# Multiple Validation Gates Per Step — Design

**Status:** Approved (brainstorm) — ready for implementation plan
**Date:** 2026-07-14
**Author:** @devuser + Copilot
**Builds on:** `2026-07-14-recipe-step-validation-and-isolated-execution-design.md` (the single-gate validation runtime, already shipped + live)

---

## 1. Motivation

A validation-gated recipe step today declares exactly one gate:

```yaml
- id: 10
  validation: { mode: evidence }
```

One independent verifier checks one thing. But real steps often have **several
distinct things to verify**, each best checked by its own focused verifier. For
example, `implement-work-item` step 10 ("draft PR + run NPE tests + send the
PR") wants to confirm *both* that the PR actually exists (evidence) *and* that
the PR-walkthrough artifact is well-formed (artifacts). Cramming both into one
verifier's prompt dilutes each check and muddies the verdict.

**Goal:** let a step declare multiple independent validation gates, each an
independent verifier, all of which must pass (AND) before the step completes.

## 2. Decisions (locked during brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Completion rule | **AND** — every gate must PASS; any FAIL reverts the step to active |
| 2 | Schema shape | `validation` accepts **one gate OR a list**; back-compat preserved |
| 3 | Rework scope | **Re-run ALL gates** each round (a fix that regresses a passed gate is caught) |
| 4 | Within an attempt | **Parallel** verifiers; on any FAIL revert with **combined gaps** from all failed gates |

Non-negotiable inherited invariant: a gated step reaches `done` ONLY via the
server-applied `viaVerdict` path — never a direct agent `running→done`. Multiple
gates does not weaken this; it strengthens it (more independent checks).

## 3. Schema / contract

`src/db/recipe-steps-store.ts`:

```typescript
export interface ValidationGate {
  /** Stable label for this gate (verdict-file path + UI). Optional in YAML. */
  name?: string;
  mode: 'evidence' | 'artifacts' | 'judge';
  criteria?: string;
  verifier_model?: string;
}

export interface ValidationDecl {          // unchanged single-gate shape
  mode: 'evidence' | 'artifacts' | 'judge';
  criteria?: string;
  max_rework?: number;
  verifier_model?: string;
}

// Step.validation widens:
validation?: ValidationDecl | ValidationGate[];
```

**Author-facing YAML.** Single (unchanged):

```yaml
validation: { mode: evidence }
```

Multiple:

```yaml
validation:
  - { name: pr-exists,   mode: evidence,  criteria: "A real PR is open and linked to the WI" }
  - { name: walkthrough, mode: artifacts, criteria: "The pr-walkthrough artifact validates" }
max_rework: 3        # step-level, applies across all gates
```

**Canonical normalized form** (what `buildStepDecls` produces and
`validation_json` stores):

```json
{ "gates": [ {"name":"pr-exists","mode":"evidence","criteria":"…"},
             {"name":"walkthrough","mode":"artifacts","criteria":"…"} ],
  "max_rework": 3 }
```

Normalization rules (in `buildStepDecls` / `coerceStepBlock`, fail-closed):
- A single `{mode,…}` object → `{ gates: [ {name: mode, …} ], max_rework }`.
- An array → `{ gates: [...], max_rework }` (pull `max_rework` from the step if
  present; gates keep only `name`/`mode`/`criteria`/`verifier_model`).
- **Gate naming:** use the author's `name`; else default to `mode`; if that
  collides with another gate, suffix the 0-based index (`evidence`,
  `evidence-1`). Names are sanitized for the verdict-file path.
- **Back-compat read:** a `validation_json` lacking `gates` (old `{mode}` blob)
  is read as a one-gate array. No migration of existing rows needed.

`presence of validation_json` remains the "is this step gated?" signal for the
un-bypassable gate guard in `transitionStatus` — unchanged.

## 4. Data model

Per-attempt, per-gate runtime state is needed (which gates spawned, which
returned). Add ONE nullable column (additive migration — no CHECK rebuild, no
table rebuild, unlike v15):

**Migration v16** — `ALTER TABLE recipe_steps ADD COLUMN validation_runs_json TEXT`.

`validation_runs_json` holds the worker's current-attempt tracking:

```json
{ "attempt": 1,
  "gates": { "pr-exists":   { "verifier_session_id": "…", "started_at": 173… },
             "walkthrough": { "verifier_session_id": "…", "started_at": 173… } } }
```

- Reset (to `{attempt:N, gates:{}}`) whenever the attempt rotates (re-claim).
- `verdict_json` keeps the **aggregate/latest** outcome for the fast single-gate
  path + the "latest" UI line: `{ verdict, gaps?, gates: {name: {verdict,…}} }`.
- Per-gate verdict **history** is reconstructed from `step_events`
  (`validation_verdict` events, now carrying a `gate` field) — reusing the
  existing rounds-from-events machinery.

Existing columns keep working: `validation_attempt`, `rework_count`,
`verifier_session_id` (now = the aggregate/"a" verifier; retained for
back-compat but the authoritative per-gate ids live in `validation_runs_json`).

## 5. Runtime — the worker loop

`src/recipe-validation-worker.ts`, `handleStep(step)` for a `validating` step,
attempt = `step.validation_attempt`:

1. Parse canonical gates from `validation_json`.
2. **Single-gate fast path:** exactly one gate → today's exact logic (one
   verdict file, one verifier, `applyVerdict`). No behavior change.
