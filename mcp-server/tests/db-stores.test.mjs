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

// ---------------------------------------------------------------- recipe-steps + step-events
import {
  addSteps,
  getStep,
  getStepById,
  listSteps,
  materializeSteps,
  MONOTONIC_TRANSITIONS,
  removeSteps,
  StepTransitionError,
  StepValidationError,
  transitionStatus,
  updateMeta,
} from '../src/db/recipe-steps-store.ts';
import { appendEvent, listEvents } from '../src/db/step-events-store.ts';

function mkInstance(db, ws_id, id = 'ri_test_1') {
  db.prepare(
    `INSERT INTO recipe_instances (id, workspace_id, workspace_path, started_at, status)
     VALUES (?, ?, ?, ?, 'running')`,
  ).run(id, ws_id, 'C:\\tmp\\proj', Date.now());
  return id;
}

test('materializeSteps creates rows with step_index, defaults', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\s1' });
  const ri = mkInstance(db, ws.id, 'ri_s1');
  const rows = materializeSteps(db, ri, [
    { id: 'one', goal: 'do one' },
    { id: 'two', goal: 'do two', depends: ['one'] },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].step_index, 0);
  assert.equal(rows[1].step_index, 1);
  assert.equal(rows[0].status, 'pending');
  db.close();
});

test('materializeSteps rejects unresolved depends', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\s2' });
  const ri = mkInstance(db, ws.id, 'ri_s2');
  assert.throws(
    () => materializeSteps(db, ri, [{ id: 'a', goal: 'g', depends: ['ghost'] }]),
    StepValidationError,
  );
  db.close();
});

test('materializeSteps rejects duplicate step ids', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\s3' });
  const ri = mkInstance(db, ws.id, 'ri_s3');
  assert.throws(
    () => materializeSteps(db, ri, [{ id: 'x', goal: 'g' }, { id: 'x', goal: 'g' }]),
    StepValidationError,
  );
  db.close();
});

test('transitionStatus enforces monotonic rule', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t1' });
  const ri = mkInstance(db, ws.id, 'ri_t1');
  const [a] = materializeSteps(db, ri, [{ id: 'one', goal: 'g' }]);
  const running = transitionStatus(db, a.id, { status: 'running' });
  assert.equal(running.status, 'running');
  assert.ok(running.started_at != null);
  assert.throws(
    () => transitionStatus(db, a.id, { status: 'pending' }),
    StepTransitionError,
  );
  const done = transitionStatus(db, a.id, { status: 'done' });
  assert.equal(done.status, 'done');
  assert.ok(done.completed_at != null);
  // Terminal cannot transition further.
  assert.throws(
    () => transitionStatus(db, a.id, { status: 'running' }),
    StepTransitionError,
  );
  db.close();
});

test('transitionStatus state merge vs replace, emits events', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t2' });
  const ri = mkInstance(db, ws.id, 'ri_t2');
  const [a] = materializeSteps(db, ri, [{ id: 'one', goal: 'g' }]);
  transitionStatus(db, a.id, { status: 'running', state: { count: 1 } });
  transitionStatus(db, a.id, { state: { added: true } });
  let row = getStepById(db, a.id);
  let st = JSON.parse(row.state_json);
  assert.equal(st.count, 1);
  assert.equal(st.added, true);
  transitionStatus(db, a.id, { state_replace: { only: 'this' } });
  row = getStepById(db, a.id);
  st = JSON.parse(row.state_json);
  assert.deepEqual(st, { only: 'this' });
  const events = listEvents(db, { recipe_step_id: a.id });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('status_changed'));
  assert.ok(types.includes('state_patched'));
  db.close();
});

test('addSteps + removeSteps with depends guard', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t3' });
  const ri = mkInstance(db, ws.id, 'ri_t3');
  materializeSteps(db, ri, [{ id: 'a', goal: 'g' }]);
  addSteps(db, ri, [{ id: 'b', goal: 'g', depends: ['a'] }]);
  assert.equal(listSteps(db, ri).length, 2);
  // Cannot remove a because b depends on it.
  assert.throws(() => removeSteps(db, ri, ['a']), StepValidationError);
  // Remove b first, then a.
  removeSteps(db, ri, ['b']);
  removeSteps(db, ri, ['a']);
  assert.equal(listSteps(db, ri).length, 0);
  db.close();
});

