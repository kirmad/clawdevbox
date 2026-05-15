/**
 * callback-api.test.mjs — exercises `/callback/<fire_id>` (spec 9.6).
 *
 * The dispatcher mints a per-fire secret + outDir when a script binding
 * starts, registers them in `dispatcher.activeRuns`, and exposes
 * `recordCallback(fire_id, secret, body)` for the HTTP route to call.
 * These tests poke `activeRuns` directly to simulate an in-flight fire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { Scheduler } from '../src/scheduler.ts';
import { handleCronApi } from '../src/cli/cron-api.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = resolve(__dirname, '.tmp', 'callback-api');

function freshTmp(name) {
  const p = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function makeWs() {
  return {
    projectDir: 'C:/test', globalDir: 'C:/test/.cdb',
    plugins: new Map(), triggerTypes: new Map(), triggerTypeErrors: [],
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
    const handled = await handleCronApi(req, res, ctx);
    if (!handled) {
      res.writeHead(404);
      res.end('not handled');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function stopServer(server) {
  await new Promise((r) => server.close(() => r()));
}

function makeCtx(db) {
  const ws = makeWs();
  const dispatcher = new Dispatcher(db, ws, { maxConcurrent: 1 });
  const scheduler = new Scheduler(db, dispatcher, ws);
  return {
    dispatcher,
    scheduler,
    ctx: {
      db, dispatcher, scheduler,
      dbPath: ':memory:', schemaVersion: 1,
      service: { pid: 1, port: 5201, started_at: 0, version: '0.0.0' },
      expectedToken: 'unused',
    },
  };
}

test('POST /callback/:fire_id — 401 without bearer', async () => {
  const db = openDb();
  const { ctx } = makeCtx(db);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/callback/fire_abc`, {
      method: 'POST', body: JSON.stringify({ hello: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server); db.close();
  }
});

test('POST /callback/:fire_id — 404 unknown fire', async () => {
  const db = openDb();
  const { ctx } = makeCtx(db);
  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/callback/fire_unknown`, {
      method: 'POST', body: JSON.stringify({ hello: 1 }),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer some-secret',
      },
    });
    assert.equal(r.status, 404);
  } finally {
    await stopServer(server); db.close();
  }
});

test('POST /callback/:fire_id — 401 with wrong bearer for active fire', async () => {
  const db = openDb();
  const { ctx, dispatcher } = makeCtx(db);
  const wsPath = freshTmp('wrong');
  const outDir = join(wsPath, '.clawdevbox', 'fires', 'fire_xyz', 'attempt-1');
  mkdirSync(outDir, { recursive: true });
  dispatcher.activeRuns = dispatcher.activeRuns ?? new Map();
  // Access private map via bracket notation — dispatcher exposes it for tests.
  const internal = dispatcher;
  internal.activeRuns.set('fire_xyz', { secret: 'real-secret', outDir });

  const { server, port } = await startServer(ctx);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/callback/fire_xyz`, {
      method: 'POST',
      body: JSON.stringify({ x: 1 }),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer not-the-real-secret',
      },
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server); db.close();
  }
});

test('POST /callback/:fire_id — 200 + appends to callbacks.json', async () => {
  const db = openDb();
  const { ctx, dispatcher } = makeCtx(db);
  const wsPath = freshTmp('ok');
  const outDir = join(wsPath, '.clawdevbox', 'fires', 'fire_good', 'attempt-1');
  mkdirSync(outDir, { recursive: true });
  const secret = 'my-secret-token';
  dispatcher.activeRuns.set('fire_good', { secret, outDir });

  const { server, port } = await startServer(ctx);
  try {
    // First call.
    let r = await fetch(`http://127.0.0.1:${port}/callback/fire_good`, {
      method: 'POST',
      body: JSON.stringify({ event: 'first' }),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
    });
    assert.equal(r.status, 200);
    let body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.received_at, 'number');

    // Second call — should append.
    r = await fetch(`http://127.0.0.1:${port}/callback/fire_good`, {
      method: 'POST',
      body: JSON.stringify({ event: 'second' }),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
    });
    assert.equal(r.status, 200);

    const cbPath = join(outDir, 'callbacks.json');
    assert.equal(existsSync(cbPath), true);
    const parsed = JSON.parse(readFileSync(cbPath, 'utf8'));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].mode, 'B');
    assert.equal(parsed[0].path, '/callback/fire_good');
    assert.equal(parsed[0].method, 'POST');
    assert.deepEqual(parsed[0].body, { event: 'first' });
    assert.deepEqual(parsed[1].body, { event: 'second' });
  } finally {
    await stopServer(server); db.close();
  }
});

test('cleanup tmp', () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
