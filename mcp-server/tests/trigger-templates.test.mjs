import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/index.ts');
const repoSampleAdoPlugin = resolve(projectRoot, '..', 'samples', 'plugins', 'ado');

class TplHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'cdb-tpl-tools-'));
    this.callerProjectDir = join(this.tmpRoot, 'caller');
    const callerClawdevbox = join(this.callerProjectDir, '.clawdevbox');
    mkdirSync(callerClawdevbox, { recursive: true });
    for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
      mkdirSync(join(callerClawdevbox, sub), { recursive: true });
    }
    this.globalDir = join(this.tmpRoot, '.global');
    const globalAdoPluginDest = join(this.globalDir, 'plugins', 'ado');
    mkdirSync(dirname(globalAdoPluginDest), { recursive: true });
    cpSync(repoSampleAdoPlugin, globalAdoPluginDest, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.endsWith('package-lock.json') && !src.includes('_legacy-mcp-server'),
    });
    const globalNodeModules = join(this.globalDir, 'node_modules');
    if (!existsSync(globalNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      symlinkSync(resolve(projectRoot, 'node_modules'), globalNodeModules, linkType);
    }
    this.serverEnv = {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: this.callerProjectDir,
      CLAWDEVBOX_GLOBAL_DIR: this.globalDir,
    };
    this.child = spawn('npx', ['tsx', entry, 'mcp'], {
      cwd: projectRoot, env: this.serverEnv,
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
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try { this.responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    this.child.stderr.on('data', () => { /* swallow noise */ });
  }
  async ready() {
    await this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
  }
  async call(name, args) {
    const id = this.nextId++;
    await this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return this.awaitResponse(id);
  }
  async send(msg, expectResponse = true) {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    if (!expectResponse) return null;
    return this.awaitResponse(msg.id);
  }
  awaitResponse(id) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const r = this.responses.find((x) => x.id === id);
        if (r) {
          if (r.error) return reject(new Error(JSON.stringify(r.error)));
          return resolve(r.result);
        }
        if (Date.now() - start > 30000) return reject(new Error(`timeout for id=${id}`));
        setTimeout(tick, 25);
      };
      tick();
    });
  }
  async stop() {
    try {
      if (this.child && !this.child.killed) {
        if (platform() === 'win32' && this.child.pid) {
          spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          this.child.kill('SIGTERM');
        }
      }
    } catch { /* ignore */ }
    if (existsSync(this.tmpRoot)) {
      try { rmSync(this.tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

async function withHarness(fn) {
  const h = new TplHarness();
  try { await h.ready(); await fn(h); } finally { await h.stop(); }
}

test('trigger.create_template happy path writes template + script and reloads registry', async () => {
  await withHarness(async (h) => {
    const res = await h.call('trigger.create_template', {
      id: 'local.demo', scope: 'project', runtime: 'tsx',
      description: 'demo trigger',
      script: '// demo script\n',
      parameters: [{ name: 'repo', type: 'string', required: true }],
    });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent.id, 'local.demo');
    assert.equal(res.structuredContent.scope, 'project');
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.demo', 'template.yaml');
    const scriptPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.demo', 'trigger.ts');
    assert.ok(existsSync(tplPath));
    assert.ok(existsSync(scriptPath));
    const list = await h.call('trigger.list_types', { search: 'local.demo' });
    const ids = list.structuredContent.trigger_types.map((t) => t.id);
    assert.ok(ids.includes('local.demo'));
  });
});

test('trigger.create_template rejects non-local. id with VALIDATION_FAILED', async () => {
  await withHarness(async (h) => {
    const res = await h.call('trigger.create_template', {
      id: 'demo', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'VALIDATION_FAILED');
  });
});

test('trigger.create_template rejects neither/both script + script_file with INVALID_REQUEST', async () => {
  await withHarness(async (h) => {
    const neither = await h.call('trigger.create_template', {
      id: 'local.x', scope: 'project', runtime: 'tsx', description: 'x',
    });
    assert.equal(neither.isError, true);
    assert.equal(neither.structuredContent.code, 'INVALID_REQUEST');
    const both = await h.call('trigger.create_template', {
      id: 'local.x', scope: 'project', runtime: 'tsx', description: 'x',
      script: '// x\n', script_file: '.clawdevbox/trigger-types/whatever.ts',
    });
    assert.equal(both.isError, true);
    assert.equal(both.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.create_template rejects double-create with TRIGGER_TEMPLATE_EXISTS', async () => {
  await withHarness(async (h) => {
    const r1 = await h.call('trigger.create_template', {
      id: 'local.dup', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    });
    assert.ok(!r1.isError);
    const r2 = await h.call('trigger.create_template', {
      id: 'local.dup', scope: 'project', runtime: 'tsx', description: 'x', script: '// y\n',
    });
    assert.equal(r2.isError, true);
    assert.equal(r2.structuredContent.code, 'TRIGGER_TEMPLATE_EXISTS');
  });
});

test('trigger.list_templates returns only agent-authored types', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.alpha', scope: 'project', runtime: 'tsx',
      description: 'a', script: '// a\n',
    });
    await h.call('trigger.create_template', {
      id: 'local.beta', scope: 'global', runtime: 'tsx',
      description: 'b', script: '// b\n',
    });
    const list = await h.call('trigger.list_templates', {});
    const ids = list.structuredContent.trigger_types.map((t) => t.id).sort();
    assert.deepEqual(ids, ['local.alpha', 'local.beta']);
    const filtered = await h.call('trigger.list_templates', { scope: 'project' });
    const fids = filtered.structuredContent.trigger_types.map((t) => t.id);
    assert.deepEqual(fids, ['local.alpha']);
  });
});

test('trigger.update_template replaces script content and bumps description', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.upd', scope: 'project', runtime: 'tsx',
      description: 'first', script: '// v1\n',
    });
    const upd = await h.call('trigger.update_template', {
      id: 'local.upd', description: 'second', script: '// v2\n',
    });
    assert.ok(!upd.isError, JSON.stringify(upd));
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.upd', 'template.yaml');
    const scriptPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.upd', 'trigger.ts');
    assert.match(readFileSync(tplPath, 'utf8'), /second/);
    assert.match(readFileSync(scriptPath, 'utf8'), /v2/);
  });
});

