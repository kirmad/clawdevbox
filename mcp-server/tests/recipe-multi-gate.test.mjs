import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  normalizeValidation, materializeSteps, getStep, getStepById, transitionStatus,
} from '../src/db/recipe-steps-store.ts';
import { runMigrations, setDatabaseForTesting } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { validateRecipeSource } from '../src/validators.ts';
import { buildStepDecls } from '../src/tools/recipe.ts';
import { startValidationWorker } from '../src/recipe-validation-worker.ts';
import { updateStatusImpl } from '../src/recipe-step-tools.ts';
import { listAllRecipeInstancesFromDb } from '../src/recipe-instances-store.ts';
import { projectValidation } from '../src/cli/library-api.ts';

test('normalizeValidation: single object → one gate named by mode', () => {
  const c = normalizeValidation({ mode: 'evidence', criteria: 'x', max_rework: 2 });
  assert.deepEqual(c, { gates: [{ name: 'evidence', mode: 'evidence', criteria: 'x' }], max_rework: 2 });
});

test('normalizeValidation: array of gates, names defaulted + de-duped', () => {
  const c = normalizeValidation([{ mode: 'evidence' }, { mode: 'evidence' }, { name: 'wt', mode: 'artifacts' }]);
  assert.deepEqual(c.gates.map((g) => g.name), ['evidence', 'evidence-1', 'wt']);
  assert.deepEqual(c.gates.map((g) => g.mode), ['evidence', 'evidence', 'artifacts']);
});

test('normalizeValidation: canonical {gates} round-trips (back-compat read)', () => {
  const canon = { gates: [{ name: 'a', mode: 'evidence' }], max_rework: 5 };
  assert.deepEqual(normalizeValidation(canon), canon);
});

test('normalizeValidation: null/empty → null', () => {
  assert.equal(normalizeValidation(null), null);
  assert.equal(normalizeValidation([]), null);
});

test('validateRecipeSource: array validation with a bad mode is rejected', () => {
  const src = `id: r\nname: r\ndescription: d\nsteps:\n  - id: s\n    goal: g\n    validation:\n      - { mode: evidence }\n      - { mode: bogus }\n`;
  assert.equal(validateRecipeSource(src).ok, false);
});

test('validateRecipeSource: array validation with valid modes passes', () => {
  const src = `id: r\nname: r\ndescription: d\nsteps:\n  - id: s\n    goal: g\n    validation:\n      - { name: pr, mode: evidence }\n      - { name: wt, mode: artifacts }\n`;
  assert.equal(validateRecipeSource(src).ok, true);
});

test('buildStepDecls: array validation with a non-object element fails closed (throws)', () => {
  assert.throws(() => buildStepDecls([{ id: 's', goal: 'g', validation: [5] }]));
  assert.throws(() => buildStepDecls([{ id: 's', goal: 'g', validation: [{ mode: 'evidence' }, 5] }]));
  assert.throws(() => buildStepDecls([{ id: 's', goal: 'g', validation: [] }]));
});

test('buildStepDecls: scalar validation still fails closed', () => {
  assert.throws(() => buildStepDecls([{ id: 's', goal: 'g', validation: 5 }]));
});

test('buildStepDecls: valid array validation materializes canonical gates', () => {
  const [step] = buildStepDecls([{ id: 's', goal: 'g', validation: [{ name: 'pr', mode: 'evidence' }, { mode: 'artifacts' }] }]);
  assert.deepEqual(step.validation, { gates: [{ name: 'pr', mode: 'evidence' }, { name: 'artifacts', mode: 'artifacts' }] });
});

test('normalizeValidation: unique names even when explicit collides with a generated suffix', () => {
  const c = normalizeValidation([{ name: 'foo-3' }, { name: 'foo' }, { name: 'bar' }, { name: 'foo' }].map((g) => ({ ...g, mode: 'evidence' })));
  assert.equal(new Set(c.gates.map((g) => g.name)).size, 4);
});

