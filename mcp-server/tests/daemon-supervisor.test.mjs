/**
 * daemon-supervisor.test.mjs — integration coverage for the daemon
 * supervisor + process runner + store.
 *
 * Uses an in-memory sqlite per test + an echo-script (creates a marker
 * file and sleeps) instead of a real Teams listener. Tests are tuned
 * for Windows (no SIGUSR1 etc.).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepP } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from '../src/db/index.ts';
import {
  upsertDaemon, getDaemon, listDaemons, setEnabled, deleteDaemon,
  getLiveRun, listRecentRuns, bumpGeneration, claimStartingRun,
  reconcileOrphanRuns, markRunRunning, markRunExited,
} from '../src/db/daemons-store.ts';
import { DaemonSupervisor } from '../src/daemon-supervisor.ts';
import { DaemonProcess, daemonLogPath, readDaemonLog } from '../src/daemon-process-runner.ts';

const __filename = fileURLToPath(import.meta.url);
const TMP_ROOT = resolve(dirname(__filename), '.tmp', 'daemon-supervisor');

function freshDirs(name) {
  const root = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  const wsPath = join(root, 'ws');
  mkdirSync(wsPath, { recursive: true });
  return { root, wsPath };
}

function makeDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertWorkspace(db, id, path) {
  db.prepare(
    'INSERT INTO workspaces (id, path, name, parent_workspace_id, created_at) VALUES (?, ?, NULL, NULL, ?)',
  ).run(id, path, Date.now());
}

/** A Node script that writes "alive" then sleeps `runMs`. */
function aliveScript(markerPath, runMs) {
  return `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(markerPath)}, 'alive'); await new Promise((r) => setTimeout(r, ${runMs}));`;
}

/** A Node script that exits non-zero immediately. */
function failScript() {
  return `process.exit(7);`;
}

function writeScript(dir, name, contents) {
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

// ============================================================================
// store tests
// ============================================================================

test('1. store: upsert + list + get + setEnabled + delete', () => {
  const dirs = freshDirs('store1');
  const db = makeDb();
  try {
    insertWorkspace(db, 'ws1', dirs.wsPath);
    const d = upsertDaemon(db, {
      name: 'echo', workspace_id: 'ws1', runtime: 'node', command: ['-e', 'console.log(1)'],
    });
    assert.ok(d.id.startsWith('dmn_'));
    assert.equal(d.enabled, 1);
    assert.equal(d.generation, 1);

    const list = listDaemons(db);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, d.id);

    setEnabled(db, d.id, false);
    const d2 = getDaemon(db, d.id);
    assert.equal(d2.enabled, 0);
    assert.equal(d2.generation, 2, 'setEnabled should bump generation');

    deleteDaemon(db, d.id);
    assert.equal(getDaemon(db, d.id), null);
  } finally { db.close(); rmSync(dirs.root, { recursive: true, force: true }); }
});

test('2. store: claimStartingRun enforces single live run via partial unique index', () => {
  const dirs = freshDirs('store2');
  const db = makeDb();
  try {
    insertWorkspace(db, 'ws1', dirs.wsPath);
    const d = upsertDaemon(db, {
      name: 'x', workspace_id: 'ws1', runtime: 'node', command: ['-e', '0'],
    });
    const r1 = claimStartingRun(db, d.id, 1, '/tmp/a.log');
    assert.ok(r1, 'first claim should succeed');
    const r2 = claimStartingRun(db, d.id, 1, '/tmp/b.log');
    assert.equal(r2, null, 'second claim should fail while first is starting');
    markRunRunning(db, r1.id, 12345);
    const r3 = claimStartingRun(db, d.id, 1, '/tmp/c.log');
    assert.equal(r3, null, 'still rejected while first is running');
    markRunExited(db, r1.id, { status: 'exited', exit_code: 0, signal: null, error: null });
    const r4 = claimStartingRun(db, d.id, 1, '/tmp/d.log');
    assert.ok(r4, 'allowed once previous run exited');
  } finally { db.close(); rmSync(dirs.root, { recursive: true, force: true }); }
});

test('3. store: reconcileOrphanRuns marks leftover live rows stopped', () => {
  const dirs = freshDirs('store3');
  const db = makeDb();
  try {
    insertWorkspace(db, 'ws1', dirs.wsPath);
    const d = upsertDaemon(db, {
      name: 'x', workspace_id: 'ws1', runtime: 'node', command: ['-e', '0'],
    });
    claimStartingRun(db, d.id, 1, '/tmp/a.log');
    const cleared = reconcileOrphanRuns(db);
    assert.equal(cleared, 1);
    // After reconciliation, a new claim succeeds.
    const r2 = claimStartingRun(db, d.id, 1, '/tmp/b.log');
    assert.ok(r2, 'orphan reconciliation unblocks new claim');
  } finally { db.close(); rmSync(dirs.root, { recursive: true, force: true }); }
});

