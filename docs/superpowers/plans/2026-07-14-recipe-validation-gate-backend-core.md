# Recipe Validation Gate — Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Cadence (per user preference):** batched task-level TDD — each task = write complete code + complete tests, run the suite + typecheck, commit. Tests are written test-first in spirit but NOT run per-assertion red→green. Full coverage, no micro-step ceremony.

**Goal:** Make step completion un-fakeable for opt-in steps: a step with a `validation` block can only reach `done` via a server-applied verifier verdict, enforced in the pure state machine.

**Architecture:** Extend the existing monotonic step machine (`recipe-steps-store.ts`). Add a `validating` state and per-step `validation`/`execution` contracts. A gated step has **no `running → done` edge**; `done` is reachable only through `validating` + a verdict applied via a `viaVerdict` flag no agent-facing tool sets. A pure `applyVerdict()` function encodes PASS/FAIL/BLOCKED/stalemate. This plan is the backend core only — the worker-loop that spawns headless verifiers, claim-and-release delivery, and the UI are follow-on plans (see end).

**Tech Stack:** TypeScript (Node `--experimental-strip-types` via tsx), better-sqlite3, `node:test`. Spec: `docs/superpowers/specs/2026-07-14-recipe-step-validation-and-isolated-execution-design.md` (§5.2–5.5, §6).

---

## File structure

- Modify `mcp-server/src/db/migrations.ts` — append migration v14 (six columns).
- Modify `mcp-server/src/db/recipe-steps-store.ts` — `RecipeStepRow` fields, `RecipeStepStatus`, `MONOTONIC_TRANSITIONS`, `Step`/`ValidationDecl`/`ExecutionDecl`, `materializeSteps` persistence, `rowToStep` mapping, `StepValidationRequiredError`, `transitionStatus` guard + `viaVerdict`.
- Create `mcp-server/src/recipe-validation.ts` — pure `applyVerdict()`.
- Modify `mcp-server/src/recipe-step-tools.ts` — surface `STEP_VALIDATION_REQUIRED` in `updateStatusImpl`.
- Modify `mcp-server/src/validators.ts` — accept + type-check `validation`/`execution` blocks in `validateRecipeParsed`.
- Create `mcp-server/tests/recipe-step-validation.test.mjs` — all tests for this plan (grows per task).

All commands run from `mcp-server/`.

---

### Task 1: Migration v14 + row shape

**Files:**
- Modify: `mcp-server/src/db/migrations.ts` (append after the v13 object, before the closing `];`)
- Modify: `mcp-server/src/db/recipe-steps-store.ts` (`RecipeStepRow` interface, ~line 73)
- Test: `mcp-server/tests/recipe-step-validation.test.mjs` (create)

- [ ] **Build — migration.** In `migrations.ts`, append to the `migrations` array:

```typescript
  {
    version: 14,
    up: (db) => {
      // Validation gate + isolated execution (spec 2026-07-14). Opt-in per step:
      // a `validation` block routes completion through a `validating` state whose
      // ONLY path to `done` is the server worker-loop applying a verifier verdict.
      // `execution` selects fresh-session vs inline run. All nullable / defaulted,
      // so steps that opt into nothing behave exactly as before.
      db.exec(`
        ALTER TABLE recipe_steps ADD COLUMN validation_json TEXT;
        ALTER TABLE recipe_steps ADD COLUMN execution_json TEXT;
        ALTER TABLE recipe_steps ADD COLUMN verifier_session_id TEXT;
        ALTER TABLE recipe_steps ADD COLUMN verdict_json TEXT;
        ALTER TABLE recipe_steps ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE recipe_steps ADD COLUMN validation_attempt INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
```

- [ ] **Build — row shape.** In `recipe-steps-store.ts` `RecipeStepRow`, add after `required: number;`:

```typescript
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
```

- [ ] **Tests.** Create `tests/recipe-step-validation.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import {
  materializeSteps,
  transitionStatus,
  getStep,
  getStepById,
  StepValidationRequiredError,
} from '../src/db/recipe-steps-store.ts';
import { ToolErrorBox, updateStatusImpl } from '../src/recipe-step-tools.ts';
import { applyVerdict } from '../src/recipe-validation.ts';
import { validateRecipeParsed } from '../src/validators.ts';

