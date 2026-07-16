import test from 'node:test';
import assert from 'node:assert/strict';
import { withVaultLock, _resetVaultLocks } from '../src/tools/memory-vault-lock.ts';

test('withVaultLock serializes calls on the same vault', async () => {
  _resetVaultLocks();
  const events = [];
  const tasks = [0, 1, 2].map((i) =>
    withVaultLock('v1', async () => {
      events.push(`start-${i}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end-${i}`);
      return i;
    })
  );
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2]);
  assert.deepEqual(events, ['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
});

test('withVaultLock allows concurrent calls on different vaults', async () => {
  _resetVaultLocks();
  const events = [];
  const tasks = [
    withVaultLock('v1', async () => {
      events.push('v1-start');
      await new Promise((r) => setTimeout(r, 30));
      events.push('v1-end');
    }),
    withVaultLock('v2', async () => {
      events.push('v2-start');
      await new Promise((r) => setTimeout(r, 10));
      events.push('v2-end');
    }),
  ];
  await Promise.all(tasks);
  assert.equal(events[0], 'v1-start');
  assert.equal(events[1], 'v2-start');
  assert.equal(events[2], 'v2-end');
  assert.equal(events[3], 'v1-end');
});

test('withVaultLock releases on error', async () => {
  _resetVaultLocks();
  await assert.rejects(
    withVaultLock('v3', async () => { throw new Error('boom'); }),
    /boom/,
  );
  const result = await withVaultLock('v3', async () => 'ok');
  assert.equal(result, 'ok');
});

test('withVaultLock returns typed value', async () => {
  _resetVaultLocks();
  const result = await withVaultLock('v4', async () => ({ x: 42 }));
  assert.equal(result.x, 42);
});
