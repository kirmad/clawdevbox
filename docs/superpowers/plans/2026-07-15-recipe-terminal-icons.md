# Recipe Terminal Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the recipe panel's top "Terminal (resume)" button with compact terminal icons that open the *existing* driving CLI session in the Terminals sidebar — one icon per step (resolved via its execution lane) and one per validation round (resolved via its verifier session), plus a single header icon for the recipe's main/orchestrator session.

**Architecture:** Resolve-at-read, **no schema change**. The backend serializer (`recipe-instances-store.ts`) joins `agent_sessions` (`cli_session_id → recipe_instance_id`) to turn the session GUIDs it already stores (`verifier_session_id`, `recipe_lane_sessions.cli_session_id`) into the `recipe_instance_id` the terminal sidebar's `selectTerminal(id)` expects. Each `RecipeStep` gains an optional `lane` + `terminal`, each `ValidationRound` gains an optional `terminal`. The Vue panel renders an icon whenever a `terminal` is present and, on click, selects that terminal in the sidebar (`selectTerminal` + `setActiveTab('agent')`) — **select, never spawn**.

**Tech Stack:** TypeScript, better-sqlite3, Node.js `node:test` (backend); Vue 3 `<script setup>` + PrimeVue + vite/vue-tsc (web).

---

## Background: the three distinct IDs (read before starting)

Confusing these three IDs is the #1 way to break this feature. They are **not** interchangeable:

| Name | Shape | Where it lives | Role |
|---|---|---|---|
| `recipe_instance_id` | `ri_…` | `recipe_instances.id`, `agent_sessions.recipe_instance_id` | **What `selectTerminal(id)` opens.** The terminal sidebar is keyed by this. |
| `cli_session_id` | GUID | `verifier_session_id`, `recipe_lane_sessions.cli_session_id`, `RunRecipeResult.session_id` | The driving CLI conversation GUID. **NOT** a terminal id. |
| `agent_sessions.id` | `as_…` | `agent_sessions` PK | Internal PK. Never surfaced. |

`agent_sessions` is the join table: `cli_session_id → recipe_instance_id`. Everything this feature does is: *take a `cli_session_id` we already have, look up its `recipe_instance_id`, hand that to the UI.*

**Main-lane special case:** a step running on the `main` lane drives on the recipe instance's **own** terminal, whose id **is** the `recipe_instance_id` itself. So for `lane === 'main'` we return `{ instance_id: recipeInstanceId }` directly — no lookup, and it works even for pre-lanes / non-lane recipes that have no `recipe_lane_sessions` row.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `mcp-server/src/recipe-instances-store.ts` | Backend serializer the SPA consumes | Add `TerminalRef` type, `resolveTerminal()` + `resolveStepTerminal()` helpers, `terminal?` on `ValidationRound`, `lane?`+`terminal?` on `RecipeStep`; populate in `buildStepValidation` (rounds) and both step-projection paths (`readStepsFromDb` + the list-path `.map`); add `execution_json` to both step SELECTs + `StepRowLite`; add imports. |
| `mcp-server/tests/recipe-terminal-links.test.mjs` | Backend unit tests for the new resolution | **Create.** Seeds `agent_sessions` + `recipe_lane_sessions`, asserts serialized `terminal`/`lane`. |
| `mcp-server/package.json` | Test runner file list | Register the new test file in `scripts.test`. |
| `mcp-server/web/src/api.ts` | SPA-side type mirror | Add `terminal?` to `ValidationRound`, `lane?`+`terminal?` to `RecipeStep`. |
| `mcp-server/web/src/components/RecipeDetailPanel.vue` | Recipe detail UI | Remove top terminal button + `openTerminal()` + `terminalLabel` + orphaned refs; add `openTerminalInSidebar()` helper, compact header icon, per-step icon, per-round icons. |

The store helpers `resolveTerminal`/`resolveStepTerminal` live next to `buildStepValidation`/`readStepsFromDb` because they change together (same file, same projection concern). No new module is warranted — DRY over premature splitting.

---

## Verification commands (used throughout)

- Backend targeted test: `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-terminal-links.test.mjs`
- Backend typecheck: `cd C:\git\clawdevbox\mcp-server ; npm run typecheck` (`tsc --noEmit`, exits 0 on success)
- Web build gate (the ONLY web gate — there are no web unit tests): `cd C:\git\clawdevbox\mcp-server\web ; npm run build` (`vue-tsc --noEmit && vite build`)
- Web fast type-only check: `cd C:\git\clawdevbox\mcp-server\web ; npx vue-tsc --noEmit`

> ⚠️ Do **not** run `npm test` (unscoped) in `mcp-server` — it includes server/e2e suites that hang. Always run the targeted file(s).

---

### Task 1: Backend — `TerminalRef` type, `resolveTerminal()`, and per-round `terminal`

