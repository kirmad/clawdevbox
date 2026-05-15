/**
 * dispatcher.ts — concurrency-capped fire dispatcher (spec §6).
 *
 * Owns an in-flight `Set<fire_id>` capped at `maxConcurrent` (default 4).
 * `pickUp()` claims as many fires as it can fit through
 * `claimNextFire(db)`, which atomically marks the row `running` (or
 * `skipped` if another fire for the same trigger is already running —
 * the §6.3 overlap-skip protocol).
 *
 * Each claimed fire is run via `runFire()`. The binding mode is resolved
 * from the trigger TYPE manifest (`ws.triggerTypes`):
 *   - `binds_callback_to_recipe`        → recipe binding (Phase 6.2)
 *   - `binds_callback_to === 'agent_session_resume'` → resume binding stub
 *   - otherwise                          → script binding (Phase 6.3)
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
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { emitChange } from './event-bus.ts';
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
import { recipePath, type RegisteredTriggerType, type Workspace } from './workspace.ts';
import { resolveRead } from './scope.ts';
import { runRecipe } from './recipe-runner.ts';
import { resolveWorkspacesRoot } from './workspaces-store.ts';

interface TriggerRow {
  id: string;
  workspace_id: string;
  type: string;
  params_json: string;
  state_json: string;
  binds_callback_to: string | null;
  binds_callback_to_recipe: string | null;
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

export interface RunRecipeBindingArgs {
  recipeId: string;
  prompt: string;
  params: Record<string, unknown>;
  workspaceInfo: { id: string; path: string };
  triggerId: string;
  fireId: string;
}

export interface RunRecipeBindingResult {
  recipe_instance_id: string;
  agent_session_id?: string;
}

export interface DispatcherOptions {
  maxConcurrent?: number;
  drainMs?: number;
  /** Override callback URL base (default `http://127.0.0.1:5201`). */
  callbackUrlBase?: string;
  /** Hard timeout for script binding (default 60s). */
  scriptTimeoutMs?: number;
  /** Test hook — fake the recipe binding without spawning a real CLI. */
  runRecipeFn?: (args: RunRecipeBindingArgs) => Promise<RunRecipeBindingResult>;
}

export class Dispatcher {
  private db: Database;
  private ws: Workspace;
  private maxConcurrent: number;
  private drainMs: number;
  private callbackUrlBase: string;
  private scriptTimeoutMs: number;
  private inFlight = new Set<string>();
  private stopped = false;
  private runRecipeFn: ((args: RunRecipeBindingArgs) => Promise<RunRecipeBindingResult>) | null;

  constructor(db: Database, ws: Workspace, opts: DispatcherOptions = {}) {
    this.db = db;
    this.ws = ws;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.drainMs = opts.drainMs ?? 15_000;
    this.callbackUrlBase = opts.callbackUrlBase ?? 'http://127.0.0.1:5201';
    this.scriptTimeoutMs = opts.scriptTimeoutMs ?? 60_000;
    this.runRecipeFn = opts.runRecipeFn ?? null;
  }

