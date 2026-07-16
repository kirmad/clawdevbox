import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, setDatabaseForTesting } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { materializeSteps, getStep, transitionStatus } from '../src/db/recipe-steps-store.ts';
import { upsertLaneSession } from '../src/db/lane-sessions-store.ts';
import { resolveTerminal, listAllRecipeInstancesFromDb } from '../src/recipe-instances-store.ts';

function openDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// Seed a workspace + instance + steps; return { ws, instanceId }.
function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_tl_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

// Insert an agent_sessions row mapping cli_session_id -> recipe_instance_id.
function seedAgentSession(db, wsId, cliSessionId, recipeInstanceId, startedAt) {
  db.prepare(
    `INSERT INTO agent_sessions (id, cli_session_id, recipe_instance_id, workspace_id, agent_cli, started_at, status, interactive)
     VALUES (?, ?, ?, ?, 'copilot', ?, 'running', 1)`,
  ).run(`as_${Math.random().toString(36).slice(2, 8)}`, cliSessionId, recipeInstanceId, wsId, startedAt);
}

// Insert a step_event directly with an explicit, strictly-increasing created_at
// so the round's started→verdict ordering is deterministic (buildStepValidation
// reads events ORDER BY created_at ASC, id ASC — appendEvent's Date.now()/random
// id made same-millisecond events sort randomly).
let evSeq = 0;
function insertEvent(db, { recipe_instance_id, recipe_step_id, type, payload }, createdAt) {
  db.prepare(
    `INSERT INTO step_events (id, recipe_step_id, recipe_instance_id, agent_session_id, type, message, payload_json, created_at)
     VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)`,
  ).run(`ev_test_${String(evSeq++).padStart(4, '0')}`, recipe_step_id, recipe_instance_id, type, JSON.stringify(payload), createdAt);
}

test('resolveTerminal: maps a cli_session_id to its recipe_instance_id', () => {
  const db = openDb();
  try {
    const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
    // Two instances so resolveTerminal must pick the right one.
    db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                VALUES ('ri_verifier', 'r', ?, ?, 'p', '{}', ?, 'running')`).run(ws.id, ws.path, Date.now());
    seedAgentSession(db, ws.id, 'cli-guid-A', 'ri_verifier', 1000);

    assert.deepEqual(resolveTerminal(db, 'cli-guid-A'), { instance_id: 'ri_verifier', cli_session_id: 'cli-guid-A' });
    assert.equal(resolveTerminal(db, 'no-such-guid'), null);
    assert.equal(resolveTerminal(db, null), null);
    assert.equal(resolveTerminal(db, undefined), null);
  } finally {
    db.close();
  }
});

test('resolveTerminal: newest agent_sessions row wins on duplicate cli_session_id', () => {
  const db = openDb();
  try {
    const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
    for (const id of ['ri_old', 'ri_new']) {
      db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                  VALUES (?, 'r', ?, ?, 'p', '{}', ?, 'running')`).run(id, ws.id, ws.path, Date.now());
    }
    seedAgentSession(db, ws.id, 'cli-guid-B', 'ri_old', 1000);
    seedAgentSession(db, ws.id, 'cli-guid-B', 'ri_new', 2000);
    assert.equal(resolveTerminal(db, 'cli-guid-B').instance_id, 'ri_new');
  } finally {
    db.close();
  }
});

test('serialize: a validation round carries the verifier terminal (resolved from verifier_session_id)', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { ws, instanceId } = seed(db, [{ id: 'g', goal: 'ship it', validation: { mode: 'evidence' } }]);
    // The verifier ran as its own recipe instance; map its cli session -> that instance.
    const ws2 = ensureWorkspace(db, { path: `C:/verif-${Math.random().toString(36).slice(2)}` });
    db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                VALUES ('ri_verif_1', 'r', ?, ?, 'p', '{}', ?, 'running')`).run(ws2.id, ws2.path, Date.now());
    seedAgentSession(db, ws2.id, 'verifier-guid-1', 'ri_verif_1', 5000);

    // Drive the step into a validating state and emit a validation round.
    const row = getStep(db, instanceId, 'g');
    transitionStatus(db, row.id, { status: 'running' });
    transitionStatus(db, row.id, { status: 'validating' });
    insertEvent(db, {
      recipe_instance_id: instanceId,
      recipe_step_id: row.id,
      type: 'validation_started',
      payload: { attempt: 0, verifier_session_id: 'verifier-guid-1' },
    }, 1000);
    insertEvent(db, {
      recipe_instance_id: instanceId,
      recipe_step_id: row.id,
      type: 'validation_verdict',
      payload: { verdict: 'PASS', evidence: 'looks good' },
    }, 2000);

    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 'g');
    const round = step.validation.rounds[0];
    assert.equal(round.verifier_session_id, 'verifier-guid-1');
    assert.deepEqual(round.terminal, { instance_id: 'ri_verif_1', cli_session_id: 'verifier-guid-1' });
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('serialize: a main-lane step gets terminal = the recipe instance itself', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { instanceId } = seed(db, [{ id: 's1', goal: 'do the thing' }]);
    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 's1');
    // No explicit execution => main lane => the instance's own terminal.
    assert.deepEqual(step.terminal, { instance_id: instanceId });
    assert.ok(step.lane === undefined || step.lane === 'main');
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('serialize: a fresh-session step resolves its lane terminal via recipe_lane_sessions', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    // Step declares execution.session: 'impl' -> lane 'impl'.
    const { ws, instanceId } = seed(db, [
      { id: 's2', goal: 'implement', execution: { session: 'impl', mode: 'fresh-session' } },
    ]);
    // The lane 'impl' spawned a CLI session 'impl-guid' which ran as instance 'ri_impl'.
    const ws3 = ensureWorkspace(db, { path: `C:/impl-${Math.random().toString(36).slice(2)}` });
    db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                VALUES ('ri_impl', 'r', ?, ?, 'p', '{}', ?, 'running')`).run(ws3.id, ws3.path, Date.now());
    seedAgentSession(db, ws3.id, 'impl-guid', 'ri_impl', 7000);
    upsertLaneSession(db, { recipe_instance_id: instanceId, lane: 'impl', cli_session_id: 'impl-guid' });

    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 's2');
    assert.equal(step.lane, 'impl');
    assert.deepEqual(step.terminal, { instance_id: 'ri_impl', cli_session_id: 'impl-guid' });
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('serialize: a fresh-session step with no lane session yet has no terminal', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { instanceId } = seed(db, [
      { id: 's3', goal: 'pending impl', execution: { session: 'impl', mode: 'fresh-session' } },
    ]);
    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 's3');
    assert.equal(step.lane, 'impl');
    assert.equal(step.terminal, undefined);
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});
