/**
 * daemons-store.ts — CRUD for the daemons + daemon_runs tables.
 *
 * Two tables, one supervisor invariant:
 *
 *   daemons        — desired state ("this command should always be running")
 *   daemon_runs    — one row per spawn attempt (audit log + live row)
 *
 * The DB enforces "at most one live run per daemon" via the partial unique
 * index `idx_daemon_runs_live` (migration v7) on
 * `daemon_runs(daemon_id) WHERE status IN ('starting','running')`. The
 * supervisor races `claimStartingRun()` inside a transaction; the loser
 * gets a UNIQUE-constraint failure and backs off.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { emitChange } from '../event-bus.ts';

export type DaemonKind = 'script';
export type DaemonRuntime = 'node' | 'tsx' | 'python' | 'bash' | 'pwsh' | 'direct';
export type DaemonRunStatus = 'starting' | 'running' | 'exited' | 'failed' | 'stopped';

export interface DaemonRow {
  id: string;
  name: string;
  workspace_id: string;
  kind: DaemonKind;
  runtime: DaemonRuntime;
  command_json: string;
  cwd: string | null;
  env_json: string;
  enabled: number;
  generation: number;
  restart_policy_json: string;
  backoff_ms: number;
  restart_count: number;
  last_exit_at: number | null;
  last_error: string | null;
  next_restart_at: number | null;
  stable_since: number | null;
  created_at: number;
  updated_at: number;
}

export interface DaemonRunRow {
  id: string;
  daemon_id: string;
  generation: number;
  status: DaemonRunStatus;
  pid: number | null;
  started_at: number;
  exited_at: number | null;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  log_path: string | null;
}

export interface RestartPolicy {
  /** Backoff schedule in ms — restart_count clamps into this array. */
  backoff_ms: number[];
  /** After alive this many ms, reset restart_count to 0. */
  stable_after_ms: number;
  /** Hard cap on restarts; 0 = unlimited. */
  max_restarts: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  backoff_ms: [5_000, 30_000, 120_000, 600_000, 1_800_000],
  stable_after_ms: 5 * 60_000,
  max_restarts: 0,
};

