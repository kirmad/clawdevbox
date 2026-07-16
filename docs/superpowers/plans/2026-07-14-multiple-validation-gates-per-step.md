# Multiple Validation Gates Per Step — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cadence (user preference):** batched task-level TDD — each task = write complete code + complete tests, run the suite + typecheck, commit. Full coverage, no per-assertion red→green ceremony.
>
> **Execution context (IMPORTANT):** This feature extends BOTH committed code and the current uncommitted validation-UI work + the user's Library WIP (`library-api.ts`, `RecipeFlow.vue`, `LibraryRecipes.vue`). It therefore executes **in the main working tree** (`C:\git\clawdevbox\mcp-server`), NOT a fresh worktree (a worktree off `main` would lack the uncommitted files). Do not `git worktree add`. Do not revert or commit the pre-existing uncommitted UI/WIP changes; build on top of them.

**Goal:** Let a recipe step declare multiple independent validation gates, all of which must pass (AND) before the step completes, with parallel verifiers and combined-gaps rework.

**Architecture:** Widen `Step.validation` to accept one gate OR a list, normalized to a canonical `{ gates:[…], max_rework }`. The worker spawns one verifier per gate in parallel (each with its own verdict file), aggregates all verdicts (all-PASS → done; any FAIL → revert with combined gaps; any BLOCKED → awaiting_user), and re-runs all gates each rework round. Single-gate steps take a fast path with byte-identical behavior to today.

**Tech Stack:** TypeScript (tsx / `--experimental-strip-types`), better-sqlite3, `node:test`, Vue 3 + PrimeVue SPA (vue-tsc + vite), Playwright for the real-e2e screenshot. Spec: `docs/superpowers/specs/2026-07-14-multiple-validation-gates-per-step-design.md`.

---

## File structure

- Modify `mcp-server/src/db/recipe-steps-store.ts` — `ValidationGate` type; widen `Step.validation`; canonical read helper `readStepGates()`.
- Modify `mcp-server/src/db/migrations.ts` — migration v16: additive nullable `validation_runs_json` column.
- Modify `mcp-server/src/tools/recipe.ts` — normalize object-or-array in `buildStepDecls`.
- Modify `mcp-server/src/validators.ts` — accept array `validation`, validate each gate.
- Modify `mcp-server/src/recipe-validation.ts` — `applyGateVerdicts()` aggregation; `applyVerdict()` → single-gate wrapper.
- Modify `mcp-server/src/recipe-validation-worker.ts` — multi-gate `handleStep`; per-gate `verdictFilePath`; per-gate verifier prompt.
- Modify `mcp-server/src/recipe-instances-store.ts` — serialize `gates[]` + per-(attempt×gate) rounds + passed/total.
- Modify `mcp-server/src/cli/library-api.ts` — template `validation.gates[]`.
- Modify `mcp-server/web/src/api.ts` — widened FE types.
- Modify `mcp-server/web/src/components/RecipeDetailPanel.vue` — per-gate rounds + aggregate header.
- Modify `mcp-server/web/src/components/RecipeFlow.vue` — `🛡 ×N` node badge.
- Modify `mcp-server/web/src/components/LibraryRecipes.vue` — per-gate step-list entries.
- Tests: `mcp-server/tests/recipe-multi-gate.test.mjs` (new), extend `tests/recipe-validation-worker.test.mjs`, `tests/recipe-step-validation.test.mjs`.

All commands run from `mcp-server/`. Wire any NEW test file into `package.json` `scripts.test`. Verify: `npm run typecheck` (exit 0) and `node --import tsx --test <files>` (exit 0). Full `npm test` hangs on server/e2e suites (pre-existing/environmental) — run targeted suites.

---

### Task 1: Contract — `ValidationGate` type + object-or-array normalization

**Files:**
- Modify: `mcp-server/src/db/recipe-steps-store.ts` (types)
- Modify: `mcp-server/src/tools/recipe.ts` (`buildStepDecls` normalization)
- Modify: `mcp-server/src/validators.ts` (accept array)
- Test: `mcp-server/tests/recipe-multi-gate.test.mjs` (create)

- [ ] **Build — types.** In `recipe-steps-store.ts`, above `ValidationDecl`, add:

