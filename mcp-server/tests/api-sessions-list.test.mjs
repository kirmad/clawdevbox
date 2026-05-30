/**
 * api-sessions-list.test.mjs — covers GET /api/sessions (the union list).
 *
 * Verifies the live pty-registry rows are merged with archived
 * agent_sessions rows, that live wins on instance_id collision, and that
 * the `since` / `limit` cursor paginates the archive without paginating
 * out the active section.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';
import { registerPty, hasSession, killPty, subscribe } from '../src/pty-registry.ts';

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
  };
}

function makeWs() {
  return {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map(),
    agentCliProviderErrors: [],
    pluginRenderers: new Map(),
    rendererErrors: [],
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
    schemaVersion: 3,
    service: { pid: 1, port: 5201, started_at: 0, version: '0.0.0' },
    expectedToken: null,
    ws,
  };
}

function registerFakeConductorPty(instanceId, { meta, workspaceId = 'ws-test' } = {}) {
  const pty = makeFakePty();
  const provider = makeFakeProvider();
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const handle = { pid: pty.pid, sessionId: 'sess_' + instanceId, pty, exited };
  registerPty({
    instanceId,
    workspaceId,
    cols: 80, rows: 24,
    ipty: pty,
    provider,
    agentHandle: handle,
    meta,
  });
}

function insertWorkspace(db, id, path) {
  db.prepare(
    `INSERT INTO workspaces (id, path, name, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, path, id, Date.now());
}

function insertRecipeInstance(db, id, recipeId, workspaceId) {
  db.prepare(
    `INSERT INTO recipe_instances (
       id, recipe_id, workspace_id, workspace_path, started_at, status
     ) VALUES (?, ?, ?, ?, ?, 'success')`,
  ).run(id, recipeId, workspaceId, 'C:/ws', Date.now());
}

function insertArchivedSession(db, opts) {
  const {
    id, workspaceId, agentCli = 'copilot',
    recipeInstanceId = null, cliSessionId = null,
    startedAt = Date.now(), endedAt = Date.now(),
    status = 'success',
  } = opts;
  db.prepare(
    `INSERT INTO agent_sessions (
       id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
       started_at, ended_at, status, interactive
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, cliSessionId, recipeInstanceId, workspaceId, agentCli, startedAt, endedAt, status);
}

function cleanupRegistry(...instanceIds) {
  for (const id of instanceIds) {
    if (hasSession(id)) {
      try { killPty(id); } catch { /* ignore */ }
      // killPty fires our fake pty's onExit synchronously, marking
      // session.exited=true with no subscribers. Add+remove a subscriber
      // to trip pty-registry's "exited && subscribers===0 → delete"
      // branch and fully evict the session immediately (otherwise the
      // 10s EXIT_RETAIN_MS keeps it visible across tests).
      try {
        const { unsubscribe } = subscribe(id, () => {});
        unsubscribe();
      } catch { /* ignore */ }
    }
  }
}

