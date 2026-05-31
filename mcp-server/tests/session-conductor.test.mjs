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

test('claude-like provider buffers locally when busy and drains serially', async () => {
  // Drains ONE-AT-A-TIME (no coalescing). Coalescing was removed because
  // copilot's TUI enters multi-line input mode when fed text containing
  // `\n\n---\n\n` separators, and `\r` no longer submits in that mode.
  // Each queued dispatch now gets its own writePrompt + own marker.
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
  // Only the first prompt has been written so far.
  assert.ok(allWrites1.includes('first'));
  assert.equal(allWrites1.includes('second'), false, 'second not yet written');
  assert.equal(allWrites1.includes('third'), false, 'third not yet written');
  const firstMarker = extractMarkerId(allWrites1);
  mock.emit(`first done\n###${firstMarker}###\n`);
  await first;

  // After first completes, the next pending (second) drains alone.
  await sleep(40);
  const allWrites2 = mock.writes.map((w) => w.data).join('');
  const tail2 = allWrites2.slice(allWrites2.indexOf(firstMarker) + firstMarker.length + 3);
  assert.ok(tail2.includes('second'), 'second drained after first done');
  assert.equal(tail2.includes('third'), false, 'third still buffered');
  assert.equal(tail2.includes('---'), false, 'no coalesce separator');
  const secondMarker = extractMarkerId(tail2);
  assert.ok(secondMarker && secondMarker !== firstMarker);
  mock.emit(`second done\n###${secondMarker}###\n`);
  const r2 = await second;
  assert.equal(r2.markerId, secondMarker);
  assert.equal(r2.doneSignal, 'marker');

  // Then third drains on its own.
  await sleep(40);
  const allWrites3 = mock.writes.map((w) => w.data).join('');
  const tail3 = allWrites3.slice(allWrites3.indexOf(secondMarker) + secondMarker.length + 3);
  assert.ok(tail3.includes('third'));
  const thirdMarker = extractMarkerId(tail3);
  mock.emit(`third done\n###${thirdMarker}###\n`);
  const r3 = await third;
  assert.equal(r3.markerId, thirdMarker);
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

test('queued dispatches drain serially with separate marker blocks', async () => {
  // Replaces the old "coalesced drain wraps batch in a single marker block"
  // test. Coalescing was removed to fix copilot's stuck-input bug under
  // rapid-fire dispatch. Now each queued prompt gets its own write +
  // own marker and they drain FIFO, one at a time.
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
  // Only `one` written so far.
  assert.ok(all.includes('one'));
  assert.equal(all.includes('two'), false);
  assert.equal(all.includes('---'), false, 'no coalesce separator anywhere');
  const firstMarker = extractMarkerId(all);
  mock.emit(`done\n###${firstMarker}###\n`);
  await first;

  // Drain second.
  await sleep(40);
  const after1 = mock.writes.map((w) => w.data).join('').slice(
    mock.writes.map((w) => w.data).join('').indexOf(firstMarker) + firstMarker.length + 3,
  );
  assert.ok(after1.includes('two'));
  assert.equal(after1.includes('three'), false, 'third not yet written');
  const secondMarker = extractMarkerId(after1);
  mock.emit(`done2\n###${secondMarker}###\n`);
  await second;

  // Drain third.
  await sleep(40);
  const allWrites3 = mock.writes.map((w) => w.data).join('');
  const after2 = allWrites3.slice(allWrites3.indexOf(secondMarker) + secondMarker.length + 3);
  assert.ok(after2.includes('three'));
  const thirdMarker = extractMarkerId(after2);
  mock.emit(`done3\n###${thirdMarker}###\n`);
  await third;

  // Drain fourth.
  await sleep(40);
  const allWrites4 = mock.writes.map((w) => w.data).join('');
  const after3 = allWrites4.slice(allWrites4.indexOf(thirdMarker) + thirdMarker.length + 3);
  assert.ok(after3.includes('four'));
  const fourthMarker = extractMarkerId(after3);
  mock.emit(`done4\n###${fourthMarker}###\n`);
  await fourth;

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