```typescript
export interface ValidationGate {
  /** Stable label; used in the verdict-file path + UI. Optional in YAML. */
  name?: string;
  mode: 'evidence' | 'artifacts' | 'judge';
  criteria?: string;
  verifier_model?: string;
}

/** Canonical, normalized multi-gate validation stored in `validation_json`. */
export interface ValidationConfig {
  gates: Array<{ name: string; mode: 'evidence' | 'artifacts' | 'judge'; criteria?: string; verifier_model?: string }>;
  max_rework?: number;
}
```

Widen the `Step.validation` field:

```typescript
  /** Opt-in validation gate(s). One gate object, OR a list of gates (all must
   *  pass). When present, the step reaches `done` only via a server-applied
   *  verifier verdict (never a direct running→done). */
  validation?: ValidationDecl | ValidationGate[];
```

- [ ] **Build — canonical read helper.** In `recipe-steps-store.ts`, add an exported normalizer (used by the worker, serializers, and buildStepDecls so the "one shape" rule lives in one place):

```typescript
/**
 * Normalize any accepted `validation` shape (single ValidationDecl, an array
 * of gates, or a canonical {gates} object read back from validation_json) into
 * the canonical ValidationConfig. Returns null when there is no gate.
 * Gate names default to their mode; duplicate defaults get an index suffix so
 * every gate name is unique + path-safe.
 */
export function normalizeValidation(
  raw: unknown,
  stepMaxRework?: number,
): ValidationConfig | null {
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
      let name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : mode;
      if (used.has(name)) name = `${name}-${i}`;
      used.add(name);
      const out: ValidationConfig['gates'][number] = { name, mode };
      if (typeof g.criteria === 'string' && g.criteria.trim()) out.criteria = g.criteria;
      if (typeof g.verifier_model === 'string') out.verifier_model = g.verifier_model;
      return out;
    });
  if (gates.length === 0) return null;
  return maxRework != null ? { gates, max_rework: maxRework } : { gates };
}
```

- [ ] **Build — normalize in `buildStepDecls`.** In `src/tools/recipe.ts`, `buildStepDecls` currently does `validation: coerceStepBlock(s.validation, 'validation', …)`. Change it to normalize to the canonical config so the materialized `validation_json` is always `{gates,…}`:

```typescript
// near the top imports:
import { normalizeValidation } from '../db/recipe-steps-store.ts';
// in the step map (replace the validation line):
validation: normalizeValidation(
  coerceStepBlock(s.validation, 'validation', String(s.id ?? '')),
  typeof (s as Record<string, unknown>).max_rework === 'number' ? (s as Record<string, unknown>).max_rework as number : undefined,
) ?? undefined as unknown as Step['validation'],
```

Read `coerceStepBlock` first (it fail-closes malformed blocks by throwing). Keep that behavior: `coerceStepBlock` still runs first (rejecting a truthy-but-non-object/array), then `normalizeValidation` canonicalizes. Confirm `coerceStepBlock` accepts arrays (it likely only guards objects — if it rejects arrays, adjust it to allow an array of objects for the `validation` field specifically, or bypass coerce for arrays and validate shape in `normalizeValidation`). Note what you changed.

- [ ] **Build — validator.** In `src/validators.ts`, find where step `validation` is validated (search `validation`). Accept EITHER an object with a `mode` in the enum, OR an array whose every element is an object with a `mode` in the enum. Add a clear error per bad gate (path `steps[i].validation[j].mode`). Mirror the existing single-object validation messages.

- [ ] **Tests.** Create `tests/recipe-multi-gate.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeValidation } from '../src/db/recipe-steps-store.ts';
import { validateRecipeSource } from '../src/validators.ts';

test('normalizeValidation: single object → one gate named by mode', () => {
  const c = normalizeValidation({ mode: 'evidence', criteria: 'x', max_rework: 2 });
  assert.deepEqual(c, { gates: [{ name: 'evidence', mode: 'evidence', criteria: 'x' }], max_rework: 2 });
});

test('normalizeValidation: array of gates, names defaulted + de-duped', () => {
  const c = normalizeValidation([{ mode: 'evidence' }, { mode: 'evidence' }, { name: 'wt', mode: 'artifacts' }]);
  assert.deepEqual(c.gates.map((g) => g.name), ['evidence', 'evidence-1', 'wt']);
  assert.deepEqual(c.gates.map((g) => g.mode), ['evidence', 'evidence', 'artifacts']);
});

test('normalizeValidation: canonical {gates} round-trips (back-compat read)', () => {
  const canon = { gates: [{ name: 'a', mode: 'evidence' }], max_rework: 5 };
  assert.deepEqual(normalizeValidation(canon), canon);
});

test('normalizeValidation: null/empty → null', () => {
  assert.equal(normalizeValidation(null), null);
  assert.equal(normalizeValidation([]), null);
});

test('validateRecipeSource: array validation with a bad mode is rejected', () => {
  const src = `id: r\nname: r\ndescription: d\nsteps:\n  - id: s\n    goal: g\n    validation:\n      - { mode: evidence }\n      - { mode: bogus }\n`;
  const res = validateRecipeSource(src);
  assert.equal(res.ok, false);
});

test('validateRecipeSource: array validation with valid modes passes', () => {
  const src = `id: r\nname: r\ndescription: d\nsteps:\n  - id: s\n    goal: g\n    validation:\n      - { name: pr, mode: evidence }\n      - { name: wt, mode: artifacts }\n`;
  const res = validateRecipeSource(src);
  assert.equal(res.ok, true);
});
```

