import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { migrations } from '../src/db/migrations.ts';

const EXPECTED_TABLES = [
  'schema_version',
  'kv',
  'workspaces',
  'triggers',
  'recipe_instances',
  'recipe_steps',
  'agent_sessions',
  'artifacts',
  'inbox_items',
  'fires',
  'step_events',
];

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

test('migrations create all v1 tables', () => {
  const db = open();
  runMigrations(db);
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of EXPECTED_TABLES) {
    assert.ok(rows.includes(t), `missing table: ${t}`);
  }
  const versions = db
    .prepare('SELECT version FROM schema_version ORDER BY version')
    .all()
    .map((r) => r.version);
  assert.deepEqual(versions, migrations.map((m) => m.version));
  db.close();
});

test('migrations are idempotent across multiple runs', () => {
  const db = open();
  runMigrations(db);
  // running again must not throw and must not duplicate version rows
  runMigrations(db);
  const rows = db.prepare('SELECT COUNT(*) AS c FROM schema_version').get();
  assert.equal(rows.c, migrations.length);
  db.close();
});

test('foreign-key violation throws when inserting trigger with missing workspace', () => {
  const db = open();
  runMigrations(db);
  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO triggers (
           id, workspace_id, type, params_json, cron_mode, registered_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('trg_1', 'nope-no-such-ws', 'ado.x', '{}', 'inherit', Date.now());
    },
    /FOREIGN KEY|foreign key/i,
  );
  db.close();
});

test('CHECK constraint rejects bogus status on recipe_instances', () => {
  const db = open();
  runMigrations(db);
  db.prepare(
    `INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)`,
  ).run('ws_1', 'C:\\tmp', Date.now());
  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO recipe_instances (
           id, workspace_id, workspace_path, started_at, status
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run('ri_1', 'ws_1', 'C:\\tmp', Date.now(), 'bogus');
    },
    /CHECK constraint/i,
  );
  db.close();
});

test('CHECK constraint rejects bogus source on fires', () => {
  const db = open();
  runMigrations(db);
  db.prepare(
    `INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)`,
  ).run('ws_1', 'C:\\tmp', Date.now());
  assert.throws(
    () => {
      db.prepare(
        `INSERT INTO fires (
           fire_id, workspace_id, source, status, scheduled_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run('fr_1', 'ws_1', 'telepathy', 'queued', Date.now());
    },
    /CHECK constraint/i,
  );
  db.close();
});
