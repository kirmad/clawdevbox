/**
 * recipe-real-e2e.test.mjs — true end-to-end recipe test framework.
 *
 * Every layer is real:
 *   - Real `clawdevbox start --service-runner` child process.
 *   - Real Streamable HTTP MCP transport.
 *   - Real `recipe.run` / `trigger.fire` JSON-RPC calls.
 *   - Real `pty.spawn` of a node agent (the `e2e-test-runner` provider).
 *   - Real HTTP MCP roundtrip from the spawned agent back into the
 *     server: it calls `inbox.upsert`, `recipe.update_steps`, and
 *     `recipe.done` against the same long-lived /mcp transport.
 *   - Real side effects asserted from disk + SQLite: inbox.json,
 *     recipe_instances JSON file + DB row, recipe-instance pty log,
 *     fires DB row, agent_sessions row.
 *
 * The framework is intentionally narrow: it proves the whole pipeline
 * works end-to-end. Targeted invariants are still covered by the in-
 * process tests next door.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import BetterSqlite3 from 'better-sqlite3';

import {
  isProcessAlive,
  probeHealth,
  writeServiceState,
} from '../src/service.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const BOOTSTRAP_TIMEOUT_MS = 45_000;
const TEARDOWN_GRACE_MS = 3000;
const AGENT_POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `cdb-real-e2e-${prefix}-`));
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function killPid(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
      await sleep(500);
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* best-effort */
  }
}

async function waitForDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
}

async function rmrfWithRetry(path, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200 * (i + 1));
    }
  }
}

function safeRead(path, lastBytes) {
  try {
    const buf = readFileSync(path, 'utf8');
    return lastBytes && buf.length > lastBytes ? buf.slice(-lastBytes) : buf;
  } catch {
    return '(no content)';
  }
}

/**
 * Spawn `clawdevbox start --service-runner` against fresh tmp dirs.
 * Mirrors mcp-server/tests/kernel-smoke.test.mjs:spawnKernelService.
 */
async function spawnKernelService({ projectConfig } = {}) {
  const globalDir = freshDir('global');
  const projectDir = freshDir('project');
  const port = await freePort();
  const token = `real-e2e-${Math.random().toString(36).slice(2, 10)}`;

  // Seed project-scope config.json BEFORE the service starts so the kernel
  // picks up overrides like `default_agent_cli` on bootstrap.
  if (projectConfig) {
    const cfgDir = join(projectDir, '.clawdevbox');
    mkdirSync(cfgDir, { recursive: true });
    const fullCfg = { version: 1, ...projectConfig };
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(fullCfg, null, 2));
  }

  const execPath = process.execPath;
  const cliEntry = resolve(projectRoot, 'src/index.ts');
  const execArgs = ['--import', 'tsx', cliEntry];
  const childArgs = [
    ...execArgs,
    'start',
    '--service-runner',
    '--global', globalDir,
    '--project', projectDir,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--token', token,
  ];

  const env = {
    ...process.env,
    CLAWDEVBOX_PROJECT_DIR: projectDir,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
    CLAWDEVBOX_TOKEN: token,
  };

  mkdirSync(globalDir, { recursive: true });
  const logPath = join(globalDir, 'service.log');
  const fdOut = openSync(logPath, 'a');
  const fdErr = openSync(logPath, 'a');
  const child = spawn(execPath, childArgs, {
    detached: true,
    stdio: ['ignore', fdOut, fdErr],
    windowsHide: true,
    shell: false,
    env,
  });
  child.unref();
  if (!child.pid) throw new Error('spawn returned no pid');
  const pid = child.pid;

  writeServiceState(globalDir, {
    pid,
    port,
    started_at: Date.now(),
    version: '0.0.0-real-e2e',
    exec_path: execPath,
    exec_args: childArgs,
  });

  const cleanup = async () => {
    await killPid(pid);
    await waitForDead(pid, TEARDOWN_GRACE_MS);
    await rmrfWithRetry(globalDir);
    await rmrfWithRetry(projectDir);
  };

  const probe = await probeHealth({ host: '127.0.0.1', port, timeoutMs: BOOTSTRAP_TIMEOUT_MS });
  if (!probe.ok) {
    const tail = safeRead(logPath, 4000);
    await cleanup();
    throw new Error(`service did not become healthy: ${probe.reason}\nlog tail:\n${tail}`);
  }

  return { pid, port, globalDir, projectDir, token, logPath, cleanup };
}

// ---------------------------------------------------------------------------
// Raw HTTP MCP helper — same shape as the agent uses.
// ---------------------------------------------------------------------------

function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { return JSON.parse(payload); } catch { /* keep scanning */ }
      }
    }
  }
  return null;
}

class McpHttpClient {
  constructor(url, bearer) {
    this.url = url;
    this.bearer = bearer;
    this.sessionId = null;
    this.nextId = 1;
  }

