/**
 * Regression: Dispatcher used to rely entirely on `pickUp()` being called by
 * the scheduler on cron wakes. Manually-enqueued fires (`trigger.fire` /
 * `enqueueFire`) emit a 'fires' bus event, but the scheduler's subscription
 * only recomputed its debounced setTimeout — it never asked the dispatcher
 * to claim the new queued row. Result: manual fires sat in `queued` for up
 * to the next cron interval (e.g. 5 minutes for `*\/5 * * * *`).
 *
 * Fix: Dispatcher subscribes to 'fires' itself in `start()` and calls
 * `pickUp()` via setImmediate whenever the bus fires. This test verifies the
 * subscription wires up correctly: with the dispatcher already started, a
 * post-start `enqueueFire()` must be claimed within a few hundred ms — well
 * under any reasonable cron interval — proving pickUp() ran from the bus
 * event, not from a periodic wake.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { enqueueFire } from '../src/db/fires-store.ts';
import { Dispatcher } from '../src/dispatcher.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = resolve(__dirname, 'fixtures', 'trigger-runner');
const TMP_ROOT = resolve(__dirname, '.tmp', 'dispatcher-fires-bus');

function freshTmp(name) {
  const p = join(
    TMP_ROOT,
    `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`,
  );
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
       binds_callback_to, binds_callback_to_recipe,
       once, max_attempts, backoff_ms_json,
       registered_at, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.workspace_id,
    opts.type,
    JSON.stringify(opts.params ?? {}),
    opts.cron_mode ?? 'disabled',
    opts.cron_expression ?? null,
    opts.enabled === false ? 0 : 1,
    opts.binds_callback_to ?? null,
    opts.binds_callback_to_recipe ?? null,
    opts.once ? 1 : 0,
    opts.max_attempts ?? 3,
    JSON.stringify(opts.backoff_ms ?? [10, 10, 10]),
    Date.now(),
    JSON.stringify(opts.state ?? {}),
  );
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('dispatcher: bus-fires subscription claims queued fires enqueued after start()', async () => {
  const db = open();
  const wsPath = freshTmp('bus-claim');
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

  const d = new Dispatcher(db, wsObj, { maxConcurrent: 2 });
  d.start();
  // Wait a tick to confirm boot-time pickUp() finds nothing to claim.
  await new Promise((r) => setTimeout(r, 50));

  // Now enqueue — this emits 'fires' bus, which (with the fix) must cause
  // the dispatcher to call pickUp() and claim the row.
  const fire = enqueueFire(db, {
    workspace_id: ws.id,
    trigger_id: 'demo.mode-a#t1',
    source: 'manual',
  });
  assert.equal(fire.status, 'queued', 'precondition: row inserted as queued');

  const claimed = await waitFor(
    () => {
      const row = db
        .prepare(`SELECT status FROM fires WHERE fire_id = ?`)
        .get(fire.fire_id);
      return row && row.status !== 'queued';
    },
    { timeoutMs: 1500, intervalMs: 20 },
  );

  await d.stop();
  const finalRow = db
    .prepare(`SELECT status FROM fires WHERE fire_id = ?`)
    .get(fire.fire_id);
  assert.equal(
    claimed,
    true,
    `dispatcher did not claim post-start enqueueFire via 'fires' bus subscription (status still '${finalRow?.status}')`,
  );
  // The fire should have advanced past 'queued' — terminal status depends on
  // how fast the underlying tsx script completes; running/success/retrying are
  // all valid evidence that pickUp() fired from the bus.
  assert.notEqual(finalRow.status, 'queued');
  db.close();
});

test('dispatcher: bus subscription is removed on stop() (no late pickUp after stop)', async () => {
  const db = open();
  const wsPath = freshTmp('bus-unsub');
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
  insertTrigger(db, { id: 'demo.mode-a#t2', workspace_id: ws.id, type: 'demo.mode-a' });

  const d = new Dispatcher(db, wsObj, { maxConcurrent: 2 });
  d.start();
  await d.stop();

  // After stop(), enqueue a fire — the subscription should have been removed,
  // so the row must remain 'queued'.
  const fire = enqueueFire(db, {
    workspace_id: ws.id,
    trigger_id: 'demo.mode-a#t2',
    source: 'manual',
  });
  await new Promise((r) => setTimeout(r, 200));
  const row = db.prepare(`SELECT status FROM fires WHERE fire_id = ?`).get(fire.fire_id);
  assert.equal(
    row.status,
    'queued',
    `stopped dispatcher should not claim fires (status='${row.status}')`,
  );
  db.close();
});
