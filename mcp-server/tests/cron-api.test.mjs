/**
 * cron-api.test.mjs — covers /api/cron/* and /api/fires/* HTTP routes.
 *
 * Spins up a local http.Server that delegates to `handleCronApi` (the same
 * function `cli/start.ts` mounts) and exercises every route with and
 * without a bearer token. The dispatcher/scheduler used here are real —
 * we only fake the workspace object (no plugin loading needed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = resolve(__dirname, '.tmp', 'cron-api');

function freshTmp(name) {
  const p = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  mkdirSync(p, { recursive: true });
  return p;
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
  const addr = server.address();
  return { server, port: addr.port };
}

async function stopServer(server) {
  await new Promise((r) => server.close(() => r()));
}

function insertTrigger(db, opts) {
  db.prepare(
    `INSERT INTO triggers (
       id, workspace_id, type, params_json,
       cron_mode, cron_expression, enabled,
       binds_callback_to, binds_callback_to_recipe,
       once, max_attempts, backoff_ms_json,
       registered_at, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id, opts.workspace_id, opts.type, JSON.stringify(opts.params ?? {}),
    opts.cron_mode ?? 'disabled', opts.cron_expression ?? null,
    opts.enabled === false ? 0 : 1,
    opts.binds_callback_to ?? null, opts.binds_callback_to_recipe ?? null,
    opts.once ? 1 : 0,
    opts.max_attempts ?? 3, JSON.stringify(opts.backoff_ms ?? [10, 10, 10]),
    Date.now(), JSON.stringify(opts.state ?? {}),
  );
}

function enqueueFire(db, opts) {
  const fire_id = `fire_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
  db.prepare(
    `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at, output_dir)
     VALUES (?, ?, ?, 'manual', ?, 1, ?, ?, ?)`,
  ).run(
    fire_id, opts.workspace_id, opts.trigger_id, opts.status ?? 'queued',
    opts.max_attempts ?? 3, opts.scheduled_at ?? Date.now(),
    opts.output_dir ?? null,
  );
  return fire_id;
}

function makeCtx(db, ws, expectedToken = 'test-token-123') {
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  // Don't start the dispatcher — we don't want it actually picking up fires
  // and racing the test assertions. We only need its status() + retry hooks.
  const scheduler = new Scheduler(db, dispatcher, ws);
  // Don't start the scheduler either; we don't want safety timers ticking.
  return {
    ctx: {
      db,
      dispatcher,
      scheduler,
      dbPath: ':memory:',
      schemaVersion: 1,
      service: { pid: 12345, port: 5201, started_at: 1715534812000, version: '0.1.0' },
      expectedToken,
    },
    dispatcher,
    scheduler,
  };
}

const TOKEN = 'test-token-abc';
const AUTH = { authorization: `Bearer ${TOKEN}` };

test('GET /api/cron/status — 200 with full shape', async () => {
  const db = openDb();
  const ws = makeWs();
  const { ctx } = makeCtx(db, ws, TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/cron/status`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.service);
    assert.equal(typeof body.service.pid, 'number');
    assert.ok(body.scheduler);
    assert.equal(typeof body.scheduler.total_wakes, 'number');
    assert.ok(body.dispatcher);
    assert.equal(typeof body.dispatcher.max_concurrent, 'number');
    assert.ok(body.db);
    assert.equal(typeof body.db.schema_version, 'number');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/cron/status — 401 without bearer', async () => {
  const db = openDb();
  const { ctx } = makeCtx(db, makeWs());
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/cron/status`);
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/cron/status — 401 with wrong bearer', async () => {
  const db = openDb();
  const { ctx } = makeCtx(db, makeWs(), 'right-token');
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/cron/status`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/fires — filters status and respects limit', async () => {
  const db = openDb();
  const wsPath = freshTmp('list');
  const wsRow = ensureWorkspace(db, { path: wsPath });
  insertTrigger(db, { id: 't1', workspace_id: wsRow.id, type: 'demo.x' });
  const fids = [];
  for (let i = 0; i < 3; i++) fids.push(enqueueFire(db, { workspace_id: wsRow.id, trigger_id: 't1', status: 'queued', scheduled_at: Date.now() + i }));
  const failed = enqueueFire(db, { workspace_id: wsRow.id, trigger_id: 't1', status: 'failed', scheduled_at: Date.now() + 10 });

  const { ctx } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    let r = await fetch(`http://127.0.0.1:${port}/api/fires?limit=2`, { headers: AUTH });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.count, 2);
    assert.equal(body.fires.length, 2);
    assert.notEqual(body.next_offset, null);

    r = await fetch(`http://127.0.0.1:${port}/api/fires?status=failed`, { headers: AUTH });
    body = await r.json();
    assert.equal(body.count, 1);
    assert.equal(body.fires[0].fire_id, failed);

    r = await fetch(`http://127.0.0.1:${port}/api/fires?trigger_id=t1`, { headers: AUTH });
    body = await r.json();
    assert.equal(body.count, 4);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/fires/:id — reads stdout/stderr/callbacks from attempt-N', async () => {
  const db = openDb();
  const wsPath = freshTmp('detail');
  const wsRow = ensureWorkspace(db, { path: wsPath });
  insertTrigger(db, { id: 't1', workspace_id: wsRow.id, type: 'demo.x' });
  const fireId = enqueueFire(db, { workspace_id: wsRow.id, trigger_id: 't1', status: 'success' });
  // Set output_dir + write artifacts.
  const fireDir = join(wsPath, '.clawdevbox', 'fires', fireId);
  const att1 = join(fireDir, 'attempt-1');
  mkdirSync(att1, { recursive: true });
  writeFileSync(join(att1, 'stdout.txt'), 'hello stdout');
  writeFileSync(join(att1, 'stderr.txt'), 'hello stderr');
  writeFileSync(join(att1, 'callbacks.json'), JSON.stringify([{ mode: 'A', body: { x: 1 }, received_at: 1 }]));
  const att2 = join(fireDir, 'attempt-2');
  mkdirSync(att2, { recursive: true });
  writeFileSync(join(att2, 'stdout.txt'), 'second attempt');
  db.prepare(`UPDATE fires SET output_dir = ? WHERE fire_id = ?`).run(fireDir, fireId);

  const { ctx } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    let r = await fetch(`http://127.0.0.1:${port}/api/fires/${fireId}`, { headers: AUTH });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.fire.fire_id, fireId);
    // Latest attempt = 2.
    assert.equal(body.stdout, 'second attempt');
    assert.deepEqual(body.attempts_available, [1, 2]);
    assert.equal(body.truncated, false);

    r = await fetch(`http://127.0.0.1:${port}/api/fires/${fireId}?attempt=1`, { headers: AUTH });
    body = await r.json();
    assert.equal(body.stdout, 'hello stdout');
    assert.equal(body.stderr, 'hello stderr');
    assert.equal(body.callbacks.length, 1);
    assert.equal(body.callbacks[0].mode, 'A');
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('GET /api/fires/:id — 404 unknown', async () => {
  const db = openDb();
  const { ctx } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/fires/no_such_fire`, { headers: AUTH });
    assert.equal(r.status, 404);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/fires/:id/retry — failed fire transitions to queued', async () => {
  const db = openDb();
  const wsRow = ensureWorkspace(db, { path: freshTmp('retry') });
  insertTrigger(db, { id: 't1', workspace_id: wsRow.id, type: 'demo.x' });
  const fireId = enqueueFire(db, { workspace_id: wsRow.id, trigger_id: 't1', status: 'failed' });

  const { ctx } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/fires/${fireId}/retry`, {
      method: 'POST',
      headers: AUTH,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.fire_id, fireId);
    assert.equal(body.status, 'queued');
    const row = db.prepare(`SELECT status, attempt FROM fires WHERE fire_id = ?`).get(fireId);
    assert.equal(row.status, 'queued');
    assert.equal(row.attempt, 1);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/fires/:id/retry — success fire returns 409', async () => {
  const db = openDb();
  const wsRow = ensureWorkspace(db, { path: freshTmp('retry-409') });
  insertTrigger(db, { id: 't1', workspace_id: wsRow.id, type: 'demo.x' });
  const fireId = enqueueFire(db, { workspace_id: wsRow.id, trigger_id: 't1', status: 'success' });

  const { ctx } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/fires/${fireId}/retry`, {
      method: 'POST',
      headers: AUTH,
    });
    assert.equal(r.status, 409);
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('POST /api/cron/diagnose — returns scheduler status', async () => {
  const db = openDb();
  const { ctx, scheduler } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/cron/diagnose`, {
      method: 'POST',
      headers: AUTH,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok('next_wake_at' in body);
    assert.ok('total_wakes' in body);
  } finally {
    await stopServer(server);
    scheduler.stop();
    db.close();
  }
});

test('all /api/fires/* + /api/cron/* return 401 without bearer', async () => {
  const db = openDb();
  const { ctx } = makeCtx(db, makeWs(), TOKEN);
  const { server, port } = await startServer(ctx);
  try {
    for (const path of [
      '/api/cron/status',
      '/api/fires',
      '/api/fires/abc',
      '/api/cron/diagnose',
      '/api/fires/abc/retry',
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: path.includes('diagnose') || path.includes('retry') ? 'POST' : 'GET' });
      assert.equal(r.status, 401, `${path} should be 401 without auth`);
    }
  } finally {
    await stopServer(server);
    db.close();
  }
});

test('cleanup tmp', () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
