/**
 * migrated-plugins.test.mjs
 *
 * End-to-end smoke for Phase 7 of the marketplace + plugin schema
 * alignment work. Confirms that all five real-world plugins migrated to
 * the Claude-Code-aligned `.claude-plugin/plugin.json` shape
 * (clawdevbox-plugins/{cfv, dgrep, icm, metrics} + agency-provider)
 * load cleanly into a fresh workspace.
 *
 * The test copies each migrated plugin into a tmp <globalDir>/plugins/
 * tree, calls `loadWorkspaceFromEnv`, and asserts that:
 *   - all 5 plugin manifests parsed and registered with status='enabled',
 *   - the agency-provider's clawdevbox.agent_clis[] entry registered
 *     under ws.agentCliProviders.get('agency'),
 *   - no entries landed in ws.agentCliProviderErrors,
 *   - each plugin contributed at least one capability of its expected
 *     family (skill / recipe / tool / trigger type / provider).
 *
 * Skipped gracefully on machines that don't have the external repos
 * cloned alongside clawdevbox. Set CLAWDEVBOX_MIGRATED_E2E_SKIP=1 to
 * force-skip regardless.
 *
 *   node --test tests/migrated-plugins.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const EXTERNAL_PLUGINS = process.env.CLAWDEVBOX_PLUGINS_SRC
  ?? resolve(projectRoot, '..', '..', 'clawdevbox-plugins');
const AGENCY_PROVIDER = process.env.CLAWDEVBOX_AGENCY_PROVIDER_SRC
  ?? resolve(projectRoot, '..', '..', 'agency-provider');

const SAMPLE_PLUGINS = ['cfv', 'dgrep', 'icm', 'metrics'];

function externalPluginsAvailable() {
  if (process.env.CLAWDEVBOX_MIGRATED_E2E_SKIP === '1') return false;
  if (!existsSync(EXTERNAL_PLUGINS) || !existsSync(AGENCY_PROVIDER)) return false;
  for (const name of SAMPLE_PLUGINS) {
    if (!existsSync(join(EXTERNAL_PLUGINS, name, '.claude-plugin', 'plugin.json'))) return false;
  }
  if (!existsSync(join(AGENCY_PROVIDER, '.claude-plugin', 'plugin.json'))) return false;
  return true;
}

const SKIP = !externalPluginsAvailable();

test('migrated sample plugins all load via Claude manifest', { skip: SKIP }, async () => {
  // Lazy-import so the file parses even without external clones.
  const wsMod = await import(
    pathToFileURL(resolve(projectRoot, 'src/workspace.ts')).href
  );

  const root = mkdtempSync(join(tmpdir(), 'cdb-migrated-e2e-'));
  const project = join(root, 'project');
  const global = join(root, '.global');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(global, 'plugins'), { recursive: true });

  // Filter to skip recursing into node_modules / .git to keep this fast
  // and avoid copying the entire dev tree.
  const filter = (src) => {
    const base = src.split(/[\\/]/).pop();
    if (!base) return true;
    if (base === 'node_modules' || base === '.git') return false;
    return true;
  };

  try {
    for (const name of SAMPLE_PLUGINS) {
      cpSync(join(EXTERNAL_PLUGINS, name), join(global, 'plugins', name), {
        recursive: true,
        filter,
      });
    }
    cpSync(AGENCY_PROVIDER, join(global, 'plugins', 'agency-cli'), {
      recursive: true,
      filter,
    });

    const ws = await wsMod.loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: project,
      CLAWDEVBOX_GLOBAL_DIR: global,
    });

    const expectedIds = [...SAMPLE_PLUGINS, 'agency-cli'];
    assert.equal(
      ws.plugins.size,
      expectedIds.length,
      `expected ${expectedIds.length} plugins, got ${ws.plugins.size}: ${[...ws.plugins.keys()].join(',')}`,
    );

    for (const id of expectedIds) {
      const p = ws.plugins.get(id);
      assert.ok(p, `plugin '${id}' should be loaded`);
      assert.equal(
        p.status,
        'enabled',
        `plugin '${id}' should be enabled (status='${p.status}', error='${p.error ?? ''}')`,
      );
    }

    // Agency provider registered + no provider load errors.
    assert.ok(
      ws.agentCliProviders.has('agency'),
      'agency provider should be registered from agency-cli plugin',
    );
    assert.deepEqual(
      ws.agentCliProviderErrors,
      [],
      `expected no agent-cli provider errors, got ${JSON.stringify(ws.agentCliProviderErrors)}`,
    );

    // Soft per-plugin capability assertions — each migrated sample
    // should contribute something on its primary capability axis. The
    // exact ids vary as the upstream plugins evolve, so we just check
    // that *at least one* of each expected family loaded.
    const cfv = ws.plugins.get('cfv');
    assert.ok(
      (cfv.manifest?.clawdevbox?.tools ?? []).length > 0,
      'cfv plugin should declare clawdevbox.tools[]',
    );
    assert.ok(
      (cfv.manifest?.clawdevbox?.recipes ?? []).length > 0,
      'cfv plugin should declare clawdevbox.recipes[]',
    );

    // icm/dgrep/metrics each declare at least one trigger type. Check
    // through ws.triggerTypes so we exercise the real registration
    // path (not just the parsed manifest).
    const triggerTypeIds = [...ws.triggerTypes.keys()];
    for (const pluginId of ['icm', 'dgrep', 'metrics']) {
      const matched = triggerTypeIds.filter((tid) => tid.startsWith(`${pluginId}.`));
      assert.ok(
        matched.length > 0,
        `expected ${pluginId} plugin to register at least one ${pluginId}.* trigger type; got triggerTypes: ${triggerTypeIds.join(',')}`,
      );
    }

    const agency = ws.plugins.get('agency-cli');
    assert.equal(
      (agency.manifest?.clawdevbox?.agent_clis ?? []).length,
      1,
      'agency-cli should declare exactly one clawdevbox.agent_clis[] entry',
    );
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* tolerate */ }
  }
});
