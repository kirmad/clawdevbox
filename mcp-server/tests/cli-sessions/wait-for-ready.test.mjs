import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForReady } from '../../src/cli-sessions/wait-for-ready.ts';

function fakeSession(snapshotsOverTime) {
  let i = 0;
  return {
    name: 'cdb_fake',
    pid: async () => 1,
    exited: new Promise(() => {}),
    sendText: async () => {},
    sendKey: async () => {},
    resize: async () => {},
    snapshot: async () => snapshotsOverTime[Math.min(i++, snapshotsOverTime.length - 1)],
    kill: async () => {},
  };
}

test('waitForReady resolves when promptReady + fullyRendered both match for stableMs', async () => {
  const s = fakeSession([
    '',                              // poll 0
    'splash text',                   // poll 1
    '❯',                             // poll 2: prompt drawn but not model line
    '❯ context (5%)',                // poll 3: both present — stableSince starts
    '❯ context (5%)',                // poll 4: still matching
    '❯ context (5%)',                // poll 5
    '❯ context (5%)',                // poll 6 — by now stableMs has elapsed
  ]);
  const result = await waitForReady(s, {
    promptReadyRegex: /❯/,
    fullyRenderedRegex: /context\s*\(\d+%\)/,
    pollIntervalMs: 50,
    stableMs: 100,
    timeoutMs: 5_000,
  });
  assert.equal(result, 'ready');
});

test('waitForReady rejects on timeout when nothing ever matches', async () => {
  const s = fakeSession(['nothing matches', 'still nothing']);
  await assert.rejects(
    waitForReady(s, {
      promptReadyRegex: /❯/,
      fullyRenderedRegex: /context/,
      pollIntervalMs: 50,
      stableMs: 100,
      timeoutMs: 300,
    }),
    /timed out/,
  );
});

test('waitForReady resets stable window when match breaks', async () => {
  const s = fakeSession([
    '❯ context (5%)',                // matches, stableSince starts
    'transitioning',                  // breaks match, stableSince resets
    '❯ context (5%)',                // matches again, stableSince restarts
    '❯ context (5%)',
    '❯ context (5%)',
    '❯ context (5%)',
  ]);
  const result = await waitForReady(s, {
    promptReadyRegex: /❯/,
    fullyRenderedRegex: /context/,
    pollIntervalMs: 50,
    stableMs: 100,
    timeoutMs: 5_000,
  });
  assert.equal(result, 'ready');
});

test('waitForReady ignores fullyRenderedRegex when not provided', async () => {
  const s = fakeSession([
    '',
    '❯',
    '❯',
    '❯',
    '❯',
  ]);
  const result = await waitForReady(s, {
    promptReadyRegex: /❯/,
    pollIntervalMs: 50,
    stableMs: 100,
    timeoutMs: 5_000,
  });
  assert.equal(result, 'ready');
});
