import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { materializeSteps, getStep, transitionStatus, getStepById, rowToStep, StepValidationRequiredError } from '../src/db/recipe-steps-store.ts';
import { ToolErrorBox, updateStatusImpl } from '../src/recipe-step-tools.ts';
import { applyVerdict, applyGateVerdicts } from '../src/recipe-validation.ts';
import { listEvents } from '../src/db/step-events-store.ts';
import { validateRecipeParsed, parseRecipeSource } from '../src/validators.ts';

export function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_val_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (
       id, recipe_id, workspace_id, workspace_path, prompt,
       params_json, started_at, status
     ) VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

test('migration v14 adds the validation columns with correct defaults', () => {
  const db = open();
  const cols = db.prepare(`PRAGMA table_info(recipe_steps)`).all().map((c) => c.name);
  for (const c of ['validation_json', 'execution_json', 'verifier_session_id', 'verdict_json', 'rework_count', 'validation_attempt']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  const { instanceId } = seed(db, [{ id: 's', goal: 'g' }]);
  const row = getStep(db, instanceId, 's');
  assert.equal(row.validation_json, null);
  assert.equal(row.execution_json, null);
  assert.equal(row.verifier_session_id, null);
  assert.equal(row.verdict_json, null);
  assert.equal(row.rework_count, 0);
  assert.equal(row.validation_attempt, 0);
});

// helper used by later tasks: drive a step to `validating` (a claim).
function claim(db, instanceId, stepId) {
  const row = getStep(db, instanceId, stepId);
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'validating', result: 'claimed: PR open' });
  return getStep(db, instanceId, stepId);
}

test('materializeSteps persists validation/execution as JSON, null when absent', () => {
  const db = open();
  const { instanceId } = seed(db, [
    { id: 'gated', goal: 'PR', validation: { mode: 'evidence', max_rework: 2 } },
    { id: 'plain', goal: 'setup' },
  ]);
  const gated = getStep(db, instanceId, 'gated');
  assert.deepEqual(JSON.parse(gated.validation_json), { mode: 'evidence', max_rework: 2 });
  assert.equal(getStep(db, instanceId, 'plain').validation_json, null);
});

test('running can transition to validating', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'gated', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'gated');
  transitionStatus(db, row.id, { status: 'running' });
  const after = transitionStatus(db, row.id, { status: 'validating' });
  assert.equal(after.status, 'validating');
});

test('gated step: running→done is rejected (must claim first)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'done' }),
    (e) => e instanceof StepValidationRequiredError && e.code === 'STEP_VALIDATION_REQUIRED',
  );
  assert.equal(getStepById(db, row.id).status, 'running');
});

test('gated step: validating→done without viaVerdict is rejected', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = claim(db, instanceId, 'g');
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'done' }),
    (e) => e instanceof StepValidationRequiredError,
  );
});

test('gated step: validating→done WITH viaVerdict succeeds', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = claim(db, instanceId, 'g');
  const done = transitionStatus(db, row.id, { status: 'done', viaVerdict: true });
  assert.equal(done.status, 'done');
});

test('non-gated step: running→done still works (backward compatible)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'p', goal: 'plain' }]);
  const row = getStep(db, instanceId, 'p');
  transitionStatus(db, row.id, { status: 'running' });
  assert.equal(transitionStatus(db, row.id, { status: 'done' }).status, 'done');
});

test('gated step: awaiting_user→done is rejected (no bypass via awaiting_user)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'awaiting_user' });
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'done' }),
    (e) => e instanceof StepValidationRequiredError && e.code === 'STEP_VALIDATION_REQUIRED',
  );
  assert.equal(getStepById(db, row.id).status, 'awaiting_user');
});

test('updateStatusImpl surfaces STEP_VALIDATION_REQUIRED for a gated validating→done (no viaVerdict)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  // A gated running→done is now auto-claimed into `validating` (see the
  // auto-claim shim). The tool must STILL surface STEP_VALIDATION_REQUIRED for
  // the genuinely-invalid path the shim does NOT intercept: a validating→done
  // without a verifier verdict.
  claim(db, instanceId, 'g'); // running→validating
  assert.throws(
    () => updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'g', status: 'done' }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'STEP_VALIDATION_REQUIRED',
  );
});

test('applyVerdict PASS -> done, stores evidence + verdict + event', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  claim(db, instanceId, 'g');
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'PASS', evidence: 'PR #123 merged, 540 tests green' },
  });
  assert.equal(res.outcome, 'passed');
  const row = getStep(db, instanceId, 'g');
  assert.equal(row.status, 'done');
  assert.match(row.result, /PR #123 merged/);
  assert.equal(JSON.parse(row.verdict_json).verdict, 'PASS');
});

