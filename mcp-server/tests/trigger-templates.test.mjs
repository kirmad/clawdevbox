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
const repoSampleAdoPlugin = resolve(projectRoot, '..', 'plugins', 'ado');

// Budgets.
//
// READY_TIMEOUT_MS covers the server *boot* — a fresh `tsx` process cold-
// compiles the whole server graph on every spawn, and under concurrent
// load (many test files / harnesses competing for CPU) a healthy boot can
// easily exceed the old flat 30s. We wait for the server's own deterministic
// readiness signal instead of racing a clock against startup.
//
// CALL_TIMEOUT_MS is the per JSON-RPC-call budget and — critically — only
// starts counting AFTER the server is ready. That is the whole fix: the
// `initialize` (id=1) budget used to start the instant the harness spawned,
// so a slow boot burned the entire budget before the server could answer.
const READY_TIMEOUT_MS = 60000;
const CALL_TIMEOUT_MS = 30000;

// The server logs a deterministic pino line to stderr once stdio MCP is wired
// up (`logger.info({...}, 'ready')` in src/cli/mcp.ts). Pino serializes the
// message under the `msg` key, so this substring is a stable readiness seam.
const READY_STDERR_RE = /"msg":"ready"/;

class TplHarness {
  /**
   * @param {object} [opts]
   * @param {{cmd: string, args: string[], env?: object}} [opts.spawnOverride]
   *   Replace the real server spawn (used by the deterministic readiness seam
   *   test to drive a controllable fake server).
   * @param {number} [opts.readyTimeoutMs]
   * @param {number} [opts.callTimeoutMs]
   */
  constructor(opts = {}) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
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
    if (opts.spawnOverride) {
      const { cmd, args, env } = opts.spawnOverride;
      this.child = spawn(cmd, args, {
        cwd: projectRoot,
        env: { ...this.serverEnv, ...(env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      this.child = spawn('npx', ['tsx', entry, 'mcp'], {
        cwd: projectRoot, env: this.serverEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    }
    this.stdoutBuf = '';
    this.responses = [];
    this.nextId = 1;
    // Readiness / lifecycle state. `awaitResponse` and `waitForReady` both
    // observe these so a crashed or exiting server rejects pending waits with
    // useful stderr instead of hanging until a timeout.
    this.ready_ = false;
    this.exited = null; // { code, signal }
    this.spawnError = null;
    this.stderrBuf = '';
    this.readyWaiters = []; // [{ resolve, reject }]
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
    this.child.stderr.on('data', (d) => {
      // Keep only a bounded tail so a chatty server can't grow this without
      // limit; the tail is what we surface on failure.
      this.stderrBuf = (this.stderrBuf + d.toString('utf8')).slice(-16384);
      if (!this.ready_ && READY_STDERR_RE.test(this.stderrBuf)) {
        this.ready_ = true;
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const w of waiters) w.resolve();
      }
    });
    this.child.on('error', (err) => {
      this.spawnError = err;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) w.reject(err);
    });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      if (!this.ready_) {
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        const err = new Error(
          `server exited before ready (code=${code}, signal=${signal})\n${this.stderrTail()}`,
        );
        for (const w of waiters) w.reject(err);
      }
    });
  }
  stderrTail(limit = 2000) {
    const tail = this.stderrBuf.slice(-limit);
    return tail ? `--- server stderr (tail) ---\n${tail}` : '(no stderr captured)';
  }
  /**
   * Resolve once the server has emitted its deterministic ready signal. Rejects
   * early on spawn error / premature exit, and after `readyTimeoutMs` with the
   * captured stderr tail attached for diagnosis.
   */
  waitForReady() {
    if (this.ready_) return Promise.resolve();
    if (this.spawnError) return Promise.reject(this.spawnError);
    if (this.exited) {
      return Promise.reject(new Error(
        `server exited before ready (code=${this.exited.code}, signal=${this.exited.signal})\n${this.stderrTail()}`,
      ));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new Error(
          `timed out after ${this.readyTimeoutMs}ms waiting for server ready signal\n${this.stderrTail()}`,
        ));
      }, this.readyTimeoutMs);
      this.readyWaiters.push(waiter);
    });
  }
  async ready() {
    // Gate the JSON-RPC handshake on the server's readiness signal FIRST, so
    // the per-call `initialize` budget starts from a booted server rather than
    // racing cold-start.
    await this.waitForReady();
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
        // Fail fast (with stderr) if the server died mid-call rather than
        // waiting out the whole budget.
        if (this.exited) {
          return reject(new Error(
            `server exited while awaiting id=${id} (code=${this.exited.code}, signal=${this.exited.signal})\n${this.stderrTail()}`,
          ));
        }
        if (this.spawnError) {
          return reject(new Error(`server spawn error while awaiting id=${id}: ${this.spawnError.message}`));
        }
        if (Date.now() - start > this.callTimeoutMs) {
          return reject(new Error(`timeout for id=${id} after ${this.callTimeoutMs}ms\n${this.stderrTail()}`));
        }
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

// --- Deterministic readiness-seam regression -------------------------------
// This is the machine-independent RED→GREEN for the startup race that made
// tests intermittently time out on `initialize` (id=1). A fake server stays
// silent on stdout and only becomes responsive AFTER emitting the deterministic
// ready signal, delayed well past the per-call budget. A readiness-blind
// harness (start the initialize clock at spawn) would fail; a readiness-aware
// harness must gate the budget on the ready signal and pass.
test('TplHarness gates the initialize budget on the ready signal (deterministic seam)', async () => {
  const READY_DELAY_MS = 500;
  const CALL_BUDGET_MS = 150; // intentionally << READY_DELAY_MS
  // Fake MCP-ish server: buffer JSON-RPC until "ready", then flush replies.
  const fake = [
    'let buf = "";',
    'let ready = false;',
    'const pending = [];',
    'function reply(id) {',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }) + "\\n");',
    '}',
    'process.stdin.on("data", (d) => {',
    '  buf += d.toString("utf8");',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    let msg; try { msg = JSON.parse(line); } catch { continue; }',
    '    if (msg.id === undefined || msg.id === null) continue;',
    '    if (ready) reply(msg.id); else pending.push(msg.id);',
    '  }',
    '});',
    'setTimeout(() => {',
    '  ready = true;',
    '  process.stderr.write(JSON.stringify({ level: 30, svc: "clawdevbox", msg: "ready" }) + "\\n");',
    '  for (const id of pending) reply(id);',
    `}, ${READY_DELAY_MS});`,
  ].join('\n');
  const h = new TplHarness({
    spawnOverride: { cmd: process.execPath, args: ['-e', fake] },
    callTimeoutMs: CALL_BUDGET_MS,
    readyTimeoutMs: 5000,
  });
  try {
    // Would throw `timeout for id=1` under the old harness; must resolve now.
    await h.ready();
  } finally {
    await h.stop();
  }
});

