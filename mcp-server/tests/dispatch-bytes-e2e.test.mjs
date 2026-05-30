/**
 * dispatch-bytes-e2e.test.mjs — proves /dispatch/<fire_id> actually
 * delivers prompt bytes to a live interactive agent's stdin,
 * end-to-end. This is the first real-binary test in the suite that
 * exercises the full HTTP → dispatcher → conductor.dispatch →
 * provider.writePrompt → pty.write → agent stdin chain.
 *
 * Sister test `tests/dispatch-spawn-e2e.test.mjs` documented this exact
 * gap: the e2e-test-runner provider used to lack `capabilities` +
 * `writePrompt`, so `pty-registry.registerPty` built the session with
 * `conductor = null` and /dispatch returned 404 `target_unavailable`.
 *
 * This PR adds those declarations to the e2e-test-runner provider plus
 * an interactive-only branch in its generated script that:
 *   1. Prints `[e2e-test-runner] READY_FOR_DISPATCH` after the MCP
 *      handshake completes (SessionConductor: starting → idle).
 *   2. Enters a stdin readline loop. Each received line is echoed back
 *      as `[e2e-test-runner] DISPATCH_RX: <line>` to pty scrollback,
 *      proving the bytes arrived at the agent process.
 *   3. On receiving the literal `__EXIT__`, prints `EXIT_RECEIVED` then
 *      `E2E_MARKER_EXIT_OK` and exits 0 for clean teardown.
 *
 * The harness is copy-adapted from dispatch-spawn-e2e.test.mjs (which
 * itself copy-adapted from recipe-real-e2e.test.mjs) so this file
 * stays runnable in isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { readIndex, writeIndex, initClawdevboxTree } from '../src/workspaces-store.ts';
import {
  hasSession,
  killPty,
  listSessions,
  getConductor,
} from '../src/pty-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Harness helpers (copy-adapted from dispatch-spawn-e2e.test.mjs).
// ---------------------------------------------------------------------------

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `cdb-disp-bytes-${prefix}-`));
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

async function bootKernel() {
  const globalDir = freshDir('global');
  const projectDir = freshDir('project');
  const port = await freePort();

  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;
  process.env.CLAWDEVBOX_PORT = String(port);
  process.env.CLAWDEVBOX_HOST = '127.0.0.1';
  delete process.env.CLAWDEVBOX_TOKEN;

  const cfg = resolveConfig({ projectDir, globalDir, port, host: '127.0.0.1', token: '' });
  applyConfigToEnv(cfg);

  const ws = await loadWorkspaceFromEnv();
  const provider = ws.agentCliProviders.get('e2e-test-runner');
  assert.ok(provider, `e2e-test-runner provider must be registered; got: ${[...ws.agentCliProviders.keys()].join(', ')}`);
  assert.ok(provider.capabilities, 'e2e-test-runner MUST declare capabilities now');
  assert.equal(typeof provider.writePrompt, 'function', 'e2e-test-runner MUST export writePrompt now');

  const opened = openDatabase(cfg.globalDir);
  await buildServer(ws);

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

async function spawnInteractiveRunner(env, prompt, subdir) {
  const wsPath = subdir ? join(env.projectDir, subdir) : env.projectDir;
  mkdirSync(wsPath, { recursive: true });
  const wsId = `ws-disp-bytes-e2e-${subdir ?? 'root'}`;
  const wsInfo = { id: wsId, path: wsPath };

  // Register the workspace in the on-disk index so the kernel's
  // context-resolver can look it up by `x-clawdevbox-workspace-id` when
  // the spawned agent calls back via MCP (recipe.done in particular
  // requires the workspace to be findable).
  const idx = readIndex(env.cfg.workspacesRoot);
  idx.workspaces[wsId] = {
    id: wsId,
    path: wsPath,
    name: null,
    created_at: Date.now(),
    parent_workspace_id: null,
  };
  writeIndex(env.cfg.workspacesRoot, idx);
  initClawdevboxTree({
    workspacePath: wsPath,
    info: idx.workspaces[wsId],
    workspacesRoot: env.cfg.workspacesRoot,
  });

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
// THE TEST.
// ---------------------------------------------------------------------------

test('e2e: /dispatch delivers bytes to a live interactive agent', { timeout: 180_000 }, async () => {
  const env = await bootKernel();
  const note = (line) => { /* eslint-disable-next-line no-console */ console.log(`[disp-bytes-e2e] ${line}`); };

  try {
    note(`kernel up on port ${env.port}`);

    // 1. Spawn the interactive runner. The runner script does its MCP
    //    handshake, then (CLAWDEVBOX_E2E_INTERACTIVE=1) prints
    //    READY_FOR_DISPATCH and enters its stdin echo loop.
    const runner = await spawnInteractiveRunner(env, 'unused-initial-prompt', 'ws-bytes');
    note(`runner spawned: instance=${runner.recipe_instance_id} pid=${runner.pid} log=${runner.log_path}`);

    // 2. Poll the pty log for the READY marker. Once visible the
    //    conductor's onData has seen it and transitioned starting → idle.
    const readyBuf = await pollLogForMarker(runner.log_path, 'READY_FOR_DISPATCH', 30_000);
    note(`READY_FOR_DISPATCH observed (${readyBuf.length} bytes in log)`);

    // 3. Conductor must exist now — provider declares capabilities +
    //    writePrompt. This is the regression-guard against the previous
    //    state where getConductor returned null.
    const conductor = getConductor(runner.recipe_instance_id);
    assert.ok(conductor, 'conductor must be non-null now that e2e-test-runner declares capabilities+writePrompt');
    note(`conductor present, state=${conductor.state}`);

    // 4. Register a fake fire with the dispatcher, targeting this pty.
    const fireId = `fire-bytes-${randomBytes(4).toString('hex')}`;
    const secret = randomBytes(16).toString('hex'); // 32-hex
    const outDir = join(env.projectDir, '.clawdevbox', 'fires', fireId, 'attempt-1');
    mkdirSync(outDir, { recursive: true });

    env.dispatcher.recordActiveRun(fireId, {
      secret,
      outDir,
      triggerId: 't-bytes-e2e',
      dispatchTargetInstanceId: runner.recipe_instance_id,
      spawnDefaults: {
        providerId: 'e2e-test-runner',
        workspaceId: 'ws-disp-bytes-e2e',
        workspacePath: env.projectDir,
      },
    });

    // 5. POST to /dispatch with a recognizable payload. The dispatcher
    //    calls conductor.dispatch which writes via provider.writePrompt
    //    to the real pty. The agent's readline picks up the first line
    //    (our prompt) and echoes it back as DISPATCH_RX.
    const token = `E2E_DISPATCH_HELLO_${randomBytes(4).toString('hex').toUpperCase()}`;
    const dispResp = await fetch(`http://127.0.0.1:${env.port}/dispatch?fire_id=${fireId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: token }),
    });
    const dispBody = await dispResp.json().catch(() => ({}));
    note(`/dispatch → HTTP ${dispResp.status} body=${JSON.stringify(dispBody)}`);
    assert.equal(dispResp.status, 200, `expected 200; body=${JSON.stringify(dispBody)}`);
    assert.equal(dispBody.ok, true, 'ok must be true');
    assert.equal(typeof dispBody.queued_at, 'number', 'queued_at must be a number');
    assert.ok(['idle', 'busy', 'starting', 'exited'].includes(dispBody.state), `unexpected state: ${dispBody.state}`);

    // 6. THE PAYOFF ASSERTION: the agent received our prompt bytes via
    //    its real stdin and echoed them back through the real pty.
    const rxMarker = `DISPATCH_RX: ${token}`;
    const rxBuf = await pollLogForMarker(runner.log_path, rxMarker, 15_000);
    note(`PAYOFF: ${rxMarker} observed in pty scrollback (${rxBuf.length} bytes)`);

    // 7. Send __EXIT__ to cleanly shut down the runner.
    const exitResp = await fetch(`http://127.0.0.1:${env.port}/dispatch?fire_id=${fireId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '__EXIT__' }),
    });
    note(`/dispatch __EXIT__ → HTTP ${exitResp.status}`);
    // We tolerate any 2xx; the agent might race the response on exit.
    assert.ok(exitResp.status >= 200 && exitResp.status < 500, `unexpected status: ${exitResp.status}`);

    // 8. Wait for the clean-shutdown marker.
    const exitBuf = await pollLogForMarker(runner.log_path, 'E2E_MARKER_EXIT_OK', 15_000);
    note(`agent exited cleanly with E2E_MARKER_EXIT_OK (final tail: ${exitBuf.slice(-200).replace(/\s+/g, ' ').trim()})`);
  } finally {
    await env.cleanup();
  }
});
