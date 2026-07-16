/* eslint-disable */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cliPluginSync,
  cliPluginDiscover,
  parsePluginListOutput,
  parseMarketplaceListOutput,
} from '../src/agent-clis/index.ts';

const FAKE_CLI = join(import.meta.dirname, 'fixtures', 'fake-cli', 'fake-claude.cjs');
const REAL_COPILOT_LIST = readFileSync(
  join(import.meta.dirname, 'fixtures', 'cli-plugin-output', 'copilot-plugin-list.txt'),
  'utf8',
);
const REAL_COPILOT_MP_LIST = readFileSync(
  join(import.meta.dirname, 'fixtures', 'cli-plugin-output', 'copilot-marketplace-list.txt'),
  'utf8',
);

function mkBinding(opts = {}) {
  return {
    binary: process.execPath,
    argsPrefix: [FAKE_CLI],
    pluginCacheDir: opts.cacheDir || mkdtempSync(join(tmpdir(), 'fake-cache-')),
  };
}

function mkPlugin(name) {
  return {
    id: name,
    manifest: { name },
  };
}

function readCalls(stateDir) {
  const p = join(stateDir, 'calls.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function withFakeEnv(envOverlay, fn) {
  const saved = {};
  for (const k of Object.keys(envOverlay)) {
    saved[k] = process.env[k];
    if (envOverlay[k] === undefined) delete process.env[k];
    else process.env[k] = envOverlay[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const ctx = {}; // helpers ignore ctx

test('parsePluginListOutput parses real copilot output (ANSI/unicode-tolerant)', () => {
  const rows = parsePluginListOutput(REAL_COPILOT_LIST);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'superpowers', marketplace: 'superpowers-marketplace', version: '5.1.0' });
  assert.deepEqual(rows[1], { name: 'calls', marketplace: 'example-plugins', version: '1.4.0' });
});

test('parseMarketplaceListOutput parses real copilot marketplace list', () => {
  const ids = parseMarketplaceListOutput(REAL_COPILOT_MP_LIST);
  assert.ok(ids.includes('superpowers-marketplace'));
  assert.ok(ids.includes('example-plugins'));
});

test('parsePluginListOutput tolerates ANSI escape codes', () => {
  const ansiOut = '\u001b[1mInstalled plugins:\u001b[0m\n  \u001b[32m•\u001b[0m foo@bar (v1.2.3)\n';
  assert.deepEqual(parsePluginListOutput(ansiOut), [
    { name: 'foo', marketplace: 'bar', version: '1.2.3' },
  ]);
});

test('cliPluginSync: installs missing marketplace + missing plugin', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-state-'));
  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: '[]',
      FAKE_CLI_MARKETPLACES: '[]',
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [mkPlugin('myplugin')],
          marketplaces: [{ id: 'my-market', kind: 'git', source: 'https://example.com/m.git' }],
        },
        mkBinding(),
      );
      assert.deepEqual(report.marketplacesAdded, ['my-market']);
      assert.deepEqual(report.marketplacesPresent, []);
      assert.deepEqual(report.pluginsInstalled, ['myplugin@my-market']);
      assert.deepEqual(report.pluginsPresent, []);
      assert.deepEqual(report.failed, []);
      const calls = readCalls(stateDir);
      assert.equal(calls.filter((c) => c.action === 'marketplace-add').length, 1);
      assert.deepEqual(calls.find((c) => c.action === 'marketplace-add').args, [
        'https://example.com/m.git',
      ]);
      assert.equal(calls.filter((c) => c.action === 'install').length, 1);
      assert.deepEqual(calls.find((c) => c.action === 'install').args, ['myplugin@my-market']);
    },
  );
});

test('cliPluginSync: marketplace + plugin already present -> no install calls', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-state-'));
  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: JSON.stringify([
        { name: 'myplugin', marketplace: 'my-market', version: '1.0.0' },
      ]),
      FAKE_CLI_MARKETPLACES: JSON.stringify(['my-market']),
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [mkPlugin('myplugin')],
          marketplaces: [{ id: 'my-market', kind: 'git', source: 'https://example.com/m.git' }],
        },
        mkBinding(),
      );
      assert.deepEqual(report.marketplacesPresent, ['my-market']);
      assert.deepEqual(report.pluginsPresent, ['myplugin@my-market']);
      assert.deepEqual(report.marketplacesAdded, []);
      assert.deepEqual(report.pluginsInstalled, []);
      const calls = readCalls(stateDir);
      assert.deepEqual(
        calls.filter((c) => c.action === 'install' || c.action === 'marketplace-add'),
        [],
      );
    },
  );
});

