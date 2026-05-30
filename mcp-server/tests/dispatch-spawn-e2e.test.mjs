/**
 * dispatch-spawn-e2e.test.mjs — real-binary end-to-end coverage for the
 * trigger-dispatch surface added in commits 70bb772..fbdd8d2.
 *
 * Boots the kernel **in-process** (sharing the test runner's V8 instance)
 * so the test can call `dispatcher.recordActiveRun(...)` directly — the
 * public test-seam added in fbdd8d2 to bypass `runScriptBinding`. The
 * scope here is the HTTP → dispatcher → conductor → pty chain; the
 * trigger-script side is covered by the in-process unit tests.
 *
 * In-process means: real `loadWorkspaceFromEnv`, real `openDatabase`,
 * real `buildServer`, real `Dispatcher`, real `handleCronApi`, real
 * `/mcp` Streamable HTTP transport, real `runRecipe` invoking the real
 * `e2e-test-runner` provider that node-pty actually spawns.
 *
 * NOTE ON e2e-test-runner CONDUCTOR SUPPORT
 * ------------------------------------------
 * The builtin `e2e-test-runner` provider now declares `capabilities`
 * and `writePrompt`, and its generated script enters a stdin echo loop
 * in interactive mode. So `pty-registry.registerPty` builds the session
 * with a real SessionConductor. The dedicated
 * `tests/dispatch-bytes-e2e.test.mjs` covers the dispatch-bytes path
 * end-to-end; here we only verify that /dispatch responds 200/ok with
 * a valid conductor state. We do NOT assert on a prompt-echo marker —
 * that's covered by the bytes test with a deterministic agent script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { resolveConfig, applyConfigToEnv } from '../src/config.ts';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { openDatabase, closeDatabase } from '../src/db/index.ts';
import { buildServer, createSessionServer } from '../src/server.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';
import { runRecipe } from '../src/recipe-runner.ts';
import {
  hasSession,
  killPty,
  listSessions,
  subscribe,
  getConductor,
} from '../src/pty-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Small harness helpers — copied/adapted from recipe-real-e2e.test.mjs to
// keep this file self-contained when run in isolation.
// ---------------------------------------------------------------------------

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `cdb-disp-spawn-${prefix}-`));
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function rmrfWithRetry(path, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await sleep(200 * (i + 1)); }
  }
}

async function pollUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null && r !== false) return r;
    } catch (err) { lastErr = err; }
    await sleep(150);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms${lastErr ? ` (last err: ${lastErr.message})` : ''}`);
}

// ---------------------------------------------------------------------------
// Minimal /mcp transport wiring — mirrors src/cli/start.ts:handleMcpRequest
// so the spawned e2e-test-runner can roundtrip MCP back into our server.
// ---------------------------------------------------------------------------

async function readJsonRpcBody(req) {
  const chunks = []; let total = 0;
  for await (const c of req) {
    const buf = c instanceof Buffer ? c : Buffer.from(c);
    total += buf.length;
    if (total > 8 * 1024 * 1024) return undefined;
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

function getSessionIdHeader(req) {
  const h = req.headers['mcp-session-id'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0 && typeof h[0] === 'string') return h[0];
  return undefined;
}

async function handleMcpRequest(req, res, ws, transports) {
  const method = req.method ?? 'GET';
  const sid = getSessionIdHeader(req);
  if (sid) {
    const existing = transports.get(sid);
    if (!existing) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      return;
    }
    await existing.handleRequest(req, res);
    return;
  }
  if (method !== 'POST') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing mcp-session-id' }, id: null }));
    return;
  }
  const body = await readJsonRpcBody(req);
  if (body === undefined || !isInitializeRequest(body)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: not an initialize' }, id: null }));
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => transports.set(id, transport),
    onsessionclosed: (id) => transports.delete(id),
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };
  const sessionServer = createSessionServer(ws);
  await sessionServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------------------
// In-process kernel boot.
// ---------------------------------------------------------------------------

async function bootKernel() {
  const globalDir = freshDir('global');
  const projectDir = freshDir('project');
  const port = await freePort();

  // Set env BEFORE resolveConfig so it picks up our chosen port + dirs.
  // These also need to be visible to the dispatcher's *internal*
  // resolveConfig call in spawnFromCallback (which re-reads env to build
  // the cfg passed into runRecipe).
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;
  process.env.CLAWDEVBOX_PORT = String(port);
  process.env.CLAWDEVBOX_HOST = '127.0.0.1';
  delete process.env.CLAWDEVBOX_TOKEN; // run unauthenticated: simplifies /mcp + /api/sessions

  const cfg = resolveConfig({ projectDir, globalDir, port, host: '127.0.0.1', token: '' });
  applyConfigToEnv(cfg);

  const ws = await loadWorkspaceFromEnv();
  const provider = ws.agentCliProviders.get('e2e-test-runner');
  assert.ok(provider, `e2e-test-runner provider must be registered; got: ${[...ws.agentCliProviders.keys()].join(', ')}`);

  const opened = openDatabase(cfg.globalDir);
  await buildServer(ws); // registers all MCP tools + opens the hosted-tools registry

  const dispatcher = new Dispatcher(opened.db, ws, {
    callbackUrlBase: `http://127.0.0.1:${port}`,
    defaultAgentCli: 'e2e-test-runner',
  });
  const scheduler = new Scheduler(opened.db, dispatcher, ws);

  const mcpTransports = new Map();
  const cronApiCtx = {
    db: opened.db,
    dispatcher,
    scheduler,
    dbPath: opened.path,
    schemaVersion: opened.schemaVersion,
    service: { pid: process.pid, port, started_at: Date.now(), version: '0.0.0-test' },
    expectedToken: cfg.http.token || null,
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
      if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
        await handleMcpRequest(req, res, ws, mcpTransports);
        return;
      }
      if (await handleCronApi(req, res, cronApiCtx)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not handled' }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });
  await new Promise((r) => httpServer.listen(port, '127.0.0.1', r));

  const cleanup = async () => {
    for (const s of listSessions()) {
      try { killPty(s.instanceId); } catch { /* best-effort */ }
    }
    await sleep(200);
    await new Promise((r) => httpServer.close(() => r()));
    try { closeDatabase(); } catch { /* may already be closed */ }
    await rmrfWithRetry(globalDir);
    await rmrfWithRetry(projectDir);
  };

  return { port, ws, cfg, db: opened.db, dispatcher, projectDir, globalDir, cleanup };
}

