# Recipe Validation Runtime + Recipe Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cadence (user preference):** batched task-level TDD — each task = write complete code + complete tests, run the suite + typecheck, commit. Full coverage, no per-assertion red→green ceremony.

**Goal:** Make the opt-in validation gate *live end-to-end*: a gated recipe step, on the agent's normal `→ done`, is transparently auto-claimed into `validating`; a server worker-loop spawns a headless verifier that writes a verdict file; the loop applies the verdict (`applyVerdict`) and delivers the next step (PASS) or a "reverted to active" + gaps message (FAIL) back into the worker's session. Then gate `implement-work-item` per spec §10.

**Architecture:** Mirror the existing `startIdleReaper` worker-loop. Add `listStepsByStatus`, an auto-claim shim in `updateStatusImpl`, a `startValidationWorker` loop with an injectable `spawnVerifier` test-hatch + a deterministic verdict-file path, and claim-and-release delivery via `dispatcher.dispatchToInstance` / `dispatchOnly`. All spawn/delivery is injectable so the loop is unit-testable with a fake verifier (no real pty). Wire into `start.ts` like the reaper.

**Tech Stack:** TypeScript (tsx / `--experimental-strip-types`), better-sqlite3, `node:test`, tmux-backed CLI providers (`copilot` headless), `echo-stub` for tests. Spec: `docs/superpowers/specs/2026-07-14-recipe-step-validation-and-isolated-execution-design.md` (§5.3–5.7). Backend core already merged (migrations v14/v15, `validating` state, `applyVerdict`, the gate guard).

---

## File structure

- Modify `mcp-server/src/db/recipe-steps-store.ts` — add `listStepsByStatus(db, status)`.
- Modify `mcp-server/src/recipe-step-tools.ts` — auto-claim shim in `updateStatusImpl` (gated `→ done` ⇒ `→ validating` capturing evidence).
- Create `mcp-server/src/recipe-validation-worker.ts` — `startValidationWorker(opts)`: scan → spawn verifier → read verdict file → `applyVerdict` → deliver. Pure helpers: `verdictFilePath()`, `buildVerifierPrompt()`, `buildDeliveryPrompt()`, `readVerdictFile()`.
- Modify `mcp-server/src/cli/start.ts` — start + stop the worker beside `startIdleReaper`.
- Tests:
  - `mcp-server/tests/recipe-validation-worker.test.mjs` — loop logic with injected fake `spawnVerifier` + fake delivery.
  - Extend `mcp-server/tests/recipe-step-validation.test.mjs` — auto-claim shim.

All commands run from `mcp-server/`. Wire any NEW test file into the `test` script in `package.json` (explicit list) next to `tests/recipe-step-validation.test.mjs`.

---

### Task 1: `listStepsByStatus` — cross-instance status scan

**Files:**
- Modify: `mcp-server/src/db/recipe-steps-store.ts` (add exported fn near `listSteps`)
- Test: `mcp-server/tests/recipe-validation-worker.test.mjs` (create)

- [ ] **Build.** In `recipe-steps-store.ts`, add:

```typescript
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
```

- [ ] **Tests.** Create `tests/recipe-validation-worker.test.mjs` with the harness + first test:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import {
  materializeSteps, getStep, transitionStatus, listStepsByStatus,
} from '../src/db/recipe-steps-store.ts';

export function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_vw_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

export function claim(db, instanceId, stepId, result = 'claimed result') {
  const row = getStep(db, instanceId, stepId);
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'validating', result });
  return getStep(db, instanceId, stepId);
}

