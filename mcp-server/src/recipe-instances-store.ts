/**
 * recipe-instances-store.ts (DB + JSON dual-write)
 *
 * Storage for recipe-run instances (spec §6.1). Phase 4 — the SQLite
 * kernel DB is now the canonical store; the legacy on-disk
 * `<workspace>/.clawdevbox/recipe-instances/<id>.json` files are
 * preserved as a write-through mirror so that:
 *
 *   - the echo-stub child process (which mutates the JSON file directly
 *     to mark itself complete) keeps working
 *   - existing tests that introspect the JSON file shape keep passing
 *   - future phases (recipe-runner extraction) can flip the read path
 *     to the DB without churn here
 *
 * Reads prefer the JSON file (it's the live, sub-process-mutated copy);
 * if the file is missing, we fall back to the DB row. Writes go to
 * both: file first (atomic), then DB upsert + optional agent_sessions
 * row insert.
 *
 * Schema mapping (RecipeInstance on disk → DB rows):
 *
 *   recipe_snapshot (raw YAML) → also written to
 *     `<workspace>/.clawdevbox/recipe-snapshots/<id>.yaml`; the DB
 *     stores `recipe_snapshot_path` pointing at that file.
 *
 *   agent_cli / pid / session_id / resume_of → an `agent_sessions` row
 *     bound to the recipe_instance. We insert one on first write that
 *     carries pid (or session_id) and skip re-inserts after that.
 *
 *   steps[] (legacy shape) → materialised into `recipe_steps` rows
 *     using each entry's id as `step_id` and its title as `goal`
 *     (falling back to "(no goal)" if absent). Subsequent writes
 *     match by `step_id` and update status/message/timestamps.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDatabase } from './db/index.ts';
import { ensureWorkspace } from './db/workspaces-store.ts';
import { emitChange } from './event-bus.ts';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Types (preserved for API compatibility)
// ============================================================================

export type RecipeInstanceStatus = 'running' | 'success' | 'failure' | 'cancelled';
export type RecipeStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'awaiting_user' | 'skipped';

export interface RecipeStep {
  /** Stable step id within the recipe (e.g. 'analyze-diffs', 'step-3'). */
  id: string;
  /** Display title. */
  title: string;
  status: RecipeStepStatus;
  started_at?: number;
  completed_at?: number;
  /** Short single-line status detail ("Generated 4 comments"). */
  message?: string;
  /** When status === 'awaiting_user', the prompt to show to the user. */
  awaiting_user_prompt?: string;
  /** Deep-link to a child recipe instance spawned by this step. */
  child_recipe_instance_id?: string;
  /** Deep-link to an artifact produced by this step. */
  artifact_id?: string;
}

export interface RecipeInstance {
  id: string;
  recipe_id: string;
  recipe_snapshot: string;
  workspace_id: string;
  workspace_path: string;
  prompt: string;
  params: Record<string, unknown>;
  agent_cli: string;
  pid: number | null;
  started_at: number;
  status: RecipeInstanceStatus;
  completed_at: number | null;
  result: unknown;
  message: string | null;
  session_id?: string;
  resume_of?: string | null;
  steps?: RecipeStep[];
  parent_recipe_instance_id?: string | null;
}

// ============================================================================
// Id minting
// ============================================================================

export function mintRecipeInstanceId(now: number = Date.now()): string {
  const ts = now.toString(36);
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `ri_${ts}_${rand}`;
}

// ============================================================================
// Paths
// ============================================================================

export function recipeInstancesDir(workspacePath: string): string {
  return join(workspacePath, '.clawdevbox', 'recipe-instances');
}

export function recipeInstancePath(workspacePath: string, id: string): string {
  return join(recipeInstancesDir(workspacePath), `${id}.json`);
}

function recipeSnapshotsDir(workspacePath: string): string {
  return join(workspacePath, '.clawdevbox', 'recipe-snapshots');
}

function recipeSnapshotPath(workspacePath: string, id: string): string {
  return join(recipeSnapshotsDir(workspacePath), `${id}.yaml`);
}

// ============================================================================
// DB helpers
// ============================================================================

function safeDb(): Database | null {
  try {
    return getDatabase();
  } catch {
    return null;
  }
}

interface RecipeInstanceRow {
  id: string;
  recipe_id: string | null;
  recipe_snapshot_path: string | null;
  workspace_id: string;
  workspace_path: string;
  parent_recipe_instance_id: string | null;
  prompt: string | null;
  params_json: string;
  started_at: number;
  status: RecipeInstanceStatus;
  completed_at: number | null;
  result: string | null;
  message: string | null;
  trigger_id: string | null;
  fire_id: string | null;
}

