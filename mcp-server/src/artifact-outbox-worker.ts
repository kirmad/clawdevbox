/**
 * artifact-outbox-worker.ts
 *
 * Background delivery worker for the durable artifact outbox (migration v12,
 * see `db/artifact-outbox-store.ts`).
 *
 * Why this exists — the browser POST that queues a message must return
 * INSTANTLY (the user is typing a comment / question and must never watch a
 * frozen button). But actually delivering the message to the agent is slow
 * and failure-prone:
 *   - the session may be CLOSED → it has to be resumed/spawned first;
 *   - the agent may be MID-TURN → we wait for it to be idle so the prompt
 *     isn't absorbed;
 *   - any of those steps can fail transiently.
 *
 * So the POST just enqueues, and this worker drains the queue:
 *   claim → spawnDispatchOrResume (resume/spawn if needed, then dispatch) →
 *   mark sent | retry-with-backoff | fail.
 *
 * Recovery:
 *   - On start, `resetStuckSending` re-queues anything left 'sending' by a
 *     crash so no message is silently dropped.
 *   - Failed deliveries retry with exponential backoff up to `max_attempts`.
 *   - Each message is isolated in its own try/catch so one poison message
 *     can't wedge the queue.
 *
 * Kept intentionally similar in shape to `idle-reaper.ts`
 * (`start… → { stop, runOnce }`, interval + overlap guard) so the two
 * background loops read the same way.
 */

import { logger } from './logger.ts';
import { emitQaChange } from './event-bus.ts';
import type { SessionHelperCtx } from './session-helpers.ts';
import {
  claimNextOutbox,
  markFailed,
  markRetry,
  markSent,
  resetStuckSending,
} from './db/artifact-outbox-store.ts';

export interface ArtifactOutboxWorkerOpts {
  /** Idle poll interval when the queue is empty (default 2500ms). */
  intervalMs?: number;
  /** Max rows to deliver per tick, so one busy artifact can't starve others (default 5). */
  batchPerTick?: number;
  /** Backoff base for retries (default 3000ms). */
  backoffBaseMs?: number;
  /** Backoff ceiling (default 60_000ms). */
  backoffCapMs?: number;
  /** How long a row may sit in 'sending' before it's reclaimed (default 5min). */
  stuckReclaimMs?: number;
  /** Test seam — override the dispatch call. */
  deliver?: (
    ctx: SessionHelperCtx,
    row: { prompt: string; session_id: string | null; workspace_id: string | null; workspace_path: string | null },
  ) => Promise<{ ok: true; instance_id: string } | { ok: false; message: string }>;
}

export interface ArtifactOutboxWorkerHandle {
  /** Stop the periodic timer. Idempotent. */
  stop(): void;
  /** Run one drain pass now (returns number delivered). For tests + `kick()`. */
  runOnce(): Promise<number>;
  /** Nudge the worker to drain very soon (called right after an enqueue). */
  kick(): void;
}