test('listStepsByStatus returns validating steps across instances', () => {
  const db = open();
  const a = seed(db, [{ id: 's', goal: 'A', validation: { mode: 'evidence' } }]);
  const b = seed(db, [{ id: 's', goal: 'B', validation: { mode: 'evidence' } }]);
  seed(db, [{ id: 's', goal: 'C plain' }]); // not gated, stays pending
  claim(db, a.instanceId, 's');
  claim(db, b.instanceId, 's');
  const validating = listStepsByStatus(db, 'validating');
  assert.equal(validating.length, 2);
  assert.deepEqual(validating.map((r) => r.recipe_instance_id).sort(), [a.instanceId, b.instanceId].sort());
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-validation-worker.test.mjs
npm run typecheck
git add src/db/recipe-steps-store.ts tests/recipe-validation-worker.test.mjs package.json
# (add the new test file to package.json scripts.test, next to recipe-step-validation.test.mjs)
git commit -m "feat(recipe): listStepsByStatus for the validation worker scan"
```

---

### Task 2: Auto-claim shim — gated `→ done` becomes a claim

**Files:**
- Modify: `mcp-server/src/recipe-step-tools.ts` (`updateStatusImpl`, before the transition call ~line 470)
- Test: `mcp-server/tests/recipe-step-validation.test.mjs`

**Context:** Today an agent finishing a gated step calls `update_status(status:'done', result:'...')`. The backend gate would REJECT that (running→done). Instead, transparently convert a gated step's `running → done` (or `awaiting_user → done` after rework) into a *claim*: transition to `validating`, keep the agent's `result` as the claimed evidence, and return a message telling the agent validation is in progress. Only genuinely invalid transitions still error.

- [ ] **Build.** In `updateStatusImpl`, read the current step row (it already looks up `current` via `getStep`). Immediately BEFORE the `transitionStatus` call, add the shim:

```typescript
    // Auto-claim: a gated step's `→ done` from the agent is transparently
    // converted into a validation CLAIM (→ validating). The agent's `result`
    // becomes the claimed evidence; the server worker-loop then verifies it.
    // This keeps gating transparent to recipe authors/agents. Only invalid
    // paths (e.g. validating→done without a verdict) still hit the gate error.
    let effectiveStatus = opts.status;
    let claimNote: string | undefined;
    const isGated = current.validation_json != null;
    if (
      isGated &&
      opts.status === 'done' &&
      (current.status === 'running' || current.status === 'awaiting_user') &&
      !opts.viaVerdict
    ) {
      effectiveStatus = 'validating';
      claimNote =
        'Claim recorded — this step is validation-gated. A verifier is checking your work; ' +
        'you will be notified with the next step (on pass) or with required fixes (on fail). Do not proceed.';
    }
```

Then change the `transitionStatus` call to pass `status: effectiveStatus` instead of `opts.status` (keep `result`, `message`, `state`, etc. as-is so the agent's evidence is stored on the row). After a successful transition, surface `claimNote` in the tool result — find where `updateStatusImpl` builds its return object (`out`) and set `out.message = claimNote ?? out.message` (or add a `claim: true` field if the result type allows; otherwise fold the note into the existing message field). Read the actual `UpdateStatusResult` shape and the existing return to place this correctly — do NOT invent fields the type doesn't have; prefer reusing `message`.

IMPORTANT: the shim must run only when `effectiveStatus` is being computed for a real status change; if `opts.status` is undefined (a state-only update) leave everything untouched. Guard with `opts.status === 'done'` as shown.

- [ ] **Tests.** Append to `tests/recipe-step-validation.test.mjs` (it already imports `updateStatusImpl`, `getStep`, `seed`, etc.):

```javascript
test('auto-claim: gated running→done is converted to validating (evidence kept)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  const res = updateStatusImpl(db, {
    recipe_instance_id: instanceId, step_id: 'g', status: 'done', result: 'opened PR #42',
  });
  const after = getStep(db, instanceId, 'g');
  assert.equal(after.status, 'validating');           // claimed, NOT done
  assert.match(after.result, /opened PR #42/);          // evidence preserved
  assert.match(res.step.message ?? res.message ?? '', /validation-gated|verifier|Claim recorded/i);
});

test('auto-claim: non-gated running→done still completes normally', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'p', goal: 'plain' }]);
  const row = getStep(db, instanceId, 'p');
  transitionStatus(db, row.id, { status: 'running' });
  const res = updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'p', status: 'done' });
  assert.equal(res.step.status, 'done');
});

test('auto-claim does not fire for a verdict-driven done (viaVerdict path unaffected)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = claim(db, instanceId, 'g'); // running→validating
  // simulate the worker finalizing via applyVerdict path (viaVerdict) — direct store call:
  const done = transitionStatus(db, row.id, { status: 'done', viaVerdict: true });
  assert.equal(done.status, 'done');
});
```

> Note: `res.step.message` vs `res.message` — adapt the assertion to wherever you surfaced `claimNote` (read `UpdateStatusResult`). Keep BOTH fallbacks in the assertion so it passes regardless.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
npm run typecheck
node --import tsx --test tests/recipe-step-tools.test.mjs   # regression on the tool
git add src/recipe-step-tools.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): auto-claim gated done into validating (transparent gating)"
```