interface AgentSessionPeek {
  agent_cli: string;
  pid: number | null;
  cli_session_id: string | null;
  resume_of_agent_session_id: string | null;
}

function readSnapshotIfPresent(workspacePath: string, id: string): string | null {
  const p = recipeSnapshotPath(workspacePath, id);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function rowToInstance(
  db: Database,
  row: RecipeInstanceRow,
  workspacePathHint: string,
): RecipeInstance {
  const session = db
    .prepare(
      `SELECT s.agent_cli, s.pid, s.cli_session_id, s.resume_of_agent_session_id
       FROM agent_sessions s
       WHERE s.recipe_instance_id = ?
       ORDER BY s.started_at DESC LIMIT 1`,
    )
    .get(row.id) as AgentSessionPeek | undefined;

  let resume_of: string | null = null;
  if (session?.resume_of_agent_session_id) {
    const prev = db
      .prepare('SELECT cli_session_id FROM agent_sessions WHERE id = ?')
      .get(session.resume_of_agent_session_id) as { cli_session_id: string | null } | undefined;
    resume_of = prev?.cli_session_id ?? null;
  }

  const steps = readStepsFromDb(db, row.id);

  let snapshot = '';
  if (row.recipe_snapshot_path && existsSync(row.recipe_snapshot_path)) {
    try {
      snapshot = readFileSync(row.recipe_snapshot_path, 'utf8');
    } catch {
      snapshot = '';
    }
  } else {
    snapshot = readSnapshotIfPresent(row.workspace_path || workspacePathHint, row.id) ?? '';
  }

  return {
    id: row.id,
    recipe_id: row.recipe_id ?? '',
    recipe_snapshot: snapshot,
    workspace_id: row.workspace_id,
    workspace_path: row.workspace_path,
    prompt: row.prompt ?? '',
    params: JSON.parse(row.params_json) as Record<string, unknown>,
    agent_cli: session?.agent_cli ?? 'unknown',
    pid: session?.pid ?? null,
    started_at: row.started_at,
    status: row.status,
    completed_at: row.completed_at,
    result: row.result ? safeParse(row.result) : null,
    message: row.message,
    session_id: session?.cli_session_id ?? undefined,
    resume_of,
    steps: steps.length > 0 ? steps : undefined,
    parent_recipe_instance_id: row.parent_recipe_instance_id,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

interface StepRowLite {
  step_id: string;
  name: string | null;
  goal: string;
  status: RecipeStepStatus;
  started_at: number | null;
  completed_at: number | null;
  message: string | null;
  awaiting_user_message: string | null;
  state_json: string;
}

function readStepsFromDb(db: Database, recipe_instance_id: string): RecipeStep[] {
  const rows = db
    .prepare(
      `SELECT step_id, name, goal, status, started_at, completed_at,
              message, awaiting_user_message, state_json
       FROM recipe_steps
       WHERE recipe_instance_id = ?
       ORDER BY step_index ASC`,
    )
    .all(recipe_instance_id) as StepRowLite[];
  return rows.map((r) => {
    const state = JSON.parse(r.state_json) as Record<string, unknown>;
    const step: RecipeStep = {
      id: r.step_id,
      title: r.name ?? r.goal,
      status: r.status,
    };
    if (r.started_at != null) step.started_at = r.started_at;
    if (r.completed_at != null) step.completed_at = r.completed_at;
    if (r.message) step.message = r.message;
    if (r.awaiting_user_message) step.awaiting_user_prompt = r.awaiting_user_message;
    if (typeof state.child_recipe_instance_id === 'string') {
      step.child_recipe_instance_id = state.child_recipe_instance_id;
    }
    if (typeof state.artifact_id === 'string') {
      step.artifact_id = state.artifact_id;
    }
    return step;
  });
}

/**
 * Upsert the DB row for an instance and mirror steps + the latest
 * agent-session metadata. Idempotent — safe to call on every write.
 */
function upsertInstanceToDb(db: Database, instance: RecipeInstance): void {
  const ws = ensureWorkspace(db, { path: instance.workspace_path });
  const snapshotPath = recipeSnapshotPath(instance.workspace_path, instance.id);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO recipe_instances (
         id, recipe_id, recipe_snapshot_path, workspace_id, workspace_path,
         parent_recipe_instance_id, prompt, params_json, started_at, status,
         completed_at, result, message
       ) VALUES (
         @id, @recipe_id, @recipe_snapshot_path, @workspace_id, @workspace_path,
         @parent_recipe_instance_id, @prompt, @params_json, @started_at, @status,
         @completed_at, @result, @message
       )
       ON CONFLICT(id) DO UPDATE SET
         recipe_id = excluded.recipe_id,
         recipe_snapshot_path = excluded.recipe_snapshot_path,
         workspace_path = excluded.workspace_path,
         parent_recipe_instance_id = excluded.parent_recipe_instance_id,
         prompt = excluded.prompt,
         params_json = excluded.params_json,
         status = excluded.status,
         completed_at = excluded.completed_at,
         result = excluded.result,
         message = excluded.message`,
    ).run({
      id: instance.id,
      recipe_id: instance.recipe_id || null,
      recipe_snapshot_path: instance.recipe_snapshot ? snapshotPath : null,
      workspace_id: ws.id,
      workspace_path: instance.workspace_path,
      parent_recipe_instance_id: instance.parent_recipe_instance_id ?? null,
      prompt: instance.prompt ?? null,
      params_json: JSON.stringify(instance.params ?? {}),
      started_at: instance.started_at,
      status: instance.status,
      completed_at: instance.completed_at,
      result:
        instance.result === null || instance.result === undefined
          ? null
          : typeof instance.result === 'string'
            ? instance.result
            : JSON.stringify(instance.result),
      message: instance.message,
    });

    // Mirror steps (materialise on first sighting; update on subsequent calls).
    if (Array.isArray(instance.steps) && instance.steps.length > 0) {
      mirrorStepsToDb(db, instance.id, instance.steps);
    }

    // Maintain a single agent_sessions row per instance when we have
    // enough metadata. Creation happens at first write that carries
    // pid OR session_id OR a non-"unknown" agent_cli; later writes
    // update the existing row in place.
    const wantsSession =
      instance.pid != null ||
      !!instance.session_id ||
      (instance.agent_cli && instance.agent_cli !== 'unknown');
    if (wantsSession) {
      const existing = db
        .prepare(
          `SELECT id FROM agent_sessions
           WHERE recipe_instance_id = ?
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(instance.id) as { id: string } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE agent_sessions SET
             agent_cli = COALESCE(?, agent_cli),
             pid = COALESCE(?, pid),
             cli_session_id = COALESCE(?, cli_session_id)
           WHERE id = ?`,
        ).run(
          instance.agent_cli || null,
          instance.pid ?? null,
          instance.session_id ?? null,
          existing.id,
        );
      } else {
        const sid = `as_${Date.now().toString(36)}_${Math.floor(Math.random() * 0x10000)
          .toString(16)
          .padStart(4, '0')}`;
        db.prepare(
          `INSERT INTO agent_sessions (
             id, cli_session_id, recipe_instance_id, workspace_id,
             agent_cli, pid, started_at, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
        ).run(
          sid,
          instance.session_id ?? null,
          instance.id,
          ws.id,
          instance.agent_cli || 'unknown',
          instance.pid ?? null,
          instance.started_at,
        );
      }
    }
  });
  tx();
}

