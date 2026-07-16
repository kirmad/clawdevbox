/**
 * recipe-validation-worker.ts
 *
 * Server worker-loop that services validation-gated recipe steps: for each
 * step in `validating`, spawn a headless verifier, read its verdict file,
 * apply the verdict (recipe-validation.applyVerdict), and deliver the next
 * step (PASS) or a "reverted to active" + gaps message (FAIL) back to the
 * worker session. Mirrors idle-reaper.ts's single-query-per-tick structure.
 *
 * All spawn + delivery is injectable (opts hatches) so the loop is unit-
 * testable with a fake verifier that writes a deterministic verdict file.
 *
 * This module (Task 3) contains only the pure helpers; the loop lands next.
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { applyVerdict, applyGateVerdicts, type Verdict, type VerdictKind, type ApplyVerdictResult } from './recipe-validation.ts';
import { listStepsByStatus, transitionStatus, normalizeValidation, computeReadySteps, normalizeExecution, resolveLane, type RecipeStepRow } from './db/recipe-steps-store.ts';
import { appendEvent } from './db/step-events-store.ts';
import { runRecipe } from './recipe-runner.ts';
import { dispatchOnly, spawnDispatchOrResume, type SessionHelperCtx } from './session-helpers.ts';
import { logger } from './logger.ts';
import { getLaneSession } from './db/lane-sessions-store.ts';

/** Resolve a step's lane from its stored execution_json ('main' by default). */
function stepLane(step: RecipeStepRow): string {
  return resolveLane(step.execution_json ? normalizeExecution(JSON.parse(step.execution_json)) : null, step.step_id);
}
import type { Dispatcher } from './dispatcher.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';

/**
 * Deterministic verdict-file path for a verifier run. Derived from the
 * workspace dir + instance + step + attempt so a re-validate (attempt++)
 * never collides with a prior verdict. Handed to the verifier via prompt+env.
 */
export function verdictFilePath(workspacePath: string, recipeInstanceId: string, stepId: string, attempt: number, gate?: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  const base = `${safe(recipeInstanceId)}__${safe(stepId)}__attempt${attempt}`;
  const suffix = gate ? `__${safe(gate)}` : '';
  return join(workspacePath, '.clawdevbox', 'validation', `${base}${suffix}.verdict.json`);
}

/** Role prompt for the headless verifier. Self-serves recipe context. */
export function buildVerifierPrompt(args: {
  recipeInstanceId: string; stepId: string; verdictFile: string;
  criteria?: string; claimedEvidence?: string; mode: string;
  gateName?: string; gateCount?: number;
}): string {
  const criteria = args.criteria?.trim()
    ? `Acceptance criteria (author-provided):\n${args.criteria}`
    : `No explicit criteria were given — derive them from the step goal + recipe invariants (read them via recipe.instance.get({ recipe_instance_id: "${args.recipeInstanceId}" })).`;
  const lines = [
    `You are an INDEPENDENT validation agent for recipe instance ${args.recipeInstanceId}, step "${args.stepId}".`,
    `Verification mode: ${args.mode}.`,
    '',
    'Your job: independently verify that the step\'s claimed outcome is ACTUALLY true. Assume the worker may be wrong. Do NOT trust the claim — verify it with tools (read artifacts, run git/az/tests, query ADO, etc.).',
    '',
    `Pull your own context: call recipe.instance.get({ recipe_instance_id: "${args.recipeInstanceId}" }) and artifact.list({ recipe_instance_id: "${args.recipeInstanceId}" }); read whatever artifacts/results you need.`,
    '',
    criteria,
    '',
    args.claimedEvidence ? `The worker's claimed evidence:\n${args.claimedEvidence}` : 'The worker provided no explicit evidence.',
    '',
    'When done, WRITE YOUR VERDICT as JSON to this exact file path (create parent dirs if needed):',
    `  ${args.verdictFile}`,
    'The JSON MUST be: { "verdict": "PASS" | "FAIL" | "BLOCKED", "evidence": "<what you verified>", "gaps": "<for FAIL: exactly what is missing/wrong to fix>", "trigger_id": "<for BLOCKED only: a REAL registered trigger id that will resume this recipe>" }',
    'Rules: PASS only if the outcome is really true. FAIL if not — list concrete gaps. BLOCKED only if genuinely gated on an external event AND you registered a real resuming trigger (verify it via trigger.instance.list) and put its id in trigger_id.',
    'Write ONLY the JSON file. Then stop.',
  ];
  // Multi-gate steps fan out one verifier per gate; each gate must stay in its
  // own lane so its verdict file (path handed above) is the ONLY one it writes.
  if (args.gateCount && args.gateCount > 1) {
    lines.unshift(
      `You are gate "${args.gateName}" — one of ${args.gateCount} independent validation gates on this step. Verify ONLY your own concern (below); write ONLY your own verdict file at the exact path given.`,
      '',
    );
  }
  return lines.join('\n');
}