3. **Multi-gate path:**
   a. Compute each gate's verdict-file path:
      `verdictFilePath(ws, instance, step, attempt, gateName)` →
      `…/validation/<instance>__<step>__attempt<N>__<gate>.verdict.json`.
   b. Read all existing verdict files → `Map<gate, Verdict>`.
   c. For every gate with **no verifier recorded** in `validation_runs_json`
      for this attempt: spawn a verifier (parallel — all un-spawned this tick),
      record `{verifier_session_id, started_at}` under
      `validation_runs_json.gates[name]`, append `validation_started {gate,
      attempt, verifier_session_id, verdict_file}`.
   d. When **every** gate has a verdict → aggregate + apply (step 4 below).
   e. Per-gate timeout: a gate whose verifier exceeded `verdictTimeoutMs` with
      no verdict → bump `validation_attempt`, clear `validation_runs_json`,
      reset `started_at` (retry the whole attempt), up to `maxAttempts`, then
      escalate to `awaiting_user` + `validation_error {gate, reason}`. (A
      timeout is an infra failure of the attempt, consistent with today.)

**Verifier prompt per gate** (`buildVerifierPrompt`) gains the gate's
`name` + `criteria` + `mode`, and is told it is one of several gates so it
scopes its check to its own concern and writes ONLY its own verdict file.

## 6. State machine — aggregation

`src/recipe-validation.ts`:

```typescript
export function applyGateVerdicts(db, args: {
  recipe_instance_id: string; step_id: string;
  gateVerdicts: Record<string /*gate*/, Verdict>;
}): ApplyVerdictResult
```

- Append one `validation_verdict` event per gate (payload `{gate, verdict,
  evidence, gaps, trigger_id}`).
- Aggregate:
  - **all PASS** → `transitionStatus(done, viaVerdict:true)`, `result` = a short
    roll-up of each gate's evidence. outcome `passed`.
  - **any FAIL** (no BLOCKED taking precedence — see below) → revert to
    `running`, `rework_count++`, write aggregate `verdict_json` with `verdict:
    FAIL` + **combined gaps** = per-failed-gate bullet list. outcome `rework`
    (or `stalemate` when `rework_count >= max_rework`).
  - **any BLOCKED** → `awaiting_user` with the first blocked gate's trigger.
    outcome `blocked`. (Precedence: BLOCKED > FAIL > PASS — a genuine external
    block is surfaced even if another gate also failed, matching single-gate.)
- `applyVerdict(single)` becomes `applyGateVerdicts` with one gate → **identical
  behavior** to today (regression-guarded by the existing suite).

Re-claim rotation (already built): re-entering `validating` after a FAIL bumps
`validation_attempt`, clears `verifier_session_id`/`verdict_json`, **and now
also clears `validation_runs_json`** so all gates re-run with fresh
verdict-file paths.

## 7. Serialization + UI

`src/recipe-instances-store.ts` `StepValidation`:

```typescript
interface GateDecl { name: string; mode: string; criteria?: string }
interface ValidationRound {
  attempt: number;
  gate: string;          // NEW — which gate this round entry is for
  mode: string;          // NEW
  verdict?: 'PASS'|'FAIL'|'BLOCKED';
  evidence?: string; gaps?: string;
  started_at?: number; decided_at?: number;
  verifier_session_id?: string; error?: string;
}
interface StepValidation {
  gates: GateDecl[];                 // NEW — the declared gate set
  mode: string;                      // kept: first gate's mode (back-compat)
  in_progress: boolean;
  attempt: number; rework_count: number;
  passed_gates: number; total_gates: number;   // NEW — "2/3 gates passed"
  verifier_session_id?: string;
  latest?: { verdict; evidence; gaps? };        // aggregate latest
  rounds: ValidationRound[];         // one entry per (attempt × gate)
}
```