test('TplHarness.waitForReady surfaces stderr when the server exits before ready', async () => {
  const h = new TplHarness({
    spawnOverride: {
      cmd: process.execPath,
      args: ['-e', 'process.stderr.write("boom: startup failed\\n"); process.exit(3);'],
    },
    readyTimeoutMs: 5000,
  });
  try {
    await assert.rejects(
      () => h.ready(),
      (err) => {
        assert.match(err.message, /exited before ready/);
        assert.match(err.message, /boom: startup failed/);
        return true;
      },
    );
  } finally {
    await h.stop();
  }
});

test('trigger.create_template happy path writes template + script and reloads registry', async () => {
  await withHarness(async (h) => {
    const res = await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.demo', scope: 'project', runtime: 'tsx',
      description: 'demo trigger',
      script: '// demo script\n',
      parameters: [{ name: 'repo', type: 'string', required: true }],
    } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent.id, 'local.demo');
    assert.equal(res.structuredContent.scope, 'project');
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.demo', 'template.yaml');
    const scriptPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.demo', 'trigger.ts');
    assert.ok(existsSync(tplPath));
    assert.ok(existsSync(scriptPath));
    const list = await h.call('run_tool', { tool: 'trigger.type.list', args: { search: 'local.demo' } });
    const ids = list.structuredContent.trigger_types.map((t) => t.id);
    assert.ok(ids.includes('local.demo'));
  });
});

test('trigger.create_template rejects non-local. id with VALIDATION_FAILED', async () => {
  await withHarness(async (h) => {
    const res = await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'demo', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'VALIDATION_FAILED');
  });
});