test('removeSteps rejects running step', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t4' });
  const ri = mkInstance(db, ws.id, 'ri_t4');
  const [a] = materializeSteps(db, ri, [{ id: 'a', goal: 'g' }]);
  transitionStatus(db, a.id, { status: 'running' });
  assert.throws(() => removeSteps(db, ri, ['a']), StepValidationError);
  db.close();
});

test('updateMeta returns trigger diff', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t5' });
  const ri = mkInstance(db, ws.id, 'ri_t5');
  materializeSteps(db, ri, [{
    id: 'a',
    goal: 'g',
    triggers: [{ type: 'ado.x', cron: '* * * * *' }],
  }]);
  const result = updateMeta(db, ri, 'a', {
    triggers: [{ type: 'ado.y', cron: '* * * * *' }],
  });
  assert.equal(result.added_triggers.length, 1);
  assert.equal(result.added_triggers[0].type, 'ado.y');
  assert.equal(result.removed_triggers.length, 1);
  assert.equal(result.removed_triggers[0].type, 'ado.x');
  db.close();
});

test('appendEvent / listEvents round-trip', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t6' });
  const ri = mkInstance(db, ws.id, 'ri_t6');
  const [a] = materializeSteps(db, ri, [{ id: 'a', goal: 'g' }]);
  appendEvent(db, {
    recipe_step_id: a.id,
    recipe_instance_id: ri,
    type: 'message',
    message: 'hi',
    payload: { k: 'v' },
  });
  const events = listEvents(db, { recipe_step_id: a.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'hi');
  assert.equal(JSON.parse(events[0].payload_json).k, 'v');
  db.close();
});

test('listSteps returns rows in step_index order', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t7' });
  const ri = mkInstance(db, ws.id, 'ri_t7');
  materializeSteps(db, ri, [
    { id: 'a', goal: 'g' },
    { id: 'b', goal: 'g' },
    { id: 'c', goal: 'g' },
  ]);
  const rows = listSteps(db, ri);
  assert.deepEqual(rows.map((r) => r.step_id), ['a', 'b', 'c']);
  db.close();
});

test('MONOTONIC_TRANSITIONS exported and well-formed', () => {
  assert.ok(MONOTONIC_TRANSITIONS.pending.includes('running'));
  assert.equal(MONOTONIC_TRANSITIONS.done.length, 0);
});

test('getStep returns null for missing step', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\t8' });
  const ri = mkInstance(db, ws.id, 'ri_t8');
  assert.equal(getStep(db, ri, 'nope'), null);
  db.close();
});

// ---------------------------------------------------------------- agent-sessions
import {
  closeSession,
  findResumeTarget,
  getSession,
  listSessionsForInstance,
  listSessionsForStep,
  markSessionSuspended,
  openSession,
} from '../src/db/agent-sessions-store.ts';

test('openSession creates a running row with started_at', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\as1' });
  const s = openSession(db, { workspace_id: ws.id, agent_cli: 'copilot', interactive: true });
  assert.equal(s.status, 'running');
  assert.equal(s.interactive, 1);
  assert.ok(s.started_at > 0);
  assert.equal(s.ended_at, null);
  db.close();
});

test('closeSession sets ended_at + status', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\as2' });
  const s = openSession(db, { workspace_id: ws.id, agent_cli: 'copilot' });
  closeSession(db, s.id, { status: 'success', result: 'done' });
  const row = getSession(db, s.id);
  assert.equal(row.status, 'success');
  assert.equal(row.result, 'done');
  assert.ok(row.ended_at != null);
  db.close();
});