test('GET /api/sessions — no sessions returns empty items', async () => {
  const db = openDb();
  const ws = makeWs();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.items));
    assert.equal(body.items.length, 0);
    assert.equal(body.next_since, undefined);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions — main pty registers as live with kind="main"', async () => {
  const db = openDb();
  const ws = makeWs();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  const instanceId = 'main';
  registerFakeConductorPty(instanceId, {
    meta: { agentCli: 'copilot', sessionId: 'sess_main', recipeId: null },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.instance_id, 'main');
    assert.equal(item.live, true);
    assert.equal(item.kind, 'main');
    assert.equal(item.label, 'Main Agent');
    assert.equal(item.provider_id, 'copilot');
    assert.equal(item.cli_session_id, 'sess_main');
    assert.equal(typeof item.queue_depth, 'number');
  } finally {
    cleanupRegistry(instanceId);
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions — live recipe instance has kind="recipe"', async () => {
  const db = openDb();
  const ws = makeWs();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  const instanceId = 'ri_abc123';
  registerFakeConductorPty(instanceId, {
    meta: { agentCli: 'copilot', sessionId: 'sess_x', recipeId: 'my-recipe' },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const body = await r.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'recipe');
    assert.equal(body.items[0].label, 'my-recipe');
    assert.equal(body.items[0].recipe_id, 'my-recipe');
  } finally {
    cleanupRegistry(instanceId);
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions?status=archived — archived row appears with live=false', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'ws1', 'C:/ws');
  insertRecipeInstance(db, 'ri_arch_1', 'pr-review', 'ws1');
  insertArchivedSession(db, {
    id: 'as_1', workspaceId: 'ws1', recipeInstanceId: 'ri_arch_1',
    cliSessionId: 'sess_arch_1', agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions?status=archived`);
    const body = await r.json();
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.equal(item.live, false);
    assert.equal(item.state, 'archived');
    assert.equal(item.instance_id, 'ri_arch_1');
    assert.equal(item.recipe_id, 'pr-review');
    assert.equal(item.kind, 'recipe');
    assert.equal(item.cli_session_id, 'sess_arch_1');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions — adhoc recipe_id derives kind="adhoc"', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'ws1', 'C:/ws');
  insertRecipeInstance(db, 'ri_adhoc_1', '__adhoc_ri_adhoc_1', 'ws1');
  insertArchivedSession(db, {
    id: 'as_adhoc', workspaceId: 'ws1', recipeInstanceId: 'ri_adhoc_1',
    cliSessionId: 'sess_ah', agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions?status=archived`);
    const body = await r.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].kind, 'adhoc');
    assert.match(body.items[0].label, /^Spawn /);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions — live and archived with same instance_id: live wins', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'ws1', 'C:/ws');
  insertRecipeInstance(db, 'ri_same', 'rcp', 'ws1');
  insertArchivedSession(db, {
    id: 'as_same', workspaceId: 'ws1', recipeInstanceId: 'ri_same',
    cliSessionId: 'sess_arch', agentCli: 'copilot',
  });
  registerFakeConductorPty('ri_same', {
    meta: { agentCli: 'copilot', sessionId: 'sess_live', recipeId: 'rcp' },
    workspaceId: 'ws1',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const body = await r.json();
    assert.equal(body.items.length, 1, JSON.stringify(body.items));
    assert.equal(body.items[0].live, true);
    assert.equal(body.items[0].cli_session_id, 'sess_live');
  } finally {
    cleanupRegistry('ri_same');
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions — pagination via limit + next_since cursor', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsP', 'C:/wsP');
  // Insert 60 archived sessions with descending started_at so newest=now,
  // oldest=now-60.
  const base = Date.now();
  for (let i = 0; i < 60; i++) {
    const ri = `ri_p_${i}`;
    insertRecipeInstance(db, ri, 'rcp', 'wsP');
    insertArchivedSession(db, {
      id: `as_p_${i}`,
      workspaceId: 'wsP',
      recipeInstanceId: ri,
      cliSessionId: `sess_p_${i}`,
      agentCli: 'copilot',
      startedAt: base - i,
      endedAt: base - i + 10,
    });
  }
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws));
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/api/sessions?status=archived&limit=25`);
    const b1 = await r1.json();
    assert.equal(b1.items.length, 25);
    assert.ok(typeof b1.next_since === 'number', 'next_since should be set when full page');

    // Subsequent page: pass next_since back as `since`.
    // The cursor is the oldest row's exact started_at; listAllSessions
    // filters with `started_at < since`, so the next page starts strictly
    // older than the previous page's last row — no duplicates, no skips.
    const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions?status=archived&limit=25&since=${b1.next_since}`);
    const b2 = await r2.json();
    assert.ok(b2.items.length > 0, 'second page should return more rows');
    // No duplicate instance_ids across pages.
    const ids1 = new Set(b1.items.map((i) => i.instance_id));
    for (const it of b2.items) {
      assert.ok(!ids1.has(it.instance_id), `dup across pages: ${it.instance_id}`);
    }
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/sessions — 401 when expectedToken set and bearer missing', async () => {
  const db = openDb();
  const ws = makeWs();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const ctx = makeCtx(db, dispatcher, ws);
  ctx.expectedToken = 'expected';
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    assert.equal(r.status, 401);
    const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { authorization: 'Bearer expected' },
    });
    assert.equal(r2.status, 200);
  } finally {
    await stopServer(server);
    db.close();
  }
});
