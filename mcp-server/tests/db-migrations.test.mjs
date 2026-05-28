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

function openWithV1Only() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  const v1 = migrations.find((m) => m.version === 1);
  assert.ok(v1, 'V1 migration must exist');
  db.transaction(() => {
    v1.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
  })();
  return db;
}

function applyV2(db) {
  const v2 = migrations.find((m) => m.version === 2);
  assert.ok(v2, 'V2 migration must exist');
  db.transaction(() => {
    v2.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
  })();
}

test('migration V2 drops binds_callback_to and binds_callback_to_recipe columns', () => {
  const db = openWithV1Only();

  // Sanity: V1 schema has the columns.
  const v1Cols = db
    .prepare(`PRAGMA table_info(triggers)`)
    .all()
    .map((c) => c.name);
  assert.ok(v1Cols.includes('binds_callback_to'), 'V1 should have binds_callback_to');
  assert.ok(v1Cols.includes('binds_callback_to_recipe'), 'V1 should have binds_callback_to_recipe');

  // Insert a workspace + a trigger row with the soon-to-be-removed
  // columns populated, so we can prove unrelated data survives.
  db.prepare(
    `INSERT INTO workspaces (id, path, created_at) VALUES ('ws_keep', 'C:/keep', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO triggers (
       id, workspace_id, type, params_json, cron_mode,
       binds_callback_to, binds_callback_to_recipe,
       registered_at
     ) VALUES ('t_keep', 'ws_keep', 'demo.t', '{}', 'inherit',
              'agent_session_resume', 'pr-review', 99)`,
  ).run();

  applyV2(db);

  const v2Cols = db
    .prepare(`PRAGMA table_info(triggers)`)
    .all()
    .map((c) => c.name);
  assert.ok(!v2Cols.includes('binds_callback_to'), 'V2 should drop binds_callback_to');
  assert.ok(!v2Cols.includes('binds_callback_to_recipe'), 'V2 should drop binds_callback_to_recipe');

  // Other column values survive.
  const row = db.prepare(`SELECT id, workspace_id, type, registered_at FROM triggers WHERE id = ?`).get('t_keep');
  assert.equal(row.id, 't_keep');
  assert.equal(row.workspace_id, 'ws_keep');
  assert.equal(row.type, 'demo.t');
  assert.equal(row.registered_at, 99);

  db.close();
});

test('migration V2 is idempotent when applied via runMigrations', async () => {
  // Loading runMigrations after the inline test above so the import is
  // not hoisted before the V2 inline assertion runs.
  const { runMigrations: runMigs } = await import('../src/db/index.ts');
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigs(db);
  // Running again is a no-op (runMigrations is version-gated).
  runMigs(db);
  const max = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get();
  assert.ok(max.v >= 2, `expected schema_version >= 2, got ${max.v}`);
  const cols = db.prepare(`PRAGMA table_info(triggers)`).all().map((c) => c.name);
  assert.ok(!cols.includes('binds_callback_to'));
  assert.ok(!cols.includes('binds_callback_to_recipe'));
  db.close();
});
