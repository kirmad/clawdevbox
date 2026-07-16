/**
 * dispatcher-dispatch-to-ipty.test.mjs
 *
 * Regression for: dispatchToInstance used to consult ONLY
 * tmuxSessionRegistry, so legacy IPty providers (agency-provider et al.)
 * always got `target_unavailable` — the smart router then fell through
 * to resume on every reply, creating a fresh process per inbox reply
 * instead of dispatching to the open terminal.
 *
 * Fix: dispatchToInstance now falls back to pty-registry when the tmux
 * registry has no entry. Same Escape / text / Enter byte sequence is
 * sent (as raw bytes via IPty.write) so the agent's TUI accepts it the
 * way it would a tmux send-keys.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { Dispatcher } from '../src/dispatcher.ts';
import { registerPty, _resetForTests as resetPtyRegistry } from '../src/pty-registry.ts';
import { tmuxSessionRegistry } from '../src/cli-sessions/tmux-session-runtime.ts';
import {
  resolvePendingTimeout,
  _resetForTests as resetPendingRegistry,
} from '../src/pending-dispatch-registry.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = OFF');
  runMigrations(db);
  return db;
}

function makeWs() {
  return {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
  };
}

// Fake IPty that records every .write() so we can assert the
// Escape / text / Enter byte sequence the dispatcher must emit.
function fakeIPty() {
  const writes = [];
  return {
    writes,
    pid: 4242,
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: (data) => { writes.push(data); },
    resize: () => {},
    kill: () => {},
  };
}

test('dispatchToInstance: falls back to pty-registry IPty when not in tmuxSessionRegistry; sends ESC + text + CR', async (t) => {
  resetPtyRegistry();
  tmuxSessionRegistry.__resetForTests();
  resetPendingRegistry();

  const db = open();
  t.after(() => {
    resolvePendingTimeout('ri_test_1');
    resetPendingRegistry();
    db.close();
    resetPtyRegistry();
    tmuxSessionRegistry.__resetForTests();
  });

  const ipty = fakeIPty();
  registerPty({
    instanceId: 'ri_test_1',
    workspaceId: 'ws_test',
    cols: 80,
    rows: 24,
    ipty,
    meta: {
      agentCli: 'agency',
      cwd: 'C:/test',
      command: 'agency',
      args: [],
      cliSessionId: 'guid-test',
      recipeId: null,
      role: 'recipe-instance',
    },
  });

  const d = new Dispatcher(db, makeWs(), { maxConcurrent: 1, drainMs: 50 });
  const r = await d.dispatchToInstance('ri_test_1', 'hello world');
  assert.equal(r.status, 'ok', `expected ok, got ${JSON.stringify(r)}`);
  assert.equal(r.state, 'dispatched');

  // ESC + prompt + Enter, in that order. (Three writes, three bytes/chars.)
  assert.deepEqual(
    ipty.writes,
    ['\x1b', 'hello world', '\r'],
    'must emit Escape, then prompt text, then Enter',
  );
});

test('dispatchToInstance: returns target_unavailable when neither registry has the instance', async (t) => {
  resetPtyRegistry();
  tmuxSessionRegistry.__resetForTests();
  resetPendingRegistry();

  const db = open();
  t.after(() => {
    resetPendingRegistry();
    db.close();
    resetPtyRegistry();
    tmuxSessionRegistry.__resetForTests();
  });

  const d = new Dispatcher(db, makeWs(), { maxConcurrent: 1, drainMs: 50 });
  const r = await d.dispatchToInstance('ri_does_not_exist', 'hello');
  assert.equal(r.status, 'target_unavailable');
});