test('cliPluginSync: plugin install error is captured in failed[]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-state-'));
  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: '[]',
      FAKE_CLI_MARKETPLACES: JSON.stringify(['market']),
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [mkPlugin('fail')],
          // The plugin is pushed via the 'market' marketplace which clawdevbox
          // manages; this is what determines the install source.
          marketplaces: [{ id: 'market', kind: 'git', source: 'https://example.com/m.git' }],
        },
        mkBinding(),
      );
      assert.equal(report.failed.length, 1);
      assert.equal(report.failed[0].kind, 'plugin');
      assert.equal(report.failed[0].id, 'fail@market');
      assert.match(report.failed[0].error, /mock plugin install failure/);
    },
  );
});

test('cliPluginSync: bidirectional uninstall removes plugins no longer in clawdevbox', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-state-'));
  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: JSON.stringify([
        { name: 'keep', marketplace: 'my-market', version: '1.0.0' },
        { name: 'remove-me', marketplace: 'my-market', version: '1.0.0' },
        { name: 'user-installed', marketplace: 'other-market', version: '1.0.0' },
      ]),
      FAKE_CLI_MARKETPLACES: JSON.stringify(['my-market']),
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [mkPlugin('keep')],
          marketplaces: [{ id: 'my-market', kind: 'git', source: 'https://example.com/m.git' }],
        },
        mkBinding(),
      );
      // 'keep' is already installed
      assert.deepEqual(report.pluginsPresent, ['keep@my-market']);
      // 'remove-me' from my-market should be uninstalled
      assert.deepEqual(report.pluginsUninstalled, ['remove-me@my-market']);
      const calls = readCalls(stateDir);
      const uninstallCalls = calls.filter((c) => c.action === 'uninstall');
      assert.equal(uninstallCalls.length, 1);
      assert.deepEqual(uninstallCalls[0].args, ['remove-me@my-market']);
      // 'user-installed@other-market' should NOT be uninstalled (other-market is not a clawdevbox marketplace)
      assert.ok(!uninstallCalls.find((c) => c.args[0]?.startsWith('user-installed')));
    },
  );
});

test('cliPluginSync: dryRun reports without making any process calls', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-state-'));
  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: '[]',
      FAKE_CLI_MARKETPLACES: '[]',
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [mkPlugin('myplugin')],
          marketplaces: [{ id: 'my-market', kind: 'git', source: 'https://example.com/m.git' }],
          dryRun: true,
        },
        mkBinding(),
      );
      assert.deepEqual(report.marketplacesAdded, ['my-market']);
      assert.deepEqual(report.pluginsInstalled, ['myplugin@my-market']);
      const calls = readCalls(stateDir);
      assert.deepEqual(
        calls.filter((c) => c.action !== 'noop'),
        [],
        'dryRun should not record any install/add/uninstall calls',
      );
    },
  );
});

test('cliPluginSync: bidirectionalUninstall=false disables uninstall', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-state-'));
  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: JSON.stringify([
        { name: 'remove-me', marketplace: 'my-market', version: '1.0.0' },
      ]),
      FAKE_CLI_MARKETPLACES: JSON.stringify(['my-market']),
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [],
          marketplaces: [{ id: 'my-market', kind: 'git', source: 'https://example.com/m.git' }],
          bidirectionalUninstall: false,
        },
        mkBinding(),
      );
      assert.deepEqual(report.pluginsUninstalled, []);
      const calls = readCalls(stateDir);
      assert.equal(calls.filter((c) => c.action === 'uninstall').length, 0);
    },
  );
});