---

### Task 3: Pure worker helpers — verdict path, prompts, verdict reader

**Files:**
- Create: `mcp-server/src/recipe-validation-worker.ts` (helpers only in this task)
- Test: `mcp-server/tests/recipe-validation-worker.test.mjs`

- [ ] **Build.** Create `src/recipe-validation-worker.ts` with the pure, side-effect-free helpers (the loop itself lands in Task 4):

```typescript
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
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { RecipeStepRow } from './db/recipe-steps-store.ts';
import type { Verdict, VerdictKind } from './recipe-validation.ts';

/**
 * Deterministic verdict-file path for a verifier run. Derived from the
 * workspace dir + instance + step + attempt so a re-validate (attempt++)
 * never collides with a prior verdict. Handed to the verifier via prompt+env.
 */
export function verdictFilePath(workspacePath: string, recipeInstanceId: string, stepId: string, attempt: number): string {
  const safeStep = stepId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(workspacePath, '.clawdevbox', 'validation',
    `${recipeInstanceId}__${safeStep}__attempt${attempt}.verdict.json`);
}

/** Role prompt for the headless verifier. Self-serves recipe context. */
export function buildVerifierPrompt(args: {
  recipeInstanceId: string; stepId: string; verdictFile: string;
  criteria?: string; claimedEvidence?: string; mode: string;
}): string {
  const criteria = args.criteria?.trim()
    ? `Acceptance criteria (author-provided):\n${args.criteria}`
    : 'No explicit criteria were given — derive them from the step goal + recipe invariants (read them via recipe.instance.get).';
  return [
    `You are an INDEPENDENT validation agent for recipe instance ${args.recipeInstanceId}, step "${args.stepId}".`,
    `Verification mode: ${args.mode}.`,
    '',
    'Your job: independently verify that the step\'s claimed outcome is ACTUALLY true. Assume the worker may be wrong. Do NOT trust the claim — verify it with tools (read artifacts, run git/az/tests, query ADO, etc.).',
    '',
    `Pull your own context: call recipe.instance.get() (your CLAWDEVBOX_RECIPE_INSTANCE_ID is already set) and artifact.list({ recipe_instance_id: "${args.recipeInstanceId}" }); read whatever artifacts/results you need.`,
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
  ].join('\n');
}

/** Delivery prompt to the worker session after a verdict is applied. */
export function buildDeliveryPrompt(args: {
  outcome: 'passed' | 'rework' | 'stalemate' | 'blocked';
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
```

- [ ] **Tests.** Append to `tests/recipe-validation-worker.test.mjs`:

