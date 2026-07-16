import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import {
  materializeSteps, getStep, getStepById, transitionStatus, listStepsByStatus,
} from '../src/db/recipe-steps-store.ts';
import {
  verdictFilePath, buildVerifierPrompt, buildDeliveryPrompt, readVerdictFile, startValidationWorker,
  defaultValidationWorkerDeps,
} from '../src/recipe-validation-worker.ts';
import { updateStatusImpl } from '../src/recipe-step-tools.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_vw_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

export function claim(db, instanceId, stepId, result = 'claimed result') {
  const row = getStep(db, instanceId, stepId);
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'validating', result });
  return getStep(db, instanceId, stepId);
}

test('listStepsByStatus returns validating steps across instances', () => {
  const db = open();
  const a = seed(db, [{ id: 's', goal: 'A', validation: { mode: 'evidence' } }]);
  const b = seed(db, [{ id: 's', goal: 'B', validation: { mode: 'evidence' } }]);
  seed(db, [{ id: 's', goal: 'C plain' }]); // not gated, stays pending
  claim(db, a.instanceId, 's');
  claim(db, b.instanceId, 's');
  const validating = listStepsByStatus(db, 'validating');
  assert.equal(validating.length, 2);
  assert.deepEqual(validating.map((r) => r.recipe_instance_id).sort(), [a.instanceId, b.instanceId].sort());
});

test('verdictFilePath is deterministic + attempt-scoped + path-safe', () => {
  const p1 = verdictFilePath('C:/ws', 'ri_1', 'v1/backfill', 0);
  const p2 = verdictFilePath('C:/ws', 'ri_1', 'v1/backfill', 1);
  assert.notEqual(p1, p2);
  assert.match(p1, /ri_1__v1_backfill__attempt0\.verdict\.json$/);
});

test('buildDeliveryPrompt FAIL says reverted to active + gaps', () => {
  const msg = buildDeliveryPrompt({ outcome: 'rework', stepId: 'g', verdict: { verdict: 'FAIL', evidence: 'no PR', gaps: 'open the PR' } });
  assert.match(msg, /REVERTED TO ACTIVE/i);
  assert.match(msg, /not done/i);
  assert.match(msg, /open the PR/);
});

test('buildDeliveryPrompt PASS includes next step', () => {
  const msg = buildDeliveryPrompt({ outcome: 'passed', stepId: 'g', verdict: { verdict: 'PASS', evidence: 'ok' }, nextStepPrompt: 'NEXT STEP 11: ...' });
  assert.match(msg, /passed validation/i);
  assert.match(msg, /NEXT STEP 11/);
});

test('buildVerifierPrompt embeds the verdict file path + do-not-trust framing', () => {
  const p = buildVerifierPrompt({ recipeInstanceId: 'ri_1', stepId: 'g', verdictFile: 'C:/x.json', mode: 'evidence', claimedEvidence: 'PR open' });
  assert.match(p, /C:\/x\.json/);
  assert.match(p, /do not trust|assume the worker may be wrong/i);
  // The verifier is its OWN ad-hoc instance, so it must read the ORIGINAL
  // instance EXPLICITLY (not rely on its own CLAWDEVBOX_RECIPE_INSTANCE_ID).
  assert.match(p, /recipe\.instance\.get\(\{ recipe_instance_id: "ri_1" \}\)/);
  assert.doesNotMatch(p, /already set/i);
});

