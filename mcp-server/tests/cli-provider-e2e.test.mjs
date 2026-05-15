/**
 * cli-provider-e2e.test.mjs — Phase 9 end-to-end smoke.
 *
 * Exercises the full chain a plugin author / operator hits when they
 * install a CLI-provider plugin and start the service:
 *
 *   1. Plugin install via `init --plugin` (composed from the same
 *      exported helpers `runInit` uses — see plan §9.1 tip allowing the
 *      smaller-factored-function shape rather than driving the full
 *      interactive init).
 *   2. Workspace reload picks up `provides.agent_clis[]`.
 *   3. Chooser surfaces the plugin provider; selecting it returns its id.
 *   4. Config file persists `default_agent_cli`.
 *   5. HTTP API (`GET /api/agent-clis`) round-trip lists the plugin
 *      provider with `source: 'plugin:<id>'`, hides internal providers
 *      by default, surfaces them with `?include_internal=true`, and
 *      rejects unauthenticated requests with 401.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import {
  resolveConfig,
  writeConfig,
  configPath,
  CONFIG_VERSION,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
} from '../src/config.ts';
import { runAgentCliChooser } from '../src/cli/init.ts';
import {
  resolvePluginSource,
  discoverPluginsInDir,
  installPluginFromDir,
} from '../src/cli/plugin-sources.ts';
import { handleAgentCliApi } from '../src/cli/agent-clis-api.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'cli-plugins');
const TEST_CLI_FIXTURE = join(FIXTURE_ROOT, 'test-cli');

const TOKEN = 'e2e-cli-provider-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

const TMP_PATHS = [];

function mkTmp() {
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-e2e-cli-'));
  TMP_PATHS.push(tmp);
  const project = tmp;
  const globalDir = join(tmp, '.global');
  mkdirSync(join(project, '.clawdevbox'), { recursive: true });
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });
  return { project, globalDir };
}

/**
 * Windows can leave junctions / open handles around for a beat after a
 * test finishes; retry rmSync a few times before giving up.
 */
function rmWithRetry(p) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (err) {
      if (i === 4) {
        // best-effort cleanup; don't fail the test suite over a stuck handle
        // eslint-disable-next-line no-console
        console.warn(`[e2e] could not remove ${p}: ${err?.message ?? err}`);
        return;
      }
    }
  }
}