```javascript
import { verdictFilePath, buildVerifierPrompt, buildDeliveryPrompt, readVerdictFile } from '../src/recipe-validation-worker.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

test('verdictFilePath is deterministic + attempt-scoped + path-safe', () => {
  const p1 = verdictFilePath('C:/ws', 'ri_1', 'v1/backfill', 0);
  const p2 = verdictFilePath('C:/ws', 'ri_1', 'v1/backfill', 1);
  assert.notEqual(p1, p2);
  assert.match(p1, /ri_1__v1_backfill__attempt0\.verdict\.json$/);
});

test('buildDeliveryPrompt FAIL says reverted to active + gaps', () => {
  const msg = buildDeliveryPrompt({ outcome: 'rework', stepId: 'g', verdict: { verdict: 'FAIL', evidence: 'no PR', gaps: 'open the PR' } });
  assert.match(msg, /REVERTED TO ACTIVE/i);
  assert.match(msg, /not done/i);
  assert.match(msg, /open the PR/);
});

test('buildDeliveryPrompt PASS includes next step', () => {
  const msg = buildDeliveryPrompt({ outcome: 'passed', stepId: 'g', verdict: { verdict: 'PASS', evidence: 'ok' }, nextStepPrompt: 'NEXT STEP 11: ...' });
  assert.match(msg, /passed validation/i);
  assert.match(msg, /NEXT STEP 11/);
});

test('buildVerifierPrompt embeds the verdict file path + do-not-trust framing', () => {
  const p = buildVerifierPrompt({ recipeInstanceId: 'ri_1', stepId: 'g', verdictFile: 'C:/x.json', mode: 'evidence', claimedEvidence: 'PR open' });
  assert.match(p, /C:\/x\.json/);
  assert.match(p, /do not trust|assume the worker may be wrong/i);
});

test('readVerdictFile parses valid, rejects malformed/missing', () => {
  const dir = join(tmpdir(), `verdict-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ verdict: 'PASS', evidence: 'ok' }));
  assert.deepEqual(readVerdictFile(good), { verdict: 'PASS', evidence: 'ok', gaps: undefined, trigger_id: undefined });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.equal(readVerdictFile(bad), null);
  assert.equal(readVerdictFile(join(dir, 'missing.json')), null);
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-validation-worker.test.mjs
npm run typecheck
git add src/recipe-validation-worker.ts tests/recipe-validation-worker.test.mjs
git commit -m "feat(recipe): validation-worker pure helpers (verdict path, prompts, reader)"
```

---

### Task 4: `startValidationWorker` — the loop (injectable spawn + delivery)

**Files:**
- Modify: `mcp-server/src/recipe-validation-worker.ts` (add the loop + opts interfaces)
- Test: `mcp-server/tests/recipe-validation-worker.test.mjs`

- [ ] **Build.** Add to `src/recipe-validation-worker.ts` (mirroring `startIdleReaper`'s tick/overlap/timer/handle structure). The spawn and delivery are injected functions so tests can substitute fakes:

```typescript
import type { Database } from 'better-sqlite3';
import { listStepsByStatus, getStepById, transitionStatus, type RecipeStepRow } from './db/recipe-steps-store.ts';
import { applyVerdict } from './recipe-validation.ts';
import { appendEvent } from './db/step-events-store.ts';
import { logger } from './logger.ts';

export interface ValidationWorkerOpts {
  db: Database;
  /** Spawn a headless verifier for a validating step. Resolves once SPAWNED
   *  (not once it finishes) — the loop polls the verdict file next ticks.
   *  Returns the verifier's session id (for bookkeeping). */
  spawnVerifier: (args: {
    step: RecipeStepRow; verdictFile: string; prompt: string; workspacePath: string;
  }) => Promise<{ sessionId: string }>;
  /** Deliver a prompt to the worker session that owns this recipe instance.
   *  Resumes the session if idle. */
  deliverToWorker: (args: { recipeInstanceId: string; prompt: string }) => Promise<void>;
  /** Compute the next-ready-step prompt after a PASS (or null if none ready). */
  nextStepPrompt: (args: { recipeInstanceId: string; doneStepId: string }) => Promise<string | null>;
  /** Resolve the workspace path for an instance (for the verdict file + spawn cwd). */
  workspacePathFor: (recipeInstanceId: string) => string;
  intervalMs?: number;         // default 15_000
  maxAttempts?: number;        // verifier respawn cap on infra failure, default 3
  verdictTimeoutMs?: number;   // how long to wait for a verdict file before infra-retry, default 600_000
}

export interface ValidationWorkerHandle {
  stop(): void;
  runOnce(): Promise<void>;
}