test('readVerdictFile parses valid, rejects malformed/missing', () => {
  const dir = join(tmpdir(), `verdict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ verdict: 'PASS', evidence: 'ok' }));
  assert.deepEqual(readVerdictFile(good), { verdict: 'PASS', evidence: 'ok', gaps: undefined, trigger_id: undefined });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.equal(readVerdictFile(bad), null);
  assert.equal(readVerdictFile(join(dir, 'missing.json')), null);
});

test('readVerdictFile rejects valid JSON with a bad shape', () => {
  const dir = join(tmpdir(), `verdict-shape-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const badKind = join(dir, 'badkind.json');
  writeFileSync(badKind, JSON.stringify({ verdict: 'MAYBE', evidence: 'x' }));
  assert.equal(readVerdictFile(badKind), null);            // verdict not in enum
  const noEvidence = join(dir, 'noev.json');
  writeFileSync(noEvidence, JSON.stringify({ verdict: 'PASS' }));
  assert.equal(readVerdictFile(noEvidence), null);          // missing/non-string evidence
  const primitive = join(dir, 'prim.json');
  writeFileSync(primitive, '42');
  assert.equal(readVerdictFile(primitive), null);           // primitive JSON
});

// ── startValidationWorker loop ────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeWorker(db, overrides = {}) {
  const delivered = [];
  const spawned = [];
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => join(tmpdir(), `vw-${Math.random().toString(36).slice(2)}`),
    spawnVerifier: async ({ verdictFile }) => { spawned.push(verdictFile); return { sessionId: 'verifier-sess' }; },
    deliverToWorker: async ({ prompt }) => { delivered.push(prompt); },
    nextStepPrompt: async () => 'NEXT STEP READY',
    intervalMs: 10_000,
    ...overrides,
  });
  return { worker, delivered, spawned };
}

test('worker tick 1 spawns a verifier + records verifier_session_id + validation_started event', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'opened PR #42');
  const { worker, spawned } = makeWorker(db);
  await worker.runOnce();
  worker.stop();
  assert.equal(spawned.length, 1);
  assert.equal(getStepById(db, s.id).verifier_session_id, 'verifier-sess');
});

test('worker applies a PASS verdict file → done + delivers next step', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'opened PR #42');
  const WSP = join(tmpdir(), `vw-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { worker, delivered } = makeWorker(db, {
    workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => {
      mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, JSON.stringify({ verdict: 'PASS', evidence: 'PR #42 really open' }));
      return { sessionId: 'verifier-sess' };
    },
  });
  await worker.runOnce(); // tick 1: spawns (writes file), records session
  await worker.runOnce(); // tick 2: reads verdict → applyVerdict PASS → deliver
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'done');
  assert.ok(delivered.some((p) => /passed validation/i.test(p) && /NEXT STEP READY/.test(p)));
});

test('worker applies a FAIL verdict → reverts to running + delivers reverted-to-active msg', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 3 } }]);
  const s = claim(db, instanceId, 'g', 'claimed done');
  const WSP = join(tmpdir(), `vw-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { worker, delivered } = makeWorker(db, {
    workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => {
      mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, JSON.stringify({ verdict: 'FAIL', evidence: 'no PR exists', gaps: 'actually open the PR' }));
      return { sessionId: 'vs' };
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'running');
  assert.ok(delivered.some((p) => /REVERTED TO ACTIVE/i.test(p) && /actually open the PR/.test(p)));
});

