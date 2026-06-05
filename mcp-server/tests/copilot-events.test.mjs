/**
 * copilot-events.test.mjs — unit coverage for the wait-for-idle helper.
 *
 * Uses a tmp directory as $COPILOT_DIR; writes synthetic events.jsonl
 * lines to simulate Copilot CLI's behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepP } from 'node:timers/promises';

import {
  waitForCopilotIdle,
  isCopilotIdleNow,
  eventsJsonlPath,
} from '../src/agent-clis/copilot-events.ts';

const __filename = fileURLToPath(import.meta.url);
const TMP_ROOT = resolve(dirname(__filename), '.tmp', 'copilot-events');

function fresh(name) {
  const root = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  const copilotDir = join(root, '.copilot');
  const sessionId = `test-${Math.random().toString(36).slice(2, 10)}`;
  mkdirSync(join(copilotDir, 'session-state', sessionId), { recursive: true });
  const file = eventsJsonlPath(sessionId, copilotDir);
  return { root, copilotDir, sessionId, file, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

function evt(type, extra = {}) {
  return JSON.stringify({ type, id: 'x', timestamp: new Date().toISOString(), ...extra }) + '\n';
}

// ----------------------------------------------------------------------------

test('1. classify: last event = assistant.turn_end → idle', async () => {
  const h = fresh('e1');
  try {
    writeFileSync(h.file,
      evt('session.start') +
      evt('user.message') +
      evt('assistant.turn_start') +
      evt('assistant.message') +
      evt('assistant.turn_end'));
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 2000, settleMs: 50 });
    assert.equal(r.ready, true);
    assert.equal(r.reason, 'idle');
    assert.equal(r.lastEvent, 'assistant.turn_end');
  } finally { h.cleanup(); }
});

test('2. ignores tool.execution_complete — still busy after tool_start', async () => {
  const h = fresh('e2');
  try {
    writeFileSync(h.file,
      evt('user.message') +
      evt('assistant.turn_start') +
      evt('tool.execution_start') +
      evt('tool.execution_complete'));
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 800, settleMs: 50 });
    assert.equal(r.ready, false);
    assert.equal(r.reason, 'timeout');
    // Most-recent STATUS-bearing event is tool.execution_start (NEUTRAL_EVENTS
    // skips tool.execution_complete).
    assert.equal(r.lastEvent, 'tool.execution_start');
  } finally { h.cleanup(); }
});

test('3. ignores session.context_changed — idle still wins', async () => {
  const h = fresh('e3');
  try {
    writeFileSync(h.file,
      evt('assistant.turn_end') +
      evt('session.context_changed') +
      evt('hook.start') +
      evt('hook.end'));
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 1500, settleMs: 50 });
    assert.equal(r.ready, true);
    assert.equal(r.reason, 'idle');
  } finally { h.cleanup(); }
});

test('4. terminal event (session.shutdown) → ready:false reason:terminal', async () => {
  const h = fresh('e4');
  try {
    writeFileSync(h.file,
      evt('session.start') +
      evt('user.message') +
      evt('assistant.turn_end') +
      evt('session.shutdown'));
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 1000 });
    assert.equal(r.ready, false);
    assert.equal(r.reason, 'terminal');
    assert.equal(r.lastEvent, 'session.shutdown');
  } finally { h.cleanup(); }
});

test('5. timeout when no events ever arrive', async () => {
  const h = fresh('e5');
  try {
    // No file at all
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 500, pollIntervalMs: 50 });
    assert.equal(r.ready, false);
    assert.equal(r.reason, 'timeout');
  } finally { h.cleanup(); }
});

test('6. busy → idle transition during wait', async () => {
  const h = fresh('e6');
  try {
    writeFileSync(h.file, evt('user.message') + evt('assistant.turn_start'));
    const waitP = waitForCopilotIdle(h.sessionId, {
      copilotDir: h.copilotDir, timeoutMs: 3000, pollIntervalMs: 100, settleMs: 50,
    });
    // After 200ms, the agent finishes the turn.
    sleepP(200).then(() => {
      appendFileSync(h.file, evt('assistant.message') + evt('assistant.turn_end'));
    });
    const r = await waitP;
    assert.equal(r.ready, true);
    assert.equal(r.reason, 'idle');
    assert.equal(r.lastEvent, 'assistant.turn_end');
    assert.ok(r.waitedMs >= 200, `expected to wait ≥ 200ms, got ${r.waitedMs}`);
  } finally { h.cleanup(); }
});

test('7. tolerates partial trailing line (no newline yet)', async () => {
  const h = fresh('e7');
  try {
    // Last "line" is incomplete JSON — tail parser should ignore it.
    writeFileSync(h.file,
      evt('user.message') +
      evt('assistant.turn_end') +
      '{"type":"session.cont');  // no closing brace + no newline
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 1000, settleMs: 50 });
    assert.equal(r.ready, true);
    assert.equal(r.lastEvent, 'assistant.turn_end');
  } finally { h.cleanup(); }
});

test('8. isCopilotIdleNow: returns false when busy, true when idle', () => {
  const h = fresh('e8');
  try {
    writeFileSync(h.file, evt('user.message') + evt('assistant.turn_start'));
    assert.equal(isCopilotIdleNow(h.sessionId, h.copilotDir), false);
    appendFileSync(h.file, evt('assistant.turn_end'));
    assert.equal(isCopilotIdleNow(h.sessionId, h.copilotDir), true);
  } finally { h.cleanup(); }
});

test('9. only session.start events → not idle yet (waiting for first turn)', async () => {
  const h = fresh('e9');
  try {
    writeFileSync(h.file, evt('session.start'));
    const r = await waitForCopilotIdle(h.sessionId, { copilotDir: h.copilotDir, timeoutMs: 500, pollIntervalMs: 100 });
    // No status-bearing event has fired yet → classify returns null → poll → timeout.
    assert.equal(r.ready, false);
    assert.equal(r.reason, 'timeout');
  } finally { h.cleanup(); }
});