**Files:**
- Create: `mcp-server/tests/recipe-terminal-links.test.mjs`
- Modify: `mcp-server/src/recipe-instances-store.ts` (add type ~L46, add `terminal?` to `ValidationRound` ~L108, add `resolveTerminal()` helper before `buildStepValidation` ~L146, thread `db` into `buildStepValidation` ~L147 + both callers L543/L978, populate rounds before final `return out` ~L303)
- Modify: `mcp-server/package.json` (`scripts.test`)

- [ ] **Step 1: Register the new test file in `package.json`**

In `mcp-server/package.json`, the `scripts.test` value is a single space-separated list of test files. Insert the new file immediately after `tests/recipe-multi-gate.test.mjs`.

Find:

```
tests/recipe-multi-gate.test.mjs tests/recipe-lane-execution.test.mjs
```

Replace with:

```
tests/recipe-multi-gate.test.mjs tests/recipe-terminal-links.test.mjs tests/recipe-lane-execution.test.mjs
```

Verify:

Run: `cd C:\git\clawdevbox\mcp-server ; node -e "console.log(require('./package.json').scripts.test.includes('recipe-terminal-links'))"`
Expected: `true`

- [ ] **Step 2: Write the failing test for `resolveTerminal` + per-round `terminal`**

Create `mcp-server/tests/recipe-terminal-links.test.mjs`. This file seeds a real instance the same way `recipe-multi-gate.test.mjs` does, plus an `agent_sessions` row that maps a verifier's `cli_session_id` to a `recipe_instance_id`, then asserts the serialized validation round carries the resolved `terminal.instance_id`.

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, setDatabaseForTesting } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { materializeSteps, getStep, transitionStatus } from '../src/db/recipe-steps-store.ts';
import { upsertLaneSession } from '../src/db/lane-sessions-store.ts';
import { appendEvent } from '../src/db/step-events-store.ts';
import { resolveTerminal, listAllRecipeInstancesFromDb } from '../src/recipe-instances-store.ts';

function openDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

// Seed a workspace + instance + steps; return { ws, instanceId }.
function seed(db, steps) {
  const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
  const instanceId = `ri_tl_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'running')`,
  ).run(instanceId, 'r1', ws.id, ws.path, 'prompt', Date.now());
  materializeSteps(db, instanceId, steps);
  return { ws, instanceId };
}

// Insert an agent_sessions row mapping cli_session_id -> recipe_instance_id.
function seedAgentSession(db, wsId, cliSessionId, recipeInstanceId, startedAt) {
  db.prepare(
    `INSERT INTO agent_sessions (id, cli_session_id, recipe_instance_id, workspace_id, agent_cli, started_at, status, interactive)
     VALUES (?, ?, ?, ?, 'copilot', ?, 'running', 1)`,
  ).run(`as_${Math.random().toString(36).slice(2, 8)}`, cliSessionId, recipeInstanceId, wsId, startedAt);
}

test('resolveTerminal: maps a cli_session_id to its recipe_instance_id', () => {
  const db = openDb();
  try {
    const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
    // Two instances so resolveTerminal must pick the right one.
    db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                VALUES ('ri_verifier', 'r', ?, ?, 'p', '{}', ?, 'running')`).run(ws.id, ws.path, Date.now());
    seedAgentSession(db, ws.id, 'cli-guid-A', 'ri_verifier', 1000);

    assert.deepEqual(resolveTerminal(db, 'cli-guid-A'), { instance_id: 'ri_verifier', cli_session_id: 'cli-guid-A' });
    assert.equal(resolveTerminal(db, 'no-such-guid'), null);
    assert.equal(resolveTerminal(db, null), null);
    assert.equal(resolveTerminal(db, undefined), null);
  } finally {
    db.close();
  }
});

test('resolveTerminal: newest agent_sessions row wins on duplicate cli_session_id', () => {
  const db = openDb();
  try {
    const ws = ensureWorkspace(db, { path: `C:/fake-ws-${Math.random().toString(36).slice(2)}` });
    for (const id of ['ri_old', 'ri_new']) {
      db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                  VALUES (?, 'r', ?, ?, 'p', '{}', ?, 'running')`).run(id, ws.id, ws.path, Date.now());
    }
    seedAgentSession(db, ws.id, 'cli-guid-B', 'ri_old', 1000);
    seedAgentSession(db, ws.id, 'cli-guid-B', 'ri_new', 2000);
    assert.equal(resolveTerminal(db, 'cli-guid-B').instance_id, 'ri_new');
  } finally {
    db.close();
  }
});