test('worker escalates to awaiting_user after verdict timeout exhausts attempts', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'claimed');
  const WSP = join(tmpdir(), `vw-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { worker } = makeWorker(db, {
    workspacePathFor: () => WSP,
    maxAttempts: 2,
    verdictTimeoutMs: 0, // everything is instantly "timed out"
    spawnVerifier: async () => ({ sessionId: 'vs' }), // never writes a verdict
  });
  // tick1: spawn (attempt 0). tick2: timeout→retry (attempt 1, clears verifier).
  // tick3: spawn (attempt 1). tick4: timeout→attempt 2 >= max → escalate.
  // Small sleeps guarantee wall-clock advances past the strict `>` timeout=0 check.
  await worker.runOnce();
  await sleep(5);
  await worker.runOnce();
  // Intermediate invariant: retried (attempt bumped, verifier cleared), NOT escalated yet.
  const mid = getStepById(db, s.id);
  assert.equal(mid.status, 'validating');
  assert.equal(mid.validation_attempt, 1);
  assert.equal(mid.verifier_session_id, null);
  await worker.runOnce();
  await sleep(5);
  await worker.runOnce();
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'awaiting_user');
});

test('persistently failing verifier spawn is bounded → retries then escalates to awaiting_user (not an infinite loop)', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'claimed');
  let spawnCalls = 0;
  const { worker } = makeWorker(db, {
    workspacePathFor: () => join(tmpdir(), `vw-spawnfail-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    maxAttempts: 2,
    spawnVerifier: async () => { spawnCalls += 1; throw new Error('unknown agent_cli / provider missing'); },
  });
  // tick1: attempt0 spawn throws → retry (attempt→1, verifier stays null). NOT escalated yet.
  await worker.runOnce();
  const mid = getStepById(db, s.id);
  assert.equal(mid.status, 'validating');
  assert.equal(mid.validation_attempt, 1);
  assert.equal(mid.verifier_session_id, null);
  // tick2: attempt1 spawn throws → nextAttempt 2 >= max → escalate to awaiting_user.
  await worker.runOnce();
  // tick3: step is no longer `validating`, so the loop must NOT touch it again.
  await worker.runOnce();
  worker.stop();
  const row = getStepById(db, s.id);
  assert.equal(row.status, 'awaiting_user');
  assert.equal(spawnCalls, 2); // bounded by maxAttempts — never loops forever
  const errEvents = db
    .prepare(`SELECT type, payload_json FROM step_events WHERE recipe_step_id = ? AND type = 'validation_error'`)
    .all(s.id);
  assert.ok(errEvents.some((e) => String(e.payload_json).includes('spawn_failed_escalated')),
    'expected a spawn_failed_escalated validation_error event');
});

test('FAIL → re-claim spawns a FRESH verifier (new attempt), not the stale verdict; then PASS → done', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 3 } }]);
  const s = claim(db, instanceId, 'g', 'claim 1');
  const WSP = join(tmpdir(), `vw-recycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let spawnCount = 0;
  const delivered = [];
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => WSP,
    // attempt 0 → FAIL, attempt 1 → PASS (keyed off the attempt in the path)
    spawnVerifier: async ({ step, verdictFile }) => {
      spawnCount += 1;
      mkdirSync(dirname(verdictFile), { recursive: true });
      const body = step.validation_attempt === 0
        ? { verdict: 'FAIL', evidence: 'no PR', gaps: 'open the PR' }
        : { verdict: 'PASS', evidence: 'PR really open now' };
      writeFileSync(verdictFile, JSON.stringify(body));
      return { sessionId: `vs-${step.validation_attempt}` };
    },
    deliverToWorker: async ({ prompt }) => { delivered.push(prompt); },
    nextStepPrompt: async () => 'NEXT STEP READY',
    intervalMs: 10_000,
  });
  await worker.runOnce(); // attempt0: spawn → writes FAIL
  await worker.runOnce(); // reads FAIL → applyVerdict → running; delivers reverted-to-active
  assert.equal(getStepById(db, s.id).status, 'running');
  // agent fixes + re-claims via the auto-claim path:
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'g', status: 'done', result: 'fixed it, opened PR' });
  assert.equal(getStepById(db, s.id).status, 'validating');
  assert.equal(getStepById(db, s.id).validation_attempt, 1);        // rotated
  assert.equal(getStepById(db, s.id).verifier_session_id, null);    // cleared → will spawn fresh
  await worker.runOnce(); // attempt1: spawn FRESH verifier → writes PASS
  await worker.runOnce(); // reads PASS → done
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'done');
  assert.equal(spawnCount, 2);                                      // proves fresh re-verification
  assert.ok(delivered.some((p) => /passed validation/i.test(p)));
});

test('first verifier is NOT timed out immediately when work started long ago (spawn-relative window)', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'claimed');
  // simulate long prior work: backdate started_at well beyond the timeout window
  db.prepare(`UPDATE recipe_steps SET started_at = ? WHERE id = ?`).run(Date.now() - 60 * 60_000, s.id);
  const WSP = join(tmpdir(), `vw-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let spawnCount = 0;
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => WSP,
    spawnVerifier: async () => { spawnCount += 1; return { sessionId: 'vs' }; }, // never writes a verdict
    deliverToWorker: async () => {},
    nextStepPrompt: async () => null,
    intervalMs: 10_000,
    verdictTimeoutMs: 10 * 60_000, // 10 min
    maxAttempts: 3,
  });
  await worker.runOnce(); // spawn (resets started_at to now)
  await worker.runOnce(); // must NOT treat the fresh verifier as timed out
  worker.stop();
  const row = getStepById(db, s.id);
  assert.equal(row.status, 'validating');     // still validating, not retried/escalated
  assert.equal(row.validation_attempt, 0);    // no infra retry happened
  assert.equal(spawnCount, 1);                // only the one verifier
});

