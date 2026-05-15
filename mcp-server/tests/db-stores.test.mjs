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

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

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
