import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerPty, getConductor, hasSession, killPty } from '../src/pty-registry.ts';

function makeFakePty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    pid: 12345,
    write: () => {},
    resize: () => {},
    kill: () => { for (const cb of exitListeners) cb({ exitCode: 0, signal: undefined }); },
    onData: (cb) => { dataListeners.push(cb); return { dispose() {} }; },
    onExit: (cb) => { exitListeners.push(cb); return { dispose() {} }; },
    _emitData: (chunk) => { for (const cb of dataListeners) cb(chunk); },
    _emitExit: (code) => { for (const cb of exitListeners) cb({ exitCode: code, signal: undefined }); },
  };
}

function makeFakeProvider() {
  return {
    id: 'fake',
    displayName: 'Fake',
    description: 'fake',
    source: 'builtin',
    capabilities: {
      queueMode: 'none',
      promptSubmitStrategy: 'bulk-cr',
      promptReadyRegex: /❯[^\S\n]*$/m,
      busyIndicators: [/Working/i],
    },
    async writePrompt() {},
    async detect() { return { available: true, binary: 'fake', version: '0' }; },
    async spawnSession() { throw new Error('unused'); },
    async syncPluginInventory() { return { plugins: [], errors: [] }; },
    async discoverInstalledPlugins() { return []; },
  };
}

test('registerPty without provider creates session without conductor', () => {
  const pty = makeFakePty();
  registerPty({ instanceId: 'noconductor-1', workspaceId: 'ws', cols: 80, rows: 24, ipty: pty });
  assert.equal(hasSession('noconductor-1'), true);
  assert.equal(getConductor('noconductor-1'), null);
  killPty('noconductor-1');
});

test('registerPty with provider + agentHandle creates conductor', () => {
  const pty = makeFakePty();
  const provider = makeFakeProvider();
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const handle = { pid: pty.pid, sessionId: 'sess', pty, exited };
  registerPty({
    instanceId: 'withconductor-1',
    workspaceId: 'ws',
    cols: 80, rows: 24,
    ipty: pty,
    provider,
    agentHandle: handle,
  });
  const cond = getConductor('withconductor-1');
  assert.ok(cond, 'conductor must exist');
  assert.equal(cond.state, 'starting');
  killPty('withconductor-1');
});

test('getConductor returns null for unknown instance', () => {
  assert.equal(getConductor('does-not-exist'), null);
});

test('conductor moves to exited when pty exits', async () => {
  const pty = makeFakePty();
  const provider = makeFakeProvider();
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const handle = { pid: pty.pid, sessionId: 'sess', pty, exited };
  registerPty({
    instanceId: 'exit-1',
    workspaceId: 'ws',
    cols: 80, rows: 24,
    ipty: pty,
    provider,
    agentHandle: handle,
  });
  const cond = getConductor('exit-1');
  assert.ok(cond);
  pty._emitExit(0);
  resolveExit({ exitCode: 0, signal: undefined });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cond.state, 'exited');
});
