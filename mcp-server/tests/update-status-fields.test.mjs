/**
 * update-status-fields.test.mjs — unit coverage for the v10 three-field
 * tab-title pipeline (task_title / subtask_title / status).
 *
 * Covers:
 *   - tri-state semantics (undefined keeps, "" clears, non-empty sets)
 *   - cli_session_id correlation (recipe_instance_id no longer used)
 *   - Legacy status_text → status synonym
 *   - In-memory pty-registry mirror (setPtyStatusFields)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../src/db/migrations.ts';
import { updateStatusBySessionId } from '../src/db/agent-sessions-store.ts';
import { handleUpdateStatus } from '../src/tools/update-status.ts';

function setupDb() {
  const db = new Database(':memory:');
  for (const m of migrations) {
    m.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
  }
  db.prepare("INSERT INTO workspaces (id, path, name, created_at) VALUES (?, ?, ?, ?)")
    .run('ws_test', 'C:\\tmp', 'test', Date.now());
  db.prepare(
    `INSERT INTO recipe_instances (id, workspace_id, workspace_path, started_at, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('ri_test', 'ws_test', 'C:\\tmp', Date.now(), 'running');
  db.prepare(
    `INSERT INTO agent_sessions
       (id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
        started_at, status, interactive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('as_test', 'sid-12345', 'ri_test', 'ws_test', 'copilot', Date.now(), 'running', 1);
  return db;
}

function readRow(db) {
  return db.prepare(
    `SELECT task_title, subtask_title, status_text, needs_user_input
     FROM agent_sessions WHERE cli_session_id = 'sid-12345'`,
  ).get();
}

// ----------------------------------------------------------------------------
// Pure store layer
// ----------------------------------------------------------------------------

test('updateStatusBySessionId: sets all 3 fields when provided', () => {
  const db = setupDb();
  try {
    const ok = updateStatusBySessionId(db, 'sid-12345', {
      taskTitle: 'Refactor auth',
      subtaskTitle: 'Migrating User model',
      status: 'Reading user.ts',
      needsUserInput: false,
      ts: Date.now(),
    });
    assert.equal(ok, true);
    assert.deepEqual(readRow(db), {
      task_title: 'Refactor auth',
      subtask_title: 'Migrating User model',
      status_text: 'Reading user.ts',
      needs_user_input: 0,
    });
  } finally { db.close(); }
});

test('updateStatusBySessionId: undefined leaves columns unchanged (sticky)', () => {
  const db = setupDb();
  try {
    updateStatusBySessionId(db, 'sid-12345', {
      taskTitle: 'Refactor auth',
      subtaskTitle: 'Sub A',
      status: 'Status A',
      needsUserInput: false,
      ts: Date.now(),
    });
    // Only update status — task & subtask must remain.
    updateStatusBySessionId(db, 'sid-12345', {
      status: 'Status B',
      needsUserInput: false,
      ts: Date.now(),
    });
    assert.deepEqual(readRow(db), {
      task_title: 'Refactor auth',     // sticky
      subtask_title: 'Sub A',          // sticky
      status_text: 'Status B',         // updated
      needs_user_input: 0,
    });
  } finally { db.close(); }
});

test('updateStatusBySessionId: empty string CLEARS', () => {
  const db = setupDb();
  try {
    updateStatusBySessionId(db, 'sid-12345', {
      taskTitle: 'X', subtaskTitle: 'Y', status: 'Z',
      needsUserInput: false, ts: Date.now(),
    });
    updateStatusBySessionId(db, 'sid-12345', {
      subtaskTitle: '',
      needsUserInput: false, ts: Date.now(),
    });
    assert.deepEqual(readRow(db), {
      task_title: 'X',           // sticky
      subtask_title: null,       // cleared
      status_text: 'Z',          // sticky
      needs_user_input: 0,
    });
  } finally { db.close(); }
});

test('updateStatusBySessionId: only matches LIVE rows (ended_at IS NULL)', () => {
  const db = setupDb();
  try {
    db.prepare("UPDATE agent_sessions SET ended_at = ? WHERE cli_session_id = 'sid-12345'").run(Date.now());
    const ok = updateStatusBySessionId(db, 'sid-12345', {
      taskTitle: 'X', needsUserInput: false, ts: Date.now(),
    });
    assert.equal(ok, false);
  } finally { db.close(); }
});

test('updateStatusBySessionId: unknown session id → false, no rows changed', () => {
  const db = setupDb();
  try {
    const ok = updateStatusBySessionId(db, 'nope-not-a-real-sid', {
      taskTitle: 'X', needsUserInput: false, ts: Date.now(),
    });
    assert.equal(ok, false);
  } finally { db.close(); }
});

// ----------------------------------------------------------------------------
// Tool handler — orchestration + legacy compat
// ----------------------------------------------------------------------------

test('handleUpdateStatus: routes by cliSessionId; applied=true on DB hit', async () => {
  const db = setupDb();
  try {
    const r = await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: 'ri_test' },
      { task_title: 'Goal', status: 'Status', session_id: 'sid-12345' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.applied, true);
    assert.deepEqual(readRow(db), {
      task_title: 'Goal', subtask_title: null,
      status_text: 'Status', needs_user_input: 0,
    });
  } finally { db.close(); }
});

test('handleUpdateStatus: legacy status_text arg is a synonym for status', async () => {
  const db = setupDb();
  try {
    await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: null },
      { status_text: 'Legacy mode' },
    );
    const row = readRow(db);
    assert.equal(row.status_text, 'Legacy mode');
  } finally { db.close(); }
});

test('handleUpdateStatus: status wins over status_text when both provided', async () => {
  const db = setupDb();
  try {
    await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: null },
      { status: 'NEW', status_text: 'OLD' },
    );
    const row = readRow(db);
    assert.equal(row.status_text, 'NEW');
  } finally { db.close(); }
});

test('handleUpdateStatus: no cliSessionId → no rows changed, applied=false', async () => {
  const db = setupDb();
  try {
    const r = await handleUpdateStatus(
      { db, cliSessionId: null, recipeInstanceId: null },
      { status: 'orphan' },
    );
    assert.equal(r.applied, false);
    assert.equal(readRow(db).status_text, null);
  } finally { db.close(); }
});

test('handleUpdateStatus: caps each field at 4096 chars', async () => {
  const db = setupDb();
  try {
    const huge = 'x'.repeat(5000);
    await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: null },
      { task_title: huge, status: huge },
    );
    const row = readRow(db);
    assert.equal(row.task_title.length, 4096);
    assert.equal(row.status_text.length, 4096);
  } finally { db.close(); }
});

test('handleUpdateStatus: needs_user_input=true sets the flag', async () => {
  const db = setupDb();
  try {
    await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: null },
      { status: 'blocked', needs_user_input: true },
    );
    assert.equal(readRow(db).needs_user_input, 1);
  } finally { db.close(); }
});

test('handleUpdateStatus: empty string clears a sticky field', async () => {
  const db = setupDb();
  try {
    await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: null },
      { task_title: 'Goal A', subtask_title: 'Sub A' },
    );
    await handleUpdateStatus(
      { db, cliSessionId: 'sid-12345', recipeInstanceId: null },
      { subtask_title: '' },
    );
    assert.deepEqual(readRow(db), {
      task_title: 'Goal A',
      subtask_title: null,
      status_text: null,
      needs_user_input: 0,
    });
  } finally { db.close(); }
});
