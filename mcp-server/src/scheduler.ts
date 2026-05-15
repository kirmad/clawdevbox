/**
 * scheduler.ts — event-driven cron scheduler (spec §5).
 *
 * Owns exactly one `setTimeout`. On wake:
 *   1. Enqueue all due cron fires (skip-missed semantics, 1s jitter window).
 *   2. Promote all retrying fires whose `next_retry_at <= now` to `queued`.
 *   3. Poke `dispatcher.pickUp()`.
 *   4. Recompute the next wake.
 *
 * The bus subscription on `'triggers'` and `'fires'` debounces a reschedule
 * by 50ms so a burst of inserts coalesces into one wall-clock recompute.
 * A 60-second safety-net `setInterval` calls `reschedule()` unconditionally
 * to defend against clock jumps and missed events.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { emitChange, onChange, type ChangeTopic } from './event-bus.ts';
import { nextRunAfter } from './cron-utils.ts';
import { logger } from './logger.ts';
import type { Workspace } from './workspace.ts';

interface TriggerRowMin {
  id: string;
  type: string;
  workspace_id: string;
  cron_mode: 'inherit' | 'override' | 'disabled';
  cron_expression: string | null;
  max_attempts: number;
}

export interface DispatcherLike {
  pickUp(): void;
}

export interface SchedulerStatus {
  next_wake_at: number | null;
  last_wake_at: number | null;
  total_wakes: number;
}

export class Scheduler {
  private db: Database;
  private dispatcher: DispatcherLike;
  private ws: Workspace;

  private timer: NodeJS.Timeout | null = null;
  private safetyInterval: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private nextWakeAt: number | null = null;
  private lastWakeAt: number | null = null;
  private totalWakes = 0;

  constructor(db: Database, dispatcher: DispatcherLike, ws: Workspace) {
    this.db = db;
    this.dispatcher = dispatcher;
    this.ws = ws;
  }

  start(): void {
    this.stopped = false;
    this.unsubscribe = onChange((topic: ChangeTopic) => {
      if (topic === 'triggers' || topic === 'fires') this.scheduleDebouncedReschedule();
    });
    this.safetyInterval = setInterval(() => this.reschedule(), 60_000);
    if (this.safetyInterval.unref) this.safetyInterval.unref();
    this.reschedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.safetyInterval) {
      clearInterval(this.safetyInterval);
      this.safetyInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  status(): SchedulerStatus {
    return {
      next_wake_at: this.nextWakeAt,
      last_wake_at: this.lastWakeAt,
      total_wakes: this.totalWakes,
    };
  }

  reschedule(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    const earliest = this.computeEarliest(now);
    this.nextWakeAt = earliest;
    this.persistKv(now, earliest);
    if (earliest === null) return;
    const delay = Math.max(0, earliest - now);
    this.timer = setTimeout(() => this.onWake(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Test-exposed wake handler. Production code reaches here through the
   * internal setTimeout, but unit tests prefer calling it directly to
   * avoid sleep-then-poll flakiness.
   */
  onWake(): void {
    if (this.stopped) return;
    this.lastWakeAt = Date.now();
    this.totalWakes++;
    const now = this.lastWakeAt;

    const triggers = this.listEnabledTriggers();
    const due: TriggerRowMin[] = [];
    for (const t of triggers) {
      const expr = this.resolveCron(t);
      if (!expr) continue;
      const next = nextRunAfter(expr, now - 1000);
      if (next === null) continue;
      // 1-second lookback + 50ms forward window absorbs setTimeout jitter.
      if (next <= now + 50) due.push(t);
    }

    let enqueued = 0;
    let promoted = 0;
    const tx = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO fires (fire_id, workspace_id, trigger_id, source, status, attempt, max_attempts, scheduled_at)
         VALUES (?, ?, ?, 'cron', 'queued', 1, ?, ?)`,
      );
      for (const t of due) {
        const fid = mintFireId(enqueued);
        insert.run(fid, t.workspace_id, t.id, t.max_attempts, now);
        enqueued++;
      }
      const r = this.db
        .prepare(
          `UPDATE fires SET status='queued' WHERE status='retrying' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`,
        )
        .run(now);
      promoted = r.changes;
    });
    tx();
    if (enqueued > 0 || promoted > 0) emitChange('fires');

    try {
      this.dispatcher.pickUp();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler: dispatcher.pickUp threw',
      );
    }
    this.reschedule();
  }

  private scheduleDebouncedReschedule(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reschedule();
    }, 50);
    if (this.debounceTimer.unref) this.debounceTimer.unref();
  }

  private listEnabledTriggers(): TriggerRowMin[] {
    return this.db
      .prepare(
        `SELECT id, type, workspace_id, cron_mode, cron_expression, max_attempts
         FROM triggers WHERE enabled = 1`,
      )
      .all() as TriggerRowMin[];
  }

  private resolveCron(row: TriggerRowMin): string | null {
    if (row.cron_mode === 'disabled') return null;
    if (row.cron_mode === 'override') {
      return row.cron_expression && row.cron_expression.length > 0 ? row.cron_expression : null;
    }
    // inherit: look up the type's default_cron
    const type = this.ws.triggerTypes.get(row.type);
    return type?.default_cron ?? null;
  }

  private computeEarliest(now: number): number | null {
    let earliest: number | null = null;
    for (const t of this.listEnabledTriggers()) {
      const expr = this.resolveCron(t);
      if (!expr) continue;
      const next = nextRunAfter(expr, now);
      if (next === null) continue;
      if (earliest === null || next < earliest) earliest = next;
    }
    const retry = this.db
      .prepare(
        `SELECT MIN(next_retry_at) AS m FROM fires WHERE status='retrying' AND next_retry_at IS NOT NULL`,
      )
      .get() as { m: number | null } | undefined;
    if (retry && retry.m != null && (earliest === null || retry.m < earliest)) {
      earliest = retry.m;
    }
    return earliest;
  }

  private persistKv(now: number, nextWake: number | null): void {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      );
      stmt.run('scheduler:last_reschedule_at', String(now), now);
      stmt.run(
        'scheduler:next_wake_at',
        nextWake === null ? '' : String(nextWake),
        now,
      );
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'scheduler: kv persist failed',
      );
    }
  }
}

let fireSeq = 0;
function mintFireId(suffix: number): string {
  fireSeq = (fireSeq + 1) & 0xffff;
  const rnd = randomBytes(2).toString('hex');
  return `fire_${Date.now().toString(36)}_${rnd}_${suffix}_${fireSeq.toString(16)}`;
}
