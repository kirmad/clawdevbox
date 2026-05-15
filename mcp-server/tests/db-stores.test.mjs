import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { resolve } from 'node:path';
import { runMigrations } from '../src/db/index.ts';
import {
  ensureWorkspace,
  getWorkspaceById,
  getWorkspaceByPath,
  listWorkspaces,
} from '../src/db/workspaces-store.ts';
import {
  attemptDir,
  claimNextFire,
  enqueueFire,
  getFire,
  listFires,
  markFireDead,
  markFireFailedShutdown,
  markFireFailedWithRetry,
  markFireForRetry,
  markFireSuccess,
  mintFireId,
} from '../src/db/fires-store.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function mkTrigger(db, ws_id, id) {
  db.prepare(
    `INSERT INTO triggers (id, workspace_id, type, params_json, cron_mode, registered_at)
     VALUES (?, ?, 'ado.x', '{}', 'inherit', ?)`,
  ).run(id, ws_id, Date.now());
  return id;
}

// ---------------------------------------------------------------- workspaces

test('ensureWorkspace upserts by path (no duplicate row)', () => {
  const db = open();
  const a = ensureWorkspace(db, { path: 'C:\\tmp\\ws1', name: 'one' });
  const b = ensureWorkspace(db, { path: 'C:\\tmp\\ws1', name: 'ignored-on-upsert' });
  assert.equal(a.id, b.id);
  const count = db.prepare('SELECT COUNT(*) AS c FROM workspaces').get();
  assert.equal(count.c, 1);
  db.close();
});

test('ensureWorkspace normalizes equivalent paths', () => {
  const db = open();
  const a = ensureWorkspace(db, { path: 'C:\\tmp\\ws-norm' });
  const b = ensureWorkspace(db, { path: resolve('C:\\tmp\\ws-norm\\.\\') });
  assert.equal(a.id, b.id);
  db.close();
});

test('getWorkspaceByPath / getWorkspaceById round-trip', () => {
  const db = open();
  const created = ensureWorkspace(db, { path: 'C:\\tmp\\ws2', name: 'two' });
  const byPath = getWorkspaceByPath(db, 'C:\\tmp\\ws2');
  const byId = getWorkspaceById(db, created.id);
  assert.equal(byPath?.id, created.id);
  assert.equal(byId?.path, created.path);
  assert.equal(byId?.name, 'two');
  db.close();
});

test('listWorkspaces returns all rows', () => {
  const db = open();
  ensureWorkspace(db, { path: 'C:\\tmp\\a' });
  ensureWorkspace(db, { path: 'C:\\tmp\\b' });
  ensureWorkspace(db, { path: 'C:\\tmp\\c' });
  const rows = listWorkspaces(db);
  assert.equal(rows.length, 3);
  db.close();
});

// ---------------------------------------------------------------- fires

test('enqueueFire creates a queued row with attempt=1', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f1' });
  const fire = enqueueFire(db, { workspace_id: ws.id, source: 'manual' });
  assert.equal(fire.status, 'queued');
  assert.equal(fire.attempt, 1);
  assert.ok(fire.scheduled_at > 0);
  db.close();
});

test('claimNextFire returns the row and marks it running', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f2' });
  const a = enqueueFire(db, { workspace_id: ws.id, source: 'manual' });
  const claimed = claimNextFire(db);
  assert.equal(claimed?.fire_id, a.fire_id);
  assert.equal(claimed?.status, 'running');
  assert.ok(claimed?.started_at != null);
  db.close();
});

test('claimNextFire returns null on empty queue', () => {
  const db = open();
  assert.equal(claimNextFire(db), null);
  db.close();
});