test('trigger.update_template rejects no-changes call with NO_CHANGES', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.nopu', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    });
    const r = await h.call('trigger.update_template', { id: 'local.nopu' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'NO_CHANGES');
  });
});

test('trigger.update_template returns TRIGGER_TEMPLATE_NOT_FOUND for missing id', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.update_template', { id: 'local.absent', description: 'x' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'TRIGGER_TEMPLATE_NOT_FOUND');
  });
});

test('trigger.delete_template removes the directory and reloads registry', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.del', scope: 'project', runtime: 'tsx',
      description: 'x', script: '// x\n',
    });
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.del');
    assert.ok(existsSync(dir));
    const res = await h.call('trigger.delete_template', { id: 'local.del' });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(dir), false);
    const list = await h.call('trigger.list_types', { search: 'local.del' });
    assert.equal(list.structuredContent.trigger_types.length, 0);
  });
});

test('trigger.delete_template refuses while a registered instance still references it', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.busy', scope: 'project', runtime: 'tsx',
      description: 'x', script: '// x\n',
      parameters: [{ name: 'repo', type: 'string', required: true }],
    });
    const reg = await h.call('trigger.register', {
      type_id: 'local.busy', params: { repo: 'svc' },
    });
    assert.ok(!reg.isError);
    const del = await h.call('trigger.delete_template', { id: 'local.busy' });
    assert.equal(del.isError, true);
    assert.equal(del.structuredContent.code, 'TRIGGER_TEMPLATE_IN_USE');
    assert.ok(Array.isArray(del.structuredContent.registered_ids));
  });
});

test('trigger.delete_template refuses to delete a plugin-shipped TYPE', async () => {
  await withHarness(async (h) => {
    const res = await h.call('trigger.delete_template', { id: 'ado.new-pr-watcher' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'TRIGGER_TEMPLATE_NOT_AUTHORED');
  });
});
test('trigger.register XOR(type_id|script|script_file) — neither is INVALID_REQUEST', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', { params: {} });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.register with inline script writes _oneoff template + once:true cron:false defaults', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', {
      script: '// inline\n', runtime: 'tsx',
    });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.adhoc, true);
    assert.match(r.structuredContent.template_id, /^local\.oneoff\./);
    assert.equal(r.structuredContent.registered.once, true);
    assert.equal(r.structuredContent.registered.cron, false);
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff', r.structuredContent.template_id);
    assert.ok(existsSync(join(dir, 'template.yaml')));
    assert.ok(existsSync(join(dir, 'trigger.ts')));
  });
});