Wire `tests/recipe-multi-gate.test.mjs` into `package.json` `scripts.test`.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-multi-gate.test.mjs
npm run typecheck
node --import tsx --test tests/recipe-build-step-decls.test.mjs tests/recipe-step-validation.test.mjs   # regressions
git add src/db/recipe-steps-store.ts src/tools/recipe.ts src/validators.ts tests/recipe-multi-gate.test.mjs package.json
git commit -m "feat(recipe): ValidationGate type + object-or-array validation normalization"
```

---

### Task 2: Migration v16 — `validation_runs_json` column

**Files:**
- Modify: `mcp-server/src/db/migrations.ts` (add v16)
- Test: `mcp-server/tests/recipe-multi-gate.test.mjs` (extend)

- [ ] **Build.** In `migrations.ts`, find the migration list/array (each entry has a `version` + an `up(db)` running SQL — read the latest entry, v15, to mirror the exact shape). Append v16:

```typescript
{
  version: 16,
  name: 'recipe_steps.validation_runs_json',
  up: (db) => {
    // Additive nullable column — no CHECK/table rebuild needed. Holds the
    // validation worker's per-attempt, per-gate runtime state for multi-gate
    // steps: { attempt, gates: { <name>: { verifier_session_id, started_at } } }.
    db.exec(`ALTER TABLE recipe_steps ADD COLUMN validation_runs_json TEXT`);
  },
},
```

Match the EXACT structural shape the file uses (some migration frameworks use `sql:` strings, others `up:` fns — copy v15's shape precisely). Add `validation_runs_json` to the `RecipeStepRow` interface in `recipe-steps-store.ts` (`validation_runs_json: string | null`).

- [ ] **Tests.** Extend `tests/recipe-multi-gate.test.mjs`:

```javascript
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';