test('serialize: a validation round carries the verifier terminal (resolved from verifier_session_id)', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { ws, instanceId } = seed(db, [{ id: 'g', goal: 'ship it', validation: { mode: 'evidence' } }]);
    // The verifier ran as its own recipe instance; map its cli session -> that instance.
    const ws2 = ensureWorkspace(db, { path: `C:/verif-${Math.random().toString(36).slice(2)}` });
    db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                VALUES ('ri_verif_1', 'r', ?, ?, 'p', '{}', ?, 'running')`).run(ws2.id, ws2.path, Date.now());
    seedAgentSession(db, ws2.id, 'verifier-guid-1', 'ri_verif_1', 5000);

    // Drive the step into a validating state and emit a validation round.
    const row = getStep(db, instanceId, 'g');
    transitionStatus(db, row.id, { status: 'running' });
    transitionStatus(db, row.id, { status: 'validating' });
    appendEvent(db, {
      recipe_instance_id: instanceId,
      recipe_step_id: row.id,
      type: 'validation_started',
      payload: { attempt: 0, verifier_session_id: 'verifier-guid-1' },
    });
    appendEvent(db, {
      recipe_instance_id: instanceId,
      recipe_step_id: row.id,
      type: 'validation_verdict',
      payload: { verdict: 'PASS', evidence: 'looks good' },
    });

    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 'g');
    const round = step.validation.rounds[0];
    assert.equal(round.verifier_session_id, 'verifier-guid-1');
    assert.deepEqual(round.terminal, { instance_id: 'ri_verif_1', cli_session_id: 'verifier-guid-1' });
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});
```

> **Verified helpers (no need to re-check):** `appendEvent(db, { recipe_step_id, recipe_instance_id, type, payload })` is the real step-event insert (`mcp-server/src/db/step-events-store.ts:46`); `type` accepts `'validation_started'`/`'validation_verdict'`. `materializeSteps`/`getStep`/`transitionStatus` are used verbatim by `tests/recipe-multi-gate.test.mjs`, so they match this usage.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-terminal-links.test.mjs`
Expected: FAIL — `resolveTerminal` is not exported (`resolveTerminal is not a function` / import error), and `round.terminal` is `undefined`.

- [ ] **Step 4: Add the `TerminalRef` type**

In `mcp-server/src/recipe-instances-store.ts`, immediately after the `RecipeStepStatus` type (~L50, before `export interface RecipeStep`), add:

```typescript
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
```

- [ ] **Step 5: Add `terminal?` to `ValidationRound`**

In the `ValidationRound` interface, after the `verifier_session_id?` field (~L108), add:

```typescript
  /** Resolved terminal for this verifier round (from `verifier_session_id`). */
  terminal?: TerminalRef;
```

- [ ] **Step 6: Add the `resolveTerminal()` helper**

Immediately **before** `function buildStepValidation(` (~L146), add:

```typescript
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
```

- [ ] **Step 7: Thread `db` into `buildStepValidation` and populate each round's `terminal`**

Change the `buildStepValidation` signature (~L147) to accept `db` as its first parameter:

Find:

```typescript
function buildStepValidation(
  fields: {
```

Replace with:

```typescript
function buildStepValidation(
  db: Database,
  fields: {
```

Then, at the very end of `buildStepValidation`, immediately before the final `return out;` (~L303, the one right after the closing `}` of the multi-gate `else` block), insert the terminal-resolution walk:

Find (this exact tail):

```typescript
    out.passed_gates = passed.size;
  }
  return out;
}
```

Replace with:

```typescript
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
```

- [ ] **Step 8: Update both `buildStepValidation` callers to pass `db`**

There are exactly two call sites. Update both.

In `readStepsFromDb` (~L543):

Find:

```typescript
    const validation = buildStepValidation(r, eventsByStep.get(r.id) ?? []);
```

Replace with:

```typescript
    const validation = buildStepValidation(db, r, eventsByStep.get(r.id) ?? []);
```

In the list-path `.map` inside `listAllRecipeInstancesFromDb` (~L978):

Find:

```typescript
        const validation = buildStepValidation(r, validationEventsByStep.get(r.id) ?? []);
```

Replace with:

```typescript
        const validation = buildStepValidation(conn, r, validationEventsByStep.get(r.id) ?? []);
```

> Note: the list path's DB handle variable is `conn` (not `db`). Confirm by reading the enclosing function header — the `SELECT` a few lines above uses `conn.prepare(...)`.

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-terminal-links.test.mjs`
Expected: PASS (3 tests: the two `resolveTerminal` tests + the round-terminal serialize test).

- [ ] **Step 10: Typecheck**

Run: `cd C:\git\clawdevbox\mcp-server ; npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 11: Commit**

```bash
git add mcp-server/src/recipe-instances-store.ts mcp-server/tests/recipe-terminal-links.test.mjs mcp-server/package.json
git commit -m "feat(recipe): resolve verifier round terminals (backend)

Add TerminalRef + resolveTerminal() and surface a resolved terminal on
each ValidationRound via its verifier_session_id.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 158a5132-efef-48d1-8613-73c75a899d11"
```

---

### Task 2: Backend — per-step `lane` + `terminal` (both projection paths)

**Files:**
- Modify: `mcp-server/src/recipe-instances-store.ts` (imports L41 + new import; `RecipeStep` interface ~L82; `StepRowLite` ~L487; `readStepsFromDb` SELECT ~L497 + `.map` ~L540; list-path SELECT ~L928 + `.map` ~L976; add `resolveStepTerminal()` helper near `resolveTerminal`)
- Modify: `mcp-server/tests/recipe-terminal-links.test.mjs` (add step-lane tests)

- [ ] **Step 1: Write the failing tests for per-step `lane` + `terminal`**

First, re-add the `upsertLaneSession` import at the top of `mcp-server/tests/recipe-terminal-links.test.mjs` (it was removed in Task 1 as unused; Task 2's lane tests need it). After the `import { materializeSteps, getStep, transitionStatus } ...` line, add:

```javascript
import { upsertLaneSession } from '../src/db/lane-sessions-store.ts';
```

Then append the three lane tests to `mcp-server/tests/recipe-terminal-links.test.mjs`:

```javascript
test('serialize: a main-lane step gets terminal = the recipe instance itself', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { instanceId } = seed(db, [{ id: 's1', goal: 'do the thing' }]);
    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 's1');
    // No explicit execution => main lane => the instance's own terminal.
    assert.deepEqual(step.terminal, { instance_id: instanceId });
    assert.ok(step.lane === undefined || step.lane === 'main');
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('serialize: a fresh-session step resolves its lane terminal via recipe_lane_sessions', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    // Step declares execution.session: 'impl' -> lane 'impl'.
    const { ws, instanceId } = seed(db, [
      { id: 's2', goal: 'implement', execution: { session: 'impl', mode: 'fresh-session' } },
    ]);
    // The lane 'impl' spawned a CLI session 'impl-guid' which ran as instance 'ri_impl'.
    const ws3 = ensureWorkspace(db, { path: `C:/impl-${Math.random().toString(36).slice(2)}` });
    db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status)
                VALUES ('ri_impl', 'r', ?, ?, 'p', '{}', ?, 'running')`).run(ws3.id, ws3.path, Date.now());
    seedAgentSession(db, ws3.id, 'impl-guid', 'ri_impl', 7000);
    upsertLaneSession(db, { recipe_instance_id: instanceId, lane: 'impl', cli_session_id: 'impl-guid' });

    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 's2');
    assert.equal(step.lane, 'impl');
    assert.deepEqual(step.terminal, { instance_id: 'ri_impl', cli_session_id: 'impl-guid' });
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});

test('serialize: a fresh-session step with no lane session yet has no terminal', () => {
  const db = openDb();
  setDatabaseForTesting(db);
  try {
    const { instanceId } = seed(db, [
      { id: 's3', goal: 'pending impl', execution: { session: 'impl', mode: 'fresh-session' } },
    ]);
    const inst = listAllRecipeInstancesFromDb().find((i) => i.id === instanceId);
    const step = inst.steps.find((s) => s.id === 's3');
    assert.equal(step.lane, 'impl');
    assert.equal(step.terminal, undefined);
  } finally {
    setDatabaseForTesting(null);
    db.close();
  }
});
```

> **Verified:** `materializeSteps` persists a step decl's `execution` into `recipe_steps.execution_json` (`s.execution ? JSON.stringify(s.execution) : null` at `mcp-server/src/db/recipe-steps-store.ts:356`), so the seed's `execution: { session: 'impl', mode: 'fresh-session' }` is stored directly — no manual `UPDATE` needed. `validateDeclarations` accepts `{ session, mode: 'fresh-session' }` (a valid lane decl).

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-terminal-links.test.mjs`
Expected: FAIL — `step.terminal` / `step.lane` are `undefined` for all three new tests (fields not yet projected).

- [ ] **Step 3: Add imports for lane resolution**

In `mcp-server/src/recipe-instances-store.ts`, extend the existing `recipe-steps-store` import (L41) and add the `lane-sessions-store` import right after it:

Find:

```typescript
import { normalizeValidation } from './db/recipe-steps-store.ts';
```

Replace with:

```typescript
import { normalizeValidation, normalizeExecution, resolveLane } from './db/recipe-steps-store.ts';
import { getLaneSession } from './db/lane-sessions-store.ts';
```

- [ ] **Step 4: Add `lane?` + `terminal?` to the `RecipeStep` interface**

In the `RecipeStep` interface, after the `validation?: StepValidation;` field (~L82, just before the closing `}`), add:

```typescript
  /**
   * The execution lane this step runs on (`main` for the orchestrator console,
   * a named session, or `__step:<id>` for an implicit fresh-session step).
   * Present for non-`main` lanes so the UI can badge/deep-link them.
   */
  lane?: string;
  /** Resolved terminal for this step's driving session (from its lane). */
  terminal?: TerminalRef;
```

- [ ] **Step 5: Add the `resolveStepTerminal()` helper**

Immediately **after** the `resolveTerminal()` function you added in Task 1 (before `buildStepValidation`), add:

```typescript
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
```

- [ ] **Step 6: Add `execution_json` to `StepRowLite`**

In the `StepRowLite` interface (~L487), after `rework_count: number | null;` (before the closing `}`), add:

```typescript
  execution_json: string | null;
```

- [ ] **Step 7: Add `execution_json` to the `readStepsFromDb` SELECT**

In `readStepsFromDb` (~L497), add `execution_json` to the selected columns:

Find:

```typescript
      `SELECT id, step_id, name, goal, status, started_at, completed_at,
              message, awaiting_user_message, state_json, required,
              validation_json, verifier_session_id, verdict_json,
              validation_attempt, rework_count
       FROM recipe_steps
       WHERE recipe_instance_id = ?
       ORDER BY step_index ASC`,
```

Replace with:

```typescript
      `SELECT id, step_id, name, goal, status, started_at, completed_at,
              message, awaiting_user_message, state_json, required,
              validation_json, verifier_session_id, verdict_json,
              validation_attempt, rework_count, execution_json
       FROM recipe_steps
       WHERE recipe_instance_id = ?
       ORDER BY step_index ASC`,
```

- [ ] **Step 8: Populate `lane`/`terminal` in the `readStepsFromDb` `.map`**

In the same function's `.map((r) => { ... })`, right before `const validation = buildStepValidation(db, r, ...)` (~L543), add the resolution and assign the fields:

Find:

```typescript
    const validation = buildStepValidation(db, r, eventsByStep.get(r.id) ?? []);
    if (validation) step.validation = validation;
    return step;
```

Replace with:

```typescript
    const { lane, terminal } = resolveStepTerminal(db, recipe_instance_id, r.execution_json, r.step_id);
    if (lane !== 'main') step.lane = lane;
    if (terminal) step.terminal = terminal;
    const validation = buildStepValidation(db, r, eventsByStep.get(r.id) ?? []);
    if (validation) step.validation = validation;
    return step;
```

- [ ] **Step 9: Add `execution_json` to the list-path SELECT**

In `listAllRecipeInstancesFromDb`, the batch step query (~L928) selects `recipe_instance_id` too. Add `execution_json`:

Find:

```typescript
        `SELECT id, step_id, name, goal, status, started_at, completed_at,
                message, awaiting_user_message, state_json, required,
                validation_json, verifier_session_id, verdict_json,
                validation_attempt, rework_count, recipe_instance_id
         FROM recipe_steps
         WHERE recipe_instance_id IN (${placeholders})
         ORDER BY recipe_instance_id, step_index ASC`,
```

Replace with:

```typescript
        `SELECT id, step_id, name, goal, status, started_at, completed_at,
                message, awaiting_user_message, state_json, required,
                validation_json, verifier_session_id, verdict_json,
                validation_attempt, rework_count, execution_json, recipe_instance_id
         FROM recipe_steps
         WHERE recipe_instance_id IN (${placeholders})
         ORDER BY recipe_instance_id, step_index ASC`,
```

- [ ] **Step 10: Populate `lane`/`terminal` in the list-path `.map`**

In the list-path step `.map((r): RecipeStep => { ... })` (~L976), right before `const validation = buildStepValidation(conn, r, ...)`, add the resolution. The instance id here is `row.id` and the DB handle is `conn`:

Find:

```typescript
        const validation = buildStepValidation(conn, r, validationEventsByStep.get(r.id) ?? []);
        if (validation) step.validation = validation;
        return step;
```

Replace with:

```typescript
        const { lane, terminal } = resolveStepTerminal(conn, row.id, r.execution_json, r.step_id);
        if (lane !== 'main') step.lane = lane;
        if (terminal) step.terminal = terminal;
        const validation = buildStepValidation(conn, r, validationEventsByStep.get(r.id) ?? []);
        if (validation) step.validation = validation;
        return step;
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-terminal-links.test.mjs`
Expected: PASS (all 6 tests — the 3 from Task 1 plus the 3 step tests).

- [ ] **Step 12: Typecheck**

Run: `cd C:\git\clawdevbox\mcp-server ; npm run typecheck`
Expected: exit 0.

- [ ] **Step 13: Regression — the multi-gate serializer still passes**

Run: `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-multi-gate.test.mjs`
Expected: PASS (the `db`-param change to `buildStepValidation` must not have broken existing rounds).

- [ ] **Step 14: Commit**

```bash
git add mcp-server/src/recipe-instances-store.ts mcp-server/tests/recipe-terminal-links.test.mjs
git commit -m "feat(recipe): resolve per-step lane + terminal in both projections

Every step now carries its execution lane and a resolved terminal
(main lane -> the recipe instance itself; named/fresh-session lanes ->
recipe_lane_sessions -> agent_sessions). Wired into both the detail
(readStepsFromDb) and list projection paths.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 158a5132-efef-48d1-8613-73c75a899d11"
```

---

### Task 3: Web — mirror the new fields in `api.ts` types

**Files:**
- Modify: `mcp-server/web/src/api.ts` (`ValidationRound` ~L354; `RecipeStep` ~L388)

- [ ] **Step 1: Add `terminal?` to the web `ValidationRound` type**

In `mcp-server/web/src/api.ts`, in the `ValidationRound` interface, after the `verifier_session_id?: string;` field (~L354), add:

```typescript
  terminal?: { instance_id: string; cli_session_id?: string };
```

- [ ] **Step 2: Add `lane?` + `terminal?` to the web `RecipeStep` type**

In the `RecipeStep` interface, after the `validation?: StepValidation;` field (~L388, before the closing `}`), add:

```typescript
  lane?: string;
  terminal?: { instance_id: string; cli_session_id?: string };
