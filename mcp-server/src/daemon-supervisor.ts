/**
 * daemon-supervisor.ts — keeps enabled daemons running.
 *
 * One supervisor instance, owned by `cli/start.ts`. On `start()`:
 *   1. Reconciles orphan runs (rows left in 'starting'/'running' by a
 *      previous process whose pids are dead).
 *   2. Subscribes to the 'daemons' bus topic + sets up a 30s tick.
 *   3. On each tick: for every enabled daemon with no live run AND
 *      `next_restart_at <= now`, atomically claim a starting-row slot
 *      via partial-unique index and spawn.
 *
 * On `stop()`: gracefully stops every running daemon, drains exits up
 * to `drainMs`, then returns.
 *
 * Restart-on-exit policy:
 *   - clean exit (code 0) → restart with backoff_ms[restart_count++]
 *   - non-zero exit / signal → restart with same schedule
 *   - if alive past stable_after_ms → restart_count := 0 (markStable)
 *   - max_restarts > 0 enforces a hard cap
 *
 * Generation guard: when the user disables / reconfigures, the daemon
 * row's `generation` bumps. The exit handler attached at spawn time
 * captured the previous generation; if it no longer matches the row's
 * current generation, the exit handler skips its restart logic.
 */

import type { Database } from 'better-sqlite3';
import { logger } from './logger.ts';
import { onChange, emitChange } from './event-bus.ts';
import {
  bumpGeneration,
  claimStartingRun,
  getDaemon,
  getLiveRun,
  listDaemons,
  markRunExited,
  markRunRunning,
  markStable,
  recordRestartBackoff,
  reconcileOrphanRuns,
  type DaemonRow,
  type DaemonRunRow,
  type RestartPolicy,
  DEFAULT_RESTART_POLICY,
} from './db/daemons-store.ts';
import { DaemonProcess, daemonLogPath, type DaemonExitInfo } from './daemon-process-runner.ts';

const TICK_INTERVAL_MS = 30_000;

interface LiveDaemon {
  daemonId: string;
  runId: string;
  generation: number;
  proc: DaemonProcess;
  startedAt: number;
  stableTimer: NodeJS.Timeout | null;
}

export interface DaemonSupervisorOptions {
  /** Resolve a workspace_id to its absolute path. */
  resolveWorkspacePath: (workspace_id: string) => string | null;
  /** Default tick interval — exposed for tests. */
  tickIntervalMs?: number;
  /** Drain timeout for stop(). Default 8000ms. */
  drainMs?: number;
}

export class DaemonSupervisor {
  private db: Database;
  private opts: DaemonSupervisorOptions;
  private tickTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private live = new Map<string, LiveDaemon>();

  constructor(db: Database, opts: DaemonSupervisorOptions) {
    this.db = db;
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    const orphaned = reconcileOrphanRuns(this.db);
    if (orphaned > 0) {
      logger.warn({ count: orphaned }, 'daemon-supervisor: reconciled orphan runs');
    }
    this.unsubscribe = onChange((topic) => {
      if (topic === 'daemons') this.scheduleDebouncedTick();
    });
    const interval = this.opts.tickIntervalMs ?? TICK_INTERVAL_MS;
    this.tickTimer = setInterval(() => this.tick(), interval);
    if (this.tickTimer.unref) this.tickTimer.unref();
    // Kick once immediately so daemons spin up at startup.
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    const drainMs = this.opts.drainMs ?? 8_000;
    const live = Array.from(this.live.values());
    await Promise.race([
      Promise.all(live.map((d) => this.stopOne(d.daemonId, { reason: 'service shutdown' }))),
      new Promise<void>((r) => setTimeout(r, drainMs)),
    ]);
  }

  /** Public: visible daemons currently supervised by this process. */
  listLive(): Array<{ daemon_id: string; run_id: string; pid: number }> {
    return Array.from(this.live.values()).map((d) => ({
      daemon_id: d.daemonId,
      run_id: d.runId,
      pid: d.proc['child']?.pid ?? -1,
    }));
  }

  /**
   * Force-restart a daemon: stop the live process (if any) and let the
   * next tick respawn it. Bumps the generation so any in-flight exit
   * handler skips its own restart attempt.
   */
  async restart(daemon_id: string): Promise<void> {
    bumpGeneration(this.db, daemon_id);
    await this.stopOne(daemon_id, { reason: 'user restart', resetBackoff: true });
    // Force immediate retry on next tick by clearing next_restart_at.
    this.db.prepare('UPDATE daemons SET next_restart_at = NULL, restart_count = 0 WHERE id = ?')
      .run(daemon_id);
    this.scheduleDebouncedTick();
  }

