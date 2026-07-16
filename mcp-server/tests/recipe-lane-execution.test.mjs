import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { normalizeExecution, resolveLane, normalizeValidation, materializeSteps, computeReadySteps } from '../src/db/recipe-steps-store.ts';
import { buildStepDecls, recordMainLane } from '../src/tools/recipe.ts';
import { validateRecipeParsed } from '../src/validators.ts';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { upsertLaneSession, getLaneSession, listLaneSessions, resolveLaneBySession } from '../src/db/lane-sessions-store.ts';
import { startLaneDispatchWorker } from '../src/lane-dispatch-worker.ts';

function db0() { const d = new BetterSqlite3(':memory:'); d.pragma('foreign_keys = ON'); runMigrations(d); return d; }
function seedInstance(db) {
  const ws = ensureWorkspace(db, { path: `C:/fake-${Math.random().toString(36).slice(2)}` });
  const id = `ri_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status) VALUES (?,?,?,?,?, '{}', ?, 'running')`)
    .run(id, 'r1', ws.id, ws.path, 'p', Date.now());
  return id;
}

test('normalizeExecution carries session/provider/agent/model + mode/isolation, drops junk', () => {
  assert.deepEqual(
    normalizeExecution({ session: 'deploy', provider: 'copilot', agent: 'dev-buddy:dev-buddy', model: 'claude-opus-4.8', junk: 1 }),
    { session: 'deploy', provider: 'copilot', agent: 'dev-buddy:dev-buddy', model: 'claude-opus-4.8' },
  );
  assert.deepEqual(normalizeExecution({ mode: 'fresh-session', isolation: 'required' }), { mode: 'fresh-session', isolation: 'required' });
  assert.equal(normalizeExecution(null), null);
  assert.equal(normalizeExecution('nonsense'), null);
});

test('resolveLane: explicit session > fresh-session __step lane > main default', () => {
  assert.equal(resolveLane({ session: 'reviews' }, 's1'), 'reviews');
  assert.equal(resolveLane({ mode: 'fresh-session' }, 's1'), '__step:s1');
  assert.equal(resolveLane({ mode: 'inline' }, 's1'), 'main');
  assert.equal(resolveLane(null, 's1'), 'main');
});

test('normalizeValidation carries verifier_provider + verifier_agent + verifier_model', () => {
  const cfg = normalizeValidation([{ name: 'g', mode: 'judge', verifier_provider: 'copilot', verifier_agent: 'dev-buddy:dev-buddy', verifier_model: 'claude-opus-4.8' }]);
  assert.deepEqual(cfg.gates[0], { name: 'g', mode: 'judge', verifier_provider: 'copilot', verifier_agent: 'dev-buddy:dev-buddy', verifier_model: 'claude-opus-4.8' });
});

test('buildStepDecls canonicalizes execution via normalizeExecution', () => {
  const [s] = buildStepDecls([{ id: 's', goal: 'g', execution: { session: 'deploy', model: 'gpt-5.6-sol', junk: 9 } }]);
  assert.deepEqual(s.execution, { session: 'deploy', model: 'gpt-5.6-sol' });
});

test('validateRecipeParsed accepts a session-only execution block (no mode)', () => {
  const res = validateRecipeParsed({ id: 'r', name: 'R', description: 'D', steps: [{ id: 's', goal: 'g', execution: { session: 'deploy', model: 'gpt-5.6-sol' } }] });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('validateRecipeParsed rejects a non-string execution.session', () => {
  const res = validateRecipeParsed({ id: 'r', name: 'R', description: 'D', steps: [{ id: 's', goal: 'g', execution: { session: 5 } }] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path.endsWith('.execution.session')));
});

test('validateRecipeParsed rejects a non-string gate verifier_model', () => {
  const res = validateRecipeParsed({ id: 'r', name: 'R', description: 'D', steps: [{ id: 's', goal: 'g', validation: [{ mode: 'evidence', verifier_model: 5 }] }] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path.includes('verifier_model')));
});

test('migration v17 creates recipe_lane_sessions', () => {
  const db = db0();
  const cols = db.prepare(`PRAGMA table_info(recipe_lane_sessions)`).all().map((c) => c.name);
  for (const c of ['recipe_instance_id', 'lane', 'cli_session_id', 'status', 'spawned_at']) assert.ok(cols.includes(c), `missing ${c}`);
});

test('lane-sessions-store: upsert/get/list/resolve', () => {
  const db = db0();
  const ri = seedInstance(db);
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'main', cli_session_id: 'sess-A', status: 'live' });
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-B', status: 'live' });
  assert.equal(getLaneSession(db, ri, 'deploy').cli_session_id, 'sess-B');
  assert.equal(listLaneSessions(db, ri).length, 2);
  assert.deepEqual(resolveLaneBySession(db, 'sess-B'), { recipe_instance_id: ri, lane: 'deploy' });
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-B', status: 'idle' });
  assert.equal(getLaneSession(db, ri, 'deploy').status, 'idle'); // upsert updates in place
});