test('migration v16 adds validation_runs_json column', () => {
  const db = new BetterSqlite3(':memory:');
  runMigrations(db);
  const cols = db.prepare('PRAGMA table_info(recipe_steps)').all().map((c) => c.name);
  assert.ok(cols.includes('validation_runs_json'), 'validation_runs_json column present');
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-multi-gate.test.mjs
node --import tsx --test tests/db-migrations.test.mjs   # migration-suite regression
npm run typecheck
git add src/db/migrations.ts src/db/recipe-steps-store.ts tests/recipe-multi-gate.test.mjs
git commit -m "feat(db): migration v16 — recipe_steps.validation_runs_json for multi-gate runtime"
```

---

### Task 3: `applyGateVerdicts` — aggregation + single-gate wrapper

**Files:**
- Modify: `mcp-server/src/recipe-validation.ts`
- Test: `mcp-server/tests/recipe-step-validation.test.mjs` (extend)

**Context:** `applyVerdict(db, {recipe_instance_id, step_id, verdict, agent_session_id?})` applies ONE verdict (PASS→done viaVerdict / FAIL→running or awaiting_user / BLOCKED→awaiting_user) + appends a `validation_verdict` event. Read it fully first.

- [ ] **Build.** Add `applyGateVerdicts` and make `applyVerdict` a wrapper:

```typescript
export function applyGateVerdicts(
  db: Database,
  args: {
    recipe_instance_id: string;
    step_id: string;
    gateVerdicts: Record<string, Verdict>;  // gate name → verdict
    agent_session_id?: string | null;
  },
): ApplyVerdictResult {
  const step = getStep(db, args.recipe_instance_id, args.step_id);
  // 1. Record one validation_verdict event per gate (tagged with `gate`).
  for (const [gate, v] of Object.entries(args.gateVerdicts)) {
    appendEvent(db, {
      recipe_step_id: step.id, recipe_instance_id: args.recipe_instance_id,
      agent_session_id: args.agent_session_id ?? null, type: 'validation_verdict',
      payload: { gate, verdict: v.verdict, evidence: v.evidence, gaps: v.gaps ?? null, trigger_id: v.trigger_id ?? null },
    });
  }
  // 2. Aggregate. Precedence: BLOCKED > FAIL > PASS.
  const entries = Object.entries(args.gateVerdicts);
  const blocked = entries.filter(([, v]) => v.verdict === 'BLOCKED');
  const failed = entries.filter(([, v]) => v.verdict === 'FAIL');
  let aggregate: Verdict;
  if (blocked.length > 0) {
    const [, v] = blocked[0];
    aggregate = { verdict: 'BLOCKED', evidence: v.evidence, gaps: v.gaps, trigger_id: v.trigger_id };
  } else if (failed.length > 0) {
    aggregate = {
      verdict: 'FAIL',
      evidence: entries.map(([g, v]) => `[${g}: ${v.verdict}] ${v.evidence}`).join('\n'),
      gaps: failed.map(([g, v]) => `• ${g}: ${v.gaps ?? '(no specific gaps)'}`).join('\n'),
    };
  } else {
    aggregate = {
      verdict: 'PASS',
      evidence: entries.map(([g, v]) => `[${g}] ${v.evidence}`).join('\n'),
    };
  }
  // 3. Persist the aggregate verdict_json (adds the per-gate map for the UI) +
  //    drive the transition through the SAME viaVerdict path used today.
  return applyAggregate(db, step, args, aggregate, args.gateVerdicts);
}
```

Refactor the EXISTING transition logic in `applyVerdict` (the PASS→done / FAIL→running(+rework_count)/awaiting_user / BLOCKED→awaiting_user branch, plus writing `verdict_json`) into a private `applyAggregate(db, step, args, aggregate, gateVerdicts?)` that both functions share. When `gateVerdicts` is provided, extend the written `verdict_json` with a `gates` map: `{...aggregateVerdict, gates: {name: {verdict, evidence, gaps}} }`. Then:

```typescript
export function applyVerdict(db, args: { recipe_instance_id; step_id; verdict: Verdict; agent_session_id? }): ApplyVerdictResult {
  // Single-gate wrapper — one gate named 'default'. Records its verdict event
  // and aggregates trivially, preserving today's exact behavior.
  return applyGateVerdicts(db, {
    recipe_instance_id: args.recipe_instance_id, step_id: args.step_id,
    agent_session_id: args.agent_session_id,
    gateVerdicts: { default: args.verdict },
  });
}
```

IMPORTANT: verify the existing `applyVerdict` behavior is exactly preserved — the single-gate `validation_verdict` event payload previously had NO `gate` field; now it will have `gate:'default'`. Confirm nothing downstream matches on the ABSENCE of `gate` (the rounds reconstruction in Task 5 must treat a missing/`'default'` gate as the sole gate). If any existing test asserts the exact payload shape, update it to allow the `gate` field.

- [ ] **Tests.** Extend `tests/recipe-step-validation.test.mjs`:

```javascript
test('applyGateVerdicts: all PASS → done', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  claim(db, instanceId, 'g'); // running→validating
  const { applyGateVerdicts } = require('../src/recipe-validation.ts');
  const r = applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: {
    a: { verdict: 'PASS', evidence: 'a ok' }, b: { verdict: 'PASS', evidence: 'b ok' } } });
  assert.equal(r.outcome, 'passed');
  assert.equal(getStep(db, instanceId, 'g').status, 'done');
});

test('applyGateVerdicts: one FAIL → running with combined gaps naming the failed gate', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  claim(db, instanceId, 'g');
  const { applyGateVerdicts } = require('../src/recipe-validation.ts');
  const r = applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: {
    a: { verdict: 'PASS', evidence: 'a ok' }, b: { verdict: 'FAIL', evidence: 'b missing', gaps: 'produce artifact b' } } });
  assert.equal(r.outcome, 'rework');
  assert.equal(getStep(db, instanceId, 'g').status, 'running');
  const v = JSON.parse(getStep(db, instanceId, 'g').verdict_json);
  assert.match(v.gaps, /b: produce artifact b/);
});

