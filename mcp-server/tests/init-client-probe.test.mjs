/* eslint-disable */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceFromEnv } from '../src/workspace.ts';
import { resolveConfig } from '../src/config.ts';
import { probeClientPlugins } from '../src/cli/probe-client-plugins.ts';
import {
  renderPluginCard,
  renderFinalSummary,
  runClientPluginProbePrompt,
} from '../src/cli/init-probe-prompt.ts';

function setupTmpWorkspace() {
  const project = mkdtempSync(join(tmpdir(), 'cdb-probe-'));
  const global = join(project, '.global');
  mkdirSync(global, { recursive: true });
  return { project, global };
}

async function loadEnv() {
  const tmp = setupTmpWorkspace();
  const ws = await loadWorkspaceFromEnv({
    CLAWDEVBOX_PROJECT_DIR: tmp.project,
    CLAWDEVBOX_GLOBAL_DIR: tmp.global,
  });
  // Isolate from real-host provider discovery so probe tests are
  // deterministic regardless of what the dev has installed in
  // ~/.copilot/installed-plugins or ~/.claude/plugins/cache.
  isolateRealProviders(ws);
  const cfg = resolveConfig({ projectDir: tmp.project, globalDir: tmp.global });
  return { ws, cfg, tmp };
}

/**
 * Plant a plugin under `cacheRoot/<plugin-name>` with a clawdevbox.recipes
 * entry and a recipe file that carries a `description`.
 */
