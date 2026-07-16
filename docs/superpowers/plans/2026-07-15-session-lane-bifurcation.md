# Session-Lane Bifurcation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let recipe steps run on named parallel interactive sessions ("lanes"), bifurcating a workflow across separate consoles and rejoining the initial console for finalize/memory, with per-step and per-gate agent/model/provider selection.

**Architecture:** A step declares `execution.session: <lane>` (default `main`). Each lane is one persistent interactive session (the initial `/spawn` session is lane `main`); non-`main` lanes are spawned lazily by a new server-side `lane-dispatch-worker` (mirroring `recipe-validation-worker`). Each session self-drives only its own lane's ready steps; the worker spawns a lane's session on first need and resumes it when a cross-lane dependency unblocks new work (this resume path is exactly how `finalize` returns to the initial console). Agent/model/provider ride in the existing `execution_json` (steps) and `validation_json` gates, threaded into the already-capable `runRecipe`.

**Tech Stack:** TypeScript, better-sqlite3, `node:test` via `node --import tsx --test`, `tsc --noEmit` typecheck.

**Spec:** `docs/superpowers/specs/2026-07-15-session-lane-bifurcation-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/db/recipe-steps-store.ts` | `ExecutionDecl`/gate types, `normalizeExecution`, `resolveLane`, `computeReadySteps` | Modify |
| `src/validators.ts` | Author-input validation for `execution.session/provider/agent` + gate `verifier_provider/agent` | Modify |
| `src/tools/recipe.ts` | `buildStepDecls` carry execution; `recipe.instance.begin` record `main` lane + lane-scoped first/next steps | Modify |
| `src/db/migrations.ts` | Migration v17: `recipe_lane_sessions` table | Modify |
| `src/db/lane-sessions-store.ts` | CRUD for `recipe_lane_sessions` (upsert, get, list, resolve-by-session, set-status) | Create |
| `src/recipe-validation-worker.ts` | Thread gate `verifier_provider/agent/model` into `spawnVerifier`; lane-aware `nextStepPrompt` | Modify |
| `src/lane-dispatch-worker.ts` | The lane-dispatch worker loop + default deps | Create |
| `src/cli/start.ts` | Start/stop the lane-dispatch worker | Modify |
| `tests/recipe-lane-execution.test.mjs` | Unit tests for normalize/resolve/ready-steps/store/worker | Create |

---

## Task 1: Execution + gate selector types and normalization

**Files:**
- Modify: `src/db/recipe-steps-store.ts` (`ExecutionDecl` ~L68, `ValidationGate` ~L45, `ValidationConfig` ~L57, `normalizeValidation` ~L234-266)
- Test: `tests/recipe-lane-execution.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// tests/recipe-lane-execution.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecution, resolveLane, normalizeValidation } from '../src/db/recipe-steps-store.ts';

test('normalizeExecution carries session/provider/agent/model + mode/isolation, drops junk', () => {
  assert.deepEqual(
    normalizeExecution({ session: 'deploy', provider: 'copilot', agent: 'dev-buddy:dev-buddy', model: 'claude-opus-4.8', junk: 1 }),
    { session: 'deploy', provider: 'copilot', agent: 'dev-buddy:dev-buddy', model: 'claude-opus-4.8' },
  );
  assert.deepEqual(normalizeExecution({ mode: 'fresh-session', isolation: 'required' }), { mode: 'fresh-session', isolation: 'required' });
  assert.equal(normalizeExecution(null), null);
  assert.equal(normalizeExecution('nonsense'), null);
});

test('resolveLane: explicit session > fresh-session __step lane > main default', () => {
  assert.equal(resolveLane({ session: 'reviews' }, 's1'), 'reviews');
  assert.equal(resolveLane({ mode: 'fresh-session' }, 's1'), '__step:s1');
  assert.equal(resolveLane({ mode: 'inline' }, 's1'), 'main');
  assert.equal(resolveLane(null, 's1'), 'main');
});

test('normalizeValidation carries verifier_provider + verifier_agent + verifier_model', () => {
  const cfg = normalizeValidation([{ name: 'g', mode: 'judge', verifier_provider: 'copilot', verifier_agent: 'dev-buddy:dev-buddy', verifier_model: 'claude-opus-4.8' }]);
  assert.deepEqual(cfg.gates[0], { name: 'g', mode: 'judge', verifier_provider: 'copilot', verifier_agent: 'dev-buddy:dev-buddy', verifier_model: 'claude-opus-4.8' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\git\clawdevbox\mcp-server; node --import tsx --test tests/recipe-lane-execution.test.mjs`
Expected: FAIL — `normalizeExecution`/`resolveLane` not exported; `verifier_provider`/`verifier_agent` missing from gate.

- [ ] **Step 3: Extend the types**

In `src/db/recipe-steps-store.ts`, replace the `ExecutionDecl` interface (make `mode` optional, add fields):
```ts
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
```
Add `verifier_provider?` + `verifier_agent?` to BOTH `ValidationGate` (~L45) and the inline gate type in `ValidationConfig.gates` (~L57), next to the existing `verifier_model?: string`.

- [ ] **Step 4: Add `normalizeExecution` + `resolveLane`**

