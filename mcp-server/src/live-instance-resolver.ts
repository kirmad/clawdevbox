/**
 * live-instance-resolver.ts
 *
 * Single source of truth for "given a CLI conversation (`cli_session_id`),
 * which recipe-instance currently has a LIVE terminal for it?"
 *
 * Why this exists: one logical CLI conversation (identified by its stable
 * `cli_session_id` GUID) can be embodied by several `agent_sessions` rows
 * over time — the original run plus every `--resume` of it. Each embodiment
 * gets its own `recipe_instance_id` (and its own `cdb_<instance_id>` tmux
 * session). Callers that only know an OLD instance id (e.g. an inbox item
 * linked to a recipe that has since been resumed) must be able to find the
 * instance that is alive RIGHT NOW so they attach to the live terminal
 * instead of a dead one — or worse, spawn a duplicate.
 *
 * **tmux is the source of truth.** A session is live iff its
 * `cdb_<recipe_instance_id>` tmux session exists right now. The DB `status`
 * column can drift across crashes / restarts / idle-reaper races; tmux
 * cannot lie. When we discover a live tmux session that isn't yet in the
 * in-memory registry we adopt it, and we self-heal a stale DB row.
 *
 * Previously this logic lived only as `Dispatcher.findLiveInstanceForSession`
 * plus an inline near-duplicate in terminal-server; both now delegate here.
 */

import type { Database } from 'better-sqlite3';
import { logger } from './logger.ts';

/**
 * Resolve the newest LIVE recipe-instance id for a CLI conversation.
 *
 * @param db            open database handle
 * @param cliSessionId  the stable `cli_session_id` GUID of the conversation
 * @returns the live instance id, or null if no embodiment is currently alive
 */
export async function resolveLiveInstanceForSession(
  db: Database,
  cliSessionId: string,
): Promise<string | null> {
  type Row = { recipe_instance_id: string };
  // All interactive agent_sessions rows for this conversation, newest first.
  // We include rows the DB thinks are dead — tmux is the final arbiter.
  // Headless (interactive=0) rows never get a tmux session so they're
  // excluded up front.
  const rows = db
    .prepare(
      `SELECT recipe_instance_id FROM agent_sessions
       WHERE cli_session_id = ? AND interactive = 1
         AND recipe_instance_id IS NOT NULL
       ORDER BY started_at DESC LIMIT 20`,
    )
    .all(cliSessionId) as Row[];
  if (rows.length === 0) return null;

  const { isSessionLive } = await import('./pty-registry.ts');
  const { tmuxSessionRegistry, tmuxSessionRuntime } =
    await import('./cli-sessions/tmux-session-runtime.ts');

  // Fast path: in-memory registry hit (zero IPC). Covers legacy IPty
  // (pty-registry) and tmux sessions registered this process lifetime.
  for (const r of rows) {
    if (isSessionLive(r.recipe_instance_id)) return r.recipe_instance_id;
    if (tmuxSessionRegistry.get(r.recipe_instance_id)) return r.recipe_instance_id;
  }

  // Slow path: ask tmux directly. The runtime's 1s list cache coalesces
  // concurrent probes so the cost stays bounded.
  let live: Array<{ name: string; alive: boolean }>;
  try {
    live = await tmuxSessionRuntime().list();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), cli_session_id: cliSessionId },
      'resolveLiveInstanceForSession: tmux list failed; assuming no live tmux session',
    );
    return null;
  }
  for (const r of rows) {
    const tmuxName = `cdb_${r.recipe_instance_id}`;
    const hit = live.find((s) => s.name === tmuxName && s.alive);
    if (!hit) continue;
    // Adopt the discovered tmux session so subsequent lookups + dispatch
    // hit the fast path and have a CliSession handle.
    if (!tmuxSessionRegistry.get(r.recipe_instance_id)) {
      try {
        const session = await tmuxSessionRuntime().attach(r.recipe_instance_id);
        if (session) tmuxSessionRegistry.register(r.recipe_instance_id, session);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), instance_id: r.recipe_instance_id },
          'resolveLiveInstanceForSession: tmux adopt failed (continuing)',
        );
      }
    }
    // Self-heal a stale DB row: tmux says alive, DB said otherwise.
    try {
      db.prepare(
        `UPDATE agent_sessions
           SET status = 'running', ended_at = NULL, end_reason = NULL
         WHERE recipe_instance_id = ? AND status != 'running'`,
      ).run(r.recipe_instance_id);
    } catch { /* non-fatal */ }
    return r.recipe_instance_id;
  }
  return null;
}

/**
 * Convenience: resolve the live instance for the conversation that a given
 * (possibly dead) instance id belongs to. Looks up the instance's
 * `cli_session_id`, then delegates to `resolveLiveInstanceForSession`.
 *
 * Returns null when the instance has no cli_session_id on record or no
 * embodiment of its conversation is currently alive.
 */
export async function resolveLiveInstanceForInstance(
  db: Database,
  instanceId: string,
): Promise<{ liveInstanceId: string; cliSessionId: string } | null> {
  const row = db
    .prepare(
      `SELECT cli_session_id FROM agent_sessions
       WHERE recipe_instance_id = ? OR id = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(instanceId, instanceId) as { cli_session_id: string | null } | undefined;
  if (!row?.cli_session_id) return null;
  const liveInstanceId = await resolveLiveInstanceForSession(db, row.cli_session_id);
  if (!liveInstanceId) return null;
  return { liveInstanceId, cliSessionId: row.cli_session_id };
}
