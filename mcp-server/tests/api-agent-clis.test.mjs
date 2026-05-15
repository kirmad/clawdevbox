/**
 * api-agent-clis.test.mjs — covers GET /api/agent-clis.
 *
 * Mirrors cron-api.test.mjs: spins up a local http.Server that delegates to
 * `handleAgentCliApi` (the same function `cli/start.ts` mounts) and exercises
 * the route with/without bearer, with/without `include_internal`, and with a
 * plugin-provided provider planted in the tmp global dir before workspace load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { resolveConfig } from '../src/config.ts';
import { handleAgentCliApi } from '../src/cli/agent-clis-api.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'cli-plugins');

const TOKEN = 'api-agent-clis-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

const TMP_PATHS = [];

function setupTmpWorkspace(fixturePlugins = []) {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-api-agent-clis-'));
  TMP_PATHS.push(tmp);
  const project = tmp;
  mkdirSync(join(project, '.clawdevbox'), { recursive: true });
  const globalDir = join(tmp, '.global');
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });
  for (const p of fixturePlugins) {
    cpSync(join(FIXTURE_ROOT, p), join(globalDir, 'plugins', p), { recursive: true });
  }
  return { project, globalDir };
}

async function loadWs({ project, globalDir }) {
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  const cfg = resolveConfig({ projectDir: project, globalDir });
  return { ws, cfg };
}

async function startServer(ws, cfg, expectedToken) {
  const server = createServer(async (req, res) => {
    try {
      const handled = await handleAgentCliApi(req, res, ws, cfg, expectedToken);
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not handled' }));
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, port };
}

async function stopServer(server) {
  await new Promise((r) => server.close(() => r()));
}

test('GET /api/agent-clis — 200 lists visible providers (copilot + claude); echo-stub hidden', async () => {
  const tmp = setupTmpWorkspace();
  const { ws, cfg } = await loadWs(tmp);
  const { server, port } = await startServer(ws, cfg, TOKEN);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.providers));
    const ids = body.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ['claude', 'copilot']);
    assert.equal(body.configured, cfg.defaultAgentCli); // null when no config
    assert.deepEqual(body.errors, []);
    for (const p of body.providers) {
      assert.equal(p.internal, false);
      assert.ok(p.detect && typeof p.detect.available === 'boolean');
      assert.equal(p.source, 'builtin');
      assert.ok(typeof p.display_name === 'string');
    }
  } finally {
    await stopServer(server);
  }
});

test('GET /api/agent-clis?include_internal=true — includes echo-stub (3 providers)', async () => {
  const tmp = setupTmpWorkspace();
  const { ws, cfg } = await loadWs(tmp);
  const { server, port } = await startServer(ws, cfg, TOKEN);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis?include_internal=true`, {
      headers: AUTH,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    const ids = body.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ['claude', 'copilot', 'echo-stub']);
    const echo = body.providers.find((p) => p.id === 'echo-stub');
    assert.equal(echo.internal, true);
  } finally {
    await stopServer(server);
  }
});

test('GET /api/agent-clis — 401 without bearer', async () => {
  const tmp = setupTmpWorkspace();
  const { ws, cfg } = await loadWs(tmp);
  const { server, port } = await startServer(ws, cfg, TOKEN);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`);
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('GET /api/agent-clis — 401 with wrong bearer', async () => {
  const tmp = setupTmpWorkspace();
  const { ws, cfg } = await loadWs(tmp);
  const { server, port } = await startServer(ws, cfg, TOKEN);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`, {
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(r.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('GET /api/agent-clis — plugin-provided provider appears with source plugin:test-cli', async () => {
  const tmp = setupTmpWorkspace(['test-cli']);
  const { ws, cfg } = await loadWs(tmp);
  assert.ok(ws.agentCliProviders.has('test-cli'), 'planted plugin provider must load');
  const { server, port } = await startServer(ws, cfg, TOKEN);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`, { headers: AUTH });
    assert.equal(r.status, 200);
    const body = await r.json();
    const testCli = body.providers.find((p) => p.id === 'test-cli');
    assert.ok(testCli, 'test-cli provider must appear in API response');
    assert.equal(testCli.source, 'plugin:test-cli');
    assert.equal(testCli.display_name, 'Test CLI Provider');
    assert.equal(testCli.internal, false);
    assert.equal(testCli.detect.available, true);
  } finally {
    await stopServer(server);
  }
});

test('cleanup tmp', () => {
  for (const p of TMP_PATHS) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
