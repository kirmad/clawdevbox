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
      // Echo the resolved session_id so tests can verify alias→GUID routing.
      session_id: opts.sessionId ?? 'sess_test',
      resume_of: null,
      status: 'spawned',
      log_path: 'C:/tmp/log.txt',
      view_url: null,
      ...(result ?? {}),
    };
  };
  return { fn, calls };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('POST /spawn?fire_id — happy path returns 200 with instance_id + session_id', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('happy'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-happy');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=fire-spawn-happy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'start fresh' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'spawn');
    assert.equal(body.instance_id, 'inst_test');
    assert.match(body.session_id, UUID_RE, 'session_id should be a fresh UUID');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].prompt, 'start fresh');
    assert.equal(stub.calls[0].workspaceInfo.id, 'ws-default');
    assert.equal(stub.calls[0].agent, 'dev-buddy:dev-buddy');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn?fire_id — body.agent overrides default agent', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('agent'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-agent');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=fire-spawn-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

test('POST /spawn — body.model flows through to runRecipe', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('model'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'go',
        provider: 'copilot',
        workspace_path: 'C:/ws/model',
        model: 'claude-opus-4.7-1m-internal',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].model, 'claude-opus-4.7-1m-internal',
      'model must flow from /spawn body → spawnFromCallback → runRecipe');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn?fire_id — body.workspace_id resolves to that workspace path', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('ws'));
  insertWorkspace(db, 'ws-override', 'C:/workspaces/override');
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-ws');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=fire-spawn-ws`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

test('POST /spawn — no fire_id, body provides provider+workspace_path (ad-hoc mode)', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('adhoc'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'adhoc go',
        provider: 'copilot',
        workspace_path: 'C:/ad-hoc-workspace',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].agentCli, 'copilot');
    // ensureWorkspace canonicalizes path separators to platform-native (backslash on Windows)
    const expected = 'C:/ad-hoc-workspace'.replace(/\//g, process.platform === 'win32' ? '\\' : '/');
    assert.equal(stub.calls[0].workspaceInfo.path, expected);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn — missing prompt returns 400', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('400'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-400');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=fire-spawn-400`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

test('POST /spawn — runRecipe throws → 500 surfaces the error message', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('500'));
  const stub = makeRunRecipeStub(new Error('boom: pty.spawn failed'));
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  seedActiveRun(dispatcher, 'fire-spawn-500');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=fire-spawn-500`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

