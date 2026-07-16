/**
 * Fires store — durable execution ledger for the trigger kernel.
 *
 * A `fires` row records every scheduled-or-triggered execution of a trigger
 * (spec §4.2, §6). The dispatcher claims fires atomically via
 * `claimNextFire()`, which implements the §6.3 overlap-skip protocol: if
 * the oldest queued fire's trigger already has another fire running, the
 * row is marked `skipped` and the dispatcher tries the next queued row.
 */

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { emitChange } from '../event-bus.ts';

export type FireSource = 'cron' | 'manual' | 'webhook' | 'event';
export type FireStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'retrying'
  | 'dead'
  | 'skipped';

export interface FireRow {
  fire_id: string;
  workspace_id: string;
  trigger_id: string | null;
  source: FireSource;
  status: FireStatus;
  attempt: number;
  max_attempts: number;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  next_retry_at: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  output_dir: string | null;
  error: string | null;
  recipe_instance_id: string | null;
  agent_session_id: string | null;
  payload_json: string | null;
}

export function mintFireId(): string {
  return `fire_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function attemptDir(workspacePath: string, fire_id: string, attempt: number): string {
  return join(workspacePath, '.clawdevbox', 'fires', fire_id, `attempt-${attempt}`);
}

export function enqueueFire(
  db: Database,
  opts: {
    workspace_id: string;
    trigger_id?: string | null;
    source: FireSource;
    scheduled_at?: number;
    max_attempts?: number;
    payload?: unknown;
  },
): FireRow {
  const fire_id = mintFireId();
  const scheduled_at = opts.scheduled_at ?? Date.now();
  const max_attempts = opts.max_attempts ?? 3;
  const payload_json = opts.payload === undefined ? null : JSON.stringify(opts.payload);
  db.prepare(
    `INSERT INTO fires (
       fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts,
       scheduled_at, payload_json
     ) VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?)`,
  ).run(
    fire_id,
    opts.workspace_id,
    opts.trigger_id ?? null,
    opts.source,
    max_attempts,
    scheduled_at,
    payload_json,
  );
  emitChange('fires');
  return getFire(db, fire_id)!;
}

export function getFire(db: Database, fire_id: string): FireRow | null {
  const row = db.prepare('SELECT * FROM fires WHERE fire_id = ?').get(fire_id) as
    | FireRow
    | undefined;
  return row ?? null;
}

/**
 * Atomically claims the next queued fire (oldest by `scheduled_at`).
 *
 * Implements §6.3 overlap-skip: if the candidate's trigger has another
 * fire already `running`, the candidate is marked `skipped` and the
 * function recurses to look at the next queued row. Returns `null` when
 * no claimable row remains.
 */
export function claimNextFire(db: Database): FireRow | null {
  const tx = db.transaction((): FireRow | null => {
    // Recurse in a loop to avoid pathological recursion depth on a long
    // queue of skipped rows.
    while (true) {
      const candidate = db
        .prepare(
          `SELECT * FROM fires WHERE status='queued' ORDER BY scheduled_at, fire_id LIMIT 1`,
        )
        .get() as FireRow | undefined;
      if (!candidate) return null;

      if (candidate.trigger_id) {
        const overlap = db
          .prepare(
            `SELECT 1 FROM fires WHERE trigger_id = ? AND status='running' LIMIT 1`,
          )
          .get(candidate.trigger_id);
        if (overlap) {
          const now = Date.now();
          db.prepare(
            `UPDATE fires SET status='skipped', finished_at=?, error='overlap_skip'
             WHERE fire_id=? AND status='queued'`,
          ).run(now, candidate.fire_id);
          continue;
        }
      }
      const now = Date.now();
      db.prepare(
        `UPDATE fires SET status='running', started_at=? WHERE fire_id=? AND status='queued'`,
      ).run(now, candidate.fire_id);
      return getFire(db, candidate.fire_id);
    }
  });
  const result = tx();
  emitChange('fires');
  return result;
}

export function markFireSuccess(
  db: Database,
  fire_id: string,
  opts: {
    duration_ms: number;
    exit_code?: number | null;
    recipe_instance_id?: string;
    agent_session_id?: string;
  },
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE fires SET
       status='success',
       finished_at=?,
       duration_ms=?,
       exit_code=COALESCE(?, exit_code),
       recipe_instance_id=COALESCE(?, recipe_instance_id),
       agent_session_id=COALESCE(?, agent_session_id)
     WHERE fire_id=?`,
  ).run(
    now,
    opts.duration_ms,
    opts.exit_code ?? null,
    opts.recipe_instance_id ?? null,
    opts.agent_session_id ?? null,
    fire_id,
  );
  emitChange('fires');
}

