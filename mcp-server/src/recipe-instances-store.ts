/**
 * recipe-instances-store.ts (DB-first; JSON file is a debounced legacy mirror)
 *
 * Storage for recipe-run instances (spec §6.1). Phase 5 — the SQLite
 * kernel DB is the canonical store. The legacy on-disk
 * `<workspace>/.clawdevbox/recipe-instances/<id>.json` files are
 * preserved as a debounced write-through mirror so that:
 *
 *   - existing scripts / test fixtures that inspect the JSON file shape
 *     keep working
 *   - the on-disk files remain available for human inspection
 *
 * Writes go to the DB synchronously (upsert via `upsertInstanceToDb`);
 * the per-instance JSON file is scheduled 500ms after each write
 * (mirrors the inbox pattern). Reads prefer the DB row; the JSON file
 * is only used as a backward-compat fallback when the DB has no matching
 * row (pre-V5 instances that were never re-saved).
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

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDatabase } from './db/index.ts';
import { ensureWorkspace } from './db/workspaces-store.ts';
import { type StepEventRow } from './db/step-events-store.ts';
import { normalizeValidation, normalizeExecution, resolveLane } from './db/recipe-steps-store.ts';
import { getLaneSession } from './db/lane-sessions-store.ts';
import { emitChange } from './event-bus.ts';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Types (preserved for API compatibility)
// ============================================================================

export type RecipeInstanceStatus = 'running' | 'success' | 'failure' | 'cancelled';
export type RecipeStepStatus = 'pending' | 'running' | 'validating' | 'done' | 'failed' | 'awaiting_user' | 'skipped';

/**
 * A resolved pointer to the CLI terminal that drives a step or verifier round.
 * `instance_id` is what the SPA's terminal sidebar `selectTerminal(id)` opens
 * (it equals a `recipe_instance_id`); `cli_session_id` is the driving CLI
 * conversation GUID, kept for display/debug only.
 */
export interface TerminalRef {
  instance_id: string;
  cli_session_id?: string;
}

export interface RecipeStep {
  /** Stable step id within the recipe (e.g. 'analyze-diffs', 'step-3'). */
  id: string;
  /** Display title — the human-readable TL;DR for the UI. */
  title: string;
  /**
   * Full agent-facing prompt for this step. Optional — when omitted the
   * step is purely informational / gate-only (no agent execution
   * required). The UI renders this in a collapsible "Agent instructions"
   * panel beneath the title.
   */
  ai_instructions?: string;
  /** When true, the step is a non-negotiable gate and cannot be skipped. */
  required?: boolean;
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
  /**
   * Present ONLY when the step is validation-gated (its recipe declared a
   * `validation:` block). Drives the "gated / validating / verified" UI.
   */
  validation?: StepValidation;
  /**
   * The execution lane this step runs on (`main` for the orchestrator console,
   * a named session, or `__step:<id>` for an implicit fresh-session step).
   * Present for non-`main` lanes so the UI can badge/deep-link them.
   */
  lane?: string;
  /** Resolved terminal for this step's driving session (from its lane). */
  terminal?: TerminalRef;
}

export type VerdictKind = 'PASS' | 'FAIL' | 'BLOCKED';

/** A single independent verifier verdict (rendered as one round in the UI). */
export interface ValidationRound {
  /** 0-based validation attempt this round belongs to. */
  attempt: number;
  /**
   * The gate this round belongs to. Single-gate steps tag every round with the
   * sole gate's name; multi-gate steps carry one round per (attempt, gate).
   */
  gate?: string;
  /** The gate's verification mode (`evidence` | `artifacts` | `judge`). */
  mode?: string;
  /** The verifier's verdict, once decided. Absent while still running. */
  verdict?: VerdictKind;
  /** The verifier's independent evidence / reasoning. */
  evidence?: string;
  /** For a FAIL: the concrete gaps the worker must address. */
  gaps?: string;
  /** When the verifier for this round was spawned (validation_started). */
  started_at?: number;
  /** When the verdict was applied (validation_verdict). */
  decided_at?: number;
  /** The verifier's session id (for deep-linking to its run). */
  verifier_session_id?: string;
  /** Resolved terminal for this verifier round (from `verifier_session_id`). */
  terminal?: TerminalRef;
  /** Infra failure for this round (e.g. verifier timed out) — not a FAIL verdict. */
  error?: string;
}