export function startValidationWorker(opts: ValidationWorkerOpts): ValidationWorkerHandle {
  const intervalMs = opts.intervalMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const verdictTimeoutMs = opts.verdictTimeoutMs ?? 600_000;
  let stopped = false;
  let running = false;

  async function handleStep(step: RecipeStepRow): Promise<void> {
    const wsPath = opts.workspacePathFor(step.recipe_instance_id);
    const attempt = step.validation_attempt;
    const verdictFile = verdictFilePath(wsPath, step.recipe_instance_id, step.step_id, attempt);

    // 1. If a verdict file already exists, apply it.
    const verdict = readVerdictFile(verdictFile);
    if (verdict) {
      const res = applyVerdict(opts.db, {
        recipe_instance_id: step.recipe_instance_id, step_id: step.step_id, verdict,
      });
      let nextPrompt: string | null | undefined;
      if (res.outcome === 'passed') {
        nextPrompt = await opts.nextStepPrompt({ recipeInstanceId: step.recipe_instance_id, doneStepId: step.step_id });
      }
      const deliver = buildDeliveryPrompt({
        outcome: res.outcome, stepId: step.step_id, verdict, nextStepPrompt: nextPrompt ?? undefined,
      });
      await opts.deliverToWorker({ recipeInstanceId: step.recipe_instance_id, prompt: deliver });
      return;
    }

    // 2. No verdict yet. If no verifier has been spawned for THIS attempt, spawn one.
    if (step.verifier_session_id == null) {
      const validation = step.validation_json ? JSON.parse(step.validation_json) : {};
      const prompt = buildVerifierPrompt({
        recipeInstanceId: step.recipe_instance_id, stepId: step.step_id, verdictFile,
        criteria: validation.criteria, claimedEvidence: step.result ?? undefined, mode: validation.mode ?? 'evidence',
      });
      const { sessionId } = await opts.spawnVerifier({ step, verdictFile, prompt, workspacePath: wsPath });
      opts.db.prepare(`UPDATE recipe_steps SET verifier_session_id = ? WHERE id = ?`).run(sessionId, step.id);
      appendEvent(opts.db, {
        recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
        type: 'validation_started', payload: { attempt, verifier_session_id: sessionId, verdict_file: verdictFile },
      });
      return;
    }

    // 3. Verifier already running, no verdict yet. If it has exceeded the
    //    timeout, treat as infra failure: bump attempt + clear verifier so a
    //    fresh one is spawned next tick, up to maxAttempts, then escalate.
    const startedAt = step.started_at ?? Date.now();
    if (Date.now() - startedAt > verdictTimeoutMs) {
      const nextAttempt = attempt + 1;
      if (nextAttempt >= maxAttempts) {
        transitionStatus(opts.db, step.id, {
          status: 'awaiting_user', viaVerdict: true,
          awaiting_user_message: `Validation could not complete after ${nextAttempt} verifier attempts (no verdict produced). Human review needed.`,
        });
        appendEvent(opts.db, {
          recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
          type: 'validation_error', payload: { attempt: nextAttempt, reason: 'verdict_timeout_escalated' },
        });
      } else {
        opts.db.prepare(`UPDATE recipe_steps SET validation_attempt = ?, verifier_session_id = NULL, started_at = ? WHERE id = ?`)
          .run(nextAttempt, Date.now(), step.id);
        appendEvent(opts.db, {
          recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
          type: 'validation_error', payload: { attempt: nextAttempt, reason: 'verdict_timeout_retry' },
        });
      }
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
```

> Read `src/logger.ts` to confirm the `logger` import path/shape (idle-reaper.ts imports it — mirror that exactly). Read `appendEvent`'s signature (used in Task-4 backend) and confirm the event `type` values `validation_started` / `validation_error` are acceptable (the `step_events.type` column has no CHECK; if there's a `StepEventType` union, add these two members like `validation_verdict` was added).

- [ ] **Tests.** Append end-to-end loop tests driving the real DB with fakes:

```javascript
import { startValidationWorker } from '../src/recipe-validation-worker.ts';
import { getStepById } from '../src/db/recipe-steps-store.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function makeWorker(db, overrides = {}) {
  const delivered = [];
  const spawned = [];
  const worker = startValidationWorker({
    db,
    workspacePathFor: () => join(tmpdir(), `vw-${Math.random().toString(36).slice(2)}`),
    spawnVerifier: async ({ verdictFile }) => { spawned.push(verdictFile); return { sessionId: 'verifier-sess' }; },
    deliverToWorker: async ({ prompt }) => { delivered.push(prompt); },
    nextStepPrompt: async () => 'NEXT STEP READY',
    intervalMs: 10_000,
    ...overrides,
  });
  return { worker, delivered, spawned };
}

test('worker tick 1 spawns a verifier + records verifier_session_id + validation_started event', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'opened PR #42');
  const { worker, spawned } = makeWorker(db);
  await worker.runOnce();
  worker.stop();
  assert.equal(spawned.length, 1);
  assert.equal(getStepById(db, s.id).verifier_session_id, 'verifier-sess');
});