async function startApiServer(ws, cfg, expectedToken) {
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

// ---------------------------------------------------------------------------
// Test A: plugin install (mimics `init --plugin`) → reload → chooser → config
// ---------------------------------------------------------------------------

test('E2E: install --plugin → workspace reload → chooser → config persistence', async () => {
  const { project, globalDir } = mkTmp();

  // ---- 1. Plugin install via the same helpers runInit uses for `--plugin`
  const source = resolvePluginSource(TEST_CLI_FIXTURE);
  try {
    const discovered = discoverPluginsInDir(source.dir);
    assert.equal(discovered.errors.length, 0, 'fixture must discover cleanly');
    assert.equal(discovered.plugins.length, 1, 'fixture is a single plugin');
    const plugin = discovered.plugins[0];
    assert.equal(plugin.id, 'test-cli');

    const result = installPluginFromDir({
      globalDir,
      plugin,
      origin: TEST_CLI_FIXTURE,
      source,
    });
    assert.ok(existsSync(result.destination), 'plugin lands in <globalDir>/plugins/');
    assert.ok(
      existsSync(join(globalDir, 'plugins', 'test-cli', '.claude-plugin', 'plugin.json')),
      '.claude-plugin/plugin.json is visible under <globalDir>/plugins/test-cli/',
    );

    // ---- 2. Workspace reload picks up provides.agent_clis[]
    const ws = await loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: project,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });
    assert.ok(
      ws.agentCliProviders.has('test-cli'),
      'plugin provider must register after workspace reload',
    );
    const provider = ws.agentCliProviders.get('test-cli');
    assert.equal(provider.source, 'plugin:test-cli', 'source must be plugin:<id>');
    assert.equal(provider.displayName, 'Test CLI Provider');
    // No loader errors for the well-formed fixture.
    const errsForTestCli = (ws.agentCliProviderErrors ?? []).filter(
      (e) => e.pluginId === 'test-cli' || e.providerId === 'test-cli',
    );
    assert.deepEqual(errsForTestCli, [], 'fixture must load without errors');

    // ---- 3. Chooser surfaces the plugin provider; selecting it returns its id
    const cfg = resolveConfig({ projectDir: project, globalDir });
    let promptArgs;
    const fakeSelect = async (args) => {
      promptArgs = args;
      return 'test-cli';
    };
    const chosen = await runAgentCliChooser(ws, cfg, 'project', fakeSelect);
    assert.equal(chosen, 'test-cli', 'chooser returns the picked provider id');
    const values = promptArgs.options.map((o) => o.value);
    assert.ok(values.includes('test-cli'), 'plugin provider appears in chooser');
    assert.ok(values.includes('__skip'));

    // ---- 4. Config persistence (mirrors what runInit writes at the end)
    writeConfig(project, {
      version: CONFIG_VERSION,
      project_dir: project,
      global_dir: globalDir,
      workspaces_root: join(globalDir, 'workspaces'),
      http: { port: DEFAULT_HTTP_PORT, host: DEFAULT_HTTP_HOST, token: TOKEN },
      tunnel: { kind: 'none' },
      default_agent_cli: chosen,
    });
    const cfgPath = configPath(project);
    assert.ok(existsSync(cfgPath), 'config.json was written');
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(onDisk.default_agent_cli, 'test-cli');
    assert.equal(onDisk.version, CONFIG_VERSION);

    // Re-resolve config from disk and confirm the new value is picked up.
    const cfg2 = resolveConfig({ projectDir: project, globalDir });
    assert.equal(cfg2.defaultAgentCli, 'test-cli');
  } finally {
    source.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test B: HTTP API round-trip with the plugin pre-seeded in <globalDir>/plugins/
// ---------------------------------------------------------------------------

test('E2E: HTTP /api/agent-clis surfaces plugin provider with source plugin:<id>', async () => {
  const { project, globalDir } = mkTmp();
  // Plant the fixture by copy (avoids junction cleanup quirks on Windows
  // for the HTTP-server-bound test).
  cpSync(TEST_CLI_FIXTURE, join(globalDir, 'plugins', 'test-cli'), { recursive: true });

  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: project,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
  });
  const cfg = resolveConfig({ projectDir: project, globalDir });
  assert.ok(ws.agentCliProviders.has('test-cli'));

  const { server, port } = await startApiServer(ws, cfg, TOKEN);
  try {
    // Default — plugin visible, echo-stub hidden.
    {
      const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`, { headers: AUTH });
      assert.equal(r.status, 200);
      const body = await r.json();
      const ids = body.providers.map((p) => p.id).sort();
      assert.ok(ids.includes('test-cli'), `plugin provider in response (got ${ids.join(',')})`);
      assert.ok(!ids.includes('echo-stub'), 'echo-stub hidden by default');
      const testCli = body.providers.find((p) => p.id === 'test-cli');
      assert.equal(testCli.source, 'plugin:test-cli');
      assert.equal(testCli.display_name, 'Test CLI Provider');
      assert.equal(testCli.internal, false);
      assert.equal(testCli.detect.available, true);
    }

    // include_internal=true — echo-stub also appears.
    {
      const r = await fetch(
        `http://127.0.0.1:${port}/api/agent-clis?include_internal=true`,
        { headers: AUTH },
      );
      assert.equal(r.status, 200);
      const body = await r.json();
      const ids = body.providers.map((p) => p.id).sort();
      assert.ok(ids.includes('echo-stub'), 'echo-stub surfaced with include_internal');
      assert.ok(ids.includes('test-cli'));
      const echo = body.providers.find((p) => p.id === 'echo-stub');
      assert.equal(echo.internal, true);
    }

    // No bearer — 401.
    {
      const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`);
      assert.equal(r.status, 401);
    }

    // Wrong bearer — also 401.
    {
      const r = await fetch(`http://127.0.0.1:${port}/api/agent-clis`, {
        headers: { authorization: 'Bearer nope' },
      });
      assert.equal(r.status, 401);
    }
  } finally {
    await stopServer(server);
  }
});

test('E2E cleanup', () => {
  for (const p of TMP_PATHS) rmWithRetry(p);
});
