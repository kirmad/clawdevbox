/**
 * spawn-endpoint.test.mjs — covers POST /spawn/<fire_id>.
 *
 * Uses the Dispatcher's `runRecipeFn` injection seam to swap in a stub
 * that records the call and returns a deterministic spawn result, so the
 * endpoint can be exercised without spinning real ptys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = resolve(__dirname, '.tmp', 'spawn-endpoint');

function freshDirs(name) {
  const root = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  const projectDir = join(root, 'project');
  const globalDir = join(root, 'global');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  return { projectDir, globalDir };
}

function makeWs(dirs) {
  return {
    projectDir: dirs.projectDir,
    globalDir: dirs.globalDir,
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

function makeCtx(db, dispatcher, ws) {
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

function seedActiveRun(dispatcher, fireId, overrides = {}) {
  dispatcher.recordActiveRun(fireId, {
    secret: 'fire-secret-xyz',
    outDir: 'C:/tmp/out',
    triggerId: 't1',
    dispatchTargetInstanceId: undefined,
    spawnDefaults: {
      providerId: 'copilot',
      agent: 'dev-buddy:dev-buddy',
      workspaceId: 'ws-default',
      workspacePath: 'C:/workspaces/default',
    },
    ...overrides,
  });
}

function insertWorkspace(db, id, path) {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, path, id, Date.now());
}

function makeRunRecipeStub(result) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    if (result instanceof Error) throw result;
    return {
      recipe_instance_id: 'inst_test',
      recipe_id: '',
      adhoc: true,
      workspace_id: opts.workspaceInfo.id,
      workspace_path: opts.workspaceInfo.path,
      attach_to_inbox_item_id: null,
      pid: 1234,
      agent_cli: opts.agentCli ?? 'copilot',
      session_id: 'sess_test',
      resume_of: null,
      status: 'spawned',
      log_path: 'C:/tmp/log.txt',
      view_url: null,
      ...(result ?? {}),
    };
  };
  return { fn, calls };
}

test('POST /spawn/<fire_id> — happy path returns 200 with instance_id + session_id', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('happy'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-happy');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/fire-spawn-happy`, {
      method: 'POST',
      headers: { authorization: 'Bearer fire-secret-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'start fresh' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.instance_id, 'inst_test');
    assert.equal(body.session_id, 'sess_test');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].prompt, 'start fresh');
    // Defaults flow through.
    assert.equal(stub.calls[0].workspaceInfo.id, 'ws-default');
    assert.equal(stub.calls[0].agent, 'dev-buddy:dev-buddy');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn/<fire_id> — body.agent overrides default agent', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('agent'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-agent');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/fire-spawn-agent`, {
      method: 'POST',
      headers: { authorization: 'Bearer fire-secret-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go', agent: 'x' }),
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].agent, 'x');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn/<fire_id> — body.workspace_id resolves to that workspace path', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('ws'));
  insertWorkspace(db, 'ws-override', 'C:/workspaces/override');
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-ws');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/fire-spawn-ws`, {
      method: 'POST',
      headers: { authorization: 'Bearer fire-secret-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go', workspace_id: 'ws-override' }),
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].workspaceInfo.id, 'ws-override');
    assert.equal(stub.calls[0].workspaceInfo.path, 'C:/workspaces/override');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn/<fire_id> — wrong bearer returns 401', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('401'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-401');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/fire-spawn-401`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 401);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn/<fire_id> — missing prompt returns 400', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('400'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-400');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/fire-spawn-400`, {
      method: 'POST',
      headers: { authorization: 'Bearer fire-secret-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error ?? '', /prompt required/i);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn/<fire_id> — runRecipe throws → 500 surfaces the error message', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('500'));
  const stub = makeRunRecipeStub(new Error('boom: pty.spawn failed'));
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-500');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/fire-spawn-500`, {
      method: 'POST',
      headers: { authorization: 'Bearer fire-secret-xyz', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.match(body.error ?? '', /boom: pty\.spawn failed/);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn/<fire_id> — unknown fire returns 404', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('404'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn/no-such-fire`, {
      method: 'POST',
      headers: { authorization: 'Bearer anything', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 404);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('cleanup tmp', () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