/**
 * Materialise legacy `steps[]` into `recipe_steps` rows on first sight,
 * then update status / runtime fields by `step_id` on subsequent writes.
 * Avoids the strict monotonic transition checks in
 * `db/recipe-steps-store.ts.transitionStatus` because the legacy steps
 * array can replay terminal states or jump backward in test fixtures.
 */
function mirrorStepsToDb(
  db: Database,
  recipe_instance_id: string,
  steps: RecipeStep[],
): void {
  const existing = db
    .prepare(
      `SELECT id, step_id FROM recipe_steps
       WHERE recipe_instance_id = ?
       ORDER BY step_index ASC`,
    )
    .all(recipe_instance_id) as Array<{ id: string; step_id: string }>;
  const existingByStepId = new Map(existing.map((r) => [r.step_id, r.id]));

  const insertStmt = db.prepare(
    `INSERT INTO recipe_steps (
       id, recipe_instance_id, step_index, step_id, name, goal,
       depends_json, params_schema_json, triggers_decl_json, artifacts_decl_json,
       status, message, state_json, started_at, completed_at, awaiting_user_message
     ) VALUES (
       ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]',
       ?, ?, ?, ?, ?, ?
     )`,
  );
  const updateStmt = db.prepare(
    `UPDATE recipe_steps SET
       name = COALESCE(?, name),
       goal = COALESCE(?, goal),
       status = ?,
       message = COALESCE(?, message),
       state_json = ?,
       started_at = COALESCE(?, started_at),
       completed_at = COALESCE(?, completed_at),
       awaiting_user_message = COALESCE(?, awaiting_user_message)
     WHERE id = ?`,
  );

  let nextIndex = existing.length;
  steps.forEach((s, idx) => {
    const stateObj: Record<string, unknown> = {};
    if (s.child_recipe_instance_id) {
      stateObj.child_recipe_instance_id = s.child_recipe_instance_id;
    }
    if (s.artifact_id) stateObj.artifact_id = s.artifact_id;
    const state_json = JSON.stringify(stateObj);
    const goal = s.title ?? '(no goal)';
    const name = s.title ?? null;
    const status: RecipeStepStatus = s.status ?? 'pending';

    const found = existingByStepId.get(s.id);
    if (found) {
      updateStmt.run(
        name,
        goal,
        status,
        s.message ?? null,
        state_json,
        s.started_at ?? null,
        s.completed_at ?? null,
        s.awaiting_user_prompt ?? null,
        found,
      );
    } else {
      const rsId = `rs_${Date.now().toString(36)}_${(idx + nextIndex)
        .toString(16)
        .padStart(2, '0')}_${Math.floor(Math.random() * 0xffff)
        .toString(16)
        .padStart(4, '0')}`;
      insertStmt.run(
        rsId,
        recipe_instance_id,
        nextIndex++,
        s.id,
        name,
        goal,
        status,
        s.message ?? null,
        state_json,
        s.started_at ?? null,
        s.completed_at ?? null,
        s.awaiting_user_prompt ?? null,
      );
    }
  });
}

