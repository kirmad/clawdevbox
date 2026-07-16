/**
 * idle-reaper.ts
 *
 * Periodically reaps tmux-backed agent sessions that have sat idle with
 * no viewer attached for longer than the configured timeout. Keeps long-
 * running clawdevbox installations from accumulating zombie copilot /
 * agency processes when /spawn'd agents finish their work but nobody
 * closes the tab.
 *
 * Reap policy (see `shouldReap` for the pure decision function):
 *   - Session must be tmux-backed (in tmuxSessionRegistry) AND alive.
 *   - Skip `instance_id === 'main'` — the long-lived bootstrap agent.
 *   - `derived_state` MUST be 'idle' (from copilot-events.ts). NULL means
 *     the agent never reached a classifiable event (still booting) and is
 *     NOT reaped.
 *   - `derived_state_at` must be older than `idleTimeoutMs`.
 *   - `tmux list-clients` must return zero attached clients.
 *
 * When reaped, kills the tmux session via `tmuxSessionRegistry.get(id).kill()`
 * AND marks the agent_sessions row with `end_reason='idle_reaped'`.
 *
 * Designed to be cheap: one DB query per tick + at most one
 * `tmux list-clients` spawn per candidate (rarely > 0-1 per tick in
 * practice). Default 60s tick.
 */

import type { Database } from 'better-sqlite3';
import { logger } from './logger.ts';
import { markSessionEnded } from './db/agent-sessions-store.ts';
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';
import type { TmuxClientOpts } from './cli-sessions/tmux-client.ts';
import { viewerCountForInstance } from './terminal-server.ts';

export const MAIN_AGENT_INSTANCE_ID = 'main';

export interface IdleReaperOpts {
  db: Database;
  /**
   * tmux client opts — retained for forward-compat (e.g. a future
   * implementation might consult tmux for client info on a non-psmux
   * tmux), but no longer used by the default viewer-counter. Pass to
   * keep the call-site shape stable across versions.
   */
  tmuxClient?: TmuxClientOpts;
  /** Tick interval (default 60_000 = 1 min). */
  intervalMs?: number;
  /** How long a session must sit idle before reaping (default 900_000 = 15 min). */
  idleTimeoutMs?: number;
  /** Test hatch: override kill (default uses tmuxSessionRegistry). */
  killSession?: (instanceId: string) => Promise<void>;
  /** Test hatch: override viewer count (default uses terminal-server's WS count). */
  countAttachedViewers?: (instanceId: string) => Promise<number>;
}

export interface IdleReaperHandle {
  /** Stop the periodic timer. Idempotent. */
  stop(): void;
  /** Run one tick immediately (returns the number of sessions reaped). For tests + diagnostics. */
  runOnce(): Promise<number>;
}

/**
 * Pure policy decision: should this row be reaped right now?
 *
 * Kept separate from I/O so it can be unit-tested without DB or tmux.
 */
export function shouldReap(args: {
  instanceId: string;
  derivedState: string | null;
  derivedStateAt: number | null;
  attachedViewers: number;
  now: number;
  idleTimeoutMs: number;
}): boolean {
  if (args.instanceId === MAIN_AGENT_INSTANCE_ID) return false;
  if (args.derivedState !== 'idle') return false;
  if (args.derivedStateAt == null) return false;
  if (args.now - args.derivedStateAt < args.idleTimeoutMs) return false;
  if (args.attachedViewers > 0) return false;
  return true;
}

interface CandidateRow {
  recipe_instance_id: string;
  derived_state: string | null;
  derived_state_at: number | null;
}

/**
 * Default viewer-counter — returns the live count of attached viewer
 * WebSockets for this instance, tracked by terminal-server.ts.
 *
 * We deliberately do NOT consult `tmux list-clients`: on psmux (Windows)
 * `tmux list-clients` ALWAYS reports a phantom `/dev/pts/0` client even
 * on a never-attached session. terminal-server's in-memory count is the
 * authoritative "are real human viewers connected" signal.
 */
function defaultCountViewers(instanceId: string): Promise<number> {
  return Promise.resolve(viewerCountForInstance(instanceId));
}

async function defaultKill(instanceId: string): Promise<void> {
  const sess = tmuxSessionRegistry.get(instanceId);
  if (!sess) return;
  await sess.kill();
}

export function startIdleReaper(opts: IdleReaperOpts): IdleReaperHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 15 * 60 * 1000;
  const killSession = opts.killSession ?? defaultKill;
  const countAttachedViewers =
    opts.countAttachedViewers ?? defaultCountViewers;

  let stopped = false;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;          // overlap guard — slow tmux on a previous tick
    running = true;
    try {
      const now = Date.now();
      const cutoff = now - idleTimeoutMs;

      // Pick the set of candidates in ONE indexed query. ended_at IS NULL
      // skips already-closed rows; derived_state='idle' skips active agents;
      // derived_state_at < cutoff means at least idleTimeoutMs old.
      const candidates = opts.db.prepare(
        `SELECT recipe_instance_id, derived_state, derived_state_at
         FROM agent_sessions
         WHERE ended_at IS NULL
           AND derived_state = 'idle'
           AND derived_state_at IS NOT NULL
           AND derived_state_at < ?
           AND recipe_instance_id IS NOT NULL
           AND recipe_instance_id != ?`,
      ).all(cutoff, MAIN_AGENT_INSTANCE_ID) as CandidateRow[];

      logger.debug({ candidates: candidates.length, cutoff },
        'idle-reaper: tick scan');

      if (candidates.length === 0) return 0;

      let reaped = 0;
      for (const c of candidates) {
        if (stopped) break;
        const instanceId = c.recipe_instance_id;
        // Re-check viewer count immediately before kill (a viewer may have
        // just attached between the DB scan and the decision).
        const viewers = await countAttachedViewers(instanceId);
        const reap = shouldReap({
          instanceId,
          derivedState: c.derived_state,
          derivedStateAt: c.derived_state_at,
          attachedViewers: viewers,
          now: Date.now(),
          idleTimeoutMs,
        });
        if (!reap) continue;
        try {
          // Mark BEFORE kill — the SSE 'sessions' emit downstream guarantees
          // UI updates even if the kill itself fails for some reason.
          markSessionEnded(opts.db, instanceId, 'idle_reaped', Date.now());
          await killSession(instanceId);
          reaped += 1;
          logger.info(
            { instanceId, idleForMs: Date.now() - (c.derived_state_at ?? Date.now()) },
            'idle-reaper: reaped session',
          );
        } catch (err) {
          logger.warn(
            { err: String(err), instanceId },
            'idle-reaper: kill failed (session may already be gone)',
          );
        }
      }
      return reaped;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick().then(
      (n) => {
        if (n > 0) logger.info({ reaped: n }, 'idle-reaper: tick complete');
      },
      (err) => logger.warn({ err: String(err) }, 'idle-reaper: tick threw'),
    );
  }, intervalMs);
  // Don't keep the event loop alive purely for the reaper.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  logger.info({ intervalMs, idleTimeoutMs },
    'idle-reaper: started');

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    runOnce(): Promise<number> {
      return tick();
    },
  };
}
