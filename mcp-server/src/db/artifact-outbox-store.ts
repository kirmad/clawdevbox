/**
 * artifact-outbox-store.ts
 *
 * DB access for the durable artifact outbox (migration v12).
 *
 * A viewer-initiated message from an artifact (a PR-walkthrough Q&A question
 * or an inline review comment) is ENQUEUED here by the HTTP handler and
 * DELIVERED asynchronously by `artifact-outbox-worker.ts`. The browser POST
 * returns the instant the row is written (202), so the UI is never blocked on
 * the slow, failure-prone dispatch (which may need to resume/spawn a closed
 * session and wait for the agent to be idle).
 *
 * Delivery lifecycle:  pending → sending → sent | failed
 *
 *   enqueue()            insert a pending row
 *   claimNext()          atomically claim ONE deliverable row (pending → sending)
 *   markSent()           delivery succeeded (sending → sent)
 *   markRetry()          delivery failed but retryable (sending → pending + backoff)
 *   markFailed()         out of attempts (sending → failed)
 *   resetStuckSending()  crash recovery: sending → pending (called on boot)
 *
 * The claim is a single UPDATE guarded by `status='pending'`, which is atomic
 * under better-sqlite3's serialized writes — two workers (or a worker + a
 * runOnce) can never claim the same row.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface OutboxRow {
  id: string;
  artifact_id: string;
  session_id: string | null;
  workspace_id: string | null;
  workspace_path: string | null;
  kind: string;
  prompt: string;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  delivered_instance_id: string | null;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export function mintOutboxId(): string {
  return `ob_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function enqueueOutbox(
  db: Database,
  opts: {
    artifact_id: string;
    session_id?: string | null;
    workspace_id?: string | null;
    workspace_path?: string | null;
    kind?: string;
    prompt: string;
    max_attempts?: number;
  },
): OutboxRow {
  const id = mintOutboxId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO artifact_outbox (
       id, artifact_id, session_id, workspace_id, workspace_path, kind, prompt,
       status, attempts, max_attempts, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)`,
  ).run(
    id,
    opts.artifact_id,
    opts.session_id ?? null,
    opts.workspace_id ?? null,
    opts.workspace_path ?? null,
    opts.kind ?? 'ask',
    opts.prompt,
    opts.max_attempts ?? 10,
    now,
    now,
  );
  return getOutbox(db, id)!;
}

export function getOutbox(db: Database, id: string): OutboxRow | null {
  const row = db
    .prepare('SELECT * FROM artifact_outbox WHERE id = ?')
    .get(id) as OutboxRow | undefined;
  return row ?? null;
}

/**
 * Atomically claim the oldest deliverable row (status='pending' and
 * next_attempt_at <= now), flipping it to 'sending'. Returns null when
 * nothing is ready. The UPDATE ... WHERE status='pending' guard makes the
 * claim safe against concurrent claimers.
 */
export function claimNextOutbox(db: Database, now = Date.now()): OutboxRow | null {
  const candidate = db
    .prepare(
      `SELECT id FROM artifact_outbox
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(now) as { id: string } | undefined;
  if (!candidate) return null;

  const res = db
    .prepare(
      `UPDATE artifact_outbox
          SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(now, candidate.id);
  // Lost the race to another claimer — try the next tick.
  if (res.changes === 0) return null;
  return getOutbox(db, candidate.id);
}

export function markSent(
  db: Database,
  id: string,
  deliveredInstanceId: string | null,
): void {
  const now = Date.now();
  // The `status='sending'` guard makes this idempotent: if the row was
  // reclaimed or already terminal, we no-op rather than clobber it.
  db.prepare(
    `UPDATE artifact_outbox
        SET status = 'sent', delivered_instance_id = ?, last_error = NULL,
            sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`,
  ).run(deliveredInstanceId, now, now, id);
}

/**
 * Delivery failed but the row still has attempts left → back to 'pending'
 * with a future `next_attempt_at` (caller computes the backoff).
 */
export function markRetry(
  db: Database,
  id: string,
  error: string,
  nextAttemptAt: number,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE artifact_outbox
        SET status = 'pending', last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`,
  ).run(error.slice(0, 500), nextAttemptAt, now, id);
}

export function markFailed(db: Database, id: string, error: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE artifact_outbox
        SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'sending'`,
  ).run(error.slice(0, 500), now, id);
}

/**
 * Recover rows stuck in 'sending'. Called on boot (olderThanMs=0 → all of
 * them, since a crash left them mid-flight) and periodically by the worker
 * with a generous threshold (a live delivery that has been 'sending' for
 * minutes is wedged — reclaim it for another attempt).
 *
 * Rows that crashed on their FINAL attempt (attempts >= max_attempts) are
 * marked 'failed' rather than re-queued, so recovery can't exceed the
 * caller's max-attempts contract. Returns the total number of rows touched.
 */
export function resetStuckSending(db: Database, olderThanMs = 0): number {
  const now = Date.now();
  const cutoff = now - Math.max(0, olderThanMs);
  const failed = db
    .prepare(
      `UPDATE artifact_outbox
          SET status = 'failed',
              last_error = COALESCE(last_error, 'recovered after max_attempts'),
              updated_at = ?
        WHERE status = 'sending' AND updated_at <= ? AND attempts >= max_attempts`,
    )
    .run(now, cutoff).changes;
  const requeued = db
    .prepare(
      `UPDATE artifact_outbox
          SET status = 'pending', updated_at = ?
        WHERE status = 'sending' AND updated_at <= ? AND attempts < max_attempts`,
    )
    .run(now, cutoff).changes;
  return failed + requeued;
}

export function listOutboxForArtifact(
  db: Database,
  artifactId: string,
  limit = 50,
): OutboxRow[] {
  return db
    .prepare(
      `SELECT * FROM artifact_outbox
        WHERE artifact_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(artifactId, Math.min(Math.max(limit, 1), 200)) as OutboxRow[];
}

/** Count of rows still awaiting delivery (pending or in-flight). */
export function pendingOutboxCount(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM artifact_outbox WHERE status IN ('pending','sending')`,
    )
    .get() as { n: number };
  return row.n;
}