```

- [ ] **Step 3: Type-check the web app**

Run: `cd C:\git\clawdevbox\mcp-server\web ; npx vue-tsc --noEmit`
Expected: exit 0 (additive optional fields — no breakage).

- [ ] **Step 4: Commit**

```bash
git add mcp-server/web/src/api.ts
git commit -m "feat(recipe-ui): mirror step lane/terminal + round terminal types

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 158a5132-efef-48d1-8613-73c75a899d11"
```

---

### Task 4: Web — swap the top button for terminal icons in `RecipeDetailPanel.vue`

**Files:**
- Modify: `mcp-server/web/src/components/RecipeDetailPanel.vue`
  - Remove: `openTerminal()` fn (~L253-297), `terminalLabel` computed (~L300-~315), the top terminal `<Button>` (~L349-359), orphaned refs `isReattaching`/`reattachError` (~L232-233)
  - Add: `openTerminalInSidebar()` helper, compact header icon, per-step icon (step-actions block ~L622), per-round icons (both `sv-round-head` sites ~L592 and ~L608)

**Design recap:** clicking any icon calls `store.selectTerminal(id)` + `store.setActiveTab('agent')` — this selects the existing terminal in the sidebar and reveals the Terminals tab. It never spawns/reattaches. The glyph is `pi pi-microchip-ai` (the app's terminal glyph — `pi pi-terminal`/`pi pi-desktop` do **not** exist in this PrimeVue build). `Button` is auto-imported via `PrimeVueResolver`.

- [ ] **Step 1: Add the `openTerminalInSidebar` helper and remove the reattach machinery**

Replace the entire `openTerminal` function (from `async function openTerminal(): Promise<void> {` ~L253 through its closing `}` just before `const terminalLabel = computed(...)`) with the small helper. Find:

```typescript
async function openTerminal(): Promise<void> {
  if (!recipe.value) return;
  reattachError.value = null;
  const r = recipe.value;
```

…through the function's end:

```typescript
  store.openRecipeTerminalInline(
    props.recipeId,
    termInstanceId,
    `Terminal · ${r.agent_cli || 'agent'}`,
  );
}
```

Replace that whole block with:

```typescript
/**
 * Reveal an EXISTING terminal in the Terminals sidebar (select — never spawn).
 * `instanceId` is a recipe_instance_id (the terminal sidebar's key): the main
 * session for the header icon, or a resolved step/round terminal.
 */