Rounds reconstruction: walk `validation_started`/`validation_verdict`/
`validation_error` events, keyed by `(attempt, gate)`. Single-gate rows produce
one gate named by mode → the current UI still renders correctly.

**Recipes tab** (`RecipeDetailPanel.vue`): the gate header shows the aggregate
state + a `passed_gates/total_gates` chip. The rounds list groups by attempt;
within each attempt, one sub-card per gate with the gate `name` + mode chip +
verdict + evidence + gaps. (Single-gate steps look exactly as they do now.)

**Library tab** (`RecipeFlow.vue` + `LibraryRecipes.vue`): the flow node shows a
`🛡 ×N` badge when `gates.length > 1` (else the single mode as today); the step
list enumerates each gate (name · mode · plain-English explanation · criteria).
`library-api.ts` `projectRecipeSteps` emits `validation.gates[]`.

`web/src/api.ts` mirrors the widened types (`ValidationGate`,
`StepValidation.gates`, `ValidationRound.gate/mode`, `LibraryRecipeStep.validation.gates`).

## 8. Backward compatibility

- Every existing single-`validation:{mode}` step normalizes to one gate → the
  worker's single-gate fast path → **byte-identical behavior**. The live
  `implement-work-item` gates and all current tests are unaffected.
- Old `verdict_json` / rows without `gate` in events → read as one unnamed gate.
- No data migration of existing rows; the only DB change is one additive
  nullable column.

## 9. Testing

Batched task-level TDD (build + tests + run + commit per task).

- **Contract:** single→one-gate normalization; array normalization + defaults;
  duplicate-name suffixing; `max_rework` hoisting; fail-closed on malformed.
- **Worker (fakes):** multi-gate parallel spawn (2–3 gates); all-PASS→done;
  one-FAIL→revert with combined gaps naming each failed gate; BLOCKED
  precedence; per-gate timeout→retry→escalate; re-claim clears
  `validation_runs_json` and re-runs all gates.
- **Aggregation:** `applyGateVerdicts` PASS/FAIL/BLOCKED/stalemate; single-gate
  wrapper parity with old `applyVerdict`.
- **Serialization:** `gates[]` + per-(attempt×gate) rounds; single-gate parity.
- **Regression:** full existing recipe-validation + worker + step-tools suites.
- **Real e2e (no mocks):** a demo recipe step with two gates (evidence +
  artifacts); runner under-delivers one → combined gaps → fixes → both PASS.
  Screenshot the multi-gate UI.

## 10. Files touched

| File | Change |
|------|--------|
| `src/db/recipe-steps-store.ts` | `ValidationGate` type, widen `Step.validation`, migration v16 (`validation_runs_json`), canonical read helper |
| `src/tools/recipe.ts` | `buildStepDecls`/`coerceStepBlock` normalize object-or-array → `{gates,max_rework}` |
| `src/validators.ts` | accept array `validation`; validate each gate |
| `src/recipe-validation.ts` | `applyGateVerdicts` aggregation; `applyVerdict` → wrapper |
| `src/recipe-validation-worker.ts` | multi-gate `handleStep` (parallel spawn, per-gate verdict files, aggregation), `verdictFilePath` gains gate, per-gate prompt |
| `src/recipe-instances-store.ts` | serialize `gates[]` + per-gate rounds + `passed/total` |
| `src/cli/library-api.ts` | template `validation.gates[]` |
| `web/src/api.ts` | widened types |
| `web/src/components/RecipeDetailPanel.vue` | per-gate rounds + aggregate header |
| `web/src/components/RecipeFlow.vue` | `🛡 ×N` node badge |
| `web/src/components/LibraryRecipes.vue` | per-gate step-list entries |

## 11. Out of scope (follow-ups)

- Per-gate independent rework (only re-run failed gates) — explicitly rejected
  (decision #3); could revisit behind a per-step flag later.
- OR / sequential-pipeline gate semantics — rejected (decision #1/#4).
- Applying multi-gates to `implement-work-item` (e.g., step 10 = evidence +
  artifacts) — a recipe-content change, done after this capability ships.
- The deferred step-13 evidence gate on `implement-work-item` — trivial recipe
  edit, folded in when we gate the recipe with multi-gates.
