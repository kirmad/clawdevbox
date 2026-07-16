/**
 * recipe-validation.ts
 *
 * Pure verdict-application logic for the validation gate. The server
 * worker-loop reads a verifier's verdict file and calls applyVerdict();
 * this module is the ONLY caller that finalizes a gated step (viaVerdict).
 * Kept side-effect-narrow (DB only) so it is unit-testable without spawning
 * a real verifier.
 */

import type { Database } from 'better-sqlite3';
import {
  getStep,
  transitionStatus,
  cascadeInstanceIfAllTerminal,
  type RecipeStepRow,
} from './db/recipe-steps-store.ts';
import { appendEvent } from './db/step-events-store.ts';

export type VerdictKind = 'PASS' | 'FAIL' | 'BLOCKED';

export interface Verdict {
  verdict: VerdictKind;
  evidence: string;
  gaps?: string;
  trigger_id?: string;
}

export interface ApplyVerdictOpts {
  recipe_instance_id: string;
  step_id: string;
  verdict: Verdict;
  agent_session_id?: string | null;
}

export class VerdictError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_MAX_REWORK = 3;

export interface ApplyVerdictResult {
  status: RecipeStepRow['status'];
  rework_count: number;
  outcome: 'passed' | 'rework' | 'stalemate' | 'blocked';
}

export interface ApplyGateVerdictsArgs {
  recipe_instance_id: string;
  step_id: string;
  /** gate name → that gate's verifier verdict. Must be non-empty. */
  gateVerdicts: Record<string, Verdict>;
  agent_session_id?: string | null;
}

/**
 * Apply one-or-more gate verdicts to a single step and aggregate them under
 * AND semantics:
 *   - every gate PASS               → step done
 *   - any gate FAIL (no BLOCKED)    → rework/stalemate with COMBINED gaps
 *   - any gate BLOCKED              → awaiting_user (precedence BLOCKED > FAIL > PASS)
 *
 * Aggregation is byte-identical to the legacy single-verdict path when a
 * single gate is supplied: no `[gate]` decoration is added, so a step gated by
 * one verifier keeps the exact same evidence/gaps/message text as before. The
 * only additive changes for the single-gate case are a per-gate `gates` map on
 * `verdict_json` and a `gate` tag on each `validation_verdict` event — both are
 * harmless extra keys the downstream readers ignore.
 */
export function applyGateVerdicts(db: Database, args: ApplyGateVerdictsArgs): ApplyVerdictResult {
  const step = getStep(db, args.recipe_instance_id, args.step_id);
  if (!step) throw new VerdictError('STEP_NOT_FOUND', `step '${args.step_id}' not found`);
  if (step.status !== 'validating') {
    throw new VerdictError('NOT_VALIDATING', `step '${args.step_id}' is ${step.status}, not validating`);
  }
  if (!step.validation_json) {
    throw new VerdictError('STEP_NOT_GATED', `step '${args.step_id}' has no validation contract; nothing to verify`);
  }
  const entries = Object.entries(args.gateVerdicts);
  if (entries.length === 0) {
    throw new VerdictError('NO_VERDICTS', `applyGateVerdicts requires at least one gate verdict`);
  }
  const validation = JSON.parse(step.validation_json);
  // `max_rework` is the number of FAIL verdicts tolerated before a stalemate:
  // the Nth FAIL (rework_count reaching max_rework) escalates to awaiting_user,
  // so a step gets up to (max_rework - 1) rework loops. Default 3.
  const maxRework = (validation && typeof validation.max_rework === 'number')
    ? validation.max_rework
    : DEFAULT_MAX_REWORK;

  // A single gate reproduces the legacy verdict text exactly (no decoration);
  // multiple gates get combined, per-gate-tagged evidence + gaps.
  const single = entries.length === 1;

  // Aggregate. Precedence: BLOCKED > FAIL > PASS.
  const blocked = entries.filter(([, v]) => v.verdict === 'BLOCKED');
  const failed = entries.filter(([, v]) => v.verdict === 'FAIL');
  let aggregate: Verdict;
  if (blocked.length > 0) {
    const [, bv] = blocked[0];
    // Enforce the trigger requirement before opening the transaction so a
    // malformed BLOCKED writes nothing (same as the legacy single-gate path).
    if (!bv.trigger_id) {
      throw new VerdictError('BLOCKED_REQUIRES_TRIGGER', 'BLOCKED verdict must supply a registered trigger_id');
    }
    aggregate = { verdict: 'BLOCKED', evidence: bv.evidence, gaps: bv.gaps, trigger_id: bv.trigger_id };
  } else if (failed.length > 0) {
    aggregate = single
      ? { verdict: 'FAIL', evidence: entries[0][1].evidence, gaps: entries[0][1].gaps }
      : {
          verdict: 'FAIL',
          evidence: entries.map(([g, v]) => `[${g}: ${v.verdict}] ${v.evidence}`).join('\n'),
          gaps: failed.map(([g, v]) => `\u2022 ${g}: ${v.gaps ?? '(no specific gaps)'}`).join('\n'),
        };
  } else {
    aggregate = single
      ? { verdict: 'PASS', evidence: entries[0][1].evidence }
      : { verdict: 'PASS', evidence: entries.map(([g, v]) => `[${g}] ${v.evidence}`).join('\n') };
  }

  const tx = db.transaction((): ApplyVerdictResult => {
    // One validation_verdict audit event PER gate, each tagged with `gate`.
    for (const [gate, v] of entries) {
      appendEvent(db, {
        recipe_step_id: step.id,
        recipe_instance_id: args.recipe_instance_id,
        agent_session_id: args.agent_session_id ?? null,
        type: 'validation_verdict',
        payload: { gate, verdict: v.verdict, evidence: v.evidence, gaps: v.gaps ?? null, trigger_id: v.trigger_id ?? null },
      });
    }
    // Persist the aggregate verdict + a per-gate map for the UI.
    const perGate: Record<string, unknown> = {};
    for (const [g, v] of entries) perGate[g] = { verdict: v.verdict, evidence: v.evidence, gaps: v.gaps ?? null };
    const verdictJson = JSON.stringify({ ...aggregate, gates: perGate });
    return applyAggregate(db, step, aggregate, verdictJson, maxRework);
  });
  return tx();
}

