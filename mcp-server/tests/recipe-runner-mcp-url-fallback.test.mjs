/**
 * Regression: recipe-runner.ts:227 used `opts.mcpUrl ?? ''`, writing an
 * empty url into the spawned agent's .mcp.json. Copilot CLI rejects this
 * with "Invalid MCP server configuration: url: Invalid url" and exits
 * code 1 within milliseconds of being spawned, so every trigger->recipe
 * spawn that came from the dispatcher (which doesn't set opts.mcpUrl)
 * silently failed.
 *
 * Fix: fall back to `http://${cfg.http.host}:${cfg.http.port}/mcp` when
 * opts.mcpUrl is unset. This test mocks the agent-CLI provider so it
 * never actually spawns a process — we just capture the SpawnSessionOpts
 * the provider receives and assert the mcp.url field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecipe } from '../src/recipe-runner.ts';

function makeStubProvider() {
  let captured = null;
  const provider = {
    id: 'stub',
    label: 'Stub',
    description: 'test stub',
    source: 'builtin',
    internal: true,
    async spawnSession(_ctx, opts) {
      captured = opts;
      return {
        pid: 99999,
        sessionId: opts.init.session_id,
        pty: {
          pid: 99999,
          onData() {},
          onExit(cb) { setImmediate(() => cb({ exitCode: 0, signal: 0 })); },
          write() {}, kill() {}, resize() {},
        },
        exited: Promise.resolve({ exitCode: 0 }),
      };
    },
  };
  return { provider, captured: () => captured };
}

function makeWs(provider) {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-rrf-'));
  mkdirSync(join(tmp, '.clawdevbox'), { recursive: true });
  return {
    projectDir: tmp,
    globalDir: join(tmp, '.global'),
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map([['stub', provider]]),
    agentCliProviderErrors: [],
  };
}

function makeCfg(ws, http = { host: '127.0.0.1', port: 5201, token: '' }) {
  return {
    projectDir: ws.projectDir,
    globalDir: ws.globalDir,
    workspacesRoot: ws.projectDir,
    http,
    cron: { max_concurrent: 4, dispatcher_drain_ms: 50 },
    tunnel: { kind: 'none' },
    plugins: [],
    pluginErrors: [],
  };
}

test('runRecipe falls back to cfg.http URL when opts.mcpUrl is unset', async () => {
  const { provider, captured } = makeStubProvider();
  const ws = makeWs(provider);
  const cfg = makeCfg(ws, { host: '127.0.0.1', port: 5201, token: '' });

  await runRecipe({
    recipeId: 'trial',
    recipeSnapshot: 'id: trial\nname: trial\nsteps: []\n',
    isAdhoc: true,
    prompt: 'hi',
    workspaceInfo: { id: 'wsX', path: ws.projectDir },
    agentCli: 'stub',
    workspacesRoot: ws.projectDir,
    ws,
    cfg,
  });

  const c = captured();
  assert.ok(c, 'provider.spawnSession was not called');
  assert.equal(
    c.mcp.url,
    'http://127.0.0.1:5201/mcp',
    `expected cfg-derived URL, got ${c.mcp.url}`,
  );
});

test('runRecipe respects explicit opts.mcpUrl (cfg fallback only when unset)', async () => {
  const { provider, captured } = makeStubProvider();
  const ws = makeWs(provider);
  const cfg = makeCfg(ws);

  await runRecipe({
    recipeId: 'trial',
    recipeSnapshot: 'id: trial\nname: trial\nsteps: []\n',
    isAdhoc: true,
    prompt: 'hi',
    workspaceInfo: { id: 'wsX', path: ws.projectDir },
    agentCli: 'stub',
    workspacesRoot: ws.projectDir,
    mcpUrl: 'http://example.invalid:8080/mcp',
    ws,
    cfg,
  });

  const c = captured();
  assert.equal(c.mcp.url, 'http://example.invalid:8080/mcp');
});

test('runRecipe falls back to cfg.http URL when opts.mcpUrl is empty string', async () => {
  const { provider, captured } = makeStubProvider();
  const ws = makeWs(provider);
  const cfg = makeCfg(ws, { host: 'localhost', port: 9999, token: '' });

  await runRecipe({
    recipeId: 'trial',
    recipeSnapshot: 'id: trial\nname: trial\nsteps: []\n',
    isAdhoc: true,
    prompt: 'hi',
    workspaceInfo: { id: 'wsX', path: ws.projectDir },
    agentCli: 'stub',
    workspacesRoot: ws.projectDir,
    mcpUrl: '',
    ws,
    cfg,
  });

  const c = captured();
  assert.equal(c.mcp.url, 'http://localhost:9999/mcp');
});
