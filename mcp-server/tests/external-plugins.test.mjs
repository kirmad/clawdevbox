/**
 * external-plugins.test.mjs
 *
 * Verifies the `clawdevbox init --plugin <folder>` install path end-to-end
 * by exercising the helpers in src/cli/plugin-sources.ts against the
 * sibling `clawdevbox-plugins` directory (icm / cfv / metrics / dgrep)
 * and then booting the MCP server to confirm tools, skills, recipes,
 * and trigger types from every installed plugin load correctly.
 *
 * If the sibling directory isn't present (e.g. running on a CI box that
 * hasn't cloned the plugins repo) the test is skipped — the path is
 * configurable via CLAWDEVBOX_PLUGINS_SRC.
 *
 *   node --test tests/external-plugins.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/index.ts');

const pluginsSrc = resolve(
  process.env.CLAWDEVBOX_PLUGINS_SRC ?? resolve(projectRoot, '..', '..', 'clawdevbox-plugins'),
);

const sourcesModuleUrl = pathToFileURL(
  resolve(projectRoot, 'src/cli/plugin-sources.ts'),
).href;

/**
 * Expected plugin shape per id. Used to assert plugin.list + tools/list +
 * skill.list + recipe.list + trigger.list_types after install. Numbers
 * are lower bounds — exact counts may grow as the plugins evolve in the
 * external repo; we just need every category to round-trip.
 */
const EXPECTED = {
  icm: {
    sampleTools: ['icm.list_incidents', 'icm.get_incident', 'icm.ack_incident'],
    sampleSkills: ['icm-investigator', 'incident-handoff'],
    sampleRecipes: ['triage-incident', 'mitigate-incident'],
    sampleTriggerTypes: ['icm.new-incident-watcher'],
  },
  cfv: {
    sampleTools: ['cfv.fetch_call', 'cfv.get_flow', 'cfv.list_cached_calls'],
    sampleSkills: ['cfv-analyzer'],
    sampleRecipes: ['analyze-call'],
    sampleTriggerTypes: [],
  },
  metrics: {
    sampleTools: ['metrics.query', 'metrics.list_dashboards', 'metrics.get_top_hints'],
    sampleSkills: ['metrics-explorer'],
    sampleRecipes: ['metrics-anomaly-check'],
    sampleTriggerTypes: ['metrics.anomaly-watcher'],
  },
  dgrep: {
    sampleTools: ['dgrep.search', 'dgrep.start_search', 'dgrep.list_namespaces'],
    sampleSkills: ['dgrep-investigator'],
    sampleRecipes: ['investigate-logs'],
    sampleTriggerTypes: ['dgrep.error-watcher'],
  },
};

class ServerHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-external-plugins-'));
    // Project tree: recipes/skills/triggers/artifacts only; plugins are
    // global now.
    const clawdevbox = join(this.tmpRoot, '.clawdevbox');
    for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
      mkdirSync(join(clawdevbox, sub), { recursive: true });
    }
    this.globalDir = join(this.tmpRoot, '.global');
    mkdirSync(join(this.globalDir, 'plugins'), { recursive: true });

    // Plugin hostable tools `import { z } from 'zod'`. Junction the server's
    // deps into the global plugin store so Node walks up from
    // <globalDir>/plugins/<id>/tools/foo.ts and finds them.
    const globalNodeModules = join(this.globalDir, 'node_modules');
    if (!existsSync(globalNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      try {
        symlinkSync(resolve(projectRoot, 'node_modules'), globalNodeModules, linkType);
      } catch {
        /* EPERM — surfaces as a hosted-tool import error below if it matters */
      }
    }
  }

  async installPlugins(plugins) {
    const mod = await import(sourcesModuleUrl);
    for (const p of plugins) {
      mod.installPluginFromDir({
        globalDir: this.globalDir,
        plugin: p,
        origin: pluginsSrc,
        source: {
          origin: pluginsSrc,
          dir: pluginsSrc,
          isGitClone: false,
          isLocalFolder: true,
          cleanup() {},
        },
      });
    }
  }

  spawnServer() {
    this.child = spawn('npx', ['tsx', entry, 'mcp'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CLAWDEVBOX_PROJECT_DIR: this.tmpRoot,
        CLAWDEVBOX_GLOBAL_DIR: this.globalDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    this.stdoutBuf = '';
    this.responses = [];
    this.nextId = 1;
    this.child.stdout.on('data', (d) => {
      this.stdoutBuf += d.toString('utf8');
      let nl;
      while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          this.responses.push(JSON.parse(line));
        } catch {
          /* ignore non-JSON pre-boot noise */
        }
      }
    });
    this.child.stderr.on('data', () => {});
  }

  async waitFor(id, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for id=${id}`);
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async init() {
    await new Promise((r) => setTimeout(r, 1200));
    const id = this.nextId++;
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'external-plugins', version: '0' },
      },
    });
    await this.waitFor(id);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  async listTools() {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    const resp = await this.waitFor(id);
    return resp.result?.tools ?? [];
  }

  async call(name, args) {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const resp = await this.waitFor(id);
    return resp.result;
  }

  shutdown() {
    if (this.child && !this.child.killed) {
      try {
        if (platform() === 'win32' && this.child.pid) {
          spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          this.child.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }
    try { this.child?.stdin?.destroy(); } catch { /* ignore */ }
    try { this.child?.stdout?.destroy(); } catch { /* ignore */ }
    try { this.child?.stderr?.destroy(); } catch { /* ignore */ }
    if (existsSync(this.tmpRoot)) {
      try { rmSync(this.tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test('external clawdevbox-plugins folder install + load', { skip: !existsSync(pluginsSrc) && `clawdevbox-plugins source missing at ${pluginsSrc}` }, async (t) => {
  // 1) Helpers behave correctly against the local folder.
  const mod = await import(sourcesModuleUrl);

  await t.test('resolvePluginSource on local folder returns it as-is', async () => {
    const r = mod.resolvePluginSource(pluginsSrc);
    try {
      assert.equal(r.isGitClone, false, 'local folder must not be cloned');
      assert.equal(r.dir, pluginsSrc, 'resolved dir must equal source');
    } finally {
      r.cleanup();
    }
  });

  let discovered;
  await t.test('discoverPluginsInDir finds icm/cfv/metrics/dgrep', async () => {
    const result = mod.discoverPluginsInDir(pluginsSrc);
    assert.equal(result.errors.length, 0, `discovery errors: ${JSON.stringify(result.errors)}`);
    const ids = result.plugins.map((p) => p.id).sort();
    for (const expected of ['cfv', 'dgrep', 'icm', 'metrics']) {
      assert.ok(ids.includes(expected), `expected ${expected} in discovered ids: ${ids.join(', ')}`);
    }
    discovered = result.plugins;
  });

  // 2) Boot an MCP server pointed at a temp project with the four
  //    plugins installed via the new helpers, and verify each plugin
  //    contributes the expected tools/skills/recipes/trigger_types.
  const h = new ServerHarness();
  t.after(() => h.shutdown());

  await t.test('installPluginFromDir installs each plugin into the global store', () => {
    for (const p of discovered.filter((x) => EXPECTED[x.id])) {
      const dest = join(h.globalDir, 'plugins', p.id);
      const r = mod.installPluginFromDir({
        globalDir: h.globalDir,
        plugin: p,
        origin: pluginsSrc,
        source: {
          origin: pluginsSrc,
          dir: pluginsSrc,
          isGitClone: false,
          isLocalFolder: true,
          cleanup() {},
        },
      });
      assert.equal(r.destination, dest);
      assert.equal(r.copied, true, `${p.id} should have been installed`);
      assert.equal(r.kind, 'local', `${p.id} from a local folder should record kind=local`);
      assert.ok(existsSync(join(dest, '.claude-plugin', 'plugin.json')));
      // Sidecar install record lives next to the plugin, not inside it.
      const sidecar = join(h.globalDir, 'plugins', `${p.id}.install.json`);
      assert.ok(existsSync(sidecar), `sidecar install.json missing for ${p.id}`);
      const installJson = JSON.parse(readFileSync(sidecar, 'utf8'));
      assert.equal(installJson.kind, 'local');
      assert.equal(installJson.from, p.dir); // local installs record the folder path
    }
  });

  h.spawnServer();
  await h.init();

  await t.test('plugin.list shows all four external plugins', async () => {
    const result = await h.call('plugin.list', {});
    const plugins = result?.structuredContent?.plugins ?? [];
    const ids = plugins.map((p) => p.id);
    for (const expected of Object.keys(EXPECTED)) {
      assert.ok(ids.includes(expected), `${expected} missing from plugin.list: ${ids.join(', ')}`);
      const entry = plugins.find((p) => p.id === expected);
      assert.equal(entry.status, 'enabled', `${expected} status was ${entry.status} (${entry.error ?? 'no error'})`);
    }
  });

  await t.test('tools/list exposes hostable tools from every plugin', async () => {
    const tools = await h.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const [id, exp] of Object.entries(EXPECTED)) {
      for (const tool of exp.sampleTools) {
        assert.ok(names.has(tool), `${id} tool ${tool} not in tools/list`);
      }
    }
  });

  await t.test('skill.list exposes skills from every plugin', async () => {
    const result = await h.call('skill.list', {});
    const skills = result?.structuredContent?.skills ?? [];
    const ids = new Set(skills.map((s) => s.id));
    for (const [id, exp] of Object.entries(EXPECTED)) {
      for (const skill of exp.sampleSkills) {
        assert.ok(ids.has(skill), `${id} skill ${skill} not in skill.list`);
      }
    }
  });

  await t.test('recipe.list exposes recipes from every plugin', async () => {
    const result = await h.call('recipe.list', {});
    const recipes = result?.structuredContent?.recipes ?? [];
    const ids = new Set(recipes.map((r) => r.id));
    for (const [id, exp] of Object.entries(EXPECTED)) {
      for (const recipe of exp.sampleRecipes) {
        assert.ok(ids.has(recipe), `${id} recipe ${recipe} not in recipe.list`);
      }
    }
  });

  await t.test('trigger.list_types exposes types from plugins that ship them', async () => {
    const result = await h.call('trigger.list_types', {});
    const types = result?.structuredContent?.trigger_types ?? [];
    const ids = new Set(types.map((t) => t.id));
    for (const [pluginId, exp] of Object.entries(EXPECTED)) {
      for (const type of exp.sampleTriggerTypes) {
        assert.ok(ids.has(type), `${pluginId} trigger type ${type} not in trigger.list_types`);
      }
    }
  });
});