/** Delivery prompt to the worker session after a verdict is applied. */
export function buildDeliveryPrompt(args: {
  outcome: ApplyVerdictResult['outcome'];
  stepId: string; verdict: Verdict; nextStepPrompt?: string;
}): string {
  if (args.outcome === 'passed') {
    return [
      `✅ Step "${args.stepId}" passed validation and is now DONE.`,
      args.verdict.evidence ? `Verifier evidence: ${args.verdict.evidence}` : '',
      '',
      args.nextStepPrompt ?? 'No further steps are ready — await the next ready step or finalize.',
    ].filter(Boolean).join('\n');
  }
  if (args.outcome === 'rework') {
    return [
      `⚠️ Step "${args.stepId}" did NOT pass validation. Its state has been REVERTED TO ACTIVE (running) — it is NOT done.`,
      `You must address the following and then mark the step done again (it will be re-verified):`,
      `Gaps: ${args.verdict.gaps ?? '(verifier gave no specific gaps — re-read the criteria and self-check)'}`,
      args.verdict.evidence ? `Verifier notes: ${args.verdict.evidence}` : '',
    ].filter(Boolean).join('\n');
  }
  if (args.outcome === 'stalemate') {
    return [
      `⛔ Step "${args.stepId}" failed validation repeatedly and is now awaiting a human decision (state: awaiting_user).`,
      `Do not retry automatically. Latest gaps: ${args.verdict.gaps ?? '(none given)'}.`,
    ].join('\n');
  }
  // blocked
  return [
    `⏸️ Step "${args.stepId}" is BLOCKED on an external event (state: awaiting_user); a watcher (${args.verdict.trigger_id ?? 'unknown'}) will resume it.`,
    `Do not mark it done manually. ${args.verdict.evidence ?? ''}`.trim(),
  ].join('\n');
}

