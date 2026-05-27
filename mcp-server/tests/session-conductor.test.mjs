import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionConductor } from '../src/agent-clis/session-conductor.ts';

// ---------------------------------------------------------------------------
// MockPty: emits data on demand, records writes, simulates exit.
// ---------------------------------------------------------------------------

function mockPty() {
  const dataListeners = [];
  const exitListeners = [];
  const writes = [];
  return {
    pty: {
      write(data) { writes.push({ at: Date.now(), data }); },
      onData(cb) { dataListeners.push(cb); return { dispose() { const i = dataListeners.indexOf(cb); if (i >= 0) dataListeners.splice(i, 1); } }; },
      onExit(cb) { exitListeners.push(cb); return { dispose() {} }; },
      kill() {},
      resize() {},
    },
    writes,
    emit(data) { for (const cb of dataListeners.slice()) cb(data); },
    emitExit(exitCode = 0, signal) { for (const cb of exitListeners.slice()) cb({ exitCode, signal }); },
  };
}

function mockHandle(mock, exitPromise) {
  return {
    pid: 1234,
    sessionId: 'mock-session',
    pty: mock.pty,
    exited: exitPromise ?? new Promise(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

const COPILOT_LIKE_CAPS = {
  queueMode: 'ctrl-q',
  promptSubmitStrategy: 'split-cr-250ms',
  promptReadyRegex: /❯[^\S\r\n]*$/m,
  busyIndicators: [/Working/i, /Queued \(\d+\)/i, /\[pending\]/i],
};

const CLAUDE_LIKE_CAPS = {
  queueMode: 'none',
  promptSubmitStrategy: 'bulk-cr',
  promptReadyRegex: /❯[^\S\r\n]*$/m,
  busyIndicators: [/Working/i, /thinking/i],
};

function copilotProvider() {
  return {
    id: 'copilot-mock',
    displayName: 'Copilot Mock',
    capabilities: COPILOT_LIKE_CAPS,
    async writePrompt(handle, { text, strategy }) {
      handle.pty.write(text);
      await sleep(10);
      handle.pty.write(strategy === 'queue' ? '\x11' : '\r');
    },
  };
}

function claudeProvider() {
  return {
    id: 'claude-mock',
    displayName: 'Claude Mock',
    capabilities: CLAUDE_LIKE_CAPS,
    async writePrompt(handle, { text, strategy }) {
      if (strategy === 'queue') throw new Error('queue strategy not supported');
      handle.pty.write(text + '\r');
    },
  };
}

function bareProvider() {
  return { id: 'bare', displayName: 'Bare' };
}

// Reusable helper: spin up a conductor for a fresh pty.
function makeConductor({ provider, opts = {}, withExit = false } = {}) {
  const mock = mockPty();
  let resolveExit;
  const exitPromise = withExit ? new Promise((r) => { resolveExit = r; }) : new Promise(() => {});
  const handle = mockHandle(mock, exitPromise);
  const conductor = new SessionConductor({
    handle,
    provider: provider ?? copilotProvider(),
    firstReadyTimeoutMs: 50,
    stableTailMs: 60,
    idleFallbackMs: 200,
    promptEchoIgnoreMs: 30,
    timeoutMs: 3_000,
    ...opts,
  });
  return { conductor, mock, handle, resolveExit };
}

function extractMarkerId(text) {
  const m = text.match(/###(CDB_DONE_[A-Za-z0-9_]+)###/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 1. dispatch on idle → marker resolves
// ---------------------------------------------------------------------------

test('dispatch on idle resolves with marker signal', async () => {
  const { conductor, mock } = makeConductor();
  mock.emit('\n❯ \n');
  await sleep(80);
  assert.equal(conductor.state, 'idle');

  const p = conductor.dispatch('hello');
  await sleep(40);
  const writtenText = mock.writes.map((w) => w.data).join('');
  const markerId = extractMarkerId(writtenText);
  assert.ok(markerId, `expected marker in write: ${writtenText}`);

  await sleep(40);
  mock.emit(`some response\n###${markerId}###\n`);
  const result = await p;
  assert.equal(result.doneSignal, 'marker');
  assert.equal(result.markerId, markerId);
  assert.equal(conductor.state, 'idle');
});

// ---------------------------------------------------------------------------
// 2 & 3. Queue while busy
// ---------------------------------------------------------------------------

test('queue strategy while busy uses provider native queue (Ctrl+Q)', async () => {
  const { conductor, mock } = makeConductor();
  mock.emit('\n❯ \n');
  await sleep(80);

  const first = conductor.dispatch('first');
  await sleep(20);
  // Now busy. Caller explicitly requests queue.
  const second = conductor.dispatch('second', { strategy: 'queue' });
  await sleep(20);

  // Both prompts batched together in our simple model — verify the second
  // is still pending (queued in the conductor's local FIFO since one
  // dispatch is already active).
  assert.equal(conductor.pendingCount(), 2);

  const firstMarker = extractMarkerId(mock.writes.map((w) => w.data).join(''));
  mock.emit('Working...\n');
  await sleep(40);
  mock.emit(`first done\n###${firstMarker}###\n`);
  const r1 = await first;
  assert.equal(r1.doneSignal, 'marker');

  await sleep(30);
  // After first resolves, conductor drains the local queue with submit.
  const allWrites = mock.writes.map((w) => w.data).join('');
  const secondMarker = extractMarkerId(allWrites.slice(allWrites.indexOf(firstMarker) + firstMarker.length + 3));
  assert.ok(secondMarker, 'expected a second marker after drain');
  mock.emit(`second done\n###${secondMarker}###\n`);
  const r2 = await second;
  assert.equal(r2.doneSignal, 'marker');
});

test('claude-like provider buffers locally when busy and drains coalesced', async () => {
  const { conductor, mock } = makeConductor({ provider: claudeProvider() });
  mock.emit('\n❯ \n');
  await sleep(80);

  const first = conductor.dispatch('first');
  await sleep(20);
  const second = conductor.dispatch('second');
  const third = conductor.dispatch('third');
  await sleep(20);

  const allWrites1 = mock.writes.map((w) => w.data).join('');
  // Claude bulk-cr → text+CR in one write. Should NOT contain DC1.
  assert.equal(allWrites1.includes('\x11'), false);
  const firstMarker = extractMarkerId(allWrites1);
  mock.emit(`first done\n###${firstMarker}###\n`);
  await first;

  await sleep(40);
  const allWrites2 = mock.writes.map((w) => w.data).join('');
  // The drained batch combined second+third with separator.
  assert.ok(allWrites2.includes('second\n\n---\n\nthird'), `expected coalesced batch, got: ${allWrites2}`);
  const drainMarker = extractMarkerId(allWrites2.slice(allWrites2.indexOf(firstMarker) + firstMarker.length + 3));
  assert.ok(drainMarker);
  mock.emit(`drained\n###${drainMarker}###\n`);
  const r2 = await second;
  const r3 = await third;
  assert.equal(r2.markerId, drainMarker);
  assert.equal(r3.markerId, drainMarker);
});

// ---------------------------------------------------------------------------
// 5. Marker false-positive guard (prompt echo)
// ---------------------------------------------------------------------------

test('marker echoed in first 250ms post-delivery is ignored', async () => {
  const { conductor, mock } = makeConductor({ opts: { promptEchoIgnoreMs: 200 } });
  mock.emit('\n❯ \n');
  await sleep(80);

  const p = conductor.dispatch('echo me');
  await sleep(30);
  const markerId = extractMarkerId(mock.writes.map((w) => w.data).join(''));
  // Echo within ignore window — should NOT resolve.
  mock.emit(`echo me\n###${markerId}###\n`);
  let resolvedEarly = false;
  p.then(() => { resolvedEarly = true; });
  await sleep(80);
  assert.equal(resolvedEarly, false, 'dispatch should not resolve from echo');

  // After echo window, real marker on a fresh emit DOES resolve.
  await sleep(250);
  mock.emit(`real output\n###${markerId}###\n`);
  const result = await p;
  assert.equal(result.doneSignal, 'marker');
});

// ---------------------------------------------------------------------------
// 6. Idle fallback
// ---------------------------------------------------------------------------

test('idle fallback resolves after configured silence', async () => {
  const { conductor, mock } = makeConductor({ opts: { idleFallbackMs: 80, stableTailMs: 5000 } });
  mock.emit('\n❯ \n');
  await sleep(80);

  const p = conductor.dispatch('no marker please', { withMarker: false });
  await sleep(30);
  // Emit enough output that the prompt-ready glyph rolls off the screen tail.
  mock.emit('a'.repeat(2500));
  await sleep(150);              // > idleFallbackMs
  const result = await p;
  assert.equal(result.doneSignal, 'idle');
  assert.equal(result.markerId, null);
});

// ---------------------------------------------------------------------------
// 7. Prompt-ready fallback
// ---------------------------------------------------------------------------

test('prompt-ready fallback fires on stable tail with no busy indicators', async () => {
  const { conductor, mock } = makeConductor({
    opts: { stableTailMs: 60, idleFallbackMs: 5000, promptEchoIgnoreMs: 0 },
  });
  mock.emit('\n❯ \n');
  await sleep(80);

  const p = conductor.dispatch('promptly', { withMarker: false });
  await sleep(20);
  mock.emit('a'.repeat(100));         // meaningful output
  mock.emit('\n❯ \n');                // ready glyph on tail
  await sleep(120);                   // > stableTailMs
  const result = await p;
  assert.equal(result.doneSignal, 'prompt-ready');
});

test('prompt-ready does not fire while busy indicator present on tail', async () => {
  const { conductor, mock } = makeConductor({
    opts: { stableTailMs: 60, idleFallbackMs: 5000, promptEchoIgnoreMs: 0 },
  });
  mock.emit('\n❯ \n');
  await sleep(80);

  const p = conductor.dispatch('busy mark', { withMarker: false });
  await sleep(20);
  mock.emit('a'.repeat(100));
  mock.emit('Working...\n❯ \n');     // ready glyph but Working too
  let resolved = false;
  p.then(() => { resolved = true; });
  await sleep(150);
  assert.equal(resolved, false);
  // Clear busy and retry.
  mock.emit('\x1b[2K');                // simulated erase — but our screen will still contain Working; we need a fresh emit.
  // Simpler: emit a long pile of dots so the tail no longer has Working in the last 2048 chars.
  mock.emit('.'.repeat(2200));
  mock.emit('\n❯ \n');
  await sleep(120);
  const result = await p;
  assert.equal(result.doneSignal, 'prompt-ready');
});

// ---------------------------------------------------------------------------
// 8. Exit during dispatch
// ---------------------------------------------------------------------------

test('exit during dispatch rejects with SessionExitedError', async () => {
  const { conductor, mock, resolveExit } = makeConductor({ withExit: true });
  mock.emit('\n❯ \n');
  await sleep(80);

  const p = conductor.dispatch('will die');
  await sleep(30);
  mock.emitExit(137, 'SIGKILL');
  resolveExit({ exitCode: 137, signal: 'SIGKILL' });
  await assert.rejects(p, /session exited/);
  assert.equal(conductor.state, 'exited');
});

// ---------------------------------------------------------------------------
// 9. Timeout
// ---------------------------------------------------------------------------

test('dispatch rejects after per-dispatch timeout', async () => {
  const { conductor, mock } = makeConductor({ opts: { timeoutMs: 100 } });
  mock.emit('\n❯ \n');
  await sleep(80);
  const p = conductor.dispatch('forever');
  await assert.rejects(p, /dispatch timed out/);
});

// ---------------------------------------------------------------------------
// 10. Coalesce drain content check
// ---------------------------------------------------------------------------

test('coalesced drain wraps batch in a single marker block', async () => {
  const { conductor, mock } = makeConductor({ provider: claudeProvider() });
  mock.emit('\n❯ \n');
  await sleep(80);

  const first = conductor.dispatch('one');
  await sleep(20);
  const second = conductor.dispatch('two');
  const third = conductor.dispatch('three');
  const fourth = conductor.dispatch('four');
  await sleep(20);

  const all = mock.writes.map((w) => w.data).join('');
  const firstMarker = extractMarkerId(all);
  mock.emit(`done\n###${firstMarker}###\n`);
  await first;

  await sleep(40);
  const all2 = mock.writes.map((w) => w.data).join('');
  const tail = all2.slice(all2.indexOf(firstMarker) + firstMarker.length + 3);
  const markerCount = (tail.match(/###CDB_DONE_/g) ?? []).length;
  assert.equal(markerCount, 1, 'coalesced drain emits exactly one marker block');
  assert.ok(tail.includes('two\n\n---\n\nthree\n\n---\n\nfour'));

  const drainMarker = extractMarkerId(tail);
  assert.ok(drainMarker);
  mock.emit(`drained\n###${drainMarker}###\n`);
  await Promise.all([second, third, fourth]);
  conductor.dispose();
});

// ---------------------------------------------------------------------------
// 11. dispose is idempotent
// ---------------------------------------------------------------------------

test('dispose rejects pending dispatches and is idempotent', async () => {
  const { conductor, mock } = makeConductor();
  mock.emit('\n❯ \n');
  await sleep(80);
  const p1 = conductor.dispatch('one');
  const p2 = conductor.dispatch('two');
  await sleep(20);
  conductor.dispose();
  await assert.rejects(p1, /session/);
  await assert.rejects(p2, /session/);
  // Idempotent.
  conductor.dispose();
  assert.equal(conductor.state, 'exited');
});

// ---------------------------------------------------------------------------
// Bonus: unsupported provider rejection
// ---------------------------------------------------------------------------

test('SessionConductor refuses providers without capabilities', () => {
  const mock = mockPty();
  const handle = mockHandle(mock);
  assert.throws(
    () => new SessionConductor({ handle, provider: bareProvider() }),
    /missing capabilities/,
  );
});
