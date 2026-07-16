/**
 * lane-dispatch-worker.ts
 *
 * Server worker-loop that routes ready recipe steps to their lane's session.
 * For each running recipe instance, per tick, it finds the lanes that are
 * "actionable" (≥1 ready step AND no in-flight step in that lane — a busy lane
 * advances itself via update_status.next_steps) and dispatches them:
 *
 *   - lane already has a recorded session → wake it (resume/dispatch a prompt),
 *   - lane is `main` with no recorded session → adopt the instance's initial
 *     interactive console (record + wake), or
 *   - any other lane with no recorded session → spawn a fresh interactive
 *     console (record the returned cli session id).
 *
 * All spawn/wake is injectable (opts hatches) so the loop is unit-testable.
 * Mirrors recipe-validation-worker.ts's structure: single scan per tick, an
 * overlap guard (`running`), a `stopped` flag, and an `unref`'d interval.
 * Task 8 supplies the real spawn/wake deps and wires this into start.ts.
 */

import type { Database } from 'better-sqlite3';
import { listSteps, computeReadySteps, normalizeExecution, resolveLane, type ReadyStep } from './db/recipe-steps-store.ts';
import { getLaneSession, upsertLaneSession } from './db/lane-sessions-store.ts';
import { runRecipe } from './recipe-runner.ts';
import { spawnDispatchOrResume, type SessionHelperCtx } from './session-helpers.ts';
import { logger } from './logger.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';

export interface LaneDispatchWorkerOpts {
  db: Database;
  /** Spawn a fresh interactive console for a non-main lane. Returns its cli session id. */
  spawnLaneSession: (args: {
    recipeInstanceId: string; lane: string; workspaceId: string; workspacePath: string;
    provider?: string; agent?: string; model?: string; prompt: string;
  }) => Promise<{ cliSessionId: string }>;
  /** Resume/dispatch an existing lane session (incl. the initial 'main' console) with a prompt. */
  wakeLaneSession: (args: { recipeInstanceId: string; lane: string; cliSessionId: string; prompt: string }) => Promise<void>;
  intervalMs?: number;
}

export interface LaneDispatchWorkerHandle { stop(): void; runOnce(): Promise<void>; }

interface InstanceRow { id: string; workspace_id: string; workspace_path: string; session_id: string | null; }

const IN_FLIGHT = new Set(['running', 'validating', 'awaiting_user']);

function laneRolePrompt(lane: string, recipeInstanceId: string, workspacePath: string, ready: { step_id: string; goal: string; ai_instructions?: string }[]): string {
  const head = lane === 'main'
    ? `▶ Lane "main" of recipe ${recipeInstanceId} has newly-ready step(s). Continue driving them with recipe.steps.update_status.`
    : `You own lane "${lane}" of recipe instance ${recipeInstanceId} (workspace ${workspacePath}). Drive ONLY lane "${lane}" steps, in depends order, via recipe.steps.update_status. Steps in other lanes run on other consoles — do not touch them. When your lane has no ready step, stop; you'll be resumed.`;
  const body = ready.map((s) => `▶ NEXT STEP: ${s.step_id}\n  Goal: ${s.goal}${s.ai_instructions ? `\n  Instructions: ${s.ai_instructions}` : ''}`).join('\n\n');
  return `${head}\n\n${body}`;
}