/** Read + parse a verdict file. Returns null if missing/unparseable (infra fail). */
export function readVerdictFile(path: string): Verdict | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    const kind = parsed?.verdict as VerdictKind;
    if (kind !== 'PASS' && kind !== 'FAIL' && kind !== 'BLOCKED') return null;
    if (typeof parsed.evidence !== 'string') return null;
    return {
      verdict: kind,
      evidence: parsed.evidence,
      gaps: typeof parsed.gaps === 'string' ? parsed.gaps : undefined,
      trigger_id: typeof parsed.trigger_id === 'string' ? parsed.trigger_id : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Recompute the SAME aggregate `Verdict` that `applyGateVerdicts`
 * (recipe-validation.ts) persists for a multi-gate step, purely so the worker's
 * delivery prompt shows the exact combined evidence/gaps the applied verdict
 * used. SOURCE OF TRUTH is `applyGateVerdicts` — this replicates its precedence
 * (BLOCKED > FAIL > PASS) and per-gate decoration verbatim; keep the two in
 * lockstep. Replicated (not imported) to keep this change confined to the
 * worker module. Only called after `applyGateVerdicts` has already accepted the
 * verdicts, so a BLOCKED aggregate is guaranteed to carry a validated trigger_id.
 */
function aggregateVerdictFor(gateVerdicts: Record<string, Verdict>): Verdict {
  const entries = Object.entries(gateVerdicts);
  const single = entries.length === 1;
  const blocked = entries.filter(([, v]) => v.verdict === 'BLOCKED');
  const failed = entries.filter(([, v]) => v.verdict === 'FAIL');
  if (blocked.length > 0) {
    const [, bv] = blocked[0];
    return { verdict: 'BLOCKED', evidence: bv.evidence, gaps: bv.gaps, trigger_id: bv.trigger_id };
  }
  if (failed.length > 0) {
    return single
      ? { verdict: 'FAIL', evidence: entries[0][1].evidence, gaps: entries[0][1].gaps }
      : {
          verdict: 'FAIL',
          evidence: entries.map(([g, v]) => `[${g}: ${v.verdict}] ${v.evidence}`).join('\n'),
          gaps: failed.map(([g, v]) => `\u2022 ${g}: ${v.gaps ?? '(no specific gaps)'}`).join('\n'),
        };
  }
  return single
    ? { verdict: 'PASS', evidence: entries[0][1].evidence }
    : { verdict: 'PASS', evidence: entries.map(([g, v]) => `[${g}] ${v.evidence}`).join('\n') };
}

// ── worker loop ────────────────────────────────────────────────────────────

/**
 * Per-attempt, per-gate spawn bookkeeping persisted in `validation_runs_json`
 * for multi-gate steps. Keyed by attempt so a re-claim / infra-retry that bumps
 * `validation_attempt` is detected as stale and every gate re-runs fresh.
 */
interface ValidationRuns {
  attempt: number;
  gates: Record<string, { verifier_session_id: string; started_at: number }>;
}

export interface ValidationWorkerOpts {
  db: Database;
  /** Spawn a headless verifier for a validating step. Resolves once SPAWNED
   *  (not once it finishes) — the loop reads the verdict file on later ticks.
   *  Returns the verifier's session id (bookkeeping). */
  spawnVerifier: (args: {
    step: RecipeStepRow; verdictFile: string; prompt: string; workspacePath: string;
    verifier?: { provider?: string; agent?: string; model?: string };
  }) => Promise<{ sessionId: string }>;
  /** Deliver a prompt to the worker session that owns this recipe instance
   *  (resumes it if idle). */
  deliverToWorker: (args: { recipeInstanceId: string; prompt: string; lane?: string }) => Promise<void>;
  /** Compute the next-ready-step prompt after a PASS (or null if none ready). */
  nextStepPrompt: (args: { recipeInstanceId: string; doneStepId: string; lane?: string }) => Promise<string | null>;
  /** Resolve the workspace path for an instance (for the verdict file + spawn cwd). */
  workspacePathFor: (recipeInstanceId: string) => string;
  intervalMs?: number;         // default 15_000
  maxAttempts?: number;        // verifier respawn cap on infra failure, default 3
  verdictTimeoutMs?: number;   // wait for a verdict file before infra-retry, default 600_000
}

export interface ValidationWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

/**
 * Periodic worker-loop that services validation-gated steps. Mirrors
 * idle-reaper.ts: a single `listStepsByStatus('validating')` scan per tick,
 * an overlap guard (`running`), a `stopped` flag, and an `unref`'d interval so
 * the loop never keeps the process alive on its own.
 *
 * All I/O beyond the DB — spawning the verifier and delivering prompts back to
 * the worker session — is injected via `opts`, so the loop is unit-testable
 * with a fake verifier that writes a deterministic verdict file (no real pty).
 *
 * Per-step state machine (across ticks; each tick re-queries so it always sees
 * fresh `verifier_session_id` / `validation_attempt`). A step with 0 or 1 gate
 * uses this single-verifier path unchanged:
 *   1. verdict file exists     → applyVerdict + deliver (PASS/FAIL/stalemate/blocked).
 *   2. no verdict, no verifier → spawn one, record its session id + attempt.
 *   3. verifier running, stale → infra retry (bump attempt, clear verifier),
 *                                or escalate to awaiting_user once attempts are spent.
 * A step with >1 gate fans out one verifier PER gate (each writing its own
 * gate-suffixed verdict file), tracks per-gate spawn state in
 * `validation_runs_json`, and applies the aggregate (applyGateVerdicts) only
 * once every gate has returned a verdict.
 */
export function startValidationWorker(opts: ValidationWorkerOpts): ValidationWorkerHandle {
  const intervalMs = opts.intervalMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const verdictTimeoutMs = opts.verdictTimeoutMs ?? 600_000;
  let stopped = false;
  let running = false;

  /**
   * Treat a stuck/failed verifier as an infra failure: bump the attempt and
   * clear the verifier so a fresh one spawns next tick, up to `maxAttempts`,
   * then escalate to `awaiting_user` for a human. Shared by the spawn-failure
   * path (step 2) and the verdict-timeout path (step 3) so BOTH are bounded and
   * visible — a persistently failing spawn can never loop silently forever.
   */
  function retryOrEscalate(step: RecipeStepRow, reason: 'verdict_timeout' | 'spawn_failed', humanPhrase: string): void {
    const nextAttempt = step.validation_attempt + 1;
    if (nextAttempt >= maxAttempts) {
      transitionStatus(opts.db, step.id, {
        status: 'awaiting_user', viaVerdict: true,
        awaiting_user_message: `Validation could not complete after ${nextAttempt} verifier attempts (${humanPhrase}). Human review needed.`,
      });
      appendEvent(opts.db, {
        recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
        type: 'validation_error', payload: { attempt: nextAttempt, reason: `${reason}_escalated` },
      });
    } else {
      opts.db.prepare(`UPDATE recipe_steps SET validation_attempt = ?, verifier_session_id = NULL, validation_runs_json = NULL, started_at = ? WHERE id = ?`)
        .run(nextAttempt, Date.now(), step.id);
      appendEvent(opts.db, {
        recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
        type: 'validation_error', payload: { attempt: nextAttempt, reason: `${reason}_retry` },
      });
    }
  }

  async function handleStep(step: RecipeStepRow): Promise<void> {
    const wsPath = opts.workspacePathFor(step.recipe_instance_id);
    const attempt = step.validation_attempt;

    // Gate topology drives routing. A step with 0 or 1 gate keeps the ORIGINAL
    // single-verifier path below verbatim — identical verdict-file path (no gate
    // suffix), prompt, and applyVerdict — so in-flight single-gate steps and the
    // deployed server stay byte-compatible. A step with >1 gate fans out to one
    // verifier per gate in the multi-gate branch that follows.
    const gates = normalizeValidation(step.validation_json ? JSON.parse(step.validation_json) : null)?.gates ?? [];

    if (gates.length <= 1) {
      const verdictFile = verdictFilePath(wsPath, step.recipe_instance_id, step.step_id, attempt);

      // 1. If a verdict file already exists, apply it + deliver.
      const verdict = readVerdictFile(verdictFile);
      if (verdict) {
        const res = applyVerdict(opts.db, {
          recipe_instance_id: step.recipe_instance_id, step_id: step.step_id, verdict,
        });
        let nextPrompt: string | null | undefined;
        if (res.outcome === 'passed') {
          nextPrompt = await opts.nextStepPrompt({ recipeInstanceId: step.recipe_instance_id, doneStepId: step.step_id, lane: stepLane(step) });
        }
        const deliver = buildDeliveryPrompt({
          outcome: res.outcome, stepId: step.step_id, verdict, nextStepPrompt: nextPrompt ?? undefined,
        });
        await opts.deliverToWorker({ recipeInstanceId: step.recipe_instance_id, prompt: deliver, lane: stepLane(step) });
        return;
      }

      // 2. No verdict yet + no verifier spawned for THIS attempt → spawn one.
      //    A spawn failure is an infra failure: bound it via retryOrEscalate so a
      //    persistently broken verifier (e.g. bad agent_cli) escalates to a human
      //    after maxAttempts instead of looping every tick and leaking instances.
      if (step.verifier_session_id == null) {
        // Read mode/criteria from the NORMALIZED gate (validation_json is the
        // canonical {gates:[…]} shape that buildStepDecls writes), NOT the raw
        // top level — otherwise a single-gate 'artifacts'/'judge' step or one
        // with explicit criteria is silently verified as 'evidence' with none.
        const gate = gates[0];
        const prompt = buildVerifierPrompt({
          recipeInstanceId: step.recipe_instance_id, stepId: step.step_id, verdictFile,
          criteria: gate?.criteria, claimedEvidence: step.result ?? undefined, mode: gate?.mode ?? 'evidence',
        });
        let sessionId: string;
        try {
          ({ sessionId } = await opts.spawnVerifier({
            step, verdictFile, prompt, workspacePath: wsPath,
            verifier: { provider: gate?.verifier_provider, agent: gate?.verifier_agent, model: gate?.verifier_model },
          }));
        } catch (err) {
          logger.warn({ err: String(err), step_id: step.step_id, attempt }, 'validation-worker: verifier spawn failed');
          retryOrEscalate(step, 'spawn_failed', 'verifier could not be spawned');
          return;
        }
        opts.db.prepare(`UPDATE recipe_steps SET verifier_session_id = ?, started_at = ? WHERE id = ?`)
          .run(sessionId, Date.now(), step.id);
        appendEvent(opts.db, {
          recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
          type: 'validation_started', payload: { attempt, verifier_session_id: sessionId, verdict_file: verdictFile },
        });
        return;
      }

      // 3. Verifier running, no verdict yet. If it exceeded the timeout, treat as
      //    infra failure: bump attempt + clear verifier so a fresh one spawns next
      //    tick, up to maxAttempts, then escalate to awaiting_user.
      const startedAt = step.started_at ?? Date.now();
      if (Date.now() - startedAt > verdictTimeoutMs) {
        retryOrEscalate(step, 'verdict_timeout', 'no verdict produced');
      }
      return;
    }

    // ── multi-gate path ────────────────────────────────────────────────────
    // One verifier per gate, in parallel, each writing its OWN verdict file.
    // Per-gate spawn state lives in validation_runs_json (keyed by attempt so a
    // re-claim / infra-retry that bumps the attempt starts every gate fresh).
    // We aggregate + apply only once EVERY gate has produced a verdict.
    // Parse fail-closed (like readVerdictFile): a corrupt/mis-shaped runs row
    // self-heals into a fresh attempt rather than wedging the step in validating.
    let runs: ValidationRuns = { attempt, gates: {} };
    try {
      const runsRaw = step.validation_runs_json ? JSON.parse(step.validation_runs_json) : null;
      if (runsRaw && runsRaw.attempt === attempt && runsRaw.gates && typeof runsRaw.gates === 'object') {
        runs = runsRaw as ValidationRuns;
      }
    } catch {
      /* corrupt validation_runs_json → start this attempt fresh */
    }
    const verdicts: Record<string, Verdict> = {};
    let missing = 0;
    for (const g of gates) {
      const vpath = verdictFilePath(wsPath, step.recipe_instance_id, step.step_id, attempt, g.name);
      const v = readVerdictFile(vpath);
      if (v) { verdicts[g.name] = v; continue; }
      missing += 1;
      if (runs.gates[g.name]?.verifier_session_id == null) {
        const prompt = buildVerifierPrompt({
          recipeInstanceId: step.recipe_instance_id, stepId: step.step_id, verdictFile: vpath,
          criteria: g.criteria, claimedEvidence: step.result ?? undefined, mode: g.mode,
          gateName: g.name, gateCount: gates.length,
        });
        try {
          const { sessionId } = await opts.spawnVerifier({
            step, verdictFile: vpath, prompt, workspacePath: wsPath,
            verifier: { provider: g.verifier_provider, agent: g.verifier_agent, model: g.verifier_model },
          });
          runs.gates[g.name] = { verifier_session_id: sessionId, started_at: Date.now() };
          appendEvent(opts.db, {
            recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
            type: 'validation_started', payload: { gate: g.name, attempt, verifier_session_id: sessionId, verdict_file: vpath },
          });
        } catch (err) {
          logger.warn({ err: String(err), step_id: step.step_id, gate: g.name }, 'validation-worker: gate verifier spawn failed');
          opts.db.prepare(`UPDATE recipe_steps SET validation_runs_json = ? WHERE id = ?`).run(JSON.stringify(runs), step.id);
          retryOrEscalate(step, 'spawn_failed', `verifier for gate '${g.name}' could not be spawned`);
          return;
        }
      }
    }
    opts.db.prepare(`UPDATE recipe_steps SET validation_runs_json = ? WHERE id = ?`).run(JSON.stringify(runs), step.id);

    if (missing === 0) {
      const res = applyGateVerdicts(opts.db, {
        recipe_instance_id: step.recipe_instance_id, step_id: step.step_id, gateVerdicts: verdicts,
      });
      let nextPrompt: string | null | undefined;
      if (res.outcome === 'passed') {
        nextPrompt = await opts.nextStepPrompt({ recipeInstanceId: step.recipe_instance_id, doneStepId: step.step_id, lane: stepLane(step) });
      }
      const deliver = buildDeliveryPrompt({
        outcome: res.outcome, stepId: step.step_id, verdict: aggregateVerdictFor(verdicts), nextStepPrompt: nextPrompt ?? undefined,
      });
      await opts.deliverToWorker({ recipeInstanceId: step.recipe_instance_id, prompt: deliver, lane: stepLane(step) });
      return;
    }

    // Some gates are still running → timeout is measured from the OLDEST gate's
    // spawn time (the whole fan-out is only as done as its slowest verifier).
    const startedAts = gates
      .map((g) => runs.gates[g.name]?.started_at)
      .filter((t): t is number => typeof t === 'number');
    const oldest = startedAts.length ? Math.min(...startedAts) : Date.now();
    if (Date.now() - oldest > verdictTimeoutMs) {
      retryOrEscalate(step, 'verdict_timeout', 'a gate verifier produced no verdict');
    }
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const steps = listStepsByStatus(opts.db, 'validating');
      for (const step of steps) {
        if (stopped) break;
        try {
          await handleStep(step);
        } catch (err) {
          logger.warn({ err: String(err), step_id: step.step_id }, 'validation-worker: step handling threw');
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick().catch((err) => logger.warn({ err: String(err) }, 'validation-worker: tick threw'));
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  logger.info({ intervalMs }, 'validation-worker: started');

  return { stop() { stopped = true; clearInterval(timer); }, async runOnce() { await tick(); } };
}

// ── real injected deps (server wiring) ───────────────────────────────────────

/** Server context the real validation-worker deps bind to. */
export interface ValidationWorkerDepsCtx {
  db: Database;
  dispatcher: Dispatcher;
  ws: Workspace;
  cfg: ResolvedConfig;
  workspacesRoot: string;
}

/**
 * Build the REAL injected deps for `startValidationWorker`, bound to a running
 * server's context. Supplies the four hatches the loop needs:
 *   - workspacePathFor: resolve an instance's workspace path from the DB.
 *   - spawnVerifier:    spawn a fresh headless AD-HOC verifier session that
 *                       runs the verifier prompt, writes the verdict JSON to
 *                       its CLAWDEVBOX_VERDICT_FILE, and exits. NOT itself gated.
 *   - deliverToWorker:  dispatch (or resume) the worker session that owns the
 *                       instance so the PASS/FAIL message reaches the agent.
 *   - nextStepPrompt:   compute the next-ready-step prompt after a PASS,
 *                       mirroring the recipe tool's ready-step cadence.
 * The loop logic itself is unchanged — this only ADDS the real deps.
 */
export function defaultValidationWorkerDeps(ctx: ValidationWorkerDepsCtx): ValidationWorkerOpts {
  const { db } = ctx;

  const workspacePathFor = (recipeInstanceId: string): string => {
    const row = db
      .prepare(`SELECT workspace_path FROM recipe_instances WHERE id = ?`)
      .get(recipeInstanceId) as { workspace_path: string } | undefined;
    if (!row?.workspace_path) {
      throw new Error(`validation-worker: no recipe_instance '${recipeInstanceId}' (cannot resolve workspace_path)`);
    }
    return row.workspace_path;
  };

  const spawnVerifier = async (args: {
    step: RecipeStepRow; verdictFile: string; prompt: string; workspacePath: string;
    verifier?: { provider?: string; agent?: string; model?: string };
  }): Promise<{ sessionId: string }> => {
    const { step, verdictFile, prompt, workspacePath, verifier } = args;
    const inst = db
      .prepare(`SELECT workspace_id, workspace_path FROM recipe_instances WHERE id = ?`)
      .get(step.recipe_instance_id) as { workspace_id: string; workspace_path: string } | undefined;
    if (!inst?.workspace_id) {
      throw new Error(`validation-worker: no recipe_instance '${step.recipe_instance_id}' (cannot spawn verifier)`);
    }
    const result = await runRecipe({
      recipeId: null, recipeSnapshot: '', isAdhoc: true,
      prompt,
      spawnMode: 'headless',
      agentCli: verifier?.provider ?? ctx.cfg.defaultAgentCli ?? 'copilot',
      agent: verifier?.agent,
      model: verifier?.model,
      workspaceInfo: { id: inst.workspace_id, path: workspacePath },
      workspacesRoot: ctx.workspacesRoot,
      ws: ctx.ws, cfg: ctx.cfg,
      extraEnv: { CLAWDEVBOX_VERDICT_FILE: verdictFile },
      params: { validation_of: step.recipe_instance_id, validation_step: step.step_id },
    });
    if (result.spawn_error) {
      throw new Error(`verifier spawn failed: ${result.spawn_error.code} ${result.spawn_error.message}`);
    }
    return { sessionId: result.session_id };
  };

  const deliverToWorker = async (args: { recipeInstanceId: string; prompt: string; lane?: string }): Promise<void> => {
    const { recipeInstanceId, prompt, lane } = args;
    // Deliver to the OWNING lane's session so a gated non-main-lane step's
    // PASS/FAIL (rework) reaches the console that did the work — NOT the main
    // console. Fall back to the initial (main) console when the lane has no
    // recorded session (a main-lane step, or a lane not yet materialized).
    let cliSessionId: string | undefined;
    if (lane) {
      const ls = getLaneSession(db, recipeInstanceId, lane);
      if (ls?.cli_session_id) cliSessionId = ls.cli_session_id;
    }
    if (!cliSessionId) {
      const row = db
        .prepare(
          `SELECT cli_session_id FROM agent_sessions
            WHERE recipe_instance_id = ? AND cli_session_id IS NOT NULL
            ORDER BY started_at DESC LIMIT 1`,
        )
        .get(recipeInstanceId) as { cli_session_id: string } | undefined;
      cliSessionId = row?.cli_session_id;
    }
    if (!cliSessionId) {
      logger.warn({ recipe_instance_id: recipeInstanceId, lane }, 'validation-worker: no cli_session for instance/lane; cannot deliver');
      return;
    }
    const shCtx: SessionHelperCtx = { db, dispatcher: ctx.dispatcher, ws: ctx.ws, cfg: ctx.cfg };
    const d = await dispatchOnly(shCtx, { session_id: cliSessionId, prompt });
    if (!d.ok) {
      // pty not live → resume the archived session and deliver.
      await spawnDispatchOrResume(shCtx, { session_id: cliSessionId, prompt });
    }
  };

  const nextStepPrompt = async (args: { recipeInstanceId: string; doneStepId: string; lane?: string }): Promise<string | null> => {
    const ready = computeReadySteps(db, args.recipeInstanceId, args.lane);
    const blocks = ready.map((s) => {
      const lines = [`▶ NEXT STEP: ${s.step_id}`, `  Goal: ${s.goal}`];
      if (s.ai_instructions) lines.push(`  Instructions: ${s.ai_instructions}`);
      return lines.join('\n');
    });
    return blocks.length > 0 ? blocks.join('\n\n') : null;
  };

  return { db, spawnVerifier, deliverToWorker, nextStepPrompt, workspacePathFor };
}