test('worker applies a PASS verdict file → done + delivers next step', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const s = claim(db, instanceId, 'g', 'opened PR #42');
  // Fake spawn writes the deterministic verdict file immediately.
  const { worker, delivered } = makeWorker(db, {
    workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => {
      mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, JSON.stringify({ verdict: 'PASS', evidence: 'PR #42 really open' }));
      return { sessionId: 'verifier-sess' };
    },
  });
  const WSP = join(tmpdir(), `vw-pass-${Date.now()}`);
  await worker.runOnce(); // tick 1: spawns (writes file), records session
  await worker.runOnce(); // tick 2: reads verdict → applyVerdict PASS → deliver
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'done');
  assert.ok(delivered.some((p) => /passed validation/i.test(p) && /NEXT STEP READY/.test(p)));
});

test('worker applies a FAIL verdict → reverts to running + delivers reverted-to-active msg', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 3 } }]);
  const s = claim(db, instanceId, 'g', 'claimed done');
  const WSP = join(tmpdir(), `vw-fail-${Date.now()}`);
  const { worker, delivered } = makeWorker(db, {
    workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => {
      mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, JSON.stringify({ verdict: 'FAIL', evidence: 'no PR exists', gaps: 'actually open the PR' }));
      return { sessionId: 'vs' };
    },
  });
  await worker.runOnce();
  await worker.runOnce();
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'running');
  assert.ok(delivered.some((p) => /REVERTED TO ACTIVE/i.test(p) && /actually open the PR/.test(p)));
});
```

> Adapt the small closure-ordering detail (`WSP` must be defined before `makeWorker` uses it — declare `const WSP = ...` first). Keep the fakes deterministic.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-validation-worker.test.mjs
npm run typecheck
git add src/recipe-validation-worker.ts src/db/step-events-store.ts tests/recipe-validation-worker.test.mjs
git commit -m "feat(recipe): startValidationWorker loop (spawn/verdict/apply/deliver, injectable)"
```

---

### Task 5: Real spawn + delivery wiring + server startup

**Files:**
- Modify: `mcp-server/src/recipe-validation-worker.ts` (add real-default factory `defaultValidationWorkerDeps(ctx)`)
- Modify: `mcp-server/src/cli/start.ts` (start + stop)
- Test: `mcp-server/tests/recipe-validation-worker.test.mjs` (a guarded integration test via echo-stub OR a documented manual check)

**Context:** The loop is injectable; now supply real implementations that (a) spawn a headless verifier via `runRecipe({ spawnMode: 'headless', ... })` with the verdict-file path in the prompt + `ambientEnv` (CLAWDEVBOX_VERDICT_FILE), (b) deliver via `dispatchOnly`/`spawnDispatchOrResume` resolving the worker's `cli_session_id` from `agent_sessions`, (c) compute next-step via the recipe instance's ready-step logic, (d) resolve workspace path from `recipe_instances.workspace_path`.

- [ ] **Build — real deps factory.** Add an exported `defaultValidationWorkerDeps(ctx)` that returns `{ spawnVerifier, deliverToWorker, nextStepPrompt, workspacePathFor }` bound to the server ctx (`{ db, dispatcher, ws, cfg, workspacesRoot }`). Implement each using the seams from the recon:
  - `workspacePathFor(id)`: `SELECT workspace_path FROM recipe_instances WHERE id = ?`.
  - `spawnVerifier({ step, verdictFile, prompt, workspacePath })`: call `runRecipe({ ws: ctx.ws, cfg: ctx.cfg, spawnMode: 'headless', prompt, agentCli: ctx.cfg.defaultAgentCli, workspaceInfo: { id: <instance workspace_id>, path: workspacePath }, workspacesRoot: ctx.workspacesRoot, ... })`. To inject `CLAWDEVBOX_VERDICT_FILE`: since `runRecipe` hardcodes `spawnEnv`, add a minimal `extraEnv?: Record<string,string>` field to `RunRecipeOptions` and merge it into `spawnEnv` (one-line change in recipe-runner.ts ~L288: `...opts.extraEnv`), then pass `extraEnv: { CLAWDEVBOX_VERDICT_FILE: verdictFile }`. The prompt ALSO contains the path (belt + suspenders). Return `{ sessionId }` from the runRecipe result.
  - `deliverToWorker({ recipeInstanceId, prompt })`: resolve `cli_session_id` via `SELECT cli_session_id FROM agent_sessions WHERE recipe_instance_id = ? ORDER BY started_at DESC LIMIT 1`, then `await dispatchOnly(sessionHelperCtx(ctx), { session_id: cliSessionId, prompt })`; if that returns a not-live code, fall back to `spawnDispatchOrResume(ctx, { session_id: cliSessionId, prompt })` to resume.
  - `nextStepPrompt({ recipeInstanceId, doneStepId })`: reuse the recipe runner's existing "next ready step" computation. READ how `recipe.steps.update_status`/the runner computes and delivers the next step today (recon item — the `first_steps`/next-step prompt builder) and call the SAME builder so the delivered prompt matches the normal recipe cadence. If a reusable function exists, use it; otherwise assemble the same shape (step goal + ai_instructions) the tool returns on a normal `done`.

  READ the exact signatures (`runRecipe`, `dispatchOnly`, `spawnDispatchOrResume`, `sessionHelperCtx`, the next-step builder) before writing; adapt precisely. If `runRecipe`'s result doesn't expose a `sessionId`, derive it from the passed `sessionId`/the returned instance's session.