function open() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_val_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (
       id, recipe_id, workspace_id, workspace_path, prompt,
       params_json, started_at, status
     ) VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

// A convenience to drive a step to `validating` (claim) for later tasks.
function claim(db, instanceId, stepId) {
  const row = getStep(db, instanceId, stepId);
  transitionStatus(db, row.id, { status: 'running' });
  transitionStatus(db, row.id, { status: 'validating', result: 'claimed: PR open' });
  return getStep(db, instanceId, stepId);
}

test('migration v14 adds the validation columns with correct defaults', () => {
  const db = open();
  const cols = db.prepare(`PRAGMA table_info(recipe_steps)`).all().map((c) => c.name);
  for (const c of ['validation_json', 'execution_json', 'verifier_session_id', 'verdict_json', 'rework_count', 'validation_attempt']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
  const { instanceId } = seed(db, [{ id: 's', goal: 'g' }]);
  const row = getStep(db, instanceId, 's');
  assert.equal(row.validation_json, null);
  assert.equal(row.rework_count, 0);
  assert.equal(row.validation_attempt, 0);
});

export { open, seed, claim };
```

> Note: `applyVerdict`, `StepValidationRequiredError`, and later helpers are imported up front so the file compiles once they exist (Tasks 3–4). Run this task's test alone until then, or comment the not-yet-created imports while iterating.

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
# Expected: the migration-columns test passes (others error until their code lands — see note).
git add src/db/migrations.ts src/db/recipe-steps-store.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): migration v14 — validation/execution step columns"
```

---

### Task 2: `validating` state + `validation`/`execution` contracts persisted

**Files:**
- Modify: `mcp-server/src/db/recipe-steps-store.ts` (`RecipeStepStatus` ~14, `MONOTONIC_TRANSITIONS` ~96, `Step` ~46, `materializeSteps` ~192, `rowToStep` ~145)
- Test: `mcp-server/tests/recipe-step-validation.test.mjs`

- [ ] **Build — status + transitions.** In `recipe-steps-store.ts`:

```typescript
export type RecipeStepStatus =
  | 'pending'
  | 'running'
  | 'validating'
  | 'done'
  | 'failed'
  | 'awaiting_user'
  | 'skipped';
```

```typescript
export const MONOTONIC_TRANSITIONS: Record<RecipeStepStatus, RecipeStepStatus[]> = {
  pending: ['running', 'skipped'],
  running: ['awaiting_user', 'validating', 'done', 'failed', 'skipped'],
  validating: ['running', 'done', 'awaiting_user', 'failed', 'skipped'],
  awaiting_user: ['running', 'validating', 'done', 'failed', 'skipped'],
  done: [],
  failed: [],
  skipped: [],
};
```

(The table still lists `running → done`; the *gated*-step block on that edge is enforced in Task 3 so non-gated steps keep today's behavior.)

- [ ] **Build — contracts + Step.** Add near the other decl interfaces (after `ArtifactDecl`, ~line 44):

```typescript
export interface ValidationDecl {
  mode: 'evidence' | 'artifacts' | 'judge';
  criteria?: string;
  max_rework?: number;
  verifier_model?: string;
}

export interface ExecutionDecl {
  mode: 'inline' | 'fresh-session';
  isolation?: 'required';
  model?: string;
}
```

Add to `interface Step` (after `required?: boolean;`):

```typescript
  /** Opt-in validation gate. When present, the step reaches `done` only via a
   *  server-applied verifier verdict (never a direct running→done). */
  validation?: ValidationDecl;
  /** How the step's own work runs. Absent = inline (today's behavior). */
  execution?: ExecutionDecl;
```

- [ ] **Build — persist in `materializeSteps`.** Extend the INSERT column list + values. Change the statement (~192) to include the two JSON columns:

```typescript
  const insertStmt = db.prepare(
    `INSERT INTO recipe_steps (
       id, recipe_instance_id, step_index, step_id, name, goal,
       depends_json, params_schema_json, triggers_decl_json, artifacts_decl_json,
       required, validation_json, execution_json, status, state_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  );
```

And in the `.run(...)` values, insert the two after `s.required ? 1 : 0,` (before the `state` arg):

```typescript
        s.required ? 1 : 0,
        s.validation ? JSON.stringify(s.validation) : null,
        s.execution ? JSON.stringify(s.execution) : null,
        JSON.stringify(state),
```

Apply the **same two additions** to the `updateMeta` INSERT (~372) so dynamically-added steps carry the contracts (add `validation_json, execution_json` to its column list, and `s.validation ? JSON.stringify(s.validation) : null, s.execution ? JSON.stringify(s.execution) : null,` after its `s.required ? 1 : 0,`).

- [ ] **Build — expose in `rowToStep`.** After `required: row.required === 1,` (~155):

```typescript
    validation: row.validation_json ? JSON.parse(row.validation_json) : undefined,
    execution: row.execution_json ? JSON.parse(row.execution_json) : undefined,
```

- [ ] **Tests.** Append:

```javascript
import { rowToStep } from '../src/db/recipe-steps-store.ts';

test('materializeSteps persists validation/execution as JSON, null when absent', () => {
  const db = open();
  const { instanceId } = seed(db, [
    { id: 'gated', goal: 'PR', validation: { mode: 'evidence', max_rework: 2 } },
    { id: 'plain', goal: 'setup' },
  ]);
  const gated = getStep(db, instanceId, 'gated');
  assert.deepEqual(JSON.parse(gated.validation_json), { mode: 'evidence', max_rework: 2 });
  assert.equal(getStep(db, instanceId, 'plain').validation_json, null);
});

test('running can transition to validating', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'gated', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'gated');
  transitionStatus(db, row.id, { status: 'running' });
  const after = transitionStatus(db, row.id, { status: 'validating' });
  assert.equal(after.status, 'validating');
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
npm run typecheck
# Expected: migration + persistence + validating-transition tests PASS.
git add src/db/recipe-steps-store.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): validating state + validation/execution step contracts"
```

---

### Task 3: Gated-step transition enforcement (the guarantee)

**Files:**
- Modify: `mcp-server/src/db/recipe-steps-store.ts` (`StepValidationRequiredError` near `StepRequiredError` ~130; `transitionStatus` opts + guard ~252/275)
- Test: `mcp-server/tests/recipe-step-validation.test.mjs`

- [ ] **Build — error class.** Add after the `StepRequiredError` class:

```typescript
export class StepValidationRequiredError extends Error {
  code = 'STEP_VALIDATION_REQUIRED';
  readonly step_id: string;
  constructor(step_id: string, detail: string) {
    super(`Step '${step_id}' is validation-gated: ${detail}.`);
    this.step_id = step_id;
  }
}
```

- [ ] **Build — `viaVerdict` opt + guard.** Add `viaVerdict?: boolean;` to the `transitionStatus` `opts` object type. Then, inside the `if (opts.status && opts.status !== current.status)` block, immediately after the existing `required`/`skipped` check and BEFORE the `MONOTONIC_TRANSITIONS` lookup, insert:

```typescript
      // Gated steps cannot be self-certified: no direct running→done, and
      // `validating → done` only through the verdict path (viaVerdict).
      const isGated = current.validation_json != null;
      if (isGated && opts.status === 'done') {
        if (current.status === 'running') {
          throw new StepValidationRequiredError(
            current.step_id,
            'must enter `validating` (claim) first — a gated step cannot go running→done directly',
          );
        }
        if (current.status === 'validating' && !opts.viaVerdict) {
          throw new StepValidationRequiredError(
            current.step_id,
            'only a verifier verdict can finalize a validating step',
          );
        }
      }
```

- [ ] **Tests.** Append:

```javascript
test('gated step: running→done is rejected (must claim first)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'done' }),
    (e) => e instanceof StepValidationRequiredError && e.code === 'STEP_VALIDATION_REQUIRED',
  );
  assert.equal(getStepById(db, row.id).status, 'running');
});