test('normalizeValidation: explicit gate names are path-sanitized', () => {
  const c = normalizeValidation([{ name: '../x/y', mode: 'evidence' }]);
  assert.doesNotMatch(c.gates[0].name, /[\/\\.]{2}|[\/\\]/);
});

test('normalizeValidation: empty verifier_model is dropped', () => {
  const c = normalizeValidation([{ mode: 'evidence', verifier_model: '' }]);
  assert.equal('verifier_model' in c.gates[0], false);
});

test('migration v16 adds validation_runs_json column', () => {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(recipe_steps)').all().map((c) => c.name);
  assert.ok(cols.includes('validation_runs_json'), 'validation_runs_json column present');
  db.close();
});

test('migration v16: validation_runs_json is nullable + writable', () => {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  // Seed the minimal parent rows (workspace + instance) then a single step.
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_mg_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  const [row] = materializeSteps(db, instanceId, [{ id: 's', goal: 'g' }]);

  // Defaults to NULL before any write.
  assert.equal(row.validation_runs_json, null, 'defaults to NULL');

  // Round-trips an arbitrary JSON string.
  const payload = JSON.stringify({ attempt: 1, gates: { evidence: { verifier_session_id: 'as_1', started_at: 42 } } });
  db.prepare('UPDATE recipe_steps SET validation_runs_json = ? WHERE id = ?').run(payload, row.id);
  const read = db.prepare('SELECT validation_runs_json FROM recipe_steps WHERE id = ?').get(row.id);
  assert.equal(read.validation_runs_json, payload, 'round-trips the written JSON');

  db.close();
});

// ── serialization: buildStepValidation (recipe-instances-store) ──────────────
// Minimal in-memory harness mirroring the validation-worker test's
// open/seed/claim helpers so we can drive a real step through the worker and
// then assert the SERIALIZED validation the SPA consumes.

function openDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedStep(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_mg_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { instanceId };
}

function claimStep(db, instanceId, stepId, result = 'claimed') {
  const row = getStep(db, instanceId, stepId);
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'validating', result });
  return getStep(db, instanceId, stepId);
}

function readSerializedStep(instanceId, stepId) {
  // Read back through the SAME serializer the SPA uses. listAllRecipeInstancesFromDb
  // resolves its DB via safeDb()/getDatabase(), so the test DB is wired in via
  // setDatabaseForTesting() by the caller.
  const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
  assert.ok(inst, 'instance must be listed');
  const step = inst.steps.find((s) => s.id === stepId);
  assert.ok(step, 'step must be present');
  return step;
}

