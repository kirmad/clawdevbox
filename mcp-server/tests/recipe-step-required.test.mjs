/**
 * Tests for the `required` step flag (recipe.yaml `steps[].required: true`).
 *
 * A step declared `required: true` must NOT be skippable — any attempt to
 * transition it into `skipped` is rejected. Non-required steps keep their
 * existing behavior (skippable from pending / running / awaiting_user).
 *
 * Drives the pure DB helpers in `src/db/recipe-steps-store.ts` and the tool
 * wrapper `updateStatusImpl` in `src/recipe-step-tools.ts` against an
 * in-memory SQLite DB, plus the shape validator `validateRecipeParsed`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import {
  materializeSteps,
  transitionStatus,
  getStep,
  getStepById,
  StepRequiredError,
} from '../src/db/recipe-steps-store.ts';
import { ToolErrorBox, updateStatusImpl } from '../src/recipe-step-tools.ts';
import { validateRecipeParsed } from '../src/validators.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_req_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (
       id, recipe_id, workspace_id, workspace_path, prompt,
       params_json, started_at, status
     ) VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

test('materializeSteps persists the required flag as 0/1', () => {
  const db = open();
  const { instanceId } = seed(db, [
    { id: 'design', goal: 'Design doc', required: true },
    { id: 'optional', goal: 'Nice to have' },
  ]);
  assert.equal(getStep(db, instanceId, 'design').required, 1);
  assert.equal(getStep(db, instanceId, 'optional').required, 0);
});

test('transitionStatus rejects skipping a required step', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'design', goal: 'Design doc', required: true }]);
  const row = getStep(db, instanceId, 'design');
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'skipped' }),
    (e) => e instanceof StepRequiredError && e.code === 'STEP_REQUIRED',
  );
  // status must be unchanged (still pending)
  assert.equal(getStepById(db, row.id).status, 'pending');
});

test('transitionStatus allows skipping a non-required step', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'optional', goal: 'Nice to have' }]);
  const row = getStep(db, instanceId, 'optional');
  const after = transitionStatus(db, row.id, { status: 'skipped' });
  assert.equal(after.status, 'skipped');
});

test('a required step can still progress to running and done', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'design', goal: 'Design doc', required: true }]);
  const row = getStep(db, instanceId, 'design');
  transitionStatus(db, row.id, { status: 'running' });
  const done = transitionStatus(db, row.id, { status: 'done' });
  assert.equal(done.status, 'done');
});

test('required step cannot be skipped from a running state either', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'design', goal: 'Design doc', required: true }]);
  const row = getStep(db, instanceId, 'design');
  transitionStatus(db, row.id, { status: 'running' });
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'skipped' }),
    (e) => e instanceof StepRequiredError,
  );
});

test('updateStatusImpl surfaces a STEP_REQUIRED ToolErrorBox when skipping a required step', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'design', goal: 'Design doc', required: true }]);
  assert.throws(
    () =>
      updateStatusImpl(db, {
        recipe_instance_id: instanceId,
        step_id: 'design',
        status: 'skipped',
      }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'STEP_REQUIRED',
  );
});

test('updateStatusImpl still allows skipping a non-required step', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'optional', goal: 'Nice to have' }]);
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId,
    step_id: 'optional',
    status: 'skipped',
  });
  assert.equal(res.step.status, 'skipped');
});

test('validateRecipeParsed accepts a boolean required flag', () => {
  const result = validateRecipeParsed({
    id: 'r',
    name: 'R',
    description: 'a recipe',
    steps: [
      { id: 's1', goal: 'required step', required: true },
      { id: 's2', goal: 'optional step', required: false },
    ],
  });
  assert.equal(result.ok, true);
});

test('validateRecipeParsed rejects a non-boolean required flag', () => {
  const result = validateRecipeParsed({
    id: 'r',
    name: 'R',
    description: 'a recipe',
    steps: [{ id: 's1', goal: 'bad required', required: 'yes' }],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === 'steps[0].required' && e.code === 'TYPE'),
    `expected a TYPE error at steps[0].required, got ${JSON.stringify(result.errors)}`,
  );
});