test('resume_of_agent_session_id chains across resumes', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\as3' });
  const s1 = openSession(db, { workspace_id: ws.id, agent_cli: 'copilot' });
  markSessionSuspended(db, s1.id);
  const s2 = openSession(db, {
    workspace_id: ws.id,
    agent_cli: 'copilot',
    resume_of_agent_session_id: s1.id,
  });
  markSessionSuspended(db, s2.id);
  const s3 = openSession(db, {
    workspace_id: ws.id,
    agent_cli: 'copilot',
    resume_of_agent_session_id: s2.id,
  });
  assert.equal(getSession(db, s2.id).resume_of_agent_session_id, s1.id);
  assert.equal(getSession(db, s3.id).resume_of_agent_session_id, s2.id);
  db.close();
});

test('findResumeTarget returns latest suspended row', async () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\as4' });
  // Create a step to hang the sessions on.
  db.prepare(
    `INSERT INTO recipe_instances (id, workspace_id, workspace_path, started_at, status)
     VALUES ('ri_as4', ?, ?, ?, 'running')`,
  ).run(ws.id, ws.path, Date.now());
  db.prepare(
    `INSERT INTO recipe_steps (id, recipe_instance_id, step_index, step_id, goal, status)
     VALUES ('rs_as4', 'ri_as4', 0, 'one', 'g', 'pending')`,
  ).run();
  const s1 = openSession(db, {
    workspace_id: ws.id,
    recipe_step_id: 'rs_as4',
    agent_cli: 'copilot',
  });
  markSessionSuspended(db, s1.id);
  await new Promise((r) => setTimeout(r, 2));
  const s2 = openSession(db, {
    workspace_id: ws.id,
    recipe_step_id: 'rs_as4',
    agent_cli: 'copilot',
  });
  markSessionSuspended(db, s2.id);
  const target = findResumeTarget(db, 'rs_as4');
  assert.equal(target.id, s2.id);
  db.close();
});

test('listSessionsForStep / listSessionsForInstance', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\as5' });
  db.prepare(
    `INSERT INTO recipe_instances (id, workspace_id, workspace_path, started_at, status)
     VALUES ('ri_as5', ?, ?, ?, 'running')`,
  ).run(ws.id, ws.path, Date.now());
  db.prepare(
    `INSERT INTO recipe_steps (id, recipe_instance_id, step_index, step_id, goal, status)
     VALUES ('rs_as5', 'ri_as5', 0, 'one', 'g', 'pending')`,
  ).run();
  openSession(db, { workspace_id: ws.id, recipe_instance_id: 'ri_as5', recipe_step_id: 'rs_as5', agent_cli: 'copilot' });
  openSession(db, { workspace_id: ws.id, recipe_instance_id: 'ri_as5', recipe_step_id: 'rs_as5', agent_cli: 'claude' });
  assert.equal(listSessionsForStep(db, 'rs_as5').length, 2);
  assert.equal(listSessionsForInstance(db, 'ri_as5').length, 2);
  db.close();
});

// ---------------------------------------------------------------- artifacts
import {
  getArtifact,
  linkArtifactToStep,
  listArtifactsForStep,
  listArtifactsForWorkspace,
  mintArtifactId,
  registerArtifact,
} from '../src/db/artifacts-db-store.ts';

test('registerArtifact returns row with mint id and metadata', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\art1' });
  const art = registerArtifact(db, {
    workspace_id: ws.id,
    type: 'pr_walkthrough',
    title: 'PR #42',
    dir_path: 'C:\\tmp\\art1\\.clawdevbox\\artifacts\\x',
    metadata: { branch: 'main' },
  });
  assert.match(art.id, /^art_[a-z0-9]+_[0-9a-f]{4}$/);
  assert.equal(art.type, 'pr_walkthrough');
  assert.equal(JSON.parse(art.metadata_json).branch, 'main');
  db.close();
});

