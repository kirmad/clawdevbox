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
  | 'validating'
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

export interface ValidationGate {
  /** Stable label; used in the verdict-file path + UI. Optional in YAML. */
  name?: string;
  mode: 'evidence' | 'artifacts' | 'judge';
  criteria?: string;
  verifier_provider?: string;
  verifier_agent?: string;
  verifier_model?: string;
}

/** Canonical, normalized multi-gate validation stored in `validation_json`. */
export interface ValidationConfig {
  gates: Array<{ name: string; mode: 'evidence' | 'artifacts' | 'judge'; criteria?: string; verifier_provider?: string; verifier_agent?: string; verifier_model?: string }>;
  max_rework?: number;
}

export interface ValidationDecl {
  mode: 'evidence' | 'artifacts' | 'judge';
  criteria?: string;
  max_rework?: number;
  verifier_model?: string;
}

export interface ExecutionDecl {
  /** Which session lane runs this step. Default 'main' (the initial console). */
  session?: string;
  mode?: 'inline' | 'fresh-session';
  isolation?: 'required';
  /** CLI/provider for the lane's session (copilot | claude | agency). */
  provider?: string;
  /** Persona passed as --agent. */
  agent?: string;
  /** Model passed as --model. */
  model?: string;
}

export interface Step {
  id: string;
  /** Optional back-compat synonym for `goal`. New recipes use `goal` directly. */
  name?: string;
  /** Human-readable TL;DR (≤ 200 chars). Shown as the step title in the UI. */
  goal: string;
  /**
   * Full agent-facing prompt for this step. Optional — omit when the step
   * is purely informational (no agent execution required). Rendered as a
   * collapsible "Agent instructions" panel in the SPA. Persisted in
   * `state_json` rather than its own column so it survives schema
   * migrations.
   */
  ai_instructions?: string;
  depends?: string[];
  params?: StepParamDecl[];
  triggers?: TriggerDecl[];
  artifacts?: ArtifactDecl[];
  /**
   * When true, the step cannot be skipped — any attempt to transition it
   * into `skipped` is rejected by the step machine (see `transitionStatus`).
   * Defaults to false (skippable). Use for non-negotiable gates (design docs,
   * approvals, etc.) that must be completed rather than skipped.
   */
  required?: boolean;
  /** Opt-in validation gate(s). One gate object, OR a list of gates (all must
   *  pass). When present, the step reaches `done` only via a server-applied
   *  verifier verdict (never a direct running→done). Canonicalized to a
   *  `ValidationConfig` by `normalizeValidation` before materialization. */
  validation?: ValidationDecl | ValidationGate[] | ValidationConfig;
  /** How the step's own work runs. Absent = inline (today's behavior). */
  execution?: ExecutionDecl;
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
  /** 0 | 1 — SQLite boolean. When 1 the step cannot be skipped. */
  required: number;
  /** Parsed `validation` contract JSON, or null when the step is not gated. */
  validation_json: string | null;
  /** Parsed `execution` contract JSON, or null (inline). */
  execution_json: string | null;
  /** Live verifier run's session id (worker-loop bookkeeping), or null. */
  verifier_session_id: string | null;
  /** Latest verdict JSON (convenience/UI), or null. */
  verdict_json: string | null;
  /** FAIL→rework loop counter. */
  rework_count: number;
  /** Verifier (re)spawn attempts (auto-retry + manual re-validate). */
  validation_attempt: number;
  /**
   * Validation worker's per-attempt, per-gate runtime state for multi-gate
   * steps, or null. JSON: { attempt, gates: { <name>: { verifier_session_id,
   * started_at } } }. Steps with 0 or 1 gate never populate it.
   */
  validation_runs_json: string | null;
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
  running: ['awaiting_user', 'validating', 'done', 'failed', 'skipped'],
  validating: ['running', 'done', 'awaiting_user', 'failed', 'skipped'],
  awaiting_user: ['running', 'validating', 'done', 'failed', 'skipped'],
  done: [],
  failed: [],
  skipped: [],
};

const TERMINAL: ReadonlySet<RecipeStepStatus> = new Set(['done', 'failed', 'skipped']);