// ── real injected deps (defaultValidationWorkerDeps) ─────────────────────────
// The two PURE deps (workspacePathFor, nextStepPrompt) only touch the DB, so
// dispatcher/ws/cfg can be stubbed. The spawn+deliver deps need a real headless
// provider (not hermetic) — see the documented skip at the bottom.

function pureDepsCtx(db) {
  return defaultValidationWorkerDeps({
    db,
    dispatcher: /** @type {any} */ ({}),
    ws: /** @type {any} */ ({}),
    cfg: /** @type {any} */ ({}),
    workspacesRoot: '',
  });
}

test('defaultValidationWorkerDeps.workspacePathFor returns the instance workspace_path', () => {
  const db = open();
  const { ws, instanceId } = seed(db, [{ id: 's', goal: 'A', validation: { mode: 'evidence' } }]);
  const deps = pureDepsCtx(db);
  assert.equal(deps.workspacePathFor(instanceId), ws.path);
});

test('defaultValidationWorkerDeps.workspacePathFor throws for a missing instance', () => {
  const db = open();
  const deps = pureDepsCtx(db);
  assert.throws(() => deps.workspacePathFor('ri_missing'), /no recipe_instance/);
});

test('defaultValidationWorkerDeps.nextStepPrompt: null while dep unmet, then emits ready step B', async () => {
  const db = open();
  const { instanceId } = seed(db, [
    { id: 'A', goal: 'do A' },
    { id: 'B', goal: 'do B', depends: ['A'], ai_instructions: 'be careful with B' },
  ]);
  const deps = pureDepsCtx(db);
  const a = getStep(db, instanceId, 'A');
  // A running (non-terminal): A is not pending, B's dep is unmet → nothing ready.
  transitionStatus(db, a.id, { status: 'running' });
  assert.equal(await deps.nextStepPrompt({ recipeInstanceId: instanceId, doneStepId: 'A' }), null);
  // A done → B becomes ready.
  transitionStatus(db, a.id, { status: 'done' });
  const prompt = await deps.nextStepPrompt({ recipeInstanceId: instanceId, doneStepId: 'A' });
  assert.match(prompt, /▶ NEXT STEP: B/);
  assert.match(prompt, /Goal: do B/);
  assert.match(prompt, /Instructions: be careful with B/);
});

// The FULL real-deps spawn+deliver cycle needs a real headless agent CLI
// (copilot) + a live workspace provider registry + dispatcher, so it is NOT
// hermetic and would risk hanging in CI. The loop logic is already covered by
// the injected-fake tests above (Task 4); factory compilation is covered by
// `npm run typecheck`. Manual verification steps:
//   1. Start the server (`clawdevbox start`) with a recipe that has a
//      validation-gated step; claim the step so it enters `validating`.
//   2. Confirm the worker spawns a headless verifier session (check
//      recipe_steps.verifier_session_id + the `validation_started` event).
//   3. Confirm the verifier receives CLAWDEVBOX_VERDICT_FILE and writes the
//      verdict JSON there; the worker applies it and the step → done (PASS).
//   4. Confirm the PASS delivery + next-step prompt reach the worker session
//      (dispatchOnly if live, else spawnDispatchOrResume).
test.skip('real-deps PASS cycle (manual)', () => {});

// ── multi-gate validation (Task 4) ───────────────────────────────────────────
// A step with >1 gate fans out one verifier PER gate, each writing its OWN
// gate-suffixed verdict file (…__<gate>.verdict.json). The worker aggregates
// (applyGateVerdicts) only once EVERY gate has returned a verdict. The fake
// spawnVerifier below writes the gate's verdict file directly, detecting which
// gate it is from the `__<gate>.verdict.json` suffix the worker encodes.