test('linkArtifactToStep updates recipe_step_id', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\art2' });
  db.prepare(
    `INSERT INTO recipe_instances (id, workspace_id, workspace_path, started_at, status)
     VALUES ('ri_art', ?, ?, ?, 'running')`,
  ).run(ws.id, ws.path, Date.now());
  db.prepare(
    `INSERT INTO recipe_steps (id, recipe_instance_id, step_index, step_id, goal, status)
     VALUES ('rs_art', 'ri_art', 0, 'one', 'g', 'pending')`,
  ).run();
  const art = registerArtifact(db, {
    workspace_id: ws.id,
    type: 'doc',
    dir_path: 'C:\\tmp\\art2\\.clawdevbox\\artifacts\\y',
  });
  linkArtifactToStep(db, art.id, 'rs_art');
  const row = getArtifact(db, art.id);
  assert.equal(row.recipe_step_id, 'rs_art');
  assert.equal(listArtifactsForStep(db, 'rs_art').length, 1);
  db.close();
});

test('listArtifactsForWorkspace returns rows', () => {
  const db = open();
  const ws = ensureWorkspace(db, { path: 'C:\\tmp\\art3' });
  registerArtifact(db, { workspace_id: ws.id, type: 'a', dir_path: 'd1' });
  registerArtifact(db, { workspace_id: ws.id, type: 'b', dir_path: 'd2' });
  assert.equal(listArtifactsForWorkspace(db, ws.id).length, 2);
  db.close();
});

test('mintArtifactId shape', () => {
  assert.match(mintArtifactId(), /^art_[a-z0-9]+_[0-9a-f]{4}$/);
});

// ---------------------------------------------------------------- legacy files
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanLegacyFiles } from '../src/db/legacy-files.ts';

function mkTmp(prefix) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('scanLegacyFiles logs and records kv entry for inbox.json', () => {
  const db = open();
  const globalDir = mkTmp('legacy-global');
  const projectDir = mkTmp('legacy-project');
  const workspacesRoot = mkTmp('legacy-ws');
  try {
    writeFileSync(join(globalDir, 'inbox.json'), '{}');
    const cfg = {
      projectDir,
      globalDir,
      workspacesRoot,
      configSource: 'defaults',
      configPath: null,
      tunnel: {},
      http: { host: '127.0.0.1', port: 0 },
      notifications: { enabled: false },
    };
    scanLegacyFiles(cfg, db);
    const inboxPath = join(globalDir, 'inbox.json');
    const row = db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(`legacy_file_seen:${inboxPath}`);
    assert.ok(row, 'expected kv row for inbox.json');
    // Second scan must not duplicate or error.
    scanLegacyFiles(cfg, db);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM kv WHERE key LIKE 'legacy_file_seen:%'")
      .get();
    assert.equal(rows.c, 1);
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(workspacesRoot, { recursive: true, force: true });
    db.close();
  }
});

test('scanLegacyFiles detects workspace triggers.json and recipe-instances', () => {
  const db = open();
  const globalDir = mkTmp('legacy-g2');
  const projectDir = mkTmp('legacy-p2');
  const workspacesRoot = mkTmp('legacy-w2');
  try {
    // project legacy file
    mkdirSync(join(projectDir, '.clawdevbox', 'recipe-instances'), { recursive: true });
    writeFileSync(join(projectDir, '.clawdevbox', 'triggers.json'), '[]');
    writeFileSync(join(projectDir, '.clawdevbox', 'recipe-instances', 'foo.json'), '{}');
    // a workspace under the root
    const wsDir = join(workspacesRoot, 'ws-a');
    mkdirSync(join(wsDir, '.clawdevbox'), { recursive: true });
    writeFileSync(join(wsDir, '.clawdevbox', 'triggers.json'), '[]');
    const cfg = {
      projectDir,
      globalDir,
      workspacesRoot,
      configSource: 'defaults',
      configPath: null,
      tunnel: {},
      http: { host: '127.0.0.1', port: 0 },
      notifications: { enabled: false },
    };
    scanLegacyFiles(cfg, db);
    const rows = db
      .prepare("SELECT key FROM kv WHERE key LIKE 'legacy_file_seen:%'")
      .all();
    assert.equal(rows.length, 3);
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(workspacesRoot, { recursive: true, force: true });
    db.close();
  }
});
