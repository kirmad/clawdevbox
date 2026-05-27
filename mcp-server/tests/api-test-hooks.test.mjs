/**
 * api-test-hooks.test.mjs — real-spawn tests for the loopback test-hook
 * endpoints (`/api/test/*`). Each test boots a real clawdevbox server child
 * against tmp dirs, hits the HTTP endpoint with `fetch`, and asserts the
 * real side effects (DB rows, inbox.json, recipe-instance files, pty log).
 *
 * Architecture mirrors `recipe-real-e2e.test.mjs` — same spawnKernelService
 * pattern, same teardown helpers, same assertion shape. The key difference
 * is the trigger surface: instead of opening an MCP session, the test hits
 * a plain HTTP endpoint with no bearer auth (loopback-only).
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
  return mkdtempSync(join(tmpdir(), `cdb-api-hooks-${prefix}-`));
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

async function spawnKernelService() {
  const globalDir = freshDir('global');
  const projectDir = freshDir('project');
  const port = await freePort();
  const token = `api-hooks-${Math.random().toString(36).slice(2, 10)}`;

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
    version: '0.0.0-api-hooks-test',
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

// ---------------------------------------------------------------------------
// Test 1 — GET /api/test/agent-clis lists e2e-test-runner.
// ---------------------------------------------------------------------------

test('api-test-hooks: GET /api/test/agent-clis lists e2e-test-runner', { timeout: 60_000 }, async () => {
  const svc = await spawnKernelService();
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/test/agent-clis`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.items), 'items is array');
    const ids = body.items.map((i) => i.id);
    assert.ok(ids.includes('e2e-test-runner'), `e2e-test-runner missing from ${ids.join(',')}`);
    const e2e = body.items.find((i) => i.id === 'e2e-test-runner');
    assert.equal(e2e.source, 'builtin');
    assert.equal(e2e.internal, true);
  } finally {
    await svc.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 2 — POST /api/test/run-e2e fires the agent and yields a real
// recipe-instance + inbox item.
// ---------------------------------------------------------------------------

test('api-test-hooks: POST /api/test/run-e2e drives a real agent end-to-end', { timeout: 120_000 }, async () => {
  const svc = await spawnKernelService();
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/test/run-e2e`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'live api-test-hook' }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${text}`);
    const body = JSON.parse(text);
    assert.equal(body.ok, true, `ok flag: ${JSON.stringify(body)}`);
    assert.equal(body.tool, 'recipe.run');
    assert.ok(body.structuredContent, 'structuredContent present');
    const sc = body.structuredContent;
    const instanceId = sc.recipe_instance_id;
    const workspacePath = sc.workspace_path;
    assert.ok(instanceId, `recipe_instance_id missing: ${JSON.stringify(sc)}`);
    assert.equal(sc.agent_cli, 'e2e-test-runner');

    // Poll DB for terminal status.
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
    }, AGENT_POLL_TIMEOUT_MS, `recipe_instances ${instanceId} reaches terminal`);

    const logPath = sc.log_path;
    const logTail = safeRead(logPath, 4000);

    assert.equal(finalRow.status, 'success', `status=${finalRow.status} message=${finalRow.message} tail:\n${logTail}`);

    const instanceFilePath = join(workspacePath, '.clawdevbox', 'recipe-instances', `${instanceId}.json`);
    assert.ok(existsSync(instanceFilePath), 'instance JSON exists');
    const instanceFile = JSON.parse(readFileSync(instanceFilePath, 'utf8'));
    assert.ok(
      typeof instanceFile.message === 'string' && instanceFile.message.includes('E2E_MARKER_DONE'),
      `instance message missing E2E_MARKER_DONE: ${instanceFile.message}`,
    );

    assert.ok(existsSync(logPath), 'pty log exists');
    const fullLog = readFileSync(logPath, 'utf8');
    assert.ok(
      fullLog.includes('E2E_MARKER_EXIT_OK'),
      `pty log missing E2E_MARKER_EXIT_OK; tail:\n${fullLog.slice(-1000)}`,
    );

    const inboxPath = join(svc.globalDir, 'inbox.json');
    assert.ok(existsSync(inboxPath));
    const inbox = JSON.parse(readFileSync(inboxPath, 'utf8'));
    const items = Array.isArray(inbox) ? inbox : (inbox.items || []);
    const item = items.find((i) => i.id === `e2e:${instanceId}`);
    assert.ok(item, `inbox item e2e:${instanceId} missing from ${items.map((i) => i.id).join(',')}`);
  } finally {
    await svc.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 3 — POST /api/test/recipe-run with inline source.
// ---------------------------------------------------------------------------

test('api-test-hooks: POST /api/test/recipe-run accepts inline source', { timeout: 120_000 }, async () => {
  const svc = await spawnKernelService();
  try {
    const yaml = [
      'id: e2e-explicit-recipe',
      'name: E2E Explicit',
      'description: Explicit-source webhook test.',
      'agent_cli: e2e-test-runner',
      'steps: []',
      '',
    ].join('\n');
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/test/recipe-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: yaml, prompt: 'explicit source', agent_cli: 'e2e-test-runner' }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    const instanceId = body.structuredContent.recipe_instance_id;
    assert.ok(instanceId);

    // Wait until terminal — proves the agent actually ran via this path too.
    await pollUntil(() => {
      const db = openDb(svc.globalDir);
      try {
        const row = db
          .prepare('SELECT status FROM recipe_instances WHERE id = ?')
          .get(instanceId);
        if (row && row.status === 'success') return row;
        return null;
      } finally {
        db.close();
      }
    }, AGENT_POLL_TIMEOUT_MS, `recipe_instances ${instanceId} reaches success`);
  } finally {
    await svc.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Test 4 — invalid bodies return 400; missing tool name returns 404.
// ---------------------------------------------------------------------------

test('api-test-hooks: input validation errors', { timeout: 30_000 }, async () => {
  const svc = await spawnKernelService();
  try {
    // Missing both id and source
    const r1 = await fetch(`http://127.0.0.1:${svc.port}/api/test/recipe-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r1.status, 400);
    const j1 = await r1.json();
    assert.equal(j1.error.code, 'INVALID_REQUEST');

    // trigger-fire without id
    const r2 = await fetch(`http://127.0.0.1:${svc.port}/api/test/trigger-fire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r2.status, 400);

    // unknown sub-route
    const r3 = await fetch(`http://127.0.0.1:${svc.port}/api/test/does-not-exist`, { method: 'POST' });
    assert.equal(r3.status, 404);
    const j3 = await r3.json();
    assert.equal(j3.error.code, 'UNKNOWN_TEST_HOOK');

    // bad JSON body
    const r4 = await fetch(`http://127.0.0.1:${svc.port}/api/test/recipe-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(r4.status, 400);
    const j4 = await r4.json();
    assert.equal(j4.error.code, 'INVALID_JSON');
  } finally {
    await svc.cleanup();
  }
});
