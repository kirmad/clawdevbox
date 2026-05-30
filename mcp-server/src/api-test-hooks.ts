/**
 * api-test-hooks.ts
 *
 * Loopback-only HTTP endpoints that let you fire recipes and triggers against
 * the LIVE clawdevbox server. Useful for:
 *
 *   • One-off demos: `curl -X POST http://127.0.0.1:5201/api/test/run-e2e`
 *     produces a real recipe-instance + inbox item visible in the home UI.
 *   • Integration tests that hit the running server instead of spinning up a
 *     hermetic child (complementing `tests/recipe-real-e2e.test.mjs`).
 *
 * Routes
 *   POST /api/test/recipe-run        — forwards to the `recipe.run` MCP tool.
 *   POST /api/test/trigger-fire      — forwards to the `trigger.fire` MCP tool.
 *   POST /api/test/run-e2e           — zero-arg shortcut: runs an inline recipe
 *                                      driven by the e2e-test-runner provider.
 *   POST /api/test/run-trigger-e2e   — zero-arg shortcut: registers an inline
 *                                      node script trigger and fires it. The
 *                                      script writes a stable marker so the
 *                                      caller can verify dispatcher execution.
 *   GET  /api/test/agent-clis        — lists registered providers (incl. internal).
 *
 * Security: every route refuses non-loopback callers (403). They are NOT
 * bearer-gated — same posture as `/api/inbox` / `/api/recipes` — because
 * loopback is the trust boundary on these surfaces.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { ResolvedConfig } from './config.ts';
import type { Workspace } from './workspace.ts';
import type { Dispatcher } from './dispatcher.ts';
import { getRegistry } from './tools/registry.ts';
import { logger } from './logger.ts';
import { ensureWorkspace } from './db/workspaces-store.ts';
import { readIndex, writeIndex, initClawdevboxTree, resolveWorkspacesRoot } from './workspaces-store.ts';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return LOOPBACK_ADDRS.has(addr);
}

async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  const MAX = 256 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: `body exceeds ${MAX} bytes` } }));
      return null;
    }
    chunks.push(buf);
  }
  if (total === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: (err as Error).message } }));
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function refuseRemote(res: ServerResponse): void {
  sendJson(res, 403, {
    error: {
      code: 'LOOPBACK_ONLY',
      message: '/api/test/* is loopback-only. Connect from 127.0.0.1 / ::1.',
    },
  });
}

/**
 * Look up a registered MCP tool and invoke its handler with the given args.
 * Surfaces structured errors as HTTP 422 so test clients can react.
 */
async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const outcome = await callTool(toolName, args);
  if (outcome.kind === 'not_registered') {
    sendJson(res, 500, {
      error: { code: 'TOOL_NOT_REGISTERED', message: `'${toolName}' is not in the tool registry` },
    });
    return;
  }
  if (outcome.kind === 'threw') {
    sendJson(res, 500, {
      error: { code: 'TOOL_THREW', tool: toolName, message: outcome.message },
    });
    return;
  }
  const status = outcome.result.isError ? 422 : 200;
  sendJson(res, status, {
    ok: !outcome.result.isError,
    tool: toolName,
    structuredContent: outcome.result.structuredContent ?? null,
    content: outcome.result.content ?? null,
  });
}

type ToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

type CallOutcome =
  | { kind: 'ok'; result: ToolResult }
  | { kind: 'not_registered' }
  | { kind: 'threw'; message: string };

/**
 * Lower-level helper: invoke a tool and return the envelope without writing
 * any HTTP response. Used by composite endpoints (e.g. run-trigger-e2e) that
 * need to chain calls and decide on a unified response.
 */
async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const entry = getRegistry().get(toolName);
  if (!entry) return { kind: 'not_registered' };
  try {
    const result = (await entry.handler(args, { source: 'api-test-hook' })) as ToolResult;
    return { kind: 'ok', result };
  } catch (err) {
    logger.error({ tool: toolName, err: (err as Error).message }, 'api-test-hook tool invocation failed');
    return { kind: 'threw', message: (err as Error).message };
  }
}

