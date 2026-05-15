import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import {
  validateRuntime,
  validateLocalTriggerTypeId,
  validateAgentAuthoredTemplate,
  validateRecipeParsed,
  validateRecipeSource,
  parseRecipeSource,
  validatePluginAgentCliEntry,
  validatePluginManifest,
} from '../src/validators.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('validateRuntime accepts the four allowed values', () => {
  for (const r of ['node', 'tsx', 'python', 'bash']) {
    const res = validateRuntime(r);
    assert.equal(res.ok, true, `${r} should be ok`);
    if (res.ok) assert.equal(res.runtime, r);
  }
});

test('validateRuntime rejects unknown values', () => {
  const res = validateRuntime('go');
  assert.equal(res.ok, false);
});

test('validateLocalTriggerTypeId requires local. prefix', () => {
  assert.equal(validateLocalTriggerTypeId('local.my-trigger').ok, true);
  assert.equal(validateLocalTriggerTypeId('local.my.nested-trigger').ok, true);
  assert.equal(validateLocalTriggerTypeId('ado.new-pr-watcher').ok, false);
  assert.equal(validateLocalTriggerTypeId('My-Trigger').ok, false);
  assert.equal(validateLocalTriggerTypeId('local.').ok, false);
});

test('validateAgentAuthoredTemplate happy path', () => {
  const res = validateAgentAuthoredTemplate({
    id: 'local.my-trigger',
    file: 'trigger.ts',
    runtime: 'tsx',
    description: 'A test trigger.',
    parameters: [{ name: 'repo', type: 'string', required: true }],
  });
  assert.equal(res.ok, true);
});

test('validateAgentAuthoredTemplate rejects missing runtime', () => {
  const res = validateAgentAuthoredTemplate({
    id: 'local.my-trigger',
    file: 'trigger.ts',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path === 'runtime'));
  }
});

test('validateAgentAuthoredTemplate rejects non-local id', () => {
  const res = validateAgentAuthoredTemplate({
    id: 'ado.new-pr-watcher',
    file: 'trigger.ts',
    runtime: 'tsx',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path === 'id'));
  }
});



// =========================================================================
// Step schema (Phase 2.1) + JSON-or-YAML source sniff (Phase 2.2)
// =========================================================================

const baseRecipe = {
  id: 'r',
  name: 'R',
  description: 'd',
};

function withSteps(steps) {
  return { ...baseRecipe, steps };
}

test('validateRecipeParsed coerces integer step ids to strings (mutates input)', () => {
  const recipe = withSteps([
    { id: 1, goal: 'one' },
    { id: 2, goal: 'two', depends: [1] },
  ]);
  const res = validateRecipeParsed(recipe);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.errors));
  assert.equal(recipe.steps[0].id, '1');
  assert.equal(recipe.steps[1].id, '2');
  assert.deepEqual(recipe.steps[1].depends, ['1']);
});

test('validateRecipeParsed coerces integer depends to strings', () => {
  const recipe = withSteps([
    { id: 'a', goal: 'A' },
    { id: 2, goal: 'B', depends: ['a', 1] }, // mixed, and 1 refers to no one
  ]);
  // depends references id "1" which is not declared (only 'a' and '2')
  const res = validateRecipeParsed(recipe);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.code === 'UNRESOLVED_REF'));
  }
});

test('validateRecipeSource accepts the legacy pr-review.yaml sample and coerces ids/depends', () => {
  const sample = readFileSync(
    resolve(__dirname, '..', '..', 'samples', 'plugins', 'ado', 'recipes', 'pr-review.yaml'),
    'utf8',
  );
  const parsed = yamlLoad(sample);
  const res = validateRecipeParsed(parsed);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.errors));
  // every step.id must now be a string; every depends entry must be a string
  for (const step of parsed.steps) {
    assert.equal(typeof step.id, 'string', `step ${JSON.stringify(step)} id should be string`);
    if (step.depends) {
      for (const d of step.depends) {
        assert.equal(typeof d, 'string', `dep ${d} should be string`);
      }
    }
  }
});

test('step.name length bounds — empty rejected, >200 rejected, valid accepted', () => {
  const valid = withSteps([{ id: 'a', name: 'A nice step', goal: 'g' }]);
  assert.equal(validateRecipeParsed(valid).ok, true);

  const empty = withSteps([{ id: 'a', name: '', goal: 'g' }]);
  const r1 = validateRecipeParsed(empty);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.ok(r1.errors.some((e) => e.path === 'steps[0].name'));

  const longName = 'x'.repeat(201);
  const tooLong = withSteps([{ id: 'a', name: longName, goal: 'g' }]);
  const r2 = validateRecipeParsed(tooLong);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok(r2.errors.some((e) => e.path === 'steps[0].name'));
});

