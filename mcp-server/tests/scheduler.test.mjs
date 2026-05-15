import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { Scheduler } from '../src/scheduler.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeWs(triggerTypes = []) {
  const ws = {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
  };
  for (const t of triggerTypes) ws.triggerTypes.set(t.id, t);
  return ws;
}

function fakeDispatcher() {
  const calls = [];
  return {
    calls,
    pickUp() { calls.push(Date.now()); },
  };
}

function insertTrigger(db, wsId, id, opts = {}) {
  db.prepare(
    `INSERT INTO triggers (id, workspace_id, type, params_json, cron_mode, cron_expression, enabled, registered_at, max_attempts)
     VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    wsId,
    opts.type ?? 'demo.t',
    opts.cron_mode ?? 'override',
    opts.cron_expression ?? null,
    opts.enabled === false ? 0 : 1,
    opts.registered_at ?? Date.now(),
    opts.max_attempts ?? 3,
  );
}

test('scheduler: empty DB → reschedule sets next_wake_at null', () => {
  const db = open();
  const ws = makeWs();
  const dispatcher = fakeDispatcher();
  const s = new Scheduler(db, dispatcher, ws);
  s.reschedule();
  assert.equal(s.status().next_wake_at, null);
  db.close();
});

test('scheduler: one trigger with cron every second → next_wake_at within ~2s', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch1' });
  insertTrigger(db, w.id, 'demo.t#a', { cron_expression: '*/1 * * * * *' });
  const ws = makeWs();
  const s = new Scheduler(db, fakeDispatcher(), ws);
  s.reschedule();
  const next = s.status().next_wake_at;
  assert.ok(typeof next === 'number', 'next_wake_at should be a number');
  const dt = next - Date.now();
  assert.ok(dt >= 0 && dt <= 2000, `expected wake within 0-2s; got ${dt}`);
  db.close();
});

test('scheduler: multiple triggers → next_wake_at is the soonest', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch2' });
  // Every 5 minutes vs every 1 minute — the 1m wins.
  insertTrigger(db, w.id, 'demo.t#5m', { cron_expression: '*/5 * * * *' });
  insertTrigger(db, w.id, 'demo.t#1m', { cron_expression: '* * * * *' });
  const s = new Scheduler(db, fakeDispatcher(), makeWs());
  s.reschedule();
  const next = s.status().next_wake_at;
  assert.ok(typeof next === 'number');
  // < 65s away (within next minute boundary)
  assert.ok(next - Date.now() <= 65_000);
  db.close();
});

test('scheduler: retrying fire with sooner next_retry_at wins', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch3' });
  insertTrigger(db, w.id, 'demo.t#a', { cron_expression: '0 0 1 1 *' }); // very far future
  const retryAt = Date.now() + 1000;
  db.prepare(
    `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at, next_retry_at)
     VALUES ('fr_x', ?, 'demo.t#a', 'cron', 'retrying', 2, 3, ?, ?)`,
  ).run(w.id, Date.now() - 1000, retryAt);
  const s = new Scheduler(db, fakeDispatcher(), makeWs());
  s.reschedule();
  assert.equal(s.status().next_wake_at, retryAt);
  db.close();
});

test('scheduler: onWake enqueues all due cron triggers in one tx', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch4' });
  // Use cron that fires every second so the boundary in [now-1000, now+50] catches it.
  insertTrigger(db, w.id, 'demo.t#a', { cron_expression: '*/1 * * * * *' });
  insertTrigger(db, w.id, 'demo.t#b', { cron_expression: '*/1 * * * * *' });
  const dispatcher = fakeDispatcher();
  const s = new Scheduler(db, dispatcher, makeWs());
  s.onWake();
  const rows = db.prepare(`SELECT * FROM fires WHERE status='queued'`).all();
  assert.equal(rows.length, 2);
  assert.equal(dispatcher.calls.length, 1, 'dispatcher.pickUp should be called once');
  db.close();
});

test('scheduler: onWake promotes retrying fires whose next_retry_at <= now', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch5' });
  insertTrigger(db, w.id, 'demo.t#x', { cron_expression: '0 0 1 1 *' });
  // Past-due retry
  db.prepare(
    `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at, next_retry_at)
     VALUES ('fr_past', ?, 'demo.t#x', 'cron', 'retrying', 2, 3, ?, ?)`,
  ).run(w.id, Date.now() - 5000, Date.now() - 100);
  // Future retry
  db.prepare(
    `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at, next_retry_at)
     VALUES ('fr_future', ?, 'demo.t#x', 'cron', 'retrying', 2, 3, ?, ?)`,
  ).run(w.id, Date.now() - 5000, Date.now() + 60_000);
  const s = new Scheduler(db, fakeDispatcher(), makeWs());
  s.onWake();
  const past = db.prepare(`SELECT status FROM fires WHERE fire_id='fr_past'`).get();
  const future = db.prepare(`SELECT status FROM fires WHERE fire_id='fr_future'`).get();
  assert.equal(past.status, 'queued');
  assert.equal(future.status, 'retrying');
  db.close();
});

test('scheduler: skip-missed — old boundary not enqueued; recent within 1s window is', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch6' });
  // Daily at midnight — boundary at midnight likely well in the past, not within 1s.
  insertTrigger(db, w.id, 'demo.t#daily', { cron_expression: '0 0 * * *' });
  // Every second — boundary always within 1s.
  insertTrigger(db, w.id, 'demo.t#every', { cron_expression: '*/1 * * * * *' });
  const s = new Scheduler(db, fakeDispatcher(), makeWs());
  s.onWake();
  const rows = db.prepare(`SELECT trigger_id FROM fires WHERE status='queued'`).all();
  const ids = rows.map((r) => r.trigger_id).sort();
  assert.deepEqual(ids, ['demo.t#every'], 'only the every-second trigger should fire');
  db.close();
});

test('scheduler: inherit cron resolves via ws.triggerTypes', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch7' });
  insertTrigger(db, w.id, 'plug.t#x', { cron_mode: 'inherit', cron_expression: null, type: 'plug.t' });
  const ws = makeWs([{ id: 'plug.t', default_cron: '*/1 * * * * *' }]);
  const s = new Scheduler(db, fakeDispatcher(), ws);
  s.reschedule();
  const next = s.status().next_wake_at;
  assert.ok(typeof next === 'number', 'next_wake_at should resolve via inherit');
  assert.ok(next - Date.now() <= 2000);
  db.close();
});

test('scheduler: disabled cron mode is skipped', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch8' });
  insertTrigger(db, w.id, 'demo.t#dis', { cron_mode: 'disabled', cron_expression: null });
  const s = new Scheduler(db, fakeDispatcher(), makeWs());
  s.reschedule();
  assert.equal(s.status().next_wake_at, null);
  db.close();
});

test('scheduler: persists scheduler:next_wake_at + last_reschedule_at to kv', () => {
  const db = open();
  const w = ensureWorkspace(db, { path: 'C:/tmp/sch9' });
  insertTrigger(db, w.id, 'demo.t#a', { cron_expression: '*/1 * * * * *' });
  const s = new Scheduler(db, fakeDispatcher(), makeWs());
  s.reschedule();
  const nw = db.prepare(`SELECT value FROM kv WHERE key='scheduler:next_wake_at'`).get();
  const lr = db.prepare(`SELECT value FROM kv WHERE key='scheduler:last_reschedule_at'`).get();
  assert.ok(nw && nw.value !== '');
  assert.ok(lr && lr.value !== '');
  db.close();
});
