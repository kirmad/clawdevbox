import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../src/db/migrations.ts';

test('V5 migration adds status_text, needs_user_input, last_status_at to agent_sessions', () => {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  const cols = db.prepare(`PRAGMA table_info(agent_sessions)`).all().map((r) => r.name);
  assert.ok(cols.includes('status_text'), `status_text column missing; got: ${cols.join(',')}`);
  assert.ok(cols.includes('needs_user_input'), `needs_user_input column missing; got: ${cols.join(',')}`);
  assert.ok(cols.includes('last_status_at'), `last_status_at column missing; got: ${cols.join(',')}`);
});

test('needs_user_input defaults to 0; status_text + last_status_at default to NULL', () => {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  // Create a workspace first for the FK constraint
  db.prepare(`INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)`).run('ws-id', '/tmp', Date.now());
  // Insert a minimal row with required columns.
  db.prepare(`
    INSERT INTO agent_sessions (id, workspace_id, agent_cli, started_at, status)
    VALUES (?, ?, ?, ?, ?)
  `).run('test-id', 'ws-id', 'copilot', Date.now(), 'running');
  const row = db.prepare(`SELECT status_text, needs_user_input, last_status_at FROM agent_sessions WHERE id = 'test-id'`).get();
  assert.equal(row.status_text, null);
  assert.equal(row.needs_user_input, 0);
  assert.equal(row.last_status_at, null);
});

test('updateStatus helper persists payload', async () => {
  const { updateStatus } = await import('../src/db/agent-sessions-store.ts');
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  // Create a workspace first for the FK constraint
  db.prepare(`INSERT INTO workspaces (id, path, created_at) VALUES (?, ?, ?)`).run('ws-id', '/tmp', Date.now());
  // Insert a minimal agent_sessions row with id = 'iX'.
  db.prepare(`
    INSERT INTO agent_sessions (id, workspace_id, agent_cli, started_at, status)
    VALUES (?, ?, ?, ?, ?)
  `).run('iX', 'ws-id', 'copilot', Date.now(), 'running');

  updateStatus(db, 'iX', { text: 'thinking', needs_user_input: false, ts: 1700000000000 });
  let row = db.prepare(`SELECT status_text, needs_user_input, last_status_at FROM agent_sessions WHERE id = 'iX'`).get();
  assert.equal(row.status_text, 'thinking');
  assert.equal(row.needs_user_input, 0);
  assert.equal(row.last_status_at, 1700000000000);

  updateStatus(db, 'iX', { text: null, needs_user_input: true, ts: 1700000000001 });
  row = db.prepare(`SELECT status_text, needs_user_input, last_status_at FROM agent_sessions WHERE id = 'iX'`).get();
  assert.equal(row.status_text, null);
  assert.equal(row.needs_user_input, 1);
  assert.equal(row.last_status_at, 1700000000001);
});