test('gated step: validating→done without viaVerdict is rejected', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = claim(db, instanceId, 'g');
  assert.throws(
    () => transitionStatus(db, row.id, { status: 'done' }),
    (e) => e instanceof StepValidationRequiredError,
  );
});

test('gated step: validating→done WITH viaVerdict succeeds', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = claim(db, instanceId, 'g');
  const done = transitionStatus(db, row.id, { status: 'done', viaVerdict: true });
  assert.equal(done.status, 'done');
});

test('non-gated step: running→done still works (backward compatible)', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'p', goal: 'plain' }]);
  const row = getStep(db, instanceId, 'p');
  transitionStatus(db, row.id, { status: 'running' });
  assert.equal(transitionStatus(db, row.id, { status: 'done' }).status, 'done');
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
npm run typecheck
# Expected: all four enforcement tests PASS; backward-compat test PASS.
git add src/db/recipe-steps-store.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): enforce validating gate — no self-certified done for gated steps"
```

---

### Task 4: `applyVerdict()` — PASS / FAIL / BLOCKED / stalemate

**Files:**
- Create: `mcp-server/src/recipe-validation.ts`
- Test: `mcp-server/tests/recipe-step-validation.test.mjs`

- [ ] **Build.** Create `src/recipe-validation.ts`:

```typescript
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

