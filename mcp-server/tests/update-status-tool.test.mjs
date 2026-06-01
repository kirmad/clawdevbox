import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  registerPending, hasPending, _resetForTests,
} from '../src/pending-dispatch-registry.ts';
import { migrations } from '../src/db/migrations.ts';
import { handleUpdateStatus } from '../src/tools/update-status.ts';

function freshDb() {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  return db;
}

test('task_complete=true resolves a pending dispatch', async () => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T1';
  const { promise } = registerPending(id, 'hello');
  const r = await handleUpdateStatus(
    { db, instanceId: id },
    { status_text: 'done', needs_user_input: false, task_complete: true },
  );
  assert.equal(r.ok, true);
  const settled = await promise;
  assert.equal(settled.task_complete, true);
  assert.equal(hasPending(id), false);
});

test('needs_user_input=true alone resolves the pending dispatch', async () => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T2';
  const { promise } = registerPending(id, 'hello');
  await handleUpdateStatus(
    { db, instanceId: id },
    { status_text: 'need clarification', needs_user_input: true, task_complete: false },
  );
  const settled = await promise;
  assert.equal(settled.needs_user_input, true);
  assert.equal(settled.task_complete, false);
});

test('no pending dispatch — call is a no-op and still returns ok', async () => {
  _resetForTests();
  const db = freshDb();
  const r = await handleUpdateStatus(
    { db, instanceId: 'inst-T3' },
    { status_text: 'progress', needs_user_input: false, task_complete: false },
  );
  assert.equal(r.ok, true);
});

test('progress update (neither flag) does not resolve the dispatch', async () => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T4';
  registerPending(id, 'hello');
  await handleUpdateStatus(
    { db, instanceId: id },
    { status_text: 'thinking', needs_user_input: false, task_complete: false },
  );
  assert.equal(hasPending(id), true, 'dispatch must remain pending after progress-only call');
});

test('missing instanceId — call is a no-op and still returns ok', async () => {
  _resetForTests();
  const db = freshDb();
  const r = await handleUpdateStatus(
    { db, instanceId: null },
    { status_text: 'orphan call', needs_user_input: false, task_complete: true },
  );
  assert.equal(r.ok, true);
});

test('persists status_text + needs_user_input + last_status_at to agent_sessions when row exists', async () => {
  _resetForTests();
  const db = freshDb();
  const id = 'inst-T5';
  // Create a workspace first for the FK constraint
  db.prepare(`INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)`).run('ws-id', '/tmp', Date.now());
  // Insert a minimal agent_sessions row
  db.prepare(`
    INSERT INTO agent_sessions (id, workspace_id, agent_cli, started_at, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, 'ws-id', 'copilot', Date.now(), 'running');
  await handleUpdateStatus(
    { db, instanceId: id },
    { status_text: 'making progress', needs_user_input: false, task_complete: false },
  );
  const row = db.prepare(
    `SELECT status_text, needs_user_input, last_status_at FROM agent_sessions WHERE id = ?`,
  ).get(id);
  assert.equal(row.status_text, 'making progress');
  assert.equal(row.needs_user_input, 0);
  assert.ok(row.last_status_at > 0);
});
