/**
 * idle-reaper.test.mjs — unit + integration coverage for the idle-session
 * reaper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startIdleReaper, shouldReap, MAIN_AGENT_INSTANCE_ID } from '../src/idle-reaper.ts';
import { migrations } from '../src/db/migrations.ts';
import Database from 'better-sqlite3';

const FIFTEEN_MIN = 15 * 60 * 1000;

// ----------------------------------------------------------------------------
// Pure policy: shouldReap
// ----------------------------------------------------------------------------

test('shouldReap: idle for 16min, 0 viewers → true', () => {
  const now = 2_000_000;
  assert.equal(
    shouldReap({
      instanceId: 'ri_x', derivedState: 'idle',
      derivedStateAt: now - (16 * 60 * 1000),
      attachedViewers: 0, now, idleTimeoutMs: FIFTEEN_MIN,
    }),
    true,
  );
});

test('shouldReap: idle for 14min → false (not old enough)', () => {
  const now = 2_000_000;
  assert.equal(
    shouldReap({
      instanceId: 'ri_x', derivedState: 'idle',
      derivedStateAt: now - (14 * 60 * 1000),
      attachedViewers: 0, now, idleTimeoutMs: FIFTEEN_MIN,
    }),
    false,
  );
});

test('shouldReap: idle for 16min but 1 viewer → false', () => {
  const now = 2_000_000;
  assert.equal(
    shouldReap({
      instanceId: 'ri_x', derivedState: 'idle',
      derivedStateAt: now - (16 * 60 * 1000),
      attachedViewers: 1, now, idleTimeoutMs: FIFTEEN_MIN,
    }),
    false,
  );
});

test('shouldReap: derived_state=thinking → false (agent still working)', () => {
  const now = 2_000_000;
  assert.equal(
    shouldReap({
      instanceId: 'ri_x', derivedState: 'thinking',
      derivedStateAt: now - (30 * 60 * 1000),
      attachedViewers: 0, now, idleTimeoutMs: FIFTEEN_MIN,
    }),
    false,
  );
});

test('shouldReap: derived_state=null → false (no signal yet, still warming up)', () => {
  const now = 2_000_000;
  assert.equal(
    shouldReap({
      instanceId: 'ri_x', derivedState: null,
      derivedStateAt: null,
      attachedViewers: 0, now, idleTimeoutMs: FIFTEEN_MIN,
    }),
    false,
  );
});

test('shouldReap: instance_id="main" → false even if all else matches', () => {
  const now = 2_000_000;
  assert.equal(
    shouldReap({
      instanceId: MAIN_AGENT_INSTANCE_ID, derivedState: 'idle',
      derivedStateAt: now - (60 * 60 * 1000),
      attachedViewers: 0, now, idleTimeoutMs: FIFTEEN_MIN,
    }),
    false,
  );
});

// ----------------------------------------------------------------------------
// Integration: runOnce against an in-memory DB
// ----------------------------------------------------------------------------

function setupDb() {
  const db = new Database(':memory:');
  // Run all migrations in order. Migration v1 creates the schema_version
  // table itself, so we can't pre-create it OR read MAX(version) before
  // v1 has applied.
  for (const m of migrations) {
    m.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
  }
  // Need at least one workspaces row for FK satisfaction.
  db.prepare("INSERT INTO workspaces (id, path, name, created_at) VALUES (?, ?, ?, ?)")
    .run('ws_test', 'C:\\tmp', 'test', Date.now());
  return db;
}

function insertSession(db, opts) {
  const id = `as_${Math.random().toString(36).slice(2, 10)}`;
  // Recipe_instances row is needed for the FK on agent_sessions.recipe_instance_id.
  db.prepare(
    `INSERT OR IGNORE INTO recipe_instances
      (id, recipe_id, workspace_id, workspace_path, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.recipe_instance_id, null, 'ws_test', 'C:\\tmp', opts.started_at ?? Date.now(), 'running');
  db.prepare(
    `INSERT INTO agent_sessions
      (id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
       started_at, status, interactive, derived_state, derived_state_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, opts.cli_session_id ?? null, opts.recipe_instance_id, 'ws_test',
    opts.agent_cli ?? 'copilot',
    opts.started_at ?? Date.now(),
    'running', 1,
    opts.derived_state ?? null,
    opts.derived_state_at ?? null,
    opts.ended_at ?? null,
  );
  return id;
}

test('runOnce: reaps an old-idle session with 0 viewers, leaves DB row with end_reason', async () => {
  const db = setupDb();
  const now = Date.now();
  insertSession(db, {
    recipe_instance_id: 'ri_a',
    derived_state: 'idle',
    derived_state_at: now - (20 * 60 * 1000),  // 20 min ago
  });

  const killCalls = [];
  const reaper = startIdleReaper({
    db,
    tmuxClient: { socket: null, configPath: null },
    intervalMs: 999_999_999,  // we drive ticks manually
    idleTimeoutMs: FIFTEEN_MIN,
    killSession: async (id) => { killCalls.push(id); },
    countAttachedViewers: async () => 0,
  });
  try {
    const reaped = await reaper.runOnce();
    assert.equal(reaped, 1);
    assert.deepEqual(killCalls, ['ri_a']);
    const row = db.prepare("SELECT end_reason, ended_at FROM agent_sessions WHERE recipe_instance_id = 'ri_a'").get();
    assert.equal(row.end_reason, 'idle_reaped');
    assert.ok(row.ended_at > 0, 'ended_at should be set');
  } finally { reaper.stop(); db.close(); }
});

test('runOnce: skips session with 1 attached viewer', async () => {
  const db = setupDb();
  const now = Date.now();
  insertSession(db, {
    recipe_instance_id: 'ri_b',
    derived_state: 'idle',
    derived_state_at: now - (20 * 60 * 1000),
  });

  const killCalls = [];
  const reaper = startIdleReaper({
    db, tmuxClient: { socket: null, configPath: null },
    intervalMs: 999_999_999, idleTimeoutMs: FIFTEEN_MIN,
    killSession: async (id) => { killCalls.push(id); },
    countAttachedViewers: async () => 1,
  });
  try {
    const reaped = await reaper.runOnce();
    assert.equal(reaped, 0);
    assert.deepEqual(killCalls, []);
    const row = db.prepare("SELECT end_reason FROM agent_sessions WHERE recipe_instance_id = 'ri_b'").get();
    assert.equal(row.end_reason, null);
  } finally { reaper.stop(); db.close(); }
});

test('runOnce: skips the Main Agent', async () => {
  const db = setupDb();
  const now = Date.now();
  insertSession(db, {
    recipe_instance_id: 'main',
    derived_state: 'idle',
    derived_state_at: now - (60 * 60 * 1000),
  });

  const killCalls = [];
  const reaper = startIdleReaper({
    db, tmuxClient: { socket: null, configPath: null },
    intervalMs: 999_999_999, idleTimeoutMs: FIFTEEN_MIN,
    killSession: async (id) => { killCalls.push(id); },
    countAttachedViewers: async () => 0,
  });
  try {
    const reaped = await reaper.runOnce();
    assert.equal(reaped, 0);
    assert.deepEqual(killCalls, []);
  } finally { reaper.stop(); db.close(); }
});

test('runOnce: skips session that is too young', async () => {
  const db = setupDb();
  const now = Date.now();
  insertSession(db, {
    recipe_instance_id: 'ri_y',
    derived_state: 'idle',
    derived_state_at: now - (5 * 60 * 1000),   // only 5 min idle
  });

  const reaper = startIdleReaper({
    db, tmuxClient: { socket: null, configPath: null },
    intervalMs: 999_999_999, idleTimeoutMs: FIFTEEN_MIN,
    killSession: async () => { throw new Error('should not be called'); },
    countAttachedViewers: async () => 0,
  });
  try {
    const reaped = await reaper.runOnce();
    assert.equal(reaped, 0);
  } finally { reaper.stop(); db.close(); }
});

test('runOnce: skips session whose state is thinking even if old', async () => {
  const db = setupDb();
  const now = Date.now();
  insertSession(db, {
    recipe_instance_id: 'ri_z',
    derived_state: 'thinking',
    derived_state_at: now - (60 * 60 * 1000),
  });

  const reaper = startIdleReaper({
    db, tmuxClient: { socket: null, configPath: null },
    intervalMs: 999_999_999, idleTimeoutMs: FIFTEEN_MIN,
    killSession: async () => { throw new Error('should not be called'); },
    countAttachedViewers: async () => 0,
  });
  try {
    const reaped = await reaper.runOnce();
    assert.equal(reaped, 0);
  } finally { reaper.stop(); db.close(); }
});

test('runOnce: race — viewer attaches between DB scan and decision → skipped', async () => {
  const db = setupDb();
  const now = Date.now();
  insertSession(db, {
    recipe_instance_id: 'ri_race',
    derived_state: 'idle',
    derived_state_at: now - (20 * 60 * 1000),
  });

  const killCalls = [];
  // countAttachedViewers returns 1 (simulating a viewer attaching right
  // after the DB scan picked the row as a candidate).
  const reaper = startIdleReaper({
    db, tmuxClient: { socket: null, configPath: null },
    intervalMs: 999_999_999, idleTimeoutMs: FIFTEEN_MIN,
    killSession: async (id) => { killCalls.push(id); },
    countAttachedViewers: async () => 1,
  });
  try {
    const reaped = await reaper.runOnce();
    assert.equal(reaped, 0);
    assert.deepEqual(killCalls, []);
  } finally { reaper.stop(); db.close(); }
});