test('applyVerdict PASS on the final gated step cascades the recipe_instance to success', () => {
  const db = open();
  // A recipe whose ONLY (or last) step is validation-gated must still complete:
  // the verdict-apply path transitions the step to done, and the instance must
  // cascade to terminal — exactly like the agent update_status path does.
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  claim(db, instanceId, 'g');
  applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'PASS', evidence: 'all done' },
  });
  const inst = db.prepare('SELECT status, completed_at FROM recipe_instances WHERE id = ?').get(instanceId);
  assert.equal(inst.status, 'success');
  assert.ok(inst.completed_at, 'completed_at must be set when the instance cascades');
});

test('applyVerdict PASS on a non-final step does NOT cascade while siblings are pending', () => {
  const db = open();
  const { instanceId } = seed(db, [
    { id: 'g', goal: 'PR', validation: { mode: 'evidence' } },
    { id: 's2', goal: 'later step' },
  ]);
  claim(db, instanceId, 'g');
  applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'PASS', evidence: 'done' },
  });
  const inst = db.prepare('SELECT status FROM recipe_instances WHERE id = ?').get(instanceId);
  assert.equal(inst.status, 'running', 's2 is still pending, so the instance must stay running');
});

test('applyVerdict FAIL -> running with rework_count incremented', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 3 } }]);
  claim(db, instanceId, 'g');
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'FAIL', evidence: 'no PR found', gaps: 'open the PR' },
  });
  assert.equal(res.outcome, 'rework');
  assert.equal(res.rework_count, 1);
  assert.equal(getStep(db, instanceId, 'g').status, 'running');
});

test('applyVerdict FAIL at max_rework -> awaiting_user stalemate', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 1 } }]);
  claim(db, instanceId, 'g');
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'FAIL', evidence: 'still not done', gaps: 'do it' },
  });
  assert.equal(res.outcome, 'stalemate');
  assert.equal(getStep(db, instanceId, 'g').status, 'awaiting_user');
});

test('applyVerdict BLOCKED without trigger_id throws; with trigger_id -> awaiting_user', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  claim(db, instanceId, 'g');
  assert.throws(
    () => applyVerdict(db, { recipe_instance_id: instanceId, step_id: 'g', verdict: { verdict: 'BLOCKED', evidence: 'gated' } }),
    (e) => e.code === 'BLOCKED_REQUIRES_TRIGGER',
  );
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'BLOCKED', evidence: 'waiting on merge', trigger_id: 'ado.new-pr-watcher#abc' },
  });
  assert.equal(res.outcome, 'blocked');
  assert.equal(getStep(db, instanceId, 'g').status, 'awaiting_user');
});

test('applyVerdict appends a validation_verdict audit event', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = claim(db, instanceId, 'g');
  applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'PASS', evidence: 'PR merged' },
  });
  const events = listEvents(db, { recipe_step_id: row.id });
  assert.ok(
    events.some((e) => e.type === 'validation_verdict'),
    `expected a validation_verdict event, got ${JSON.stringify(events.map((e) => e.type))}`,
  );
});

// ---------------------------------------------------------------------------
// Recipe SOURCE validator: validation/execution step blocks (spec §7.4).
// ---------------------------------------------------------------------------

test('validateRecipeParsed accepts a valid validation block', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'PR', validation: { mode: 'evidence', max_rework: 2 } }],
  });
  assert.equal(result.ok, true);
});

test('validateRecipeParsed rejects a bad validation.mode', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'PR', validation: { mode: 'vibes' } }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[0].validation.mode'));
});

test('validateRecipeParsed rejects a bad execution.mode', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'x', execution: { mode: 'parallel-9000' } }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[0].execution.mode'));
});

test('validateRecipeParsed rejects max_rework < 1', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'PR', validation: { mode: 'evidence', max_rework: 0 } }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[0].validation.max_rework'));
});

test('parseRecipeSource carries validation/execution onto the parsed step', () => {
  const yaml = [
    'id: r',
    'name: R',
    'description: a recipe',
    'steps:',
    '  - id: s1',
    '    goal: PR',
    '    validation:',
    '      mode: evidence',
    '    execution:',
    '      mode: fresh-session',
  ].join('\n');
  const parsed = parseRecipeSource(yaml);
  const step = (parsed.recipe ?? parsed).steps[0];
  assert.deepEqual(step.validation, { mode: 'evidence' });
  assert.deepEqual(step.execution, { mode: 'fresh-session' });
});

