/**
 * smoke.test.mjs
 *
 * Same flow as manual-test.mjs but as node:test assertions. No external
 * services required — the server runs against an isolated temp workspace
 * populated from plugins/ado/.
 *
 *   node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/index.ts');
const repoSampleAdoPlugin = resolve(projectRoot, '..', 'plugins', 'ado');

// ----------------------------------------------------------------------------
// Test harness
// ----------------------------------------------------------------------------

class ServerHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-mcp-smoke-'));
    const clawdevboxDir = join(this.tmpRoot, '.clawdevbox');
    // Project tree: recipes/skills/triggers/artifacts only; plugins are
    // global now.
    mkdirSync(clawdevboxDir, { recursive: true });
    for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
      mkdirSync(join(clawdevboxDir, sub), { recursive: true });
    }

    // Global plugin store — install the ADO built-in here so the server
    // discovers it via `<global_dir>/plugins/*`.
    this.globalDir = join(this.tmpRoot, '.global');
    const pluginDest = join(this.globalDir, 'plugins', 'ado');
    mkdirSync(dirname(pluginDest), { recursive: true });
    cpSync(repoSampleAdoPlugin, pluginDest, {
      recursive: true,
      filter: (src) =>
        !src.includes('node_modules') &&
        !src.endsWith('package-lock.json') &&
        !src.includes('_legacy-mcp-server'),
    });

    // Junction the Clawdevbox server's node_modules into the GLOBAL dir
    // so the ADO plugin's hostable tools (which `import 'zod'`) resolve
    // via Node's walk-up from `<globalDir>/plugins/ado/tools/*.ts`.
    const globalNodeModules = join(this.globalDir, 'node_modules');
    if (!existsSync(globalNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      symlinkSync(resolve(projectRoot, 'node_modules'), globalNodeModules, linkType);
    }

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

test('clawdevbox MCP server smoke', async (t) => {
  const h = new ServerHarness();
  t.after(() => h.shutdown());

  await h.init();

  await t.test('tools/list exposes exactly the 3 meta-tools', async () => {
    const tools = await h.listTools();
    const names = tools.map((x) => x.name).sort();
    assert.deepEqual(names, ['learn_tool', 'list_tools', 'run_tool']);
  });

  await t.test('list_tools returns the full Clawdevbox catalog', async () => {
    const res = await h.call('list_tools', {});
    const parsed = JSON.parse(res.content[0].text);
    const names = parsed.tools.map((t) => t.name);
    assert.ok(parsed.count >= 30, `expected >=30 tools, got ${parsed.count}`);
    // Spot-check families
    for (const n of [
      'recipe.list', 'recipe.read', 'recipe.upsert', 'recipe.delete',
      'recipe.update_steps', 'recipe.steps.update_status',
      'skill.list', 'skill.read', 'skill.upsert', 'skill.delete',
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

  await t.test("recipe.list scope='plugin:ado' returns the registered plugin recipes", async () => {
    const res = await h.call('run_tool', { tool: 'recipe.list', args: { scope: 'plugin:ado' } });
    const recipes = res.structuredContent?.recipes ?? [];
    assert.ok(recipes.every((r) => r.scope === 'plugin:ado'));
    const ids = recipes.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      'address-pr-feedback',
      'fix-bug',
      'implement-feature',
      'pr-review',
      'respond-to-pr-comment',
      'triage-work-item',
    ]);
  });

  await t.test('shadowing: project upsert overrides plugin read', async () => {
    const original = await h.call('run_tool', { tool: 'recipe.read', args: { id: 'pr-review' } });
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
    const up = await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'pr-review',
      scope: 'project',
      source: projectShadow,
    } });
    assert.ok(!up.isError, JSON.stringify(up));

    const after = await h.call('run_tool', { tool: 'recipe.read', args: { id: 'pr-review' } });
    assert.equal(after.structuredContent?.scope, 'project');
    assert.equal(after.structuredContent?.parsed?.name, 'PR Review (shadow)');
  });

  await t.test('plugin-scope writes are rejected with PLUGIN_SCOPE_READONLY', async () => {
    const res = await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'foo',
      scope: 'plugin:ado',
      source: 'id: foo\nname: foo\ndescription: x\n',
    } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'PLUGIN_SCOPE_READONLY');
  });

  await t.test('recipe.upsert format=yaml writes <id>.yaml (default)', async () => {
    const res = await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'fmt-yaml',
      scope: 'project',
      source: 'id: fmt-yaml\nname: F\ndescription: d\nsteps:\n  - id: s\n    goal: g\n',
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent?.format, 'yaml');
    assert.ok(String(res.structuredContent?.path ?? '').endsWith('.yaml'));
    const projDir = h.tmpRoot;
    assert.ok(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-yaml.yaml')));
    assert.equal(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-yaml.json')), false);
  });

  await t.test('recipe.upsert format=json writes <id>.json', async () => {
    const res = await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'fmt-json',
      scope: 'project',
      source: JSON.stringify({
        id: 'fmt-json',
        name: 'J',
        description: 'd',
        steps: [{ id: 's', goal: 'g' }],
      }),
      format: 'json',
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent?.format, 'json');
    assert.ok(String(res.structuredContent?.path ?? '').endsWith('.json'));
    const projDir = h.tmpRoot;
    assert.ok(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-json.json')));
    assert.equal(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-json.yaml')), false);

    // recipe.read should still resolve it.
    const read = await h.call('run_tool', { tool: 'recipe.read', args: { id: 'fmt-json' } });
    assert.ok(!read.isError, JSON.stringify(read));
    assert.equal(read.structuredContent?.parsed?.id, 'fmt-json');
  });

  await t.test('recipe.upsert format toggle removes the sibling file', async () => {
    // Start as yaml.
    await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'fmt-toggle',
      scope: 'project',
      source: 'id: fmt-toggle\nname: T\ndescription: d\nsteps:\n  - id: s\n    goal: g\n',
    } });
    const projDir = h.tmpRoot;
    const yamlPath = join(projDir, '.clawdevbox', 'recipes', 'fmt-toggle.yaml');
    const jsonPath = join(projDir, '.clawdevbox', 'recipes', 'fmt-toggle.json');
    assert.ok(existsSync(yamlPath));
    assert.equal(existsSync(jsonPath), false);

    // Now upsert as json — yaml sibling should disappear.
    const res = await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'fmt-toggle',
      scope: 'project',
      source: JSON.stringify({
        id: 'fmt-toggle',
        name: 'T',
        description: 'd',
        steps: [{ id: 's', goal: 'g' }],
      }),
      format: 'json',
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(yamlPath), false, 'yaml sibling should be removed');
    assert.ok(existsSync(jsonPath));
    assert.ok((res.structuredContent?.removed_siblings ?? []).some((p) => p.endsWith('.yaml')));
  });

  await t.test('plugin.list shows the ADO plugin', async () => {
    const res = await h.call('run_tool', { tool: 'plugin.list', args: {} });
    const plugins = res.structuredContent?.plugins ?? [];
    const ado = plugins.find((p) => p.id === 'ado');
    assert.ok(ado, 'expected ado plugin to be listed');
    assert.equal(ado.status, 'enabled');
  });

  await t.test('skill.list shows the ADO skills', async () => {
    const res = await h.call('run_tool', { tool: 'skill.list', args: { scope: 'plugin:ado' } });
    const skills = res.structuredContent?.skills ?? [];
    assert.equal(skills.length, 2);
    const ids = skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['analyze-pr-comment', 'summarize-pr-changes']);
  });

  await t.test('skill.upsert writes skills/<id>/SKILL.md (directory shape)', async () => {
    const id = 'demo-skill';
    const res = await h.call('run_tool', { tool: 'skill.upsert', args: {
      id,
      scope: 'project',
      source: '---\nname: demo-skill\ndescription: a demo\n---\nhello body\n',
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    const expected = join(h.tmpRoot, '.clawdevbox', 'skills', id, 'SKILL.md');
    assert.equal(res.structuredContent?.path, expected);
    assert.ok(existsSync(expected), `expected SKILL.md at ${expected}`);
    // Legacy flat file must NOT exist
    assert.equal(existsSync(join(h.tmpRoot, '.clawdevbox', 'skills', `${id}.md`)), false);
    // skill.read returns the same source
    const read = await h.call('run_tool', { tool: 'skill.read', args: { id, scope: 'project' } });
    assert.ok(!read.isError, JSON.stringify(read));
    assert.match(read.structuredContent?.source ?? '', /hello body/);
  });

  await t.test('skill.upsert injects frontmatter.name when missing', async () => {
    const id = 'name-injected';
    const res = await h.call('run_tool', { tool: 'skill.upsert', args: {
      id,
      scope: 'project',
      source: '---\ndescription: no name field\n---\nbody\n',
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    const fileAt = join(h.tmpRoot, '.clawdevbox', 'skills', id, 'SKILL.md');
    const text = readFileSync(fileAt, 'utf8');
    assert.match(text, /name:\s*name-injected/);
    const read = await h.call('run_tool', { tool: 'skill.read', args: { id, scope: 'project' } });
    assert.equal(read.structuredContent?.frontmatter?.name, id);
  });

  await t.test('skill.upsert rejects mismatched frontmatter.name', async () => {
    const res = await h.call('run_tool', { tool: 'skill.upsert', args: {
      id: 'wanted-id',
      scope: 'project',
      source: '---\nname: other-id\ndescription: d\n---\nbody\n',
    } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NAME_MISMATCH');
  });

  await t.test('skill.upsert overwrites existing skill content', async () => {
    const id = 'demo-skill';
    const target = join(h.tmpRoot, '.clawdevbox', 'skills', id, 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const res = await h.call('run_tool', { tool: 'skill.upsert', args: {
      id,
      scope: 'project',
      source: '---\nname: demo-skill\ndescription: updated\n---\nNEW BODY\n',
    } });
    assert.ok(!res.isError);
    const after = readFileSync(target, 'utf8');
    assert.notEqual(before, after);
    assert.match(after, /NEW BODY/);
  });

  await t.test('skill.upsert with legacy flat <id>.md deletes the legacy after write', async () => {
    const id = 'legacy-flip';
    const skillsRoot = join(h.tmpRoot, '.clawdevbox', 'skills');
    const legacy = join(skillsRoot, `${id}.md`);
    mkdirSync(skillsRoot, { recursive: true });
    // Hand-write a legacy flat skill file.
    writeFileSync(
      legacy,
      '---\nname: legacy-flip\ndescription: legacy\n---\nold body\n',
      'utf8',
    );
    assert.ok(existsSync(legacy));
    const res = await h.call('run_tool', { tool: 'skill.upsert', args: {
      id,
      scope: 'project',
      source: '---\nname: legacy-flip\ndescription: new\n---\nnew body\n',
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(legacy), false, 'legacy flat file should be deleted');
    assert.ok(existsSync(join(skillsRoot, id, 'SKILL.md')));
  });

  await t.test('skill.delete removes the entire <id>/ directory', async () => {
    const id = 'demo-skill';
    const dir = join(h.tmpRoot, '.clawdevbox', 'skills', id);
    // Drop a sibling supporting file alongside SKILL.md to prove the rm is
    // recursive.
    writeFileSync(join(dir, 'helper.md'), 'side', 'utf8');
    assert.ok(existsSync(join(dir, 'helper.md')));
    const res = await h.call('run_tool', { tool: 'skill.delete', args: { id, scope: 'project' } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(dir), false, 'skill dir should be removed recursively');
  });

  await t.test('skill.delete on unknown id returns NOT_FOUND', async () => {
    const res = await h.call('run_tool', { tool: 'skill.delete', args: { id: 'nope-nada', scope: 'project' } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_FOUND');
  });

  await t.test('inbox + thread + approval round-trip (in-memory stub)', async () => {
    const up = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:1',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 1: Fix auth',
    } });
    assert.ok(!up.isError);
    assert.equal(up.structuredContent?.item?.id, 'ado:pr:1');
    // New: upsert reports whether the row was created vs updated.
    assert.equal(up.structuredContent?.created, true, 'expected created=true on first upsert');
    // Re-upserting the same id reports created=false.
    const up2 = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:1',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 1: Fix auth (updated)',
    } });
    assert.equal(up2.structuredContent?.created, false, 'expected created=false on re-upsert');
    // Notifications aren't configured in the test harness, so a push attempt
    // surfaces NOTIFICATIONS_DISABLED rather than throwing.
    const pushCall = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:2',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 2: refactor',
      notify: true,
    } });
    assert.equal(pushCall.structuredContent?.push_error_code, 'NOTIFICATIONS_DISABLED');
    assert.equal(pushCall.structuredContent?.push, null);

    const tsp = await h.call('run_tool', { tool: 'thread.spawn', args: {
      inbox_item_id: 'ado:pr:1',
      prompt: 'Please review PR 1.',
      recipe_id: 'pr-review',
    } });
    const threadId = tsp.structuredContent?.thread?.id;
    assert.ok(threadId, 'thread id missing');

    const apr = await h.call('run_tool', { tool: 'approval.request', args: {
      thread_id: threadId,
      question: 'Post the drafted comments?',
      options: [{ value: 'yes' }, { value: 'no' }],
    } });
    const approvalId = apr.structuredContent?.approval?.id;
    assert.ok(approvalId);

    const pending = await h.call('run_tool', { tool: 'approval.list_pending', args: { thread_id: threadId } });
    assert.equal(pending.structuredContent?.approvals?.length, 1);

    const resolved = await h.call('run_tool', { tool: 'approval.resolve', args: { approval_id: approvalId, answer: 'yes' } });
    assert.equal(resolved.structuredContent?.approval?.state, 'resolved');

    const stillPending = await h.call('run_tool', { tool: 'approval.list_pending', args: { thread_id: threadId } });
    assert.equal(stillPending.structuredContent?.approvals?.length, 0);
  });

  await t.test('inbox is persisted to <globalDir>/inbox.json', async () => {
    // The previous test upserted ado:pr:1 and ado:pr:2 — both should now be
    // visible in the on-disk file under the harness's globalDir.
    const inboxFile = join(h.globalDir, 'inbox.json');
    assert.ok(existsSync(inboxFile), `expected ${inboxFile} to exist`);
    const parsed = JSON.parse(readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.items));
    const ids = parsed.items.map((it) => it.id).sort();
    assert.ok(ids.includes('ado:pr:1'), `ado:pr:1 missing from inbox.json (got ${ids.join(', ')})`);
    assert.ok(ids.includes('ado:pr:2'), `ado:pr:2 missing from inbox.json (got ${ids.join(', ')})`);
  });

  await t.test('inbox.upsert accepts the expanded schema (preview/description/attachments/links/labels)', async () => {
    const upsertRes = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 99: ship it',
      preview: 'Two lines changed. LGTM modulo a typo in the comments.',
      description: '## Summary\n\nReady to merge.\n\n- typo in `auth.ts`\n- everything else looks fine',
      description_format: 'markdown',
      attachments: [
        { artifact_id: 'pr-99-walkthrough', type: 'walkthrough', title: 'Walkthrough' },
        { artifact_id: 'pr-99-review', type: 'pr-review' },
      ],
      recipe_instance: { id: 'ri_demo_abcd', workspace_id: 'ws-demo' },
      trigger_id: 'ado.new-pr-watcher#auth-svc',
      labels: ['critical', 'ready-to-merge', 'critical'], // duplicate dropped
    } });
    assert.ok(!upsertRes.isError);
    const item = upsertRes.structuredContent?.item;
    assert.equal(item?.preview, 'Two lines changed. LGTM modulo a typo in the comments.');
    assert.equal(item?.description_format, 'markdown');
    assert.equal(typeof item?.description_size, 'number');
    assert.ok((item?.description_size ?? 0) > 0, 'description_size should be > 0');
    assert.equal(item?.attachments?.length, 2);
    assert.equal(item?.attachments?.[0]?.artifact_id, 'pr-99-walkthrough');
    assert.equal(item?.recipe_instance?.id, 'ri_demo_abcd');
    assert.equal(item?.trigger_id, 'ado.new-pr-watcher#auth-svc');
    // Labels are de-duplicated case-insensitively.
    assert.deepEqual(item?.labels, ['critical', 'ready-to-merge']);

    // The body should be persisted as a sidecar file (NOT inline in inbox.json).
    const bodiesDir = join(h.globalDir, 'inbox-bodies');
    assert.ok(existsSync(bodiesDir), 'inbox-bodies dir should exist');
    const sidecar = join(bodiesDir, 'ado_pr_99.md');
    assert.ok(existsSync(sidecar), `expected sidecar ${sidecar} to exist`);
    const sidecarText = readFileSync(sidecar, 'utf8');
    assert.ok(sidecarText.includes('Ready to merge.'));

    // inbox.json must NOT contain the body inline — only metadata.
    const inboxJson = JSON.parse(readFileSync(join(h.globalDir, 'inbox.json'), 'utf8'));
    const stored = inboxJson.items.find((it) => it.id === 'ado:pr:99');
    assert.ok(stored, 'stored item must be present');
    assert.equal(stored.description, undefined, 'description must not be inlined');
    assert.equal(stored.description_format, 'markdown');
    assert.equal(typeof stored.description_size, 'number');
    assert.equal(stored.attachments.length, 2);

    // inbox.read returns the body inlined via the sidecar.
    const readRes = await h.call('run_tool', { tool: 'inbox.read', args: { id: 'ado:pr:99' } });
    assert.ok(!readRes.isError);
    assert.match(readRes.structuredContent?.description ?? '', /Ready to merge/);

    // include_body: false skips the sidecar read.
    const readNoBody = await h.call('run_tool', { tool: 'inbox.read', args: { id: 'ado:pr:99', include_body: false } });
    assert.equal(readNoBody.structuredContent?.description, null);

    // Empty description deletes the sidecar; description_size becomes 0.
    const clearRes = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      description: '',
    } });
    assert.equal(clearRes.structuredContent?.item?.description_size, 0);
    assert.ok(!existsSync(sidecar), 'sidecar should be deleted after empty description');

    // Empty attachments / labels arrays clear those fields.
    const clearLists = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      attachments: [],
      labels: [],
    } });
    assert.deepEqual(clearLists.structuredContent?.item?.attachments, []);
    assert.deepEqual(clearLists.structuredContent?.item?.labels, []);

    // null clears nullable refs.
    const clearRefs = await h.call('run_tool', { tool: 'inbox.upsert', args: {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      recipe_instance: null,
      trigger_id: null,
    } });
    assert.equal(clearRefs.structuredContent?.item?.recipe_instance, null);
    assert.equal(clearRefs.structuredContent?.item?.trigger_id, null);

    // inbox.list filters by label.
    const filtered = await h.call('run_tool', { tool: 'inbox.list', args: { label: 'critical' } });
    const filteredIds = filtered.structuredContent?.items?.map((it) => it.id) ?? [];
    // ado:pr:99's labels were cleared above so it should NOT match. Sanity:
    assert.ok(!filteredIds.includes('ado:pr:99'), 'cleared labels must not match');
  });

  await t.test('recipe.upsert validates shape and rejects malformed sources', async () => {
    const res = await h.call('run_tool', { tool: 'recipe.upsert', args: {
      id: 'broken',
      scope: 'project',
      source: 'id: broken\n# missing name and description',
    } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'VALIDATION_FAILED');
    const paths = res.structuredContent?.errors?.map((e) => e.path) ?? [];
    assert.ok(paths.includes('name'), 'expected name path among errors');
    assert.ok(paths.includes('description'), 'expected description path among errors');
  });

  await t.test('trigger.list_types surfaces the ADO plugin trigger types', async () => {
    const res = await h.call('run_tool', { tool: 'trigger.list_types', args: { scope: 'plugin:ado' } });
    const types = res.structuredContent?.trigger_types ?? [];
    const ids = types.map((t) => t.id).sort();
    // After the 2026-05-28 callback-binding cleanup, the ADO plugin no
    // longer declares any trigger types — new scripts will be written
    // against the L3 SessionConductor wiring once that lands.
    assert.deepEqual(ids, []);
  });

  await t.test('trigger.register rejects unknown type_id with TRIGGER_TYPE_NOT_FOUND', async () => {
    const res = await h.call('run_tool', { tool: 'trigger.register', args: {
      type_id: 'nope.does-not-exist',
      params: {},
    } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'TRIGGER_TYPE_NOT_FOUND');
  });

  await t.test('trigger.fire returns NOT_FOUND for unknown id', async () => {
    const res = await h.call('run_tool', { tool: 'trigger.fire', args: { id: 'nope.does-not-exist#unknown' } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_FOUND');
  });
});