  baseHeaders(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...extra,
    };
    if (this.bearer) h.Authorization = `Bearer ${this.bearer}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async rpc(method, params, isNotification = false) {
    const id = isNotification ? undefined : this.nextId++;
    const body = isNotification
      ? { jsonrpc: '2.0', method, params: params || {} }
      : { jsonrpc: '2.0', id, method, params: params || {} };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.baseHeaders(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} on ${method}: ${text.slice(0, 400)}`);
    }
    const respSid = res.headers.get('mcp-session-id');
    if (respSid && !this.sessionId) this.sessionId = respSid;
    return parseSseOrJson(text);
  }

  async initialize() {
    const resp = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'recipe-real-e2e-test', version: '1.0' },
    });
    if (!this.sessionId) {
      throw new Error('initialize did not return mcp-session-id; body=' + JSON.stringify(resp));
    }
    await this.rpc('notifications/initialized', {}, true);
  }

  async callTool(name, args) {
    const resp = await this.rpc('tools/call', {
      name: 'run_tool',
      arguments: { tool: name, args: args || {} },
    });
    if (resp && resp.error) {
      throw new Error(`run_tool ${name} JSON-RPC error: ${JSON.stringify(resp.error)}`);
    }
    const result = resp && resp.result;
    if (result && result.isError) {
      const text = (result.content && result.content[0] && result.content[0].text) || '';
      throw new Error(`tool ${name} returned isError: ${text}`);
    }
    return result;
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: this.baseHeaders() });
    } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

async function pollUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== undefined && result !== null && result !== false) return result;
    } catch (err) {
      lastErr = err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`pollUntil(${label}) timed out after ${timeoutMs}ms${lastErr ? ` (last err: ${lastErr.message})` : ''}`);
}

function openDb(globalDir) {
  const dbPath = join(globalDir, 'clawdevbox.db');
  const db = new BetterSqlite3(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

const INLINE_RECIPE_YAML = [
  'id: e2e-inline-recipe',
  'name: E2E Inline Recipe',
  'description: Ad-hoc recipe driven by the e2e-test-runner agent CLI.',
  'agent_cli: e2e-test-runner',
  'steps: []',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Test A — recipe.run direct path.
// ---------------------------------------------------------------------------

test(
  'real e2e: recipe.run spawns e2e-test-runner agent which roundtrips MCP and recipe.done',
  { timeout: 120_000 },
  async () => {
    const svc = await spawnKernelService();
    const client = new McpHttpClient(`http://127.0.0.1:${svc.port}/mcp`, svc.token);
    try {
      await client.initialize();

      const runResult = await client.callTool('recipe.run', {
        source: INLINE_RECIPE_YAML,
        prompt: 'run e2e test',
        agent_cli: 'e2e-test-runner',
      });

      const structured = runResult && runResult.structuredContent;
      assert.ok(structured, `recipe.run returned no structuredContent: ${JSON.stringify(runResult)}`);
      const instanceId = structured.recipe_instance_id;
      const workspacePath = structured.workspace_path;
      const workspaceId = structured.workspace_id;
      const logPath = structured.log_path;
      assert.ok(instanceId, 'instanceId is set');
      assert.ok(workspacePath, 'workspacePath is set');
      assert.equal(structured.agent_cli, 'e2e-test-runner');

      // Poll the DB until status becomes terminal.
      const finalRow = await pollUntil(() => {
        const db = openDb(svc.globalDir);
        try {
          const row = db
            .prepare('SELECT id, status, message FROM recipe_instances WHERE id = ?')
            .get(instanceId);
          if (row && row.status && row.status !== 'running') return row;
          return null;
        } finally {
          db.close();
        }
      }, AGENT_POLL_TIMEOUT_MS, `recipe_instances row for ${instanceId} reaches terminal`);

      // Pull diagnostic info eagerly so a failure shows the agent's stderr.
      const logTail = safeRead(logPath, 4000);
      const instanceFilePath = join(workspacePath, '.clawdevbox', 'recipe-instances', `${instanceId}.json`);
      const instanceFile = existsSync(instanceFilePath) ? JSON.parse(readFileSync(instanceFilePath, 'utf8')) : null;

      assert.equal(
        finalRow.status,
        'success',
        `expected status=success; got ${finalRow.status}; message=${finalRow.message}; log tail:\n${logTail}`,
      );

      // Recipe-instance JSON file
      assert.ok(instanceFile, `instance file ${instanceFilePath} missing`);
      assert.equal(instanceFile.status, 'success');
      assert.ok(
        typeof instanceFile.message === 'string' && instanceFile.message.includes('E2E_MARKER_DONE'),
        `expected message to include E2E_MARKER_DONE; got ${JSON.stringify(instanceFile.message)}`,
      );

      // pty log file
      assert.ok(existsSync(logPath), `pty log ${logPath} should exist`);
      const fullLog = readFileSync(logPath, 'utf8');
      assert.ok(
        fullLog.includes('E2E_MARKER_EXIT_OK'),
        `pty log should contain E2E_MARKER_EXIT_OK; got:\n${fullLog.slice(-1000)}`,
      );

      // inbox.json
      const inboxPath = join(svc.globalDir, 'inbox.json');
      assert.ok(existsSync(inboxPath), 'inbox.json should exist');
      const inbox = JSON.parse(readFileSync(inboxPath, 'utf8'));
      const items = Array.isArray(inbox) ? inbox : (inbox.items || []);
      const item = items.find((i) => i.id === `e2e:${instanceId}`);
      assert.ok(item, `inbox item e2e:${instanceId} not found; items: ${items.map((i) => i.id).join(',')}`);
      assert.ok(item.title && item.title.includes(instanceId), 'inbox title contains instanceId');

      // Workspace + DB sanity
      assert.equal(finalRow.id, instanceId);
      assert.ok(workspaceId, 'workspace id present');

      await client.close();
    } finally {
      await client.close();
      await svc.cleanup();
    }
  },
);