test('claimNextFire overlap-skips a second fire on the same trigger', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f3' });
  const trg = mkTrigger(db, ws.id, 'trg_overlap');
  const a = enqueueFire(db, { workspace_id: ws.id, source: 'cron', trigger_id: trg, scheduled_at: 1 });
  const b = enqueueFire(db, { workspace_id: ws.id, source: 'cron', trigger_id: trg, scheduled_at: 2 });
  const first = claimNextFire(db);
  assert.equal(first?.fire_id, a.fire_id);
  // Second claim: b's trigger has a running fire so b is skipped; queue is now empty.
  const second = claimNextFire(db);
  assert.equal(second, null);
  const bRow = getFire(db, b.fire_id);
  assert.equal(bRow?.status, 'skipped');
  assert.equal(bRow?.error, 'overlap_skip');
  db.close();
});

test('markFireSuccess sets finished_at, duration_ms', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f4' });
  const fire = enqueueFire(db, { workspace_id: ws.id, source: 'manual' });
  claimNextFire(db);
  markFireSuccess(db, fire.fire_id, { duration_ms: 1234, exit_code: 0 });
  const row = getFire(db, fire.fire_id);
  assert.equal(row?.status, 'success');
  assert.equal(row?.duration_ms, 1234);
  assert.ok(row?.finished_at != null);
  db.close();
});

test('markFireFailedWithRetry bumps attempt and sets retrying', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f5' });
  const fire = enqueueFire(db, { workspace_id: ws.id, source: 'manual' });
  claimNextFire(db);
  markFireFailedWithRetry(db, fire.fire_id, { error: 'boom', next_retry_at: 99999 });
  const row = getFire(db, fire.fire_id);
  assert.equal(row?.status, 'retrying');
  assert.equal(row?.attempt, 2);
  assert.equal(row?.next_retry_at, 99999);
  db.close();
});

test('markFireDead sets dead + error', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f6' });
  const fire = enqueueFire(db, { workspace_id: ws.id, source: 'manual' });
  claimNextFire(db);
  markFireDead(db, fire.fire_id, { error: 'gave-up' });
  const row = getFire(db, fire.fire_id);
  assert.equal(row?.status, 'dead');
  assert.equal(row?.error, 'gave-up');
  assert.ok(row?.finished_at != null);
  db.close();
});

test('markFireFailedShutdown / markFireForRetry transitions', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\f7' });
  const fire = enqueueFire(db, { workspace_id: ws.id, source: 'manual' });
  claimNextFire(db);
  markFireFailedShutdown(db, fire.fire_id);
  let row = getFire(db, fire.fire_id);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.error, 'service_shutdown');
  markFireForRetry(db, fire.fire_id);
  row = getFire(db, fire.fire_id);
  assert.equal(row?.status, 'queued');
  assert.equal(row?.attempt, 1);
  assert.equal(row?.error, null);
  db.close();
});

test('listFires filters by status, workspace, trigger', () => {
  const db = open();
  const ws1 = ensureWorkspace(db, { path: 'C:\\tmp\\fL1' });
  const ws2 = ensureWorkspace(db, { path: 'C:\\tmp\\fL2' });
  const t1 = mkTrigger(db, ws1.id, 'trg_l1');
  enqueueFire(db, { workspace_id: ws1.id, source: 'cron', trigger_id: t1 });
  enqueueFire(db, { workspace_id: ws1.id, source: 'manual' });
  enqueueFire(db, { workspace_id: ws2.id, source: 'manual' });
  assert.equal(listFires(db, { workspace_id: ws1.id }).length, 2);
  assert.equal(listFires(db, { trigger_id: t1 }).length, 1);
  assert.equal(listFires(db, { status: ['queued'] }).length, 3);
  assert.equal(listFires(db, { status: ['success'] }).length, 0);
  db.close();
});

test('mintFireId and attemptDir helpers', () => {
  const id = mintFireId();
  assert.match(id, /^fire_[a-z0-9]+_[0-9a-f]{4}$/);
  const dir = attemptDir('C:\\tmp\\ws', id, 2);
  assert.ok(dir.endsWith(`fires\\${id}\\attempt-2`) || dir.endsWith(`fires/${id}/attempt-2`));
});
