/**
 * workspace.test.mjs
 *
 * node:test suite for the workspace.* and recipe.run/.done/.instance_info
 * surface added in the mission-control redesign. Boots an isolated harness
 * with CONDUCTOR_PROJECT_DIR and CONDUCTOR_WORKSPACES_ROOT pointing at temp
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
  'recipes',
  'simple-prompt.yaml',
);

// ----------------------------------------------------------------------------
// Harness
// ----------------------------------------------------------------------------

class WsHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-ws-smoke-'));
    // The "calling" workspace (CONDUCTOR_PROJECT_DIR points here).
    this.callerProjectDir = join(this.tmpRoot, 'caller');
    const callerConductor = join(this.callerProjectDir, '.conductor');
    const callerPluginDest = join(callerConductor, 'plugins', 'ado');
    mkdirSync(callerPluginDest, { recursive: true });
    cpSync(repoSampleAdoPlugin, callerPluginDest, {
      recursive: true,
      filter: (src) =>
        !src.includes('node_modules') &&
        !src.endsWith('package-lock.json') &&
        !src.includes('_legacy-mcp-server'),
    });
    // Drop the simple-prompt recipe in the caller's project scope so recipe.read
    // resolves it.
    const callerRecipesDir = join(callerConductor, 'recipes');
    mkdirSync(callerRecipesDir, { recursive: true });
    cpSync(repoSampleSimplePromptRecipe, join(callerRecipesDir, 'simple-prompt.yaml'));

    this.globalDir = join(this.tmpRoot, '.global');
    mkdirSync(this.globalDir, { recursive: true });
    this.workspacesRoot = join(this.tmpRoot, '.workspaces');
    mkdirSync(this.workspacesRoot, { recursive: true });

    // Junction node_modules into the caller dir so the ADO plugin's hostable
    // tools resolve via Node's ESM walk-up.
    const wsNodeModules = join(this.callerProjectDir, 'node_modules');
    if (!existsSync(wsNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      symlinkSync(resolve(projectRoot, 'node_modules'), wsNodeModules, linkType);
    }

    this.serverEnv = {
      ...process.env,
      CONDUCTOR_PROJECT_DIR: this.callerProjectDir,
      CONDUCTOR_GLOBAL_DIR: this.globalDir,
      CONDUCTOR_WORKSPACES_ROOT: this.workspacesRoot,
    };

    this.child = spawn('npx', ['tsx', entry], {
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

  async waitFor(id, timeoutMs = 15000) {
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
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
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

  await t.test('workspace.create scaffolds the .conductor tree and registers the workspace', async () => {
    const res = await h.call('workspace.create', { name: 'test-ws' });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.ok(typeof sc.id === 'string' && sc.id.startsWith('ws_'), `bad id: ${sc.id}`);
    assert.ok(existsSync(sc.path), `workspace path missing: ${sc.path}`);
    for (const sub of ['recipes', 'skills', 'plugins', 'recipe-instances']) {
      assert.ok(
        existsSync(join(sc.path, '.conductor', sub)),
        `missing .conductor/${sub}`,
      );
    }
    assert.ok(existsSync(join(sc.path, '.conductor', 'triggers.json')));
    assert.ok(existsSync(join(sc.path, '.conductor', 'workspace.json')));
    const meta = JSON.parse(readFileSync(join(sc.path, '.conductor', 'workspace.json'), 'utf8'));
    assert.equal(meta.id, sc.id);
    assert.equal(meta.name, 'test-ws');
    const triggers = JSON.parse(readFileSync(join(sc.path, '.conductor', 'triggers.json'), 'utf8'));
    assert.deepEqual(triggers, { registered: [] });
    // Registry should reflect this workspace.
    const idxPath = join(h.workspacesRoot, 'index.json');
    assert.ok(existsSync(idxPath));
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
    assert.ok(idx.workspaces[sc.id]);
    firstWorkspaceId = sc.id;
    firstWorkspacePath = sc.path;
  });

  await t.test('workspace.create with inherit_plugins copies the calling workspace\'s plugins/', async () => {
    const res = await h.call('workspace.create', { name: 'with-plugins', inherit_plugins: true });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.ok(Array.isArray(sc.inherited_plugins) && sc.inherited_plugins.includes('ado'));
    const adoDir = join(sc.path, '.conductor', 'plugins', 'ado');
    assert.ok(existsSync(adoDir), 'expected ado plugin dir to be inherited');
    assert.ok(existsSync(join(adoDir, 'plugin.yaml')), 'expected plugin.yaml in inherited plugin');
  });

  await t.test('workspace.create with copy_from clones the source workspace .conductor/ tree', async () => {
    // Pre-populate the first workspace with an extra file under .conductor/
    // so we can verify copy_from picked it up.
    const sourceCustomFile = join(firstWorkspacePath, '.conductor', 'custom-marker.txt');
    writeFileSync(sourceCustomFile, 'hello from source\n', 'utf8');

    const res = await h.call('workspace.create', { name: 'cloned', copy_from: firstWorkspaceId });
    assert.ok(!res.isError, JSON.stringify(res));
    const sc = res.structuredContent;
    assert.ok(Array.isArray(sc.copied_from_subtrees));
    // Both the standard tree and our custom marker should be present.
    assert.ok(existsSync(join(sc.path, '.conductor', 'custom-marker.txt')));
    // recipe-instances and workspace.json must be regenerated (not copied raw).
    const meta = JSON.parse(readFileSync(join(sc.path, '.conductor', 'workspace.json'), 'utf8'));
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

  await t.test('workspace.current returns found:false when CONDUCTOR_PROJECT_DIR is not registered', async () => {
    // The harness's CONDUCTOR_PROJECT_DIR is the caller dir, which is NOT
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
    assert.ok(mcpConfig.mcpServers?.conductor);
    const env = mcpConfig.mcpServers.conductor.env;
    assert.equal(env.CONDUCTOR_PROJECT_DIR, sc.workspace_path);
    assert.equal(env.CONDUCTOR_RECIPE_INSTANCE_ID, sc.recipe_instance_id);
    assert.equal(env.CONDUCTOR_WORKSPACE_ID, sc.workspace_id);
    assert.ok(typeof env.CONDUCTOR_MCP_SECRET === 'string' && env.CONDUCTOR_MCP_SECRET.length >= 32);

    // Verify instance file.
    const instancePath = join(sc.workspace_path, '.conductor', 'recipe-instances', `${sc.recipe_instance_id}.json`);
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

  await t.test('recipe.done outside a recipe-run session is rejected', async () => {
    // The harness's MCP server has NO CONDUCTOR_RECIPE_INSTANCE_ID env var,
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
      CONDUCTOR_PROJECT_DIR: recipeRunWorkspacePath,
      CONDUCTOR_GLOBAL_DIR: h.globalDir,
      CONDUCTOR_WORKSPACES_ROOT: h.workspacesRoot,
      CONDUCTOR_RECIPE_INSTANCE_ID: firstInstanceId,
      CONDUCTOR_WORKSPACE_ID: recipeRunWorkspaceId,
    };
    const child = spawn('npx', ['tsx', entry], {
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

    const waitFor = async (id, timeoutMs = 15000) => {
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
        '.conductor',
        'recipe-instances',
        `${firstInstanceId}.json`,
      );
      const inst = JSON.parse(readFileSync(instancePath, 'utf8'));
      assert.equal(inst.status, 'success');
      assert.ok(typeof inst.completed_at === 'number' && inst.completed_at > 0);
      assert.equal(inst.message, 'all done');
      assert.deepEqual(inst.result, { score: 42 });
    } finally {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
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
    // The harness server has no CONDUCTOR_RECIPE_INSTANCE_ID env var, so a
    // call without `id` should fail.
    const res = await h.call('recipe.instance_info', {});
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_IN_RECIPE_INSTANCE');
  });
});