export function applyVerdict(db: Database, opts: ApplyVerdictOpts): ApplyVerdictResult {
  const step = getStep(db, opts.recipe_instance_id, opts.step_id);
  if (!step) throw new VerdictError('STEP_NOT_FOUND', `step '${opts.step_id}' not found`);
  if (step.status !== 'validating') {
    throw new VerdictError('NOT_VALIDATING', `step '${opts.step_id}' is ${step.status}, not validating`);
  }
  const validation = step.validation_json ? JSON.parse(step.validation_json) : null;
  const maxRework = (validation && typeof validation.max_rework === 'number')
    ? validation.max_rework
    : DEFAULT_MAX_REWORK;

  const v = opts.verdict;
  const tx = db.transaction((): ApplyVerdictResult => {
    // Persist the verdict blob + audit event regardless of kind.
    const persistVerdict = () => {
      db.prepare(`UPDATE recipe_steps SET verdict_json = ? WHERE id = ?`)
        .run(JSON.stringify(v), step.id);
      appendEvent(db, {
        recipe_step_id: step.id,
        recipe_instance_id: opts.recipe_instance_id,
        agent_session_id: opts.agent_session_id ?? null,
        type: 'validation_verdict',
        payload: { verdict: v.verdict, evidence: v.evidence, gaps: v.gaps ?? null, trigger_id: v.trigger_id ?? null },
      });
    };

    if (v.verdict === 'PASS') {
      transitionStatus(db, step.id, { status: 'done', result: v.evidence, viaVerdict: true });
      persistVerdict();
      return { status: 'done', rework_count: step.rework_count, outcome: 'passed' };
    }

    if (v.verdict === 'BLOCKED') {
      if (!v.trigger_id) {
        throw new VerdictError('BLOCKED_REQUIRES_TRIGGER', 'BLOCKED verdict must supply a registered trigger_id');
      }
      transitionStatus(db, step.id, {
        status: 'awaiting_user',
        viaVerdict: true,
        awaiting_user_message: `Blocked on external event; watcher ${v.trigger_id}. ${v.evidence}`,
      });
      persistVerdict();
      return { status: 'awaiting_user', rework_count: step.rework_count, outcome: 'blocked' };
    }

    // FAIL
    const nextRework = step.rework_count + 1;
    db.prepare(`UPDATE recipe_steps SET rework_count = ? WHERE id = ?`).run(nextRework, step.id);
    if (nextRework >= maxRework) {
      transitionStatus(db, step.id, {
        status: 'awaiting_user',
        viaVerdict: true,
        awaiting_user_message: `Validation stalemate after ${nextRework} attempts. Gaps: ${v.gaps ?? '(none given)'}`,
      });
      persistVerdict();
      return { status: 'awaiting_user', rework_count: nextRework, outcome: 'stalemate' };
    }
    transitionStatus(db, step.id, {
      status: 'running',
      viaVerdict: true,
      message: `Validation FAILED (attempt ${nextRework}). Fix: ${v.gaps ?? '(no gaps given)'}`,
    });
    persistVerdict();
    return { status: 'running', rework_count: nextRework, outcome: 'rework' };
  });
  return tx();
}
```

- [ ] **Tests.** Append:

```javascript
test('applyVerdict PASS → done, stores evidence + verdict + event', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  claim(db, instanceId, 'g');
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'PASS', evidence: 'PR #123 merged, 540 tests green' },
  });
  assert.equal(res.outcome, 'passed');
  const row = getStep(db, instanceId, 'g');
  assert.equal(row.status, 'done');
  assert.match(row.result, /PR #123 merged/);
  assert.equal(JSON.parse(row.verdict_json).verdict, 'PASS');
});