test('applyGateVerdicts: any BLOCKED → awaiting_user (precedence over FAIL)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'evidence' }] }]);
  claim(db, instanceId, 'g');
  const { applyGateVerdicts } = require('../src/recipe-validation.ts');
  const r = applyGateVerdicts(db, { recipe_instance_id: instanceId, step_id: 'g', gateVerdicts: {
    a: { verdict: 'FAIL', evidence: 'x', gaps: 'y' }, b: { verdict: 'BLOCKED', evidence: 'gated on CI', trigger_id: 't1' } } });
  assert.equal(r.outcome, 'blocked');
  assert.equal(getStep(db, instanceId, 'g').status, 'awaiting_user');
});
```

Use whatever import style the file already uses (`await import` vs top import) — match it; the snippets use `require` illustratively.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
npm run typecheck
node --import tsx --test tests/recipe-validation-worker.test.mjs   # single-gate worker still green
git add src/recipe-validation.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): applyGateVerdicts aggregation (AND, combined gaps, BLOCKED precedence)"
```

---

### Task 4: Worker — multi-gate `handleStep` (parallel spawn + aggregation)

**Files:**
- Modify: `mcp-server/src/recipe-validation-worker.ts`
- Test: `mcp-server/tests/recipe-validation-worker.test.mjs` (extend)

**Context:** Read the current `handleStep` (single-gate: read one verdict file → applyVerdict; else spawn one verifier; else timeout retry/escalate) and the `verdictFilePath`/`buildVerifierPrompt` helpers. The re-claim rotation + spawn-relative timeout fixes are already in place.

- [ ] **Build — per-gate verdict path.** Widen `verdictFilePath` to take an optional gate:

```typescript
export function verdictFilePath(workspacePath: string, recipeInstanceId: string, stepId: string, attempt: number, gate?: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  const base = `${safe(recipeInstanceId)}__${safe(stepId)}__attempt${attempt}`;
  const suffix = gate ? `__${safe(gate)}` : '';
  return join(workspacePath, '.clawdevbox', 'validation', `${base}${suffix}.verdict.json`);
}
```

(Existing single-gate callers pass no gate → identical path → the single-gate fast path is byte-compatible.)

- [ ] **Build — per-gate verifier prompt.** Add gate context to `buildVerifierPrompt` args (`gateName?: string; gateCount?: number`). When `gateCount > 1`, prepend: "You are gate '<gateName>' — one of <gateCount> independent gates on this step. Verify ONLY your concern (below) and write ONLY your own verdict file at the path given." Keep the existing single-gate wording when `gateCount` is 1/absent.

- [ ] **Build — multi-gate `handleStep`.** Replace the body with a gate-aware version. Parse `normalizeValidation(JSON.parse(step.validation_json))`. If exactly one gate → the EXISTING single-gate path (unchanged code, gate name omitted from the path for byte-compat). If >1 gate:

```typescript
    const cfg = normalizeValidation(step.validation_json ? JSON.parse(step.validation_json) : null);
    const gates = cfg?.gates ?? [];
    // --- multi-gate branch ---
    const runs = step.validation_runs_json ? JSON.parse(step.validation_runs_json) : { attempt, gates: {} };
    if (runs.attempt !== attempt) { runs.attempt = attempt; runs.gates = {}; } // attempt rotated
    const verdicts: Record<string, Verdict> = {};
    let missing = 0;
    for (const g of gates) {
      const vpath = verdictFilePath(wsPath, step.recipe_instance_id, step.step_id, attempt, g.name);
      const v = readVerdictFile(vpath);
      if (v) { verdicts[g.name] = v; continue; }
      missing += 1;
      if (runs.gates[g.name]?.verifier_session_id == null) {
        // spawn this gate's verifier (parallel — every un-spawned gate this tick)
        const prompt = buildVerifierPrompt({
          recipeInstanceId: step.recipe_instance_id, stepId: step.step_id, verdictFile: vpath,
          criteria: g.criteria, claimedEvidence: step.result ?? undefined, mode: g.mode,
          gateName: g.name, gateCount: gates.length,
        });
        try {
          const { sessionId } = await opts.spawnVerifier({ step, verdictFile: vpath, prompt, workspacePath: wsPath });
          runs.gates[g.name] = { verifier_session_id: sessionId, started_at: Date.now() };
          appendEvent(opts.db, { recipe_step_id: step.id, recipe_instance_id: step.recipe_instance_id, agent_session_id: null,
            type: 'validation_started', payload: { gate: g.name, attempt, verifier_session_id: sessionId, verdict_file: vpath } });
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
      // every gate returned → aggregate + apply
      const res = applyGateVerdicts(opts.db, { recipe_instance_id: step.recipe_instance_id, step_id: step.step_id, gateVerdicts: verdicts });
      let nextPrompt: string | null | undefined;
      if (res.outcome === 'passed') nextPrompt = await opts.nextStepPrompt({ recipeInstanceId: step.recipe_instance_id, doneStepId: step.step_id });
      const deliver = buildDeliveryPrompt({ outcome: res.outcome, stepId: step.step_id, verdict: aggregateVerdictFor(verdicts), nextStepPrompt: nextPrompt ?? undefined });
      await opts.deliverToWorker({ recipeInstanceId: step.recipe_instance_id, prompt: deliver });
      return;
    }
    // some gates still running → per-gate timeout check
    const oldest = Math.min(...gates.map((g) => runs.gates[g.name]?.started_at ?? Date.now()));
    if (Date.now() - oldest > verdictTimeoutMs) { retryOrEscalate(step, 'verdict_timeout', 'a gate verifier produced no verdict'); }
    return;
```