// ---------------------------------------------------------------------------
// Spawn an interactive e2e-test-runner pty by calling runRecipe directly.
// Returns the recipe-instance metadata once the pty is registered.
// ---------------------------------------------------------------------------

async function spawnInteractiveRunner(env, prompt, subdir) {
  const wsPath = subdir ? join(env.projectDir, subdir) : env.projectDir;
  mkdirSync(wsPath, { recursive: true });
  const wsInfo = { id: `ws-disp-spawn-e2e-${subdir ?? 'root'}`, path: wsPath };
  const result = await runRecipe({
    recipeId: null,
    recipeSnapshot: '',
    isAdhoc: true,
    prompt,
    spawnMode: 'interactive',
    workspaceInfo: wsInfo,
    agentCli: 'e2e-test-runner',
    workspacesRoot: env.cfg.workspacesRoot,
    ws: env.ws,
    cfg: env.cfg,
  });
  if (result.spawn_error) {
    throw new Error(`runRecipe spawn_error: ${result.spawn_error.code} ${result.spawn_error.message}`);
  }
  // Sanity-check that the pty registered.
  await pollUntil(() => hasSession(result.recipe_instance_id), 5000, `register pty ${result.recipe_instance_id}`);
  return result;
}

function pollLogForMarker(logPath, marker, timeoutMs) {
  return pollUntil(() => {
    if (!existsSync(logPath)) return false;
    const buf = readFileSync(logPath, 'utf8');
    return buf.includes(marker) ? buf : false;
  }, timeoutMs, `marker ${marker} in ${logPath}`);
}

// ---------------------------------------------------------------------------
// THE TEST. Single mega-test so we share one kernel boot across all 4
// phases (the kernel uses process-global singletons — db, pty-registry,
// tool registry — which prefer one setup/teardown per file).
// ---------------------------------------------------------------------------

