/**
 * artifact-outbox.test.mjs — durability + recovery coverage for the artifact
 * outbox store and its delivery worker.
 *
 * The outbox is what lets `POST /artifact/<id>/ask` return instantly while a
 * message is delivered asynchronously (resuming a closed session if needed,
 * retrying on failure). These tests pin the guarantees that make it safe:
 *   - atomic claim (no double-delivery)
 *   - retry-with-backoff on transient failure
 *   - permanent failure after max_attempts
 *   - crash recovery (stuck 'sending' rows re-queued on start)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrations } from '../src/db/migrations.ts';
import {
  enqueueOutbox,
  claimNextOutbox,
  markSent,
  markRetry,
  markFailed,
  resetStuckSending,
  getOutbox,
  listOutboxForArtifact,
  pendingOutboxCount,
} from '../src/db/artifact-outbox-store.ts';
import { startArtifactOutboxWorker } from '../src/artifact-outbox-worker.ts';

function setupDb() {
  const db = new Database(':memory:');
  for (const m of migrations) {
    m.up(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
  }
  return db;
}

function fakeCtx(db) {
  // The worker only touches ctx.db in these tests (deliver is stubbed).
  return { db, dispatcher: {}, ws: {}, cfg: {} };
}

// ---------------------------------------------------------------------------
// Store: enqueue + claim
// ---------------------------------------------------------------------------

test('enqueue writes a pending row that is immediately claimable', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art-1', session_id: 's1', prompt: 'hi' });
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 0);
  assert.equal(pendingOutboxCount(db), 1);

  const claimed = claimNextOutbox(db, Date.now());
  assert.ok(claimed);
  assert.equal(claimed.id, row.id);
  assert.equal(claimed.status, 'sending');
  assert.equal(claimed.attempts, 1, 'claim increments attempts');
});

test('claim is atomic — a second claim returns null (no double-delivery)', () => {
  const db = setupDb();
  enqueueOutbox(db, { artifact_id: 'art-1', session_id: 's1', prompt: 'only once' });
  const first = claimNextOutbox(db);
  const second = claimNextOutbox(db);
  assert.ok(first, 'first claim succeeds');
  assert.equal(second, null, 'nothing else is pending');
});

test('claim respects next_attempt_at (backoff not yet due)', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art-1', session_id: 's1', prompt: 'later' });
  claimNextOutbox(db);                       // → sending, attempts=1
  markRetry(db, row.id, 'boom', Date.now() + 60_000); // due in 60s
  assert.equal(claimNextOutbox(db, Date.now()), null, 'not claimable before next_attempt_at');
  const due = claimNextOutbox(db, Date.now() + 61_000);
  assert.ok(due, 'claimable once backoff elapses');
  assert.equal(due.attempts, 2);
});

test('claim is FIFO by created_at', () => {
  const db = setupDb();
  const a = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'first' });
  // Force a later created_at on the second row.
  const b = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'second' });
  db.prepare('UPDATE artifact_outbox SET created_at = ? WHERE id = ?').run(a.created_at, a.id);
  db.prepare('UPDATE artifact_outbox SET created_at = ? WHERE id = ?').run(a.created_at + 5, b.id);
  assert.equal(claimNextOutbox(db).id, a.id);
  assert.equal(claimNextOutbox(db).id, b.id);
});

// ---------------------------------------------------------------------------
// Store: terminal transitions + recovery
// ---------------------------------------------------------------------------

test('markSent moves to sent with delivered instance', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'x' });
  claimNextOutbox(db);
  markSent(db, row.id, 'ri_live_1');
  const after = getOutbox(db, row.id);
  assert.equal(after.status, 'sent');
  assert.equal(after.delivered_instance_id, 'ri_live_1');
  assert.ok(after.sent_at);
  assert.equal(pendingOutboxCount(db), 0);
});

test('markFailed moves to failed (terminal)', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'x' });
  claimNextOutbox(db);
  markFailed(db, row.id, 'permanent');
  const after = getOutbox(db, row.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.last_error, 'permanent');
  assert.equal(claimNextOutbox(db), null, 'failed rows are never re-claimed');
});

test('resetStuckSending re-queues rows left mid-flight by a crash', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'x' });
  claimNextOutbox(db); // → sending (simulate crash here, never marked sent)
  assert.equal(getOutbox(db, row.id).status, 'sending');
  const reset = resetStuckSending(db);
  assert.equal(reset, 1);
  assert.equal(getOutbox(db, row.id).status, 'pending');
  assert.ok(claimNextOutbox(db), 're-queued row is claimable again');
});

test('resetStuckSending marks a row that crashed on its FINAL attempt as failed (not re-queued past max)', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'x', max_attempts: 1 });
  claimNextOutbox(db); // attempts → 1 == max_attempts, status='sending' (crash here)
  const n = resetStuckSending(db);
  assert.equal(n, 1);
  assert.equal(getOutbox(db, row.id).status, 'failed', 'exhausted row recovered as failed, not pending');
  assert.equal(claimNextOutbox(db), null);
});

test('resetStuckSending(olderThanMs) only reclaims rows stuck longer than the threshold', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'x' });
  claimNextOutbox(db); // status='sending', updated_at ~ now
  // A fresh in-flight delivery must NOT be reclaimed.
  assert.equal(resetStuckSending(db, 5 * 60_000), 0);
  assert.equal(getOutbox(db, row.id).status, 'sending');
  // Backdate updated_at to simulate a wedged delivery, then it IS reclaimed.
  db.prepare('UPDATE artifact_outbox SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 6 * 60_000, row.id);
  assert.equal(resetStuckSending(db, 5 * 60_000), 1);
  assert.equal(getOutbox(db, row.id).status, 'pending');
});

test('markSent/markRetry/markFailed are guarded — no-op unless the row is sending', () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's', prompt: 'x' });
  // Row is 'pending' (not claimed) — terminal transitions must not clobber it.
  markSent(db, row.id, 'ri_x');
  assert.equal(getOutbox(db, row.id).status, 'pending', 'markSent ignored a non-sending row');
  markFailed(db, row.id, 'nope');
  assert.equal(getOutbox(db, row.id).status, 'pending', 'markFailed ignored a non-sending row');
  // Claim → sending, mark sent, then a late markRetry must NOT resurrect it.
  claimNextOutbox(db);
  markSent(db, row.id, 'ri_1');
  assert.equal(getOutbox(db, row.id).status, 'sent');
  markRetry(db, row.id, 'late', Date.now());
  assert.equal(getOutbox(db, row.id).status, 'sent', 'markRetry cannot un-send a delivered row');
});

test('listOutboxForArtifact returns newest first and scopes by artifact', () => {
  const db = setupDb();
  enqueueOutbox(db, { artifact_id: 'art-A', session_id: 's', prompt: '1' });
  enqueueOutbox(db, { artifact_id: 'art-B', session_id: 's', prompt: '2' });
  const a = listOutboxForArtifact(db, 'art-A');
  assert.equal(a.length, 1);
  assert.equal(a[0].artifact_id, 'art-A');
});

// ---------------------------------------------------------------------------
// Worker: delivery, retry, permanent failure, batching
// ---------------------------------------------------------------------------

test('worker delivers a queued message (pending → sent)', async () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's1', prompt: 'deliver me' });
  const seen = [];
  const worker = startArtifactOutboxWorker(fakeCtx(db), {
    deliver: async (_ctx, r) => { seen.push(r.prompt); return { ok: true, instance_id: 'ri_1' }; },
  });
  const n = await worker.runOnce();
  worker.stop();
  assert.equal(n, 1);
  assert.deepEqual(seen, ['deliver me']);
  assert.equal(getOutbox(db, row.id).status, 'sent');
});

test('worker retries a transient failure with backoff, then succeeds', async () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's1', prompt: 'flaky' });
  let calls = 0;
  const worker = startArtifactOutboxWorker(fakeCtx(db), {
    backoffBaseMs: 50, // defer the retry to a later tick (not same-tick)
    deliver: async () => {
      calls++;
      if (calls === 1) return { ok: false, message: 'target_unavailable' };
      return { ok: true, instance_id: 'ri_1' };
    },
  });
  await worker.runOnce();
  assert.equal(getOutbox(db, row.id).status, 'pending', 'back to pending after transient failure');
  assert.equal(getOutbox(db, row.id).attempts, 1);
  await new Promise((r) => setTimeout(r, 90)); // let the backoff window elapse
  await worker.runOnce();
  worker.stop();
  assert.equal(getOutbox(db, row.id).status, 'sent');
  assert.equal(calls, 2);
});

test('worker gives up after max_attempts (→ failed)', async () => {
  const db = setupDb();
  const row = enqueueOutbox(db, { artifact_id: 'art', session_id: 's1', prompt: 'doomed', max_attempts: 3 });
  const worker = startArtifactOutboxWorker(fakeCtx(db), {
    backoffBaseMs: 0,
    deliver: async () => ({ ok: false, message: 'still down' }),
  });
  await worker.runOnce();
  await worker.runOnce();
  await worker.runOnce();
  worker.stop();
  const after = getOutbox(db, row.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.attempts, 3);
  assert.equal(after.last_error, 'still down');
});

test('worker delivers multiple queued messages in one tick (batch)', async () => {
  const db = setupDb();
  for (let i = 0; i < 3; i++) {
    enqueueOutbox(db, { artifact_id: 'art', session_id: 's1', prompt: `m${i}` });
  }
  const worker = startArtifactOutboxWorker(fakeCtx(db), {
    deliver: async () => ({ ok: true, instance_id: 'ri_1' }),
  });
  const n = await worker.runOnce();
  worker.stop();
  assert.equal(n, 3);
  assert.equal(pendingOutboxCount(db), 0);
});

test('worker isolates a throwing delivery (queue not wedged)', async () => {
  const db = setupDb();
  const bad = enqueueOutbox(db, { artifact_id: 'art', session_id: 's1', prompt: 'throws', max_attempts: 1 });
  const good = enqueueOutbox(db, { artifact_id: 'art', session_id: 's1', prompt: 'ok' });
  const worker = startArtifactOutboxWorker(fakeCtx(db), {
    backoffBaseMs: 0,
    deliver: async (_ctx, r) => {
      if (r.prompt === 'throws') throw new Error('kaboom');
      return { ok: true, instance_id: 'ri_1' };
    },
  });
  await worker.runOnce();
  worker.stop();
  assert.equal(getOutbox(db, bad.id).status, 'failed', 'thrown error counts as a failed attempt');
  assert.equal(getOutbox(db, good.id).status, 'sent', 'sibling still delivered');
});
