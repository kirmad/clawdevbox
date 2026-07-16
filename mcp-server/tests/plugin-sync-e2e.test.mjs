/* eslint-disable */
/**
 * E2E smoke for the bidirectional plugin-sync surface.
 *
 * Exercises the same code paths `clawdevbox plugin sync` exercises
 * (cliPluginSync / cliPluginDiscover) against the Phase-1 fake-CLI
 * fixtures by actually spawning a Node subprocess and parsing its
 * real stdout. The copilot provider's resolveBinary() honors
 * CLAWDEVBOX_COPILOT_PATH on POSIX (where a shebang-marked .cjs is
 * directly executable), but on Windows spawn() with shell:false
 * cannot exec a .cjs/.cmd file directly — these tests therefore
 * build the PluginCliBinding manually (binary=process.execPath,
 * argsPrefix=[fakeCliPath]) which is portable to both platforms and
 * still spawns the fake CLI as a real subprocess.
 *
 * The runPluginSync CLI entry point itself is covered by
 * cli-plugin-sync.test.mjs (parser, dry-run reporting, exit codes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cliPluginSync,
  cliPluginDiscover,
} from '../src/agent-clis/index.ts';

const FAKE_COPILOT = join(import.meta.dirname, 'fixtures', 'fake-cli', 'fake-copilot.cjs');

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mkBinding(cacheDir, stateDir) {
  return {
    binary: process.execPath,
    argsPrefix: [FAKE_COPILOT],
    pluginCacheDir: cacheDir,
    __stateDir: stateDir,
  };
}

function readCalls(stateDir) {
  const p = join(stateDir, 'calls.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function withFakeEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const ctx = {}; // helpers ignore ctx

// ---------------------------------------------------------------------------

test('e2e plugin sync push (dry-run): plans install against fake CLI, records no calls', async () => {
  const stateDir = mkTmp('e2e-push-dry-');
  const cacheDir = mkTmp('e2e-cache-');
  const globalDir = mkTmp('e2e-global-');

  // Install one clawdevbox plugin under <globalDir>/plugins/test-plugin/
  const pluginDir = join(globalDir, 'plugins', 'test-plugin');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'test-plugin',
      version: '1.0.0',
      description: 'e2e fixture plugin',
      clawdevbox: { tools: [] },
    }),
  );

  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: '[]',
      FAKE_CLI_MARKETPLACES: JSON.stringify(['test-mp']),
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [
            { id: 'test-plugin', manifest: { name: 'test-plugin', version: '1.0.0' } },
          ],
          marketplaces: [
            { id: 'test-mp', kind: 'git', source: 'https://example.com/test-mp.git' },
          ],
          dryRun: true,
        },
        mkBinding(cacheDir, stateDir),
      );

      // Dry-run plans the install of `test-plugin@test-mp` …
      assert.ok(
        report.pluginsInstalled.some((s) => s.includes('test-plugin@test-mp')),
        `expected planned install for test-plugin@test-mp; got ${JSON.stringify(report.pluginsInstalled)}`,
      );
      assert.deepEqual(report.marketplacesPresent, ['test-mp']);
      assert.equal(report.failed.length, 0);

      // …but NO install/marketplace-add/uninstall call was recorded.
      const calls = readCalls(stateDir);
      const mutating = calls.filter((c) =>
        c.action === 'install' || c.action === 'marketplace-add' || c.action === 'uninstall',
      );
      assert.deepEqual(mutating, [], 'dry-run must not record mutating calls');
    },
  );

  // Cleanup tmp dirs (best-effort).
  for (const d of [stateDir, cacheDir, globalDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------

test('e2e plugin sync pull: discoverInstalledPlugins surfaces planted plugin', async () => {
  const stateDir = mkTmp('e2e-pull-');
  const cacheDir = mkTmp('e2e-cache-');

  // Plant a fake plugin in the CLI plugin cache. Use the `<name>-<marketplace>/`
  // layout the copilot provider uses on disk.
  const pluginDir = join(cacheDir, 'test-plugin-test-mp');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'test-plugin',
      version: '1.2.3',
      description: 'discovered fixture',
      clawdevbox: {
        tools: [{ id: 'test-plugin.hello', file: 'tools/hello.ts', runtime: 'tsx' }],
      },
    }),
  );

  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: JSON.stringify([
        { name: 'test-plugin', marketplace: 'test-mp', version: '1.2.3' },
      ]),
      FAKE_CLI_MARKETPLACES: JSON.stringify(['test-mp']),
    },
    async () => {
      const discovered = await cliPluginDiscover(ctx, mkBinding(cacheDir, stateDir));
      assert.equal(discovered.length, 1, 'expected exactly one discovered plugin');
      assert.equal(discovered[0].name, 'test-plugin');
      assert.equal(discovered[0].marketplaceId, 'test-mp');
      assert.equal(discovered[0].source, 'cli-marketplace');
      assert.equal(discovered[0].absoluteDir, pluginDir);
    },
  );

  for (const d of [stateDir, cacheDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------

test('e2e plugin sync push (not dry-run): records install call against fake CLI', async () => {
  const stateDir = mkTmp('e2e-push-real-');
  const cacheDir = mkTmp('e2e-cache-');

  await withFakeEnv(
    {
      FAKE_CLI_STATE: stateDir,
      FAKE_CLI_INSTALLED_PLUGINS: '[]',
      FAKE_CLI_MARKETPLACES: JSON.stringify(['test-mp']),
    },
    async () => {
      const report = await cliPluginSync(
        ctx,
        {
          plugins: [
            { id: 'test-plugin', manifest: { name: 'test-plugin', version: '1.0.0' } },
          ],
          marketplaces: [
            { id: 'test-mp', kind: 'git', source: 'https://example.com/test-mp.git' },
          ],
        },
        mkBinding(cacheDir, stateDir),
      );

      assert.deepEqual(report.marketplacesPresent, ['test-mp']);
      assert.ok(
        report.pluginsInstalled.some((s) => s.includes('test-plugin@test-mp')),
        `expected an installed entry for test-plugin@test-mp; got ${JSON.stringify(report.pluginsInstalled)}`,
      );
      assert.equal(report.failed.length, 0);

      const calls = readCalls(stateDir);
      const installCalls = calls.filter((c) => c.action === 'install');
      assert.equal(installCalls.length, 1, 'expected exactly one install call');
      assert.deepEqual(installCalls[0].args, ['test-plugin@test-mp']);
    },
  );

  for (const d of [stateDir, cacheDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