- [ ] **Build — startup wiring.** In `src/cli/start.ts`, next to `const idleReaper = startIdleReaper({...})` (~L2052):

```typescript
  const validationWorker = startValidationWorker(
    defaultValidationWorkerDeps({ db: opened.db, dispatcher, ws, cfg, workspacesRoot: cfg.workspacesRoot }),
  );
```

and in the shutdown block next to `idleReaper.stop();` (~L2315): `validationWorker.stop();`. Match the surrounding style; confirm the exact names of `dispatcher`, `ws`, `cfg`, `opened.db`, and `cfg.workspacesRoot` in that scope before writing.

- [ ] **Test — guarded integration (echo-stub) OR documented manual check.** A real headless copilot spawn is not hermetic. Prefer an **echo-stub-based** integration test only if you can make echo-stub write the verdict file (it runs an arbitrary generated `.cjs` — the generated script could write the deterministic verdict path from its env `CLAWDEVBOX_VERDICT_FILE`). If that is clean, add one test asserting a full real-deps PASS cycle drives the step to `done`. If it is NOT clean within a reasonable effort, DO NOT force it: instead add a `test.skip(...)` with a comment describing the manual verification steps, and rely on Task 4's injected-fake coverage for the loop logic + a typecheck that the real factory compiles. Note which path you took.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-validation-worker.test.mjs
npm run typecheck
node --import tsx --test tests/recipe-runner-interactive.test.mjs tests/recipe-step-tools.test.mjs  # regressions
git add src/recipe-validation-worker.ts src/recipe-runner.ts src/cli/start.ts tests/recipe-validation-worker.test.mjs
git commit -m "feat(recipe): real verifier spawn + delivery wiring + start/stop in server"
```

---

### Task 6: Gate `implement-work-item` per spec §10

**Files:**
- Modify: `C:\git\team-memory\recipes\implement-work-item.yaml` (vault copy)
- Modify: `C:\Users\devuser\.clawdevbox\recipes\implement-work-item.yaml` (global copy — shadows the vault; MUST be synced)
- Validate: via `validateRecipeSource` (mcp-server validator)

**Context:** Add `validation:` blocks per spec §10 map. Both recipe copies must be updated (the global copy shadows the vault at resolution time — known repository fact). Use the existing edit approach that preserves EOLs.

Spec §10 gating map:
- `validation: { mode: evidence }` → steps **8** (impl+tests), **10** (PR+NPE), **11** (dev-release PR), **12** (comments→merge), **14** (deploy).
- `validation: { mode: artifacts }` → steps **9** (self-review), **15** (soak), **17** (UAT).
- (Fresh-session execution / `execution:` blocks are Phase 1b — NOT in this task.)

- [ ] **Build.** For each listed step id, insert a `validation:` block as a sibling of `required:`/`goal:` (same indentation as `required:`). Example for step 10:

```yaml
  - id: 10
    required: true
    validation:
      mode: evidence
    goal: >-
      ...