/**
 * Shared transition + rework logic for an already-aggregated verdict. Assumes
 * a BLOCKED verdict has a validated `trigger_id`. Callers run this inside a
 * `db.transaction` and are responsible for having emitted their audit events.
 */
function applyAggregate(
  db: Database,
  step: RecipeStepRow,
  aggregate: Verdict,
  verdictJson: string,
  maxRework: number,
): ApplyVerdictResult {
  const persistVerdictJson = () => {
    db.prepare(`UPDATE recipe_steps SET verdict_json = ? WHERE id = ?`).run(verdictJson, step.id);
  };

  if (aggregate.verdict === 'PASS') {
    transitionStatus(db, step.id, { status: 'done', result: aggregate.evidence, viaVerdict: true });
    persistVerdictJson();
    // A gated step reaches `done` ONLY here (never via the agent update_status
    // path), so this is the sole place that can complete a recipe whose final
    // step is validation-gated. Cascade the instance to terminal when every
    // sibling is now terminal — mirrors updateStatusImpl's exit hook.
    cascadeInstanceIfAllTerminal(db, step.recipe_instance_id);
    return { status: 'done', rework_count: step.rework_count, outcome: 'passed' };
  }

  if (aggregate.verdict === 'BLOCKED') {
    transitionStatus(db, step.id, {
      status: 'awaiting_user',
      viaVerdict: true,
      awaiting_user_message: `Blocked on external event; watcher ${aggregate.trigger_id}. ${aggregate.evidence}`,
    });
    persistVerdictJson();
    return { status: 'awaiting_user', rework_count: step.rework_count, outcome: 'blocked' };
  }

  // FAIL — increment rework ONCE per aggregate (not once per failed gate).
  const nextRework = step.rework_count + 1;
  db.prepare(`UPDATE recipe_steps SET rework_count = ? WHERE id = ?`).run(nextRework, step.id);
  if (nextRework >= maxRework) {
    transitionStatus(db, step.id, {
      status: 'awaiting_user',
      viaVerdict: true,
      awaiting_user_message: `Validation stalemate after ${nextRework} attempts. Gaps: ${aggregate.gaps ?? '(none given)'}`,
    });
    persistVerdictJson();
    return { status: 'awaiting_user', rework_count: nextRework, outcome: 'stalemate' };
  }
  transitionStatus(db, step.id, {
    status: 'running',
    viaVerdict: true,
    message: `Validation FAILED (attempt ${nextRework}). Fix: ${aggregate.gaps ?? '(no gaps given)'}`,
  });
  persistVerdictJson();
  return { status: 'running', rework_count: nextRework, outcome: 'rework' };
}

/**
 * Single-gate wrapper: one gate named 'default'. Same transitions + rework
 * semantics as the legacy path. The single validation_verdict event now
 * carries gate:'default' and verdict_json gains a `gates` map (both harmless —
 * the rounds reader treats a missing/one gate as the sole gate).
 */
export function applyVerdict(db: Database, opts: ApplyVerdictOpts): ApplyVerdictResult {
  return applyGateVerdicts(db, {
    recipe_instance_id: opts.recipe_instance_id,
    step_id: opts.step_id,
    agent_session_id: opts.agent_session_id,
    gateVerdicts: { default: opts.verdict },
  });
}
