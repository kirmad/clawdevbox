/**
 * memory-sync-register.test.mjs
 *
 * Regression tests for ensureMemorySyncInstance (src/memory-sync-register.ts).
 *
 * On a fresh deployment, triggers.workspace_id references workspaces(id), but
 * the bootstrap previously inserted the literal id "global" without creating
 * that workspace. With foreign keys enabled, startup failed and no memory-sync
 * trigger was registered.
 *
 * The bootstrap must also seed state_json from params because the dispatcher
 * passes state_json to the script without merging params_json.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureMemorySyncInstance } from '../src/memory-sync-register.ts';

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'memsync-reg-'));
process.env.CLAWDEVBOX_GLOBAL_DIR = join(TMP_ROOT, 'global');
process.env.CLAWDEVBOX_WORKSPACES_ROOT = join(TMP_ROOT, 'workspaces');

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT,
      parent_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE triggers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT,
      params_json TEXT NOT NULL,
      cron_mode TEXT NOT NULL CHECK(cron_mode IN ('inherit','override','disabled')),
      cron_expression TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      registered_at INTEGER NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

test('startup without a global workspace registers memory-sync without an FK error', () => {
  const db = makeDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM workspaces').get().c, 0);
  assert.doesNotThrow(() => ensureMemorySyncInstance(db));
  const row = db.prepare(`SELECT COUNT(*) AS c FROM triggers WHERE type='memory-sync'`).get();
  assert.equal(row.c, 1);
});

test('registered instance references an existing workspace row', () => {
  const db = makeDb();
  ensureMemorySyncInstance(db);
  const trigger = db.prepare(
    `SELECT workspace_id FROM triggers WHERE type='memory-sync'`,
  ).get();
  assert.ok(trigger);
  const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(trigger.workspace_id);
  assert.ok(workspace);
});

test('ensureMemorySyncInstance is idempotent (no duplicate rows)', () => {
  const db = makeDb();
  ensureMemorySyncInstance(db);
  ensureMemorySyncInstance(db);
  ensureMemorySyncInstance(db);
  const row = db.prepare(`SELECT COUNT(*) AS c FROM triggers WHERE type='memory-sync'`).get();
  assert.equal(row.c, 1);
});

test('bootstrap instance seeds state_json from params so the script honors them', () => {
  const db = makeDb();
  ensureMemorySyncInstance(db);
  const row = db.prepare(
    `SELECT state_json, params_json FROM triggers WHERE type='memory-sync'`,
  ).get();

  const params = JSON.parse(row.params_json);
  // Sanity: params carry the documented defaults.
  assert.equal(params.vault_scope, 'all');
  assert.equal(params.auto_push, true);

  // The dispatcher hands the SCRIPT `envelope.state = state_json`. The script
  // reads state.vault_scope / state.auto_push, so those keys MUST be present
  // in state_json — otherwise the registered params are silently ignored.
  const state = JSON.parse(row.state_json);
  assert.equal(state.vault_scope, 'all',
    `state_json must seed vault_scope from params; got state_json=${row.state_json}`);
  assert.equal(state.auto_push, true,
    `state_json must seed auto_push from params; got state_json=${row.state_json}`);
});
