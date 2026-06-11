/**
 * e2e-test-runner.ts — builtin provider used by the real-spawn end-to-end
 * tests (`tests/recipe-real-e2e.test.mjs`). Generates a self-contained
 * node script that:
 *
 *   1. Reads its own `.mcp.json` (written by writeMcpJson in shared.ts).
 *   2. POSTs `initialize` to the clawdevbox MCP HTTP endpoint and captures
 *      the `mcp-session-id` response header.
 *   3. Sends `notifications/initialized`.
 *   4. Calls `inbox.upsert` with a stable e2e-marker id.
 *   5. Tries `recipe.update_steps` (best-effort; failure is tolerated).
 *   6. Calls `recipe.done` with status=success and a marker message.
 *   7. DELETEs the session and exits 0 — prints `E2E_MARKER_EXIT_OK`.
 *
 * The agent script uses only Node built-ins (fetch, fs, path, process) so
 * it has no module-resolution requirements at any arbitrary cwd. Every
 * call goes through the real production HTTP MCP transport — no mocks.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileAtomic } from '../fs-util.ts';
import { writeMcpJson } from './shared.ts';
import type {
  AgentCliProvider,
  AgentHandle,
  ProviderCapabilities,
  ProviderCtx,
  SpawnSessionOpts,
  WritePromptOpts,
} from './types.ts';

function renderScriptBody(opts: SpawnSessionOpts): string {
  const sessionId = opts.init.session_id;
  return `// e2e-test-runner generated script for session ${sessionId}
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function log(line) {
  process.stdout.write('[e2e-test-runner] ' + line + '\\n');
}

function readMcpConfig() {
  const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR || process.cwd();
  const candidates = [
    path.join(projectDir, '.mcp.json'),
    path.join(process.cwd(), '.mcp.json'),
  ];
  let lastErr = null;
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const cfg = JSON.parse(raw);
      const entry = cfg && cfg.mcpServers && cfg.mcpServers.clawdevbox;
      if (entry && typeof entry.url === 'string') {
        return { path: p, url: entry.url, headers: entry.headers || {} };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('no .mcp.json with mcpServers.clawdevbox found (tried ' + candidates.join(', ') + ': ' + (lastErr && lastErr.message) + ')');
}

function parseSseOrJson(text) {
  // Streamable HTTP returns either JSON or text/event-stream with a single
  // \`data: <json>\\n\\n\` frame. Tolerate both.
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  for (const rawLine of trimmed.split(/\\r?\\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { return JSON.parse(payload); } catch { /* keep scanning */ }
      }
    }
  }
  return null;
}

async function rpc(url, headers, sessionId, method, params, id) {
  const body = id == null
    ? { jsonrpc: '2.0', method, params: params || {} }
    : { jsonrpc: '2.0', id: id, method, params: params || {} };
  const hdrs = Object.assign({}, headers, {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  });
  if (sessionId) hdrs['mcp-session-id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 400) {
    throw new Error('HTTP ' + res.status + ' calling ' + method + ': ' + text.slice(0, 400));
  }
  const respSessionId = res.headers.get('mcp-session-id');
  const parsed = parseSseOrJson(text);
  if (parsed && parsed.error) {
    throw new Error('JSON-RPC error on ' + method + ': ' + JSON.stringify(parsed.error));
  }
  if (parsed && parsed.result && parsed.result.isError) {
    const t = parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
    throw new Error('tool error on ' + method + ': ' + (t || JSON.stringify(parsed.result)));
  }
  return { status: res.status, body: parsed, raw: text, sessionId: respSessionId };
}