export class StepTransitionError extends Error {
  code = 'INVALID_STEP_TRANSITION';
  // Explicit field declarations + body assignment (not TypeScript parameter
  // properties) because Node's --experimental-strip-types mode used by the
  // test runner does not support parameter property syntax.
  readonly from: RecipeStepStatus;
  readonly to: RecipeStepStatus;
  constructor(from: RecipeStepStatus, to: RecipeStepStatus) {
    super(`Cannot transition step from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}

export class StepValidationError extends Error {
  code = 'INVALID_STEP_DECLARATION';
  constructor(message: string) {
    super(message);
  }
}

export class StepRequiredError extends Error {
  code = 'STEP_REQUIRED';
  // Explicit field declaration + body assignment (not a TS parameter
  // property) — Node's --experimental-strip-types test mode rejects the
  // shorthand.
  readonly step_id: string;
  constructor(step_id: string) {
    super(
      `Cannot skip step '${step_id}': it is declared required (required: true) and must be completed, not skipped.`,
    );
    this.step_id = step_id;
  }
}

export class StepValidationRequiredError extends Error {
  code = 'STEP_VALIDATION_REQUIRED';
  readonly step_id: string;
  constructor(step_id: string, detail: string) {
    super(`Step '${step_id}' is validation-gated: ${detail}.`);
    this.step_id = step_id;
  }
}

export function mintStepId(): string {
  return `rs_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

/**
 * Sanitize an explicit gate name into a path-safe token. Explicit names feed
 * the per-gate verdict-file path in a later task, so strip anything that isn't
 * `[A-Za-z0-9._-]`, collapse `..` runs (defeats parent-dir traversal), and trim
 * separator padding. Falls back to `gate` when nothing usable remains.
 */
function sanitizeGateName(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'gate';
}

/**
 * Normalize any accepted `validation` shape (single ValidationDecl, an array of
 * gates, or a canonical {gates} object read back from validation_json) into the
 * canonical ValidationConfig. Returns null when there is no gate. Gate names
 * default to their mode; duplicate defaults get an index suffix so every name
 * is unique + path-safe.
 *
 * This function is LENIENT and MUST NEVER throw: it doubles as the back-compat
 * reader for validation_json rows written by earlier tasks. Fail-closed
 * enforcement of malformed authoring input lives at the write chokepoint
 * (`buildStepDecls`) and in `validateRecipeSource`, not here.
 */
export function normalizeValidation(raw: unknown, stepMaxRework?: number): ValidationConfig | null {
  if (raw == null) return null;
  let gatesRaw: unknown[];
  let maxRework = stepMaxRework;
  if (Array.isArray(raw)) {
    gatesRaw = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.gates)) {
      gatesRaw = obj.gates;
      if (typeof obj.max_rework === 'number') maxRework = obj.max_rework;
    } else {
      gatesRaw = [obj]; // a single ValidationDecl
      if (typeof obj.max_rework === 'number') maxRework = obj.max_rework;
    }
  } else {
    return null;
  }
  const used = new Set<string>();
  const gates = gatesRaw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map((g, i) => {
      const mode = (typeof g.mode === 'string' ? g.mode : 'evidence') as 'evidence' | 'artifacts' | 'judge';
      let base = typeof g.name === 'string' && g.name.trim() ? sanitizeGateName(g.name.trim()) : mode;
      let name = base, k = i;
      while (used.has(name)) name = `${base}-${k++}`;
      used.add(name);
      const out: ValidationConfig['gates'][number] = { name, mode };
      if (typeof g.criteria === 'string' && g.criteria.trim()) out.criteria = g.criteria;
      if (typeof g.verifier_model === 'string' && g.verifier_model.trim()) out.verifier_model = g.verifier_model;
      if (typeof g.verifier_provider === 'string' && g.verifier_provider.trim()) out.verifier_provider = g.verifier_provider.trim();
      if (typeof g.verifier_agent === 'string' && g.verifier_agent.trim()) out.verifier_agent = g.verifier_agent.trim();
      return out;
    });
  if (gates.length === 0) return null;
  return maxRework != null ? { gates, max_rework: maxRework } : { gates };
}

/** Canonicalize a raw `execution` block; NEVER throws. Doubles as the reader
 *  that turns a stored `execution_json` back into a canonical ExecutionDecl.
 *  Returns null when empty/not-an-object. */
export function normalizeExecution(raw: unknown): ExecutionDecl | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: ExecutionDecl = {};
  if (typeof o.session === 'string' && o.session.trim()) out.session = o.session.trim();
  if (o.mode === 'inline' || o.mode === 'fresh-session') out.mode = o.mode;
  if (o.isolation === 'required') out.isolation = 'required';
  for (const k of ['provider', 'agent', 'model'] as const) {
    if (typeof o[k] === 'string' && (o[k] as string).trim()) out[k] = (o[k] as string).trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Resolve a step's lane: explicit session > implicit fresh-session lane > 'main'. */
export function resolveLane(execution: ExecutionDecl | null | undefined, stepId: string): string {
  if (execution?.session) return execution.session;
  if (execution?.mode === 'fresh-session') return `__step:${stepId}`;
  return 'main';
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
    required: row.required === 1,
    validation: row.validation_json ? JSON.parse(row.validation_json) : undefined,
    execution: row.execution_json ? JSON.parse(row.execution_json) : undefined,
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
       required, validation_json, execution_json, status, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const ids: string[] = [];
  const tx = db.transaction(() => {
    steps.forEach((s, idx) => {
      const id = mintStepId();
      ids.push(id);
      // Stash ai_instructions in state_json (no schema migration needed).
      const state: Record<string, unknown> = {};
      if (s.ai_instructions) state.ai_instructions = s.ai_instructions;
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
        s.required ? 1 : 0,
        s.validation ? JSON.stringify(s.validation) : null,
        s.execution ? JSON.stringify(s.execution) : null,
        JSON.stringify(state),
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

export interface ReadyStep {
  step_id: string; goal: string; lane: string;
  ai_instructions?: string; ai_prompt?: string; depends: string[];
}

/** Ready = pending AND every dependency terminal. Optionally filter to one lane. */
export function computeReadySteps(db: Database, recipe_instance_id: string, lane?: string): ReadyStep[] {
  const TERMINAL = new Set<RecipeStepStatus>(['done', 'failed', 'skipped']);
  const all = listSteps(db, recipe_instance_id);
  const doneIds = new Set(all.filter((s) => TERMINAL.has(s.status)).map((s) => s.step_id));
  const out: ReadyStep[] = [];
  for (const s of all) {
    if (s.status !== 'pending') continue;
    const deps = JSON.parse(s.depends_json) as string[];
    if (!deps.every((d) => doneIds.has(d))) continue;
    const exec = s.execution_json ? (normalizeExecution(JSON.parse(s.execution_json)) ?? null) : null;
    const stepLane = resolveLane(exec, s.step_id);
    if (lane != null && stepLane !== lane) continue;
    const state = JSON.parse(s.state_json || '{}') as Record<string, unknown>;
    out.push({
      step_id: s.step_id, goal: s.goal, lane: stepLane,
      ai_instructions: typeof state.ai_instructions === 'string' ? state.ai_instructions : undefined,
      ai_prompt: typeof state.ai_prompt === 'string' ? state.ai_prompt : undefined,
      depends: deps,
    });
  }
  return out;
}

/**
 * List every step across ALL instances currently in `status`. Backed by
 * `idx_steps_status`. Used by the validation worker-loop's per-tick scan
 * (mirrors idle-reaper's single indexed query per tick).
 */
export function listStepsByStatus(db: Database, status: RecipeStepStatus): RecipeStepRow[] {
  return db
    .prepare(`SELECT * FROM recipe_steps WHERE status = ? ORDER BY started_at ASC`)
    .all(status) as RecipeStepRow[];
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
    viaVerdict?: boolean;
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
      if (opts.status === 'skipped' && current.required) {
        throw new StepRequiredError(current.step_id);
      }
      // Gated steps can reach `done` ONLY from `validating` via the verdict
      // path. Gating on the TARGET (not enumerated source states) also closes
      // indirect bypasses like running → awaiting_user → done.
      const isGated = current.validation_json != null;
      if (isGated && opts.status === 'done' && !(current.status === 'validating' && opts.viaVerdict)) {
        const detail = current.status === 'validating'
          ? 'only a verifier verdict can finalize a validating step'
          : `a gated step cannot reach done from '${current.status}' — it must enter \`validating\` (claim) and pass verification`;
        throw new StepValidationRequiredError(current.step_id, detail);
      }
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

/**
 * Cascade a recipe instance to a terminal status when ALL of its steps are
 * terminal (done/failed/skipped): `failure` if any step failed, else `success`.
 *
 * This is the SINGLE source of truth for instance completion. It is called from
 * BOTH terminal-transition paths — the agent-facing `recipe.steps.update_status`
 * tool (`updateStatusImpl`) AND the validator's verdict-apply path
 * (`applyGateVerdicts`). Without the latter, a recipe whose final step is
 * validation-gated would complete every step yet leave the instance stuck in
 * `running` forever, because a gated step only reaches `done` via the worker's
 * verdict (never the agent path).
 *
 * Idempotent: the UPDATE is guarded by `status = 'running'`, so repeated or
 * concurrent calls are safe. Returns the instance status after the attempt, or
 * `null` when the instance is unknown or not all steps are terminal yet.
 */
export function cascadeInstanceIfAllTerminal(
  db: Database,
  recipe_instance_id: string,
): string | null {
  const siblings = listSteps(db, recipe_instance_id);
  if (siblings.length === 0) return null;
  const TERMINAL_STATUSES = new Set<RecipeStepStatus>(['done', 'failed', 'skipped']);
  if (!siblings.every((r) => TERMINAL_STATUSES.has(r.status))) return null;
  const anyFailed = siblings.some((r) => r.status === 'failed');
  const newStatus = anyFailed ? 'failure' : 'success';
  db.prepare(
    `UPDATE recipe_instances
       SET status = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(newStatus, Date.now(), recipe_instance_id);
  const row = db
    .prepare('SELECT status FROM recipe_instances WHERE id = ?')
    .get(recipe_instance_id) as { status: string } | undefined;
  return row?.status ?? null;
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
       required, validation_json, execution_json, status, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}')`,
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
        s.required ? 1 : 0,
        s.validation ? JSON.stringify(s.validation) : null,
        s.execution ? JSON.stringify(s.execution) : null,
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
         artifacts_decl_json = COALESCE(?, artifacts_decl_json),
         required = COALESCE(?, required)
       WHERE id = ?`,
    ).run(
      patch.name ?? null,
      patch.goal ?? null,
      patch.depends !== undefined ? JSON.stringify(patch.depends) : null,
      patch.params !== undefined ? JSON.stringify(patch.params) : null,
      patch.triggers !== undefined ? JSON.stringify(patch.triggers) : null,
      patch.artifacts !== undefined ? JSON.stringify(patch.artifacts) : null,
      patch.required === undefined ? null : patch.required ? 1 : 0,
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