  /**
   * Stop a daemon (the user-visible operation). Bumps generation so the
   * exit handler does NOT restart it, then sends stop() to the process.
   * The supervisor will only respawn it if the user re-enables.
   */
  async stopDaemon(daemon_id: string): Promise<void> {
    bumpGeneration(this.db, daemon_id);
    await this.stopOne(daemon_id, { reason: 'user stop' });
  }

  private async stopOne(
    daemon_id: string,
    info: { reason: string; resetBackoff?: boolean },
  ): Promise<void> {
    const live = this.live.get(daemon_id);
    if (!live) return;
    if (live.stableTimer) {
      clearTimeout(live.stableTimer);
      live.stableTimer = null;
    }
    this.live.delete(daemon_id);
    try {
      await live.proc.stop();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), daemon_id, reason: info.reason },
        'daemon-supervisor: stop() failed',
      );
    }
    // Mark the run row as stopped (exit handler may have already done it).
    try {
      markRunExited(this.db, live.runId, {
        status: 'stopped',
        exit_code: null,
        signal: null,
        error: info.reason,
      });
    } catch { /* exit handler beat us; that's fine */ }
    if (info.resetBackoff) {
      this.db.prepare(
        `UPDATE daemons SET restart_count = 0, next_restart_at = NULL, last_error = NULL
         WHERE id = ?`,
      ).run(daemon_id);
    }
  }

  private scheduleDebouncedTick(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tick();
    }, 100);
    if (this.debounceTimer.unref) this.debounceTimer.unref();
  }

  /** Called on tick + on every 'daemons' topic event (debounced). */
  tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    const daemons = listDaemons(this.db);
    for (const d of daemons) {
      if (!d.enabled) {
        // If we still have a live process for a disabled daemon, stop it.
        if (this.live.has(d.id)) {
          this.stopOne(d.id, { reason: 'disabled' }).catch(() => { /* logged in stopOne */ });
        }
        continue;
      }
      if (this.live.has(d.id)) continue;
      // Database says it might be live (orphan from another process)?
      // claimStartingRun will fail the partial-unique constraint and
      // return null in that case.
      if (d.next_restart_at != null && d.next_restart_at > now) continue;
      this.maybeStart(d);
    }
  }

  private maybeStart(d: DaemonRow): void {
    const wsPath = this.opts.resolveWorkspacePath(d.workspace_id);
    if (!wsPath) {
      logger.warn({ daemon_id: d.id, workspace_id: d.workspace_id },
        'daemon-supervisor: workspace not found; skipping');
      return;
    }
    const generationAtSpawn = d.generation;
    const runRow = claimStartingRun(this.db, d.id, generationAtSpawn, null);
    if (!runRow) {
      // Another live run exists per partial-unique index. The DB knows
      // more than we do — likely an orphan from a previous process that
      // reconcileOrphanRuns missed, or a race with another supervisor
      // (shouldn't happen in single-process mode).
      logger.debug({ daemon_id: d.id }, 'daemon-supervisor: live run already present');
      return;
    }
    const logPath = daemonLogPath(wsPath, d.id, runRow.id);
    // Patch the row's log_path (we couldn't compute it before the run_id existed).
    this.db.prepare('UPDATE daemon_runs SET log_path = ? WHERE id = ?').run(logPath, runRow.id);

    let command: string[];
    let env: Record<string, string>;
    try {
      command = JSON.parse(d.command_json);
      env = JSON.parse(d.env_json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ daemon_id: d.id, err: msg }, 'daemon-supervisor: bad command_json/env_json');
      markRunExited(this.db, runRow.id, {
        status: 'failed', exit_code: null, signal: null, error: `bad spec: ${msg}`,
      });
      this.handleExit(d, runRow, generationAtSpawn, { exit_code: null, signal: null, spawn_error: msg });
      return;
    }

    const proc = new DaemonProcess({
      runtime: d.runtime,
      command,
      cwd: d.cwd ?? wsPath,
      env,
      logPath,
    });

    let pid: number;
    try {
      pid = proc.start();
      markRunRunning(this.db, runRow.id, pid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markRunExited(this.db, runRow.id, {
        status: 'failed', exit_code: null, signal: null, error: msg,
      });
      this.handleExit(d, runRow, generationAtSpawn, { exit_code: null, signal: null, spawn_error: msg });
      return;
    }

    const startedAt = Date.now();
    const policy = this.parsePolicy(d.restart_policy_json);
    const live: LiveDaemon = {
      daemonId: d.id,
      runId: runRow.id,
      generation: generationAtSpawn,
      proc,
      startedAt,
      stableTimer: null,
    };
    // After stable_after_ms, reset restart_count.
    if (policy.stable_after_ms > 0) {
      live.stableTimer = setTimeout(() => {
        if (this.live.get(d.id) === live) markStable(this.db, d.id, startedAt);
      }, policy.stable_after_ms);
      if (live.stableTimer.unref) live.stableTimer.unref();
    }
    this.live.set(d.id, live);
    emitChange('daemons');

    proc.once('exit', (info: DaemonExitInfo) => {
      if (live.stableTimer) {
        clearTimeout(live.stableTimer);
        live.stableTimer = null;
      }
      // Only delete if WE'RE still the live entry (stop() may have replaced us).
      if (this.live.get(d.id) === live) this.live.delete(d.id);
      const exitStatus =
        info.spawn_error ? 'failed' :
        info.signal || (info.exit_code != null && info.exit_code !== 0) ? 'failed' :
        'exited';
      // markRunExited may already have been called by stopOne — swallow if so.
      try {
        markRunExited(this.db, runRow.id, {
          status: exitStatus,
          exit_code: info.exit_code,
          signal: info.signal,
          error: info.spawn_error,
        });
      } catch { /* already updated */ }
      this.handleExit(d, runRow, generationAtSpawn, info);
    });
  }

  /**
   * Decide whether to schedule a restart for this daemon. Generation
   * guard: if the daemon was disabled/reconfigured since we spawned,
   * skip the restart — the new generation's tick will handle it.
   */
  private handleExit(
    d: DaemonRow,
    runRow: DaemonRunRow,
    generationAtSpawn: number,
    info: DaemonExitInfo,
  ): void {
    if (this.stopped) return;
    const current = getDaemon(this.db, d.id);
    if (!current) return;
    if (!current.enabled) return;
    if (current.generation !== generationAtSpawn) {
      // The daemon was reconfigured / disabled while we were running.
      // The next tick will handle the new generation.
      return;
    }

    const policy = this.parsePolicy(current.restart_policy_json);
    const wasStable = current.stable_since != null;
    let nextCount = wasStable ? 1 : current.restart_count + 1;
    if (policy.max_restarts > 0 && nextCount > policy.max_restarts) {
      logger.warn({ daemon_id: d.id, max_restarts: policy.max_restarts },
        'daemon-supervisor: max_restarts exceeded; daemon will not auto-restart');
      this.db.prepare(
        `UPDATE daemons SET enabled = 0, last_error = ?, updated_at = ? WHERE id = ?`,
      ).run(`max_restarts (${policy.max_restarts}) exceeded`, Date.now(), d.id);
      return;
    }
    const backoffMs = pickBackoff(policy.backoff_ms, nextCount - 1);
    const nextAt = Date.now() + backoffMs;
    recordRestartBackoff(this.db, d.id, {
      next_restart_at: nextAt,
      restart_count: nextCount,
      last_error: info.spawn_error ?? (info.signal ? `signal ${info.signal}` :
        info.exit_code != null && info.exit_code !== 0 ? `exit code ${info.exit_code}` : null),
    });
    logger.info({
      daemon_id: d.id, run_id: runRow.id,
      exit_code: info.exit_code, signal: info.signal,
      restart_count: nextCount, backoff_ms: backoffMs, next_restart_at: nextAt,
    }, 'daemon-supervisor: scheduled restart');

    // Schedule a tick exactly when the backoff expires so we don't wait
    // up to TICK_INTERVAL_MS for the safety interval.
    const t = setTimeout(() => this.tick(), backoffMs + 50);
    if (t.unref) t.unref();
  }

  private parsePolicy(json: string): RestartPolicy {
    try {
      return { ...DEFAULT_RESTART_POLICY, ...JSON.parse(json) };
    } catch {
      return DEFAULT_RESTART_POLICY;
    }
  }
}

function pickBackoff(schedule: number[], index: number): number {
  if (schedule.length === 0) return 5_000;
  const i = Math.min(index, schedule.length - 1);
  return schedule[Math.max(0, i)]!;
}
