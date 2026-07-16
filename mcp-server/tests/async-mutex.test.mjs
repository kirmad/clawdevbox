import test from 'node:test';
import assert from 'node:assert/strict';
import { withKeyedLock, _internalQueueSize } from '../src/async-mutex.ts';

test('async-mutex: serializes same-key concurrent calls', async () => {
  const order = [];
  const tasks = [];
  for (let i = 0; i < 5; i++) {
    tasks.push(withKeyedLock('K1', async () => {
      order.push(`enter-${i}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`exit-${i}`);
      return i;
    }));
  }
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  for (let i = 0; i < 5; i++) {
    assert.equal(order[2 * i], `enter-${i}`);
    assert.equal(order[2 * i + 1], `exit-${i}`);
  }
});

test('async-mutex: different keys run concurrently', async () => {
  let aRunning = false;
  let bRunning = false;
  let overlap = false;
  await Promise.all([
    withKeyedLock('A', async () => {
      aRunning = true;
      await new Promise((r) => setTimeout(r, 30));
      if (bRunning) overlap = true;
      aRunning = false;
    }),
    withKeyedLock('B', async () => {
      bRunning = true;
      await new Promise((r) => setTimeout(r, 30));
      if (aRunning) overlap = true;
      bRunning = false;
    }),
  ]);
  assert.equal(overlap, true);
});

test('async-mutex: releases lock when fn throws', async () => {
  await assert.rejects(
    withKeyedLock('K2', async () => { throw new Error('boom'); }),
    /boom/,
  );
  const result = await withKeyedLock('K2', async () => 'ok');
  assert.equal(result, 'ok');
});

test('async-mutex: prunes empty queues', async () => {
  await withKeyedLock('PRUNE_KEY', async () => 'a');
  await withKeyedLock('PRUNE_KEY', async () => 'b');
  assert.equal(_internalQueueSize('PRUNE_KEY'), 0);
});
