/**
 * kernel-smoke.test.mjs — Phase 10 end-to-end smoke verification.
 *
 * Spawns a REAL `clawdevbox start --service-runner` child against a tmp
 * project/global dir, waits for `/healthz`, then exercises the live
 * kernel control plane (`/api/cron/status`, `/api/fires`,
 * `/api/cron/diagnose`) over real HTTP. This is the only test that
 * verifies the whole bootstrap → kernel → HTTP API stack works
 * end-to-end against the same process tree we ship.
 *
 * Tasks 10.3 (recipe step API), 10.4 (MCP bootstrap), and 10.5
 * (Mode-B callback) are intentionally NOT duplicated here — they are
 * each covered by a dedicated test file already:
 *   - 10.3 → tests/recipe-step-tools.test.mjs (in-process harness; spec §10.5)
 *   - 10.4 → tests/mcp-bootstrap.test.mjs    (real spawn of `start --service-runner`)
 *   - 10.5 → tests/callback-api.test.mjs     (POST /callback/<fire_id>)
 *
 * The kernel-internal mechanics (claim, retry ladder, overlap-skip,
 * dead-letter, /callback) are covered by dispatcher.test.mjs,
 * scheduler.test.mjs, db-stores.test.mjs, and cron-api.test.mjs against
 * in-memory or in-process surfaces. What's missing — and what this file
 * fills — is "does the wiring actually come up when you run the real
 * CLI?". So this test deliberately stays narrow: spawn, probe, poke,
 * tear down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
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
  readServiceState,
} from '../src/service.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const BOOTSTRAP_TIMEOUT_MS = 30_000;
const TEARDOWN_GRACE_MS = 3000;

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), `cdb-kernel-smoke-${prefix}-`));
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

/**
 * Spawn `clawdevbox start --service-runner` exactly the way
 * ensureHttpServiceRunning does, against fresh tmp dirs. Returns
 * `{ pid, port, globalDir, projectDir, token, logPath, cleanup }`.
 */
async function spawnKernelService() {
  const globalDir = freshDir('global');
  const projectDir = freshDir('project');
  const port = await freePort();
  const token = `kernel-smoke-${Math.random().toString(36).slice(2, 10)}`;

  // Match mcp.ts:resolveExecForBootstrap behavior: under `npm test` we're
  // running through tsx, so `process.execPath` is node and we need to
  // invoke the CLI via tsx-loaded src/index.ts. We re-use spawnDetached
  // so the child is fully detached on POSIX and gets a per-process log
  // file. This matches what `clawdevbox mcp` does at runtime.
  const execPath = process.execPath;
  const cliEntry = resolve(projectRoot, 'src/index.ts');
  // The `--import tsx` form was reliable on Node 20.6+. We don't pin a
  // node version in CI; if tsx isn't installed, the spawn will fail and
  // the /healthz probe will time out cleanly.
  const execArgs = ['--import', 'tsx', cliEntry];
  const childArgs = [
    ...execArgs,
    'start',
    '--service-runner',
    '--global',
    globalDir,
    '--project',
    projectDir,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--token',
    token,
  ];

  const env = {
    ...process.env,
    CLAWDEVBOX_PROJECT_DIR: projectDir,
    CLAWDEVBOX_GLOBAL_DIR: globalDir,
    CLAWDEVBOX_TOKEN: token,
  };

  let pid;
  let logPath = null;
  try {
    // Build the detached spawn ourselves rather than going through
    // service.spawnDetached() — we MUST pass an env override so the
    // parent's CLAWDEVBOX_* env (if any) doesn't shadow our --project /
    // --global / --token flags.
    mkdirSync(globalDir, { recursive: true });
    logPath = join(globalDir, 'service.log');
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
    pid = child.pid;
  } catch (err) {
    await rmrfWithRetry(globalDir);
    await rmrfWithRetry(projectDir);
    throw err;
  }

  // Record state so listenOrConfirmExisting-style probes can find us.
  writeServiceState(globalDir, {
    pid,
    port,
    started_at: Date.now(),
    version: '0.0.0-smoke',
    exec_path: execPath,
    exec_args: childArgs,
  });

  const cleanup = async () => {
    await killPid(pid);
    await waitForDead(pid, TEARDOWN_GRACE_MS);
    await rmrfWithRetry(globalDir);
    await rmrfWithRetry(projectDir);
  };

  // Wait for the service to answer /healthz.
  const probe = await probeHealth({
    host: '127.0.0.1',
    port,
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
  });
  if (!probe.ok) {
    const tail = logPath
      ? safeRead(logPath, 4000)
      : '(no log path)';
    await cleanup();
    throw new Error(
      `service did not become healthy within ${BOOTSTRAP_TIMEOUT_MS}ms\nreason: ${probe.reason}\nlog tail:\n${tail}`,
    );
  }

  return { pid, port, globalDir, projectDir, token, logPath, cleanup };
}