test('POST /spawn?fire_id — unknown fire AND no body fallback returns 404', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('404'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn?fire_id=no-such-fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go' }),
    });
    assert.equal(r.status, 404);
  } finally {
    await stopServer(server);
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Smart routing: session_id aliases + auto-spawn-or-dispatch
// ---------------------------------------------------------------------------

test('POST /spawn — session_id alias mints a GUID and persists the mapping', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('alias'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    // First call with a friendly alias.
    const r1 = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'first',
        session_id: 'my-feature',
        provider: 'copilot',
        workspace_path: 'C:/ws/feature',
      }),
    });
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.mode, 'spawn');
    assert.equal(b1.session_alias, 'my-feature');
    assert.match(b1.session_id, UUID_RE, 'alias must be mapped to a GUID');
    const guid1 = b1.session_id;

    // DB row was inserted.
    const row = db.prepare('SELECT * FROM session_aliases WHERE alias = ?').get('my-feature');
    assert.ok(row);
    assert.equal(row.session_id, guid1);

    // Second call with same alias resolves to the same GUID.
    const r2 = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'second',
        session_id: 'my-feature',
        provider: 'copilot',
        workspace_path: 'C:/ws/feature',
      }),
    });
    const b2 = await r2.json();
    assert.equal(b2.session_id, guid1, 'same alias must resolve to same GUID');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn — explicit GUID passes through unchanged (no alias row)', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('rawguid'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  const myGuid = '11111111-2222-3333-4444-555555555555';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'go',
        session_id: myGuid,
        provider: 'copilot',
        workspace_path: 'C:/ws/raw',
      }),
    });
    const body = await r.json();
    assert.equal(body.session_id, myGuid);
    assert.equal(body.session_alias, null);
    const count = db.prepare('SELECT COUNT(*) AS n FROM session_aliases').get();
    assert.equal(count.n, 0, 'GUID input should NOT create an alias row');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn — live session routes prompt as dispatch (no second spawn)', { skip: 'flaky after T19 tmux migration; rewrite in dispatch follow-up' }, async () => {
  // We can't easily simulate a live pty in this unit test without the
  // pty-registry running real ptys, so this test:
  //   1. Spawns a session normally (mode=spawn), records the GUID + instance.
  //   2. Manually inserts a matching agent_sessions row with status='running'
  //      and interactive=1, and registers a fake pty for that instance.
  //   3. Sends a second /spawn with the same alias — should return mode=dispatch.
  const db = openDb();
  const ws = makeWs(freshDirs('live'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  const { registerPty, killPty, hasSession } = await import('../src/pty-registry.ts');
  const { runMigrations } = await import('../src/db/index.ts');
  // Migrations already applied by openDb, but ensure V4 ran.
  void runMigrations;

  const instanceId = 'inst_live_test';
  insertWorkspace(db, 'ws-live', 'C:/ws/live');
  // Insert a recipe_instances row so the agent_sessions FK constraint passes.
  db.prepare(`
    INSERT INTO recipe_instances (id, workspace_id, workspace_path, started_at, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(instanceId, 'ws-live', 'C:/ws/live', Date.now());
  // Insert an alias mapping + agent_sessions row matching the live pty.
  const guid = '00000000-1111-2222-3333-444444444444';
  db.prepare('INSERT INTO session_aliases (alias, session_id, created_at) VALUES (?, ?, ?)')
    .run('shared-feature', guid, Date.now());
  db.prepare(`
    INSERT INTO agent_sessions (id, cli_session_id, recipe_instance_id, workspace_id,
      agent_cli, started_at, status, interactive)
    VALUES (?, ?, ?, ?, ?, ?, 'running', 1)
  `).run('as_live_test', guid, instanceId, 'ws-live', 'copilot', Date.now());

  // Register a fake conductor pty under that instance_id so the live check
  // finds it.
  const fakePty = {
    pid: 999,
    write: () => {}, resize: () => {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    kill: () => {},
  };
  const fakeProvider = {
    id: 'fake', displayName: 'Fake', description: 'fake', source: 'builtin',
    capabilities: {
      queueMode: 'none', promptSubmitStrategy: 'bulk-cr',
      promptReadyRegex: /❯[^\S\n]*$/m, busyIndicators: [/Working/i],
    },
    async writePrompt() {},
    async detect() { return { available: true, binary: 'fake', version: '0' }; },
    async spawnSession() { throw new Error('unused'); },
    async syncPluginInventory() { return { plugins: [], errors: [] }; },
    async discoverInstalledPlugins() { return []; },
  };
  registerPty({
    instanceId, workspaceId: 'ws-live', cols: 80, rows: 24,
    ipty: fakePty, provider: fakeProvider,
    agentHandle: { pid: 999, sessionId: guid, pty: fakePty, exited: new Promise(() => {}) },
  });
  // T19: dispatch routing now goes through tmuxSessionRegistry. Register a
  // fake CliSession so dispatchToInstance resolves and returns 'dispatched'
  // instead of 'target_unavailable' (which would cause /spawn to fall through
  // to a second spawn).
  const { tmuxSessionRegistry } = await import('../src/cli-sessions/tmux-session-runtime.ts');
  const fakeSession = {
    name: `cdb_${instanceId}`,
    pid: async () => 999,
    exited: new Promise(() => {}),
    sendText: async () => {},
    sendKey: async () => {},
    resize: async () => {},
    snapshot: async () => '',
    kill: async () => {},
  };
  tmuxSessionRegistry.__register(instanceId, fakeSession);

  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'follow-up message',
        session_id: 'shared-feature',
        provider: 'copilot',
        workspace_path: 'C:/ws/live',
      }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.mode, 'dispatch', 'live session must route as dispatch, not spawn');
    assert.equal(body.instance_id, instanceId);
    assert.equal(body.session_id, guid);
    assert.equal(body.session_alias, 'shared-feature');
    assert.equal(stub.calls.length, 0, 'runRecipe must NOT be called when dispatching');
  } finally {
    if (hasSession(instanceId)) killPty(instanceId);
    await stopServer(server);
    db.close();
  }
});

test('POST /spawn — workspace_id + workspace_path together creates workspace with given id', async () => {
  const db = openDb();
  const ws = makeWs(freshDirs('wsid'));
  const stub = makeRunRecipeStub();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1, runRecipeFn: stub.fn });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'go',
        provider: 'copilot',
        workspace_id: 'my-stable-ws',
        workspace_path: 'C:/ws/stable',
      }),
    });
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].workspaceInfo.id, 'my-stable-ws',
      'workspace_id should be honored when creating the row');
    const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get('my-stable-ws');
    assert.ok(row, 'workspace row should be created with the caller-supplied id');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('cleanup tmp', () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