test('step.params accepts whitelisted types and rejects unknown types', () => {
  const valid = withSteps([
    {
      id: 'a',
      goal: 'g',
      params: [
        { name: 'repo', type: 'string', required: true, description: 'repo name' },
        { name: 'n', type: 'integer' },
      ],
    },
  ]);
  assert.equal(validateRecipeParsed(valid).ok, true);

  const bad = withSteps([
    { id: 'a', goal: 'g', params: [{ name: 'x', type: 'datetime' }] },
  ]);
  const r = validateRecipeParsed(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path === 'steps[0].params[0].type'));
});

test('step.params.name pattern enforced', () => {
  const bad = withSteps([
    { id: 'a', goal: 'g', params: [{ name: '1bad', type: 'string' }] },
  ]);
  const r = validateRecipeParsed(bad);
  assert.equal(r.ok, false);
});

test('step.triggers requires non-empty type', () => {
  const valid = withSteps([
    { id: 'a', goal: 'g', triggers: [{ type: 'ado.comment-watcher', params: { repo: 'r' } }] },
  ]);
  assert.equal(validateRecipeParsed(valid).ok, true);

  const bad = withSteps([{ id: 'a', goal: 'g', triggers: [{ params: {} }] }]);
  const r = validateRecipeParsed(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path === 'steps[0].triggers[0].type'));
});

test('step.triggers accepts the full optional field set', () => {
  const valid = withSteps([
    {
      id: 'a',
      goal: 'g',
      triggers: [
        {
          type: 'ado.comment-watcher',
          params: { repo: 'r' },
          cron: '*/30 * * * * *',
          binds_callback_to: 'agent_session_resume',
          binds_callback_to_recipe: 'respond-to-pr-comment',
          once: false,
          expires_at: 1234567890,
          max_attempts: 5,
          backoff_ms: [1000, 5000],
        },
      ],
    },
  ]);
  const r = validateRecipeParsed(valid);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.errors));
});

test('step.triggers rejects bad binds_callback_to / max_attempts / cron', () => {
  const bad = withSteps([
    {
      id: 'a',
      goal: 'g',
      triggers: [
        {
          type: 't',
          binds_callback_to: 'bogus',
          max_attempts: 0,
          cron: 42,
        },
      ],
    },
  ]);
  const r = validateRecipeParsed(bad);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.path === 'steps[0].triggers[0].binds_callback_to'));
    assert.ok(r.errors.some((e) => e.path === 'steps[0].triggers[0].max_attempts'));
    assert.ok(r.errors.some((e) => e.path === 'steps[0].triggers[0].cron'));
  }
});

test('step.artifacts.id pattern enforced', () => {
  const valid = withSteps([
    { id: 'a', goal: 'g', artifacts: [{ id: 'pr-summary', type: 'pr-walkthrough', title: 'PR' }] },
  ]);
  assert.equal(validateRecipeParsed(valid).ok, true);

  const bad = withSteps([
    { id: 'a', goal: 'g', artifacts: [{ id: 'BAD/ID', type: 't' }] },
  ]);
  const r = validateRecipeParsed(bad);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path === 'steps[0].artifacts[0].id'));
});

test('parseRecipeSource parses YAML', () => {
  const parsed = parseRecipeSource('id: foo\nname: Foo\n');
  assert.deepEqual(parsed, { id: 'foo', name: 'Foo' });
});

test('parseRecipeSource parses JSON object (leading {)', () => {
  const parsed = parseRecipeSource('{"id":"foo","steps":[]}');
  assert.deepEqual(parsed, { id: 'foo', steps: [] });
});

test('parseRecipeSource parses JSON array (leading [)', () => {
  const parsed = parseRecipeSource('[1,2,3]');
  assert.deepEqual(parsed, [1, 2, 3]);
});

test('parseRecipeSource ignores leading whitespace before sniff', () => {
  const parsed = parseRecipeSource('   \n\t  {"id":"x"}');
  assert.deepEqual(parsed, { id: 'x' });

  const parsedYaml = parseRecipeSource('   \nid: y\n');
  assert.deepEqual(parsedYaml, { id: 'y' });
});

test('parseRecipeSource throws on malformed JSON when leading char is {', () => {
  assert.throws(() => parseRecipeSource('{not json'));
});

test('parseRecipeSource throws on malformed YAML', () => {
  assert.throws(() => parseRecipeSource('id: "unterminated\nname: x'));
});

test('validateRecipeSource accepts JSON source via the sniff', () => {
  const json = JSON.stringify({
    id: 'foo',
    name: 'Foo',
    description: 'd',
    steps: [{ id: 's1', goal: 'go' }],
  });
  const res = validateRecipeSource(json);
  assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.errors));
});


import { validateMaxAttempts, validateBackoffMs } from '../src/validators.ts';