export function mintDaemonId(): string {
  return `dmn_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function mintDaemonRunId(): string {
  return `dr_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export interface UpsertDaemonInput {
  id?: string;
  name: string;
  workspace_id: string;
  runtime: DaemonRuntime;
  command: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  enabled?: boolean;
  restart_policy?: Partial<RestartPolicy>;
}

export function upsertDaemon(db: Database, input: UpsertDaemonInput): DaemonRow {
  const now = Date.now();
  const id = input.id ?? mintDaemonId();
  const existing = db.prepare('SELECT * FROM daemons WHERE id = ?').get(id) as DaemonRow | undefined;

  const policy: RestartPolicy = {
    ...DEFAULT_RESTART_POLICY,
    ...(input.restart_policy ?? {}),
  };

  if (existing) {
    db.prepare(
      `UPDATE daemons SET
         name = ?, workspace_id = ?, runtime = ?,
         command_json = ?, cwd = ?, env_json = ?,
         enabled = ?, restart_policy_json = ?,
         generation = generation + 1,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name,
      input.workspace_id,
      input.runtime,
      JSON.stringify(input.command),
      input.cwd ?? null,
      JSON.stringify(input.env ?? {}),
      input.enabled === false ? 0 : 1,
      JSON.stringify(policy),
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO daemons (
         id, name, workspace_id, kind, runtime,
         command_json, cwd, env_json, enabled,
         generation, restart_policy_json, backoff_ms,
         restart_count, created_at, updated_at
       ) VALUES (?, ?, ?, 'script', ?, ?, ?, ?, ?, 1, ?, 0, 0, ?, ?)`,
    ).run(
      id, input.name, input.workspace_id, input.runtime,
      JSON.stringify(input.command),
      input.cwd ?? null,
      JSON.stringify(input.env ?? {}),
      input.enabled === false ? 0 : 1,
      JSON.stringify(policy),
      now, now,
    );
  }
  emitChange('daemons');
  return getDaemon(db, id)!;
}

export function getDaemon(db: Database, id: string): DaemonRow | null {
  const row = db.prepare('SELECT * FROM daemons WHERE id = ?').get(id) as DaemonRow | undefined;
  return row ?? null;
}

export function listDaemons(db: Database, opts: { workspace_id?: string } = {}): DaemonRow[] {
  if (opts.workspace_id) {
    return db.prepare('SELECT * FROM daemons WHERE workspace_id = ? ORDER BY created_at ASC')
      .all(opts.workspace_id) as DaemonRow[];
  }
  return db.prepare('SELECT * FROM daemons ORDER BY created_at ASC').all() as DaemonRow[];
}

export function setEnabled(db: Database, id: string, enabled: boolean): void {
  db.prepare(
    `UPDATE daemons
     SET enabled = ?, generation = generation + 1, updated_at = ?
     WHERE id = ?`,
  ).run(enabled ? 1 : 0, Date.now(), id);
  emitChange('daemons');
}

export function deleteDaemon(db: Database, id: string): void {
  db.prepare('DELETE FROM daemons WHERE id = ?').run(id);
  emitChange('daemons');
}

/**
 * Bump the daemon's generation — used by the supervisor when stopping or
 * reconfiguring so any in-flight exit handler with a stale generation
 * skips its restart.
 */
export function bumpGeneration(db: Database, id: string): number {
  db.prepare('UPDATE daemons SET generation = generation + 1, updated_at = ? WHERE id = ?')
    .run(Date.now(), id);
  const row = getDaemon(db, id);
  return row?.generation ?? 0;
}

/**
 * Atomically claim a starting-run slot for this daemon. Returns the new
 * `daemon_run` row on success, or `null` if another run is already
 * `starting` or `running` (partial unique index violation).
 *
 * The caller must follow up with `markRunRunning()` after pid is known
 * and `markRunExited()` from the exit handler.
 */
export function claimStartingRun(
  db: Database,
  daemon_id: string,
  generation: number,
  log_path: string | null,
): DaemonRunRow | null {
  const id = mintDaemonRunId();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO daemon_runs (id, daemon_id, generation, status, started_at, log_path)
       VALUES (?, ?, ?, 'starting', ?, ?)`,
    ).run(id, daemon_id, generation, now, log_path);
  } catch (err) {
    // UNIQUE constraint on idx_daemon_runs_live — another live run exists.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) return null;
    throw err;
  }
  emitChange('daemons');
  return db.prepare('SELECT * FROM daemon_runs WHERE id = ?').get(id) as DaemonRunRow;
}

export function markRunRunning(db: Database, run_id: string, pid: number): void {
  db.prepare(
    `UPDATE daemon_runs SET status = 'running', pid = ? WHERE id = ?`,
  ).run(pid, run_id);
  emitChange('daemons');
}

export function markRunExited(
  db: Database,
  run_id: string,
  opts: {
    status: 'exited' | 'failed' | 'stopped';
    exit_code: number | null;
    signal: string | null;
    error: string | null;
  },
): void {
  db.prepare(
    `UPDATE daemon_runs SET status = ?, exited_at = ?, exit_code = ?, signal = ?, error = ?
     WHERE id = ?`,
  ).run(opts.status, Date.now(), opts.exit_code, opts.signal, opts.error, run_id);
  emitChange('daemons');
}

export function getLiveRun(db: Database, daemon_id: string): DaemonRunRow | null {
  const row = db.prepare(
    `SELECT * FROM daemon_runs
     WHERE daemon_id = ? AND status IN ('starting','running')
     ORDER BY started_at DESC LIMIT 1`,
  ).get(daemon_id) as DaemonRunRow | undefined;
  return row ?? null;
}

export function listRecentRuns(
  db: Database,
  daemon_id: string,
  limit = 20,
): DaemonRunRow[] {
  return db.prepare(
    `SELECT * FROM daemon_runs WHERE daemon_id = ?
     ORDER BY started_at DESC LIMIT ?`,
  ).all(daemon_id, limit) as DaemonRunRow[];
}

/** Update backoff/restart bookkeeping after a run exits. */
export function recordRestartBackoff(
  db: Database,
  id: string,
  opts: { next_restart_at: number | null; restart_count: number; last_error: string | null },
): void {
  db.prepare(
    `UPDATE daemons SET
       last_exit_at = ?,
       last_error = ?,
       restart_count = ?,
       next_restart_at = ?,
       stable_since = NULL,
       updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), opts.last_error, opts.restart_count, opts.next_restart_at, Date.now(), id);
}

/** Mark a daemon as "stable since N" (called when alive past stable_after_ms). */
export function markStable(db: Database, id: string, stable_since: number): void {
  db.prepare(
    `UPDATE daemons SET restart_count = 0, stable_since = ?, next_restart_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(stable_since, Date.now(), id);
}

/**
 * Reconcile any starting/running rows from a previous process — used at
 * startup. Their pids belong to a dead clawdevbox instance, so they need
 * to be marked stopped so the partial-unique index doesn't block a fresh
 * spawn.
 */
export function reconcileOrphanRuns(db: Database): number {
  const r = db.prepare(
    `UPDATE daemon_runs SET status = 'stopped', exited_at = ?, error = 'orphaned by service restart'
     WHERE status IN ('starting','running')`,
  ).run(Date.now());
  return r.changes;
}