Add a small local `aggregateVerdictFor(verdicts)` that returns a `Verdict` mirroring `applyGateVerdicts`'s aggregate (PASS/FAIL/BLOCKED + combined gaps) so `buildDeliveryPrompt` shows the same combined message. Ensure `retryOrEscalate` (already in the file) also clears `validation_runs_json` when it rotates the attempt (add `validation_runs_json = NULL` to its retry UPDATE). Import `normalizeValidation` + `applyGateVerdicts`.

- [ ] **Tests.** Extend `tests/recipe-validation-worker.test.mjs`. Use the `open`/`seed`/`claim`/`makeWorker` harness; a fake `spawnVerifier` that writes the gate's verdict file. Cover:
  - **all-PASS:** 2 gates, fake writes PASS to both → after ticks, step `done`, `spawnCount === 2`.
  - **one-FAIL:** gate `a` PASS, gate `b` FAIL(gaps) → step `running`, delivered prompt contains `REVERTED TO ACTIVE` + `b`'s gaps.
  - **re-claim re-runs all:** after the FAIL, re-claim (auto-claim) → `validation_runs_json` cleared, attempt bumped → both gates spawn fresh (spawnCount grows by 2).

```javascript
test('multi-gate: all gates PASS → done (parallel spawn, aggregate)', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  const s = claim(db, instanceId, 'g', 'did the work');
  const WSP = join(tmpdir(), `mg-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let spawnCount = 0;
  const worker = startValidationWorker({
    db, workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => { spawnCount += 1; mkdirSync(dirname(verdictFile), { recursive: true });
      writeFileSync(verdictFile, JSON.stringify({ verdict: 'PASS', evidence: 'ok ' + verdictFile })); return { sessionId: 'vs' + spawnCount }; },
    deliverToWorker: async () => {}, nextStepPrompt: async () => 'NEXT', intervalMs: 10_000,
  });
  await worker.runOnce(); // spawn both gates (write PASS)
  await worker.runOnce(); // all verdicts present → aggregate PASS → done
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'done');
  assert.equal(spawnCount, 2);
});

