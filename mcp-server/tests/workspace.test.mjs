/**
 * workspace.test.mjs
 *
 * node:test suite for the workspace.* and recipe.run/.done/.instance_info
 * surface added in the mission-control redesign. Boots an isolated harness
 * with CLAWDEVBOX_PROJECT_DIR and CLAWDEVBOX_WORKSPACES_ROOT pointing at temp
 * directories — no host-filesystem side effects.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/index.ts');
const repoSampleAdoPlugin = resolve(projectRoot, '..', 'plugins', 'ado');
const repoSampleSimplePromptRecipe = resolve(
  projectRoot,
  '..',
  'samples',
  'recipes',
  'simple-prompt.yaml',
);

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

class WsHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-ws-smoke-'));
    // The "calling" workspace (CLAWDEVBOX_PROJECT_DIR points here).
    this.callerProjectDir = join(this.tmpRoot, 'caller');
    const callerClawdevbox = join(this.callerProjectDir, '.clawdevbox');
    mkdirSync(callerClawdevbox, { recursive: true });
    for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
      mkdirSync(join(callerClawdevbox, sub), { recursive: true });
    }
    // Drop the simple-prompt recipe in the caller's project scope so recipe.read
    // resolves it.
    cpSync(repoSampleSimplePromptRecipe, join(callerClawdevbox, 'recipes', 'simple-prompt.yaml'));

    // Plugins now live in the global store — install the ADO plugin there.
    this.globalDir = join(this.tmpRoot, '.global');
    const globalAdoPluginDest = join(this.globalDir, 'plugins', 'ado');
    mkdirSync(dirname(globalAdoPluginDest), { recursive: true });
    cpSync(repoSampleAdoPlugin, globalAdoPluginDest, {
      recursive: true,
      filter: (src) =>
        !src.includes('node_modules') &&
        !src.endsWith('package-lock.json') &&
        !src.includes('_legacy-mcp-server'),
    });
    this.workspacesRoot = join(this.tmpRoot, '.workspaces');
    mkdirSync(this.workspacesRoot, { recursive: true });

    // Junction node_modules into the global dir so the ADO plugin's hostable
    // tools resolve via Node's ESM walk-up from <globalDir>/plugins/ado/.
    const globalNodeModules = join(this.globalDir, 'node_modules');
    if (!existsSync(globalNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      symlinkSync(resolve(projectRoot, 'node_modules'), globalNodeModules, linkType);
    }

    this.serverEnv = {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: this.callerProjectDir,
      CLAWDEVBOX_GLOBAL_DIR: this.globalDir,
      CLAWDEVBOX_WORKSPACES_ROOT: this.workspacesRoot,
    };

    this.child = spawn('npx', ['tsx', entry, 'mcp'], {
      cwd: projectRoot,
      env: this.serverEnv,
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
          /* ignore */
        }
      }
    });
    this.child.stderr.on('data', () => {
      /* swallow */
    });
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
        clientInfo: { name: 'ws-smoke', version: '0' },
      },
    });
    await this.waitFor(id);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }

  async call(name, args) {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const resp = await this.waitFor(id);
    return resp.result;
  }

  async listTools() {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    const resp = await this.waitFor(id);
    return resp.result?.tools ?? [];
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

test('workspace + recipe.run surface', async (t) => {
  const h = new WsHarness();
  t.after(() => h.shutdown());
  await h.init();

  await t.test('tools/list registers the four workspace tools and the three recipe-run tools', async () => {
    const tools = await h.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'workspace.create',
      'workspace.list',
      'workspace.get',
      'workspace.current',
      'recipe.run',
      'recipe.done',
      'recipe.instance_info',
    ]) {
      assert.ok(names.includes(n), `missing tool: ${n}`);
    }
  });

  let firstWorkspaceId = null;
  let firstWorkspacePath = null;

  await t.test('workspace.create scaffolds the .clawdevbox tree and registers the workspace', async () => {
    const res = await h.call('workspace.create', { name: 'test-ws' });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.ok(typeof sc.id === 'string' && sc.id.startsWith('ws_'), `bad id: ${sc.id}`);
    assert.ok(existsSync(sc.path), `workspace path missing: ${sc.path}`);
    // Plugins are global now — workspace.create scaffolds only the
    // per-workspace subtrees.
    for (const sub of ['recipes', 'skills', 'recipe-instances']) {
      assert.ok(
        existsSync(join(sc.path, '.clawdevbox', sub)),
        `missing .clawdevbox/${sub}`,
      );
    }
    assert.ok(
      !existsSync(join(sc.path, '.clawdevbox', 'plugins')),
      'workspace.create must NOT create a per-workspace plugins/ dir (plugins are global)',
    );
    assert.ok(existsSync(join(sc.path, '.clawdevbox', 'triggers.json')));
    assert.ok(existsSync(join(sc.path, '.clawdevbox', 'workspace.json')));
    const meta = JSON.parse(readFileSync(join(sc.path, '.clawdevbox', 'workspace.json'), 'utf8'));
    assert.equal(meta.id, sc.id);
    assert.equal(meta.name, 'test-ws');
    const triggers = JSON.parse(readFileSync(join(sc.path, '.clawdevbox', 'triggers.json'), 'utf8'));
    assert.deepEqual(triggers, { registered: [] });
    // Registry should reflect this workspace.
    const idxPath = join(h.workspacesRoot, 'index.json');
    assert.ok(existsSync(idxPath));
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    assert.ok(idx.workspaces[sc.id]);
    firstWorkspaceId = sc.id;
    firstWorkspacePath = sc.path;
  });

  await t.test('workspace.create with inherit_plugins is a no-op now that plugins are global', async () => {
    const res = await h.call('workspace.create', { name: 'with-plugins', inherit_plugins: true });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    // Plugins are visible globally — no per-workspace inheritance happens
    // anymore. Response shape is preserved (empty array).
    assert.ok(Array.isArray(sc.inherited_plugins));
    assert.equal(sc.inherited_plugins.length, 0, 'inherit_plugins should be a no-op under the global plugin store');
    assert.ok(
      !existsSync(join(sc.path, '.clawdevbox', 'plugins')),
      'no per-workspace plugins/ tree should be created',
    );
  });

  await t.test('workspace.create with copy_from clones the source workspace .clawdevbox/ tree', async () => {
    // Pre-populate the first workspace with an extra file under .clawdevbox/
    // so we can verify copy_from picked it up.
    const sourceCustomFile = join(firstWorkspacePath, '.clawdevbox', 'custom-marker.txt');
    writeFileSync(sourceCustomFile, 'hello from source\n', 'utf8');

    const res = await h.call('workspace.create', { name: 'cloned', copy_from: firstWorkspaceId });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.ok(Array.isArray(sc.copied_from_subtrees));
    // Both the standard tree and our custom marker should be present.
    assert.ok(existsSync(join(sc.path, '.clawdevbox', 'custom-marker.txt')));
    // recipe-instances and workspace.json must be regenerated (not copied raw).
    const meta = JSON.parse(readFileSync(join(sc.path, '.clawdevbox', 'workspace.json'), 'utf8'));
    assert.equal(meta.id, sc.id, 'workspace.json id must be the new id, not the source');
  });

  await t.test('workspace.create rejects inherit_plugins + copy_from together', async () => {
    const res = await h.call('workspace.create', {
      inherit_plugins: true,
      copy_from: firstWorkspaceId,
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'INVALID_ARGS');
  });

  await t.test('workspace.list returns all created workspaces', async () => {
    const res = await h.call('workspace.list', {});
    assert.ok(!res.isError);
    const workspaces = res.structuredContent?.workspaces ?? [];
    assert.ok(workspaces.length >= 3, `expected >=3 workspaces, got ${workspaces.length}`);
    assert.ok(workspaces.some((w) => w.id === firstWorkspaceId));
  });

  await t.test('workspace.get returns full info + counts', async () => {
    const res = await h.call('workspace.get', { id: firstWorkspaceId });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.equal(sc.id, firstWorkspaceId);
    assert.equal(sc.dir_exists, true);
    assert.equal(typeof sc.counts.plugins, 'number');
    assert.equal(typeof sc.counts.recipes, 'number');
    assert.equal(typeof sc.counts.skills, 'number');
    assert.equal(typeof sc.counts.registered_triggers, 'number');
  });

  await t.test('workspace.get returns WORKSPACE_NOT_FOUND for unknown id', async () => {
    const res = await h.call('workspace.get', { id: 'ws_nope_dead' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'WORKSPACE_NOT_FOUND');
  });

  await t.test('workspace.current returns found:false when CLAWDEVBOX_PROJECT_DIR is not registered', async () => {
    // The harness's CLAWDEVBOX_PROJECT_DIR is the caller dir, which is NOT
    // registered in the workspaces index (we only register workspaces created
    // via workspace.create).
    const res = await h.call('workspace.current', {});
    assert.ok(!res.isError);
    assert.equal(res.structuredContent?.found, false);
  });

  let firstInstanceId = null;
  let recipeRunWorkspaceId = null;
  let recipeRunWorkspacePath = null;

  await t.test('recipe.run echo-stub creates a fresh workspace and an instance file', async () => {
    const res = await h.call('recipe.run', {
      id: 'simple-prompt',
      prompt: 'Say hello',
      agent_cli: 'echo-stub',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.ok(typeof sc.recipe_instance_id === 'string' && sc.recipe_instance_id.startsWith('ri_'));
    assert.ok(typeof sc.workspace_id === 'string' && sc.workspace_id.startsWith('ws_'));
    assert.ok(typeof sc.workspace_path === 'string');
    assert.equal(typeof sc.pid, 'number');
    assert.ok(sc.pid > 0);
    assert.equal(sc.status, 'spawned');
    firstInstanceId = sc.recipe_instance_id;
    recipeRunWorkspaceId = sc.workspace_id;
    recipeRunWorkspacePath = sc.workspace_path;

    // Verify .mcp.json was written.
    const mcpConfigPath = join(sc.workspace_path, '.mcp.json');
    assert.ok(existsSync(mcpConfigPath), 'expected .mcp.json to be written');
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
    assert.ok(mcpConfig.mcpServers?.clawdevbox);
    const env = mcpConfig.mcpServers.clawdevbox.env;
    assert.equal(env.CLAWDEVBOX_PROJECT_DIR, sc.workspace_path);
    assert.equal(env.CLAWDEVBOX_RECIPE_INSTANCE_ID, sc.recipe_instance_id);
    assert.equal(env.CLAWDEVBOX_WORKSPACE_ID, sc.workspace_id);
    assert.ok(typeof env.CLAWDEVBOX_MCP_SECRET === 'string' && env.CLAWDEVBOX_MCP_SECRET.length >= 32);

    // Verify instance file.
    const instancePath = join(sc.workspace_path, '.clawdevbox', 'recipe-instances', `${sc.recipe_instance_id}.json`);
    assert.ok(existsSync(instancePath), 'expected instance file to be written');
    const inst = JSON.parse(readFileSync(instancePath, 'utf8'));
    assert.equal(inst.status, 'running');
    assert.equal(inst.recipe_id, 'simple-prompt');
    assert.equal(inst.prompt, 'Say hello');
    assert.equal(inst.workspace_id, sc.workspace_id);
  });

  await t.test('recipe.run with explicit workspace_id reuses the existing workspace', async () => {
    const res = await h.call('recipe.run', {
      id: 'simple-prompt',
      prompt: 'Second call',
      workspace_id: recipeRunWorkspaceId,
      agent_cli: 'echo-stub',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.equal(sc.workspace_id, recipeRunWorkspaceId);
    assert.notEqual(sc.recipe_instance_id, firstInstanceId);
  });

  await t.test('recipe.run rejects unknown recipe ids', async () => {
    const res = await h.call('recipe.run', {
      id: 'nope-not-here',
      prompt: 'x',
      agent_cli: 'echo-stub',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_FOUND');
  });

  await t.test('recipe.run rejects when neither id nor source is given', async () => {
    const res = await h.call('recipe.run', { prompt: 'x', agent_cli: 'echo-stub' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'INVALID_REQUEST');
    assert.match(res.content?.[0]?.text ?? '', /id.*or.*source/);
  });

  await t.test('recipe.run rejects when both id and source are given', async () => {
    const res = await h.call('recipe.run', {
      id: 'echo-stub',
      source: 'id: echo-stub\nname: x\ndescription: x\n',
      prompt: 'x',
      agent_cli: 'echo-stub',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'INVALID_REQUEST');
  });

  await t.test('recipe.run with inline `source` runs an ad-hoc recipe (no upsert needed)', async () => {
    const adhocSource = [
      'id: adhoc-demo',
      'name: Ad-hoc demo',
      'description: Inline recipe used only for this run.',
    ].join('\n') + '\n';
    const res = await h.call('recipe.run', {
      source: adhocSource,
      prompt: 'no-op',
      agent_cli: 'echo-stub',
    });
    assert.equal(res.isError, undefined);
    const sc = res.structuredContent ?? {};
    assert.equal(sc.recipe_id, 'adhoc-demo');
    assert.equal(sc.adhoc, true);
    assert.equal(typeof sc.recipe_instance_id, 'string');
    // The recipe should NOT have been written to disk.
    const projectRecipeFile = join(h.callerProjectDir, '.clawdevbox', 'recipes', 'adhoc-demo.yaml');
    assert.equal(existsSync(projectRecipeFile), false, 'ad-hoc recipe must not persist');
  });

  await t.test('recipe.run with malformed inline source returns VALIDATION_FAILED', async () => {
    const res = await h.call('recipe.run', {
      source: 'name: missing-id-field\ndescription: still missing\n',
      prompt: 'x',
      agent_cli: 'echo-stub',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'VALIDATION_FAILED');
    const paths = (res.structuredContent?.errors ?? []).map((e) => e.path);
    assert.ok(paths.includes('id'), `expected id error, got: ${paths.join(', ')}`);
  });

  await t.test('recipe.run rejects unknown agent_cli with UNKNOWN_AGENT_CLI', async () => {
    const res = await h.call('recipe.run', {
      id: 'simple-prompt',
      prompt: 'x',
      agent_cli: 'not-a-real-provider',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'UNKNOWN_AGENT_CLI');
    assert.equal(res.structuredContent?.agent_cli, 'not-a-real-provider');
    assert.ok(Array.isArray(res.structuredContent?.available));
  });

  await t.test('recipe.run rejects recipes whose default_client is not a registered provider', async () => {
    const adhocSource = [
      'id: adhoc-bad-client',
      'name: bad-client',
      'description: references a provider that does not exist.',
      'default_client: not-installed-provider',
    ].join('\n') + '\n';
    const res = await h.call('recipe.run', {
      source: adhocSource,
      prompt: 'x',
      agent_cli: 'echo-stub',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'UNKNOWN_AGENT_CLI');
    assert.equal(res.structuredContent?.default_client, 'not-installed-provider');
  });

  await t.test('recipe.upsert warns (does NOT fail) when default_client is not yet installed', async () => {
    const source = [
      'id: future-plugin-recipe',
      'name: Future',
      'description: References a plugin not yet installed.',
      'default_client: future-plugin',
    ].join('\n') + '\n';
    const res = await h.call('recipe.upsert', {
      id: 'future-plugin-recipe',
      scope: 'project',
      source,
    });
    assert.ok(!res.isError, JSON.stringify(res));
    const warnings = res.structuredContent?.warnings ?? [];
    assert.ok(Array.isArray(warnings));
    assert.ok(
      warnings.some(
        (w) => w.code === 'UNKNOWN_AGENT_CLI' && w.field === 'default_client' && w.value === 'future-plugin',
      ),
      `expected UNKNOWN_AGENT_CLI warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  await t.test('recipe.done outside a recipe-run session is rejected', async () => {
    // The harness's MCP server has NO CLAWDEVBOX_RECIPE_INSTANCE_ID env var,
    // so calling recipe.done on it should fail with NOT_IN_RECIPE_INSTANCE.
    const res = await h.call('recipe.done', { status: 'success' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_IN_RECIPE_INSTANCE');
  });

  await t.test('recipe.done updates the instance file when called inside a spawned session', async () => {
    // Simulate a spawned-session call by booting a fresh MCP server child
    // process with the recipe-instance env vars set, calling recipe.done over
    // its stdio transport, then asserting the on-disk instance file is updated.
    const childEnv = {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: recipeRunWorkspacePath,
      CLAWDEVBOX_GLOBAL_DIR: h.globalDir,
      CLAWDEVBOX_WORKSPACES_ROOT: h.workspacesRoot,
      CLAWDEVBOX_RECIPE_INSTANCE_ID: firstInstanceId,
      CLAWDEVBOX_WORKSPACE_ID: recipeRunWorkspaceId,
    };
    const child = spawn('npx', ['tsx', entry, 'mcp'], {
      cwd: projectRoot,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let buf = '';
    const responses = [];
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', () => { /* swallow */ });

    const waitFor = async (id, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`timeout waiting for id=${id}`);
    };

    try {
      await new Promise((r) => setTimeout(r, 1200));
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'done-test', version: '0' },
        },
      }) + '\n');
      await waitFor(1);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
          name: 'recipe.done',
          arguments: { status: 'success', message: 'all done', result: { score: 42 } },
        },
      }) + '\n');
      const r = await waitFor(2);
      assert.ok(!r.result?.isError, JSON.stringify(r));
      assert.equal(r.result?.structuredContent?.status, 'success');

      // Read the instance file from disk and assert.
      const instancePath = join(
        recipeRunWorkspacePath,
        '.clawdevbox',
        'recipe-instances',
        `${firstInstanceId}.json`,
      );
      const inst = JSON.parse(readFileSync(instancePath, 'utf8'));
      assert.equal(inst.status, 'success');
      assert.ok(typeof inst.completed_at === 'number' && inst.completed_at > 0);
      assert.equal(inst.message, 'all done');
      assert.deepEqual(inst.result, { score: 42 });
    } finally {
      try {
        if (platform() === 'win32' && child.pid) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }
  });

  await t.test('recipe.instance_info round-trips the updated instance', async () => {
    const res = await h.call('recipe.instance_info', { id: firstInstanceId });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.equal(sc.recipe_instance_id, firstInstanceId);
    assert.equal(sc.workspace_id, recipeRunWorkspaceId);
    assert.equal(sc.status, 'success');
    assert.equal(sc.recipe_id, 'simple-prompt');
    assert.equal(sc.message, 'all done');
  });

  await t.test('recipe.instance_info without env vars is rejected', async () => {
    // The harness server has no CLAWDEVBOX_RECIPE_INSTANCE_ID env var, so a
    // call without `id` should fail.
    const res = await h.call('recipe.instance_info', {});
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_IN_RECIPE_INSTANCE');
  });
});

// ----------------------------------------------------------------------------
// Regression: warnIfLegacyProjectPlugins must NOT fire when
// `<projectDir>/.clawdevbox/plugins` resolves to the same path as the global
// plugin store (common when projectDir is an ancestor of globalDir — e.g.
// running `clawdevbox init` from `~` with the default globalDir at `~/.clawdevbox`).
// ----------------------------------------------------------------------------

test('legacy-plugin warning is suppressed when project plugins dir == global plugins dir', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'legacy-warn-'));
  try {
    const home = join(tmp, 'home');
    const projectDir = home;
    const globalDir = join(home, '.clawdevbox');
    // Set up the global plugin store at <globalDir>/plugins/fake-plugin.
    // From projectDir's perspective, <projectDir>/.clawdevbox/plugins is the
    // SAME path, which used to trigger a spurious "legacy plugins detected"
    // warning.
    mkdirSync(join(globalDir, 'plugins', 'fake-plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(globalDir, 'plugins', 'fake-plugin', '.claude-plugin', 'plugin.json'),
      '{"name":"fake-plugin","version":"0.0.0","description":"x"}',
    );

    // Spawn a stdio MCP child with these env vars; capture stderr; assert the
    // warning string is NOT present.
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', entry, 'mcp'],
      {
        env: {
          ...process.env,
          CLAWDEVBOX_PROJECT_DIR: projectDir,
          CLAWDEVBOX_GLOBAL_DIR: globalDir,
        },
        input: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }) + '\n',
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    const stderr = child.stderr ?? '';
    assert.ok(
      !stderr.includes('Legacy project-scope plugins detected'),
      `false-positive legacy warning fired:\n${stderr.slice(0, 1500)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
