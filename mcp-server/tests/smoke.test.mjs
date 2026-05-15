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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  await t.test('tools/list registers the full Clawdevbox catalog', async () => {
    const tools = await h.listTools();
    const names = tools.map((x) => x.name);
    assert.ok(tools.length >= 30, `expected >=30 tools, got ${tools.length}`);
    // Spot-check families
    for (const n of [
      'recipe.list', 'recipe.read', 'recipe.upsert', 'recipe.delete',
      'recipe.update_steps', 'recipe.steps.update_status',
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

  await t.test('recipe.upsert format=yaml writes <id>.yaml (default)', async () => {
    const res = await h.call('recipe.upsert', {
      id: 'fmt-yaml',
      scope: 'project',
      source: 'id: fmt-yaml\nname: F\ndescription: d\nsteps:\n  - id: s\n    goal: g\n',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent?.format, 'yaml');
    assert.ok(String(res.structuredContent?.path ?? '').endsWith('.yaml'));
    const projDir = h.tmpRoot;
    assert.ok(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-yaml.yaml')));
    assert.equal(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-yaml.json')), false);
  });

  await t.test('recipe.upsert format=json writes <id>.json', async () => {
    const res = await h.call('recipe.upsert', {
      id: 'fmt-json',
      scope: 'project',
      source: JSON.stringify({
        id: 'fmt-json',
        name: 'J',
        description: 'd',
        steps: [{ id: 's', goal: 'g' }],
      }),
      format: 'json',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent?.format, 'json');
    assert.ok(String(res.structuredContent?.path ?? '').endsWith('.json'));
    const projDir = h.tmpRoot;
    assert.ok(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-json.json')));
    assert.equal(existsSync(join(projDir, '.clawdevbox', 'recipes', 'fmt-json.yaml')), false);

    // recipe.read should still resolve it.
    const read = await h.call('recipe.read', { id: 'fmt-json' });
    assert.ok(!read.isError, JSON.stringify(read));
    assert.equal(read.structuredContent?.parsed?.id, 'fmt-json');
  });

  await t.test('recipe.upsert format toggle removes the sibling file', async () => {
    // Start as yaml.
    await h.call('recipe.upsert', {
      id: 'fmt-toggle',
      scope: 'project',
      source: 'id: fmt-toggle\nname: T\ndescription: d\nsteps:\n  - id: s\n    goal: g\n',
    });
    const projDir = h.tmpRoot;
    const yamlPath = join(projDir, '.clawdevbox', 'recipes', 'fmt-toggle.yaml');
    const jsonPath = join(projDir, '.clawdevbox', 'recipes', 'fmt-toggle.json');
    assert.ok(existsSync(yamlPath));
    assert.equal(existsSync(jsonPath), false);

    // Now upsert as json — yaml sibling should disappear.
    const res = await h.call('recipe.upsert', {
      id: 'fmt-toggle',
      scope: 'project',
      source: JSON.stringify({
        id: 'fmt-toggle',
        name: 'T',
        description: 'd',
        steps: [{ id: 's', goal: 'g' }],
      }),
      format: 'json',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(yamlPath), false, 'yaml sibling should be removed');
    assert.ok(existsSync(jsonPath));
    assert.ok((res.structuredContent?.removed_siblings ?? []).some((p) => p.endsWith('.yaml')));
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

  await t.test('skill.upsert writes skills/<id>/SKILL.md (directory shape)', async () => {
    const id = 'demo-skill';
    const res = await h.call('skill.upsert', {
      id,
      scope: 'project',
      source: '---\nname: demo-skill\ndescription: a demo\n---\nhello body\n',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    const expected = join(h.tmpRoot, '.clawdevbox', 'skills', id, 'SKILL.md');
    assert.equal(res.structuredContent?.path, expected);
    assert.ok(existsSync(expected), `expected SKILL.md at ${expected}`);
    // Legacy flat file must NOT exist
    assert.equal(existsSync(join(h.tmpRoot, '.clawdevbox', 'skills', `${id}.md`)), false);
    // skill.read returns the same source
    const read = await h.call('skill.read', { id, scope: 'project' });
    assert.ok(!read.isError, JSON.stringify(read));
    assert.match(read.structuredContent?.source ?? '', /hello body/);
  });

  await t.test('skill.upsert injects frontmatter.name when missing', async () => {
    const id = 'name-injected';
    const res = await h.call('skill.upsert', {
      id,
      scope: 'project',
      source: '---\ndescription: no name field\n---\nbody\n',
    });
    assert.ok(!res.isError, JSON.stringify(res));
    const fileAt = join(h.tmpRoot, '.clawdevbox', 'skills', id, 'SKILL.md');
    const text = readFileSync(fileAt, 'utf8');
    assert.match(text, /name:\s*name-injected/);
    const read = await h.call('skill.read', { id, scope: 'project' });
    assert.equal(read.structuredContent?.frontmatter?.name, id);
  });

  await t.test('skill.upsert rejects mismatched frontmatter.name', async () => {
    const res = await h.call('skill.upsert', {
      id: 'wanted-id',
      scope: 'project',
      source: '---\nname: other-id\ndescription: d\n---\nbody\n',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NAME_MISMATCH');
  });

  await t.test('skill.upsert overwrites existing skill content', async () => {
    const id = 'demo-skill';
    const target = join(h.tmpRoot, '.clawdevbox', 'skills', id, 'SKILL.md');
    const before = readFileSync(target, 'utf8');
    const res = await h.call('skill.upsert', {
      id,
      scope: 'project',
      source: '---\nname: demo-skill\ndescription: updated\n---\nNEW BODY\n',
    });
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
    const res = await h.call('skill.upsert', {
      id,
      scope: 'project',
      source: '---\nname: legacy-flip\ndescription: new\n---\nnew body\n',
    });
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
    const res = await h.call('skill.delete', { id, scope: 'project' });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(dir), false, 'skill dir should be removed recursively');
  });

  await t.test('skill.delete on unknown id returns NOT_FOUND', async () => {
    const res = await h.call('skill.delete', { id: 'nope-nada', scope: 'project' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_FOUND');
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
    // New: upsert reports whether the row was created vs updated.
    assert.equal(up.structuredContent?.created, true, 'expected created=true on first upsert');
    // Re-upserting the same id reports created=false.
    const up2 = await h.call('inbox.upsert', {
      id: 'ado:pr:1',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 1: Fix auth (updated)',
    });
    assert.equal(up2.structuredContent?.created, false, 'expected created=false on re-upsert');
    // Notifications aren't configured in the test harness, so a push attempt
    // surfaces NOTIFICATIONS_DISABLED rather than throwing.
    const pushCall = await h.call('inbox.upsert', {
      id: 'ado:pr:2',
      kind: 'pr_review',
      source: 'ado',
      title: 'PR 2: refactor',
      notify: true,
    });
    assert.equal(pushCall.structuredContent?.push_error_code, 'NOTIFICATIONS_DISABLED');
    assert.equal(pushCall.structuredContent?.push, null);

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
    const upsertRes = await h.call('inbox.upsert', {
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
    });
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
    const readRes = await h.call('inbox.read', { id: 'ado:pr:99' });
    assert.ok(!readRes.isError);
    assert.match(readRes.structuredContent?.description ?? '', /Ready to merge/);

    // include_body: false skips the sidecar read.
    const readNoBody = await h.call('inbox.read', { id: 'ado:pr:99', include_body: false });
    assert.equal(readNoBody.structuredContent?.description, null);

    // Empty description deletes the sidecar; description_size becomes 0.
    const clearRes = await h.call('inbox.upsert', {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      description: '',
    });
    assert.equal(clearRes.structuredContent?.item?.description_size, 0);
    assert.ok(!existsSync(sidecar), 'sidecar should be deleted after empty description');

    // Empty attachments / labels arrays clear those fields.
    const clearLists = await h.call('inbox.upsert', {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      attachments: [],
      labels: [],
    });
    assert.deepEqual(clearLists.structuredContent?.item?.attachments, []);
    assert.deepEqual(clearLists.structuredContent?.item?.labels, []);

    // null clears nullable refs.
    const clearRefs = await h.call('inbox.upsert', {
      id: 'ado:pr:99',
      kind: 'pr_review',
      source: 'ado',
      recipe_instance: null,
      trigger_id: null,
    });
    assert.equal(clearRefs.structuredContent?.item?.recipe_instance, null);
    assert.equal(clearRefs.structuredContent?.item?.trigger_id, null);

    // inbox.list filters by label.
    const filtered = await h.call('inbox.list', { label: 'critical' });
    const filteredIds = filtered.structuredContent?.items?.map((it) => it.id) ?? [];
    // ado:pr:99's labels were cleared above so it should NOT match. Sanity:
    assert.ok(!filteredIds.includes('ado:pr:99'), 'cleared labels must not match');
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

  await t.test('trigger.fire enqueues a DB-backed manual fire row', async () => {
    // Register a trigger with a disabled cron so it only fires when we call.
    const reg = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'fire-svc' },
      cron: false,
    });
    assert.ok(!reg.isError, JSON.stringify(reg));
    const triggerId = reg.structuredContent.id;

    const fire = await h.call('trigger.fire', {
      id: triggerId,
      payload: { hello: 'world', n: 42 },
    });
    assert.ok(!fire.isError, JSON.stringify(fire));
    assert.equal(fire.structuredContent?.trigger_id, triggerId);
    assert.equal(fire.structuredContent?.status, 'queued');
    assert.match(String(fire.structuredContent?.fire_id ?? ''), /^fire_/);

    // Verify the row appears in the kernel DB. The dispatcher may have
    // already moved it past 'queued' by the time we query — just confirm
    // existence + source + payload + trigger linkage.
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const dbPath = join(h.globalDir, 'clawdevbox.db');
    const db = new BetterSqlite3(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT * FROM fires WHERE trigger_id = ? AND source = ?')
      .all(triggerId, 'manual');
    db.close();
    assert.equal(rows.length, 1, `expected one manual fire row; got ${rows.length}`);
    assert.equal(rows[0].fire_id, fire.structuredContent.fire_id);
    assert.ok(rows[0].payload_json, 'payload_json should be populated');
    const payload = JSON.parse(rows[0].payload_json);
    assert.equal(payload.hello, 'world');
    assert.equal(payload.n, 42);

    await h.call('trigger.unregister', { id: triggerId });
  });

  await t.test('trigger.fire returns NOT_FOUND for unknown id', async () => {
    const res = await h.call('trigger.fire', { id: 'ado.new-pr-watcher#does-not-exist' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'NOT_FOUND');
  });

  await t.test('trigger.register persists max_attempts + backoff_ms', async () => {
    const reg = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'retry-svc' },
      cron: false,
      max_attempts: 5,
      backoff_ms: [1000, 5000, 10000],
    });
    assert.ok(!reg.isError, JSON.stringify(reg));
    assert.equal(reg.structuredContent?.registered?.max_attempts, 5);
    assert.deepEqual(reg.structuredContent?.registered?.backoff_ms, [1000, 5000, 10000]);

    // Verify on disk via the DB.
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(join(h.globalDir, 'clawdevbox.db'), { readonly: true });
    const row = db
      .prepare('SELECT max_attempts, backoff_ms_json FROM triggers WHERE id = ?')
      .get(reg.structuredContent.id);
    db.close();
    assert.equal(row.max_attempts, 5);
    assert.deepEqual(JSON.parse(row.backoff_ms_json), [1000, 5000, 10000]);

    await h.call('trigger.unregister', { id: reg.structuredContent.id });
  });

  await t.test('trigger.register rejects max_attempts=0', async () => {
    const res = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'reject-ma' },
      max_attempts: 0,
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'PARAM_VALIDATION');
    const paths = (res.structuredContent?.errors ?? []).map((e) => e.path);
    assert.ok(paths.includes('max_attempts'));
  });

  await t.test('trigger.register rejects empty backoff_ms array', async () => {
    const res = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'reject-bo' },
      backoff_ms: [],
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent?.code, 'PARAM_VALIDATION');
    const paths = (res.structuredContent?.errors ?? []).map((e) => e.path);
    assert.ok(paths.includes('backoff_ms'));
  });

  await t.test('trigger.update_params honors max_attempts + backoff_ms', async () => {
    const reg = await h.call('trigger.register', {
      type_id: 'ado.new-pr-watcher',
      params: { repo: 'upd-svc' },
      cron: false,
    });
    assert.ok(!reg.isError, JSON.stringify(reg));
    const id = reg.structuredContent.id;

    const upd = await h.call('trigger.update_params', {
      id,
      max_attempts: 7,
      backoff_ms: [2000, 4000],
    });
    assert.ok(!upd.isError, JSON.stringify(upd));
    assert.equal(upd.structuredContent?.registered?.max_attempts, 7);
    assert.deepEqual(upd.structuredContent?.registered?.backoff_ms, [2000, 4000]);

    // Invalid update should fail.
    const bad = await h.call('trigger.update_params', { id, max_attempts: -1 });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent?.code, 'PARAM_VALIDATION');

    await h.call('trigger.unregister', { id });
  });
});
