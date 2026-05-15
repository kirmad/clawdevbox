/**
 * mcp-bootstrap.test.mjs — covers Phase 8 bootstrap helpers.
 *
 * - `listenOrConfirmExisting` (Task 8.3): when the target port is bound by
 *   our own service (probe response matches our schema) -> 'already-running'.
 *   When bound by something else -> 'conflict'. When free -> 'listening'.
 *
 * - `ensureHttpServiceRunning` (Task 8.4): bootstraps a detached child
 *   `clawdevbox start --service-runner` when no service.json is present
 *   (or the recorded PID is dead), then probes /healthz until ready or
 *   a 10s deadline expires. Already-healthy service -> no spawn.
 *
 * The 8.4 tests spawn real child processes; cleanup kills them in
 * `afterEach`. Tests use 60s timeouts to absorb cold-start latency.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { listenOrConfirmExisting } from '../src/cli/start.ts';
import {
  isProcessAlive,
  probeHealth,
  readServiceState,
  writeServiceState,
} from '../src/service.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

function freshGlobalDir() {
  return mkdtempSync(join(tmpdir(), 'cdb-bootstrap-'));
}

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

// ----------------------------------------------------------------------------
// Task 8.3 — listenOrConfirmExisting
// ----------------------------------------------------------------------------

test('listenOrConfirmExisting — port free returns listening', async () => {
  const port = await freePort();
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'token');
    assert.equal(result, 'listening');
    assert.equal(server.address().port, port);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('listenOrConfirmExisting — port held by our schema returns already-running', async () => {
  const port = await freePort();
  const probeServer = createServer((req, res) => {
    if (req.url === '/api/cron/status' && req.headers.authorization === 'Bearer my-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        service: { pid: 1, port, started_at: 0, version: '0' },
        scheduler: { next_wake_at: null, last_wake_at: null, total_wakes: 0 },
        dispatcher: { in_flight: 0, max_concurrent: 4, queued_count: 0, retrying_count: 0, dead_count: 0 },
        db: { path: ':memory:', schema_version: 1 },
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => probeServer.listen(port, '127.0.0.1', r));
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'my-token');
    assert.equal(result, 'already-running');
  } finally {
    await new Promise((r) => probeServer.close(r));
    if (server.listening) await new Promise((r) => server.close(r));
  }
});

test('listenOrConfirmExisting — port held by something else returns conflict', async () => {
  const port = await freePort();
  // Foreign server returns 200 OK but a totally different shape.
  const foreign = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service_name: 'something-else', version: '1.0' }));
  });
  await new Promise((r) => foreign.listen(port, '127.0.0.1', r));
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'token');
    assert.equal(result, 'conflict');
  } finally {
    await new Promise((r) => foreign.close(r));
    if (server.listening) await new Promise((r) => server.close(r));
  }
});

// ----------------------------------------------------------------------------
// Task 8.4 — ensureHttpServiceRunning
//
// We import the helper from `cli/mcp.ts` (it's exported for tests). It
// shells out to a real `clawdevbox start --service-runner` via tsx; cold
// start can take 5-30s on Windows so these tests use 60s timeouts.
// ----------------------------------------------------------------------------

async function importEnsure() {
  const mod = await import('../src/cli/mcp.ts');
  return mod.ensureHttpServiceRunning;
}

async function killPid(pid) {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
      await sleep(200);
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* best-effort */
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
  // Give up silently — Windows handle release races are not worth failing tests.
}

async function waitForDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
}

test('ensureHttpServiceRunning — already healthy service is reused (no spawn)', { timeout: 30000 }, async () => {
  // Stand up a tiny health server we can pretend is the running service.
  const port = await freePort();
  const fake = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => fake.listen(port, '127.0.0.1', r));

  const globalDir = freshGlobalDir();
  writeServiceState(globalDir, {
    pid: process.pid, // we know this pid is alive
    port,
    started_at: Date.now(),
    version: '0.0.0',
    exec_path: 'node',
    exec_args: [],
  });

  const ensure = await importEnsure();
  try {
    const result = await ensure({
      globalDir,
      http: { host: '127.0.0.1', port, token: 'unused' },
    });
    assert.equal(result.running, true);
    assert.equal(result.started, false);
    assert.equal(result.pid, process.pid);
  } finally {
    await new Promise((r) => fake.close(r));
    await rmrfWithRetry(globalDir);
  }
});