test('applyVerdict FAIL → running with rework_count incremented', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 3 } }]);
  claim(db, instanceId, 'g');
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'FAIL', evidence: 'no PR found', gaps: 'open the PR' },
  });
  assert.equal(res.outcome, 'rework');
  assert.equal(res.rework_count, 1);
  assert.equal(getStep(db, instanceId, 'g').status, 'running');
});

test('applyVerdict FAIL at max_rework → awaiting_user stalemate', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence', max_rework: 1 } }]);
  claim(db, instanceId, 'g');
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'FAIL', evidence: 'still not done', gaps: 'do it' },
  });
  assert.equal(res.outcome, 'stalemate');
  assert.equal(getStep(db, instanceId, 'g').status, 'awaiting_user');
});

test('applyVerdict BLOCKED without trigger_id throws; with trigger_id → awaiting_user', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  claim(db, instanceId, 'g');
  assert.throws(
    () => applyVerdict(db, { recipe_instance_id: instanceId, step_id: 'g', verdict: { verdict: 'BLOCKED', evidence: 'gated' } }),
    (e) => e.code === 'BLOCKED_REQUIRES_TRIGGER',
  );
  const res = applyVerdict(db, {
    recipe_instance_id: instanceId, step_id: 'g',
    verdict: { verdict: 'BLOCKED', evidence: 'waiting on merge', trigger_id: 'ado.new-pr-watcher#abc' },
  });
  assert.equal(res.outcome, 'blocked');
  assert.equal(getStep(db, instanceId, 'g').status, 'awaiting_user');
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
npm run typecheck
# Expected: all applyVerdict tests PASS.
git add src/recipe-validation.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): applyVerdict — PASS/FAIL/BLOCKED/stalemate verdict application"
```

---

### Task 5: Tool error surfacing + recipe-source validation

**Files:**
- Modify: `mcp-server/src/recipe-step-tools.ts` (`updateStatusImpl` catch block, ~490)
- Modify: `mcp-server/src/validators.ts` (`validateRecipeParsed` step loop, ~277; and carry `validation`/`execution` through `parseRecipeSource` the same way `required` is carried)
- Test: `mcp-server/tests/recipe-step-validation.test.mjs`

- [ ] **Build — tool error.** In `recipe-step-tools.ts`, import `StepValidationRequiredError` from `./db/recipe-steps-store.ts` (add to the existing import list), and in `updateStatusImpl`'s `catch (e)` block (where `StepRequiredError` is handled) add, before the `StepTransitionError` check:

```typescript
        if (e instanceof StepValidationRequiredError) {
          throw new ToolErrorBox({
            code: 'STEP_VALIDATION_REQUIRED',
            message: e.message,
            detail: { step_id: e.step_id },
          });
        }
```

- [ ] **Build — recipe validation.** In `validators.ts` `validateRecipeParsed`, right after the `required` block (~277), add:

```typescript
        // validation — optional block enabling the completion gate.
        if (step.validation !== undefined) {
          if (!isPlainObject(step.validation)) {
            errors.push({ path: `${pathPrefix}.validation`, code: 'TYPE', message: 'step.validation must be an object.' });
          } else {
            const vm = step.validation.mode;
            if (typeof vm !== 'string' || !['evidence', 'artifacts', 'judge'].includes(vm)) {
              errors.push({ path: `${pathPrefix}.validation.mode`, code: 'ENUM', message: 'validation.mode must be one of: evidence, artifacts, judge.' });
            }
            if (step.validation.max_rework !== undefined && (typeof step.validation.max_rework !== 'number' || !Number.isInteger(step.validation.max_rework))) {
              errors.push({ path: `${pathPrefix}.validation.max_rework`, code: 'TYPE', message: 'validation.max_rework must be an integer.' });
            }
          }
        }
        // execution — optional block selecting how the step's work runs.
        if (step.execution !== undefined) {
          if (!isPlainObject(step.execution)) {
            errors.push({ path: `${pathPrefix}.execution`, code: 'TYPE', message: 'step.execution must be an object.' });
          } else {
            const em = step.execution.mode;
            if (typeof em !== 'string' || !['inline', 'fresh-session'].includes(em)) {
              errors.push({ path: `${pathPrefix}.execution.mode`, code: 'ENUM', message: 'execution.mode must be one of: inline, fresh-session.' });
            }
          }
        }