In `src/db/recipe-steps-store.ts` (near `normalizeValidation`), add:
```ts
/** Canonicalize a raw `execution` block; NEVER throws (also the back-compat
 *  reader for execution_json). Returns null when empty/not-an-object. */
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
```
In `normalizeValidation`, after the `verifier_model` line (~L264) add:
```ts
      if (typeof g.verifier_provider === 'string' && g.verifier_provider.trim()) out.verifier_provider = g.verifier_provider.trim();
      if (typeof g.verifier_agent === 'string' && g.verifier_agent.trim()) out.verifier_agent = g.verifier_agent.trim();
```

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/recipe-steps-store.ts tests/recipe-lane-execution.test.mjs
git commit -m "feat(recipe): execution lane/selector types + normalizeExecution/resolveLane + gate verifier_provider/agent"
```

---

## Task 2: Materialize execution + validate author input

**Files:**
- Modify: `src/tools/recipe.ts` (`buildStepDecls` ~L153-186, esp. the `execution:` map line ~L181)
- Modify: `src/validators.ts` (execution block ~L316-322; gate validation ~L294)
- Test: `tests/recipe-lane-execution.test.mjs`, `tests/recipe-build-step-decls.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `tests/recipe-lane-execution.test.mjs`)

```js
import { buildStepDecls } from '../src/tools/recipe.ts';
import { validateRecipeParsed } from '../src/validators.ts';

test('buildStepDecls canonicalizes execution via normalizeExecution', () => {
  const [s] = buildStepDecls([{ id: 's', goal: 'g', execution: { session: 'deploy', model: 'gpt-5.6-sol', junk: 9 } }]);
  assert.deepEqual(s.execution, { session: 'deploy', model: 'gpt-5.6-sol' });
});

test('validateRecipeParsed rejects a non-string execution.session', () => {
  const res = validateRecipeParsed({ id: 'r', name: 'R', steps: [{ id: 's', goal: 'g', execution: { session: 5 } }] });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.path.endsWith('.execution.session')));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs`
Expected: FAIL — `s.execution` still contains `junk`; no `execution.session` validation error.

- [ ] **Step 3: Wire `normalizeExecution` into `buildStepDecls`**

In `src/tools/recipe.ts`, add to the imports from `../db/recipe-steps-store.ts`: `normalizeExecution`. Replace the `execution:` line (~L181):
```ts
      execution: normalizeExecution(coerceStepBlock(s.execution, 'execution', String(s.id ?? ''))) ?? undefined,
```
(`coerceStepBlock` still fail-closes on a non-object; `normalizeExecution` then canonicalizes.)

- [ ] **Step 4: Add author-input validation**

In `src/validators.ts`, inside the `if (step.execution !== undefined)` block (~L316), after the `execution.mode` enum check, add:
```ts
            if (step.execution.session !== undefined && (typeof step.execution.session !== 'string' || !/^(main|[a-z][a-z0-9-]*)$/.test(step.execution.session))) {
              errors.push({ path: `${pathPrefix}.execution.session`, code: 'PATTERN', message: 'execution.session must be "main" or match ^[a-z][a-z0-9-]*$.' });
            }
            for (const k of ['provider', 'agent', 'model']) {
              if (step.execution[k] !== undefined && typeof step.execution[k] !== 'string') {
                errors.push({ path: `${pathPrefix}.execution.${k}`, code: 'TYPE', message: `execution.${k} must be a string.` });
              }
            }
```
In the gate-validation loop (~L294, where `gate.mode` is checked), add string checks for `gate.verifier_provider`, `gate.verifier_agent`, `gate.verifier_model` (each: if defined and not a string → push a `TYPE` error at `${gatePath}.verifier_<k>`).

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs tests/recipe-build-step-decls.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools/recipe.ts src/validators.ts tests/recipe-lane-execution.test.mjs
git commit -m "feat(recipe): materialize canonical execution + validate execution.session/selectors and gate verifier selectors"
```

---

## Task 3: `recipe_lane_sessions` table (migration v17) + store

**Files:**
- Modify: `src/db/migrations.ts` (append after the `version: 16` entry ~L544)
- Create: `src/db/lane-sessions-store.ts`
- Test: `tests/recipe-lane-execution.test.mjs`

- [ ] **Step 1: Write the failing test** (append)

```js
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { upsertLaneSession, getLaneSession, listLaneSessions, resolveLaneBySession } from '../src/db/lane-sessions-store.ts';

function db0() { const d = new BetterSqlite3(':memory:'); d.pragma('foreign_keys = ON'); runMigrations(d); return d; }
function seedInstance(db) {
  const ws = ensureWorkspace(db, { path: `C:/fake-${Math.random().toString(36).slice(2)}` });
  const id = `ri_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO recipe_instances (id, recipe_id, workspace_id, workspace_path, prompt, params_json, started_at, status) VALUES (?,?,?,?,?, '{}', ?, 'running')`)
    .run(id, 'r1', ws.id, ws.path, 'p', Date.now());
  return id;
}

test('migration v17 creates recipe_lane_sessions', () => {
  const db = db0();
  const cols = db.prepare(`PRAGMA table_info(recipe_lane_sessions)`).all().map((c) => c.name);
  for (const c of ['recipe_instance_id', 'lane', 'cli_session_id', 'status', 'spawned_at']) assert.ok(cols.includes(c), `missing ${c}`);
});