test('ensureHttpServiceRunning — stale service.json (dead pid) is cleared and respawned', { timeout: 60000 }, async () => {
  const globalDir = freshGlobalDir();
  const projectDir = freshGlobalDir();
  const port = await freePort();
  writeServiceState(globalDir, {
    pid: 999999,
    port,
    started_at: 0,
    version: '0.0.0',
    exec_path: 'nope',
    exec_args: [],
  });

  const ensure = await importEnsure();
  let spawnedPid = null;
  const prev = {
    token: process.env.CLAWDEVBOX_TOKEN,
    proj: process.env.CLAWDEVBOX_PROJECT_DIR,
  };
  process.env.CLAWDEVBOX_TOKEN = 'test-bootstrap-token';
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  try {
    const result = await ensure({
      globalDir,
      http: { host: '127.0.0.1', port, token: 'test-bootstrap-token' },
    });
    if (!result.running) {
      const logPath = result.logPath ?? join(globalDir, 'service.log');
      const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(no log)';
      assert.fail(`bootstrap did not become healthy: ${result.reason}\nLog tail:\n${tail}`);
    }
    assert.equal(result.started, true);
    spawnedPid = result.pid;
    assert.equal(isProcessAlive(spawnedPid), true);

    const state = readServiceState(globalDir);
    assert.ok(state);
    assert.equal(state.pid, spawnedPid);
  } finally {
    if (prev.token === undefined) delete process.env.CLAWDEVBOX_TOKEN;
    else process.env.CLAWDEVBOX_TOKEN = prev.token;
    if (prev.proj === undefined) delete process.env.CLAWDEVBOX_PROJECT_DIR;
    else process.env.CLAWDEVBOX_PROJECT_DIR = prev.proj;
    if (spawnedPid) {
      await killPid(spawnedPid);
      await waitForDead(spawnedPid, 5000);
    }
    await rmrfWithRetry(globalDir);
    await rmrfWithRetry(projectDir);
  }
});

test('ensureHttpServiceRunning — no service.json -> spawns and /healthz comes up', { timeout: 60000 }, async () => {
  const globalDir = freshGlobalDir();
  const projectDir = freshGlobalDir();
  const port = await freePort();

  const ensure = await importEnsure();
  let spawnedPid = null;
  const prev = {
    token: process.env.CLAWDEVBOX_TOKEN,
    proj: process.env.CLAWDEVBOX_PROJECT_DIR,
  };
  process.env.CLAWDEVBOX_TOKEN = 'test-bootstrap-token-2';
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  try {
    const result = await ensure({
      globalDir,
      http: { host: '127.0.0.1', port, token: 'test-bootstrap-token-2' },
    });
    if (!result.running) {
      const logPath = result.logPath ?? join(globalDir, 'service.log');
      const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-2000) : '(no log)';
      assert.fail(`bootstrap did not become healthy: ${result.reason}\nLog tail:\n${tail}`);
    }
    spawnedPid = result.pid;
    assert.equal(result.started, true);

    const probe = await probeHealth({ host: '127.0.0.1', port, timeoutMs: 2000 });
    assert.equal(probe.ok, true);
  } finally {
    if (prev.token === undefined) delete process.env.CLAWDEVBOX_TOKEN;
    else process.env.CLAWDEVBOX_TOKEN = prev.token;
    if (prev.proj === undefined) delete process.env.CLAWDEVBOX_PROJECT_DIR;
    else process.env.CLAWDEVBOX_PROJECT_DIR = prev.proj;
    if (spawnedPid) {
      await killPid(spawnedPid);
      await waitForDead(spawnedPid, 5000);
    }
    await rmrfWithRetry(globalDir);
    await rmrfWithRetry(projectDir);
  }
});