test('trigger.register with script but no runtime fails RUNTIME_REQUIRED', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', { script: '// x\n' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'RUNTIME_REQUIRED');
  });
});

test('trigger.register with subscriber_thread_id sets binds_callback_to thread_resume in the auto-template', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', {
      script: '// hot\n', runtime: 'tsx', subscriber_thread_id: 'thr_abc',
    });
    assert.ok(!r.isError);
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff',
      r.structuredContent.template_id, 'template.yaml');
    assert.match(readFileSync(tplPath, 'utf8'), /binds_callback_to:\s*thread_resume/);
  });
});

test('trigger.unregister removes _oneoff dir for one-off registrations', async () => {
  await withHarness(async (h) => {
    const reg = await h.call('trigger.register', { script: '// once\n', runtime: 'tsx' });
    assert.ok(!reg.isError);
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff', reg.structuredContent.template_id);
    assert.ok(existsSync(dir));
    const un = await h.call('trigger.unregister', { id: reg.structuredContent.id });
    assert.ok(!un.isError);
    assert.equal(existsSync(dir), false);
  });
});
test('trigger.test with inline script captures Mode B callback', async () => {
  await withHarness(async (h) => {
    const script = `
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const secret = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${secret}\` },
  body: JSON.stringify({ prompt: 'inline test', context: {} }),
});
process.stdout.write(JSON.stringify({ state: { ok: true } }));
`;
    const r = await h.call('trigger.test', { script, runtime: 'tsx', timeout_ms: 30000 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.exit_code, 0);
    assert.equal(r.structuredContent.timed_out, false);
    assert.ok(Array.isArray(r.structuredContent.callbacks));
    assert.equal(r.structuredContent.callbacks.length, 1);
    assert.equal(r.structuredContent.callbacks[0].mode, 'B');
    assert.equal(r.structuredContent.callbacks[0].body.prompt, 'inline test');
  });
});

test('trigger.test by template_id resolves a saved template', async () => {
  await withHarness(async (h) => {
    const script = `
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
process.stdout.write(JSON.stringify({ callback: { body: { prompt: 'tpl-test' } } }));
`;
    await h.call('trigger.create_template', {
      id: 'local.tpl-test', scope: 'project', runtime: 'tsx',
      description: 'tpl', script,
    });
    const r = await h.call('trigger.test', { template_id: 'local.tpl-test', timeout_ms: 30000 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.exit_code, 0);
    assert.equal(r.structuredContent.callbacks.length, 1);
    assert.equal(r.structuredContent.callbacks[0].mode, 'A');
    assert.equal(r.structuredContent.callbacks[0].body.prompt, 'tpl-test');
  });
});

test('trigger.test by registered id uses the bound params + state', async () => {
  await withHarness(async (h) => {
    const script = `
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
process.stdout.write(JSON.stringify({ callback: { body: { prompt: 'reg', state: env.state } } }));
`;
    await h.call('trigger.create_template', {
      id: 'local.regtest', scope: 'project', runtime: 'tsx',
      description: 'reg', script,
      parameters: [{ name: 'repo', type: 'string', required: true }],
    });
    const reg = await h.call('trigger.register', {
      type_id: 'local.regtest', params: { repo: 'svc' }, cron: false,
    });
    assert.ok(!reg.isError);
    const r = await h.call('trigger.test', { id: reg.structuredContent.id, timeout_ms: 30000 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.callbacks[0].body.state.repo, 'svc');
  });
});

test('trigger.test enforces XOR(id|template_id|script)', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.test', {});
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.test honors timeout_ms and reports timed_out', async () => {
  await withHarness(async (h) => {
    const script = `await new Promise(() => {});`;
    const r = await h.call('trigger.test', { script, runtime: 'tsx', timeout_ms: 800 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.timed_out, true);
  });
});