test('trigger.create_template rejects neither/both script + script_file with INVALID_REQUEST', async () => {
  await withHarness(async (h) => {
    const neither = await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.x', scope: 'project', runtime: 'tsx', description: 'x',
    } });
    assert.equal(neither.isError, true);
    assert.equal(neither.structuredContent.code, 'INVALID_REQUEST');
    const both = await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.x', scope: 'project', runtime: 'tsx', description: 'x',
      script: '// x\n', script_file: '.clawdevbox/trigger-types/whatever.ts',
    } });
    assert.equal(both.isError, true);
    assert.equal(both.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.create_template rejects double-create with TRIGGER_TEMPLATE_EXISTS', async () => {
  await withHarness(async (h) => {
    const r1 = await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.dup', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    } });
    assert.ok(!r1.isError);
    const r2 = await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.dup', scope: 'project', runtime: 'tsx', description: 'x', script: '// y\n',
    } });
    assert.equal(r2.isError, true);
    assert.equal(r2.structuredContent.code, 'TRIGGER_TEMPLATE_EXISTS');
  });
});

test('trigger.list_templates returns only agent-authored types', async () => {
  await withHarness(async (h) => {
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.alpha', scope: 'project', runtime: 'tsx',
      description: 'a', script: '// a\n',
    } });
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.beta', scope: 'global', runtime: 'tsx',
      description: 'b', script: '// b\n',
    } });
    const list = await h.call('run_tool', { tool: 'trigger.template.list', args: {} });
    const ids = list.structuredContent.trigger_types.map((t) => t.id).sort();
    assert.deepEqual(ids, ['local.alpha', 'local.beta']);
    const filtered = await h.call('run_tool', { tool: 'trigger.template.list', args: { scope: 'project' } });
    const fids = filtered.structuredContent.trigger_types.map((t) => t.id);
    assert.deepEqual(fids, ['local.alpha']);
  });
});

test('trigger.update_template replaces script content and bumps description', async () => {
  await withHarness(async (h) => {
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.upd', scope: 'project', runtime: 'tsx',
      description: 'first', script: '// v1\n',
    } });
    const upd = await h.call('run_tool', { tool: 'trigger.template.update', args: {
      id: 'local.upd', description: 'second', script: '// v2\n',
    } });
    assert.ok(!upd.isError, JSON.stringify(upd));
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.upd', 'template.yaml');
    const scriptPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.upd', 'trigger.ts');
    assert.match(readFileSync(tplPath, 'utf8'), /second/);
    assert.match(readFileSync(scriptPath, 'utf8'), /v2/);
  });
});

test('trigger.update_template rejects no-changes call with NO_CHANGES', async () => {
  await withHarness(async (h) => {
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.nopu', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    } });
    const r = await h.call('run_tool', { tool: 'trigger.template.update', args: { id: 'local.nopu' } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'NO_CHANGES');
  });
});

test('trigger.update_template returns TRIGGER_TEMPLATE_NOT_FOUND for missing id', async () => {
  await withHarness(async (h) => {
    const r = await h.call('run_tool', { tool: 'trigger.template.update', args: { id: 'local.absent', description: 'x' } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'TRIGGER_TEMPLATE_NOT_FOUND');
  });
});

test('trigger.delete_template removes the directory and reloads registry', async () => {
  await withHarness(async (h) => {
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.del', scope: 'project', runtime: 'tsx',
      description: 'x', script: '// x\n',
    } });
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.del');
    assert.ok(existsSync(dir));
    const res = await h.call('run_tool', { tool: 'trigger.template.delete', args: { id: 'local.del' } });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(dir), false);
    const list = await h.call('run_tool', { tool: 'trigger.type.list', args: { search: 'local.del' } });
    assert.equal(list.structuredContent.trigger_types.length, 0);
  });
});

test('trigger.delete_template refuses while a registered instance still references it', async () => {
  await withHarness(async (h) => {
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.busy', scope: 'project', runtime: 'tsx',
      description: 'x', script: '// x\n',
      parameters: [{ name: 'repo', type: 'string', required: true }],
    } });
    const reg = await h.call('run_tool', { tool: 'trigger.instance.register', args: {
      type_id: 'local.busy', params: { repo: 'svc' },
    } });
    assert.ok(!reg.isError);
    const del = await h.call('run_tool', { tool: 'trigger.template.delete', args: { id: 'local.busy' } });
    assert.equal(del.isError, true);
    assert.equal(del.structuredContent.code, 'TRIGGER_TEMPLATE_IN_USE');
    assert.ok(Array.isArray(del.structuredContent.registered_ids));
  });
});

