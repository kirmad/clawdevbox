import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRuntime,
  validateLocalTriggerTypeId,
  validateAgentAuthoredTemplate,
} from '../src/validators.ts';

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
