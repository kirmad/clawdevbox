import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerPending, getPending, resolvePending, resolvePendingTimeout, hasPending, _resetForTests,
} from '../src/pending-dispatch-registry.ts';

test('registerPending returns dispatchId + promise', () => {
  _resetForTests();
  const r = registerPending('inst-A', 'hello');
  assert.equal(typeof r.dispatchId, 'string');
  assert.ok(r.dispatchId.length > 0);
  assert.ok(r.promise instanceof Promise);
  resolvePendingTimeout('inst-A');
});

test('only one pending per instance — second register awaits the first', async () => {
  _resetForTests();
  const a = registerPending('inst-B', 'first');
  const b = registerPending('inst-B', 'second');
  assert.notEqual(a.promise, b.promise);
  // a is head and resolvable by its dispatchId; b is queued and NOT yet head.
  resolvePending('inst-B', a.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  const ra = await a.promise;
  assert.equal(ra.task_complete, true);
  // b still pending
  let bSettled = false;
  b.promise.then(() => { bSettled = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bSettled, false);
  // Now b should be the head and resolvable by b.dispatchId
  resolvePending('inst-B', b.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  const rb = await b.promise;
  assert.equal(rb.task_complete, true);
  assert.equal(hasPending('inst-B'), false);
});

test('resolvePending is a no-op for stale dispatchId', () => {
  _resetForTests();
  const a = registerPending('inst-C', 'x');
  resolvePending('inst-C', 'wrong-id', { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  assert.equal(hasPending('inst-C'), true);
  resolvePendingTimeout('inst-C');
});

test('resolvePending with matching id resolves and clears entry', async () => {
  _resetForTests();
  const a = registerPending('inst-D', 'x');
  resolvePending('inst-D', a.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  await a.promise;
  // Allow microtask for the cleanup .then() to run
  await new Promise((r) => setImmediate(r));
  assert.equal(hasPending('inst-D'), false);
});

test('getPending returns null when nothing in flight', () => {
  _resetForTests();
  assert.equal(getPending('inst-NONE'), null);
});

test('resolvePendingTimeout resolves with timeout status', async () => {
  _resetForTests();
  const a = registerPending('inst-E', 'x');
  resolvePendingTimeout('inst-E');
  const r = await a.promise;
  assert.equal(r.status, 'timeout');
});

test('needs_user_input alone is a valid resolution (not just task_complete)', async () => {
  _resetForTests();
  const a = registerPending('inst-F', 'x');
  resolvePending('inst-F', a.dispatchId, { task_complete: false, needs_user_input: true, doneAt: Date.now() });
  const r = await a.promise;
  assert.equal(r.needs_user_input, true);
  assert.equal(r.task_complete, false);
  assert.equal(r.status, 'ok');
});