/** Validation-gate state for a single gated step, surfaced to the UI. */
export interface StepValidation {
  /**
   * Gate mode of the FIRST gate (`evidence` | `artifacts` | …). Retained for
   * back-compat with single-gate consumers; multi-gate detail lives in `gates`.
   */
  mode: string;
  /** Optional author-provided acceptance criteria (first gate, back-compat). */
  criteria?: string;
  /** Every declared gate on this step (≥ 1). Single-gate steps carry one entry. */
  gates: Array<{ name: string; mode: string; criteria?: string }>;
  /** Number of gates whose latest verdict at the current attempt is PASS. */
  passed_gates: number;
  /** Total number of gates declared on this step (= `gates.length`). */
  total_gates: number;
  /** True while an independent verifier is actively checking (status === 'validating'). */
  in_progress: boolean;
  /** Current attempt index (bumped on each re-validate after a FAIL). */
  attempt: number;
  /** How many times the step was reverted to active by a FAIL verdict. */
  rework_count: number;
  /** The live verifier's session id, when in_progress. */
  verifier_session_id?: string;
  /** The most recent applied verdict (latest round's outcome). */
  latest?: { verdict: VerdictKind; evidence: string; gaps?: string };
  /** Full per-round history — one entry per verifier run (may be several). */
  rounds: ValidationRound[];
}

/**
 * Reconstruct a step's validation state from its DB row fields + its
 * chronological `validation_*` step-events. Returns undefined for a
 * non-gated step (no `validation_json`).
 */
/**
 * Resolve a CLI session GUID to the terminal the SPA can open. Joins
 * `agent_sessions` (cli_session_id → recipe_instance_id); the newest matching
 * row wins. Returns null when the GUID is absent or unmapped (→ no icon).
 */