test('lane-sessions-store: upsert/get/list/resolve', () => {
  const db = db0();
  const ri = seedInstance(db);
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'main', cli_session_id: 'sess-A', status: 'live' });
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-B', status: 'live' });
  assert.equal(getLaneSession(db, ri, 'deploy').cli_session_id, 'sess-B');
  assert.equal(listLaneSessions(db, ri).length, 2);
  assert.deepEqual(resolveLaneBySession(db, 'sess-B'), { recipe_instance_id: ri, lane: 'deploy' });
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-B', status: 'idle' });
  assert.equal(getLaneSession(db, ri, 'deploy').status, 'idle'); // upsert updates in place
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs`
Expected: FAIL — no `recipe_lane_sessions` table / store module.

- [ ] **Step 3: Add migration v17**

In `src/db/migrations.ts`, append to the migrations array (after `version: 16`):
```ts
  {
    version: 17,
    up: (db) => {
      // Session lanes: N interactive sessions per recipe instance (design
      // 2026-07-15). Maps (instance, lane) -> the live cli_session_id driving it.
      db.exec(`
        CREATE TABLE recipe_lane_sessions (
          recipe_instance_id TEXT NOT NULL REFERENCES recipe_instances(id) ON DELETE CASCADE,
          lane               TEXT NOT NULL,
          cli_session_id     TEXT,
          status             TEXT NOT NULL DEFAULT 'live',
          spawned_at         INTEGER NOT NULL,
          PRIMARY KEY (recipe_instance_id, lane)
        );
        CREATE INDEX idx_lane_sessions_cli ON recipe_lane_sessions(cli_session_id);
      `);
    },
  },
```

- [ ] **Step 4: Create the store**

```ts
// src/db/lane-sessions-store.ts
import type { Database } from 'better-sqlite3';

export interface LaneSessionRow {
  recipe_instance_id: string;
  lane: string;
  cli_session_id: string | null;
  status: string;      // 'live' | 'idle' | 'done'
  spawned_at: number;
}

export function upsertLaneSession(
  db: Database,
  row: { recipe_instance_id: string; lane: string; cli_session_id: string | null; status?: string },
): void {
  db.prepare(
    `INSERT INTO recipe_lane_sessions (recipe_instance_id, lane, cli_session_id, status, spawned_at)
       VALUES (@recipe_instance_id, @lane, @cli_session_id, @status, @spawned_at)
     ON CONFLICT(recipe_instance_id, lane) DO UPDATE SET
       cli_session_id = COALESCE(excluded.cli_session_id, recipe_lane_sessions.cli_session_id),
       status = excluded.status`,
  ).run({
    recipe_instance_id: row.recipe_instance_id,
    lane: row.lane,
    cli_session_id: row.cli_session_id,
    status: row.status ?? 'live',
    spawned_at: Date.now(),
  });
}

export function getLaneSession(db: Database, recipe_instance_id: string, lane: string): LaneSessionRow | undefined {
  return db.prepare(`SELECT * FROM recipe_lane_sessions WHERE recipe_instance_id = ? AND lane = ?`)
    .get(recipe_instance_id, lane) as LaneSessionRow | undefined;
}

export function listLaneSessions(db: Database, recipe_instance_id: string): LaneSessionRow[] {
  return db.prepare(`SELECT * FROM recipe_lane_sessions WHERE recipe_instance_id = ?`)
    .all(recipe_instance_id) as LaneSessionRow[];
}

export function resolveLaneBySession(db: Database, cli_session_id: string): { recipe_instance_id: string; lane: string } | null {
  const r = db.prepare(
    `SELECT recipe_instance_id, lane FROM recipe_lane_sessions WHERE cli_session_id = ? ORDER BY spawned_at DESC LIMIT 1`,
  ).get(cli_session_id) as { recipe_instance_id: string; lane: string } | undefined;
  return r ?? null;
}