function backoff(attempts: number, baseMs: number, capMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(raw, capMs);
  // ±20% jitter so a burst of failures doesn't retry in lockstep.
  const jitter = capped * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

async function defaultDeliver(
  ctx: SessionHelperCtx,
  row: { prompt: string; session_id: string | null; workspace_id: string | null; workspace_path: string | null },
): Promise<{ ok: true; instance_id: string } | { ok: false; message: string }> {
  const { spawnDispatchOrResume } = await import('./session-helpers.ts');
  const result = await spawnDispatchOrResume(ctx, {
    prompt: row.prompt,
    session_id: row.session_id,
    provider: null,
    agent: null,
    model: null,
    workspace_id: row.workspace_id && row.workspace_id !== 'project' ? row.workspace_id : null,
    workspace_path: row.workspace_path,
    default_workspace_path: null,
    fire_id: null,
  });
  if (result.ok) return { ok: true, instance_id: result.instance_id };
  return { ok: false, message: `${result.code}: ${result.message}` };
}

export function startArtifactOutboxWorker(
  ctx: SessionHelperCtx,
  opts: ArtifactOutboxWorkerOpts = {},
): ArtifactOutboxWorkerHandle {
  const intervalMs = opts.intervalMs ?? 2500;
  const batchPerTick = opts.batchPerTick ?? 5;
  const backoffBaseMs = opts.backoffBaseMs ?? 3000;
  const backoffCapMs = opts.backoffCapMs ?? 60_000;
  const deliver = opts.deliver ?? defaultDeliver;
  // A row that has been 'sending' this long is wedged (a delivery that never
  // resolved, or a crash that predated a restart). Reclaim it for another
  // attempt. Must comfortably exceed a real delivery (spawn/resume + wait-for-
  // idle is seconds, not minutes), so a genuinely in-flight delivery is never
  // stolen.
  const stuckReclaimMs = opts.stuckReclaimMs ?? 5 * 60_000;

  let stopped = false;
  let running = false;
  let kickQueued = false;

  // Crash recovery — re-queue anything a previous run left mid-flight.
  try {
    const reset = resetStuckSending(ctx.db);
    if (reset > 0) logger.info({ reset }, 'artifact-outbox: re-queued stuck sending rows on start');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'artifact-outbox: startup recovery failed (non-fatal)',
    );
  }

  async function deliverOne(row: {
    id: string;
    artifact_id: string;
    prompt: string;
    session_id: string | null;
    workspace_id: string | null;
    workspace_path: string | null;
    attempts: number;
    max_attempts: number;
  }): Promise<boolean> {
    try {
      const res = await deliver(ctx, row);
      if (res.ok) {
        markSent(ctx.db, row.id, res.instance_id);
        // Nudge any live SSE viewers of this artifact to refresh delivery state.
        try { emitQaChange(row.artifact_id); } catch { /* best effort */ }
        logger.info(
          { id: row.id, artifact_id: row.artifact_id, instance_id: res.instance_id, attempts: row.attempts },
          'artifact-outbox: delivered',
        );
        return true;
      }
      handleFailure(row, res.message);
      return false;
    } catch (err) {
      handleFailure(row, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  function handleFailure(
    row: { id: string; artifact_id: string; attempts: number; max_attempts: number },
    message: string,
  ): void {
    if (row.attempts >= row.max_attempts) {
      markFailed(ctx.db, row.id, message);
      try { emitQaChange(row.artifact_id); } catch { /* best effort */ }
      logger.warn(
        { id: row.id, artifact_id: row.artifact_id, attempts: row.attempts, err: message },
        'artifact-outbox: delivery failed permanently (out of attempts)',
      );
      return;
    }
    const delay = backoff(row.attempts, backoffBaseMs, backoffCapMs);
    markRetry(ctx.db, row.id, message, Date.now() + delay);
    logger.info(
      { id: row.id, artifact_id: row.artifact_id, attempts: row.attempts, retry_in_ms: delay, err: message },
      'artifact-outbox: delivery failed, will retry',
    );
  }

  async function tick(): Promise<number> {
    if (running) return 0; // overlap guard — a slow dispatch on the previous tick
    running = true;
    let delivered = 0;
    try {
      // Belt-and-suspenders: reclaim any row wedged in 'sending' far longer
      // than a real delivery takes, so nothing is stranded between restarts.
      try {
        const reclaimed = resetStuckSending(ctx.db, stuckReclaimMs);
        if (reclaimed > 0) logger.info({ reclaimed }, 'artifact-outbox: reclaimed wedged sending rows');
      } catch { /* non-fatal — the claim loop below still runs */ }

      for (let i = 0; i < batchPerTick; i++) {
        if (stopped) break;
        const row = claimNextOutbox(ctx.db);
        if (!row) break; // queue drained
        const ok = await deliverOne(row);
        if (ok) delivered++;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'artifact-outbox: tick threw (non-fatal)',
      );
    } finally {
      running = false;
    }
    return delivered;
  }

  const timer = setInterval(() => { void tick(); }, intervalMs);
  // Don't hold the event loop open on this timer alone.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runOnce() {
      return tick();
    },
    kick() {
      // Coalesce bursts of kicks into a single near-immediate drain.
      if (kickQueued) return;
      kickQueued = true;
      setTimeout(() => { kickQueued = false; void tick(); }, 10);
    },
  };
}
