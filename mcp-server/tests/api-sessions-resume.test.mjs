/**
 * api-sessions-resume.test.mjs — covers POST /api/sessions/<id>/resume.
 *
 * Uses the CronApiContext.runRecipeFn injection seam to swap in a stub
 * runRecipe that records the call and returns a deterministic result so
 * the endpoint can be exercised without spinning a real pty.
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

function makeWs(extraProviders = {}) {
  const agentCliProviders = new Map();
  const baseProviders = {
    copilot: { id: 'copilot', displayName: 'Copilot', source: 'builtin', supportsResume: true },
    'echo-stub': { id: 'echo-stub', displayName: 'Echo', source: 'builtin', supportsResume: false },
    ...extraProviders,
  };
  for (const [id, p] of Object.entries(baseProviders)) {
    agentCliProviders.set(id, p);
  }
  return {
    // Use process.cwd() so resolveConfig's existsSync check passes;
    // the stubbed runRecipeFn ignores cfg contents.
    projectDir: process.cwd(),
    globalDir: process.cwd(),
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders,
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

function makeCtx(db, dispatcher, ws, opts = {}) {
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
    runRecipeFn: opts.runRecipeFn,
  };
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
    status = 'success',
  } = opts;
  db.prepare(
    `INSERT INTO agent_sessions (
       id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
       started_at, ended_at, status, interactive
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, cliSessionId, recipeInstanceId, workspaceId, agentCli,
        Date.now() - 10_000, Date.now(), status);
}

function makeFakePty() {
  const exitListeners = [];
  return {
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => { for (const cb of exitListeners) cb({ exitCode: 0, signal: undefined }); },
    onData: () => ({ dispose() {} }),
    onExit: (cb) => { exitListeners.push(cb); return { dispose() {} }; },
  };
}

function makeStubRunRecipe(result) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    if (result instanceof Error) throw result;
    return {
      recipe_instance_id: 'ri_new_resume',
      recipe_id: opts.recipeId ?? `__adhoc_ri_new_resume`,
      adhoc: !!opts.isAdhoc,
      workspace_id: opts.workspaceInfo.id,
      workspace_path: opts.workspaceInfo.path,
      attach_to_inbox_item_id: null,
      pid: 7777,
      agent_cli: opts.agentCli ?? 'copilot',
      session_id: 'sess_new_resume',
      resume_of: opts.resumeOf ?? null,
      status: 'spawned',
      log_path: 'C:/tmp/log.txt',
      view_url: null,
      ...(result ?? {}),
    };
  };
  return { fn, calls };
}

test('POST /api/sessions/<id>/resume — happy path returns new instance + marks original', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsR', 'C:/wsR');
  insertRecipeInstance(db, 'ri_old', 'pr-review', 'wsR');
  insertArchivedSession(db, {
    id: 'as_old', workspaceId: 'wsR', recipeInstanceId: 'ri_old',
    cliSessionId: 'sess_old_xyz', agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe();
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_old/resume`, { method: 'POST' });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.new_instance_id, 'ri_new_resume');
    assert.equal(body.session_id, 'sess_new_resume');

    // runRecipe was called with resumeOf=cli_session_id and the workspace
    // info looked up from the DB.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].resumeOf, 'sess_old_xyz');
    assert.equal(stub.calls[0].workspaceInfo.id, 'wsR');
    assert.equal(stub.calls[0].workspaceInfo.path, 'C:/wsR');
    assert.equal(stub.calls[0].recipeId, 'pr-review');
    assert.equal(stub.calls[0].isAdhoc, false);
    assert.equal(stub.calls[0].spawnMode, 'interactive');

    // Original archived row got `resumed_into_instance_id` set.
    const updated = db
      .prepare('SELECT resumed_into_instance_id FROM agent_sessions WHERE id = ?')
      .get('as_old');
    assert.equal(updated.resumed_into_instance_id, 'ri_new_resume');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — ad-hoc original sets isAdhoc=true, recipeId=null', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsA', 'C:/wsA');
  insertRecipeInstance(db, 'ri_ah', '__adhoc_ri_ah', 'wsA');
  insertArchivedSession(db, {
    id: 'as_ah', workspaceId: 'wsA', recipeInstanceId: 'ri_ah',
    cliSessionId: 'sess_ah', agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe();
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_ah/resume`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].isAdhoc, true);
    assert.equal(stub.calls[0].recipeId, null);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — 400 when session is currently live', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsL', 'C:/wsL');
  const pty = makeFakePty();
  registerPty({
    instanceId: 'ri_live',
    workspaceId: 'wsL',
    cols: 80, rows: 24,
    ipty: pty,
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe();
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_live/resume`, { method: 'POST' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /currently live/);
    assert.equal(stub.calls.length, 0);
  } finally {
    if (hasSession('ri_live')) killPty('ri_live');
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — 404 when session unknown', async () => {
  const db = openDb();
  const ws = makeWs();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe();
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/nope/resume`, { method: 'POST' });
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /not found/);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — 422 when provider does not support resume', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsE', 'C:/wsE');
  insertRecipeInstance(db, 'ri_echo', 'r', 'wsE');
  insertArchivedSession(db, {
    id: 'as_echo', workspaceId: 'wsE', recipeInstanceId: 'ri_echo',
    cliSessionId: 'sess_echo', agentCli: 'echo-stub',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe();
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_echo/resume`, { method: 'POST' });
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.match(body.error, /does not support --resume/);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — 422 when row has no cli_session_id', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsN', 'C:/wsN');
  insertRecipeInstance(db, 'ri_nocli', 'r', 'wsN');
  insertArchivedSession(db, {
    id: 'as_nocli', workspaceId: 'wsN', recipeInstanceId: 'ri_nocli',
    cliSessionId: null, agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe();
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_nocli/resume`, { method: 'POST' });
    assert.equal(r.status, 422);
    const body = await r.json();
    assert.match(body.error, /no cli_session_id/);
    assert.equal(stub.calls.length, 0);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — 500 when runRecipe throws', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsF', 'C:/wsF');
  insertRecipeInstance(db, 'ri_fail', 'r', 'wsF');
  insertArchivedSession(db, {
    id: 'as_fail', workspaceId: 'wsF', recipeInstanceId: 'ri_fail',
    cliSessionId: 'sess_fail', agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe(new Error('boom'));
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_fail/resume`, { method: 'POST' });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.match(body.error, /spawn failed.*boom/);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/sessions/<id>/resume — 500 when runRecipe returns spawn_error', async () => {
  const db = openDb();
  const ws = makeWs();
  insertWorkspace(db, 'wsS', 'C:/wsS');
  insertRecipeInstance(db, 'ri_se', 'r', 'wsS');
  insertArchivedSession(db, {
    id: 'as_se', workspaceId: 'wsS', recipeInstanceId: 'ri_se',
    cliSessionId: 'sess_se', agentCli: 'copilot',
  });
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const stub = makeStubRunRecipe({ spawn_error: { code: 'X', message: 'fizz' } });
  const { server, port } = await startServer(makeCtx(db, dispatcher, ws, { runRecipeFn: stub.fn }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/ri_se/resume`, { method: 'POST' });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.match(body.error, /spawn failed.*X.*fizz/);
  } finally {
    await stopServer(server);
    db.close();
  }
});
