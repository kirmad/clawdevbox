/**
 * recipe_steps store — materialized rows for a recipe instance.
 *
 * Implements the §10.4-10.5 monotonic status machine and the §10.5
 * `recipe.update_steps` semantics (add / remove / update_meta). Every
 * state-changing path appends a row to `step_events` so the SPA timeline
 * has a complete causal log.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { appendEvent } from './step-events-store.ts';

export type RecipeStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'awaiting_user'
  | 'skipped';

export interface StepParamDecl {
  name: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface TriggerDecl {
  type: string;
  params?: Record<string, unknown>;
  cron?: string | null | false;
  binds_callback_to?: string;
  binds_callback_to_recipe?: string;
  once?: boolean;
  expires_at?: number;
  max_attempts?: number;
  backoff_ms?: number[];
}

export interface ArtifactDecl {
  id: string;
  type: string;
  title?: string;
}

export interface Step {
  id: string;
  name?: string;
  goal: string;
  depends?: string[];
  params?: StepParamDecl[];
  triggers?: TriggerDecl[];
  artifacts?: ArtifactDecl[];
}

export interface RecipeStepRow {
  id: string;
  recipe_instance_id: string;
  step_index: number;
  step_id: string;
  name: string | null;
  goal: string;
  depends_json: string;
  params_schema_json: string;
  triggers_decl_json: string;
  artifacts_decl_json: string;
  status: RecipeStepStatus;
  message: string | null;
  state_json: string;
  started_at: number | null;
  completed_at: number | null;
  awaiting_user_message: string | null;
  result: string | null;
  error: string | null;
}

export const MONOTONIC_TRANSITIONS: Record<RecipeStepStatus, RecipeStepStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['awaiting_user', 'done', 'failed', 'skipped'],
  awaiting_user: ['running', 'done', 'failed', 'skipped'],
  done: [],
  failed: [],
  skipped: [],
};

const TERMINAL: ReadonlySet<RecipeStepStatus> = new Set(['done', 'failed', 'skipped']);

export class StepTransitionError extends Error {
  code = 'INVALID_STEP_TRANSITION';
  constructor(
    public from: RecipeStepStatus,
    public to: RecipeStepStatus,
  ) {
    super(`Cannot transition step from ${from} to ${to}`);
  }
}

export class StepValidationError extends Error {
  code = 'INVALID_STEP_DECLARATION';
  constructor(message: string) {
    super(message);
  }
}

export function mintStepId(): string {
  return `rs_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

function rowToStep(row: RecipeStepRow): Step {
  return {
    id: row.step_id,
    name: row.name ?? undefined,
    goal: row.goal,
    depends: JSON.parse(row.depends_json),
    params: JSON.parse(row.params_schema_json),
    triggers: JSON.parse(row.triggers_decl_json),
    artifacts: JSON.parse(row.artifacts_decl_json),
  };
}

function validateDeclarations(
  newSteps: Step[],
  existingStepIds: Set<string>,
): void {
  const seen = new Set<string>();
  for (const s of newSteps) {
    if (!s.id) throw new StepValidationError('step missing id');
    if (!s.goal) throw new StepValidationError(`step '${s.id}' missing goal`);
    if (seen.has(s.id)) throw new StepValidationError(`duplicate step id '${s.id}'`);
    if (existingStepIds.has(s.id)) {
      throw new StepValidationError(`step id '${s.id}' already exists in instance`);
    }
    seen.add(s.id);
  }
  const allIds = new Set<string>([...existingStepIds, ...newSteps.map((s) => s.id)]);
  for (const s of newSteps) {
    for (const dep of s.depends ?? []) {
      if (!allIds.has(dep)) {
        throw new StepValidationError(
          `step '${s.id}' depends on unknown step '${dep}'`,
        );
      }
    }
  }
}

export function materializeSteps(
  db: Database,
  recipe_instance_id: string,
  steps: Step[],
): RecipeStepRow[] {
  validateDeclarations(steps, new Set());
  const insertStmt = db.prepare(
    `INSERT INTO recipe_steps (
       id, recipe_instance_id, step_index, step_id, name, goal,
       depends_json, params_schema_json, triggers_decl_json, artifacts_decl_json,
       status, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}')`,
  );
  const ids: string[] = [];
  const tx = db.transaction(() => {
    steps.forEach((s, idx) => {
      const id = mintStepId();
      ids.push(id);
      insertStmt.run(
        id,
        recipe_instance_id,
        idx,
        s.id,
        s.name ?? null,
        s.goal,
        JSON.stringify(s.depends ?? []),
        JSON.stringify(s.params ?? []),
        JSON.stringify(s.triggers ?? []),
        JSON.stringify(s.artifacts ?? []),
      );
    });
  });
  tx();
  return ids.map((id) => getStepById(db, id)!);
}

export function listSteps(db: Database, recipe_instance_id: string): RecipeStepRow[] {
  return db
    .prepare(
      `SELECT * FROM recipe_steps WHERE recipe_instance_id = ? ORDER BY step_index ASC`,
    )
    .all(recipe_instance_id) as RecipeStepRow[];
}

export function getStep(
  db: Database,
  recipe_instance_id: string,
  step_id: string,
): RecipeStepRow | null {
  const row = db
    .prepare(`SELECT * FROM recipe_steps WHERE recipe_instance_id = ? AND step_id = ?`)
    .get(recipe_instance_id, step_id) as RecipeStepRow | undefined;
  return row ?? null;
}

export function getStepById(db: Database, rs_id: string): RecipeStepRow | null {
  const row = db
    .prepare(`SELECT * FROM recipe_steps WHERE id = ?`)
    .get(rs_id) as RecipeStepRow | undefined;
  return row ?? null;
}

export function transitionStatus(
  db: Database,
  rs_id: string,
  opts: {
    status?: RecipeStepStatus;
    message?: string;
    state?: Record<string, unknown>;
    state_replace?: Record<string, unknown>;
    result?: string;
    error?: string;
    awaiting_user_message?: string;
    agent_session_id?: string;
  },
): RecipeStepRow {
  if (opts.state && opts.state_replace) {
    throw new StepValidationError('state and state_replace are mutually exclusive');
  }
  const tx = db.transaction((): RecipeStepRow => {
    const current = getStepById(db, rs_id);
    if (!current) throw new StepValidationError(`step ${rs_id} not found`);

    let nextStatus = current.status;
    if (opts.status && opts.status !== current.status) {
      const allowed = MONOTONIC_TRANSITIONS[current.status];
      if (!allowed.includes(opts.status)) {
        throw new StepTransitionError(current.status, opts.status);
      }
      nextStatus = opts.status;
    }

    let nextState = current.state_json;
    if (opts.state_replace) {
      nextState = JSON.stringify(opts.state_replace);
    } else if (opts.state) {
      const merged = { ...JSON.parse(current.state_json), ...opts.state };
      nextState = JSON.stringify(merged);
    }

    let started_at = current.started_at;
    let completed_at = current.completed_at;
    if (nextStatus === 'running' && started_at == null) {
      started_at = Date.now();
    }
    if (TERMINAL.has(nextStatus) && completed_at == null) {
      completed_at = Date.now();
    }

    db.prepare(
      `UPDATE recipe_steps SET
         status = ?,
         message = COALESCE(?, message),
         state_json = ?,
         result = COALESCE(?, result),
         error = COALESCE(?, error),
         awaiting_user_message = COALESCE(?, awaiting_user_message),
         started_at = ?,
         completed_at = ?
       WHERE id = ?`,
    ).run(
      nextStatus,
      opts.message ?? null,
      nextState,
      opts.result ?? null,
      opts.error ?? null,
      opts.awaiting_user_message ?? null,
      started_at,
      completed_at,
      rs_id,
    );

    if (nextStatus !== current.status) {
      appendEvent(db, {
        recipe_step_id: rs_id,
        recipe_instance_id: current.recipe_instance_id,
        agent_session_id: opts.agent_session_id,
        type: 'status_changed',
        message: opts.message,
        payload: { from: current.status, to: nextStatus },
      });
    } else if (opts.state || opts.state_replace) {
      appendEvent(db, {
        recipe_step_id: rs_id,
        recipe_instance_id: current.recipe_instance_id,
        agent_session_id: opts.agent_session_id,
        type: 'state_patched',
        message: opts.message,
        payload: opts.state_replace
          ? { replace: opts.state_replace }
          : { patch: opts.state },
      });
    } else if (opts.message) {
      appendEvent(db, {
        recipe_step_id: rs_id,
        recipe_instance_id: current.recipe_instance_id,
        agent_session_id: opts.agent_session_id,
        type: 'message',
        message: opts.message,
      });
    }

    return getStepById(db, rs_id)!;
  });
  return tx();
}

export function addSteps(
  db: Database,
  recipe_instance_id: string,
  newSteps: Step[],
): RecipeStepRow[] {
  const existing = listSteps(db, recipe_instance_id);
  const existingIds = new Set(existing.map((r) => r.step_id));
  validateDeclarations(newSteps, existingIds);
  const startIndex = existing.length > 0
    ? Math.max(...existing.map((r) => r.step_index)) + 1
    : 0;
  const insertStmt = db.prepare(
    `INSERT INTO recipe_steps (
       id, recipe_instance_id, step_index, step_id, name, goal,
       depends_json, params_schema_json, triggers_decl_json, artifacts_decl_json,
       status, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}')`,
  );
  const ids: string[] = [];
  const tx = db.transaction(() => {
    newSteps.forEach((s, i) => {
      const id = mintStepId();
      ids.push(id);
      insertStmt.run(
        id,
        recipe_instance_id,
        startIndex + i,
        s.id,
        s.name ?? null,
        s.goal,
        JSON.stringify(s.depends ?? []),
        JSON.stringify(s.params ?? []),
        JSON.stringify(s.triggers ?? []),
        JSON.stringify(s.artifacts ?? []),
      );
      appendEvent(db, {
        recipe_step_id: id,
        recipe_instance_id,
        type: 'step_added',
        payload: { step_id: s.id, name: s.name ?? null, goal: s.goal },
      });
    });
  });
  tx();
  return ids.map((id) => getStepById(db, id)!);
}

export function removeSteps(
  db: Database,
  recipe_instance_id: string,
  step_ids: string[],
): void {
  const all = listSteps(db, recipe_instance_id);
  const byId = new Map(all.map((r) => [r.step_id, r]));
  const toRemove: RecipeStepRow[] = [];
  for (const sid of step_ids) {
    const row = byId.get(sid);
    if (!row) throw new StepValidationError(`step '${sid}' not in instance`);
    if (row.status === 'running' || row.status === 'awaiting_user') {
      throw new StepValidationError(
        `cannot remove step '${sid}' in status '${row.status}'`,
      );
    }
    toRemove.push(row);
  }
  const removeIds = new Set(toRemove.map((r) => r.step_id));
  // Reject if any non-removed step depends on a removed one.
  for (const row of all) {
    if (removeIds.has(row.step_id)) continue;
    const depends = JSON.parse(row.depends_json) as string[];
    for (const d of depends) {
      if (removeIds.has(d)) {
        throw new StepValidationError(
          `cannot remove '${d}': step '${row.step_id}' depends on it`,
        );
      }
    }
  }
  const tx = db.transaction(() => {
    // Emit step_removed events FIRST so the audit row survives even though the
    // FK cascade on step_events will purge them on delete. Events reference
    // step rows by id; emitting before delete keeps FK happy.
    for (const row of toRemove) {
      appendEvent(db, {
        recipe_step_id: row.id,
        recipe_instance_id,
        type: 'step_removed',
        payload: { step_id: row.step_id },
      });
    }
    const del = db.prepare(`DELETE FROM recipe_steps WHERE id = ?`);
    for (const row of toRemove) del.run(row.id);
  });
  tx();
}

function diffTriggers(
  oldDecl: TriggerDecl[],
  newDecl: TriggerDecl[],
): { added: TriggerDecl[]; removed: TriggerDecl[] } {
  const keyOf = (t: TriggerDecl) =>
    JSON.stringify({
      type: t.type,
      params: t.params ?? {},
      cron: t.cron ?? null,
      binds_callback_to: t.binds_callback_to ?? null,
      binds_callback_to_recipe: t.binds_callback_to_recipe ?? null,
    });
  const oldKeys = new Map(oldDecl.map((t) => [keyOf(t), t]));
  const newKeys = new Map(newDecl.map((t) => [keyOf(t), t]));
  const added: TriggerDecl[] = [];
  const removed: TriggerDecl[] = [];
  for (const [k, v] of newKeys) if (!oldKeys.has(k)) added.push(v);
  for (const [k, v] of oldKeys) if (!newKeys.has(k)) removed.push(v);
  return { added, removed };
}

export function updateMeta(
  db: Database,
  recipe_instance_id: string,
  step_id: string,
  patch: Partial<Step>,
): {
  row: RecipeStepRow;
  added_triggers: TriggerDecl[];
  removed_triggers: TriggerDecl[];
} {
  const current = getStep(db, recipe_instance_id, step_id);
  if (!current) throw new StepValidationError(`step '${step_id}' not in instance`);

  const oldTriggers = JSON.parse(current.triggers_decl_json) as TriggerDecl[];
  const newTriggers = patch.triggers !== undefined ? patch.triggers : oldTriggers;

  if (patch.depends !== undefined) {
    const otherIds = listSteps(db, recipe_instance_id)
      .filter((r) => r.step_id !== step_id)
      .map((r) => r.step_id);
    const allowed = new Set(otherIds);
    for (const d of patch.depends) {
      if (!allowed.has(d)) {
        throw new StepValidationError(
          `step '${step_id}' depends on unknown step '${d}'`,
        );
      }
    }
  }

  const tx = db.transaction((): RecipeStepRow => {
    db.prepare(
      `UPDATE recipe_steps SET
         name = COALESCE(?, name),
         goal = COALESCE(?, goal),
         depends_json = COALESCE(?, depends_json),
         params_schema_json = COALESCE(?, params_schema_json),
         triggers_decl_json = COALESCE(?, triggers_decl_json),
         artifacts_decl_json = COALESCE(?, artifacts_decl_json)
       WHERE id = ?`,
    ).run(
      patch.name ?? null,
      patch.goal ?? null,
      patch.depends !== undefined ? JSON.stringify(patch.depends) : null,
      patch.params !== undefined ? JSON.stringify(patch.params) : null,
      patch.triggers !== undefined ? JSON.stringify(patch.triggers) : null,
      patch.artifacts !== undefined ? JSON.stringify(patch.artifacts) : null,
      current.id,
    );
    appendEvent(db, {
      recipe_step_id: current.id,
      recipe_instance_id,
      type: 'meta_patched',
      payload: { fields: Object.keys(patch) },
    });
    return getStepById(db, current.id)!;
  });

  const row = tx();
  const { added, removed } = diffTriggers(oldTriggers, newTriggers);
  return { row, added_triggers: added, removed_triggers: removed };
}

// Re-export for convenience (consumers often want both shapes).
export { rowToStep };
