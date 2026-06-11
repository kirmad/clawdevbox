/**
 * step_events store — append-only audit log per recipe step.
 *
 * Every meaningful change on a step (status flip, state patch, trigger
 * registered, artifact attached, user-input round-trip, meta patch, add/
 * remove sibling) is recorded as a row here. See spec §10.4-10.5 for the
 * exhaustive event-type list and tool semantics.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export type StepEventType =
  | 'status_changed'
  | 'message'
  | 'state_patched'
  | 'artifact_attached'
  | 'inbox_attached'
  | 'trigger_registered'
  | 'trigger_unregistered'
  | 'trigger_registration_failed'
  | 'user_input_requested'
  | 'user_input_received'
  | 'meta_patched'
  | 'step_added'
  | 'step_removed';

export interface StepEventRow {
  id: string;
  recipe_step_id: string;
  recipe_instance_id: string;
  agent_session_id: string | null;
  type: StepEventType;
  message: string | null;
  payload_json: string;
  created_at: number;
}

export function mintEventId(): string {
  return `ev_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function appendEvent(
  db: Database,
  opts: {
    recipe_step_id: string;
    recipe_instance_id: string;
    agent_session_id?: string | null;
    type: StepEventType;
    message?: string;
    payload?: unknown;
  },
): StepEventRow {
  const id = mintEventId();
  const created_at = Date.now();
  const payload_json = opts.payload === undefined ? '{}' : JSON.stringify(opts.payload);
  // FK-safe agent_session_id: the column has a hard FK on agent_sessions(id).
  // If the caller passes a stale id (session archived, never written, or
  // an env-var holdover from a prior run), the INSERT fails with
  // "FOREIGN KEY constraint failed". Validate existence and null it if
  // not found — the column is `ON DELETE SET NULL` anyway, so null is
  // semantically equivalent to "the session linkage was lost".
  let safeSessionId: string | null = opts.agent_session_id ?? null;
  if (safeSessionId !== null) {
    const exists = db
      .prepare('SELECT 1 FROM agent_sessions WHERE id = ?')
      .get(safeSessionId) as { 1: number } | undefined;
    if (!exists) safeSessionId = null;
  }
  db.prepare(
    `INSERT INTO step_events (
       id, recipe_step_id, recipe_instance_id, agent_session_id, type, message, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.recipe_step_id,
    opts.recipe_instance_id,
    safeSessionId,
    opts.type,
    opts.message ?? null,
    payload_json,
    created_at,
  );
  return {
    id,
    recipe_step_id: opts.recipe_step_id,
    recipe_instance_id: opts.recipe_instance_id,
    agent_session_id: safeSessionId,
    type: opts.type,
    message: opts.message ?? null,
    payload_json,
    created_at,
  };
}

export function listEvents(
  db: Database,
  opts: {
    recipe_step_id?: string;
    recipe_instance_id?: string;
    limit?: number;
    before?: number;
  },
): StepEventRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.recipe_step_id) {
    where.push('recipe_step_id = ?');
    params.push(opts.recipe_step_id);
  }
  if (opts.recipe_instance_id) {
    where.push('recipe_instance_id = ?');
    params.push(opts.recipe_instance_id);
  }
  if (opts.before !== undefined) {
    where.push('created_at < ?');
    params.push(opts.before);
  }
  const limit = Math.min(opts.limit ?? 100, 1000);
  const sql = `SELECT * FROM step_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at ASC, id ASC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as StepEventRow[];
}