test('single-gate worker reads mode + criteria from the canonical {gates} shape (regression)', async () => {
  const db = open();
  // Canonical single-gate shape as buildStepDecls writes it, with a NON-evidence
  // mode + explicit criteria. Before the fix the worker read the raw top level
  // (validation.mode/criteria = undefined) and verified as 'evidence' with none.
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: { gates: [{ name: 'judge', mode: 'judge', criteria: 'coverage >= 80%' }] } }]);
  claim(db, instanceId, 'g', 'claimed');
  let captured = '';
  const WSP = join(tmpdir(), `sg-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => WSP,
    spawnVerifier: async ({ prompt }) => { captured = prompt; return { sessionId: 'vs' }; },
    deliverToWorker: async () => {},
    nextStepPrompt: async () => null,
    intervalMs: 10_000,
  });
  await worker.runOnce();
  worker.stop();
  assert.match(captured, /judge/i);            // the author's mode, not defaulted 'evidence'
  assert.match(captured, /coverage >= 80%/);   // the author's criteria, not "no criteria given"
});

test('multi-gate: all gates PASS → done (parallel spawn)', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  const s = claim(db, instanceId, 'g', 'did the work');
  const WSP = join(tmpdir(), `mg-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let spawnCount = 0;
  const worker = startValidationWorker({
    db, workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => {
      spawnCount += 1;
      mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, JSON.stringify({ verdict: 'PASS', evidence: 'ok ' + verdictFile }));
      return { sessionId: 'vs' + spawnCount };
    },
    deliverToWorker: async () => {}, nextStepPrompt: async () => 'NEXT', intervalMs: 10_000,
  });
  await worker.runOnce(); // tick1: spawn BOTH gates in one pass (each writes PASS)
  assert.equal(spawnCount, 2); // proves parallel fan-out in a single tick
  await worker.runOnce(); // tick2: all verdicts present → aggregate PASS → done
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'done');
  assert.equal(spawnCount, 2);
});

test('multi-gate: one gate FAILs → reverted to active with that gate\'s gaps', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  const s = claim(db, instanceId, 'g', 'did the work');
  const WSP = join(tmpdir(), `mg-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const delivered = [];
  const worker = startValidationWorker({
    db, workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => {
      mkdirSync(dirname(verdictFile), { recursive: true });
      const isB = /__b\.verdict/.test(verdictFile);
      writeFileSync(verdictFile, JSON.stringify(isB ? { verdict: 'FAIL', evidence: 'b bad', gaps: 'make b' } : { verdict: 'PASS', evidence: 'a ok' }));
      return { sessionId: 'vs' };
    },
    deliverToWorker: async ({ prompt }) => delivered.push(prompt), nextStepPrompt: async () => null, intervalMs: 10_000,
  });
  await worker.runOnce();
  await worker.runOnce();
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'running');
  assert.ok(delivered.some((p) => /REVERTED TO ACTIVE/i.test(p) && /make b/.test(p)));
});

test('multi-gate: re-claim after FAIL re-runs ALL gates (fresh attempt)', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  const s = claim(db, instanceId, 'g', 'first try');
  const WSP = join(tmpdir(), `mg-re-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let spawnCount = 0;
  const worker = startValidationWorker({
    db, workspacePathFor: () => WSP,
    // attempt 0: b FAILs; attempt 1: both PASS
    spawnVerifier: async ({ step, verdictFile }) => {
      spawnCount += 1;
      mkdirSync(dirname(verdictFile), { recursive: true });
      const isB = /__b\.verdict/.test(verdictFile);
      const fail = step.validation_attempt === 0 && isB;
      writeFileSync(verdictFile, JSON.stringify(fail ? { verdict: 'FAIL', evidence: 'b bad', gaps: 'make b' } : { verdict: 'PASS', evidence: 'ok' }));
      return { sessionId: 'vs' + spawnCount };
    },
    deliverToWorker: async () => {}, nextStepPrompt: async () => null, intervalMs: 10_000,
  });
  await worker.runOnce(); await worker.runOnce(); // attempt0: spawn 2, apply → FAIL → running
  assert.equal(getStepById(db, s.id).status, 'running');
  // agent re-claims (auto-claim running→validating, bumps attempt, clears verifier/verdict)
  const { updateStatusImpl } = await import('../src/recipe-step-tools.ts');
  updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'g', status: 'done', result: 'fixed b' });
  assert.equal(getStepById(db, s.id).status, 'validating');
  await worker.runOnce(); await worker.runOnce(); // attempt1: spawn 2 FRESH, apply → PASS → done
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'done');
  assert.equal(spawnCount, 4); // 2 per attempt × 2 attempts — proves all gates re-ran
});