/**
 * Inline recipe used by `/api/test/run-e2e`. Drives the `e2e-test-runner`
 * provider that ships in BUILTIN_PROVIDERS, so no plugins / config / fixtures
 * are needed.
 */
const INLINE_E2E_RECIPE_YAML = [
  'id: e2e-live-test',
  'name: E2E Live Test',
  'description: Drive the e2e-test-runner provider against the live server.',
  'agent_cli: e2e-test-runner',
  'steps: []',
  '',
].join('\n');

/**
 * Inline node script used by `/api/test/run-trigger-e2e`. Writes a stable
 * marker to stdout so the caller (or test harness) can prove the dispatcher
 * picked up the fire and ran the script binding end-to-end.
 *
 * Stays minimal on purpose — no MCP roundtrip, no callbacks. The trigger
 * pipeline is what's under test; the script is just a witness.
 *
 * The dispatcher (`trigger-runner.ts`) writes the TriggerEnvelope JSON to
 * the child's stdin, so we read+parse it from there.
 */
const INLINE_TRIGGER_SCRIPT = [
  "'use strict';",
  '// Witness script for /api/test/run-trigger-e2e.',
  '// Dispatcher writes the TriggerEnvelope to stdin; we read it to prove',
  '// the wiring is intact. stdout/stderr are captured to attempt-N/*.txt.',
  "let envelopeRaw = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { envelopeRaw += chunk; });",
  "process.stdin.on('end', () => {",
  '  let envelope = {};',
  '  try { envelope = envelopeRaw ? JSON.parse(envelopeRaw) : {}; } catch (e) { envelope = { __parse_error: String(e) }; }',
  "  process.stdout.write('TRIGGER_E2E_MARKER trigger_id=' + (envelope.trigger_id || '?') + ' run_id=' + (envelope.run_id || '?') + '\\n');",
  "  process.stdout.write(JSON.stringify({ state: envelope.state || {}, callback: { body: { ok: true, witness: 'TRIGGER_E2E_MARKER', trigger_id: envelope.trigger_id, run_id: envelope.run_id } } }) + '\\n');",
  '  process.exit(0);',
  '});',
  '',
].join('\n');

export interface TestHookCtx {
  cfg: ResolvedConfig;
  ws: Workspace;
  db?: Database;
  /** Lazy getter — dispatcher is constructed AFTER the HTTP server binds. */
  getDispatcher?: () => Dispatcher | null;
}

/**
 * Dispatcher. Returns `true` if the request matched a /api/test/* route
 * (response is already written), `false` if the URL didn't match anything.
 */
