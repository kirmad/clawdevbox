import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { Dispatcher } from '../src/dispatcher.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, 'fixtures', 'trigger-runner');
const TMP_ROOT = resolve(__dirname, '.tmp', 'dispatcher');

function freshTmp(name) {
  const p = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeWs(triggerTypes = []) {
  const ws = {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
  };
  for (const t of triggerTypes) ws.triggerTypes.set(t.id, t);
  return ws;
}

function insertTrigger(db, opts) {
  db.prepare(
    `INSERT INTO triggers (
       id, workspace_id, type, params_json,
       cron_mode, cron_expression, enabled,
       once, max_attempts, backoff_ms_json,
       registered_at, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.workspace_id,
    opts.type,
    JSON.stringify(opts.params ?? {}),
    opts.cron_mode ?? 'disabled',
    opts.cron_expression ?? null,
    opts.enabled === false ? 0 : 1,
    opts.once ? 1 : 0,
    opts.max_attempts ?? 3,
    JSON.stringify(opts.backoff_ms ?? [10, 10, 10]),
    Date.now(),
    JSON.stringify(opts.state ?? {}),
  );
}

function enqueueFireDirect(db, opts) {
  const fire_id = `fire_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
  db.prepare(
    `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at, payload_json)
     VALUES (?, ?, ?, 'cron', 'queued', 1, ?, ?, ?)`,
  ).run(
    fire_id,
    opts.workspace_id,
    opts.trigger_id,
    opts.max_attempts ?? 3,
    opts.scheduled_at ?? Date.now(),
    opts.payload ? JSON.stringify(opts.payload) : null,
  );
  return fire_id;
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ============================================================== script binding

test('dispatcher: script binding success path writes stdout.txt + marks success', async () => {
  const db = open();
  const wsPath = freshTmp('success');
  const ws = ensureWorkspace(db, { path: wsPath });
  const wsObj = makeWs([
    {
      id: 'demo.mode-a',
      file: 'heartbeat-mode-a.ts',
      file_abs: join(FIXTURES, 'heartbeat-mode-a.ts'),
      runtime: 'tsx',
      source_plugin_id: 'demo',
      scope: 'plugin:demo',
    },
  ]);
  insertTrigger(db, { id: 'demo.mode-a#t1', workspace_id: ws.id, type: 'demo.mode-a' });
  const fid = enqueueFireDirect(db, { workspace_id: ws.id, trigger_id: 'demo.mode-a#t1' });

  const d = new Dispatcher(db, wsObj, { maxConcurrent: 2 });
  d.start();

  const ok = await waitFor(() => {
    const row = db.prepare(`SELECT status FROM fires WHERE fire_id = ?`).get(fid);
    return row && row.status === 'success';
  });
  await d.stop();
  assert.equal(ok, true, 'fire should reach success');
  const stdoutPath = join(wsPath, '.clawdevbox', 'fires', fid, 'attempt-1', 'stdout.txt');
  assert.equal(existsSync(stdoutPath), true, 'attempt-1/stdout.txt should exist');
  // State should be persisted back.
  const t = db.prepare(`SELECT state_json FROM triggers WHERE id='demo.mode-a#t1'`).get();
  const state = JSON.parse(t.state_json);
  assert.equal(state.tickedA, true);
  db.close();
});

test('dispatcher: script binding failure → retry with attempt=2 and next_retry_at set', async () => {
  const db = open();
  const wsPath = freshTmp('retry');
  const ws = ensureWorkspace(db, { path: wsPath });
  // Write a fixture that exits non-zero.
  const failScript = join(wsPath, 'fail.cjs');
  writeFileSync(failScript, `process.stderr.write('boom\\n'); process.exit(1);\n`);
  const wsObj = makeWs([
    {
      id: 'demo.fail',
      file: 'fail.cjs',
      file_abs: failScript,
      runtime: 'node',
      source_plugin_id: 'demo',
      scope: 'plugin:demo',
    },
  ]);
  insertTrigger(db, { id: 'demo.fail#t', workspace_id: ws.id, type: 'demo.fail', max_attempts: 3, backoff_ms: [50, 50, 50] });
  const fid = enqueueFireDirect(db, { workspace_id: ws.id, trigger_id: 'demo.fail#t' });

  const d = new Dispatcher(db, wsObj, { maxConcurrent: 1 });
  d.start();
  const ok = await waitFor(() => {
    const row = db.prepare(`SELECT status, attempt, next_retry_at FROM fires WHERE fire_id = ?`).get(fid);
    return row && row.status === 'retrying';
  });
  await d.stop();
  assert.equal(ok, true);
  const row = db.prepare(`SELECT status, attempt, next_retry_at, error FROM fires WHERE fire_id = ?`).get(fid);
  assert.equal(row.status, 'retrying');
  assert.equal(row.attempt, 2);
  assert.ok(row.next_retry_at != null && row.next_retry_at > Date.now() - 1000);
  assert.ok((row.error || '').includes('script exited'));
  db.close();
});

test('dispatcher: script binding failure → dead-letter after max_attempts; inbox row appears', async () => {
  const db = open();
  const wsPath = freshTmp('dead');
  const ws = ensureWorkspace(db, { path: wsPath });
  const failScript = join(wsPath, 'fail2.cjs');
  writeFileSync(failScript, `process.exit(7);\n`);
  const wsObj = makeWs([
    {
      id: 'demo.fail2',
      file: 'fail2.cjs',
      file_abs: failScript,
      runtime: 'node',
      source_plugin_id: 'demo',
      scope: 'plugin:demo',
    },
  ]);
  // Set max_attempts=1 so the first failure is terminal.
  insertTrigger(db, {
    id: 'demo.fail2#t',
    workspace_id: ws.id,
    type: 'demo.fail2',
    max_attempts: 1,
    backoff_ms: [10],
  });
  const fid = enqueueFireDirect(db, {
    workspace_id: ws.id,
    trigger_id: 'demo.fail2#t',
    max_attempts: 1,
  });

  const d = new Dispatcher(db, wsObj, { maxConcurrent: 1 });
  d.start();
  const ok = await waitFor(() => {
    const row = db.prepare(`SELECT status FROM fires WHERE fire_id = ?`).get(fid);
    return row && row.status === 'dead';
  });
  await d.stop();
  assert.equal(ok, true, 'fire should reach dead');
  const inb = db
    .prepare(`SELECT id, title, source, trigger_id, fire_id FROM inbox_items WHERE source = 'trigger-dead'`)
    .all();
  assert.equal(inb.length, 1);
  assert.equal(inb[0].fire_id, fid);
  assert.equal(inb[0].trigger_id, 'demo.fail2#t');
  assert.ok(inb[0].title.includes('demo.fail2#t'));
  // Trigger last_run_status='error'
  const t = db.prepare(`SELECT last_run_status FROM triggers WHERE id='demo.fail2#t'`).get();
  assert.equal(t.last_run_status, 'error');
  db.close();
});

test('dispatcher: overlap-skip — second queued fire for same trigger gets skipped', async () => {
  const db = open();
  const wsPath = freshTmp('overlap');
  const ws = ensureWorkspace(db, { path: wsPath });
  // A fast-exit script — but we'll mark one fire 'running' manually first to force overlap.
  const wsObj = makeWs([
    {
      id: 'demo.mode-a',
      file: 'heartbeat-mode-a.ts',
      file_abs: join(FIXTURES, 'heartbeat-mode-a.ts'),
      runtime: 'tsx',
      source_plugin_id: 'demo',
      scope: 'plugin:demo',
    },
  ]);
  insertTrigger(db, { id: 'demo.mode-a#ovl', workspace_id: ws.id, type: 'demo.mode-a' });
  // Pretend fire-A is already running.
  db.prepare(
    `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at, started_at)
     VALUES ('fire_running', ?, 'demo.mode-a#ovl', 'cron', 'running', 1, 3, ?, ?)`,
  ).run(ws.id, Date.now() - 5000, Date.now() - 5000);
  // Queue fire-B.
  const fid2 = enqueueFireDirect(db, { workspace_id: ws.id, trigger_id: 'demo.mode-a#ovl' });

  const d = new Dispatcher(db, wsObj, { maxConcurrent: 2 });
  d.pickUp();
  // claimNextFire is synchronous; the skip should already be persisted.
  const row = db.prepare(`SELECT status, error FROM fires WHERE fire_id = ?`).get(fid2);
  assert.equal(row.status, 'skipped');
  assert.equal(row.error, 'overlap_skip');
  await d.stop();
  db.close();
});

test('dispatcher: once-trigger success disables trigger row', async () => {
  const db = open();
  const wsPath = freshTmp('once');
  const ws = ensureWorkspace(db, { path: wsPath });
  const wsObj = makeWs([
    {
      id: 'demo.mode-a',
      file: 'heartbeat-mode-a.ts',
      file_abs: join(FIXTURES, 'heartbeat-mode-a.ts'),
      runtime: 'tsx',
      source_plugin_id: 'demo',
      scope: 'plugin:demo',
    },
  ]);
  insertTrigger(db, { id: 'demo.mode-a#once', workspace_id: ws.id, type: 'demo.mode-a', once: true });
  const fid = enqueueFireDirect(db, { workspace_id: ws.id, trigger_id: 'demo.mode-a#once' });
  const d = new Dispatcher(db, wsObj, { maxConcurrent: 1 });
  d.start();
  const ok = await waitFor(() => {
    const r = db.prepare(`SELECT status FROM fires WHERE fire_id = ?`).get(fid);
    return r && r.status === 'success';
  });
  await d.stop();
  assert.equal(ok, true);
  const t = db.prepare(`SELECT enabled FROM triggers WHERE id='demo.mode-a#once'`).get();
  assert.equal(t.enabled, 0);
  db.close();
});

// =============================================================== drain shutdown

test('dispatcher: stop() drains in-flight, then marks survivors service_shutdown', async () => {
  const db = open();
  const wsPath = freshTmp('drain');
  const ws = ensureWorkspace(db, { path: wsPath });
  const wsObj = makeWs([
    {
      id: 'demo.sleep',
      file: 'sleep-forever.ts',
      file_abs: join(FIXTURES, 'sleep-forever.ts'),
      runtime: 'tsx',
      source_plugin_id: 'demo',
      scope: 'plugin:demo',
    },
  ]);
  insertTrigger(db, { id: 'demo.sleep#t', workspace_id: ws.id, type: 'demo.sleep', max_attempts: 1, backoff_ms: [10] });
  const fid = enqueueFireDirect(db, { workspace_id: ws.id, trigger_id: 'demo.sleep#t', max_attempts: 1 });

  // Very short drain window — the sleep-forever script can't finish in time.
  const d = new Dispatcher(db, wsObj, { maxConcurrent: 1, drainMs: 300, scriptTimeoutMs: 60_000 });
  d.start();
  // Give the dispatcher a moment to claim + spawn.
  await waitFor(() => {
    const r = db.prepare(`SELECT status FROM fires WHERE fire_id = ?`).get(fid);
    return r && r.status === 'running';
  });
  const stopStart = Date.now();
  await d.stop();
  const stopDuration = Date.now() - stopStart;
  assert.ok(stopDuration < 5000, `stop() should return within 5s; took ${stopDuration}ms`);
  const final = db.prepare(`SELECT status, error FROM fires WHERE fire_id = ?`).get(fid);
  assert.equal(final.status, 'failed');
  assert.equal(final.error, 'service_shutdown');
  db.close();
});

// Cleanup tmp dir
test('cleanup', () => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