// ---------------------------------------------------------------------------
// Auto-claim shim (Task 2): a gated step's `→ done` from the agent is
// transparently converted into a validation CLAIM (`→ validating`) so gating
// stays invisible — agents keep calling update_status(done) as usual.
// ---------------------------------------------------------------------------

test('auto-claim: gated running→done is converted to validating (evidence kept)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId, step_id: 'g', status: 'done', result: 'opened PR #42',
  });
  const after = getStep(db, instanceId, 'g');
  assert.equal(after.status, 'validating');            // claimed, NOT done
  assert.match(after.result, /opened PR #42/);          // evidence preserved
  assert.match(res.step.message ?? '', /validation-gated|verifier|Claim recorded/i);
});

test('auto-claim: gated awaiting_user→done (post-rework) also claims to validating', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'awaiting_user' });
  const res = updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'g', status: 'done', result: 'fixed it' });
  assert.equal(getStep(db, instanceId, 'g').status, 'validating');
});

test('auto-claim: non-gated running→done still completes normally', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'p', goal: 'plain' }]);
  const row = getStep(db, instanceId, 'p');
  transitionStatus(db, row.id, { status: 'running' });
  const res = updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'p', status: 'done' });
  assert.equal(res.step.status, 'done');
});

test('auto-claim does not fire for a verdict-driven done (viaVerdict path via applyVerdict)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  claim(db, instanceId, 'g'); // running→validating
  const r = applyVerdict(db, { recipe_instance_id: instanceId, step_id: 'g', verdict: { verdict: 'PASS', evidence: 'ok' } });
  assert.equal(r.outcome, 'passed');
  assert.equal(getStep(db, instanceId, 'g').status, 'done'); // verdict path still reaches done
});

// ---------------------------------------------------------------------------
// Task 3: applyGateVerdicts — multiple gate verdicts aggregated onto one step
// (AND semantics: all PASS → done; any FAIL → rework/stalemate with combined
// gaps; any BLOCKED → awaiting_user, precedence BLOCKED > FAIL > PASS).
// ---------------------------------------------------------------------------

test('applyGateVerdicts: all PASS → done', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  claim(db, instanceId, 'g');
  const r = applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: { a: { verdict: 'PASS', evidence: 'a ok' }, b: { verdict: 'PASS', evidence: 'b ok' } } });
  assert.equal(r.outcome, 'passed');
  assert.equal(getStep(db, instanceId, 'g').status, 'done');
});
test('applyGateVerdicts: one FAIL → running with combined gaps naming the failed gate', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  claim(db, instanceId, 'g');
  const r = applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: { a: { verdict: 'PASS', evidence: 'a ok' }, b: { verdict: 'FAIL', evidence: 'b missing', gaps: 'produce artifact b' } } });
  assert.equal(r.outcome, 'rework');
  assert.equal(getStep(db, instanceId, 'g').status, 'running');
  const v = JSON.parse(getStep(db, instanceId, 'g').verdict_json);
  assert.match(v.gaps, /b: produce artifact b/);
  assert.ok(v.gates && v.gates.a && v.gates.b, 'per-gate map present');
});
test('applyGateVerdicts: any BLOCKED → awaiting_user (precedence over FAIL)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'evidence' }] }]);
  claim(db, instanceId, 'g');
  const r = applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: { a: { verdict: 'FAIL', evidence: 'x', gaps: 'y' }, b: { verdict: 'BLOCKED', evidence: 'gated on CI', trigger_id: 't1' } } });
  assert.equal(r.outcome, 'blocked');
  assert.equal(getStep(db, instanceId, 'g').status, 'awaiting_user');
});
test('applyGateVerdicts: BLOCKED without trigger_id throws', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }] }]);
  claim(db, instanceId, 'g');
  assert.throws(() => applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: { a: { verdict: 'BLOCKED', evidence: 'x' } } }));
});
test('applyVerdict wrapper: single FAIL still reverts to running (parity)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: { mode: 'evidence', max_rework: 3 } }]);
  claim(db, instanceId, 'g');
  const r = applyVerdict(db, { recipe_instance_id: instanceId, step_id: 'g', verdict: { verdict: 'FAIL', evidence: 'no', gaps: 'do it' } });
  assert.equal(r.outcome, 'rework');
  assert.equal(getStep(db, instanceId, 'g').status, 'running');
});