```

- [ ] **Build — parser passthrough.** In `parseRecipeSource` (same file), wherever a parsed step object is assembled into a `Step` (the place that already copies `required`), also copy `validation` and `execution` from the raw step: `validation: rawStep.validation, execution: rawStep.execution,`. (Mirror exactly how `required` is threaded — the `required` feature already round-trips YAML→Step→DB, so follow that path.)

- [ ] **Tests.** Append:

```javascript
test('updateStatusImpl surfaces STEP_VALIDATION_REQUIRED for a gated running→done', () => {
  const db = open();
  const { instanceId } = seed(db, [{ id: 'g', goal: 'PR', validation: { mode: 'evidence' } }]);
  const row = getStep(db, instanceId, 'g');
  transitionStatus(db, row.id, { status: 'running' });
  assert.throws(
    () => updateStatusImpl(db, { recipe_instance_id: instanceId, step_id: 'g', status: 'done' }),
    (e) => e instanceof ToolErrorBox && e.payload.code === 'STEP_VALIDATION_REQUIRED',
  );
});

test('validateRecipeParsed accepts a valid validation block', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'PR', validation: { mode: 'evidence', max_rework: 2 } }],
  });
  assert.equal(result.ok, true);
});

test('validateRecipeParsed rejects a bad validation.mode', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'PR', validation: { mode: 'vibes' } }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[0].validation.mode' && e.code === 'ENUM'));
});

test('validateRecipeParsed rejects a bad execution.mode', () => {
  const result = validateRecipeParsed({
    id: 'r', name: 'R', description: 'a recipe',
    steps: [{ id: 's1', goal: 'x', execution: { mode: 'parallel-9000' } }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'steps[0].execution.mode' && e.code === 'ENUM'));
});
```

- [ ] **Verify + commit.**

```bash
node --import tsx --test tests/recipe-step-validation.test.mjs
npm run typecheck
# Expected: ALL tests in the file PASS; typecheck clean.
git add src/recipe-step-tools.ts src/validators.ts tests/recipe-step-validation.test.mjs
git commit -m "feat(recipe): surface STEP_VALIDATION_REQUIRED + validate validation/execution blocks"
```

---

## Self-review (author checklist — done)

- **Spec coverage:** §5.2 (validating state + conditional transitions) → Tasks 2–3; §5.5 outcome model (PASS/FAIL/BLOCKED/stalemate) → Task 4; §6 schema → Task 1; validator/tool surfacing → Task 5. The worker-loop/verdict-file (§5.3–5.4), delivery (§5.6), fresh-session execution (§5.7), and UI (§5.9–5.10) are **out of scope for this plan** — see follow-ons.
- **Placeholder scan:** none — every step has complete code + exact commands.
- **Type consistency:** `viaVerdict`, `StepValidationRequiredError`, `ValidationDecl`, `applyVerdict`, `verdict_json`, `rework_count` are defined in earlier tasks and used consistently in later ones; test imports match created exports.

## Follow-on plans (not this plan)

1. **Validation runtime** — the server worker-loop that detects `validating` steps, spawns the headless verifier with coordinates + `CLAWDEVBOX_VERDICT_FILE` (§5.3), reads the verdict file → `applyVerdict` (§5.4), the claim-and-release next-step/gap dispatch (§5.6), and auto-retry + `recipe.steps.revalidate` recovery.
2. **Validation UI** — instance panel + attempt history from `step_events` (§5.9) and template flow-diagram badges + validation prompt in the library (§5.10).
3. **Fresh-session execution (Phase 1b)** — `execution: fresh-session` + `isolation: required` (§5.7), reusing the runtime spawn primitive.
4. **Parallel fan-out (Phase 2)** — separate spec + plan.