export function setLaneStatus(db: Database, recipe_instance_id: string, lane: string, status: string): void {
  db.prepare(`UPDATE recipe_lane_sessions SET status = ? WHERE recipe_instance_id = ? AND lane = ?`)
    .run(status, recipe_instance_id, lane);
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs tests/db-migrations.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations.ts src/db/lane-sessions-store.ts tests/recipe-lane-execution.test.mjs
git commit -m "feat(db): migration v17 recipe_lane_sessions + lane-sessions store"
```

---

## Task 4: Shared lane-aware `computeReadySteps` + de-duplicate the 3 call sites

**Files:**
- Modify: `src/db/recipe-steps-store.ts` (add `computeReadySteps`)
- Modify: `src/tools/recipe.ts` (begin first_steps ~L825-833; update_status next_steps ~L1240-1253)
- Modify: `src/recipe-validation-worker.ts` (`nextStepPrompt` ~L516-531)
- Test: `tests/recipe-lane-execution.test.mjs`

- [ ] **Step 1: Write the failing test** (append)

```js
import { materializeSteps, computeReadySteps } from '../src/db/recipe-steps-store.ts';

test('computeReadySteps filters by lane and honors depends', () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [
    { id: 'a', goal: 'A', execution: { session: 'main' } },
    { id: 'b', goal: 'B', depends: ['a'], execution: { session: 'deploy' } },
    { id: 'c', goal: 'C', execution: { session: 'reviews' } },
  ]);
  // nothing done yet: a (main) and c (reviews) are ready; b waits on a.
  assert.deepEqual(computeReadySteps(db, ri).map((s) => s.step_id).sort(), ['a', 'c']);
  assert.deepEqual(computeReadySteps(db, ri, 'main').map((s) => s.step_id), ['a']);
  assert.deepEqual(computeReadySteps(db, ri, 'reviews').map((s) => s.step_id), ['c']);
  assert.equal(computeReadySteps(db, ri, 'deploy').length, 0);
  assert.equal(computeReadySteps(db, ri, 'main')[0].lane, 'main');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs`
Expected: FAIL — `computeReadySteps` not exported.

- [ ] **Step 3: Add `computeReadySteps` to `recipe-steps-store.ts`**

```ts
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
```

- [ ] **Step 4: Replace the worker's `nextStepPrompt` body** (`src/recipe-validation-worker.ts` ~L516-531)

Add `computeReadySteps` to the import from `./db/recipe-steps-store.ts`, then:
```ts
  const nextStepPrompt = async (args: { recipeInstanceId: string; doneStepId: string; lane?: string }): Promise<string | null> => {
    const ready = computeReadySteps(db, args.recipeInstanceId, args.lane);
    const blocks = ready.map((s) => {
      const lines = [`▶ NEXT STEP: ${s.step_id}`, `  Goal: ${s.goal}`];
      if (s.ai_instructions) lines.push(`  Instructions: ${s.ai_instructions}`);
      return lines.join('\n');
    });
    return blocks.length > 0 ? blocks.join('\n\n') : null;
  };
```

- [ ] **Step 5: Replace the `update_status` next_steps loop** (`src/tools/recipe.ts` ~L1240-1253)

Add `computeReadySteps` + `resolveLaneBySession` imports. Replace the manual loop that builds `next_steps` with (resolve the caller's lane so a lane session only sees its own next steps):
```ts
      const callerSess = resolveAgentSessionId(extra);
      const callerLane = callerSess ? (resolveLaneBySession(db, callerSess)?.lane ?? 'main') : undefined;
      const next_steps = computeReadySteps(db, opts.recipe_instance_id, callerLane).map((s) => ({
        step_id: s.step_id, goal: s.goal, ai_instructions: s.ai_instructions, ai_prompt: s.ai_prompt, depends: s.depends,
      }));
```
(`db` is the workspace DB already in scope in this handler; if the local variable name differs, use it.)

- [ ] **Step 6: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs tests/recipe-step-validation.test.mjs tests/recipe-step-tools.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/db/recipe-steps-store.ts src/recipe-validation-worker.ts src/tools/recipe.ts tests/recipe-lane-execution.test.mjs
git commit -m "refactor(recipe): shared lane-aware computeReadySteps; lane-scope next_steps + nextStepPrompt"
```

---

## Task 5: `recipe.instance.begin` records the `main` lane + lane-scopes first steps

**Files:**
- Modify: `src/tools/recipe.ts` (`recipe.instance.begin` handler: after `writeRecipeInstance` ~L794; first_steps ~L825-833)
- Test: `tests/recipe-lane-execution.test.mjs`

- [ ] **Step 1: Write the failing test** (append — drive the handler through its exported impl if available, else assert via the store after a begin)

```js
// If recipe.instance.begin's impl is not directly importable, this asserts the
// invariant the handler must satisfy: after begin, a 'main' lane row exists
// bound to the caller's session id. Use the handler's exported helper if present;
// otherwise this test is realized by the integration begin path. Prefer a direct
// unit on a small helper `recordMainLane(db, instanceId, cliSessionId)`.
import { recordMainLane } from '../src/tools/recipe.ts';
test('recordMainLane binds the initial session to lane main', () => {
  const db = db0();
  const ri = seedInstance(db);
  recordMainLane(db, ri, 'sess-INIT');
  assert.deepEqual(resolveLaneBySession(db, 'sess-INIT'), { recipe_instance_id: ri, lane: 'main' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs`
Expected: FAIL — `recordMainLane` not exported.

- [ ] **Step 3: Add + call `recordMainLane`**

In `src/tools/recipe.ts`, add (near `buildStepDecls`), importing `upsertLaneSession` from `../db/lane-sessions-store.ts`:
```ts
/** Bind the initial (begin-calling) session to the 'main' lane of an instance. */
export function recordMainLane(db: Database, recipeInstanceId: string, cliSessionId: string): void {
  if (!cliSessionId) return;
  upsertLaneSession(db, { recipe_instance_id: recipeInstanceId, lane: 'main', cli_session_id: cliSessionId, status: 'live' });
}
```
In the `recipe.instance.begin` handler, right after `writeRecipeInstance(...)` (~L794):
```ts
      recordMainLane(db, instanceId, resolveAgentSessionId(extra as ResolveExtra | undefined) ?? '');
```
Change the begin `first_steps` computation (~L825-833) to lane-scope to `main`:
```ts
      const firstSteps = computeReadySteps(db, instanceId, 'main').map((s) => ({
        step_id: s.step_id, goal: s.goal, ai_instructions: s.ai_instructions, ai_prompt: s.ai_prompt, depends: s.depends,
      }));
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs tests/workspace.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/tools/recipe.ts tests/recipe-lane-execution.test.mjs
git commit -m "feat(recipe): begin records the main lane + lane-scopes first_steps to main"
```

---

## Task 6: Thread gate selectors (provider/agent/model) into the verifier spawn

**Files:**
- Modify: `src/recipe-validation-worker.ts` (`ValidationWorkerOpts.spawnVerifier` args ~L183; single-gate call ~L301-307; multi-gate call ~L356-362; `defaultValidationWorkerDeps.spawnVerifier` ~L467-493)
- Test: `tests/recipe-validation-worker.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `tests/recipe-validation-worker.test.mjs`, using its existing harness that drives `startValidationWorker` with a fake `spawnVerifier`)

```js
test('worker passes gate verifier_provider/agent/model to spawnVerifier', async () => {
  const h = makeWorkerHarness(); // existing helper: seeds a validating single-gate step
  h.seedValidatingStep({ gates: [{ name: 'g', mode: 'judge', verifier_provider: 'claude', verifier_agent: 'x:y', verifier_model: 'claude-opus-4.8' }] });
  const seen = [];
  const worker = startValidationWorker({ ...h.opts, spawnVerifier: async (a) => { seen.push(a.verifier); return { sessionId: 'v1' }; } });
  await worker.runOnce();
  worker.stop();
  assert.deepEqual(seen[0], { provider: 'claude', agent: 'x:y', model: 'claude-opus-4.8' });
});
```
(If `makeWorkerHarness`/`seedValidatingStep` don't exist, add minimal equivalents mirroring the existing tests in that file — seed a recipe instance + one `validating` step with `validation_json` = the canonical gates, and build `opts` with fake `deliverToWorker`/`nextStepPrompt`/`workspacePathFor`.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recipe-validation-worker.test.mjs`
Expected: FAIL — `a.verifier` is `undefined` (not passed).

- [ ] **Step 3: Extend `spawnVerifier` contract + pass gate selectors**

In `ValidationWorkerOpts.spawnVerifier` (~L183), add `verifier?: { provider?: string; agent?: string; model?: string }` to the args object type. In the single-gate call (~L307) pass it from `gate`:
```ts
          ({ sessionId } = await opts.spawnVerifier({ step, verdictFile, prompt, workspacePath: wsPath,
            verifier: { provider: gate?.verifier_provider, agent: gate?.verifier_agent, model: gate?.verifier_model } }));
```
In the multi-gate call (~L362) pass from `g`:
```ts
          const { sessionId } = await opts.spawnVerifier({ step, verdictFile: vpath, prompt, workspacePath: wsPath,
            verifier: { provider: g.verifier_provider, agent: g.verifier_agent, model: g.verifier_model } });
```

- [ ] **Step 4: Forward selectors to `runRecipe` in the real `spawnVerifier`** (`defaultValidationWorkerDeps` ~L468-490)

Add `verifier` to the `spawnVerifier` args destructure, and change the `runRecipe` call:
```ts
      agentCli: args.verifier?.provider ?? ctx.cfg.defaultAgentCli ?? 'copilot',
      agent: args.verifier?.agent,
      model: args.verifier?.model,
```
(Replacing the current hardcoded `agentCli: ctx.cfg.defaultAgentCli ?? 'copilot'` line; add the two new keys.)

- [ ] **Step 5: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-validation-worker.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/recipe-validation-worker.ts tests/recipe-validation-worker.test.mjs
git commit -m "feat(recipe): honor gate verifier_provider/agent/model when spawning verifiers"
```

---

## Task 7: The lane-dispatch worker

**Files:**
- Create: `src/lane-dispatch-worker.ts`
- Test: `tests/recipe-lane-execution.test.mjs`

**Routing rule per lane (each tick, per running instance):** a lane is *actionable* only when it has ≥1 ready step AND no in-flight step (`running`/`validating`/`awaiting_user`) in that lane (a busy lane advances itself via `update_status.next_steps`). For an actionable lane: if `getLaneSession` exists → `wakeLaneSession` (resume/dispatch the ready-step prompt); else spawn — `main` uses the recorded initial session (wake it), any other lane calls `spawnLaneSession` and records the row.

- [ ] **Step 1: Write the failing test** (append)

```js
import { startLaneDispatchWorker } from '../src/lane-dispatch-worker.ts';

function makeLaneOpts(db, calls) {
  return {
    db,
    spawnLaneSession: async (a) => { calls.push(['spawn', a.lane]); return { cliSessionId: `sess-${a.lane}` }; },
    wakeLaneSession: async (a) => { calls.push(['wake', a.lane, a.cliSessionId]); },
  };
}

test('lane worker: spawns a non-main lane once, wakes main when idle+ready', async () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [
    { id: 'a', goal: 'A', execution: { session: 'main' } },
    { id: 'b', goal: 'B', execution: { session: 'deploy' } },
    { id: 'c', goal: 'C', depends: ['a', 'b'], execution: { session: 'main' } },
  ]);
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'main', cli_session_id: 'sess-INIT', status: 'idle' });
  const calls = [];
  const w = startLaneDispatchWorker(makeLaneOpts(db, calls));
  await w.runOnce();
  w.stop();
  // 'deploy' has no session -> spawn; 'main' has an idle session + ready 'a' -> wake.
  assert.ok(calls.some((c) => c[0] === 'spawn' && c[1] === 'deploy'));
  assert.ok(calls.some((c) => c[0] === 'wake' && c[1] === 'main' && c[2] === 'sess-INIT'));
  // spawn recorded the deploy lane row:
  assert.equal(getLaneSession(db, ri, 'deploy').cli_session_id, 'sess-deploy');
});