function openTerminalInSidebar(instanceId: string): void {
  store.selectTerminal(instanceId);
  store.setActiveTab('agent');
}
```

- [ ] **Step 2: Remove the now-orphaned `terminalLabel` computed**

Delete the entire `const terminalLabel = computed(() => { ... });` block (starts ~L300). Find its start:

```typescript
const terminalLabel = computed(() => {
  const r = recipe.value;
  if (!r) return 'Terminal';
  if (isReattaching.value) return 'Reattaching…';
```

Delete from that line through the block's closing `});`. (If `computed` becomes unused elsewhere in the file, the build in Step 6 will surface it — leave the `import { computed }` alone unless the build flags it; other computeds in this file still use it.)

- [ ] **Step 3: Remove the orphaned reattach refs**

`isReattaching` and `reattachError` are now referenced only by the removed code. Delete both declarations (~L232-233):

```typescript
const isReattaching = ref(false);
const reattachError = ref<string | null>(null);
```

- [ ] **Step 4: Replace the top terminal button with a compact header icon**

In the template's `.head-actions` block, replace the terminal `<Button>` (~L349-359) — the one with `:label="terminalLabel"` — with a compact icon-only button that opens the recipe's **main** terminal (`recipe.id`). Find:

```html
        <Button
          icon="pi pi-microchip-ai"
          :label="terminalLabel"
          size="small"
          severity="secondary"
          outlined
          :loading="isReattaching"
          aria-label="Open terminal (reattaches the agent session if it has exited)"
          :title="isReattaching ? 'Spawning a fresh agent process bound to this session_id…' : 'Open the live xterm viewer. For exited recipes this reattaches the session — no new recipe row is created.'"
          class="action-btn"
          @click="openTerminal"
        />