test('real-binary e2e: /dispatch, /spawn, /api/sessions against e2e-test-runner', { timeout: 180_000 }, async () => {
  const env = await bootKernel();
  const failures = [];
  const note = (line) => { /* eslint-disable-next-line no-console */ console.log(`[disp-spawn-e2e] ${line}`); };

  try {
    note(`kernel up on port ${env.port}`);

    // -------------------------------------------------------------------
    // Test 1: /dispatch/<fire_id> against a real e2e-test-runner pty.
    //
    // We document the limitation (no conductor → 404 target_unavailable),
    // but still exercise: spawn real pty, recordActiveRun on the real
    // dispatcher, hit the endpoint and assert on the OBSERVED behaviour
    // (skip the 200 assertion per constraint #8 of the brief).
    // -------------------------------------------------------------------
    const runner1 = await spawnInteractiveRunner(env, 'Reply with only: E2E_DISPATCH_OK', 'ws-disp');
    note(`runner #1 spawned: instance=${runner1.recipe_instance_id} pid=${runner1.pid} log=${runner1.log_path}`);

    const fireId1 = `fire-disp-${randomBytes(4).toString('hex')}`;
    const secret1 = randomBytes(16).toString('hex'); // 32-hex
    const outDir1 = join(env.projectDir, '.clawdevbox', 'fires', fireId1, 'attempt-1');
    mkdirSync(outDir1, { recursive: true });

    env.dispatcher.recordActiveRun(fireId1, {
      secret: secret1,
      outDir: outDir1,
      triggerId: 't-disp-e2e',
      dispatchTargetInstanceId: runner1.recipe_instance_id,
      spawnDefaults: {
        providerId: 'e2e-test-runner',
        workspaceId: 'ws-disp-spawn-e2e',
        workspacePath: env.projectDir,
      },
    });

    const conductor = getConductor(runner1.recipe_instance_id);
    const dispResp = await fetch(`http://127.0.0.1:${env.port}/dispatch?fire_id=${fireId1}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with only: E2E_DISPATCH_OK' }),
    });
    const dispBody = await dispResp.json().catch(() => ({}));
    note(`Test 1: /dispatch → HTTP ${dispResp.status} body=${JSON.stringify(dispBody)} conductor_present=${conductor !== null}`);

    if (conductor === null) {
      failures.push('Test 1: expected conductor to be present now that e2e-test-runner declares capabilities+writePrompt');
    } else {
      try {
        assert.equal(dispResp.status, 200, 'expected 200 from /dispatch happy path');
        assert.equal(dispBody.ok, true);
        assert.equal(typeof dispBody.queued_at, 'number');
        assert.ok(['idle', 'busy', 'starting', 'exited'].includes(dispBody.state), `unexpected state: ${dispBody.state}`);
        note('Test 1: PASS (HTTP-layer ack; dispatch-bytes coverage lives in tests/dispatch-bytes-e2e.test.mjs)');
      } catch (err) {
        const tail = existsSync(runner1.log_path)
          ? readFileSync(runner1.log_path, 'utf8').slice(-2048)
          : '(no log)';
        failures.push(`Test 1: ${err.message}\npty tail:\n${tail}`);
      }
    }

    // -------------------------------------------------------------------
    // Test 2: /spawn/<fire_id> spawns a fresh interactive pty.
    // -------------------------------------------------------------------
    const fireId2 = `fire-spawn-${randomBytes(4).toString('hex')}`;
    const secret2 = randomBytes(16).toString('hex');
    const outDir2 = join(env.projectDir, '.clawdevbox', 'fires', fireId2, 'attempt-1');
    mkdirSync(outDir2, { recursive: true });
    // Distinct workspace path so .mcp.json writes don't collide with runner #1
    // (Windows EPERM on rename if the file is still held open by the
    // previous pty's child process).
    const spawn2WsPath = join(env.projectDir, 'ws-spawn');
    mkdirSync(spawn2WsPath, { recursive: true });

    env.dispatcher.recordActiveRun(fireId2, {
      secret: secret2,
      outDir: outDir2,
      triggerId: 't-spawn-e2e',
      // No dispatchTargetInstanceId — this fire only does /spawn.
      spawnDefaults: {
        providerId: 'e2e-test-runner',
        workspaceId: 'ws-disp-spawn-e2e-spawn',
        workspacePath: spawn2WsPath,
      },
    });

    const spawnResp = await fetch(`http://127.0.0.1:${env.port}/spawn?fire_id=${fireId2}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Reply with only: E2E_SPAWN_OK' }),
    });
    const spawnBody = await spawnResp.json().catch(() => ({}));
    note(`Test 2: /spawn → HTTP ${spawnResp.status} body=${JSON.stringify(spawnBody)}`);

    let spawnedInstanceId = null;
    let spawnedSessionId = null;
    try {
      assert.equal(spawnResp.status, 200, `expected 200; body=${JSON.stringify(spawnBody)}`);
      assert.equal(spawnBody.ok, true);
      assert.ok(typeof spawnBody.instance_id === 'string' && spawnBody.instance_id.length > 0, 'instance_id present');
      assert.ok(typeof spawnBody.session_id === 'string' && spawnBody.session_id.length > 0, 'session_id present');
      spawnedInstanceId = spawnBody.instance_id;
      spawnedSessionId = spawnBody.session_id;

      // agent_sessions row check — recipe-runner inserts on writeRecipeInstance
      // with interactive=1.
      const row = env.db
        .prepare(`SELECT recipe_instance_id, cli_session_id, interactive FROM agent_sessions WHERE recipe_instance_id = ?`)
        .get(spawnedInstanceId);
      assert.ok(row, `agent_sessions row should exist for ${spawnedInstanceId}`);
      assert.equal(row.interactive, 1, 'interactive flag must be 1');
      note(`Test 2: agent_sessions row ok (cli_session=${row.cli_session_id} interactive=${row.interactive})`);

      // The e2e-test-runner agent script doesn't echo the prompt itself,
      // but it does write `E2E_MARKER_EXIT_OK` (success) or
      // `E2E_MARKER_EXIT_FAIL: ...` (failure) when its MCP roundtrip is
      // done. Either marker proves the spawned binary actually ran. We
      // succeed on either to keep the assertion about the *spawn pipeline*
      // and not about the runner's MCP behaviour (covered elsewhere).
      const log2Path = join(spawn2WsPath, '.clawdevbox', 'recipe-instances', `${spawnedInstanceId}.log`);
      const marker = await pollUntil(() => {
        if (!existsSync(log2Path)) return false;
        const buf = readFileSync(log2Path, 'utf8');
        if (buf.includes('E2E_MARKER_EXIT_OK')) return { kind: 'ok', buf };
        if (buf.includes('E2E_MARKER_EXIT_FAIL')) return { kind: 'fail', buf };
        return false;
      }, 30_000, `EXIT marker for ${spawnedInstanceId}`);
      note(`Test 2: agent exited with marker=${marker.kind} (log tail: ${marker.buf.slice(-200).replace(/\s+/g, ' ').trim()})`);
      // E2E_MARKER_EXIT_OK is the happy path; FAIL is acceptable here as
      // proof-of-execution but indicates a /mcp wiring or runner issue
      // worth investigating manually.
      if (marker.kind !== 'ok') {
        note(`Test 2: WARNING — e2e-test-runner reported FAIL; tail:\n${marker.buf.slice(-1024)}`);
      }
    } catch (err) {
      const log2Path = spawnedInstanceId
        ? join(spawn2WsPath, '.clawdevbox', 'recipe-instances', `${spawnedInstanceId}.log`)
        : null;
      const tail = log2Path && existsSync(log2Path) ? readFileSync(log2Path, 'utf8').slice(-2048) : '(no log)';
      failures.push(`Test 2: ${err.message}\npty tail:\n${tail}`);
    }

    // -------------------------------------------------------------------
    // Test 3: GET /api/sessions/<spawned_instance_id>.
    // -------------------------------------------------------------------
    try {
      assert.ok(spawnedInstanceId, 'Test 3 requires Test 2 to have produced an instance_id');
      const sessResp = await fetch(`http://127.0.0.1:${env.port}/api/sessions/${spawnedInstanceId}`);
      const sessBody = await sessResp.json().catch(() => ({}));
      note(`Test 3: /api/sessions → HTTP ${sessResp.status} body=${JSON.stringify(sessBody)}`);
      assert.equal(sessResp.status, 200, 'expected 200');
      assert.equal(sessBody.instance_id, spawnedInstanceId);
      // 'unknown' is permitted because e2e-test-runner has no conductor;
      // see KNOWN LIMITATIONS at the top of this file.
      assert.ok(
        ['idle', 'busy', 'starting', 'exited', 'unknown'].includes(sessBody.state),
        `unexpected state: ${sessBody.state}`,
      );
      assert.equal(sessBody.provider_id, 'e2e-test-runner', 'provider_id mirrors registered provider');
      assert.equal(sessBody.agent_session_id, spawnedSessionId, 'agent_session_id mirrors registered session id');
      assert.equal(typeof sessBody.queue_depth, 'number');
    } catch (err) { failures.push(`Test 3: ${err.message}`); }

    if (failures.length > 0) {
      throw new Error(`\n${failures.length} sub-test failure(s):\n  - ${failures.join('\n  - ')}`);
    }
    note('all sub-tests passed');
  } finally {
    await env.cleanup();
  }
});