```

Add `mode: evidence` to steps 8, 10, 11, 12, 14 and `mode: artifacts` to steps 9, 15, 17. Do NOT add a `criteria:` — the verifier derives criteria from the step goal + invariants (keep it terse; can be added later). Use a script that inserts the two-line block right after each target step's `required: true` line, preserving the file's EOLs (mirror the approach used when `required: true` was inserted). Leave steps 0,1,2,3,4,5,6,7,13,18,19 ungated (5/6 are human-approval gates; setup/wrapup steps need no verifier).

- [ ] **Verify — validate + sync.**

```bash
# Validate the vault copy parses with the new blocks:
cd C:\git\clawdevbox\mcp-server
# (run validateRecipeSource on the vault file via a tiny tsx snippet, as done previously; expect ok:true)

# Sync vault → global (global shadows vault at begin-time):
Copy-Item "C:\git\team-memory\recipes\implement-work-item.yaml" "C:\Users\devuser\.clawdevbox\recipes\implement-work-item.yaml" -Force
# Confirm both identical + validation blocks present on the 8 gated steps.
```

Also confirm via the live server: `recipe.template.get({ id: 'implement-work-item' })` shows `validation` on the 8 steps (as done when the `required` flags were verified).

- [ ] **Commit (vault recipe).**

```bash
cd C:\git\team-memory
git add recipes/implement-work-item.yaml
git commit -m "feat(recipe): gate implement-work-item steps 8-15,17 with validation blocks (spec §10)"
# (global copy is a local runtime artifact — not committed; it is synced, not version-controlled)
```

---

### Task 7: End-to-end activation check

**Files:** none (verification only)

- [ ] **Restart the service** so it loads the new worker + migrations-aware code (the running service predates this code — known fact that a long-running service doesn't pick up source edits until restart). Use the documented restart path (`clawdevbox` service restart / `daemon.restart` for the MCP, per the repo's runbook). Confirm `healthz` ok + the validation-worker "started" log line appears.
- [ ] **Dry-run the gate** with a throwaway ad-hoc recipe (NOT the real WI recipe) that has one `validation: { mode: evidence }` step, begun via `recipe.instance.begin({ source: ... })`. Drive the step to `running`, then `update_status(done)` and confirm: (a) it auto-claims to `validating`, (b) the worker spawns a verifier, (c) on a written PASS verdict it goes `done` and the next-step delivery fires. Use `mode: echo-stub`-style or a manual verdict-file write to keep it hermetic. Capture the observed transitions.
- [ ] **Record** a memory: the validation runtime is live (worker loop id/log line, verdict-file location convention, auto-claim behavior), and update the follow-up todo for the `mirrorStepsToDb` defense-in-depth guard.

---

## Self-review (author checklist — done)

- **Spec coverage:** §5.3 verifier spawn → Tasks 3–5; §5.4 verdict channel (file) → Tasks 3–5; §5.5 outcomes → reuses `applyVerdict` (backend) + delivery Task 3–4; §5.6 claim-and-release + auto-claim + "reverted to active" FAIL message → Tasks 2–4; §10 gating map → Task 6; activation → Task 7. Fresh-session execution (§5.7) and UI (§5.9/§5.10) remain separate follow-on plans (out of scope here).
- **Placeholder scan:** loop + helpers + tests are complete code. Task 5's real-deps factory and Task 6's insertion are specified as "read the exact signature, then mirror this shape" because they bind to live server scope + a large YAML — the engineer must confirm names in-context (flagged explicitly), but the exact seams, call shapes, and the one `extraEnv` change are named.
- **Type consistency:** `Verdict`/`VerdictKind` (from backend `recipe-validation.ts`), `RecipeStepRow`, `listStepsByStatus`, `startValidationWorker`/`ValidationWorkerOpts`/`ValidationWorkerHandle`, `applyVerdict` outcomes (`passed|rework|stalemate|blocked`) are used consistently across tasks.

## Out of scope (follow-on plans)
- **UI** — instance validation panel + attempt history (§5.9); template flow-diagram badges + validation prompt (§5.10).
- **Fresh-session execution (Phase 1b)** — `execution: fresh-session` + `isolation: required` (§5.7).
- **`mirrorStepsToDb` defense-in-depth** — guard the second writer against gated→done (tracked todo `followup-mirror`).
- **Parallel fan-out (Phase 2)**.