(async () => {
  try {
    const cfg = readMcpConfig();
    log('mcp url=' + cfg.url + ' (.mcp.json=' + cfg.path + ')');

    // 1. initialize
    const initResult = await rpc(cfg.url, cfg.headers, null, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e-test-runner', version: '1.0' },
    }, 1);
    const mcpSessionId = initResult.sessionId;
    if (!mcpSessionId) {
      throw new Error('initialize did not return mcp-session-id header; body=' + initResult.raw.slice(0, 200));
    }
    log('initialized session=' + mcpSessionId);

    // 2. notifications/initialized — no id (it's a notification)
    await rpc(cfg.url, cfg.headers, mcpSessionId, 'notifications/initialized', {}, null);

    const instanceId = process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID || 'unknown';

    // 3. inbox.upsert
    const inboxResp = await rpc(cfg.url, cfg.headers, mcpSessionId, 'tools/call', {
      name: 'run_tool',
      arguments: {
        tool: 'inbox.upsert',
        args: {
          id: 'e2e:' + instanceId,
          kind: 'e2e-test',
          source: 'e2e-test-runner',
          title: 'E2E test ran for ' + instanceId,
          preview: 'E2E_MARKER_INBOX',
          notify: false,
        },
      },
    }, 2);
    log('inbox.upsert ok status=' + inboxResp.status);

    // 4. recipe.update_steps — best effort. Step shape: { id, goal }.
    try {
      await rpc(cfg.url, cfg.headers, mcpSessionId, 'tools/call', {
        name: 'run_tool',
        arguments: {
          tool: 'recipe.instance.update_steps',
          args: { add: [{ id: 'e2e-check', goal: 'verify e2e' }] },
        },
      }, 3);
      log('recipe.update_steps ok');
    } catch (err) {
      log('recipe.update_steps best-effort failed: ' + err.message);
    }

    // 5. recipe.done was removed in the agent-executes-recipe redesign
    //    (2026-06). The recipe-runner's pty exit handler treats exit code 0
    //    as success and marks the instance terminal, so we just exit
    //    cleanly. The E2E_MARKER_DONE log line is preserved as a regex
    //    anchor for tests that grep for it.
    log('E2E_MARKER_DONE: all steps complete (no recipe.done — exit code 0 cascades)');

    // 6. DELETE session to release transport resources.
    try {
      const hdrs = Object.assign({}, cfg.headers, { 'mcp-session-id': mcpSessionId });
      await fetch(cfg.url, { method: 'DELETE', headers: hdrs });
    } catch (err) {
      log('DELETE best-effort failed: ' + err.message);
    }

    // ─── interactive-mode stdin echo loop ────────────────────────────
    // When the spawn was interactive (mode === 'interactive'), don't
    // exit after recipe.done — stay alive and echo any dispatched
    // prompts so the dispatch-bytes e2e test can observe them.
    if (process.env.CLAWDEVBOX_E2E_INTERACTIVE === '1') {
      process.stdout.write('[e2e-test-runner] READY_FOR_DISPATCH\\n');

      // Read stdin line-by-line. Each line is a dispatched prompt
      // arriving via SessionConductor → writePrompt → pty.write(text + '\\r').
      // Node turns the inbound \\r into \\n on Windows ConPTY readback,
      // so readline should hand us the whole prompt as one line.
      const readline = require('node:readline');
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

      rl.on('line', (line) => {
        const trimmed = line.replace(/\\r$/, '').trim();
        if (trimmed.length === 0) return;
        if (trimmed.startsWith('__EXIT__')) {
          process.stdout.write('[e2e-test-runner] EXIT_RECEIVED\\n');
          rl.close();
          process.stdout.write('E2E_MARKER_EXIT_OK\\n');
          process.exit(0);
        }
        process.stdout.write('[e2e-test-runner] DISPATCH_RX: ' + trimmed + '\\n');
      });

      // Safety fuse: if no exit signal arrives in 60s, exit anyway.
      setTimeout(() => {
        process.stdout.write('[e2e-test-runner] TIMEOUT_60S\\n');
        process.stdout.write('E2E_MARKER_EXIT_OK\\n');
        process.exit(0);
      }, 60_000).unref();

      return; // keep event loop alive via rl + setTimeout
    }
    // ─────────────────────────────────────────────────────────────────

    process.stdout.write('E2E_MARKER_EXIT_OK\\n');
    process.exit(0);
  } catch (err) {
    process.stdout.write('E2E_MARKER_EXIT_FAIL: ' + (err && err.stack ? err.stack : err) + '\\n');
    process.exit(2);
  }
})();
`;
}

export const e2eTestRunnerProvider: AgentCliProvider = {
  id: 'e2e-test-runner',
  displayName: 'E2E Test Runner (testing)',
  description:
    "Internal test-only provider. Spawns a node script that performs a real HTTP MCP roundtrip (initialize → inbox.upsert → recipe.update_steps → recipe.done) against the clawdevbox MCP server. Used by tests/recipe-real-e2e.test.mjs.",
  source: 'builtin',
  internal: true,
  supportsResume: false,

  capabilities: {
    queueMode: 'none',
    promptSubmitStrategy: 'bulk-cr',
    // The agent script prints this marker when it's ready to accept a
    // dispatched prompt. SessionConductor uses this to transition
    // starting → idle.
    promptReadyRegex: /\[e2e-test-runner\] READY_FOR_DISPATCH/m,
    busyIndicators: [],
  } satisfies ProviderCapabilities,

  async writePrompt(handle: AgentHandle, { text, strategy }: WritePromptOpts): Promise<void> {
    if (strategy === 'queue') {
      throw new Error('e2e-test-runner: queue strategy not supported');
    }
    // bulk-cr: single write with trailing CR. The agent's stdin-read
    // loop splits on \n (LF), and node-pty translates CR to LF on Windows.
    handle.pty!.write(text + '\r');
  },

  async detect(_ctx: ProviderCtx) {
    return { available: true, binary: process.execPath, version: process.version };
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const dir = join(opts.workspaceInfo.path, '.clawdevbox', 'e2e-test-runner');
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, `${opts.init.session_id}.cjs`);
    writeFileAtomic(scriptPath, renderScriptBody(opts));

    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    if (opts.mode === 'interactive') {
      env.CLAWDEVBOX_E2E_INTERACTIVE = '1';
    }
    const pty = ctx.spawnPty(process.execPath, [scriptPath], {
      cwd: opts.workspaceInfo.path,
      env,
      cols: opts.ptyCols ?? 80,
      rows: opts.ptyRows ?? 24,
    });
    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) =>
        pty.onExit(({ exitCode, signal }) =>
          resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }),
        ),
      ),
    };
  },
};
