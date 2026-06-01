import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  registerPending, getPending, resolvePending, _resetForTests,
} from '../src/pending-dispatch-registry.ts';
import { tmuxSessionRegistry } from '../src/cli-sessions/tmux-session-runtime.ts';

// The dispatcher logic under test is small enough to inline-validate via a
// fake CliSession injected into tmuxSessionRegistry. Full dispatcher class
// invocation requires DB + workspace plumbing that's out of scope here —
// the integration is covered by tests/dispatcher.test.mjs once the rest of
// the wiring lands in T13+.

function fakeSession(name = 'cdb_fake') {
  const calls = [];
  return {
    name,
    pid: async () => 1234,
    exited: new Promise(() => {}),
    sendText: async (t) => { calls.push(['sendText', t]); },
    sendKey: async (k) => { calls.push(['sendKey', k]); },
    resize: async () => {},
    snapshot: async () => '',
    kill: async () => {},
    calls,
  };
}

// Pulled out so both tests share the same orchestration as the production
// dispatcher.dispatchToInstance impl (Escape → gap → text → gap → Enter,
// registerPending before sends, background race against timeout).
async function dispatchToInstance(instanceId, prompt, { timeoutMs = 60_000 } = {}) {
  const session = tmuxSessionRegistry.get(instanceId);
  if (!session) return { status: 'target_unavailable' };
  const { dispatchId, promise } = registerPending(instanceId, prompt);
  await session.sendKey('Escape');
  await sleep(20);
  await session.sendText(prompt);
  await sleep(20);
  await session.sendKey('Enter');
  // Background race kept implicit: test resolves directly.
  return { status: 'ok', state: 'dispatched', dispatchId, promise, timeoutMs };
}

test('dispatch sends Escape + text + Enter and registers a pending dispatch', async () => {
  _resetForTests();
  tmuxSessionRegistry.__resetForTests();
  const sess = fakeSession();
  tmuxSessionRegistry.__register('inst-X', sess);

  const res = await dispatchToInstance('inst-X', 'HELLO');
  assert.equal(res.status, 'ok');
  assert.deepEqual(sess.calls, [
    ['sendKey', 'Escape'],
    ['sendText', 'HELLO'],
    ['sendKey', 'Enter'],
  ]);
  // pending-dispatch entry exists
  const pending = getPending('inst-X');
  assert.ok(pending, 'pending entry must be registered');
  assert.equal(pending.dispatchId, res.dispatchId);

  // simulate update_status arriving
  resolvePending('inst-X', res.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  const settled = await res.promise;
  assert.equal(settled.task_complete, true);
});

test('dispatch to unregistered instance returns target_unavailable', async () => {
  _resetForTests();
  tmuxSessionRegistry.__resetForTests();
  const res = await dispatchToInstance('inst-NONE', 'HELLO');
  assert.equal(res.status, 'target_unavailable');
});

test('second dispatch to same instance queues behind first (FIFO via pending-dispatch)', async () => {
  _resetForTests();
  tmuxSessionRegistry.__resetForTests();
  const sess = fakeSession();
  tmuxSessionRegistry.__register('inst-Y', sess);

  const r1 = await dispatchToInstance('inst-Y', 'FIRST');
  const r2 = await dispatchToInstance('inst-Y', 'SECOND');
  // Both prompts have been written to the session (dispatcher fires the
  // bytes immediately; pending-dispatch serializes the *completion* signal).
  assert.deepEqual(sess.calls, [
    ['sendKey', 'Escape'], ['sendText', 'FIRST'], ['sendKey', 'Enter'],
    ['sendKey', 'Escape'], ['sendText', 'SECOND'], ['sendKey', 'Enter'],
  ]);

  // r2.promise must NOT settle until r1.promise settles
  let r2Settled = false;
  r2.promise.then(() => { r2Settled = true; });
  resolvePending('inst-Y', r1.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  await r1.promise;
  // give microtasks a chance
  await sleep(20);
  assert.equal(r2Settled, false, 'r2 must still be pending after r1 resolves');
  // Now resolve r2
  resolvePending('inst-Y', r2.dispatchId, { task_complete: true, needs_user_input: false, doneAt: Date.now() });
  await r2.promise;
  assert.equal(r2Settled, true);
});