test('cliPluginDiscover: returns plugins located in pluginCacheDir', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'fake-cache-'));
  // Plant plugin dirs in two layouts: <name>-<mp> and <mp>/<name>.
  const dirA = join(cacheDir, 'plug-a-my-market');
  const dirB = join(cacheDir, 'other-market', 'plug-b');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });

  await withFakeEnv(
    {
      FAKE_CLI_STATE: mkdtempSync(join(tmpdir(), 'fake-state-')),
      FAKE_CLI_INSTALLED_PLUGINS: JSON.stringify([
        { name: 'plug-a', marketplace: 'my-market' },
        { name: 'plug-b', marketplace: 'other-market' },
        { name: 'missing', marketplace: 'gone' },
      ]),
      FAKE_CLI_MARKETPLACES: '[]',
    },
    async () => {
      const discovered = await cliPluginDiscover(ctx, mkBinding({ cacheDir }));
      // 'missing' should be skipped because no on-disk dir exists.
      assert.equal(discovered.length, 2);
      assert.deepEqual(
        discovered.map((d) => d.name).sort(),
        ['plug-a', 'plug-b'],
      );
      const a = discovered.find((d) => d.name === 'plug-a');
      assert.equal(a.absoluteDir, dirA);
      assert.equal(a.marketplaceId, 'my-market');
      assert.equal(a.source, 'cli-marketplace');
      const b = discovered.find((d) => d.name === 'plug-b');
      assert.equal(b.absoluteDir, dirB);
    },
  );
});

test('cliPluginDiscover: returns [] when plugin list fails', async () => {
  await withFakeEnv(
    {
      FAKE_CLI_STATE: mkdtempSync(join(tmpdir(), 'fake-state-')),
      FAKE_CLI_INSTALLED_PLUGINS: '[]',
      FAKE_CLI_MARKETPLACES: '[]',
      FAKE_CLI_FAIL_PLUGIN_LIST: '1',
    },
    async () => {
      const discovered = await cliPluginDiscover(ctx, mkBinding());
      assert.deepEqual(discovered, []);
    },
  );
});

// ============================================================================
// runPluginSync subcommand
// ============================================================================

import { runPluginSync } from '../src/cli/plugin-sync.ts';

function makeProjectTree() {
  const root = mkdtempSync(join(tmpdir(), 'pluginsync-proj-'));
  const globalDir = join(root, '.global');
  mkdirSync(globalDir, { recursive: true });
  return { root, globalDir };
}

test('runPluginSync: --help exits 0 without touching providers', async () => {
  const { root, globalDir } = makeProjectTree();
  const prevProj = process.env.CLAWDEVBOX_PROJECT_DIR;
  const prevGlobal = process.env.CLAWDEVBOX_GLOBAL_DIR;
  process.env.CLAWDEVBOX_PROJECT_DIR = root;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;
  try {
    const r = await runPluginSync(['--help']);
    assert.equal(r.exitCode, 0);
  } finally {
    process.env.CLAWDEVBOX_PROJECT_DIR = prevProj;
    process.env.CLAWDEVBOX_GLOBAL_DIR = prevGlobal;
  }
});

test('runPluginSync: --direction=invalid returns exitCode 2', async () => {
  const { root, globalDir } = makeProjectTree();
  const prevProj = process.env.CLAWDEVBOX_PROJECT_DIR;
  const prevGlobal = process.env.CLAWDEVBOX_GLOBAL_DIR;
  process.env.CLAWDEVBOX_PROJECT_DIR = root;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;
  try {
    const r = await runPluginSync(['--direction=bogus']);
    assert.equal(r.exitCode, 2);
  } finally {
    process.env.CLAWDEVBOX_PROJECT_DIR = prevProj;
    process.env.CLAWDEVBOX_GLOBAL_DIR = prevGlobal;
  }
});

test('runPluginSync: --respect-config + clientSync.mode=off short-circuits', async () => {
  const { root, globalDir } = makeProjectTree();
  // Write a config that disables sync.
  const cfgMod = await import('../src/config.ts');
  cfgMod.writeGlobalConfig(globalDir, {
    version: cfgMod.CONFIG_VERSION,
    global_dir: globalDir,
    client_sync: { mode: 'off' },
  });
  const prevProj = process.env.CLAWDEVBOX_PROJECT_DIR;
  const prevGlobal = process.env.CLAWDEVBOX_GLOBAL_DIR;
  process.env.CLAWDEVBOX_PROJECT_DIR = root;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;
  try {
    const r = await runPluginSync(['--respect-config']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.syncReport, undefined);
  } finally {
    process.env.CLAWDEVBOX_PROJECT_DIR = prevProj;
    process.env.CLAWDEVBOX_GLOBAL_DIR = prevGlobal;
  }
});