test('lane-sessions-store: upsert without status preserves status; null cli preserves session', () => {
  const db = db0();
  const ri = seedInstance(db);
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-B', status: 'idle' });
  // Re-attach the same session WITHOUT passing status → must NOT reset to 'live'.
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-B' });
  assert.equal(getLaneSession(db, ri, 'deploy').status, 'idle');
  // Status-only upsert with null cli → must preserve the existing session id.
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: null, status: 'done' });
  const row = getLaneSession(db, ri, 'deploy');
  assert.equal(row.status, 'done');
  assert.equal(row.cli_session_id, 'sess-B');
  // A brand-new lane with no status defaults to 'live'.
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'reviews', cli_session_id: 'sess-C' });
  assert.equal(getLaneSession(db, ri, 'reviews').status, 'live');
});

test('computeReadySteps filters by lane and honors depends', () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [
    { id: 'a', goal: 'A', execution: { session: 'main' } },
    { id: 'b', goal: 'B', depends: ['a'], execution: { session: 'deploy' } },
    { id: 'c', goal: 'C', execution: { session: 'reviews' } },
  ]);
  assert.deepEqual(computeReadySteps(db, ri).map((s) => s.step_id).sort(), ['a', 'c']);
  assert.deepEqual(computeReadySteps(db, ri, 'main').map((s) => s.step_id), ['a']);
  assert.deepEqual(computeReadySteps(db, ri, 'reviews').map((s) => s.step_id), ['c']);
  assert.equal(computeReadySteps(db, ri, 'deploy').length, 0);
  assert.equal(computeReadySteps(db, ri, 'main')[0].lane, 'main');
});

test('recordMainLane binds the initial session to lane main', () => {
  const db = db0();
  const ri = seedInstance(db);
  recordMainLane(db, ri, 'sess-INIT');
  assert.deepEqual(resolveLaneBySession(db, 'sess-INIT'), { recipe_instance_id: ri, lane: 'main' });
});

function makeLaneOpts(db, calls) {
  return {
    db,
    spawnLaneSession: async (a) => { calls.push(['spawn', a.lane]); return { cliSessionId: `sess-${a.lane}` }; },
    wakeLaneSession: async (a) => { calls.push(['wake', a.lane, a.cliSessionId]); },
  };
}

test('lane worker: spawns a non-main lane once, wakes main when idle+ready', async () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [
    { id: 'a', goal: 'A', execution: { session: 'main' } },
    { id: 'b', goal: 'B', execution: { session: 'deploy' } },
    { id: 'c', goal: 'C', depends: ['a', 'b'], execution: { session: 'main' } },
  ]);
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'main', cli_session_id: 'sess-INIT', status: 'idle' });
  const calls = [];
  const w = startLaneDispatchWorker(makeLaneOpts(db, calls));
  await w.runOnce();
  w.stop();
  assert.ok(calls.some((c) => c[0] === 'spawn' && c[1] === 'deploy'));
  assert.ok(calls.some((c) => c[0] === 'wake' && c[1] === 'main' && c[2] === 'sess-INIT'));
  assert.equal(getLaneSession(db, ri, 'deploy').cli_session_id, 'sess-deploy');
});

test('lane worker: skips a lane with an in-flight step', async () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [{ id: 'a', goal: 'A', execution: { session: 'deploy' } }, { id: 'b', goal: 'B', execution: { session: 'deploy' } }]);
  db.prepare(`UPDATE recipe_steps SET status='running' WHERE step_id='a'`).run();
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-D', status: 'live' });
  const calls = [];
  const w = startLaneDispatchWorker(makeLaneOpts(db, calls));
  await w.runOnce();
  w.stop();
  assert.equal(calls.length, 0);
});

test('lane worker: does not re-dispatch an unchanged ready-set (guard against re-prompting a booting lane)', async () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [{ id: 'a', goal: 'A', execution: { session: 'deploy' } }]);
  const calls = [];
  const w = startLaneDispatchWorker(makeLaneOpts(db, calls));
  await w.runOnce(); // tick 1: spawn deploy
  await w.runOnce(); // tick 2: step still pending, same ready-set → guard skips
  w.stop();
  // Without the guard, tick 2 would take the wake path (a lane session now exists)
  // → calls.length === 2. The guard keeps it at exactly the single tick-1 spawn.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['spawn', 'deploy']);
});

test('lane worker: a failed wake does NOT set the guard (lane retries next tick)', async () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [{ id: 'a', goal: 'A', execution: { session: 'main' } }]);
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'main', cli_session_id: 'sess-INIT', status: 'idle' });
  let wakeCalls = 0;
  const w = startLaneDispatchWorker({
    db,
    spawnLaneSession: async () => ({ cliSessionId: 'x' }),
    wakeLaneSession: async () => { wakeCalls += 1; throw new Error('wake boom'); },
  });
  await w.runOnce(); // tick 1: wake main → throws (caught per-lane) → guard NOT set
  await w.runOnce(); // tick 2: same ready-set, guard unset → wake retried
  w.stop();
  assert.equal(wakeCalls, 2);
});
