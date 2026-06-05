/**
 * dispatcher.ts — concurrency-capped fire dispatcher (spec §6).
 *
 * Owns an in-flight `Set<fire_id>` capped at `maxConcurrent` (default 4).
 * `pickUp()` claims as many fires as it can fit through
 * `claimNextFire(db)`, which atomically marks the row `running` (or
 * `skipped` if another fire for the same trigger is already running —
 * the §6.3 overlap-skip protocol).
 *
 *
 * Each claimed fire is run via `runFire()`, which always dispatches to
 * the script binding. The `binds_callback_to_*` mechanism was removed
 * on 2026-05-28 (see docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md).
 *
 * Outcomes:
 *   - success → markFireSuccess + once-disable
 *   - failure with attempts left → markFireFailedWithRetry
 *   - failure with attempts exhausted → markFireDead + dead-letter to inbox
 *
 * `stop()` is awaitable: stops accepting new picks, drains in-flight up to
 * `drainMs`, marks the survivors `failed/service_shutdown`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepP } from 'node:timers/promises';
import { registerPending, resolvePendingTimeout } from './pending-dispatch-registry.ts';
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';
import type { Database } from 'better-sqlite3';
import { emitChange, onChange } from './event-bus.ts';
import { logger } from './logger.ts';
import {
  attemptDir,
  claimNextFire,
  getFire,
  markFireDead,
  markFireFailedShutdown,
  markFireFailedWithRetry,
  markFireSuccess,
  type FireRow,
} from './db/fires-store.ts';
import { runTriggerScript } from './trigger-runner.ts';
import type { TriggerRuntime } from './validators.ts';
import { type RegisteredTriggerType, type Workspace } from './workspace.ts';
import type { runRecipe as RunRecipeFn } from './recipe-runner.ts';

interface TriggerRow {
  id: string;
  workspace_id: string;
  type: string;
  params_json: string;
  state_json: string;
  once: number;
  max_attempts: number;
  backoff_ms_json: string;
}

interface WorkspaceRowLite {
  id: string;
  path: string;
}

export interface DispatcherStatus {
  in_flight: number;
  max_concurrent: number;
  queued_count: number;
  retrying_count: number;
  dead_count: number;
}

export interface DispatcherOptions {
  maxConcurrent?: number;
  drainMs?: number;
  /** Override callback URL base (default `http://127.0.0.1:5201`). */
  callbackUrlBase?: string;
  /** Hard timeout for script binding (default 60s). */
  scriptTimeoutMs?: number;
  /** Provider id used as the spawn default when /spawn/<fire_id> doesn't override. Default 'copilot'. */
  defaultAgentCli?: string;
  /**
   * Test seam — overrides the runRecipe import used by spawnFromCallback.
   * Production callers leave this undefined; tests inject a stub to avoid
   * pty.spawn + filesystem writes.
   */
  runRecipeFn?: typeof RunRecipeFn;
}

export interface ActiveRunEntry {
  outDir: string;
  triggerId: string;
  dispatchTargetInstanceId?: string;
  spawnDefaults: {
    providerId: string;
    agent?: string;
    workspaceId: string;
    workspacePath: string;
  };
}

export class Dispatcher {
  private db: Database;
  private ws: Workspace;
  private maxConcurrent: number;
  private drainMs: number;
  private callbackUrlBase: string;
  private scriptTimeoutMs: number;
  private defaultAgentCli: string;
  private runRecipeFn: typeof RunRecipeFn | null;
  private inFlight = new Set<string>();
  private activeRuns = new Map<string, ActiveRunEntry>();
  private stopped = false;
  /**
   * Unsubscribes the bus listener that wakes pickUp() on 'fires' events.
   * Without this, manually-enqueued fires (via `trigger.fire`) sit in the
   * queue until the scheduler's next cron wake — the scheduler's debounced
   * reschedule only recomputes timer math, it doesn't call pickUp itself.
   */
  private unsubscribeFires: (() => void) | null = null;