export function startLaneDispatchWorker(opts: LaneDispatchWorkerOpts): LaneDispatchWorkerHandle {
  const intervalMs = opts.intervalMs ?? 15_000;
  let stopped = false;
  let running = false;
  const lastDispatched = new Map<string, string>(); // `${instanceId}:${lane}` -> sorted ready step_ids

  async function handleInstance(inst: InstanceRow): Promise<void> {
    const all = listSteps(opts.db, inst.id);
    const ready = computeReadySteps(opts.db, inst.id);
    if (ready.length === 0) return;

    const inFlightLanes = new Set<string>();
    for (const s of all) {
      if (!IN_FLIGHT.has(s.status)) continue;
      const exec = s.execution_json ? normalizeExecution(JSON.parse(s.execution_json)) : null;
      inFlightLanes.add(resolveLane(exec, s.step_id));
    }

    const byLane = new Map<string, ReadyStep[]>();
    for (const r of ready) {
      let arr = byLane.get(r.lane);
      if (!arr) { arr = []; byLane.set(r.lane, arr); }
      arr.push(r);
    }

    for (const [lane, laneReady] of byLane) {
      if (inFlightLanes.has(lane)) continue;
      try {
        const sig = laneReady.map((r) => r.step_id).sort().join(',');
        const key = `${inst.id}:${lane}`;
        if (lastDispatched.get(key) === sig) continue; // already dispatched this exact ready-set; wait for the lane to pick it up or for the set to change
        const prompt = laneRolePrompt(lane, inst.id, inst.workspace_path, laneReady);
        const existing = getLaneSession(opts.db, inst.id, lane);
        if (existing?.cli_session_id) {
          await opts.wakeLaneSession({ recipeInstanceId: inst.id, lane, cliSessionId: existing.cli_session_id, prompt });
          lastDispatched.set(key, sig);
          continue;
        }
        if (lane === 'main') {
          const sid = inst.session_id;
          if (sid) {
            upsertLaneSession(opts.db, { recipe_instance_id: inst.id, lane: 'main', cli_session_id: sid, status: 'live' });
            await opts.wakeLaneSession({ recipeInstanceId: inst.id, lane, cliSessionId: sid, prompt });
            lastDispatched.set(key, sig);
          }
          continue;
        }
        const firstRow = all.find((s) => s.step_id === laneReady[0].step_id);
        const exec = firstRow?.execution_json ? normalizeExecution(JSON.parse(firstRow.execution_json)) : null;
        const { cliSessionId } = await opts.spawnLaneSession({
          recipeInstanceId: inst.id, lane, workspaceId: inst.workspace_id, workspacePath: inst.workspace_path,
          provider: exec?.provider, agent: exec?.agent, model: exec?.model, prompt,
        });
        upsertLaneSession(opts.db, { recipe_instance_id: inst.id, lane, cli_session_id: cliSessionId, status: 'live' });
        lastDispatched.set(key, sig);
      } catch (err) {
        logger.warn({ err: String(err), instance: inst.id, lane }, 'lane-dispatch: lane dispatch failed');
      }
    }
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      // recipe_instances has no session_id column; the "initial" console is the
      // earliest interactive agent_sessions row for the instance.
      const instances = opts.db.prepare(
        `SELECT ri.id, ri.workspace_id, ri.workspace_path,
                (SELECT s.cli_session_id FROM agent_sessions s
                  WHERE s.recipe_instance_id = ri.id AND s.interactive = 1 AND s.cli_session_id IS NOT NULL
                  ORDER BY s.started_at ASC LIMIT 1) AS session_id
           FROM recipe_instances ri
          WHERE ri.status = 'running'`,
      ).all() as InstanceRow[];
      // Prune re-dispatch-guard entries for instances no longer running (keeps
      // the in-memory map bounded on a long-lived server). Instance ids contain
      // no ':', so the first colon reliably separates id from lane.
      const runningIds = new Set(instances.map((i) => i.id));
      for (const key of lastDispatched.keys()) {
        if (!runningIds.has(key.slice(0, key.indexOf(':')))) lastDispatched.delete(key);
      }
      for (const inst of instances) {
        if (stopped) break;
        try {
          await handleInstance(inst);
        } catch (err) {
          logger.warn({ err: String(err), instance: inst.id }, 'lane-dispatch: instance tick failed');
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch((err) => logger.warn({ err: String(err) }, 'lane-dispatch: tick threw'));
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  logger.info({ intervalMs }, 'lane-dispatch-worker: started');

  return { stop() { stopped = true; clearInterval(timer); }, async runOnce() { await tick(); } };
}

// ── real injected deps (server wiring) ───────────────────────────────────────

/** Server context the real lane-dispatch-worker deps bind to. */
export interface LaneDispatchWorkerDepsCtx {
  db: Database;
  dispatcher: Dispatcher;
  ws: Workspace;
  cfg: ResolvedConfig;
  workspacesRoot: string;
}

/**
 * Build the REAL injected deps for `startLaneDispatchWorker`, bound to a
 * running server's context. Supplies the two hatches the loop needs:
 *   - spawnLaneSession: spawn a fresh INTERACTIVE console for a non-main lane
 *                       via `runRecipe` (ad-hoc, keeps its pty alive), tagging
 *                       it with the recipe instance + lane via extraEnv, and
 *                       returns the new cli session id to record.
 *   - wakeLaneSession:  wake an existing lane session (incl. the initial 'main'
 *                       console): dispatch if its pty is live, resume if it's
 *                       archived/idle — `spawnDispatchOrResume` is the codebase
 *                       primitive that routes exactly this way.
 * The loop logic itself is unchanged — this only ADDS the real deps.
 */
export function defaultLaneDispatchWorkerDeps(ctx: LaneDispatchWorkerDepsCtx): LaneDispatchWorkerOpts {
  const { db } = ctx;

  const spawnLaneSession: LaneDispatchWorkerOpts['spawnLaneSession'] = async (a) => {
    const result = await runRecipe({
      recipeId: null, recipeSnapshot: '', isAdhoc: true, prompt: a.prompt, spawnMode: 'interactive',
      agentCli: a.provider ?? ctx.cfg.defaultAgentCli ?? 'copilot', agent: a.agent, model: a.model,
      workspaceInfo: { id: a.workspaceId, path: a.workspacePath }, workspacesRoot: ctx.workspacesRoot,
      ws: ctx.ws, cfg: ctx.cfg,
      extraEnv: { CLAWDEVBOX_RECIPE_INSTANCE_ID: a.recipeInstanceId, CLAWDEVBOX_RECIPE_LANE: a.lane },
    });
    if (result.spawn_error) {
      throw new Error(`lane '${a.lane}' spawn failed: ${result.spawn_error.code} ${result.spawn_error.message}`);
    }
    return { cliSessionId: result.session_id };
  };

  const wakeLaneSession: LaneDispatchWorkerOpts['wakeLaneSession'] = async (a) => {
    const shCtx: SessionHelperCtx = { db, dispatcher: ctx.dispatcher, ws: ctx.ws, cfg: ctx.cfg };
    const res = await spawnDispatchOrResume(shCtx, {
      session_id: a.cliSessionId, prompt: a.prompt, provider: ctx.cfg.defaultAgentCli,
    });
    if (res.ok === false) {
      // Throw (symmetric with spawnLaneSession's spawn_error throw) so the caller's
      // per-lane catch fires and the re-dispatch guard is NOT recorded — otherwise a
      // failed wake would set the guard on an un-driven ready-set and stall the lane
      // permanently. Throwing leaves the guard unset → the lane is retried next tick.
      throw new Error(`lane '${a.lane}' wake failed: ${res.code}`);
    }
  };

  return { db, spawnLaneSession, wakeLaneSession };
}