export async function handleTestHook(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: TestHookCtx,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/test/')) return false;

  if (!isLoopback(req)) {
    refuseRemote(res);
    return true;
  }

  // ── GET /api/test/agent-clis ──────────────────────────────────────────
  if (path === '/api/test/agent-clis' && req.method === 'GET') {
    const ws = _ctx.ws;
    const items = [...ws.agentCliProviders.entries()].map(([id, p]) => ({
      id,
      display_name: p.displayName,
      source: p.source,
      internal: !!p.internal,
    }));
    sendJson(res, 200, { items });
    return true;
  }

  // ── POST /api/test/recipe-run ─────────────────────────────────────────
  if (path === '/api/test/recipe-run' && req.method === 'POST') {
    const body = (await readJsonBody<Record<string, unknown>>(req, res)) ?? null;
    if (body == null) return true;
    if (!body.id && !body.source) {
      sendJson(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'either `id` or `source` is required' },
      });
      return true;
    }
    await invokeTool('recipe.run', body, res);
    return true;
  }

  // ── POST /api/test/trigger-fire ───────────────────────────────────────
  if (path === '/api/test/trigger-fire' && req.method === 'POST') {
    const body = (await readJsonBody<Record<string, unknown>>(req, res)) ?? null;
    if (body == null) return true;
    if (!body.id) {
      sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: '`id` is required' } });
      return true;
    }
    await invokeTool('trigger.fire', body, res);
    return true;
  }

  // ── POST /api/test/run-e2e ────────────────────────────────────────────
  if (path === '/api/test/run-e2e' && req.method === 'POST') {
    const body = ((await readJsonBody<{ prompt?: string }>(req, res)) ?? {}) as { prompt?: string };
    await invokeTool(
      'recipe.run',
      {
        source: INLINE_E2E_RECIPE_YAML,
        prompt: body.prompt ?? 'run e2e test (live)',
        agent_cli: 'e2e-test-runner',
      },
      res,
    );
    return true;
  }

  // ── POST /api/test/run-trigger-e2e ────────────────────────────────────
  // Composite demo: register a one-off node script trigger, then fire it.
  // The script writes TRIGGER_E2E_MARKER to stdout, which the dispatcher
  // persists to attempt-N/stdout.txt. Returns both envelopes so callers can
  // chain `fire_id` → poll `triggers.json` / DB to verify completion.
  if (path === '/api/test/run-trigger-e2e' && req.method === 'POST') {
    const body = ((await readJsonBody<{ payload?: unknown }>(req, res)) ?? {}) as {
      payload?: unknown;
    };

    const registerOutcome = await callTool('trigger.register', {
      script: INLINE_TRIGGER_SCRIPT,
      runtime: 'node',
    });
    if (registerOutcome.kind !== 'ok' || registerOutcome.result.isError) {
      sendJson(res, registerOutcome.kind === 'ok' ? 422 : 500, {
        ok: false,
        stage: 'register',
        kind: registerOutcome.kind,
        structuredContent:
          registerOutcome.kind === 'ok' ? registerOutcome.result.structuredContent ?? null : null,
        content:
          registerOutcome.kind === 'ok' ? registerOutcome.result.content ?? null : null,
        message:
          registerOutcome.kind === 'threw' ? registerOutcome.message : 'trigger.register failed',
      });
      return true;
    }
    const registered = registerOutcome.result.structuredContent as { id?: string } | null;
    const triggerId = registered?.id;
    if (typeof triggerId !== 'string' || triggerId.length === 0) {
      sendJson(res, 500, {
        ok: false,
        stage: 'register',
        message: 'trigger.register did not return structuredContent.id',
        structuredContent: registerOutcome.result.structuredContent ?? null,
      });
      return true;
    }

    const fireOutcome = await callTool('trigger.fire', {
      id: triggerId,
      payload: body.payload ?? { witness: 'TRIGGER_E2E_MARKER' },
    });
    if (fireOutcome.kind !== 'ok' || fireOutcome.result.isError) {
      sendJson(res, fireOutcome.kind === 'ok' ? 422 : 500, {
        ok: false,
        stage: 'fire',
        trigger_id: triggerId,
        kind: fireOutcome.kind,
        structuredContent:
          fireOutcome.kind === 'ok' ? fireOutcome.result.structuredContent ?? null : null,
        content: fireOutcome.kind === 'ok' ? fireOutcome.result.content ?? null : null,
        message: fireOutcome.kind === 'threw' ? fireOutcome.message : 'trigger.fire failed',
      });
      return true;
    }

    const fireResult = fireOutcome.result.structuredContent as
      | { fire_id?: string; trigger_id?: string; status?: string }
      | null;
    sendJson(res, 200, {
      ok: true,
      stage: 'fire',
      witness_marker: 'TRIGGER_E2E_MARKER',
      register: {
        structuredContent: registerOutcome.result.structuredContent ?? null,
        content: registerOutcome.result.content ?? null,
      },
      fire: {
        structuredContent: fireOutcome.result.structuredContent ?? null,
        content: fireOutcome.result.content ?? null,
      },
      trigger_id: triggerId,
      fire_id: fireResult?.fire_id ?? null,
    });
    return true;
  }

  // ── POST /api/test/record-active-run ──────────────────────────────────
  // Test-only: directly inject an activeRuns entry into the dispatcher so
  // /spawn/<fire_id> and /dispatch/<fire_id> accept the per-fire bearer
  // without needing a real trigger script to fire. Used by the
  // terminals-panel-e2e playwright test. Also inserts a fires row +
  // ensures the workspace is registered, so spawnFromCallback's
  // workspace lookup succeeds.
  //
  // Body: { fire_id, secret, workspace_id?, workspace_path,
  //         provider_id?, dispatch_target_instance_id? }
  // Returns 200 { ok: true, fire_id, secret } on success.
  if (path === '/api/test/record-active-run' && req.method === 'POST') {
    const body = (await readJsonBody<{
      fire_id?: string;
      secret?: string;
      workspace_id?: string;
      workspace_path?: string;
      provider_id?: string;
      dispatch_target_instance_id?: string | null;
    }>(req, res)) ?? null;
    if (body == null) return true;
    if (!body.fire_id || !body.secret || !body.workspace_path) {
      sendJson(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'fire_id, secret, workspace_path are required' },
      });
      return true;
    }
    const dispatcher = _ctx.getDispatcher?.();
    const db = _ctx.db;
    if (!dispatcher || !db) {
      sendJson(res, 503, {
        error: { code: 'NOT_READY', message: 'dispatcher or db not available' },
      });
      return true;
    }

    // Ensure workspace exists in BOTH the DB AND the on-disk index.
    // The DB row is required by spawnFromCallback's workspace lookup;
    // the on-disk index is required by context-resolver when the spawned
    // agent's MCP requests carry x-clawdevbox-workspace-id header (which
    // recipe.done validates).
    const wsRow = ensureWorkspace(db, { path: body.workspace_path });
    const workspaceId = body.workspace_id ?? wsRow.id;
    try {
      const workspacesRoot = resolveWorkspacesRoot();
      const idx = readIndex(workspacesRoot);
      if (!idx.workspaces[workspaceId]) {
        idx.workspaces[workspaceId] = {
          id: workspaceId,
          path: body.workspace_path,
          name: null,
          parent_workspace_id: null,
          created_at: Date.now(),
        };
        writeIndex(workspacesRoot, idx);
        initClawdevboxTree({
          workspacePath: body.workspace_path,
          info: idx.workspaces[workspaceId],
          workspacesRoot,
        });
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), workspaceId },
        'record-active-run: on-disk index write failed (continuing)',
      );
    }

    // Insert a synthetic fires row so the /spawn handler's downstream
    // marker write (if any) doesn't FK-fail. The row is enough for
    // dispatcher.activeRuns to flow; status='running' to mirror an
    // in-flight script binding.
    try {
      db.prepare(
        `INSERT INTO fires (fire_id, workspace_id, source, status, attempt, max_attempts, scheduled_at)
         VALUES (?, ?, 'manual', 'running', 1, 1, ?)
         ON CONFLICT(fire_id) DO NOTHING`,
      ).run(body.fire_id, workspaceId, Date.now());
    } catch (err) {
      logger.warn(
        { fire_id: body.fire_id, err: err instanceof Error ? err.message : String(err) },
        'record-active-run: fires INSERT failed (continuing)',
      );
    }

    dispatcher.recordActiveRun(body.fire_id, {
      secret: body.secret,
      outDir: body.workspace_path,
      triggerId: 'test-trigger',
      dispatchTargetInstanceId: body.dispatch_target_instance_id ?? undefined,
      spawnDefaults: {
        providerId: body.provider_id ?? 'e2e-test-runner',
        workspaceId,
        workspacePath: body.workspace_path,
      },
    });

    sendJson(res, 200, { ok: true, fire_id: body.fire_id, secret: body.secret, workspace_id: workspaceId });
    return true;
  }

  // Path was under /api/test/ but didn't match anything.
  sendJson(res, 404, {
    error: { code: 'UNKNOWN_TEST_HOOK', message: `no handler for ${req.method} ${path}` },
  });
  return true;
}