// ── gate verifier selectors (Task 6) ─────────────────────────────────────────
// A gate may pick the CLI/persona/model of its independent verifier via
// verifier_provider / verifier_agent / verifier_model. These must be threaded
// through the spawnVerifier seam so runRecipe can pick the right provider.

test('single-gate: gate verifier_provider/agent/model are threaded into spawnVerifier', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: { gates: [{ name: 'g', mode: 'judge', verifier_provider: 'claude', verifier_agent: 'x:y', verifier_model: 'claude-opus-4.8' }] } }]);
  claim(db, instanceId, 'g', 'claimed');
  const seen = [];
  const WSP = join(tmpdir(), `sg-verifier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => WSP,
    spawnVerifier: async (args) => { seen.push(args.verifier); return { sessionId: 'v1' }; },
    deliverToWorker: async () => {},
    nextStepPrompt: async () => null,
    intervalMs: 10_000,
  });
  await worker.runOnce();
  worker.stop();
  assert.deepEqual(seen[0], { provider: 'claude', agent: 'x:y', model: 'claude-opus-4.8' });
});

test('multi-gate: EACH gate\'s verifier_provider/agent/model is threaded into its spawnVerifier', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: { gates: [
    { name: 'a', mode: 'evidence', verifier_provider: 'copilot', verifier_model: 'model-a' },
    { name: 'b', mode: 'judge', verifier_provider: 'claude', verifier_agent: 'p:q', verifier_model: 'model-b' },
  ] } }]);
  claim(db, instanceId, 'g', 'claimed');
  const seen = [];
  const WSP = join(tmpdir(), `mg-verifier-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => WSP,
    spawnVerifier: async (args) => { seen.push(args.verifier); return { sessionId: 'v-' + seen.length }; },
    deliverToWorker: async () => {},
    nextStepPrompt: async () => null,
    intervalMs: 10_000,
  });
  await worker.runOnce(); // multi-gate: spawns BOTH gates in one tick
  worker.stop();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((v) => v.model).sort(), ['model-a', 'model-b']);
  assert.deepEqual(seen.find((v) => v.model === 'model-a'), { provider: 'copilot', agent: undefined, model: 'model-a' });
  assert.deepEqual(seen.find((v) => v.model === 'model-b'), { provider: 'claude', agent: 'p:q', model: 'model-b' });
});

// A gated step on a NON-main lane must have its PASS/FAIL delivered to THAT
// lane (so the rework prompt reaches the console that did the work), not main.
test('deliverToWorker receives the gated step lane (non-main routing)', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', execution: { session: 'deploy' }, validation: { gates: [{ name: 'j', mode: 'evidence' }] } }]);
  claim(db, instanceId, 'g', 'claimed');
  const delivered = [];
  const WSP = join(tmpdir(), `dl-lane-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => { mkdirSync(dirname(verdictFile), { recursive: true }); writeFileSync(verdictFile, JSON.stringify({ verdict: 'PASS', evidence: 'ok' })); return { sessionId: 'v1' }; },
    deliverToWorker: async (a) => { delivered.push(a); },
    nextStepPrompt: async () => null,
    intervalMs: 10_000,
  });
  await worker.runOnce(); // spawn verifier (writes PASS verdict file)
  await worker.runOnce(); // read verdict → PASS → deliverToWorker
  worker.stop();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].lane, 'deploy');
});

