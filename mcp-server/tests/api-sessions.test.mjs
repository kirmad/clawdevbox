/**
 * api-sessions.test.mjs — covers GET /api/sessions/<instance_id>.
 *
 * Uses a fake pty + provider to register a real SessionConductor in
 * pty-registry, then exercises the endpoint's success, not-found, and
 * unauthorized branches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';
import { registerPty, hasSession, killPty } from '../src/pty-registry.ts';

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
  };
}

function makeFakeProvider() {
  return {
    id: 'fake-provider',
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

function makeCtx(db, dispatcher, expectedToken = null) {
  const scheduler = new Scheduler(db, dispatcher, makeWs());
  return {
    db,
    dispatcher,
    scheduler,
    dbPath: ':memory:',
    schemaVersion: 1,
    service: { pid: 1, port: 5201, started_at: 0, version: '0.0.0' },
    expectedToken,
  };
}

function registerFakeConductorPty(instanceId, { meta } = {}) {
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
    meta,
  });
}

test('GET /api/sessions/<instance_id> — 200 with state, queue_depth, provider_id', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  const instanceId = 'api-sess-1';
  registerFakeConductorPty(instanceId, {
    meta: { agentCli: 'copilot', sessionId: 'sess_x' },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${instanceId}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.instance_id, instanceId);
    assert.ok(['idle', 'busy', 'starting', 'exited', 'unknown'].includes(body.state));
    assert.equal(typeof body.queue_depth, 'number');
    assert.equal(body.queue_depth, 0);
    assert.equal(body.provider_id, 'copilot');
    assert.equal(body.agent_session_id, 'sess_x');
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions/<unknown> — 404', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/does-not-exist`);
    assert.equal(r.status, 404);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions/<id> — 401 when expectedToken set and bearer missing', async () => {
  const db = openDb();
  const dispatcher = new Dispatcher(db, makeWs(), { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, 'expected-token'));
  const instanceId = 'api-sess-auth';
  registerFakeConductorPty(instanceId, {
    meta: { agentCli: 'copilot', sessionId: 'sess_x' },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${instanceId}`);
    assert.equal(r.status, 401);
    // Correct token succeeds.
    const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions/${instanceId}`, {
      headers: { authorization: 'Bearer expected-token' },
    });
    assert.equal(r2.status, 200);
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});
