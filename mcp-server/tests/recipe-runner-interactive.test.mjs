import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDatabase, teardownTestDatabase } from './helpers/db.mjs';
import { runRecipe } from '../src/recipe-runner.ts';
import { getConductor, killPty } from '../src/pty-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = resolve(__dirname, '.tmp', 'recipe-runner-interactive');

function freshTmp(name) {
  const p = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function makeFakePty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    pid: 99001,
    write: () => {},
    resize: () => {},
    kill: () => { for (const cb of exitListeners) cb({ exitCode: 0, signal: undefined }); },
    onData: (cb) => { dataListeners.push(cb); return { dispose() {} }; },
    onExit: (cb) => { exitListeners.push(cb); return { dispose() {} }; },
    _emitData: (chunk) => { for (const cb of dataListeners) cb(chunk); },
    _emitExit: (code) => { for (const cb of exitListeners) cb({ exitCode: code, signal: undefined }); },
  };
}

function makeFakeProvider(captured) {
  return {
    id: 'fake-cli',
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
    async spawnSession(_ctx, opts) {
      captured.spawnCalls.push({ mode: opts.mode, prompt: opts.prompt });
      const pty = makeFakePty();
      const handle = { pid: pty.pid, sessionId: opts.init.session_id, pty, exited: new Promise(() => {}) };
      captured.lastHandle = handle;
      captured.lastPty = pty;
      return handle;
    },
    async syncPluginInventory() { return { plugins: [], errors: [] }; },
    async discoverInstalledPlugins() { return []; },
  };
}

function makeWs(provider) {
  return {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map([[provider.id, provider]]),
  };
}

function makeCfg() {
  return {
    defaultAgentCli: 'fake-cli',
    http: { host: '127.0.0.1', port: 5201, token: '' },
    vaults: [],
  };
}

test('runRecipe spawnMode=headless does NOT register a conductor', async () => {
  setupTestDatabase();
  const captured = { spawnCalls: [] };
  const provider = makeFakeProvider(captured);
  const ws = makeWs(provider);
  const wsPath = freshTmp('headless');
  const wsInfo = { id: 'ws_t', path: wsPath };
  const result = await runRecipe({
    recipeId: 'r',
    recipeSnapshot: 'name: r\n',
    prompt: 'hello',
    workspaceInfo: wsInfo,
    workspacesRoot: wsPath,
    ws,
    cfg: makeCfg(),
  });
  assert.equal(captured.spawnCalls[0].mode, 'headless');
  assert.equal(getConductor(result.recipe_instance_id), null);
  killPty(result.recipe_instance_id); await new Promise((r) => setTimeout(r, 100));
});

test.skip('runRecipe spawnMode=interactive registers a conductor', async () => {
  setupTestDatabase();
  const captured = { spawnCalls: [] };
  const provider = makeFakeProvider(captured);
  const ws = makeWs(provider);
  const wsPath = freshTmp('interactive');
  const wsInfo = { id: 'ws_t', path: wsPath };
  const result = await runRecipe({
    recipeId: 'r',
    recipeSnapshot: 'name: r\n',
    prompt: 'hello',
    spawnMode: 'interactive',
    workspaceInfo: wsInfo,
    workspacesRoot: wsPath,
    ws,
    cfg: makeCfg(),
  });
  assert.equal(captured.spawnCalls[0].mode, 'interactive');
  const cond = getConductor(result.recipe_instance_id);
  assert.ok(cond, 'conductor must exist for interactive runs');
  killPty(result.recipe_instance_id); await new Promise((r) => setTimeout(r, 100));
});

test('runRecipe ad-hoc (recipeId=null) succeeds and returns a synthetic recipe_id', async () => {
  setupTestDatabase();
  const captured = { spawnCalls: [] };
  const provider = makeFakeProvider(captured);
  const ws = makeWs(provider);
  const wsPath = freshTmp('adhoc');
  const wsInfo = { id: 'ws_t', path: wsPath };
  const result = await runRecipe({
    recipeId: null,
    recipeSnapshot: '',
    isAdhoc: true,
    prompt: 'just respond',
    spawnMode: 'interactive',
    workspaceInfo: wsInfo,
    workspacesRoot: wsPath,
    ws,
    cfg: makeCfg(),
  });
  assert.equal(result.adhoc, true);
  assert.ok(result.recipe_id.startsWith('__adhoc_'), `expected __adhoc_ prefix, got ${result.recipe_id}`);
  killPty(result.recipe_instance_id); await new Promise((r) => setTimeout(r, 100));
});

test('cleanup', async () => {
  await new Promise((r) => setTimeout(r, 200));
  teardownTestDatabase();
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});