test('4. store: bumpGeneration increments + returns new value', () => {
  const dirs = freshDirs('store4');
  const db = makeDb();
  try {
    insertWorkspace(db, 'ws1', dirs.wsPath);
    const d = upsertDaemon(db, {
      name: 'x', workspace_id: 'ws1', runtime: 'node', command: ['-e', '0'],
    });
    assert.equal(d.generation, 1);
    const newGen = bumpGeneration(db, d.id);
    assert.equal(newGen, 2);
  } finally { db.close(); rmSync(dirs.root, { recursive: true, force: true }); }
});

// ============================================================================
// runner tests
// ============================================================================

test('5. runner: spawn echo + observe exit', async () => {
  const dirs = freshDirs('run1');
  try {
    const marker = join(dirs.root, 'marker.txt');
    const script = writeScript(dirs.root, 'echo.mjs', aliveScript(marker, 100));
    const logPath = join(dirs.root, 'log.txt');
    const proc = new DaemonProcess({
      runtime: 'direct',
      command: [process.execPath, script],
      cwd: dirs.root,
      logPath,
    });
    const exitPromise = new Promise((r) => proc.once('exit', r));
    const pid = proc.start();
    assert.ok(pid > 0, `expected pid, got ${pid}`);
    const info = await exitPromise;
    assert.equal(info.exit_code, 0);
    assert.ok(existsSync(marker), 'marker file should exist');
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /\[clawdevbox\] spawn/);
    assert.match(log, /\[clawdevbox\] exit code=0/);
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test('6. runner: stop() kills a long-running process', async () => {
  const dirs = freshDirs('run2');
  try {
    const marker = join(dirs.root, 'm.txt');
    const script = writeScript(dirs.root, 'long.mjs', aliveScript(marker, 30_000));
    const proc = new DaemonProcess({
      runtime: 'direct',
      command: [process.execPath, script],
      cwd: dirs.root,
      logPath: join(dirs.root, 'log.txt'),
    });
    const exitPromise = new Promise((r) => proc.once('exit', r));
    proc.start();
    // Wait for the marker to be created so we know it's actually running.
    for (let i = 0; i < 50 && !existsSync(marker); i += 1) await sleepP(50);
    assert.ok(existsSync(marker), 'process should have started');
    await proc.stop();
    const info = await exitPromise;
    // Either clean shutdown (code) or killed (signal/non-zero).
    assert.ok(info.exit_code !== null || info.signal !== null,
      'process should have exited');
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test('7. runner: spawn failure (missing binary) emits exit with spawn_error', async () => {
  const dirs = freshDirs('run3');
  try {
    const proc = new DaemonProcess({
      runtime: 'direct',
      command: [join(dirs.root, 'definitely-does-not-exist.exe')],
      cwd: dirs.root,
      logPath: join(dirs.root, 'log.txt'),
    });
    const exitPromise = new Promise((r) => proc.once('exit', r));
    try { proc.start(); } catch { /* spawn threw — that's the expected path */ }
    const info = await exitPromise;
    assert.ok(info.spawn_error, 'should report a spawn_error');
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

// ============================================================================
// supervisor tests
// ============================================================================

test('8. supervisor: enabled daemon spawns on tick', async () => {
  const dirs = freshDirs('sup1');
  const db = makeDb();
  insertWorkspace(db, 'ws1', dirs.wsPath);
  const sup = new DaemonSupervisor(db, {
    resolveWorkspacePath: () => dirs.wsPath,
    tickIntervalMs: 60_000,  // disable auto-tick; we'll tick manually
  });
  try {
    sup.start();
    const marker = join(dirs.root, 'm.txt');
    const script = writeScript(dirs.root, 'a.mjs', aliveScript(marker, 60_000));
    const d = upsertDaemon(db, {
      name: 'A', workspace_id: 'ws1', runtime: 'direct',
      command: [process.execPath, script],
      restart_policy: { stable_after_ms: 0 },
    });
    sup.tick();
    for (let i = 0; i < 50 && !existsSync(marker); i += 1) await sleepP(50);
    assert.ok(existsSync(marker), 'marker should be created by the spawn');
    const live = getLiveRun(db, d.id);
    assert.ok(live, 'live row should be present');
    assert.equal(live.status, 'running');
  } finally {
    await sup.stop();
    db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('9. supervisor: dead daemon is restarted on exit (with backoff bypass)', async () => {
  const dirs = freshDirs('sup2');
  const db = makeDb();
  insertWorkspace(db, 'ws1', dirs.wsPath);
  const sup = new DaemonSupervisor(db, {
    resolveWorkspacePath: () => dirs.wsPath,
    tickIntervalMs: 60_000,
  });
  try {
    sup.start();
    const m1 = join(dirs.root, 'm1.txt');
    const script = writeScript(dirs.root, 'a.mjs', aliveScript(m1, 80));
    const d = upsertDaemon(db, {
      name: 'A', workspace_id: 'ws1', runtime: 'direct',
      command: [process.execPath, script],
      // Use a backoff of 50ms so the test isn't slow.
      restart_policy: { backoff_ms: [50], stable_after_ms: 0 },
    });
    sup.tick();
    // Wait for first run to complete + supervisor to schedule a restart.
    for (let i = 0; i < 100; i += 1) {
      await sleepP(50);
      const runs = listRecentRuns(db, d.id, 10);
      if (runs.length >= 2) break;
    }
    const runs = listRecentRuns(db, d.id, 10);
    assert.ok(runs.length >= 2, `expected ≥ 2 runs, got ${runs.length}`);
    const exited = runs.filter((r) => ['exited', 'failed', 'stopped'].includes(r.status));
    assert.ok(exited.length >= 1, 'should have at least one exited run');
  } finally {
    await sup.stop();
    db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('10. supervisor: disabled daemon is not respawned after exit', async () => {
  const dirs = freshDirs('sup3');
  const db = makeDb();
  insertWorkspace(db, 'ws1', dirs.wsPath);
  const sup = new DaemonSupervisor(db, {
    resolveWorkspacePath: () => dirs.wsPath,
    tickIntervalMs: 60_000,
  });
  try {
    sup.start();
    const m = join(dirs.root, 'm.txt');
    const script = writeScript(dirs.root, 'a.mjs', aliveScript(m, 50));
    const d = upsertDaemon(db, {
      name: 'A', workspace_id: 'ws1', runtime: 'direct',
      command: [process.execPath, script],
      restart_policy: { backoff_ms: [10], stable_after_ms: 0 },
    });
    sup.tick();
    // Wait for first run to start + exit, then disable BEFORE backoff fires.
    for (let i = 0; i < 50 && !existsSync(m); i += 1) await sleepP(20);
    setEnabled(db, d.id, false);
    await sleepP(500);
    const runs = listRecentRuns(db, d.id, 20);
    // The disabled state + bumped generation should prevent restart.
    // Tolerate a single race-window restart (so assert <= 2).
    assert.ok(runs.length <= 2, `disabled daemon should not keep restarting; got ${runs.length} runs`);
    const final = getDaemon(db, d.id);
    assert.equal(final.enabled, 0);
  } finally {
    await sup.stop();
    db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('11. supervisor: stopDaemon kills live run + bumps generation', async () => {
  const dirs = freshDirs('sup4');
  const db = makeDb();
  insertWorkspace(db, 'ws1', dirs.wsPath);
  const sup = new DaemonSupervisor(db, {
    resolveWorkspacePath: () => dirs.wsPath,
    tickIntervalMs: 60_000,
  });
  try {
    sup.start();
    const m = join(dirs.root, 'm.txt');
    const script = writeScript(dirs.root, 'long.mjs', aliveScript(m, 30_000));
    const d = upsertDaemon(db, {
      name: 'A', workspace_id: 'ws1', runtime: 'direct',
      command: [process.execPath, script],
    });
    const gen0 = d.generation;
    sup.tick();
    for (let i = 0; i < 50 && !existsSync(m); i += 1) await sleepP(50);
    assert.ok(existsSync(m));
    await sup.stopDaemon(d.id);
    const after = getDaemon(db, d.id);
    assert.ok(after.generation > gen0, 'stopDaemon should bump generation');
    const live = getLiveRun(db, d.id);
    assert.equal(live, null, 'no live run after stop');
  } finally {
    await sup.stop();
    db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('12. supervisor: max_restarts caps respawns then auto-disables', async () => {
  const dirs = freshDirs('sup5');
  const db = makeDb();
  insertWorkspace(db, 'ws1', dirs.wsPath);
  const sup = new DaemonSupervisor(db, {
    resolveWorkspacePath: () => dirs.wsPath,
    tickIntervalMs: 60_000,
  });
  try {
    sup.start();
    const script = writeScript(dirs.root, 'fail.mjs', failScript());
    const d = upsertDaemon(db, {
      name: 'A', workspace_id: 'ws1', runtime: 'direct',
      command: [process.execPath, script],
      restart_policy: { backoff_ms: [20], stable_after_ms: 0, max_restarts: 2 },
    });
    sup.tick();
    // Allow restart_count to reach max.
    for (let i = 0; i < 40; i += 1) {
      await sleepP(50);
      const cur = getDaemon(db, d.id);
      if (!cur.enabled) break;
    }
    const final = getDaemon(db, d.id);
    assert.equal(final.enabled, 0, 'daemon should be auto-disabled after max_restarts');
    assert.match(final.last_error ?? '', /max_restarts/);
  } finally {
    await sup.stop();
    db.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