test('trigger.delete_template returns NOT_FOUND for unknown ids', async () => {
  // Plugin-shipped trigger types (e.g. ado.*) were removed in the F PR
  // (2026-05-28 callback-binding cleanup). With no plugin-shipped types
  // in the tree, this test now only exercises the NOT_FOUND path. If a
  // plugin ever re-ships a trigger type, restore the original assertion
  // that delete_template on it returns TRIGGER_TEMPLATE_NOT_AUTHORED.
  await withHarness(async (h) => {
    const res = await h.call('run_tool', { tool: 'trigger.template.delete', args: { id: 'no.such.template' } });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'TRIGGER_TEMPLATE_NOT_FOUND');
  });
});
test('trigger.register XOR(type_id|script|script_file) — neither is INVALID_REQUEST', async () => {
  await withHarness(async (h) => {
    const r = await h.call('run_tool', { tool: 'trigger.instance.register', args: { params: {} } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.register with inline script writes _oneoff template + once:true cron:false defaults', async () => {
  await withHarness(async (h) => {
    const r = await h.call('run_tool', { tool: 'trigger.instance.register', args: {
      script: '// inline\n', runtime: 'tsx',
    } });
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
    const r = await h.call('run_tool', { tool: 'trigger.instance.register', args: { script: '// x\n' } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'RUNTIME_REQUIRED');
  });
});

test('trigger.unregister removes _oneoff dir for one-off registrations', async () => {
  await withHarness(async (h) => {
    const reg = await h.call('run_tool', { tool: 'trigger.instance.register', args: { script: '// once\n', runtime: 'tsx' } });
    assert.ok(!reg.isError);
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff', reg.structuredContent.template_id);
    assert.ok(existsSync(dir));
    const un = await h.call('run_tool', { tool: 'trigger.instance.unregister', args: { id: reg.structuredContent.id } });
    assert.ok(!un.isError);
    assert.equal(existsSync(dir), false);
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
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.tpl-test', scope: 'project', runtime: 'tsx',
      description: 'tpl', script,
    } });
    const r = await h.call('run_tool', { tool: 'trigger.test', args: { template_id: 'local.tpl-test', timeout_ms: 30000 } });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.exit_code, 0);
    assert.equal(r.structuredContent.stdout_parsed.callback.body.prompt, 'tpl-test');
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
    await h.call('run_tool', { tool: 'trigger.template.create', args: {
      id: 'local.regtest', scope: 'project', runtime: 'tsx',
      description: 'reg', script,
      parameters: [{ name: 'repo', type: 'string', required: true }],
    } });
    const reg = await h.call('run_tool', { tool: 'trigger.instance.register', args: {
      type_id: 'local.regtest', params: { repo: 'svc' }, cron: false,
    } });
    assert.ok(!reg.isError);
    const r = await h.call('run_tool', { tool: 'trigger.test', args: { id: reg.structuredContent.id, timeout_ms: 30000 } });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.stdout_parsed.callback.body.state.repo, 'svc');
  });
});

test('trigger.test enforces XOR(id|template_id|script)', async () => {
  await withHarness(async (h) => {
    const r = await h.call('run_tool', { tool: 'trigger.test', args: {} });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.test honors timeout_ms and reports timed_out', async () => {
  await withHarness(async (h) => {
    const script = `await new Promise(() => {});`;
    const r = await h.call('run_tool', { tool: 'trigger.test', args: { script, runtime: 'tsx', timeout_ms: 800 } });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.timed_out, true);
  });
});

test('trigger.test captures observation files written to output_dir (incl. nested)', async () => {
  await withHarness(async (h) => {
    const script = `
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
mkdirSync(join(env.output_dir, 'nested'), { recursive: true });
writeFileSync(join(env.output_dir, 'observation.json'), JSON.stringify({ hello: 'world' }));
writeFileSync(join(env.output_dir, 'nested', 'note.txt'), 'deep');
`;
    const r = await h.call('run_tool', { tool: 'trigger.test', args: { script, runtime: 'tsx', timeout_ms: 30000 } });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.exit_code, 0, JSON.stringify(r.structuredContent));
    const obs = r.structuredContent.observations;
    assert.ok(Array.isArray(obs), `observations should be an array, got ${JSON.stringify(r.structuredContent)}`);
    const paths = obs.map((o) => o.path);
    assert.deepEqual(paths, ['nested/note.txt', 'observation.json']);
    const top = obs.find((o) => o.path === 'observation.json');
    assert.equal(top.encoding, 'utf8');
    assert.equal(top.truncated, false);
    assert.equal(JSON.parse(top.content).hello, 'world');
    const nested = obs.find((o) => o.path === 'nested/note.txt');
    assert.equal(nested.content, 'deep');
  });
});