export function markFireFailedWithRetry(
  db: Database,
  fire_id: string,
  opts: { error: string; next_retry_at: number },
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE fires SET
       status='retrying',
       attempt=attempt+1,
       next_retry_at=?,
       finished_at=?,
       error=?
     WHERE fire_id=?`,
  ).run(opts.next_retry_at, now, opts.error, fire_id);
  emitChange('fires');
}

export function markFireDead(
  db: Database,
  fire_id: string,
  opts: { error: string },
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE fires SET status='dead', finished_at=?, error=? WHERE fire_id=?`,
  ).run(now, opts.error, fire_id);
  emitChange('fires');
}

export function markFireFailedShutdown(db: Database, fire_id: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE fires SET status='failed', finished_at=?, error='service_shutdown'
     WHERE fire_id=?`,
  ).run(now, fire_id);
  emitChange('fires');
}

export function markFireForRetry(db: Database, fire_id: string): void {
  db.prepare(
    `UPDATE fires SET
       status='queued',
       attempt=1,
       started_at=NULL,
       finished_at=NULL,
       next_retry_at=NULL,
       error=NULL
     WHERE fire_id=?`,
  ).run(fire_id);
  emitChange('fires');
}

/**
 * Canonical reason recorded on fires reclaimed from a crashed/killed
 * process. Distinct from `service_shutdown` (graceful drain in
 * `Dispatcher.stop()`) so operators can tell a clean shutdown apart from
 * a hard crash that left the row orphaned.
 */
export const ORPHAN_RECLAIM_REASON = 'service_restart_orphan';

/**
 * Record a dead-letter for a fire that reached a terminal `dead` state.
 *
 * Shared by both dead-letter paths so a permanently-dead fire is equally
 * visible to operators no matter how it died:
 *   - `Dispatcher.recordFailure` — the trigger's own script exhausted its
 *     retry budget (real trigger-logic failure).
 *   - `reclaimOrphanFires` — a `running` fire was orphaned by a crash and
 *     its retry budget was already exhausted (`service_restart_orphan`).
 *
 * Behaviour (mirrors the former private `Dispatcher.addDeadLetterInbox`):
 *   - Upserts a single inbox row with a deterministic id
 *     (`inb_dead_<fire_id>`) so re-running reclaim never duplicates it.
 *   - Links `trigger_id` only when that trigger row still exists, so a
 *     trigger-less or already-deleted-trigger fire cannot break the
 *     `inbox_items.trigger_id → triggers(id)` foreign key.
 *   - When the trigger exists, stamps its `last_run_status='error'` /
 *     `last_run_error` so the failure surfaces on the trigger too.
 *   - Emits a single `inbox` change so the UI refreshes.
 *
 * Does NOT itself transition the fire to `dead`; callers own that via
 * `markFireDead` (keeps the fire ledger write and the operator-visibility
 * write independently testable).
 */
export function deadLetterFire(
  db: Database,
  fire: Pick<FireRow, 'fire_id' | 'workspace_id' | 'trigger_id'>,
  opts: { error: string; title: string; preview: string },
): void {
  const now = Date.now();
  const id = `inb_dead_${fire.fire_id}`;
  // Only link the trigger when it still exists — a deleted/absent trigger
  // would otherwise violate the inbox_items.trigger_id FK.
  let triggerId: string | null = null;
  if (fire.trigger_id) {
    const trg = db
      .prepare(`SELECT id FROM triggers WHERE id=?`)
      .get(fire.trigger_id) as { id: string } | undefined;
    if (trg) triggerId = fire.trigger_id;
  }
  db.prepare(
    `INSERT INTO inbox_items (id, workspace_id, title, preview, source, status, trigger_id, fire_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'trigger-dead', 'unread', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       preview = excluded.preview,
       updated_at = excluded.updated_at`,
  ).run(id, fire.workspace_id, opts.title, opts.preview, triggerId, fire.fire_id, now, now);
  if (triggerId) {
    db.prepare(
      `UPDATE triggers SET last_run_at=?, last_run_status='error', last_run_error=? WHERE id=?`,
    ).run(now, opts.error, triggerId);
  }
  emitChange('inbox');
}

export interface ReclaimOrphanResult {
  /** fire_ids that still had retry budget → moved to `retrying`. */
  reclaimed: string[];
  /** fire_ids whose attempts were exhausted → moved to `dead`. */
  dead: string[];
}

/**
 * Reclaim fires left in `status='running'` by a previous process.
 *
 * A crash (SIGKILL / power loss / `taskkill /F`) skips
 * `Dispatcher.stop()`, so the fire row is never transitioned out of
 * `running`. The §6.3 overlap-skip in `claimNextFire` then treats that
 * zombie row as an in-flight run and skips every subsequent queued fire
 * for the same trigger — indefinitely. This reclaims those rows so the
 * queue unblocks.
 *
 * Orphan criterion (not an arbitrary age — that would kill legitimately
 * long-running triggers): a row is an orphan iff its `fire_id` is NOT in
 * `activeFireIds`, i.e. the current process is not actually running it.
 * At startup the caller passes no active ids (the dispatcher owns nothing
 * yet), so every `running` row belongs to the dead process. For periodic
 * reclaim the caller passes the dispatcher's in-flight set, so genuinely
 * active in-process fires are preserved.
 *
 * Reclaimed rows follow the normal retry policy for consistency: rows
 * with attempts left become `retrying` (promoted to `queued` by the
 * scheduler on its next tick via `next_retry_at`), exhausted rows become
 * `dead`.
 */
export function reclaimOrphanFires(
  db: Database,
  opts: { activeFireIds?: Iterable<string>; now?: number } = {},
): ReclaimOrphanResult {
  const active = new Set(opts.activeFireIds ?? []);
  const now = opts.now ?? Date.now();
  const rows = db
    .prepare(`SELECT * FROM fires WHERE status='running'`)
    .all() as FireRow[];
  const reclaimed: string[] = [];
  const dead: string[] = [];
  for (const row of rows) {
    if (active.has(row.fire_id)) continue; // genuinely running here — leave it
    if (row.attempt < row.max_attempts) {
      // Immediate eligibility: next_retry_at=now so the scheduler promotes
      // it back to `queued` on its next tick.
      markFireFailedWithRetry(db, row.fire_id, {
        error: ORPHAN_RECLAIM_REASON,
        next_retry_at: now,
      });
      reclaimed.push(row.fire_id);
    } else {
      markFireDead(db, row.fire_id, { error: ORPHAN_RECLAIM_REASON });
      // Surface the permanently-dead orphan to operators exactly like a
      // real dead-letter, but attribute it to the service restart — the
      // trigger's own logic did not fail.
      deadLetterFire(db, row, {
        error: ORPHAN_RECLAIM_REASON,
        title: `Trigger fire interrupted by service restart: ${row.trigger_id ?? '(unknown)'}`,
        preview:
          'Fire was still running when clawdevbox restarted and its retry budget was already exhausted, so it was dead-lettered (service_restart_orphan). The trigger logic itself did not fail; re-run it manually if the work is still needed.',
      });
      dead.push(row.fire_id);
    }
  }
  return { reclaimed, dead };
}

export function listFires(
  db: Database,
  opts: {
    status?: string[];
    workspace_id?: string;
    trigger_id?: string;
    limit?: number;
    before?: number;
  },
): FireRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status.length > 0) {
    where.push(`status IN (${opts.status.map(() => '?').join(',')})`);
    params.push(...opts.status);
  }
  if (opts.workspace_id) {
    where.push('workspace_id = ?');
    params.push(opts.workspace_id);
  }
  if (opts.trigger_id) {
    where.push('trigger_id = ?');
    params.push(opts.trigger_id);
  }
  if (opts.before !== undefined) {
    where.push('scheduled_at < ?');
    params.push(opts.before);
  }
  const limit = Math.min(opts.limit ?? 50, 500);
  const sql = `SELECT * FROM fires ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY scheduled_at DESC, fire_id DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as FireRow[];
}