```

Replace with:

```html
        <Button
          v-if="recipe"
          icon="pi pi-microchip-ai"
          text rounded size="small"
          aria-label="Open the main recipe terminal in the sidebar"
          title="Open the orchestrator (main) session terminal in the sidebar"
          class="action-btn"
          @click="openTerminalInSidebar(recipe.id)"
        />
```

- [ ] **Step 5: Add a per-step terminal icon in the `step-actions` block**

The `step-actions` block (~L622) is currently gated on `v-if="s.child_recipe_instance_id || s.artifact_id"`. Widen the condition to include `s.terminal`, and add the icon button. Find:

```html
              <div v-if="s.child_recipe_instance_id || s.artifact_id" class="step-actions">
                <Button
                  v-if="s.child_recipe_instance_id"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  class="step-btn"
                  @click="openChildRecipe(s.child_recipe_instance_id!)"
                >
                  <i class="pi pi-sitemap" /> Open child run
                </Button>
```

Replace with:

```html
              <div v-if="s.child_recipe_instance_id || s.artifact_id || s.terminal" class="step-actions">
                <Button
                  v-if="s.terminal"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  class="step-btn"
                  :title="s.lane ? `Open the '${s.lane}' session terminal in the sidebar` : 'Open this step\'s terminal in the sidebar'"
                  @click="openTerminalInSidebar(s.terminal.instance_id)"
                >
                  <i class="pi pi-microchip-ai" /> Open terminal<span v-if="s.lane" class="step-lane-chip">{{ s.lane }}</span>
                </Button>
                <Button
                  v-if="s.child_recipe_instance_id"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  class="step-btn"
                  @click="openChildRecipe(s.child_recipe_instance_id!)"
                >
                  <i class="pi pi-sitemap" /> Open child run
                </Button>