function safeRead(path, lastBytes) {
  try {
    const buf = readFileSync(path, 'utf8');
    return lastBytes && buf.length > lastBytes ? buf.slice(-lastBytes) : buf;
  } catch {
    return '(no log content)';
  }
}

// ---------------------------------------------------------------------------
// Task 10.1 — /api/cron/status against a real running service.
// ---------------------------------------------------------------------------

test(
  'kernel smoke: /api/cron/status returns service+scheduler+dispatcher+db shape',
  { timeout: 60_000 },
  async () => {
    const svc = await spawnKernelService();
    try {
      const r = await fetch(`http://127.0.0.1:${svc.port}/api/cron/status`, {
        headers: { authorization: `Bearer ${svc.token}` },
      });
      assert.equal(r.status, 200, 'status endpoint should be 200');
      const body = await r.json();
      assert.ok(body.service, 'service block present');
      assert.equal(body.service.pid, svc.pid, 'service.pid matches spawned child');
      assert.equal(body.service.port, svc.port);
      assert.equal(typeof body.service.started_at, 'number');
      assert.ok(body.scheduler, 'scheduler block present');
      assert.equal(typeof body.scheduler.total_wakes, 'number');
      assert.ok('next_wake_at' in body.scheduler);
      assert.ok(body.dispatcher, 'dispatcher block present');
      assert.equal(typeof body.dispatcher.max_concurrent, 'number');
      assert.ok(body.dispatcher.max_concurrent >= 1);
      assert.ok(body.db, 'db block present');
      assert.ok(body.db.schema_version >= 1, 'schema_version >= 1');

      // The same service.json on disk should mirror /api/cron/status.
      const state = readServiceState(svc.globalDir);
      assert.ok(state);
      assert.equal(state.pid, svc.pid);
    } finally {
      await svc.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Task 10.1/10.2 — bearer auth + 404 + /api/fires + /api/cron/diagnose
// against the real service. We don't run a full manual fire end-to-end
// because that requires a trigger TYPE in the workspace's triggerTypes
// map, and the dispatcher's script-binding success/failure paths are
// already exhaustively covered by dispatcher.test.mjs. What we DO verify
// here is that the live HTTP plane reads the same SQLite DB the kernel
// is writing to — i.e. the wiring works.
// ---------------------------------------------------------------------------

test(
  'kernel smoke: /api/fires reads rows written to the live kernel DB',
  { timeout: 60_000 },
  async () => {
    const svc = await spawnKernelService();
    try {
      // 1. Empty registry → 0 rows.
      let r = await fetch(`http://127.0.0.1:${svc.port}/api/fires`, {
        headers: { authorization: `Bearer ${svc.token}` },
      });
      assert.equal(r.status, 200);
      let body = await r.json();
      assert.equal(body.count, 0, 'empty fires list');

      // 2. Open the live kernel DB from this test process and insert a
      //    workspace + trigger + fire row. better-sqlite3 + WAL allows a
      //    second writer-attached connection while the kernel holds one.
      const dbPath = join(svc.globalDir, 'clawdevbox.db');
      const db = new BetterSqlite3(dbPath);
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        const wsRow = ensureWorkspace(db, { path: svc.projectDir });
        db.prepare(
          `INSERT INTO triggers (
             id, workspace_id, type, params_json,
             cron_mode, cron_expression, enabled,
             once, max_attempts, backoff_ms_json,
             registered_at, state_json
           ) VALUES (?, ?, ?, '{}', 'disabled', NULL, 1, 0, 3, '[10000]', ?, '{}')`,
        ).run('smoke.t1', wsRow.id, 'smoke.t1.type', Date.now());
        db.prepare(
          `INSERT INTO fires (
             fire_id, workspace_id, trigger_id, source, status,
             attempt, max_attempts, scheduled_at
           ) VALUES (?, ?, ?, 'manual', 'failed', 1, 3, ?)`,
        ).run('fire_smoke_1', wsRow.id, 'smoke.t1', Date.now());
      } finally {
        db.close();
      }

      // 3. /api/fires now sees the row.
      r = await fetch(`http://127.0.0.1:${svc.port}/api/fires`, {
        headers: { authorization: `Bearer ${svc.token}` },
      });
      body = await r.json();
      assert.equal(body.count, 1, 'inserted fire visible to live API');
      assert.equal(body.fires[0].fire_id, 'fire_smoke_1');
      assert.equal(body.fires[0].status, 'failed');

      // 4. /api/fires/<id>/retry transitions failed → queued.
      r = await fetch(
        `http://127.0.0.1:${svc.port}/api/fires/fire_smoke_1/retry`,
        { method: 'POST', headers: { authorization: `Bearer ${svc.token}` } },
      );
      assert.equal(r.status, 200);
      body = await r.json();
      assert.equal(body.fire_id, 'fire_smoke_1');
      assert.equal(body.status, 'queued');

      // 5. /api/cron/diagnose forces a scheduler recompute and returns
      //    the scheduler status.
      r = await fetch(`http://127.0.0.1:${svc.port}/api/cron/diagnose`, {
        method: 'POST',
        headers: { authorization: `Bearer ${svc.token}` },
      });
      assert.equal(r.status, 200);
      body = await r.json();
      assert.ok('total_wakes' in body, 'diagnose returns scheduler status');

      // 6. 401 without bearer (smoke the auth wiring on the live server).
      r = await fetch(`http://127.0.0.1:${svc.port}/api/cron/status`);
      assert.equal(r.status, 401);
    } finally {
      await svc.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Tasks 10.3 / 10.4 / 10.5 — marked covered elsewhere.
//
// We intentionally do NOT duplicate these here. Doing so would require
// spawning the service twice or more per `npm test` run on Windows
// (~10-20s each), which is already a flaky boundary in mcp-bootstrap.
// Adding a third spawn for content that's exhaustively tested elsewhere
// would trade real value for CI fragility.
//
// If the next maintainer wants stronger live coverage, the cleanest
// shape is to (a) hoist `spawnKernelService` into a tests/helpers/
// module, (b) reuse a single service instance across multiple
// sub-tests via `test.before` / `test.after`, and (c) write a trigger
// type manifest into the workspace's `.clawdevbox/trigger-types/`
// directory BEFORE spawning so a real script binding can fire.
// ---------------------------------------------------------------------------

test('kernel smoke: phases 10.3/10.4/10.5 covered by sibling test files (todo marker)', () => {
  // No-op marker so the test report makes the coverage delegation explicit.
  // 10.3 → recipe-step-tools.test.mjs
  // 10.4 → mcp-bootstrap.test.mjs
  // 10.5 → callback-api.test.mjs
  assert.ok(true);
});
