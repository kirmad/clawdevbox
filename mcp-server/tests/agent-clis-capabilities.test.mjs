import test from 'node:test';
import assert from 'node:assert/strict';
import { copilotProvider } from '../src/agent-clis/copilot.ts';
import { claudeProvider } from '../src/agent-clis/claude.ts';
import { echoStubProvider } from '../src/agent-clis/echo-stub.ts';

// ---------------------------------------------------------------------------
// Static metadata: every interactive provider exposes capabilities + writePrompt
// ---------------------------------------------------------------------------

test('copilot capabilities use ctrl-q queue and split-cr submit', () => {
  const caps = copilotProvider.capabilities;
  assert.ok(caps, 'copilot.capabilities present');
  assert.equal(caps.queueMode, 'ctrl-q');
  assert.equal(caps.promptSubmitStrategy, 'split-cr-250ms');
  assert.ok(caps.promptReadyRegex instanceof RegExp);
  assert.ok(Array.isArray(caps.busyIndicators));
  assert.ok(caps.busyIndicators.length >= 3);
  assert.equal(typeof copilotProvider.writePrompt, 'function');
});

test('claude capabilities declare no queue and bulk-cr submit', () => {
  const caps = claudeProvider.capabilities;
  assert.ok(caps, 'claude.capabilities present');
  assert.equal(caps.queueMode, 'none');
  assert.equal(caps.promptSubmitStrategy, 'bulk-cr');
  assert.equal(typeof claudeProvider.writePrompt, 'function');
});

test('echo-stub does not expose interactive capabilities', () => {
  // echo-stub is headless-only; capabilities are optional and intentionally
  // absent so the SessionConductor refuses to wrap it.
  assert.equal(echoStubProvider.capabilities, undefined);
  assert.equal(echoStubProvider.writePrompt, undefined);
});

// ---------------------------------------------------------------------------
// Regex behavior: match spike-captured strings
// ---------------------------------------------------------------------------

test('copilot promptReadyRegex matches trailing ❯ glyph but not active input', () => {
  const ready = '\n┌─ working dir\n│\n❯ \n└─ ?';
  assert.ok(copilotProvider.capabilities.promptReadyRegex.test(ready));
  const editing = 'foo\n❯ Say hello\n';
  assert.equal(copilotProvider.capabilities.promptReadyRegex.test(editing), false);
});

test('copilot busy indicators match spike-captured tokens', () => {
  const [working, queued, pending] = copilotProvider.capabilities.busyIndicators;
  assert.ok(working.test('Working on it...'));
  assert.ok(queued.test('Queued (2)'));
  assert.ok(queued.test('queued (1)'));
  assert.ok(pending.test('[pending] tool call'));
});

test('claude busy indicators match Working and thinking', () => {
  const indicators = claudeProvider.capabilities.busyIndicators;
  assert.ok(indicators.some((re) => re.test('Working')));
  assert.ok(indicators.some((re) => re.test('thinking...')));
});

test('claude promptReadyRegex matches trailing ❯ glyph', () => {
  assert.ok(claudeProvider.capabilities.promptReadyRegex.test('foo\n❯ \n'));
});

// ---------------------------------------------------------------------------
// writePrompt: byte-level sequencing
// ---------------------------------------------------------------------------

function fakeHandle() {
  const writes = [];
  return {
    handle: {
      pid: 1,
      sessionId: 'sess',
      pty: {
        write(data) { writes.push({ at: Date.now(), data }); },
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        kill() {},
        resize() {},
      },
      exited: new Promise(() => {}),
    },
    writes,
  };
}

test('copilot writePrompt submit writes Ctrl+U then text then CR with ~250ms gap', async () => {
  const { handle, writes } = fakeHandle();
  await copilotProvider.writePrompt(handle, { text: 'hello world', strategy: 'submit' });
  assert.equal(writes.length, 3);
  assert.equal(writes[0].data, '\x15');
  assert.equal(writes[1].data, 'hello world');
  assert.equal(writes[2].data, '\r');
  const gap = writes[2].at - writes[1].at;
  assert.ok(gap >= 200, `expected ~250ms gap, got ${gap}ms`);
});

test('copilot writePrompt queue writes text then DC1 (Ctrl+Q) without Ctrl+U', async () => {
  const { handle, writes } = fakeHandle();
  await copilotProvider.writePrompt(handle, { text: 'follow up', strategy: 'queue' });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data, 'follow up');
  assert.equal(writes[1].data, '\x11');
});