test('lane worker: skips a lane with an in-flight step', async () => {
  const db = db0();
  const ri = seedInstance(db);
  materializeSteps(db, ri, [{ id: 'a', goal: 'A', execution: { session: 'deploy' } }, { id: 'b', goal: 'B', depends: ['a'], execution: { session: 'deploy' } }]);
  db.prepare(`UPDATE recipe_steps SET status='running' WHERE step_id='a'`).run();
  upsertLaneSession(db, { recipe_instance_id: ri, lane: 'deploy', cli_session_id: 'sess-D', status: 'live' });
  const calls = [];
  const w = startLaneDispatchWorker(makeLaneOpts(db, calls));
  await w.runOnce();
  w.stop();
  assert.equal(calls.length, 0); // deploy is busy (a running), b not ready -> no action
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs`
Expected: FAIL — `src/lane-dispatch-worker.ts` does not exist.

- [ ] **Step 3: Implement the worker**

```ts
// src/lane-dispatch-worker.ts
import type { Database } from 'better-sqlite3';
import { listSteps, computeReadySteps } from './db/recipe-steps-store.ts';
import { getLaneSession, upsertLaneSession, listLaneSessions } from './db/lane-sessions-store.ts';
import { logger } from './logger.ts';

export interface LaneDispatchWorkerOpts {
  db: Database;
  /** Spawn a fresh interactive console for a non-main lane. Returns its cli session id. */
  spawnLaneSession: (args: {
    recipeInstanceId: string; lane: string; workspaceId: string; workspacePath: string;
    provider?: string; agent?: string; model?: string; prompt: string;
  }) => Promise<{ cliSessionId: string }>;
  /** Resume/dispatch an existing lane session (incl. the initial 'main' console) with a prompt. */
  wakeLaneSession: (args: { recipeInstanceId: string; lane: string; cliSessionId: string; prompt: string }) => Promise<void>;
  intervalMs?: number;
}

export interface LaneDispatchWorkerHandle { stop(): void; runOnce(): Promise<void>; }

const IN_FLIGHT = new Set(['running', 'validating', 'awaiting_user']);

function laneRolePrompt(lane: string, recipeInstanceId: string, workspacePath: string, ready: { step_id: string; goal: string; ai_instructions?: string }[]): string {
  const head = lane === 'main'
    ? `▶ Lane "main" of recipe ${recipeInstanceId} has newly-ready step(s). Continue driving them with recipe.steps.update_status.`
    : `You own lane "${lane}" of recipe instance ${recipeInstanceId} (workspace ${workspacePath}). Drive ONLY lane "${lane}" steps, in depends order, via recipe.steps.update_status. Steps in other lanes run on other consoles — do not touch them. When your lane has no ready step, stop; you'll be resumed.`;
  const body = ready.map((s) => `▶ NEXT STEP: ${s.step_id}\n  Goal: ${s.goal}${s.ai_instructions ? `\n  Instructions: ${s.ai_instructions}` : ''}`).join('\n\n');
  return `${head}\n\n${body}`;
}

export function startLaneDispatchWorker(opts: LaneDispatchWorkerOpts): LaneDispatchWorkerHandle {
  const intervalMs = opts.intervalMs ?? 15_000;
  let stopped = false, running = false;

  async function handleInstance(inst: { id: string; workspace_id: string; workspace_path: string; session_id: string | null }): Promise<void> {
    const all = listSteps(opts.db, inst.id);
    const ready = computeReadySteps(opts.db, inst.id);
    if (ready.length === 0) return;
    // group ready by lane; determine per-lane in-flight
    const inFlightLanes = new Set<string>();
    for (const s of all) {
      if (!IN_FLIGHT.has(s.status)) continue;
      const exec = s.execution_json ? JSON.parse(s.execution_json) : null;
      inFlightLanes.add(exec?.session ?? (exec?.mode === 'fresh-session' ? `__step:${s.step_id}` : 'main'));
    }
    const byLane = new Map<string, typeof ready>();
    for (const r of ready) { if (!byLane.has(r.lane)) byLane.set(r.lane, []); byLane.get(r.lane)!.push(r); }

    for (const [lane, laneReady] of byLane) {
      if (inFlightLanes.has(lane)) continue; // busy — it advances itself
      const prompt = laneRolePrompt(lane, inst.id, inst.workspace_path, laneReady);
      const existing = getLaneSession(opts.db, inst.id, lane);
      if (existing?.cli_session_id) {
        await opts.wakeLaneSession({ recipeInstanceId: inst.id, lane, cliSessionId: existing.cli_session_id, prompt });
        continue;
      }
      if (lane === 'main') {
        // begin should have recorded main; fall back to the instance's own session_id.
        const sid = existing?.cli_session_id ?? inst.session_id;
        if (sid) { upsertLaneSession(opts.db, { recipe_instance_id: inst.id, lane: 'main', cli_session_id: sid, status: 'live' });
                   await opts.wakeLaneSession({ recipeInstanceId: inst.id, lane, cliSessionId: sid, prompt }); }
        continue;
      }
      // Non-main lane, first materialization: pick selectors from the lane-creating step.
      const firstRow = all.find((s) => s.step_id === laneReady[0].step_id);
      const exec = firstRow?.execution_json ? JSON.parse(firstRow.execution_json) : {};
      const { cliSessionId } = await opts.spawnLaneSession({
        recipeInstanceId: inst.id, lane, workspaceId: inst.workspace_id, workspacePath: inst.workspace_path,
        provider: exec.provider, agent: exec.agent, model: exec.model, prompt,
      });
      upsertLaneSession(opts.db, { recipe_instance_id: inst.id, lane, cli_session_id: cliSessionId, status: 'live' });
    }
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const instances = opts.db.prepare(`SELECT id, workspace_id, workspace_path, session_id FROM recipe_instances WHERE status = 'running'`).all() as
        { id: string; workspace_id: string; workspace_path: string; session_id: string | null }[];
      for (const inst of instances) { if (stopped) break; try { await handleInstance(inst); } catch (err) { logger.warn({ err: String(err), instance: inst.id }, 'lane-dispatch: instance tick failed'); } }
    } finally { running = false; }
  }

  const timer = setInterval(() => { void tick().catch((err) => logger.warn({ err: String(err) }, 'lane-dispatch: tick threw')); }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
  logger.info({ intervalMs }, 'lane-dispatch-worker: started');
  return { stop() { stopped = true; clearInterval(timer); }, async runOnce() { await tick(); } };
}
```
> Note: `recipe_instances` has a `session_id` column (the begin-caller's cli session id) — confirmed in `recipe-instances-store.ts`. If a column is named differently at implementation time, adjust the SELECT.

- [ ] **Step 4: Run tests + typecheck**

Run: `node --import tsx --test tests/recipe-lane-execution.test.mjs; npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lane-dispatch-worker.ts tests/recipe-lane-execution.test.mjs
git commit -m "feat(recipe): lane-dispatch worker (spawn/wake lane sessions from ready steps)"
```

---

## Task 8: Default deps + wire the worker into the server

**Files:**
- Modify: `src/lane-dispatch-worker.ts` (add `defaultLaneDispatchWorkerDeps`)
- Modify: `src/cli/start.ts` (import ~L33; start after validation worker ~L2063; stop ~L2324)
- Test: manual/typecheck (start.ts wiring), plus the real e2e in Task 9

- [ ] **Step 1: Add `defaultLaneDispatchWorkerDeps`**

In `src/lane-dispatch-worker.ts`, mirroring `defaultValidationWorkerDeps` (`recipe-validation-worker.ts:455-533`). `spawnLaneSession` calls `runRecipe({ spawnMode: 'interactive', recipeId: null, recipeSnapshot: '', isAdhoc: true, prompt, agentCli: provider ?? cfg.defaultAgentCli ?? 'copilot', agent, model, workspaceInfo: { id: workspaceId, path: workspacePath }, workspacesRoot, ws, cfg, extraEnv: { CLAWDEVBOX_RECIPE_INSTANCE_ID: recipeInstanceId, CLAWDEVBOX_RECIPE_LANE: lane } })` and returns `{ cliSessionId: result.session_id }`. `wakeLaneSession` builds `SessionHelperCtx { db, dispatcher, ws, cfg }` and calls `dispatchOnly({ session_id: cliSessionId, prompt })`; if `!d.ok` fall back to `spawnDispatchOrResume` (same pattern as `deliverToWorker` in `recipe-validation-worker.ts:495-511`). Accept a ctx `{ db, dispatcher, ws, cfg, workspacesRoot }` (same `LaneDispatchWorkerDepsCtx` shape as `ValidationWorkerDepsCtx`).

```ts
export interface LaneDispatchWorkerDepsCtx { db: Database; dispatcher: Dispatcher; ws: Workspace; cfg: ResolvedConfig; workspacesRoot: string; }

export function defaultLaneDispatchWorkerDeps(ctx: LaneDispatchWorkerDepsCtx): LaneDispatchWorkerOpts {
  const { db } = ctx;
  const spawnLaneSession: LaneDispatchWorkerOpts['spawnLaneSession'] = async (a) => {
    const { runRecipe } = await import('./recipe-runner.ts');
    const result = await runRecipe({
      recipeId: null, recipeSnapshot: '', isAdhoc: true, prompt: a.prompt, spawnMode: 'interactive',
      agentCli: a.provider ?? ctx.cfg.defaultAgentCli ?? 'copilot', agent: a.agent, model: a.model,
      workspaceInfo: { id: a.workspaceId, path: a.workspacePath }, workspacesRoot: ctx.workspacesRoot,
      ws: ctx.ws, cfg: ctx.cfg,
      extraEnv: { CLAWDEVBOX_RECIPE_INSTANCE_ID: a.recipeInstanceId, CLAWDEVBOX_RECIPE_LANE: a.lane },
    });
    if (result.spawn_error) throw new Error(`lane spawn failed: ${result.spawn_error.code} ${result.spawn_error.message}`);
    return { cliSessionId: result.session_id };
  };
  const wakeLaneSession: LaneDispatchWorkerOpts['wakeLaneSession'] = async (a) => {
    const { dispatchOnly } = await import('./session-helpers.ts');
    const shCtx = { db, dispatcher: ctx.dispatcher, ws: ctx.ws, cfg: ctx.cfg };
    const d = await dispatchOnly(shCtx, { session_id: a.cliSessionId, prompt: a.prompt });
    if (!d.ok) logger.warn({ lane: a.lane, code: d.code }, 'lane-dispatch: wake failed');
  };
  return { db, spawnLaneSession, wakeLaneSession };
}
```
(Import `Dispatcher`, `Workspace`, `ResolvedConfig` types the same way `recipe-validation-worker.ts` does.)

- [ ] **Step 2: Wire into `start.ts`**

Import (~L33): `import { startLaneDispatchWorker, defaultLaneDispatchWorkerDeps } from '../lane-dispatch-worker.ts';`
After the validation worker construction (~L2063):
```ts
  const laneWorker = startLaneDispatchWorker(
    defaultLaneDispatchWorkerDeps({ db: opened.db, dispatcher, ws, cfg, workspacesRoot: cfg.workspacesRoot }),
  );
```
At shutdown, next to `validationWorker.stop();` (~L2324): add `laneWorker.stop();`.

- [ ] **Step 3: Typecheck + targeted regression suite**

Run: `npm run typecheck; node --import tsx --test tests/recipe-lane-execution.test.mjs tests/recipe-step-validation.test.mjs tests/recipe-step-tools.test.mjs tests/recipe-validation-worker.test.mjs tests/recipe-build-step-decls.test.mjs tests/recipe-multi-gate.test.mjs tests/db-migrations.test.mjs`
Expected: typecheck exit 0; all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/lane-dispatch-worker.ts src/cli/start.ts
git commit -m "feat(recipe): default lane-dispatch deps + start/stop the worker in the server"
```

---

## Task 9: Real end-to-end acceptance (no mocks)

**Files:** Create a demo recipe under `~/.clawdevbox/recipes/lane-bifurcation-demo.yaml`; drive it via `POST http://127.0.0.1:5201/spawn`.

Not a unit test — the live acceptance proof (same method used throughout this project).

- [ ] **Step 1: Author the demo recipe** — `main` lane: `setup` → `finalize`; `deploy` lane: `deploy-step`; `reviews` lane: `review-step`; `finalize` `depends: [setup, deploy-step, review-step]` on lane `main`; give one gate a `verifier_model` and one lane an `execution.model`. Each non-main step's `ai_instructions` write a lane-stamped file into `CLAWDEVBOX_PROJECT_DIR`.

- [ ] **Step 2: Restart the tsx server from source** (loads migration v17 + workers), confirm `healthz` = ok and `schema_version` = 17.

- [ ] **Step 3: `POST /spawn`** a prompt that runs `lane-bifurcation-demo`. Poll the DB (readonly, WAL) — assert: (a) `recipe_lane_sessions` gains `main`, `deploy`, `reviews` rows with distinct `cli_session_id`s; (b) `deploy` + `reviews` steps run concurrently on separate sessions; (c) `finalize` runs on the SAME `cli_session_id` as `setup` (the initial console resumed); (d) the gated step's verifier session was spawned with the declared model.

- [ ] **Step 4: Full targeted suite + typecheck green; screenshot the recipe UI** showing the lanes if the UI renders them (optional).

- [ ] **Step 5: Commit any demo artifacts / notes** (the recipe lives in the user recipe dir, not the repo — commit only code/docs).

---

## Self-Review Notes (author)

- **Spec coverage:** §5 schema → Tasks 1–2; §6 worker + lane-scoped readiness → Tasks 4,7,8; §8 resume-to-initial → Task 7 (`main` wake) + Task 5 (main recorded); §9 model/agent wiring → Task 6 (validation) + Tasks 7–8 (execution); §10 storage → Task 3; §11 backward-compat → default `main` everywhere + Task 9 regression; §13 testing → each task's unit tests + Task 9 e2e.
- **Duplication removed:** the three ready-step sites (`recipe.ts` begin, `recipe.ts` update_status, worker `nextStepPrompt`) all route through `computeReadySteps` (Task 4).
- **Naming consistency:** `normalizeExecution`, `resolveLane`, `computeReadySteps`, `recordMainLane`, `upsertLaneSession`/`getLaneSession`/`resolveLaneBySession`, `startLaneDispatchWorker`/`defaultLaneDispatchWorkerDeps`, `spawnLaneSession`/`wakeLaneSession` are used identically across tasks.
- **Backward-compat:** a recipe with no `execution` → every step lane `main` → one row in `recipe_lane_sessions` → the lane worker only ever wakes the already-live initial session (no behavior change); `verifier_model` moves from ignored to honored.