test('validateMaxAttempts accepts positive integers up to 100', () => {
  for (const v of [1, 3, 50, 100]) {
    const r = validateMaxAttempts(v);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, v);
  }
});

test('validateMaxAttempts rejects zero negatives non-integers and over 100', () => {
  for (const v of [0, -1, 1.5, 101, 'three', null, [], {}]) {
    const r = validateMaxAttempts(v);
    assert.equal(r.ok, false);
  }
});

test('validateBackoffMs accepts non-empty integer arrays in range', () => {
  const r = validateBackoffMs([0, 30000, 86400000]);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, [0, 30000, 86400000]);
});

test('validateBackoffMs rejects empty non-array negative non-integer and out-of-range', () => {
  for (const v of [[], 'no', [1, -1], [1.5], [86400001], null]) {
    const r = validateBackoffMs(v);
    assert.equal(r.ok, false);
  }
});

// ============================================================================
// validatePluginAgentCliEntry — provides.agent_clis[] (spec §4)
// ============================================================================

test('validatePluginAgentCliEntry accepts a valid entry', () => {
  const errs = validatePluginAgentCliEntry(
    { id: 'agency', module: 'scripts/agency-provider.js', display_name: 'Agency', description: 'desc' },
    0,
  );
  assert.deepEqual(errs, []);
});

test('validatePluginAgentCliEntry rejects missing id', () => {
  const errs = validatePluginAgentCliEntry({ module: 'a.js' }, 0);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0].id' && e.code === 'INVALID_VALUE'));
});

test('validatePluginAgentCliEntry rejects bad id pattern', () => {
  const errs = validatePluginAgentCliEntry({ id: 'has space!', module: 'a.js' }, 1);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[1].id' && e.code === 'INVALID_VALUE'));
});

test('validatePluginAgentCliEntry rejects missing module', () => {
  const errs = validatePluginAgentCliEntry({ id: 'ok' }, 2);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[2].module' && e.code === 'REQUIRED'));
});

test('validatePluginAgentCliEntry rejects path traversal in module', () => {
  const errs = validatePluginAgentCliEntry({ id: 'ok', module: '../foo.js' }, 0);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0].module' && e.code === 'INVALID_VALUE'));
});

test('validatePluginAgentCliEntry rejects nested path traversal in module', () => {
  const errs = validatePluginAgentCliEntry({ id: 'ok', module: 'a/../../b.js' }, 0);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0].module' && e.code === 'INVALID_VALUE'));
});

test('validatePluginAgentCliEntry rejects absolute Unix path', () => {
  const errs = validatePluginAgentCliEntry({ id: 'ok', module: '/etc/evil.js' }, 0);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0].module' && e.code === 'INVALID_VALUE'));
});

test('validatePluginAgentCliEntry rejects absolute Windows drive path', () => {
  const errs = validatePluginAgentCliEntry({ id: 'ok', module: 'C:/evil.js' }, 0);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0].module' && e.code === 'INVALID_VALUE'));
});

test('validatePluginAgentCliEntry rejects bad display_name type', () => {
  const errs = validatePluginAgentCliEntry(
    { id: 'ok', module: 'a.js', display_name: 42 },
    0,
  );
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0].display_name' && e.code === 'TYPE'));
});

test('validatePluginAgentCliEntry rejects non-object entry', () => {
  const errs = validatePluginAgentCliEntry('not-an-object', 0);
  assert.ok(errs.some((e) => e.path === 'provides.agent_clis[0]' && e.code === 'TYPE'));
});

test('validatePluginManifest integrates provides.agent_clis validation', () => {
  const r = validatePluginManifest({
    id: 'p',
    name: 'P',
    version: '0.1.0',
    description: 'd',
    provides: {
      agent_clis: [
        { id: 'good', module: 'a.js' },
        { id: 'bad space', module: '../escape.js' },
      ],
    },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.path === 'provides.agent_clis[1].id'));
    assert.ok(r.errors.some((e) => e.path === 'provides.agent_clis[1].module'));
  }
});

test('validatePluginManifest rejects non-array provides.agent_clis', () => {
  const r = validatePluginManifest({
    id: 'p', name: 'P', version: '0.1.0', description: 'd',
    provides: { agent_clis: 'nope' },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.path === 'provides.agent_clis' && e.code === 'TYPE'));
  }
});

test('validatePluginManifest detects duplicate agent_clis ids within a plugin', () => {
  const r = validatePluginManifest({
    id: 'p', name: 'P', version: '0.1.0', description: 'd',
    provides: {
      agent_clis: [
        { id: 'dup', module: 'a.js' },
        { id: 'dup', module: 'b.js' },
      ],
    },
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.errors.some((e) => e.path === 'provides.agent_clis[1].id' && e.code === 'DUPLICATE'));
  }
});