function plantPlugin(cacheRoot, name, opts = {}) {
  const dir = join(cacheRoot, name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  const cdx = {};
  if (opts.withRecipe) {
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    writeFileSync(
      join(dir, 'recipes', 'sample.yaml'),
      'description: "Sample recipe description"\nsteps: []\n',
      'utf8',
    );
    cdx.recipes = undefined; // auto-discover
  }
  if (opts.withTrigger) {
    mkdirSync(join(dir, 'triggers'), { recursive: true });
    writeFileSync(
      join(dir, 'triggers', 'watcher.ts'),
      'export default async function watcher() {}\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'triggers', 'watcher.trigger.yaml'),
      'description: "Watches a thing"\ndefault_cron: "*/5 * * * *"\n',
      'utf8',
    );
  }
  if (opts.withSkill) {
    mkdirSync(join(dir, 'skills', 'check-thing'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'check-thing', 'SKILL.md'),
      '---\nname: check-thing\ndescription: "Checks the thing"\n---\n\nbody\n',
      'utf8',
    );
  }
  const manifest = { name };
  if (!opts.noClawdevbox) manifest.clawdevbox = cdx;
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  return dir;
}

function stubProvider(ws, providerId, discovered) {
  const provider = ws.agentCliProviders.get(providerId);
  if (!provider) throw new Error(`provider ${providerId} not registered in workspace`);
  provider.detect = async () => ({ available: true, binary: 'fake', version: '1.0.0' });
  provider.discoverInstalledPlugins = async () => discovered;
}

/**
 * Replace every non-internal provider's discoverInstalledPlugins with one
 * that returns []. Tests then call `stubProvider(ws, 'claude', [...])` to
 * inject the providers they actually want to exercise. Prevents real-host
 * provider discovery (which inspects ~/.copilot/installed-plugins on the
 * dev's machine) from leaking into the test result.
 */
function isolateRealProviders(ws) {
  for (const [, provider] of ws.agentCliProviders) {
    if (provider.internal) continue;
    if (typeof provider.discoverInstalledPlugins === 'function') {
      provider.discoverInstalledPlugins = async () => [];
    }
    // Don't replace detect — the probe filters on detect.available, and we
    // want isolated providers to *not* be probed at all (so set unavailable).
    provider.detect = async () => ({ available: false, reason: 'isolated for test' });
  }
}

test('probeClientPlugins: returns plugins carrying clawdevbox extensions', async () => {
  const { ws, cfg, tmp } = await loadEnv();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cdb-probe-cache-'));
  const dir = plantPlugin(cacheRoot, 'test-plugin', {
    withRecipe: true,
    withTrigger: true,
    withSkill: true,
  });
  stubProvider(ws, 'claude', [
    { name: 'test-plugin', absoluteDir: dir, source: 'cli-cache', marketplaceId: null },
  ]);

  const probed = await probeClientPlugins(ws, cfg);
  assert.equal(probed.length, 1);
  assert.equal(probed[0].pluginName, 'test-plugin');
  assert.equal(probed[0].providerId, 'claude');
  assert.equal(probed[0].clawdevbox.recipes.length, 1);
  assert.equal(probed[0].clawdevbox.recipes[0].id, 'sample');
  assert.equal(
    probed[0].clawdevbox.recipes[0].description,
    'Sample recipe description',
    'recipe description harvested from YAML',
  );
  assert.equal(probed[0].clawdevbox.trigger_types.length, 1);
  assert.equal(probed[0].clawdevbox.trigger_types[0].description, 'Watches a thing');
  assert.equal(probed[0].clawdevbox.trigger_types[0].default_cron, '*/5 * * * *');
  assert.equal(probed[0].clientSide.skills.length, 1);
  assert.equal(probed[0].clientSide.skills[0].id, 'check-thing');
  assert.equal(probed[0].clientSide.skills[0].description, 'Checks the thing');
});

test('probeClientPlugins: skips plugins with no clawdevbox.* extensions', async () => {
  const { ws, cfg } = await loadEnv();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cdb-probe-cache-'));
  // Plugin with only a skill (no clawdevbox block) — must be filtered out.
  const dir = plantPlugin(cacheRoot, 'pure-claude-plugin', {
    withSkill: true,
    noClawdevbox: true,
  });
  stubProvider(ws, 'claude', [
    { name: 'pure-claude-plugin', absoluteDir: dir, source: 'cli-cache', marketplaceId: null },
  ]);

  const probed = await probeClientPlugins(ws, cfg);
  assert.equal(probed.length, 0);
});

test('probeClientPlugins: provider reporting unavailable is skipped', async () => {
  const { ws, cfg } = await loadEnv();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cdb-probe-cache-'));
  const dir = plantPlugin(cacheRoot, 'test-plugin', { withRecipe: true });
  const provider = ws.agentCliProviders.get('claude');
  provider.detect = async () => ({ available: false, reason: 'no binary' });
  provider.discoverInstalledPlugins = async () => [
    { name: 'test-plugin', absoluteDir: dir, source: 'cli-cache', marketplaceId: null },
  ];

  const probed = await probeClientPlugins(ws, cfg);
  assert.equal(probed.length, 0);
});

test('probeClientPlugins: sorts by pluginName', async () => {
  const { ws, cfg } = await loadEnv();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cdb-probe-cache-'));
  const a = plantPlugin(cacheRoot, 'zeta-plugin', { withRecipe: true });
  const b = plantPlugin(cacheRoot, 'alpha-plugin', { withRecipe: true });
  stubProvider(ws, 'claude', [
    { name: 'zeta-plugin', absoluteDir: a, source: 'cli-cache', marketplaceId: null },
    { name: 'alpha-plugin', absoluteDir: b, source: 'cli-cache', marketplaceId: null },
  ]);

  const probed = await probeClientPlugins(ws, cfg);
  assert.equal(probed.length, 2);
  assert.equal(probed[0].pluginName, 'alpha-plugin');
  assert.equal(probed[1].pluginName, 'zeta-plugin');
});

test('probeClientPlugins: per-provider failure does not abort others', async () => {
  const { ws, cfg } = await loadEnv();
  const cacheRoot = mkdtempSync(join(tmpdir(), 'cdb-probe-cache-'));
  const dir = plantPlugin(cacheRoot, 'good-plugin', { withRecipe: true });

  const claude = ws.agentCliProviders.get('claude');
  claude.detect = async () => ({ available: true });
  claude.discoverInstalledPlugins = async () => [
    { name: 'good-plugin', absoluteDir: dir, source: 'cli-cache', marketplaceId: null },
  ];

  const copilot = ws.agentCliProviders.get('copilot');
  copilot.detect = async () => ({ available: true });
  copilot.discoverInstalledPlugins = async () => {
    throw new Error('boom — copilot CLI offline');
  };

  const probed = await probeClientPlugins(ws, cfg);
  // Claude's plugin survived even though Copilot's probe threw.
  assert.equal(probed.length, 1);
  assert.equal(probed[0].pluginName, 'good-plugin');
  assert.equal(probed[0].providerId, 'claude');
});

// ---------------------------------------------------------------------------
// Prompt rendering + interactive loop
// ---------------------------------------------------------------------------

function fakeProbed(overrides = {}) {
  return {
    pluginName: 'ado-pipeline-autodebug',
    pluginDir: '/fake/path/ado-pipeline-autodebug',
    providerId: 'claude',
    manifestPath: '/fake/path/ado-pipeline-autodebug/.claude-plugin/plugin.json',
    clawdevbox: {
      recipes: [
        { id: 'ado.investigate', description: 'Classify ADO pipeline failure.', file: 'recipes/investigate.yaml' },
      ],
      tools: [],
      trigger_types: [
        { id: 'ado.build-watcher', description: 'Watch for failures', default_cron: '*/5 * * * *', file: 'triggers/watcher.ts' },
      ],
      agent_clis: [],
      renderers: [],
    },
    clientSide: {
      skills: [{ id: 'check-build-status', description: 'Check ADO build status' }],
      agents: [],
      commands: [],
      mcpServers: [],
    },
    ...overrides,
  };
}

test('renderPluginCard: contains plugin name, recipe id+description, trigger', () => {
  const card = renderPluginCard(fakeProbed(), 1, 1);
  assert.ok(card.includes('ado-pipeline-autodebug'));
  assert.ok(card.includes('1 of 1'));
  assert.ok(card.includes('Recipes (1)'));
  assert.ok(card.includes('ado.investigate'));
  assert.ok(card.includes('Classify ADO pipeline failure.'));
  assert.ok(card.includes('Trigger types (1)'));
  assert.ok(card.includes('*/5 * * * *'));
  assert.ok(card.includes('check-build-status'));
  // Box drawing borders.
  assert.ok(card.startsWith('┌'));
  assert.ok(card.trimEnd().endsWith('┘'));
});

test('renderPluginCard: omits empty sections', () => {
  const p = fakeProbed({
    clawdevbox: { recipes: [], tools: [], trigger_types: [], agent_clis: [], renderers: [] },
    clientSide: { skills: [], agents: [], commands: [], mcpServers: [] },
  });
  const card = renderPluginCard(p, 1, 1);
  assert.ok(!card.includes('Recipes'));
  assert.ok(!card.includes('Trigger types'));
  assert.ok(!card.includes('Components handled by'));
});

test('renderFinalSummary: lists each selected plugin with provider', () => {
  const sel = [fakeProbed(), fakeProbed({ pluginName: 'calls', providerId: 'copilot' })];
  const out = renderFinalSummary(sel, '/some/path/config.json');
  assert.ok(out.includes('You selected 2'));
  assert.ok(out.includes('ado-pipeline-autodebug'));
  assert.ok(out.includes('(claude)'));
  assert.ok(out.includes('calls'));
  assert.ok(out.includes('(copilot)'));
  assert.ok(out.includes('/some/path/config.json'));
});

test('runClientPluginProbePrompt: auto-yes selects every plugin', async () => {
  const probed = [fakeProbed(), fakeProbed({ pluginName: 'calls', providerId: 'copilot' })];
  const confirmFn = async () => true;
  const selections = await runClientPluginProbePrompt(probed, /*cfg*/ {}, {
    configPath: '/tmp/config.json',
    confirmFn,
    noteFn: () => {},
  });
  assert.deepEqual(selections, [
    { provider: 'claude', name: 'ado-pipeline-autodebug' },
    { provider: 'copilot', name: 'calls' },
  ]);
});

test('runClientPluginProbePrompt: auto-no yields empty selection', async () => {
  const probed = [fakeProbed()];
  const confirmFn = async () => false;
  const selections = await runClientPluginProbePrompt(probed, {}, {
    configPath: '/tmp/config.json',
    confirmFn,
    noteFn: () => {},
  });
  assert.deepEqual(selections, []);
});

test('runClientPluginProbePrompt: preselect populates initialValue from existing discovered_plugins', async () => {
  const probed = [
    fakeProbed({ pluginName: 'ado-pipeline-autodebug', providerId: 'claude' }),
    fakeProbed({ pluginName: 'fresh-plugin', providerId: 'claude' }),
  ];
  const seenInitials = [];
  const confirmFn = async (opts) => {
    // First call is the per-plugin confirm; record initialValue + auto-yes.
    if (opts.message.startsWith('Enable clawdevbox')) {
      seenInitials.push({ message: opts.message, initialValue: opts.initialValue });
      return true;
    }
    // Final summary confirm.
    return true;
  };
  await runClientPluginProbePrompt(probed, {}, {
    configPath: '/tmp/config.json',
    preselect: [{ provider: 'claude', name: 'ado-pipeline-autodebug' }],
    confirmFn,
    noteFn: () => {},
  });
  assert.equal(seenInitials.length, 2);
  // First probed plugin was in preselect → initialValue true.
  assert.equal(seenInitials[0].initialValue, true);
  // Second probed plugin was NOT in preselect → initialValue false.
  assert.equal(seenInitials[1].initialValue, false);
});

test('runClientPluginProbePrompt: empty input returns empty without prompting', async () => {
  let called = false;
  const confirmFn = async () => {
    called = true;
    return true;
  };
  const selections = await runClientPluginProbePrompt([], {}, {
    configPath: '/tmp/config.json',
    confirmFn,
    noteFn: () => {},
  });
  assert.deepEqual(selections, []);
  assert.equal(called, false);
});