export function resolveTerminal(db: Database, cliSessionId: string | null | undefined): TerminalRef | null {
  if (!cliSessionId) return null;
  const row = db
    .prepare(
      `SELECT recipe_instance_id FROM agent_sessions
       WHERE cli_session_id = ? AND recipe_instance_id IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(cliSessionId) as { recipe_instance_id: string | null } | undefined;
  if (!row?.recipe_instance_id) return null;
  return { instance_id: row.recipe_instance_id, cli_session_id: cliSessionId };
}

/**
 * Resolve a step's lane + driving terminal.
 *   - `main` lane → the recipe instance's own terminal ({ instance_id }); works
 *     even for pre-lanes / non-lane recipes (no recipe_lane_sessions row needed).
 *   - a named / fresh-session lane → recipe_lane_sessions(instance, lane) →
 *     cli_session_id → resolveTerminal. Absent until that lane has a session.
 */
function resolveStepTerminal(
  db: Database,
  recipeInstanceId: string,
  executionJson: string | null,
  stepId: string,
): { lane: string; terminal?: TerminalRef } {
  let execution = null as ReturnType<typeof normalizeExecution>;
  if (executionJson) {
    try { execution = normalizeExecution(JSON.parse(executionJson)); } catch { /* malformed → main */ }
  }
  const lane = resolveLane(execution, stepId);
  if (lane === 'main') {
    return { lane, terminal: { instance_id: recipeInstanceId } };
  }
  const ls = getLaneSession(db, recipeInstanceId, lane);
  const terminal = resolveTerminal(db, ls?.cli_session_id);
  return { lane, terminal: terminal ?? undefined };
}

function buildStepValidation(
  db: Database,
  fields: {
    status: RecipeStepStatus;
    validation_json: string | null;
    verifier_session_id: string | null;
    verdict_json: string | null;
    validation_attempt: number | null;
    rework_count: number | null;
  },
  events: StepEventRow[],
): StepValidation | undefined {
  if (!fields.validation_json) return undefined;
  // `validation_json` may hold either a raw authoring shape ({mode,criteria} or
  // an array of gates) or the canonical {gates} form — normalizeValidation reads
  // all of them. A malformed/empty payload on a gated step still yields one
  // fallback gate so the UI renders a single gate rather than nothing.
  let parsed: unknown = null;
  try { parsed = JSON.parse(fields.validation_json); } catch { /* malformed → fallback gate */ }
  const cfg = normalizeValidation(parsed);
  const gates: Array<{ name: string; mode: string; criteria?: string }> =
    cfg?.gates ?? [{ name: 'evidence', mode: 'evidence' }];

  const out: StepValidation = {
    mode: gates[0]?.mode ?? 'evidence',
    gates: gates.map((g) => ({ name: g.name, mode: g.mode, ...(g.criteria ? { criteria: g.criteria } : {}) })),
    passed_gates: 0,
    total_gates: gates.length,
    in_progress: fields.status === 'validating',
    attempt: fields.validation_attempt ?? 0,
    rework_count: fields.rework_count ?? 0,
    rounds: [],
  };
  if (gates[0]?.criteria) out.criteria = gates[0].criteria;
  if (fields.verifier_session_id && fields.status === 'validating') {
    out.verifier_session_id = fields.verifier_session_id;
  }
  if (fields.verdict_json) {
    try {
      const v = JSON.parse(fields.verdict_json) as { verdict?: VerdictKind; evidence?: string; gaps?: string };
      if (v.verdict) {
        out.latest = { verdict: v.verdict, evidence: typeof v.evidence === 'string' ? v.evidence : '', ...(v.gaps ? { gaps: v.gaps } : {}) };
      }
    } catch {
      /* ignore */
    }
  }

  const attempt = fields.validation_attempt ?? 0;

  if (gates.length <= 1) {
    // ── single-gate: keep the ORIGINAL attempt-only reconstruction VERBATIM ──
    // A single-gate `validation_started` carries no `gate`, but its paired
    // `validation_verdict` carries gate:'default' — so we MUST NOT key by gate
    // here (they would never match). Order-based `cur` pairing stays identical
    // to prior behaviour; rounds are tagged with the sole gate afterwards.
    let cur: ValidationRound | null = null;
    let curAttempt = 0;
    for (const e of events) {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload_json) as Record<string, unknown>; } catch { /* ignore */ }
      if (e.type === 'validation_started') {
        curAttempt = typeof p.attempt === 'number' ? p.attempt : curAttempt;
        cur = { attempt: curAttempt, started_at: e.created_at };
        if (typeof p.verifier_session_id === 'string') cur.verifier_session_id = p.verifier_session_id;
        out.rounds.push(cur);
      } else if (e.type === 'validation_verdict') {
        if (!cur) { cur = { attempt: curAttempt }; out.rounds.push(cur); }
        if (typeof p.verdict === 'string') cur.verdict = p.verdict as VerdictKind;
        if (typeof p.evidence === 'string') cur.evidence = p.evidence;
        if (typeof p.gaps === 'string' && p.gaps) cur.gaps = p.gaps;
        cur.decided_at = e.created_at;
        cur = null;
      } else if (e.type === 'validation_error') {
        const at = typeof p.attempt === 'number' ? p.attempt : curAttempt;
        let r = cur && cur.attempt === at ? cur : out.rounds.find((x) => x.attempt === at && !x.verdict && !x.error);
        if (!r) { r = { attempt: at }; out.rounds.push(r); }
        r.error = typeof p.reason === 'string' ? p.reason : 'error';
      }
    }
    // Tag every round with the sole gate's name + mode (additive; the walk above
    // is unchanged so existing single-gate output stays byte-compatible).
    for (const r of out.rounds) {
      r.gate = gates[0]?.name ?? 'default';
      r.mode = gates[0]?.mode ?? out.mode;
    }
    out.passed_gates = out.latest?.verdict === 'PASS' ? 1 : 0;
  } else {
    // ── multi-gate: one round per (attempt, gate) ────────────────────────────
    // Both validation_started AND validation_verdict carry a real `gate` name,
    // but only validation_started carries `attempt` (applyGateVerdicts omits it
    // from the verdict event). So — exactly like the single-gate `cur` pairing,
    // generalised per gate — a verdict/error attaches to the OPEN (started,
    // undecided) round for its gate. Rounds are keyed by (attempt, gate) so
    // re-validate attempts never merge, and stay in event (push) order.
    const modeByGate = new Map(gates.map((g) => [g.name, g.mode]));
    const byKey = new Map<string, ValidationRound>();
    const openByGate = new Map<string, ValidationRound>();
    const getRound = (a: number, gate: string): ValidationRound => {
      const key = `${a}::${gate}`;
      let r = byKey.get(key);
      if (!r) {
        r = { attempt: a, gate, mode: modeByGate.get(gate) ?? out.mode };
        byKey.set(key, r);
        out.rounds.push(r);
      }
      return r;
    };
    for (const e of events) {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload_json) as Record<string, unknown>; } catch { /* ignore */ }
      const gate = typeof p.gate === 'string' ? p.gate : gates[0].name;
      if (e.type === 'validation_started') {
        const a = typeof p.attempt === 'number' ? p.attempt : 0;
        const r = getRound(a, gate);
        r.started_at = e.created_at;
        if (typeof p.verifier_session_id === 'string') r.verifier_session_id = p.verifier_session_id;
        openByGate.set(gate, r);
      } else if (e.type === 'validation_verdict') {
        let r = openByGate.get(gate);
        if (!r || r.verdict) r = getRound(typeof p.attempt === 'number' ? p.attempt : 0, gate);
        if (typeof p.verdict === 'string') r.verdict = p.verdict as VerdictKind;
        if (typeof p.evidence === 'string') r.evidence = p.evidence;
        if (typeof p.gaps === 'string' && p.gaps) r.gaps = p.gaps;
        r.decided_at = e.created_at;
        openByGate.delete(gate);
      } else if (e.type === 'validation_error') {
        const r = openByGate.get(gate) ?? getRound(typeof p.attempt === 'number' ? p.attempt : 0, gate);
        r.error = typeof p.reason === 'string' ? p.reason : 'error';
      }
    }
    // passed_gates = # distinct gates whose latest verdict at the CURRENT attempt
    // is PASS (a partial count while some gates are still undecided — the desired
    // "2/3 gates passed" signal).
    const passed = new Set<string>();
    for (const r of out.rounds) {
      if (r.attempt === attempt && r.gate && r.verdict === 'PASS') passed.add(r.gate);
    }
    out.passed_gates = passed.size;
  }
  // Resolve each round's driving verifier terminal (cli GUID → recipe_instance_id).
  for (const round of out.rounds) {
    if (round.verifier_session_id) {
      const t = resolveTerminal(db, round.verifier_session_id);
      if (t) round.terminal = t;
    }
  }
  return out;
}

/** Group a flat list of step-events by their `recipe_step_id` (row PK). */
function groupEventsByStepRow(events: StepEventRow[]): Map<string, StepEventRow[]> {
  const m = new Map<string, StepEventRow[]>();
  for (const e of events) {
    const arr = m.get(e.recipe_step_id) ?? [];
    arr.push(e);
    m.set(e.recipe_step_id, arr);
  }
  return m;
}

export interface RecipeInstance {
  id: string;
  recipe_id: string;
  /**
   * Human-readable name from the recipe YAML's `name` field. Populated
   * at creation time from the parsed recipe source so the SPA can
   * display a meaningful label instead of falling back to the opaque
   * `__adhoc_<instance_id>` recipe_id. Optional because legacy rows
   * predate the column.
   */
  recipe_name?: string;
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
  recipe_name: string | null;
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
    recipe_name: row.recipe_name ?? undefined,
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
  id: string;
  step_id: string;
  name: string | null;
  goal: string;
  status: RecipeStepStatus;
  started_at: number | null;
  completed_at: number | null;
  message: string | null;
  awaiting_user_message: string | null;
  state_json: string;
  required: number;
  validation_json: string | null;
  verifier_session_id: string | null;
  verdict_json: string | null;
  validation_attempt: number | null;
  rework_count: number | null;
  execution_json: string | null;
}

function readStepsFromDb(db: Database, recipe_instance_id: string): RecipeStep[] {
  const rows = db
    .prepare(
      `SELECT id, step_id, name, goal, status, started_at, completed_at,
              message, awaiting_user_message, state_json, required,
              validation_json, verifier_session_id, verdict_json,
              validation_attempt, rework_count, execution_json
       FROM recipe_steps
       WHERE recipe_instance_id = ?
       ORDER BY step_index ASC`,
    )
    .all(recipe_instance_id) as StepRowLite[];
  // Type-filtered, UNBOUNDED fetch (mirrors the list path). A prior
  // listEvents(limit:1000) grabbed the OLDEST 1000 events of ALL types then
  // filtered, silently dropping recent validation rounds on busy/reworked
  // instances and disagreeing with the list view.
  const validationEvents = db
    .prepare(
      `SELECT * FROM step_events
       WHERE recipe_instance_id = ?
         AND type IN ('validation_started', 'validation_verdict', 'validation_error')
       ORDER BY created_at ASC, id ASC`,
    )
    .all(recipe_instance_id) as StepEventRow[];
  const eventsByStep = groupEventsByStepRow(validationEvents);
  return rows.map((r) => {
    const state = JSON.parse(r.state_json) as Record<string, unknown>;
    const step: RecipeStep = {
      id: r.step_id,
      // `goal` is the human-readable TL;DR (the new shape). For back-compat
      // with rows written before the rename, fall back to `name`. Either way
      // the result is a ≤ 200-char short title suitable for the UI.
      title: r.goal ?? r.name ?? '(no goal)',
      status: r.status,
    };
    if (typeof state.ai_instructions === 'string' && state.ai_instructions.length > 0) {
      step.ai_instructions = state.ai_instructions;
    }
    if (r.required === 1) step.required = true;
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
    const { lane, terminal } = resolveStepTerminal(db, recipe_instance_id, r.execution_json, r.step_id);
    if (lane !== 'main') step.lane = lane;
    if (terminal) step.terminal = terminal;
    const validation = buildStepValidation(db, r, eventsByStep.get(r.id) ?? []);
    if (validation) step.validation = validation;
    return step;
  });
}

/**
 * Upsert the DB row for an instance and mirror steps + the latest
 * agent-session metadata. Idempotent — safe to call on every write.
 */
function upsertInstanceToDb(db: Database, instance: RecipeInstance, opts?: { interactive?: boolean }): void {
  const ws = ensureWorkspace(db, { path: instance.workspace_path });
  const snapshotPath = recipeSnapshotPath(instance.workspace_path, instance.id);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO recipe_instances (
         id, recipe_id, recipe_name, recipe_snapshot_path, workspace_id, workspace_path,
         parent_recipe_instance_id, prompt, params_json, started_at, status,
         completed_at, result, message
       ) VALUES (
         @id, @recipe_id, @recipe_name, @recipe_snapshot_path, @workspace_id, @workspace_path,
         @parent_recipe_instance_id, @prompt, @params_json, @started_at, @status,
         @completed_at, @result, @message
       )
       ON CONFLICT(id) DO UPDATE SET
         recipe_id = excluded.recipe_id,
         recipe_name = COALESCE(excluded.recipe_name, recipe_instances.recipe_name),
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
      recipe_name: instance.recipe_name ?? null,
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
             agent_cli, pid, started_at, status, interactive
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
        ).run(
          sid,
          instance.session_id ?? null,
          instance.id,
          ws.id,
          instance.agent_cli || 'unknown',
          instance.pid ?? null,
          instance.started_at,
          opts?.interactive ? 1 : 0,
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
    if (s.ai_instructions) stateObj.ai_instructions = s.ai_instructions;
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
// Debounced JSON mirror (per-instance file, legacy inspection only)
// ============================================================================

const JSON_MIRROR_DEBOUNCE_MS = 500;
/** Map of filePath → pending timer; one entry per in-flight debounce. */
const pendingMirrorTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedule a debounced write of the DB-authoritative instance back to the
 * legacy per-instance JSON file. Collapses rapid successive writes into one
 * flush (500ms after the last call). Fires unref'd so it doesn't prevent
 * process exit.
 */
function scheduleInstanceMirror(filePath: string, workspacePath: string, id: string): void {
  if (pendingMirrorTimers.has(filePath)) return; // already pending
  const timer = setTimeout(() => {
    pendingMirrorTimers.delete(filePath);
    const conn = safeDb();
    if (!conn) return;
    try {
      const row = conn
        .prepare('SELECT * FROM recipe_instances WHERE id = ?')
        .get(id) as RecipeInstanceRow | undefined;
      if (!row) return;
      const instance = rowToInstance(conn, row, workspacePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, JSON.stringify(instance, null, 2) + '\n');
    } catch {
      // best-effort mirror — DB is authoritative; mirror failure is non-fatal
    }
  }, JSON_MIRROR_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingMirrorTimers.set(filePath, timer);
}

// ============================================================================
// Read / write — DB-primary, JSON-mirror
// ============================================================================

export function readRecipeInstance(
  workspacePath: string,
  id: string,
): RecipeInstance | null {
  // DB-first (V5+). JSON file is fallback only for pre-V5 rows missing from DB.
  const conn = safeDb();
  if (conn) {
    try {
      const row = conn
        .prepare('SELECT * FROM recipe_instances WHERE id = ? AND workspace_path = ?')
        .get(id, workspacePath) as RecipeInstanceRow | undefined;
      if (row) return rowToInstance(conn, row, workspacePath);
    } catch {
      // fall through to JSON fallback
    }
  }
  // Legacy fallback: DB row missing but JSON file exists (pre-V5 backward compat).
  const p = recipeInstancePath(workspacePath, id);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as RecipeInstance;
    } catch {
      // corrupt file — nothing to return
    }
  }
  return null;
}

export function writeRecipeInstance(workspacePath: string, instance: RecipeInstance, opts?: { interactive?: boolean }): void {
  // 1. Snapshot sidecar — synchronous (small text file, read-on-demand for display).
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

  // 2. DB upsert — authoritative and synchronous.
  const conn = safeDb();
  if (conn) {
    try {
      upsertInstanceToDb(conn, instance, opts);
    } catch {
      // Log-worthy but non-fatal: schedule a direct JSON write as emergency fallback.
    }
  }

  // 3. Debounced JSON mirror (legacy, for human inspection / backward compat).
  scheduleInstanceMirror(
    recipeInstancePath(workspacePath, instance.id),
    workspacePath,
    instance.id,
  );

  emitChange('recipes');
}

/**
 * Fetch ALL recipe instances from the DB in 3 batched queries (instances +
 * agent_sessions + recipe_steps) joined in memory.  Avoids the N+1 pattern
 * in rowToInstance() and the per-workspace filesystem scan in
 * listRecipeInstancesInWorkspace().  Returns an empty array when the DB is
 * unavailable.
 *
 * NOTE: recipe_snapshot is intentionally omitted (set to '') — the list
 * endpoint doesn't expose it to the SPA and it requires one extra file-read
 * per row.
 */
export function listAllRecipeInstancesFromDb(): RecipeInstance[] {
  const conn = safeDb();
  if (!conn) return [];
  try {
    const rows = conn
      .prepare('SELECT * FROM recipe_instances ORDER BY started_at DESC')
      .all() as RecipeInstanceRow[];
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    // One query for all agent_sessions (latest per instance — DESC order).
    interface SessionRow {
      recipe_instance_id: string;
      agent_cli: string;
      pid: number | null;
      cli_session_id: string | null;
      resume_of_agent_session_id: string | null;
    }
    const sessions = conn
      .prepare(
        `SELECT s.recipe_instance_id, s.agent_cli, s.pid, s.cli_session_id,
                s.resume_of_agent_session_id
         FROM agent_sessions s
         WHERE s.recipe_instance_id IN (${placeholders})
         ORDER BY s.started_at DESC`,
      )
      .all(...ids) as SessionRow[];

    const sessionByInstance = new Map<string, SessionRow>();
    for (const s of sessions) {
      if (!sessionByInstance.has(s.recipe_instance_id)) {
        sessionByInstance.set(s.recipe_instance_id, s);
      }
    }

    // One query to resolve resume_of pointers.
    const resumeAgentIds = [
      ...new Set(
        sessions
          .filter((s) => s.resume_of_agent_session_id)
          .map((s) => s.resume_of_agent_session_id!),
      ),
    ];
    const resumeCliSessionById = new Map<string, string | null>();
    if (resumeAgentIds.length > 0) {
      const rp = resumeAgentIds.map(() => '?').join(',');
      (
        conn
          .prepare(`SELECT id, cli_session_id FROM agent_sessions WHERE id IN (${rp})`)
          .all(...resumeAgentIds) as Array<{ id: string; cli_session_id: string | null }>
      ).forEach((r) => resumeCliSessionById.set(r.id, r.cli_session_id));
    }

    // One query for all recipe_steps.
    interface StepRowWithInstance extends StepRowLite {
      recipe_instance_id: string;
    }
    const allSteps = conn
      .prepare(
        `SELECT id, step_id, name, goal, status, started_at, completed_at,
                message, awaiting_user_message, state_json, required,
                validation_json, verifier_session_id, verdict_json,
                validation_attempt, rework_count, execution_json, recipe_instance_id
         FROM recipe_steps
         WHERE recipe_instance_id IN (${placeholders})
         ORDER BY recipe_instance_id, step_index ASC`,
      )
      .all(...ids) as StepRowWithInstance[];

    const stepsByInstance = new Map<string, StepRowLite[]>();
    for (const { recipe_instance_id, ...s } of allSteps) {
      const arr = stepsByInstance.get(recipe_instance_id) ?? [];
      arr.push(s);
      stepsByInstance.set(recipe_instance_id, arr);
    }

    // One query for all validation step-events across these instances, so the
    // list endpoint can surface each gated step's verdict rounds without an
    // N+1. Grouped by the step's row PK (step_events.recipe_step_id).
    const validationEvents = conn
      .prepare(
        `SELECT * FROM step_events
         WHERE recipe_instance_id IN (${placeholders})
           AND type IN ('validation_started', 'validation_verdict', 'validation_error')
         ORDER BY created_at ASC, id ASC`,
      )
      .all(...ids) as StepEventRow[];
    const validationEventsByStep = groupEventsByStepRow(validationEvents);

    return rows.map((row) => {
      const session = sessionByInstance.get(row.id);
      const resume_of = session?.resume_of_agent_session_id
        ? (resumeCliSessionById.get(session.resume_of_agent_session_id) ?? null)
        : null;

      const steps = (stepsByInstance.get(row.id) ?? []).map((r): RecipeStep => {
        const state = JSON.parse(r.state_json) as Record<string, unknown>;
        const step: RecipeStep = { id: r.step_id, title: r.name ?? r.goal, status: r.status };
        if (r.required === 1) step.required = true;
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
        const { lane, terminal } = resolveStepTerminal(conn, row.id, r.execution_json, r.step_id);
        if (lane !== 'main') step.lane = lane;
        if (terminal) step.terminal = terminal;
        const validation = buildStepValidation(conn, r, validationEventsByStep.get(r.id) ?? []);
        if (validation) step.validation = validation;
        return step;
      });

      return {
        id: row.id,
        recipe_id: row.recipe_id ?? '',
        recipe_name: row.recipe_name ?? undefined,
        recipe_snapshot: '',   // omitted from list endpoint — saves file I/O
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
    });
  } catch {
    return [];
  }
}

/**
 * List every recipe instance for a workspace. DB-only query — no directory
 * scan. Returns an empty list when the DB is unavailable.
 */
export function listRecipeInstancesInWorkspace(workspacePath: string): RecipeInstance[] {
  const conn = safeDb();
  if (!conn) return [];
  try {
    const ws = ensureWorkspace(conn, { path: workspacePath });
    const rows = conn
      .prepare(
        `SELECT * FROM recipe_instances WHERE workspace_id = ?
         ORDER BY started_at DESC`,
      )
      .all(ws.id) as RecipeInstanceRow[];
    return rows.map((row) => rowToInstance(conn, row, workspacePath));
  } catch {
    return [];
  }
}