```

- [ ] **Step 6: Add a per-round terminal icon in the multi-gate `sv-round-head`**

In the multi-gate rounds template (~L592), add a terminal button at the end of the `sv-round-head` row. Find:

```html
                          <div class="sv-round-head">
                            <span v-if="r.gate" class="sv-gate-chip">{{ r.gate }}</span>
                            <span v-if="r.mode" class="sv-mode" :title="`Gate mode: ${r.mode}`">{{ r.mode }}</span>
                            <span class="sv-verdict"><i :class="verdictIcon(r)" /> {{ roundLabel(r) }}</span>
                            <span v-if="r.decided_at" class="sv-time">{{ relativeTime(r.decided_at) }}</span>
                            <span v-else-if="r.started_at" class="sv-time">{{ relativeTime(r.started_at) }}</span>
                          </div>
```

Replace with:

```html
                          <div class="sv-round-head">
                            <span v-if="r.gate" class="sv-gate-chip">{{ r.gate }}</span>
                            <span v-if="r.mode" class="sv-mode" :title="`Gate mode: ${r.mode}`">{{ r.mode }}</span>
                            <span class="sv-verdict"><i :class="verdictIcon(r)" /> {{ roundLabel(r) }}</span>
                            <span v-if="r.decided_at" class="sv-time">{{ relativeTime(r.decided_at) }}</span>
                            <span v-else-if="r.started_at" class="sv-time">{{ relativeTime(r.started_at) }}</span>
                            <button
                              v-if="r.terminal"
                              type="button"
                              class="sv-term-btn"
                              title="Open this validator's terminal in the sidebar"
                              aria-label="Open validator terminal"
                              @click="openTerminalInSidebar(r.terminal.instance_id)"
                            ><i class="pi pi-microchip-ai" /></button>
                          </div>
```

- [ ] **Step 7: Add a per-round terminal icon in the single-gate `sv-round-head`**

In the single-gate flat list (~L608), do the same. Find:

```html
                        <div class="sv-round-head">
                          <span class="sv-round-n">Round {{ r.attempt + 1 }}</span>
                          <span class="sv-verdict"><i :class="verdictIcon(r)" /> {{ roundLabel(r) }}</span>
                          <span v-if="r.decided_at" class="sv-time">{{ relativeTime(r.decided_at) }}</span>
                          <span v-else-if="r.started_at" class="sv-time">{{ relativeTime(r.started_at) }}</span>
                        </div>
