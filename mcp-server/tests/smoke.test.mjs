/**
 * smoke.test.mjs
 *
 * Same flow as manual-test.mjs but as node:test assertions. No external
 * services required — the server runs against an isolated temp workspace
 * populated from samples/plugins/ado/.
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/index.ts');
const repoSampleAdoPlugin = resolve(projectRoot, '..', 'samples', 'plugins', 'ado');

// ----------------------------------------------------------------------------
// Test harness
// ----------------------------------------------------------------------------

class ServerHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'conductor-mcp-smoke-'));
    const conductorDir = join(this.tmpRoot, '.conductor');
    const pluginDest = join(conductorDir, 'plugins', 'ado');
    mkdirSync(pluginDest, { recursive: true });
    cpSync(repoSampleAdoPlugin, pluginDest, {
      recursive: true,
      filter: (src) =>
        !src.includes('node_modules') &&
        !src.endsWith('package-lock.json') &&
        !src.includes('_legacy-mcp-server'),
    });
    this.globalDir = join(this.tmpRoot, '.global');
    mkdirSync(this.globalDir, { recursive: true });

    // Junction the Conductor server's node_modules into the temp workspace
    // root so the ADO plugin's hostable tools (which `import 'zod'`) resolve.
    // See hosted-tools.test.mjs for the same pattern + rationale.
    const wsNodeModules = join(this.tmpRoot, 'node_modules');
    if (!existsSync(wsNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      symlinkSync(resolve(projectRoot, 'node_modules'), wsNodeModules, linkType);
    }

    this.child = spawn('npx', ['tsx', entry], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CONDUCTOR_PROJECT_DIR: this.tmpRoot,
        CONDUCTOR_GLOBAL_DIR: this.globalDir,
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
    // wait for server boot
    await new Promise((r) => setTimeout(r, 1200));
    const id = this.nextId++;
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
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
    // On Windows, child.kill('SIGTERM') doesn't reliably terminate the
    // npx → tsx → node process tree spawned via shell: true. Use taskkill
    // /T to walk the tree. Without this, the test runner hangs after the
    // last assertion because npx + grandchildren keep the event loop alive.
    if (this.child && !this.child.killed) {
      try {
        if (platform() === 'win32' && this.child.pid) {
          spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          this.child.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }
    // Detach + destroy the stdio pipes so Node's event loop doesn't
    // hold references to them after the child is gone.
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

test('conductor MCP server smoke', async (t) => {
  const h = new ServerHarness();
  t.after(() => h.shutdown());

  await h.init();

  await t.test('tools/list registers the full Conductor catalog', async () => {
    const tools = await h.listTools();
    const names = tools.map((x) => x.name);
    assert.ok(tools.length >= 30, `expected >=30 tools, got ${tools.length}`);
    // Spot-check families
    for (const n of [
      'recipe.list', 'recipe.read', 'recipe.upsert', 'recipe.delete',
      'skill.list', 'skill.read', 'skill.upsert', 'skill.delete',
      // New trigger surface (spec §6.1) — types + registered instances split.
      'trigger.list_types', 'trigger.list_registered', 'trigger.register',
      'trigger.unregister', 'trigger.update_params', 'trigger.enable',
      'trigger.disable', 'trigger.fire',
      'plugin.list', 'plugin.read', 'plugin.install', 'plugin.update', 'plugin.uninstall', 'plugin.enable', 'plugin.disable',
      'inbox.list', 'inbox.read', 'inbox.upsert', 'inbox.set_state', 'inbox.snooze', 'inbox.archive',
      'thread.spawn', 'thread.append_message', 'thread.read', 'thread.set_state', 'thread.cancel', 'thread.wake',
      'approval.request', 'approval.resolve', 'approval.list_pending',
      'artifact.add', 'artifact.list', 'artifact.get', 'artifact.delete',
      'renderer.list', 'renderer.read', 'renderer.write', 'renderer.delete',
    ]) {
      assert.ok(names.includes(n), `missing tool: ${n}`);
    }
  });

  await t.test("recipe.list scope='plugin:ado' returns the two plugin recipes", async () => {
    const res = await h.call('recipe.list', { scope: 'plugin:ado' });
    const recipes = res.structuredContent?.recipes ?? [];
    assert.equal(recipes.length, 2);
    assert.ok(recipes.every((r) => r.scope === 'plugin:ado'));
    const ids = recipes.map((r) => r.id).sort();
    assert.deepEqual(ids, ['pr-review', 'respond-to-pr-comment']);
  });

  await t.test('shadowing: project upsert overrides plugin read', async () => {
    const original = await h.call('recipe.read', { id: 'pr-review' });
    assert.equal(original.structuredContent?.scope, 'plugin:ado');

    const projectShadow = [
      'id: pr-review',
      'name: "PR Review (shadow)"',
      'description: "Project override."',
      'kind: pr_review',
      'steps:',
      '  - id: 1',
      '    goal: "shadow step"',
    ].join('\n');
    const up = await h.call('recipe.upsert', {
      id: 'pr-review',
      scope: 'project',
      source: projectShadow,
    });
    assert.ok(!up.isError, JSON.stringify(up));

    const after = await h.call('recipe.read', { id: 'pr-review' });
    assert.equal(after.structuredContent?.scope, 'project');
    assert.equal(after.structuredContent?.parsed?.name, 'PR Review (shadow)');
  });

  await t.test('plugin-scope writes are rejected with PLUGIN_SCOPE_READONLY', async () => {
    const res = await h.call('recipe.upsert', {
      id: 'foo',
      scope: 'plugin:ado',
      source: 'id: foo\nname: foo\ndescription: x\n',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'PLUGIN_SCOPE_READONLY');
  });

  await t.test('plugin.list shows the ADO plugin', async () => {
    const res = await h.call('plugin.list', {});
    const plugins = res.structuredContent?.plugins ?? [];
    const ado = plugins.find((p) => p.id === 'ado');
    assert.ok(ado, 'expected ado plugin to be listed');
    assert.equal(ado.status, 'enabled');
  });

  await t.test('skill.list shows the ADO skills', async () => {
    const res = await h.call('skill.list', { scope: 'plugin:ado' });
    const skills = res.structuredContent?.skills ?? [];
    assert.equal(skills.length, 2);
    const ids = skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['analyze-pr-comment', 'summarize-pr-changes']);
  });

  await t.test('inbox + thread + approval round-trip (in-memory stub)', async () => {
    const up = await h.call('inbox.upsert', {
      id: 'ado:pr:1',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 1: Fix auth',
    });
    assert.ok(!up.isError);
    assert.equal(up.structuredContent?.item?.id, 'ado:pr:1');

    const tsp = await h.call('thread.spawn', {
      inbox_item_id: 'ado:pr:1',
      prompt: 'Please review PR 1.',
      recipe_id: 'pr-review',
    });
    const threadId = tsp.structuredContent?.thread?.id;
    assert.ok(threadId, 'thread id missing');

    const apr = await h.call('approval.request', {
      thread_id: threadId,
      question: 'Post the drafted comments?',
      options: [{ value: 'yes' }, { value: 'no' }],
    });
    const approvalId = apr.structuredContent?.approval?.id;
    assert.ok(approvalId);

    const pending = await h.call('approval.list_pending', { thread_id: threadId });
    assert.equal(pending.structuredContent?.approvals?.length, 1);

    const resolved = await h.call('approval.resolve', { approval_id: approvalId, answer: 'yes' });
    assert.equal(resolved.structuredContent?.approval?.state, 'resolved');

    const stillPending = await h.call('approval.list_pending', { thread_id: threadId });
    assert.equal(stillPending.structuredContent?.approvals?.length, 0);
  });

  await t.test('recipe.upsert validates shape and rejects malformed sources', async () => {
    const res = await h.call('recipe.upsert', {
      id: 'broken',
      scope: 'project',
      source: 'id: broken\n# missing name and description',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'VALIDATION_FAILED');
    const paths = res.structuredContent?.errors?.map((e) => e.path) ?? [];
    assert.ok(paths.includes('name'), 'expected name path among errors');
    assert.ok(paths.includes('description'), 'expected description path among errors');
  });

  await t.test('trigger.list_types surfaces the ADO plugin trigger types', async () => {
    const res = await h.call('trigger.list_types', { scope: 'plugin:ado' });
    const types = res.structuredContent?.trigger_types ?? [];
    const ids = types.map((t) => t.id).sort();
    assert.deepEqual(ids, [
      'ado.comment-watcher',
      'ado.new-pr-watcher',
      'ado.pr-pulse-watcher',
    ]);
    // Spot-check schema surfaces.
    const newPr = types.find((t) => t.id === 'ado.new-pr-watcher');
    assert.ok(newPr, 'ado.new-pr-watcher missing');
    assert.equal(newPr.binds_callback_to_recipe, 'pr-review');
    assert.equal(newPr.default_cron, '*/5 * * * *');
    assert.equal(newPr.identity_param, 'repo');
    assert.ok(Array.isArray(newPr.parameters) && newPr.parameters.length >= 1);
  });

  await t.test('trigger.register + list_registered + update_params + unregister', async () => {
    // Register an instance of ado.new-pr-watcher.
    const reg = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'auth-svc' },
    });
    assert.ok(!reg.isError, JSON.stringify(reg));
    assert.equal(reg.structuredContent?.id, 'ado.new-pr-watcher#auth-svc');

    // list_registered shows it.
    const list1 = await h.call('trigger.list_registered', {});
    const ids1 = (list1.structuredContent?.registered ?? []).map((r) => r.id);
    assert.ok(ids1.includes('ado.new-pr-watcher#auth-svc'));

    // update_params — override cron.
    const upd = await h.call('trigger.update_params', {
      id: 'ado.new-pr-watcher#auth-svc',
      cron: '*/1 * * * *',
    });
    assert.ok(!upd.isError, JSON.stringify(upd));
    assert.equal(upd.structuredContent?.registered?.cron, '*/1 * * * *');

    // disable flips enabled to false.
    const dis = await h.call('trigger.disable', { id: 'ado.new-pr-watcher#auth-svc' });
    assert.ok(!dis.isError);
    const list2 = await h.call('trigger.list_registered', { enabled: false });
    const found = (list2.structuredContent?.registered ?? []).find(
      (r) => r.id === 'ado.new-pr-watcher#auth-svc',
    );
    assert.ok(found, 'expected disabled trigger to show with enabled=false filter');

    // unregister removes the row.
    const un = await h.call('trigger.unregister', { id: 'ado.new-pr-watcher#auth-svc' });
    assert.ok(!un.isError);
    const list3 = await h.call('trigger.list_registered', {});
    const ids3 = (list3.structuredContent?.registered ?? []).map((r) => r.id);
    assert.ok(!ids3.includes('ado.new-pr-watcher#auth-svc'));
  });

  await t.test('trigger.register rejects missing required params with PARAM_VALIDATION', async () => {
    const res = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: {}, // repo missing
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'PARAM_VALIDATION');
    const paths = (res.structuredContent?.errors ?? []).map((e) => e.path);
    assert.ok(paths.includes('params.repo'), `expected params.repo in errors; got ${paths.join(',')}`);
  });

  await t.test('trigger.register rejects unknown type_id with TRIGGER_TYPE_NOT_FOUND', async () => {
    const res = await h.call('trigger.register', {
      type_id: 'nope.does-not-exist',
      params: {},
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'TRIGGER_TYPE_NOT_FOUND');
  });

  await t.test('trigger.register rejects collisions with TRIGGER_ALREADY_REGISTERED', async () => {
    const r1 = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'collide-svc' },
    });
    assert.ok(!r1.isError, JSON.stringify(r1));
    const r2 = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'collide-svc' },
    });
    assert.equal(r2.isError, true);
    assert.equal(r2.structuredContent?.code, 'TRIGGER_ALREADY_REGISTERED');
    // Cleanup so other subtests start fresh.
    await h.call('trigger.unregister', { id: 'ado.new-pr-watcher#collide-svc' });
  });

  await t.test('trigger.register rejects invalid cron with PARAM_VALIDATION', async () => {
    const res = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'invalid-cron-svc' },
      cron: 'not-a-cron',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'PARAM_VALIDATION');
  });

  await t.test('trigger.register with cron=false stores disabled-cron registration', async () => {
    const res = await h.call('trigger.register', {
      type_id: 'ado.comment-watcher',
      params: { repo: 'auth-svc', pr_id: 9001 },
      subscriber_thread_id: 'thr_test',
      cron: false,
    });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent?.registered?.cron, false);
    assert.equal(res.structuredContent?.registered?.resolved_cron, false);
    await h.call('trigger.unregister', { id: res.structuredContent.id });
  });
});
