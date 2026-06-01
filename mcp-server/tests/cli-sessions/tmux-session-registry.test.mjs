import test from 'node:test';
import assert from 'node:assert/strict';
import { tmuxSessionRegistry } from '../../src/cli-sessions/tmux-session-runtime.ts';

function fakeSession(name, exitedPromise) {
  return {
    name,
    pid: async () => 1234,
    exited: exitedPromise,
    sendText: async () => {},
    sendKey: async () => {},
    resize: async () => {},
    snapshot: async () => '',
    kill: async () => {},
  };
}

test('register stores the session and get returns it', () => {
  tmuxSessionRegistry.__resetForTests();
  const sess = fakeSession('cdb_X', new Promise(() => {}));
  tmuxSessionRegistry.register('inst-X', sess);
  assert.equal(tmuxSessionRegistry.get('inst-X'), sess);
});

test('register auto-unregisters when session.exited resolves', async () => {
  tmuxSessionRegistry.__resetForTests();
  let resolveExit;
  const exitedPromise = new Promise((r) => { resolveExit = r; });
  const sess = fakeSession('cdb_Y', exitedPromise);
  tmuxSessionRegistry.register('inst-Y', sess);
  assert.ok(tmuxSessionRegistry.get('inst-Y'), 'session should be registered');
  resolveExit({ exitCode: 0 });
  // Allow microtasks for the .then() to run
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(tmuxSessionRegistry.get('inst-Y'), null, 'session should auto-unregister on exit');
});

test('register does NOT delete a replacement entry if the original exits later', async () => {
  tmuxSessionRegistry.__resetForTests();
  let resolveA;
  const sessA = fakeSession('cdb_Z', new Promise((r) => { resolveA = r; }));
  const sessB = fakeSession('cdb_Z2', new Promise(() => {}));
  tmuxSessionRegistry.register('inst-Z', sessA);
  tmuxSessionRegistry.register('inst-Z', sessB);  // replacement
  resolveA({ exitCode: 0 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(tmuxSessionRegistry.get('inst-Z'), sessB, 'replacement should survive original exit');
});

test('list returns currently registered entries with sessionName', () => {
  tmuxSessionRegistry.__resetForTests();
  tmuxSessionRegistry.register('inst-1', fakeSession('cdb_one', new Promise(() => {})));
  tmuxSessionRegistry.register('inst-2', fakeSession('cdb_two', new Promise(() => {})));
  const items = tmuxSessionRegistry.list();
  assert.equal(items.length, 2);
  const map = Object.fromEntries(items.map((i) => [i.instanceId, i.sessionName]));
  assert.equal(map['inst-1'], 'cdb_one');
  assert.equal(map['inst-2'], 'cdb_two');
});

test('unregister removes the entry', () => {
  tmuxSessionRegistry.__resetForTests();
  tmuxSessionRegistry.register('inst-U', fakeSession('cdb_u', new Promise(() => {})));
  assert.ok(tmuxSessionRegistry.get('inst-U'));
  tmuxSessionRegistry.unregister('inst-U');
  assert.equal(tmuxSessionRegistry.get('inst-U'), null);
});
