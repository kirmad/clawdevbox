/**
 * agent_sessions store — open / close / resume tracking for agent-CLI runs.
 *
 * Each row represents a single agent-CLI process (Copilot, Claude, …).
 * Sessions are bound to a workspace and optionally to a recipe instance and
 * a specific step. `resume_of_agent_session_id` chains a resumed session
 * back to its predecessor — `findResumeTarget` returns the latest
 * suspended/terminal row for a step so Phase 2 can pick up where it left
 * off.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { emitChange } from '../event-bus.ts';

export type AgentSessionStatus =
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'suspended';

export interface AgentSessionRow {
  id: string;
  cli_session_id: string | null;
  recipe_instance_id: string | null;
  recipe_step_id: string | null;
  workspace_id: string;
  agent_cli: string;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
  status: AgentSessionStatus;
  result: string | null;
  error: string | null;
  resume_of_agent_session_id: string | null;
  interactive: number;
  status_text: string | null;
  needs_user_input: number;
  last_status_at: number | null;
}

export function mintSessionId(): string {
  return `as_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function openSession(
  db: Database,
  opts: {
    workspace_id: string;
    recipe_instance_id?: string;
    recipe_step_id?: string;
    agent_cli: string;
    pid?: number;
    cli_session_id?: string;
    interactive?: boolean;
    resume_of_agent_session_id?: string;
  },
): AgentSessionRow {
  const id = mintSessionId();
  const started_at = Date.now();
  db.prepare(
    `INSERT INTO agent_sessions (
       id, cli_session_id, recipe_instance_id, recipe_step_id, workspace_id,
       agent_cli, pid, started_at, status, resume_of_agent_session_id, interactive
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    id,
    opts.cli_session_id ?? null,
    opts.recipe_instance_id ?? null,
    opts.recipe_step_id ?? null,
    opts.workspace_id,
    opts.agent_cli,
    opts.pid ?? null,
    started_at,
    opts.resume_of_agent_session_id ?? null,
    opts.interactive ? 1 : 0,
  );
  emitChange('sessions');
  return getSession(db, id)!;
}

export function closeSession(
  db: Database,
  id: string,
  opts: {
    status: 'success' | 'failure' | 'cancelled' | 'suspended';
    result?: string;
    error?: string;
  },
): void {
  const ended_at = Date.now();
  db.prepare(
    `UPDATE agent_sessions SET
       status = ?,
       ended_at = ?,
       result = COALESCE(?, result),
       error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(opts.status, ended_at, opts.result ?? null, opts.error ?? null, id);
  emitChange('sessions');
}

export function markSessionSuspended(db: Database, id: string): void {
  db.prepare(
    `UPDATE agent_sessions SET status='suspended', ended_at=? WHERE id=?`,
  ).run(Date.now(), id);
  emitChange('sessions');
}

export function getSession(db: Database, id: string): AgentSessionRow | null {
  const row = db
    .prepare('SELECT * FROM agent_sessions WHERE id = ?')
    .get(id) as AgentSessionRow | undefined;
  return row ?? null;
}

export function listSessionsForStep(
  db: Database,
  recipe_step_id: string,
): AgentSessionRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_sessions WHERE recipe_step_id = ? ORDER BY started_at ASC`,
    )
    .all(recipe_step_id) as AgentSessionRow[];
}

export function listSessionsForInstance(
  db: Database,
  recipe_instance_id: string,
): AgentSessionRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_sessions WHERE recipe_instance_id = ? ORDER BY started_at ASC`,
    )
    .all(recipe_instance_id) as AgentSessionRow[];
}

export function findResumeTarget(
  db: Database,
  recipe_step_id: string,
): AgentSessionRow | null {
  const row = db
    .prepare(
      `SELECT * FROM agent_sessions
       WHERE recipe_step_id = ? AND status IN ('suspended', 'success', 'failure')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(recipe_step_id) as AgentSessionRow | undefined;
  return row ?? null;
}

export interface ListAllSessionsOpts {
  /**
   * Exclusive upper bound on `started_at` for paginating archived rows
   * (descending order). Pass the previous page's `next_since` cursor
   * (which is the oldest row's `started_at`) to fetch the next page of
   * older rows. When 0 or undefined, no upper bound is applied.
   */
  since?: number;
  /** Page size (default 50, max 200). */
  limit?: number;
}

/**
 * List recent agent_sessions rows for the Terminals Panel.
 *
 * Live rows (status='running') are always included regardless of `since`
 * so the Active section is never paginated out. Archived rows are filtered
 * by `started_at < since` (when since>0) and ordered newest-first; the
 * caller dedupes against the live pty-registry by `recipe_instance_id`.
 */
export function listAllSessions(
  db: Database,
  opts: ListAllSessionsOpts = {},
): AgentSessionRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const since = opts.since ?? 0;
  return db
    .prepare(
      `SELECT * FROM agent_sessions
       WHERE (status = 'running')
          OR (? = 0)
          OR (started_at < ?)
       ORDER BY (status = 'running') DESC, started_at DESC
       LIMIT ?`,
    )
    .all(since, since, limit) as AgentSessionRow[];
}

/**
 * Mark the archived agent_sessions row whose recipe_instance_id = oldInstanceId
 * as having been resumed into newInstanceId. The UI uses this to render a
 * "Resumed as <new-id>" badge on the original archived row.
 */
export function markResumedInto(
  db: Database,
  oldInstanceId: string,
  newInstanceId: string,
): void {
  db.prepare(
    `UPDATE agent_sessions
       SET resumed_into_instance_id = ?
     WHERE recipe_instance_id = ?`,
  ).run(newInstanceId, oldInstanceId);
  emitChange('sessions');
}

export function updateStatus(
  db: Database,
  id: string,
  payload: { text: string | null; needs_user_input: boolean; ts: number },
): void {
  db.prepare(
    `UPDATE agent_sessions
      SET status_text = ?, needs_user_input = ?, last_status_at = ?
     WHERE id = ?`,
  ).run(payload.text, payload.needs_user_input ? 1 : 0, payload.ts, id);
}