test('multi-gate: one gate FAILs → reverted to active with that gate\'s gaps', async () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'x', validation: [{ name: 'a', mode: 'evidence' }, { name: 'b', mode: 'artifacts' }] }]);
  const s = claim(db, instanceId, 'g', 'did the work');
  const WSP = join(tmpdir(), `mg-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const delivered = [];
  const worker = startValidationWorker({
    db, workspacePathFor: () => WSP,
    spawnVerifier: async ({ verdictFile }) => { mkdirSync(dirname(verdictFile), { recursive: true });
      const isB = /__b\.verdict/.test(verdictFile);
      writeFileSync(verdictFile, JSON.stringify(isB ? { verdict: 'FAIL', evidence: 'b bad', gaps: 'make b' } : { verdict: 'PASS', evidence: 'a ok' }));
      return { sessionId: 'vs' }; },
    deliverToWorker: async ({ prompt }) => delivered.push(prompt), nextStepPrompt: async () => null, intervalMs: 10_000,
  });
  await worker.runOnce();
  await worker.runOnce();
  worker.stop();
  assert.equal(getStepById(db, s.id).status, 'running');
  assert.ok(delivered.some((p) => /REVERTED TO ACTIVE/i.test(p) && /make b/.test(p)));
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-validation-worker.test.mjs
npm run typecheck
node --import tsx --test tests/recipe-step-validation.test.mjs tests/recipe-step-tools.test.mjs
git add src/recipe-validation-worker.ts tests/recipe-validation-worker.test.mjs
git commit -m "feat(recipe): multi-gate validation worker (parallel verifiers, per-gate verdict files, aggregate)"
```

---

### Task 5: Serialization — per-gate config + rounds

**Files:**
- Modify: `mcp-server/src/recipe-instances-store.ts` (`StepValidation` + `buildStepValidation`)
- Modify: `mcp-server/src/cli/library-api.ts` (template gates)
- Test: `mcp-server/tests/recipe-validation-worker.test.mjs` OR `recipe-multi-gate.test.mjs` (serialization)

- [ ] **Build — instance serialization.** In `recipe-instances-store.ts`, widen types + `buildStepValidation`:
  - `StepValidation` gains `gates: Array<{ name: string; mode: string; criteria?: string }>`, `passed_gates: number`, `total_gates: number`. Keep `mode` = first gate's mode (back-compat).
  - `ValidationRound` gains `gate: string` and `mode: string`.
  - Parse `validation_json` via `normalizeValidation` → set `gates`. `total_gates = gates.length`.
  - Rounds reconstruction: key events by `(attempt, gate)`. `validation_started`/`validation_verdict`/`validation_error` now carry `gate` in payload; when absent (old single-gate rows) use the sole gate's name (or `'default'`). Compute `passed_gates` = number of DISTINCT gates whose latest verdict is PASS at the current attempt. `in_progress` unchanged (status === 'validating').
  - `latest` = the aggregate `verdict_json` (already written by `applyGateVerdicts` with the `gates` map) — keep the aggregate verdict/evidence/gaps.

- [ ] **Build — template serialization.** In `library-api.ts`, change `projectValidation` to emit `gates`:

```typescript
function projectValidation(v: unknown): { gates: Array<{ name: string; mode: string; criteria?: string }> } | undefined {
  const cfg = normalizeValidation(v);  // import from recipe-steps-store.ts
  if (!cfg) return undefined;
  return { gates: cfg.gates.map((g) => ({ name: g.name, mode: g.mode, ...(g.criteria ? { criteria: g.criteria } : {}) })) };
}
```

Update the `RecipeStepView.validation` type to `{ gates: Array<{ name; mode; criteria? }> }`.

- [ ] **Tests.** Add a serialization test (real DB): seed a 2-gate step, drive it through the worker (fakes) to `done` with a FAIL-then-PASS on one gate, then call the instance serializer (`listAllRecipeInstancesFromDb` or `readStepsFromDb`) and assert `step.validation.gates.length === 2`, `total_gates === 2`, and `rounds` contain per-gate entries with the `gate` field set. Also assert `library-api` `projectValidation` emits `gates` for both a single-object and an array validation.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-multi-gate.test.mjs tests/recipe-validation-worker.test.mjs
npm run typecheck
git add src/recipe-instances-store.ts src/cli/library-api.ts tests/recipe-multi-gate.test.mjs
git commit -m "feat(recipe): serialize multi-gate config + per-gate validation rounds"
```

---

### Task 6: Frontend — per-gate UI

**Files:**
- Modify: `mcp-server/web/src/api.ts` (types)
- Modify: `mcp-server/web/src/components/RecipeDetailPanel.vue` (instance)
- Modify: `mcp-server/web/src/components/RecipeFlow.vue` (node badge)
- Modify: `mcp-server/web/src/components/LibraryRecipes.vue` (step list)

- [ ] **Build — types (`api.ts`).** Add `ValidationGate { name; mode; criteria? }`. On `StepValidation` add `gates: ValidationGate[]`, `passed_gates: number`, `total_gates: number`. On `ValidationRound` add `gate: string; mode: string`. On `LibraryRecipeStep.validation` change to `{ gates: ValidationGate[] }` (was `{ mode; criteria? }`).

- [ ] **Build — instance (`RecipeDetailPanel.vue`).** In the `.step-validation` block:
  - Header: when `s.validation.total_gates > 1`, show a chip `{{ s.validation.passed_gates }}/{{ s.validation.total_gates }} gates passed` next to the mode chip; the mode chip becomes `🛡 ×{{ total_gates }}`.
  - Rounds: group `s.validation.rounds` by `attempt` (a computed `roundsByAttempt`), render one "Attempt N" block; within it, one sub-card per round entry showing `round.gate` (a gate-name chip) + `round.mode` chip + the existing verdict/evidence/gaps markup. Single-gate steps (`total_gates === 1`) render exactly as today (the single gate's rounds; no gate chip needed — hide the gate chip when `total_gates === 1`).
  - Keep all existing styles; add `.sv-gate-name` chip + `.sv-attempt` group styles.

- [ ] **Build — flow node (`RecipeFlow.vue`).** The node gate badge: when `p.validation.gates.length > 1` show `🛡 ×{{ p.validation.gates.length }}`; else `🛡 {{ p.validation.gates[0].mode }}`. Guard all reads through `p.validation?.gates`.

- [ ] **Build — step list (`LibraryRecipes.vue`).** Replace the single `s.validation.mode`/`criteria` block with a loop over `s.validation.gates`: for each gate render `🛡 {{ gate.mode }}` · `gate.name` · `gateExplain(gate.mode)` · optional `gate.criteria`. Keep `gateExplain`.

- [ ] **Verify + commit.**

```bash
cd web && npm run build    # vue-tsc typecheck + vite build
cd ..
git add web/src/api.ts web/src/components/RecipeDetailPanel.vue web/src/components/RecipeFlow.vue web/src/components/LibraryRecipes.vue
git commit -m "feat(web): render multiple validation gates per step (per-gate rounds + node badge)"
```

---

### Task 7: Real end-to-end + activation

**Files:** none (verification only) + a throwaway demo recipe.

- [ ] **Restart the source server** so the new backend (migration v16 + multi-gate worker) loads: stop the running tsx server on :5201, restart `node <tsx-cli> mcp-server/src/cli/index.ts start`, confirm `validation-worker: started` + `schema_version` includes 16 + `healthz` ok. (The server runs from source via tsx; no rebuild needed for backend. The web SPA is served from `web/dist` — Task 6's `npm run build` already refreshed it.)

- [ ] **Real multi-gate run (no mocks).** Write a throwaway `~/.clawdevbox/recipes/multigate-demo.yaml` with a step declaring TWO gates (evidence + artifacts) whose criteria are deterministically checkable (e.g. gate `config` checks `config.json` content; gate `readme` checks `README.md` first line). `POST /spawn` a copilot runner to run it, instructing it to under-deliver ONE gate on the first attempt (so it FAILs → combined gaps → fix → both PASS). Poll the DB: confirm the step goes `validating` → (2 verifiers spawn) → `running(rework)` on the partial FAIL → `validating` → `done` when both gates PASS. Confirm `validation.gates.length === 2` and rounds show both gates across 2 attempts via `/api/recipes`.

- [ ] **Screenshot the UI** (Playwright, deep-link `/recipes/<id>` + `/library/recipes` → select multigate-demo): capture the per-gate rounds (with the `N/2 gates passed` chip + per-gate sub-cards) and the `🛡 ×2` flow node. Clean up temp scripts; keep or remove the demo recipe per user preference.

- [ ] **Record** a memory: multi-gate is live (schema, `validation_runs_json`, aggregate precedence, per-gate verdict-file path convention). Update the `implement-work-item` follow-up note (some steps can now use combined gates).

---

## Self-review

- **Spec coverage:** §3 schema → Task 1; §4 data/migration → Task 2; §6 aggregation → Task 3; §5 runtime → Task 4; §7 serialization+UI → Tasks 5–6; §8 backward-compat → single-gate fast path (Tasks 3–6) + regression suites each task; §9 testing → tests in every task + Task 7 real e2e; §10 files → all mapped.
- **Placeholder scan:** every code step carries real code; the two "read the exact shape then mirror" notes (migration framework shape in Task 2, `coerceStepBlock` array handling in Task 1) are flagged with the precise anchor + expected change, matching the accepted runtime-plan style.
- **Type consistency:** `ValidationGate`, `ValidationConfig`, `normalizeValidation`, `applyGateVerdicts`, `verdictFilePath(…, gate?)`, `StepValidation.gates/passed_gates/total_gates`, `ValidationRound.gate/mode` are used consistently across tasks and mirrored FE↔BE.
- **Backward-compat guard:** single-gate path keeps the gate-less verdict-file path + `applyVerdict` wrapper + `total_gates===1` UI branch, and every task re-runs the existing single-gate suites.

## Out of scope (follow-ups, per spec §11)

- Applying multi-gates to `implement-work-item` (e.g. step 10 = evidence + artifacts) + the deferred step-13 evidence gate — recipe-content edits after this ships.
- Per-gate independent rework / OR / sequential semantics — rejected in brainstorm.