  constructor(db: Database, ws: Workspace, opts: DispatcherOptions = {}) {
    this.db = db;
    this.ws = ws;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.drainMs = opts.drainMs ?? 15_000;
    this.callbackUrlBase = opts.callbackUrlBase ?? 'http://127.0.0.1:5201';
    this.scriptTimeoutMs = opts.scriptTimeoutMs ?? 60_000;
    this.defaultAgentCli = opts.defaultAgentCli ?? 'copilot';
    this.runRecipeFn = opts.runRecipeFn ?? null;
  }

  start(): void {
    this.stopped = false;
    // React to fires-store mutations (enqueueFire, claimNextFire, mark*) so
    // manually-fired triggers don't have to wait for the next scheduler wake.
    // claimNextFire is atomic, so re-entrant pickUp() calls are safe.
    if (!this.unsubscribeFires) {
      this.unsubscribeFires = onChange((topic) => {
        if (topic === 'fires' && !this.stopped) {
          // Defer one tick so the calling transaction has fully committed
          // before claimNextFire runs in another statement.
          setImmediate(() => {
            try {
              this.pickUp();
            } catch (err) {
              logger.warn(
                { err: err instanceof Error ? err.message : String(err) },
                'dispatcher: pickUp from fires-bus subscription threw',
              );
            }
          });
        }
      });
    }
    this.pickUp();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.unsubscribeFires) {
      this.unsubscribeFires();
      this.unsubscribeFires = null;
    }
    const deadline = Date.now() + this.drainMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.inFlight.size > 0) {
      const survivors = [...this.inFlight];
      for (const fid of survivors) {
        try {
          markFireFailedShutdown(this.db, fid);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), fire_id: fid },
            'dispatcher: shutdown mark failed',
          );
        }
      }
      this.inFlight.clear();
    }
  }

  pickUp(): void {
    if (this.stopped) return;
    while (this.inFlight.size < this.maxConcurrent) {
      let fire: FireRow | null;
      try {
        fire = claimNextFire(this.db);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'dispatcher: claimNextFire failed',
        );
        return;
      }
      if (!fire) break;
      this.inFlight.add(fire.fire_id);
      setImmediate(() => {
        this.runFire(fire!).catch((err) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), fire_id: fire!.fire_id },
            'dispatcher: runFire threw outside catch',
          );
          this.inFlight.delete(fire!.fire_id);
        });
      });
    }
  }

  status(): DispatcherStatus {
    const counts = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM fires WHERE status IN ('queued','retrying','dead') GROUP BY status`,
      )
      .all() as Array<{ status: string; c: number }>;
    const get = (s: string): number => counts.find((x) => x.status === s)?.c ?? 0;
    return {
      in_flight: this.inFlight.size,
      max_concurrent: this.maxConcurrent,
      queued_count: get('queued'),
      retrying_count: get('retrying'),
      dead_count: get('dead'),
    };
  }

  /**
   * Test seam — register an active-run entry as if a script binding had
   * just kicked off. Production code path is `runScriptBinding`, which
   * calls this method internally. Tests use it directly to exercise
   * `/dispatch/<fire_id>` and `/spawn/<fire_id>` without spinning up a
   * real trigger script.
   */
  recordActiveRun(fireId: string, entry: ActiveRunEntry): void {
    this.activeRuns.set(fireId, entry);
  }

  /**
   * Dispatch a prompt to the tmux session attached to the fire's
   * subscriber pty. Returns a discriminated union signaling the routing
   * outcome; the HTTP handler maps each variant to an appropriate response.
   */
  async dispatchToConductor(
    fire_id: string,
    prompt: string,
  ): Promise<
    | { status: 'not_found_fire' }
    | { status: 'no_dispatch_target' }
    | { status: 'target_unavailable' }
    | { status: 'ok'; state: 'dispatched'; dispatchId: string }
  > {
    const entry = this.activeRuns.get(fire_id);
    if (!entry) return { status: 'not_found_fire' };
    if (!entry.dispatchTargetInstanceId) return { status: 'no_dispatch_target' };
    return this.dispatchToInstance(entry.dispatchTargetInstanceId, prompt);
  }

  /**
   * Dispatch a prompt directly to a tmux session by instance_id — no fire
   * required. Used by ad-hoc callers (the /dispatch endpoint, /spawn smart
   * routing) that already know the target session.
   *
   * Behavior:
   *   1. Look up the tmux session via `tmuxSessionRegistry`. Returns
   *      `target_unavailable` if not found (caller can fall through to a
   *      spawn path or surface a 404).
   *   2. Register a pending-dispatch entry. Subsequent dispatches to the
   *      same instance are FIFO-queued; only one is "active" at a time.
   *   3. Send the bytes: Escape (clears any overlay) → gap → text → gap →
   *      Enter. The two gaps match copilot's documented split-cr-250ms
   *      timing — too-fast Enter is absorbed by the TUI.
   *   4. Race the agent's `update_status` response against an overall
   *      timeout in the BACKGROUND. The method itself returns as soon as
   *      the bytes are written so the HTTP caller doesn't block.
   *
   * The returned `state` is always `'dispatched'` under the tmux model —
   * the legacy SessionConductor state machine ('idle'|'busy'|'starting'|
   * 'exited') no longer exists. The caller treats the field opaquely.
   */
  async dispatchToInstance(
    instanceId: string,
    prompt: string,
  ): Promise<
    | { status: 'target_unavailable' }
    | { status: 'ok'; state: 'dispatched'; dispatchId: string }
  > {
    const session = tmuxSessionRegistry.get(instanceId);
    if (!session) return { status: 'target_unavailable' };

    const { dispatchId, promise } = registerPending(instanceId, prompt);

    // Bytes-on-the-wire ordering. Each gap is empirically required: Copilot's
    // TUI absorbs Enter that arrives too close to a preceding ESC or the
    // input bytes.
    try {
      await session.sendKey('Escape');
      await sleepP(200);
      await session.sendText(prompt);
      await sleepP(250);
      await session.sendKey('Enter');
    } catch (err) {
      logger.warn(
        { instanceId, err: err instanceof Error ? err.message : String(err) },
        'dispatcher: dispatchToInstance — sendText/sendKey failed',
      );
      // Treat send-failure as immediate target_unavailable; tear down the
      // pending entry so a retry can re-register.
      resolvePendingTimeout(instanceId);
      return { status: 'target_unavailable' };
    }

    // Background timeout race — does NOT block the HTTP response.
    const TIMEOUT_MS = 5 * 60 * 1000;
    const timeoutPromise = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), TIMEOUT_MS));
    Promise.race([promise, timeoutPromise]).then((winner) => {
      if (winner === 'timeout') {
        resolvePendingTimeout(instanceId);
        logger.warn({ instanceId, dispatchId }, 'dispatcher: dispatch timed out waiting for update_status');
      }
    }).catch(() => { /* swallow — registry already resolved */ });

    return { status: 'ok', state: 'dispatched', dispatchId };
  }

  /**
   * Find the live instance_id for a given cli_session_id (GUID), if any.
   * A session is live iff the DB row is still running and either the legacy
   * pty registry or the tmux session registry still has the instance.
   *
   * Returns the newest matching live instance_id, or null.
   */
  async findLiveInstanceForSession(cliSessionId: string): Promise<string | null> {
    type Row = { recipe_instance_id: string };
    const rows = this.db
      .prepare(
        `SELECT recipe_instance_id FROM agent_sessions
         WHERE cli_session_id = ? AND status = 'running' AND interactive = 1
         ORDER BY started_at DESC LIMIT 10`,
      )
      .all(cliSessionId) as Row[];
    if (rows.length === 0) return null;
    const { isSessionLive } = await import('./pty-registry.ts');
    const { tmuxSessionRegistry } = await import('./cli-sessions/tmux-session-runtime.ts');
    for (const r of rows) {
      if (isSessionLive(r.recipe_instance_id)) return r.recipe_instance_id;
      if (tmuxSessionRegistry.get(r.recipe_instance_id)) return r.recipe_instance_id;
    }
    return null;
  }

  /**
   * Spawn a fresh interactive agent session via recipe-runner with the
   * supplied prompt. Optional body fields can override the trigger's
   * configured defaults. Returns the new instance_id + sessionId on
   * success.
   */
  /**
   * Spawn a fresh interactive agent session via recipe-runner with the
   * supplied prompt. When `fire_id` resolves to an active fire entry,
   * defaults come from that entry's `spawnDefaults`. When no fire_id
   * (or fire not found), the caller must provide `provider`, `workspace_*`
   * etc. directly.
   */
  async spawnFromCallback(
    fire_id: string | null,
    prompt: string,
    overrides: {
      agent?: string;
      /** Optional --model override for copilot/claude/agency. */
      model?: string;
      workspaceId?: string;
      provider?: string;
      workspacePath?: string;
      /** Explicit cli_session_id (GUID) to bind to. If omitted, runRecipe mints a fresh UUID. */
      sessionId?: string;
      /** When true and a session_id is provided, this is a resume (we've already verified the prior session existed). */
      resume?: boolean;
    } = {},
  ): Promise<
    | { status: 'not_found_fire' }
    | { status: 'spawn_failed'; message: string }
    | { status: 'ok'; instanceId: string; sessionId: string }
  > {
    let entry: ActiveRunEntry | undefined;
    if (fire_id) {
      entry = this.activeRuns.get(fire_id);
      if (!entry && !(overrides.provider && overrides.workspacePath)) {
        return { status: 'not_found_fire' };
      }
    }

    const { runRecipe } = this.runRecipeFn
      ? { runRecipe: this.runRecipeFn }
      : await import('./recipe-runner.ts');
    const { resolveConfig } = await import('./config.ts');
    const { resolveWorkspacesRoot } = await import('./workspaces-store.ts');
    const { ensureWorkspace } = await import('./db/workspaces-store.ts');

    const cfg = resolveConfig({ projectDir: this.ws.projectDir, globalDir: this.ws.globalDir });
    const workspacesRoot = resolveWorkspacesRoot();
    const agent = overrides.agent ?? entry?.spawnDefaults.agent;

    // Resolve workspace: explicit id > explicit path > entry defaults.
    // If workspace_id is given AND no row exists, we still need workspace_path
    // to create it (the id is honored — useful for stable references across
    // restarts).
    let workspaceInfo: { id: string; path: string } | null = null;
    if (overrides.workspaceId) {
      workspaceInfo = this.resolveWorkspaceById(overrides.workspaceId);
      if (!workspaceInfo && overrides.workspacePath) {
        // Caller-supplied id + path — honor the id when creating.
        const wsRow = ensureWorkspace(this.db, {
          id: overrides.workspaceId,
          path: overrides.workspacePath,
        });
        workspaceInfo = { id: wsRow.id, path: wsRow.path };
      }
    }
    if (!workspaceInfo && overrides.workspacePath) {
      const wsRow = ensureWorkspace(this.db, { path: overrides.workspacePath });
      workspaceInfo = { id: wsRow.id, path: wsRow.path };
    }
    if (!workspaceInfo && entry) {
      workspaceInfo = { id: entry.spawnDefaults.workspaceId, path: entry.spawnDefaults.workspacePath };
    }
    if (!workspaceInfo) {
      return { status: 'spawn_failed', message: 'workspace_path or fire_id with valid spawn defaults required' };
    }

    const providerId = overrides.provider ?? entry?.spawnDefaults.providerId;
    if (!providerId) {
      return { status: 'spawn_failed', message: 'provider required (no fire defaults available)' };
    }

    try {
      const result = await runRecipe({
        recipeId: null,
        recipeSnapshot: '',
        isAdhoc: true,
        prompt,
        spawnMode: 'interactive',
        workspaceInfo,
        agentCli: providerId,
        agent,
        model: overrides.model,
        workspacesRoot,
        ws: this.ws,
        cfg,
        triggerId: entry?.triggerId,
        fireId: fire_id ?? undefined,
        sessionId: overrides.sessionId,
        resumeOf: overrides.resume ? overrides.sessionId : undefined,
      });
      if (result.spawn_error) {
        return { status: 'spawn_failed', message: `${result.spawn_error.code}: ${result.spawn_error.message}` };
      }
      return { status: 'ok', instanceId: result.recipe_instance_id, sessionId: result.session_id };
    } catch (err) {
      return { status: 'spawn_failed', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private resolveWorkspaceById(id: string): { id: string; path: string } | null {
    const row = this.db.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as { id: string; path: string } | undefined;
    return row ?? null;
  }

  private async runFire(fire: FireRow): Promise<void> {
    const startedAt = Date.now();
    let trigger: TriggerRow | undefined;
    try {
      if (!fire.trigger_id) {
        throw new Error('fire has no trigger_id');
      }
      trigger = this.db
        .prepare(`SELECT * FROM triggers WHERE id = ?`)
        .get(fire.trigger_id) as TriggerRow | undefined;
      if (!trigger) throw new Error(`trigger not found: ${fire.trigger_id}`);

      const wsRow = this.db
        .prepare(`SELECT id, path FROM workspaces WHERE id = ?`)
        .get(fire.workspace_id) as WorkspaceRowLite | undefined;
      if (!wsRow) throw new Error(`workspace not found: ${fire.workspace_id}`);

      const outDir = attemptDir(wsRow.path, fire.fire_id, fire.attempt);
      mkdirSync(outDir, { recursive: true });

      // Set the parent output_dir on the fire row once.
      this.db
        .prepare(`UPDATE fires SET output_dir = ? WHERE fire_id = ?`)
        .run(join(wsRow.path, '.clawdevbox', 'fires', fire.fire_id), fire.fire_id);

      const typeManifest = this.ws.triggerTypes.get(trigger.type) ?? null;

      logger.debug(
        { fire_id: fire.fire_id, trigger_id: trigger.id, attempt: fire.attempt },
        'dispatcher: running fire',
      );

      const result = await this.runScriptBinding(fire, trigger, outDir, typeManifest);

      markFireSuccess(this.db, fire.fire_id, {
        duration_ms: Date.now() - startedAt,
        exit_code: result.exit_code ?? 0,
      });

      this.db
        .prepare(
          `UPDATE triggers SET last_run_at=?, last_run_status='ok', last_run_error=NULL WHERE id=?`,
        )
        .run(Date.now(), trigger.id);

      if (trigger.once === 1) {
        this.db.prepare(`UPDATE triggers SET enabled=0 WHERE id=?`).run(trigger.id);
        emitChange('triggers');
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.message : String(err);
      this.recordFailure(fire, trigger, errStr);
    } finally {
      this.inFlight.delete(fire.fire_id);
      this.activeRuns.delete(fire.fire_id);
      if (!this.stopped) this.pickUp();
    }
  }

  private recordFailure(fire: FireRow, trigger: TriggerRow | undefined, errStr: string): void {
    let backoffs: number[] = [30000, 120000, 600000];
    if (trigger?.backoff_ms_json) {
      try {
        const parsed = JSON.parse(trigger.backoff_ms_json) as unknown;
        if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) {
          backoffs = parsed as number[];
        }
      } catch {
        /* keep defaults */
      }
    }
    const current = getFire(this.db, fire.fire_id);
    if (!current) return;
    if (current.status !== 'running') return; // already terminal

    if (current.attempt < current.max_attempts) {
      const idx = current.attempt - 1;
      const backoff = backoffs[idx] ?? backoffs[backoffs.length - 1] ?? 60_000;
      markFireFailedWithRetry(this.db, fire.fire_id, {
        error: errStr,
        next_retry_at: Date.now() + backoff,
      });
    } else {
      markFireDead(this.db, fire.fire_id, { error: errStr });
      try {
        this.addDeadLetterInbox(fire, trigger, errStr);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'dispatcher: dead-letter inbox add failed',
        );
      }
      if (trigger) {
        this.db
          .prepare(
            `UPDATE triggers SET last_run_at=?, last_run_status='error', last_run_error=? WHERE id=?`,
          )
          .run(Date.now(), errStr, trigger.id);
      }
    }
  }

  private addDeadLetterInbox(fire: FireRow, trigger: TriggerRow | undefined, errStr: string): void {
    const id = `inb_dead_${fire.fire_id}`;
    const now = Date.now();
    const title = `Trigger fire failed permanently: ${trigger?.id ?? fire.trigger_id ?? '(unknown)'}`;
    const preview = errStr.slice(0, 200);
    this.db
      .prepare(
        `INSERT INTO inbox_items (id, workspace_id, title, preview, source, status, trigger_id, fire_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'trigger-dead', 'unread', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           preview = excluded.preview,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        fire.workspace_id,
        title,
        preview,
        trigger?.id ?? null,
        fire.fire_id,
        now,
        now,
      );
    emitChange('inbox');
  }

  private async runScriptBinding(
    fire: FireRow,
    trigger: TriggerRow,
    outDir: string,
    typeManifest: RegisteredTriggerType | null,
  ): Promise<{ exit_code: number }> {
    if (!typeManifest) throw new Error(`trigger type not found: ${trigger.type}`);
    const runtime = ((typeManifest as unknown as { runtime?: TriggerRuntime }).runtime ?? 'tsx') as TriggerRuntime;
    const baseUrl = this.callbackUrlBase;
    const dispatchUrl = `${baseUrl}/dispatch?fire_id=${encodeURIComponent(fire.fire_id)}`;
    const spawnUrl = `${baseUrl}/spawn?fire_id=${encodeURIComponent(fire.fire_id)}`;

    const wsRow = this.db
      .prepare(`SELECT id, path FROM workspaces WHERE id = ?`)
      .get(fire.workspace_id) as WorkspaceRowLite | undefined;
    if (!wsRow) throw new Error(`workspace not found: ${fire.workspace_id}`);

    const state = (JSON.parse(trigger.state_json) as Record<string, unknown>) || {};

    // Resolve dispatch target from the trigger's stashed subscriber thread id
    // (if any), but only if that pty is live in pty-registry right now.
    let dispatchTargetInstanceId: string | undefined;
    try {
      const subscriberThreadId = state.__subscriber_thread_id;
      if (typeof subscriberThreadId === 'string') {
        const { hasSession } = await import('./pty-registry.ts');
        if (hasSession(subscriberThreadId)) {
          dispatchTargetInstanceId = subscriberThreadId;
        }
      }
    } catch { /* malformed state — skip dispatch routing */ }
    delete (state as Record<string, unknown>).__subscriber_thread_id;

    const spawnDefaults: ActiveRunEntry['spawnDefaults'] = {
      providerId: this.defaultAgentCli,
      agent: 'dev-buddy:dev-buddy',
      workspaceId: wsRow.id,
      workspacePath: wsRow.path,
    };

    this.recordActiveRun(fire.fire_id, {
      outDir,
      triggerId: trigger.id,
      dispatchTargetInstanceId,
      spawnDefaults,
    });

    const payload = fire.payload_json ? JSON.parse(fire.payload_json) : null;

    const result = await runTriggerScript({
      scriptPath: typeManifest.file_abs,
      runtime,
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: trigger.id,
        run_id: fire.fire_id,
        output_dir: outDir,
        dispatch_url: dispatchTargetInstanceId ? dispatchUrl : undefined,
        spawn_url: spawnUrl,
        state,
        payload,
      },
      timeoutMs: this.scriptTimeoutMs,
    });

    try {
      writeFileSync(join(outDir, 'stdout.txt'), result.stdout);
      writeFileSync(join(outDir, 'stderr.txt'), result.stderr);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'dispatcher: attempt output write failed',
      );
    }

    const parsed = result.stdout_parsed as
      | { state?: unknown }
      | null;

    if (result.timed_out) throw new Error('script_timeout');
    if (result.exit_code !== 0) {
      throw new Error(
        `script exited with code ${result.exit_code}; stderr=${result.stderr.slice(0, 1000)}`,
      );
    }

    // Persist returned state.
    if (parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object') {
      const merged = { ...state, ...(parsed.state as Record<string, unknown>) };
      this.db
        .prepare(`UPDATE triggers SET state_json = ? WHERE id = ?`)
        .run(JSON.stringify(merged), trigger.id);
      emitChange('triggers');
    }

    return { exit_code: result.exit_code ?? 0 };
  }
}