  start(): void {
    this.stopped = false;
    this.pickUp();
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
      const bindsToRecipe = trigger.binds_callback_to_recipe
        ?? typeManifest?.binds_callback_to_recipe
        ?? null;
      const bindsTo = trigger.binds_callback_to
        ?? typeManifest?.binds_callback_to
        ?? null;

      let result: { recipe_instance_id?: string; agent_session_id?: string; exit_code?: number | null };

      if (bindsToRecipe) {
        result = await this.runRecipeBinding(fire, trigger, wsRow, bindsToRecipe);
      } else if (bindsTo === 'agent_session_resume') {
        throw new Error('agent_session_resume_not_implemented');
      } else {
        result = await this.runScriptBinding(fire, trigger, outDir, typeManifest);
      }

      markFireSuccess(this.db, fire.fire_id, {
        duration_ms: Date.now() - startedAt,
        exit_code: result.exit_code ?? 0,
        recipe_instance_id: result.recipe_instance_id,
        agent_session_id: result.agent_session_id,
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

  // ------------------------------------------------------------------ bindings

  private async runRecipeBinding(
    fire: FireRow,
    trigger: TriggerRow,
    wsRow: WorkspaceRowLite,
    recipeId: string,
  ): Promise<{ recipe_instance_id: string; agent_session_id?: string; exit_code: number }> {
    const params = {
      ...(JSON.parse(trigger.params_json) as Record<string, unknown>),
      ...((fire.payload_json ? JSON.parse(fire.payload_json) : {}) as Record<string, unknown>),
      _trigger_state: JSON.parse(trigger.state_json) as Record<string, unknown>,
    };
    const payload = fire.payload_json ? JSON.parse(fire.payload_json) : null;
    const prompt = `Triggered by ${trigger.id} at ${new Date(fire.scheduled_at).toISOString()}.\nPayload: ${JSON.stringify(payload)}`;

    if (this.runRecipeFn) {
      const out = await this.runRecipeFn({
        recipeId,
        prompt,
        params,
        workspaceInfo: { id: wsRow.id, path: wsRow.path },
        triggerId: trigger.id,
        fireId: fire.fire_id,
      });
      return {
        recipe_instance_id: out.recipe_instance_id,
        agent_session_id: out.agent_session_id,
        exit_code: 0,
      };
    }

    // Production path — resolve the recipe via the scope chain and call
    // the real recipe-runner. The agent CLI is detached (pty.spawn): we
    // return as soon as the spawn returns a pid, while the agent runs to
    // completion in the background. The fire row carries the
    // recipe_instance_id forward so the SPA can stitch the lineage.
    const hit = resolveRead(this.ws, 'all', 'recipe', recipeId, recipePath);
    if (!hit) throw new Error(`recipe not found: ${recipeId}`);
    const workspacesRoot = resolveWorkspacesRoot();
    const out = await runRecipe({
      recipeId,
      recipeSnapshot: hit.source,
      isAdhoc: false,
      prompt,
      params,
      workspaceInfo: { id: wsRow.id, path: wsRow.path },
      triggerId: trigger.id,
      fireId: fire.fire_id,
      workspacesRoot,
    });
    if (out.spawn_error) {
      throw new Error(`${out.spawn_error.code}: ${out.spawn_error.message}`);
    }

    // Find the auto-created agent_session row so we can record it on the fire.
    const session = this.db
      .prepare(
        `SELECT id FROM agent_sessions WHERE recipe_instance_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(out.recipe_instance_id) as { id: string } | undefined;

    return {
      recipe_instance_id: out.recipe_instance_id,
      agent_session_id: session?.id,
      exit_code: 0,
    };
  }

  private async runScriptBinding(
    fire: FireRow,
    trigger: TriggerRow,
    outDir: string,
    typeManifest: RegisteredTriggerType | null,
  ): Promise<{ exit_code: number }> {
    if (!typeManifest) throw new Error(`trigger type not found: ${trigger.type}`);
    const runtime = ((typeManifest as unknown as { runtime?: TriggerRuntime }).runtime ?? 'tsx') as TriggerRuntime;
    const callbackSecret = randomBytes(16).toString('hex');
    const callbackUrl = `${this.callbackUrlBase}/callback/${fire.fire_id}`;

    const state = (JSON.parse(trigger.state_json) as Record<string, unknown>) || {};
    delete (state as Record<string, unknown>).__subscriber_thread_id;
    const payload = fire.payload_json ? JSON.parse(fire.payload_json) : null;

    const result = await runTriggerScript({
      scriptPath: typeManifest.file_abs,
      runtime,
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: trigger.id,
        run_id: fire.fire_id,
        callback_url: callbackUrl,
        state,
        payload,
      },
      callbackSecret,
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

    // Mode A callback extraction. Mode B captures land in /callback/* (Phase 8).
    const callbacks: Array<{ mode: 'A' | 'B'; body: unknown; received_at: number }> = [];
    const parsed = result.stdout_parsed as
      | { callback?: { body?: unknown }; state?: unknown }
      | null;
    if (parsed && parsed.callback && typeof parsed.callback === 'object') {
      callbacks.push({
        mode: 'A',
        body: (parsed.callback as { body?: unknown }).body ?? null,
        received_at: Date.now(),
      });
    }
    try {
      writeFileSync(join(outDir, 'callbacks.json'), JSON.stringify(callbacks, null, 2));
    } catch {
      /* best-effort */
    }

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
