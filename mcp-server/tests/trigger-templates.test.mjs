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