// ============================================================================
// Read / write — file-primary, DB-mirror
// ============================================================================

export function readRecipeInstance(
  workspacePath: string,
  id: string,
): RecipeInstance | null {
  const p = recipeInstancePath(workspacePath, id);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as RecipeInstance;
    } catch {
      // fall through to DB read
    }
  }
  const conn = safeDb();
  if (!conn) return null;
  const row = conn
    .prepare('SELECT * FROM recipe_instances WHERE id = ? AND workspace_path = ?')
    .get(id, workspacePath) as RecipeInstanceRow | undefined;
  if (!row) return null;
  return rowToInstance(conn, row, workspacePath);
}

export function writeRecipeInstance(workspacePath: string, instance: RecipeInstance): void {
  // 1. Atomic file write (legacy primary).
  writeFileAtomic(
    recipeInstancePath(workspacePath, instance.id),
    JSON.stringify(instance, null, 2) + '\n',
  );

  // 2. Snapshot sidecar — captures the YAML so the DB row can point at it.
  if (instance.recipe_snapshot) {
    try {
      writeFileAtomic(
        recipeSnapshotPath(workspacePath, instance.id),
        instance.recipe_snapshot,
      );
    } catch {
      // best-effort
    }
  }

  // 3. DB mirror upsert.
  const conn = safeDb();
  if (conn) {
    try {
      upsertInstanceToDb(conn, instance);
    } catch {
      // The file write is the source of truth in Phase 4; never let a
      // DB hiccup mask a successful disk write to callers.
    }
  }

  emitChange('recipes');
}

/**
 * List every recipe instance under a workspace path. Returns an empty list
 * if the workspace has no `.clawdevbox/recipe-instances/` directory yet.
 * Corrupt or unreadable files are silently skipped so a single bad row
 * doesn't break the listing.
 */
export function listRecipeInstancesInWorkspace(workspacePath: string): RecipeInstance[] {
  const dir = recipeInstancesDir(workspacePath);
  const out: RecipeInstance[] = [];
  const seen = new Set<string>();

  if (existsSync(dir)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RecipeInstance;
        if (parsed && typeof parsed.id === 'string') {
          out.push(parsed);
          seen.add(parsed.id);
        }
      } catch {
        /* corrupt entry — skip */
      }
    }
  }

  // Pick up DB rows that don't have a corresponding JSON file yet.
  const conn = safeDb();
  if (conn) {
    try {
      const ws = ensureWorkspace(conn, { path: workspacePath });
      const rows = conn
        .prepare(
          `SELECT * FROM recipe_instances WHERE workspace_id = ?
           ORDER BY started_at DESC`,
        )
        .all(ws.id) as RecipeInstanceRow[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        out.push(rowToInstance(conn, row, workspacePath));
        seen.add(row.id);
      }
    } catch {
      // ignore — DB might not be available in some test contexts
    }
  }
  return out;
}
