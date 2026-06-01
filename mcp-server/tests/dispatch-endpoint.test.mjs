/**
 * dispatch-endpoint.test.mjs — covers POST /dispatch.
 *
 * No auth. Two routing modes:
 *   1. ?fire_id=<id> → resolve via dispatcher.activeRuns
 *   2. ?instance_id=<id> → direct conductor lookup, no fire required
 *   3. body.instance_id / body.fire_id → same as query
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';
import { registerPty, killPty, hasSession, getConductor } from '../src/pty-registry.ts';

function makeFakePty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => { for (const cb of exitListeners) cb({ exitCode: 0, signal: undefined }); },
    onData: (cb) => { dataListeners.push(cb); return { dispose() {} }; },
    onExit: (cb) => { exitListeners.push(cb); return { dispose() {} }; },
    _emitExit: (code) => { for (const cb of exitListeners) cb({ exitCode: code, signal: undefined }); },
  };
}

function makeFakeProvider() {
  return {
    id: 'fake',
    displayName: 'Fake',
    description: 'fake',
    source: 'builtin',
    capabilities: {
      queueMode: 'none',
      promptSubmitStrategy: 'bulk-cr',
      promptReadyRegex: /❯[^\S\n]*$/m,
      busyIndicators: [/Working/i],
    },
    async writePrompt() {},
    async detect() { return { available: true, binary: 'fake', version: '0' }; },
    async spawnSession() { throw new Error('unused'); },
    async syncPluginInventory() { return { plugins: [], errors: [] }; },
    async discoverInstalledPlugins() { return []; },
  };
}

function makeWs() {
  return {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
  };
}

function openDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function startServer(ctx) {
  const server = createServer(async (req, res) => {
    try {
      const handled = await handleCronApi(req, res, ctx);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not handled' }));
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function stopServer(server) {
  await new Promise((r) => server.close(() => r()));
}

function makeCtx(db, dispatcher) {
  const ws = makeWs();
  const scheduler = new Scheduler(db, dispatcher, ws);
  return {
    db,
    dispatcher,
    scheduler,
    dbPath: ':memory:',
    schemaVersion: 1,
    service: { pid: 1, port: 5201, started_at: 0, version: '0.0.0' },
    expectedToken: null,
  };
}

function registerFakeConductorPty(instanceId) {
  const pty = makeFakePty();
  const provider = makeFakeProvider();
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const handle = { pid: pty.pid, sessionId: 'sess_' + instanceId, pty, exited };
  registerPty({
    instanceId,
    workspaceId: 'ws-test',
    cols: 80, rows: 24,
    ipty: pty,
    provider,
    agentHandle: handle,
  });
  return { pty, resolveExit };
}

function seedActiveRun(dispatcher, fireId, { dispatchTargetInstanceId } = {}) {
  dispatcher.recordActiveRun(fireId, {
    outDir: 'C:/tmp/out',
    triggerId: 't1',
    dispatchTargetInstanceId,
    spawnDefaults: {
      providerId: 'copilot',
      agent: 'dev-buddy:dev-buddy',
      workspaceId: 'ws-test',
      workspacePath: 'C:/test-ws',
    },
  });
}

test.skip('POST /dispatch?fire_id — happy path: queues prompt on conductor and returns 200', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  const instanceId = 'disp-happy-1';
  registerFakeConductorPty(instanceId);
  seedActiveRun(dispatcher, 'fire-happy', { dispatchTargetInstanceId: instanceId });

  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=fire-happy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.queued_at, 'number');
    assert.ok(['idle', 'busy', 'starting', 'exited'].includes(body.state));
    const cond = getConductor(instanceId);
    assert.ok(cond);
    assert.equal(cond.pendingCount(), 1);
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});

test.skip('POST /dispatch?instance_id — direct routing without a fire works', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  const instanceId = 'disp-direct-1';
  registerFakeConductorPty(instanceId);

  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?instance_id=${instanceId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go direct' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    const cond = getConductor(instanceId);
    assert.equal(cond.pendingCount(), 1);
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});

test.skip('POST /dispatch — instance_id in body also works', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  const instanceId = 'disp-bodyid-1';
  registerFakeConductorPty(instanceId);

  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go bodyid', instance_id: instanceId }),
    });
    assert.equal(r.status, 200);
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});

test('POST /dispatch — unknown fire returns 404 fire-not-found', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=no-such-fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error ?? '', /fire not found/i);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /dispatch — no dispatch target returns 404', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  seedActiveRun(dispatcher, 'fire-nodisp', { dispatchTargetInstanceId: undefined });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=fire-nodisp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error ?? '', /no dispatch target/i);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /dispatch — target pty gone returns 404 target_unavailable', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  seedActiveRun(dispatcher, 'fire-gone', { dispatchTargetInstanceId: 'ghost-instance' });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=fire-gone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error ?? '', /dispatch target pty has exited|target_unavailable/i);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /dispatch — missing prompt returns 400', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  const instanceId = 'disp-400-1';
  registerFakeConductorPty(instanceId);
  seedActiveRun(dispatcher, 'fire-400', { dispatchTargetInstanceId: instanceId });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=fire-400`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error ?? '', /prompt required/i);
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});

test('POST /dispatch — missing both fire_id and instance_id returns 400', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'orphan' }),
    });
    assert.equal(r.status, 400);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /dispatch — non-POST method returns 405', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dispatch?fire_id=whatever`, { method: 'GET' });
    assert.equal(r.status, 405);
  } finally {
    await stopServer(server);
    db.close();
  }
});