```

Replace with:

```html
                        <div class="sv-round-head">
                          <span class="sv-round-n">Round {{ r.attempt + 1 }}</span>
                          <span class="sv-verdict"><i :class="verdictIcon(r)" /> {{ roundLabel(r) }}</span>
                          <span v-if="r.decided_at" class="sv-time">{{ relativeTime(r.decided_at) }}</span>
                          <span v-else-if="r.started_at" class="sv-time">{{ relativeTime(r.started_at) }}</span>
                          <button
                            v-if="r.terminal"
                            type="button"
                            class="sv-term-btn"
                            title="Open this validator's terminal in the sidebar"
                            aria-label="Open validator terminal"
                            @click="openTerminalInSidebar(r.terminal.instance_id)"
                          ><i class="pi pi-microchip-ai" /></button>
                        </div>
```

- [ ] **Step 8: Add minimal styles for the new chips/buttons**

In the component's `<style scoped>` block (append near the other `.sv-*` / `.step-*` rules), add:

```css
.sv-term-btn {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--p-text-muted-color, #94a3b8);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}
.sv-term-btn:hover { color: var(--p-primary-color, #6366f1); background: rgba(99, 102, 241, 0.12); }
.step-lane-chip {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 0.72em;
  background: rgba(99, 102, 241, 0.15);
  color: var(--p-primary-color, #818cf8);
}
```

> If any of these CSS variables/classes clash with existing rules, prefer the file's existing conventions (reuse an existing muted-icon-button class if one is already defined for `.sv-*`). The goal is a subtle, right-aligned icon button — exact styling is not load-bearing.

- [ ] **Step 9: Build the web app (the web gate)**

Run: `cd C:\git\clawdevbox\mcp-server\web ; npm run build`
Expected: `vue-tsc --noEmit` passes (no reference to removed `openTerminal`/`terminalLabel`/`isReattaching`/`reattachError` remains) **and** `vite build` completes. Exit 0.

If the build fails on a leftover reference (e.g. a template still binding `terminalLabel` or `isReattaching`), grep the file for that identifier and remove the last usage, then rebuild.

- [ ] **Step 10: Commit**

```bash
git add mcp-server/web/src/components/RecipeDetailPanel.vue
git commit -m "feat(recipe-ui): terminal icons per step + per validation round

Replace the top reattach button with select-existing-terminal icons: a
compact header icon (main session), a per-step icon (resolved via the
step's lane) and a per-round icon (validator session). Clicking selects
the terminal in the sidebar; it never spawns/reattaches.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 158a5132-efef-48d1-8613-73c75a899d11"
```

---

## Final verification (after all tasks)

- [ ] Backend suite (targeted): `cd C:\git\clawdevbox\mcp-server ; node --import tsx --test tests/recipe-terminal-links.test.mjs tests/recipe-multi-gate.test.mjs` → all PASS
- [ ] Backend typecheck: `cd C:\git\clawdevbox\mcp-server ; npm run typecheck` → exit 0
- [ ] Web build: `cd C:\git\clawdevbox\mcp-server\web ; npm run build` → exit 0
- [ ] Live smoke (optional): restart the dev server (tsx does not hot-reload), open a spawned recipe with a fresh-session step + a gated step, confirm: header icon opens the main terminal in the sidebar; a fresh-session step's icon opens that lane's terminal; a validation round's icon opens the verifier's terminal; the old top "Terminal" button is gone.

---

## Self-Review (completed by plan author)

**1. Spec coverage** (`docs/superpowers/specs/2026-07-15-recipe-terminal-icons-design.md`):
- §4 backend `resolveTerminal` + projections → Tasks 1 & 2. ✅ (round terminal via `verifier_session_id`; step terminal via lane → `getLaneSession` → `resolveTerminal`; both detail + list paths covered.)
- §5 UI icons (remove top button; header + per-step + per-round icons; select-not-spawn) → Task 4. ✅
- §8 testing (backend unit tests; web gate = `npm run build`, no component tests) → Tasks 1-2 tests + Task 4 build. ✅
- Per-step + per-validation-round granularity (Q1) and compact header icon replacing the top button (Q2) → Task 4 Steps 4-7. ✅

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows full code. The two implementer notes (recordStepEvent signature; execution_json persistence) are *verification prompts with concrete fallbacks*, not placeholders. ✅

**3. Type consistency:** `TerminalRef { instance_id: string; cli_session_id?: string }` defined once (Task 1 Step 4), used identically on `ValidationRound.terminal`, `RecipeStep.terminal`, `resolveTerminal` return, and mirrored structurally in `api.ts` (Task 3). Helper names stable: `resolveTerminal` (exported), `resolveStepTerminal` (private), `openTerminalInSidebar` (Vue). `buildStepValidation` signature change (`db` first) applied to definition + both call sites (readStepsFromDb uses `db`, list path uses `conn`). ✅

**4. Backward-compat:** main-lane steps (incl. pre-lanes recipes with no `recipe_lane_sessions` row) always resolve to `{ instance_id: recipeInstanceId }`, so existing recipes keep a working per-step icon; fresh-session lanes without a session yet render no icon (correct). ✅