test('claude writePrompt submit clears input with Ctrl+U then writes text+CR', async () => {
  const { handle, writes } = fakeHandle();
  await claudeProvider.writePrompt(handle, { text: 'do thing', strategy: 'submit' });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data, '\x15');
  assert.equal(writes[1].data, 'do thing\r');
});

test('claude writePrompt rejects queue strategy', async () => {
  const { handle } = fakeHandle();
  await assert.rejects(
    claudeProvider.writePrompt(handle, { text: 'x', strategy: 'queue' }),
    /queue strategy not supported/i,
  );
});

// ---------------------------------------------------------------------------
// deliverInitialPromptWhenReady: shared helper for interactive seeding
// ---------------------------------------------------------------------------

import { deliverInitialPromptWhenReady } from '../src/agent-clis/shared.ts';

function fakePty() {
  const dataListeners = [];
  const writes = [];
  return {
    pty: {
      write(d) { writes.push({ at: Date.now(), data: d }); },
      onData(cb) { dataListeners.push(cb); return { dispose() { const i = dataListeners.indexOf(cb); if (i >= 0) dataListeners.splice(i, 1); } }; },
      onExit() { return { dispose() {} }; },
      kill() {}, resize() {},
    },
    writes,
    emit(d) { for (const cb of dataListeners.slice()) cb(d); },
    listenerCount() { return dataListeners.length; },
  };
}

test('deliverInitialPromptWhenReady waits for ❯ glyph before submitting', async () => {
  const m = fakePty();
  let status = 'pending';
  const writePrompt = async ({ text, strategy }) => {
    m.pty.write(text);
    await new Promise((r) => setTimeout(r, 10));
    m.pty.write(strategy === 'queue' ? '\x11' : '\r');
  };
  deliverInitialPromptWhenReady(m.pty, {
    text: 'hello',
    promptReadyRegex: copilotProvider.capabilities.promptReadyRegex,
    writePrompt,
    stableMs: 50,
    timeoutMs: 2000,
  }).then((r) => { status = `ok:${r}`; }).catch((err) => { status = `err:${err.message}`; });

  // Splash bytes — should not trigger delivery.
  m.emit('\x1b[2J\x1b[H Loading...\n');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(m.writes.length, 0);
  assert.equal(status, 'pending');

  // Ready glyph appears; after stableMs the helper writes text + CR.
  m.emit('\n❯ ');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(m.writes.length, 2);
  assert.equal(m.writes[0].data, 'hello');
  assert.equal(m.writes[1].data, '\r');
  assert.equal(status, 'ok:delivered');
  assert.equal(m.listenerCount(), 0, 'listener disposed after delivery');
});

test('deliverInitialPromptWhenReady rejects on timeout if ❯ never appears', async () => {
  const m = fakePty();
  const writePrompt = async () => { throw new Error('should not be called'); };
  await assert.rejects(
    deliverInitialPromptWhenReady(m.pty, {
      text: 'unused',
      promptReadyRegex: copilotProvider.capabilities.promptReadyRegex,
      writePrompt,
      stableMs: 50,
      timeoutMs: 80,
    }),
    /timed out/,
  );
  assert.equal(m.listenerCount(), 0, 'listener disposed on timeout');
});

test('deliverInitialPromptWhenReady requires stable tail before submitting', async () => {
  const m = fakePty();
  const writePrompt = async ({ text }) => { m.pty.write(text); };
  const p = deliverInitialPromptWhenReady(m.pty, {
    text: 'go',
    promptReadyRegex: copilotProvider.capabilities.promptReadyRegex,
    writePrompt,
    stableMs: 100,
    timeoutMs: 2000,
  });

  // Emit ❯ but immediately flicker with more bytes before stable window.
  m.emit('\n❯ ');
  await new Promise((r) => setTimeout(r, 50));        // < stableMs
  m.emit('extra noise');
  await new Promise((r) => setTimeout(r, 50));        // ❯ no longer at tail
  assert.equal(m.writes.length, 0, 'should not have submitted on flicker');

  // Re-emit a stable ready glyph; helper should now fire.
  m.emit('\n❯ ');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(m.writes[0]?.data, 'go');
  await p;
});
