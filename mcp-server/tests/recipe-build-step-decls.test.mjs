/**
 * Tests for `buildStepDecls` — the raw-parsed-step → `Step` declaration
 * transform used by the recipe.begin handler in `src/tools/recipe.ts`.
 *
 * This map is the ONLY place raw parsed recipe steps become the `Step[]` that
 * `materializeSteps` persists to the DB. Deleting the validation/execution
 * passthrough must fail a test — that is what this file guards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStepDecls } from '../src/tools/recipe.ts';

test('buildStepDecls carries required/validation/execution onto step decls', () => {
  const decls = buildStepDecls([
    { id: 's1', goal: 'PR', required: true, validation: { mode: 'evidence', max_rework: 2 }, execution: { mode: 'fresh-session' } },
    { id: 's2', goal: 'setup' },
  ]);
  assert.equal(decls[0].required, true);
  // `validation` is now canonicalized to the multi-gate ValidationConfig shape
  // by normalizeValidation (single object → one gate named by its mode).
  assert.deepEqual(decls[0].validation, { gates: [{ name: 'evidence', mode: 'evidence' }], max_rework: 2 });
  assert.deepEqual(decls[0].execution, { mode: 'fresh-session' });
  assert.equal(decls[1].required, undefined);
  assert.equal(decls[1].validation, undefined);
  assert.equal(decls[1].execution, undefined);
});

test('buildStepDecls carries triggers + artifacts onto step decls (template load path)', () => {
  // Regression: these two fields were silently dropped by the map, so a recipe
  // begun from a TEMPLATE lost every step-declared trigger (trigger-based gates
  // could never register) and every declared artifact. `materializeSteps`
  // already persists both — the transform just failed to pass them through.
  const decls = buildStepDecls([
    {
      id: 's1',
      goal: 'watch',
      triggers: [{ type: 'memory-sync', cron: false, once: true }],
      artifacts: [{ id: 'out', type: 'file', title: 'Output' }],
    },
    { id: 's2', goal: 'noop' },
  ]);
  assert.deepEqual(decls[0].triggers, [{ type: 'memory-sync', cron: false, once: true }]);
  assert.deepEqual(decls[0].artifacts, [{ id: 'out', type: 'file', title: 'Output' }]);
  // Absent on steps that don't declare them (never an empty-array surprise).
  assert.equal(decls[1].triggers, undefined);
  assert.equal(decls[1].artifacts, undefined);
});

test('buildStepDecls narrows non-array triggers/artifacts to undefined', () => {
  const [step] = buildStepDecls([{ id: 's1', goal: 'g', triggers: 'nope', artifacts: 5 }]);
  assert.equal(step.triggers, undefined);
  assert.equal(step.artifacts, undefined);
});

test('buildStepDecls preserves id/name/goal/depends/ai_instructions', () => {
  const decls = buildStepDecls([
    {
      id: 's1',
      name: 'First',
      goal: 'Open PR',
      ai_instructions: 'do the thing',
      depends: ['s0', 2],
    },
  ]);
  assert.equal(decls[0].id, 's1');
  assert.equal(decls[0].name, 'First');
  assert.equal(decls[0].goal, 'Open PR');
  assert.equal(decls[0].ai_instructions, 'do the thing');
  assert.deepEqual(decls[0].depends, ['s0', '2']);
});

test('buildStepDecls falls back goal→title and drops entries missing id/goal', () => {
  const decls = buildStepDecls([
    { id: 'ok', title: 'Legacy title' },
    { id: 'no-goal' },
    { goal: 'no-id' },
    null,
    'not-an-object',
  ]);
  assert.equal(decls.length, 1);
  assert.equal(decls[0].id, 'ok');
  assert.equal(decls[0].goal, 'Legacy title');
});

test('buildStepDecls narrows a non-boolean required to undefined', () => {
  const decls = buildStepDecls([
    { id: 's2', goal: 'PR2', required: 'yes' },
  ]);
  // required is only carried through when it is a real boolean.
  assert.equal(decls[0].required, undefined);
});

test('buildStepDecls throws on a present-but-malformed validation block (fail closed)', () => {
  assert.throws(
    () => buildStepDecls([{ id: 's1', goal: 'PR', validation: 'yes' }]),
    /validation.*must be an object|fail closed/i,
  );
});

test('buildStepDecls throws on a present-but-malformed execution block (fail closed)', () => {
  assert.throws(
    () => buildStepDecls([{ id: 's1', goal: 'PR', execution: ['array'] }]),
    /execution.*must be an object|fail closed/i,
  );
});

test('buildStepDecls normalizes a plain-object validation to the canonical gates shape', () => {
  const decls = buildStepDecls([{ id: 's1', goal: 'PR', validation: { mode: 'evidence' } }]);
  assert.deepEqual(decls[0].validation, { gates: [{ name: 'evidence', mode: 'evidence' }] });
});