test('serialize: multi-gate step surfaces per-gate rounds + passed_gates (gate b FAIL→PASS)', async () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { instanceId } = seedStep(db, [
      { id: 'g', goal: 'ship it', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] },
    ]);
    const s = claimStep(db, instanceId, 'g', 'claim 1');
    const WSP = join(tmpdir(), `mg-ser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const worker = startValidationWorker({
      db,
      workspacePathFor: () => WSP,
      // gate a always PASSes; gate b FAILs on attempt 0, PASSes on attempt 1.
      spawnVerifier: async ({ step, verdictFile }) => {
        mkdirSync(dirname(verdictFile), { recursive: true });
        const isB = verdictFile.endsWith('__b.verdict.json');
        const body = isB && step.validation_attempt === 0
          ? { verdict: 'FAIL', evidence: 'artifact missing', gaps: 'produce the artifact' }
          : { verdict: 'PASS', evidence: 'looks good' };
        writeFileSync(verdictFile, JSON.stringify(body));
        return { sessionId: `vs-${step.validation_attempt}-${isB ? 'b' : 'a'}` };
      },
      deliverToWorker: async () => {},
      nextStepPrompt: async () => 'NEXT STEP READY',
      intervalMs: 10_000,
    });
    // attempt 0: tick1 spawns both gates (a=PASS, b=FAIL); tick2 aggregates → FAIL → running.
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(getStepById(db, s.id).status, 'running');
    // agent reworks + re-claims → fresh attempt 1.
    updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'g', status: 'done', result: 'fixed artifact' });
    assert.equal(getStepById(db, s.id).validation_attempt, 1);
    // attempt 1: tick3 spawns both gates (a=PASS, b=PASS); tick4 aggregates → PASS → done.
    await worker.runOnce();
    await worker.runOnce();
    worker.stop();
    assert.equal(getStepById(db, s.id).status, 'done');

    const step = readSerializedStep(instanceId, 'g');
    assert.ok(step.validation, 'gated step must carry validation');
    assert.equal(step.validation.total_gates, 2);
    assert.equal(step.validation.gates.length, 2);
    assert.deepEqual(step.validation.gates.map((g) => g.name).sort(), ['a', 'b']);
    assert.ok(step.validation.rounds.some((r) => r.gate === 'b' && r.verdict === 'FAIL'));
    assert.ok(step.validation.rounds.some((r) => r.gate === 'b' && r.verdict === 'PASS'));
    assert.equal(step.validation.passed_gates, 2); // both PASS at the final attempt
    // per-gate rounds carry their gate's attempt + mode.
    const bFail = step.validation.rounds.find((r) => r.gate === 'b' && r.verdict === 'FAIL');
    assert.equal(bFail.attempt, 0);
    assert.equal(bFail.mode, 'artifacts');
    const bPass = step.validation.rounds.find((r) => r.gate === 'b' && r.verdict === 'PASS');
    assert.equal(bPass.attempt, 1);
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('serialize: single-gate step (back-compat) — one PASS round, gate-tagged, total_gates 1', async () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { instanceId } = seedStep(db, [{ id: 'g', goal: 'open PR', validation: { mode: 'evidence' } }]);
    const s = claimStep(db, instanceId, 'g', 'opened PR #42');
    const WSP = join(tmpdir(), `sg-ser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const worker = startValidationWorker({
      db,
      workspacePathFor: () => WSP,
      spawnVerifier: async ({ verdictFile }) => {
        mkdirSync(dirname(verdictFile), { recursive: true });
        writeFileSync(verdictFile, JSON.stringify({ verdict: 'PASS', evidence: 'PR #42 really open' }));
        return { sessionId: 'verifier-sess' };
      },
      deliverToWorker: async () => {},
      nextStepPrompt: async () => 'NEXT STEP READY',
      intervalMs: 10_000,
    });
    await worker.runOnce(); // tick1: spawn (writes PASS)
    await worker.runOnce(); // tick2: read PASS → done
    worker.stop();
    assert.equal(getStepById(db, s.id).status, 'done');

    const step = readSerializedStep(instanceId, 'g');
    assert.ok(step.validation);
    assert.equal(step.validation.total_gates, 1);
    assert.equal(step.validation.gates.length, 1);
    assert.equal(step.validation.mode, 'evidence');
    const passRounds = step.validation.rounds.filter((r) => r.verdict === 'PASS');
    assert.equal(passRounds.length, 1, 'exactly one PASS round');
    assert.ok(step.validation.rounds[0].gate, 'single-gate round is still gate-tagged');
    assert.equal(step.validation.passed_gates, 1);
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('projectValidation (library-api): single decl → one gate; array → N gates', () => {
  assert.deepEqual(projectValidation({ mode: 'evidence' }), { gates: [{ name: 'evidence', mode: 'evidence' }] });
  const multi = projectValidation([{ name: 'x', mode: 'evidence' }, { mode: 'artifacts' }]);
  assert.equal(multi.gates.length, 2);
  assert.deepEqual(multi.gates.map((g) => g.name), ['x', 'artifacts']);
  assert.deepEqual(multi.gates.map((g) => g.mode), ['evidence', 'artifacts']);
  // criteria is carried through when present, dropped when absent.
  assert.deepEqual(projectValidation({ mode: 'evidence', criteria: 'must be green' }),
    { gates: [{ name: 'evidence', mode: 'evidence', criteria: 'must be green' }] });
  // no gate → undefined (unchanged contract).
  assert.equal(projectValidation(undefined), undefined);
  assert.equal(projectValidation(null), undefined);
});
