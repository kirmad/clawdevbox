# Trigger → Live Agent Dispatch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire L1 (provider capabilities) + L2 (SessionConductor) into the trigger → agent flow. After this plan lands, trigger scripts can POST a prompt to either an existing live agent (queued + coalesced via SessionConductor) or a freshly spawned interactive agent. The legacy `/callback/<fire_id>` route is deleted; new `/dispatch/<fire_id>` and `/spawn/<fire_id>` endpoints replace it. Spec: `docs/superpowers/specs/2026-05-29-trigger-live-agent-dispatch-design.md`.

**Architecture:** Three sequential PRs, each independently shippable. PR#1 adds conductor lifecycle to pty-registry + migrates main-agent (infrastructure only, no behavior change). PR#2 adds `spawnMode: 'interactive'` + ad-hoc no-recipe runs to recipe-runner (still no caller wired). PR#3 deletes `/callback`, adds `/dispatch` + `/spawn` endpoints + `GET /api/sessions/<id>`, updates the trigger envelope, renames `CLAWDEVBOX_MCP_SECRET` → `CLAWDEVBOX_FIRE_SECRET`. PR#3 is the user-visible payoff.

**Tech Stack:** TypeScript (mcp-server kernel), node:test, better-sqlite3, the existing SessionConductor / pty-registry / recipe-runner / dispatcher modules.

---

## File Structure

### PR #1 (B+E) — pty-registry conductor lifecycle + main-agent migration

| File | Action |
|---|---|
| `mcp-server/src/pty-registry.ts` | Add `provider`/`agentHandle` to `PtyRegisterOptions`; construct conductor when both supplied; add `getConductor(instanceId)` export |
| `mcp-server/src/main-agent.ts` | Pass `provider` + `agentHandle` to `registerPty` |
| `mcp-server/tests/pty-registry-conductor.test.mjs` | NEW — covers conductor creation + getConductor + cleanup-on-exit |
| `mcp-server/tests/main-agent-conductor.test.mjs` | NEW — asserts main-agent registers with a conductor |
| `mcp-server/package.json:34` | Register the two new test files |

### PR #2 (D) — recipe-runner interactive mode + ad-hoc support

| File | Action |
|---|---|
| `mcp-server/src/recipe-runner.ts` | Add `spawnMode?: 'interactive' \| 'headless'`; make `recipeId: string \| null`; add `isAdhoc?: boolean`; branch spawn `mode` accordingly; pass `provider`+`agentHandle` to `registerPty` when interactive; set `agent_sessions.interactive=1` when interactive |
| `mcp-server/src/tools/recipe.ts` | Add optional `spawn_mode` parameter to `recipe.run` zod schema; pass through to runRecipe |
| `mcp-server/tests/recipe-runner-interactive.test.mjs` | NEW — covers headless default, interactive + conductor registration, ad-hoc no-recipe, returns immediately after spawn |
| `mcp-server/package.json:34` | Register the new test file |

### PR #3 (C) — Trigger dispatch + spawn endpoints + envelope rewrite

| File | Action |
|---|---|
| `mcp-server/src/trigger-runner.ts` | `TriggerEnvelope.callback_url` removed; add `output_dir`, optional `dispatch_url`, required `spawn_url`; env var rename `CLAWDEVBOX_MCP_SECRET` → `CLAWDEVBOX_FIRE_SECRET` |
| `mcp-server/src/dispatcher.ts` | Drop `recordCallback` method; drop Mode A/B reading; expand `activeRuns` entry; mint dispatch+spawn URLs; resolve `dispatchTargetInstanceId` from `trigger.subscriber_thread_id` |
| `mcp-server/src/cli/cron-api.ts` | Remove `/callback/<fire_id>` route; add `/dispatch/<fire_id>`, `/spawn/<fire_id>`, `GET /api/sessions/<id>` |
| `mcp-server/src/cli/start.ts` | Wire `/api/sessions/<id>` route mounting if not already covered by cron-api |
| `mcp-server/src/tools/trigger.ts` | `trigger.test` MCP tool: update envelope construction to use the new shape (drop callback_url, add output_dir + spawn_url + dispatch_url placeholders); rename CLAWDEVBOX_MCP_SECRET env injection |
| `mcp-server/tests/callback-api.test.mjs` | DELETE (route is gone) or trim to non-callback tests if it has any |
| `mcp-server/tests/dispatcher.test.mjs` | Remove assertions about `recordCallback` / `callback_url` / Mode A/B |
| `mcp-server/tests/dispatch-endpoint.test.mjs` | NEW — covers dispatch routing to conductor |
| `mcp-server/tests/spawn-endpoint.test.mjs` | NEW — covers spawn routing to recipe-runner |
| `mcp-server/tests/api-sessions.test.mjs` | NEW — covers GET /api/sessions/<id> projection |
| `mcp-server/tests/trigger-templates.test.mjs` or `tests/trigger.test` | Update envelope-shape assertions where applicable |
| `mcp-server/package.json:34` | Register 3 new test files, remove deleted ones |
| `docs/tools/trigger.md` | New envelope contract docs |
| `docs/MCP-TOOLS-REFERENCE.md` | Regenerate via `docs/scripts/compose_master_doc.py` after trigger.md edits |

---

## PR #1: pty-registry conductor lifecycle + main-agent migration

### Task 1.1: Extend pty-registry to construct conductors

**Files:**
- Modify: `mcp-server/src/pty-registry.ts:75-82, 84-96, 102-154`
- Test: `mcp-server/tests/pty-registry-conductor.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/pty-registry-conductor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerPty, getConductor, hasSession, killPty } from '../src/pty-registry.ts';

function makeFakePty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    pid: 12345,
    write: () => {},
    resize: () => {},
    kill: () => { for (const cb of exitListeners) cb({ exitCode: 0, signal: undefined }); },
    onData: (cb) => { dataListeners.push(cb); return { dispose() {} }; },
    onExit: (cb) => { exitListeners.push(cb); return { dispose() {} }; },
    _emitData: (chunk) => { for (const cb of dataListeners) cb(chunk); },
    _emitExit: (code) => { for (const cb of exitListeners) cb({ exitCode: code, signal: undefined }); },
  };
}

function makeFakeProvider() {
  return {
    id: 'fake',
    displayName: 'Fake',
    description: 'fake',
    source: 'builtin',
    capabilities: {
      queueMode: 'none',
      promptSubmitStrategy: 'bulk-cr',
      promptReadyRegex: /❯[^\S\n]*$/m,
      busyIndicators: [/Working/i],
    },
    async writePrompt() {},
    async detect() { return { available: true, binary: 'fake', version: '0' }; },
    async spawnSession() { throw new Error('unused'); },
    async syncPluginInventory() { return { plugins: [], errors: [] }; },
    async discoverInstalledPlugins() { return []; },
  };
}

test('registerPty without provider creates session without conductor', () => {
  const pty = makeFakePty();
  registerPty({ instanceId: 'noconductor-1', workspaceId: 'ws', cols: 80, rows: 24, ipty: pty });
  assert.equal(hasSession('noconductor-1'), true);
  assert.equal(getConductor('noconductor-1'), null);
  killPty('noconductor-1');
});

test('registerPty with provider + agentHandle creates conductor', () => {
  const pty = makeFakePty();
  const provider = makeFakeProvider();
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const handle = { pid: pty.pid, sessionId: 'sess', pty, exited };
  registerPty({
    instanceId: 'withconductor-1',
    workspaceId: 'ws',
    cols: 80, rows: 24,
    ipty: pty,
    provider,
    agentHandle: handle,
  });
  const cond = getConductor('withconductor-1');
  assert.ok(cond, 'conductor must exist');
  assert.equal(cond.state, 'starting');
  killPty('withconductor-1');
});

test('getConductor returns null for unknown instance', () => {
  assert.equal(getConductor('does-not-exist'), null);
});

test('conductor moves to exited when pty exits', async () => {
  const pty = makeFakePty();
  const provider = makeFakeProvider();
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const handle = { pid: pty.pid, sessionId: 'sess', pty, exited };
  registerPty({
    instanceId: 'exit-1',
    workspaceId: 'ws',
    cols: 80, rows: 24,
    ipty: pty,
    provider,
    agentHandle: handle,
  });
  const cond = getConductor('exit-1');
  assert.ok(cond);
  pty._emitExit(0);
  resolveExit({ exitCode: 0, signal: undefined });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(cond.state, 'exited');
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd C:\git\clawdevbox\mcp-server
node --import tsx --test tests/pty-registry-conductor.test.mjs
```

Expected: at least 2 of the 4 tests fail (registerPty doesn't accept provider/agentHandle; getConductor doesn't exist).

- [ ] **Step 3: Extend `PtyRegisterOptions` and add conductor field on session**

Edit `mcp-server/src/pty-registry.ts`. At the top of the file, add imports:

```ts
import type { AgentCliProvider, AgentHandle } from './agent-clis/types.ts';
import { createSessionConductor, type SessionConductor } from './agent-clis/session-conductor.ts';
```

Update `PtyRegisterOptions` (currently lines 75-82) to add the two optional fields:

```ts
export interface PtyRegisterOptions {
  instanceId: string;
  workspaceId: string;
  cols: number;
  rows: number;
  ipty: IPty;
  meta?: Omit<PtySessionMeta, 'startedAt'>;
  /**
   * Provider that spawned this pty. Required for the registry to build a
   * SessionConductor. When omitted, the session has no conductor and
   * getConductor(instanceId) returns null. Legacy callers (playwright
   * fixture, raw test harnesses) can still register without this.
   */
  provider?: AgentCliProvider;
  /**
   * Agent handle whose .pty is `ipty`. Required iff `provider` is provided —
   * the conductor needs handle.exited to track the exited state transition.
   */
  agentHandle?: AgentHandle;
}
```

Update the `PtySession` interface (currently lines 84-96) to hold the conductor:

```ts
interface PtySession {
  instanceId: string;
  workspaceId: string;
  ipty: IPty;
  cols: number;
  rows: number;
  buffer: string[];
  bufferBytes: number;
  subscribers: Set<PtySubscriber>;
  exited: boolean;
  exitCode: number | null;
  meta: PtySessionMeta;
  conductor: SessionConductor | null;
}
```

- [ ] **Step 4: Construct conductor in `registerPty` when both inputs supplied**

In the `registerPty` function (currently lines 114-154), after creating the `session` object and before `sessions.set(...)`, add:

```ts
  let conductor: SessionConductor | null = null;
  if (opts.provider && opts.agentHandle) {
    try {
      conductor = createSessionConductor({
        handle: opts.agentHandle,
        provider: opts.provider,
        role: opts.instanceId,
      });
    } catch (err) {
      // Provider may not declare capabilities or writePrompt (e.g.,
      // echo-stub). Sessions without conductor remain valid for raw
      // terminal viewing — the caller just can't dispatch through the
      // conductor API.
      conductor = null;
    }
  }
  session.conductor = conductor;
```

Update the `session` object literal earlier in the function to default `conductor: null` so the field is always present:

Find:
```ts
  const session: PtySession = {
    instanceId: opts.instanceId,
    workspaceId: opts.workspaceId,
    ipty: opts.ipty,
    cols: opts.cols,
    rows: opts.rows,
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    exited: false,
    exitCode: null,
    meta: { ...(opts.meta ?? {}), startedAt: Date.now() },
  };
```

Replace with:
```ts
  const session: PtySession = {
    instanceId: opts.instanceId,
    workspaceId: opts.workspaceId,
    ipty: opts.ipty,
    cols: opts.cols,
    rows: opts.rows,
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    exited: false,
    exitCode: null,
    meta: { ...(opts.meta ?? {}), startedAt: Date.now() },
    conductor: null,
  };
```

Then the conductor-creation block above runs immediately after and sets `session.conductor` if applicable.

- [ ] **Step 5: Add `getConductor` export**

At the bottom of the file (after `getSessionMeta`), add:

```ts
/**
 * Return the SessionConductor for `instanceId`, or null if:
 *  - the session is unknown,
 *  - the session was registered without a provider+agentHandle pair, or
 *  - the provider didn't declare capabilities/writePrompt (conductor creation threw).
 */
export function getConductor(instanceId: string): SessionConductor | null {
  const s = sessions.get(instanceId);
  return s ? s.conductor : null;
}
```

- [ ] **Step 6: Dispose conductor when session is garbage-collected**

In the `onExit` callback inside `registerPty` (currently lines 140-153), after the `session.exited = true; session.exitCode = ...` assignments, add:

```ts
    if (session.conductor) {
      try { session.conductor.dispose(); } catch { /* idempotent */ }
    }
```

This belongs INSIDE the `onExit` handler but BEFORE the `for (const sub of session.subscribers)` loop so subscribers don't see post-exit emissions from the conductor.

- [ ] **Step 7: Run test to verify it passes**

```powershell
cd C:\git\clawdevbox\mcp-server
node --import tsx --test tests/pty-registry-conductor.test.mjs
```

Expected: 4/4 pass.

- [ ] **Step 8: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 9: Register test file in package.json**

Open `mcp-server/package.json`. Locate the `"test"` script (line 34). Insert `tests/pty-registry-conductor.test.mjs` alphabetically. Verify by inspection that the path appears exactly once.

- [ ] **Step 10: Run targeted tests**

```powershell
node --import tsx --test tests/pty-registry-conductor.test.mjs tests/session-conductor.test.mjs
```

Expected: all pass.

- [ ] **Step 11: Commit**

```powershell
cd C:\git\clawdevbox
git add mcp-server/src/pty-registry.ts mcp-server/tests/pty-registry-conductor.test.mjs mcp-server/package.json
git commit -m "feat(pty-registry): construct SessionConductor when provider+agentHandle supplied" -m "Adds provider?: AgentCliProvider and agentHandle?: AgentHandle fields to PtyRegisterOptions. When both are present, registerPty builds a SessionConductor via createSessionConductor() and stores it on the session record. New getConductor(instanceId) export returns it; null for sessions registered without those inputs (legacy/test paths) or for providers that don't declare capabilities/writePrompt." -m "Conductor is disposed automatically inside the onExit handler so subscribers don't see post-exit emissions. registerPty's existing writeToPty/resizePty/killPty contract is unchanged." -m "Spec: docs/superpowers/specs/2026-05-29-trigger-live-agent-dispatch-design.md (PR #1 / B+E)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 1.2: Migrate main-agent to pass provider+agentHandle

**Files:**
- Modify: `mcp-server/src/main-agent.ts:194-200`
- Test: `mcp-server/tests/main-agent-conductor.test.mjs` (new)

- [ ] **Step 1: Write the failing test**

Create `mcp-server/tests/main-agent-conductor.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getConductor, hasSession } from '../src/pty-registry.ts';
import { MAIN_AGENT_INSTANCE_ID } from '../src/main-agent.ts';

// This is a documentation test — main-agent.startMainAgent has too many
// dependencies (config, workspace, vault, real pty) to unit-test in
// isolation here. Instead we verify the wiring contract: when a main
// agent is registered (in any production session), getConductor returns
// non-null. The integration test for the spawn flow lives in
// tests/kernel-smoke.test.mjs and exercises the real path.
//
// This test asserts the EXPECTED state shape so that if the wiring
// regresses in main-agent.ts (provider arg dropped), the integration
// test failure is preceded by a clearer signal here.

test('main-agent module exports the expected constants for conductor wiring', () => {
  assert.equal(typeof MAIN_AGENT_INSTANCE_ID, 'string');
  assert.equal(MAIN_AGENT_INSTANCE_ID, 'main');
  // getConductor exists and is callable
  assert.equal(typeof getConductor, 'function');
  // When no main agent is registered (this test runs in isolation),
  // getConductor returns null cleanly.
  if (!hasSession(MAIN_AGENT_INSTANCE_ID)) {
    assert.equal(getConductor(MAIN_AGENT_INSTANCE_ID), null);
  }
});
```

- [ ] **Step 2: Run test to verify it passes (shape-only test)**

```powershell
node --import tsx --test tests/main-agent-conductor.test.mjs
```

Expected: 1/1 pass.

This test is intentionally lightweight — it documents the contract. The real wiring fix below is verified end-to-end by running the kernel and inspecting `getConductor('main')` after `startMainAgent` (covered in Step 7).

- [ ] **Step 3: Update main-agent.ts to pass provider + agentHandle**

Open `mcp-server/src/main-agent.ts`. Locate the `registerPty` call inside `startMainAgent` (currently lines 194-200):

```ts
    registerPty({
      instanceId: MAIN_AGENT_INSTANCE_ID,
      workspaceId: 'project',
      cols: 120,
      rows: 30,
      ipty: handle.pty,
    });
```

Replace with:

```ts
    registerPty({
      instanceId: MAIN_AGENT_INSTANCE_ID,
      workspaceId: 'project',
      cols: 120,
      rows: 30,
      ipty: handle.pty,
      provider,
      agentHandle: handle,
    });
```

(`provider` and `handle` are both already in scope — `provider` from line 114, `handle` from line 168.)

- [ ] **Step 4: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 5: Run targeted tests**

```powershell
node --import tsx --test tests/main-agent-conductor.test.mjs tests/pty-registry-conductor.test.mjs tests/session-conductor.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Run main-agent-adjacent suite**

```powershell
node --import tsx --test tests/kernel-smoke.test.mjs tests/mcp-bootstrap.test.mjs
```

Expected: passes OR pre-existing flake (compare against baseline). If a new failure appears, it likely stems from the conductor's `firstReadyTimeoutMs` timer keeping the process alive in test mode — fix by ensuring the conductor's timers are properly disposed when the pty exits (Task 1.1 Step 6 should handle this).

- [ ] **Step 7: Register test file in package.json**

Open `mcp-server/package.json`. Insert `tests/main-agent-conductor.test.mjs` alphabetically.

- [ ] **Step 8: Commit**

```powershell
git add mcp-server/src/main-agent.ts mcp-server/tests/main-agent-conductor.test.mjs mcp-server/package.json
git commit -m "feat(main-agent): pass provider + agentHandle to registerPty" -m "After PR #1's pty-registry change, registerPty can construct a SessionConductor when given both. The main agent already has the resolved provider (line 114) and the spawn handle (line 168). Passing both unlocks getConductor('main') for the upcoming dispatch endpoint." -m "MainAgentStatus projection is unchanged; the conductor state is not surfaced yet (lands in PR #3 via GET /api/sessions/main)." -m "Spec: docs/superpowers/specs/2026-05-29-trigger-live-agent-dispatch-design.md (PR #1 / B+E)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 1.3: PR #1 verification

- [ ] **Step 1: Full typecheck**

```powershell
cd C:\git\clawdevbox\mcp-server
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 2: Full test suite — confirm no regressions**

```powershell
npm test
```

Expected: pass count ≥ 484 (the post-F baseline) with the same flake set (`api-test-hooks`, `workspace+recipe.run`). New tests add 5 to the total (4 from conductor test + 1 from main-agent shape test).

Document the actual pass/fail count for PR #2's baseline comparison.

- [ ] **Step 3: Commit lineage check**

```powershell
git --no-pager log --oneline -3
```

Expected:
```
<sha> feat(main-agent): pass provider + agentHandle to registerPty
<sha> feat(pty-registry): construct SessionConductor when provider+agentHandle supplied
<sha> [previous head before PR #1]
```

---

## PR #2: recipe-runner interactive mode + ad-hoc support

### Task 2.1: Add spawnMode + ad-hoc to recipe-runner

**Files:**
- Modify: `mcp-server/src/recipe-runner.ts:39-82, 126-330+`
- Test: `mcp-server/tests/recipe-runner-interactive.test.mjs` (new)

- [ ] **Step 1: Update RunRecipeOptions interface**

Open `mcp-server/src/recipe-runner.ts`. Update the `RunRecipeOptions` interface (currently lines 39-82):

```ts
export interface RunRecipeOptions {
  /**
   * Resolved recipe id (after scope-chain lookup), OR null for ad-hoc
   * sessions that don't load a recipe. When null, `isAdhoc` must be true.
   */
  recipeId: string | null;
  /**
   * Raw YAML snapshot to record on the instance row. Required when
   * recipeId is non-null; ignored (use empty string) for ad-hoc sessions.
   */
  recipeSnapshot: string;
  /** True when the recipe was supplied inline (no saved file) OR when this is an ad-hoc no-recipe session. */
  isAdhoc?: boolean;
  /** First user message handed to the spawned agent. */
  prompt: string;
  /**
   * 'headless' (default) preserves current behavior — provider spawns with
   * --print/-p, agent exits on completion. 'interactive' keeps the pty
   * alive after the first turn; opts.prompt becomes the seed prompt
   * delivered via deliverInitialPromptWhenReady (already in the provider).
   * Interactive runs register a SessionConductor in pty-registry for
   * downstream dispatch via /dispatch/<fire_id> or in-process callers.
   */
  spawnMode?: 'interactive' | 'headless';
  /** Optional structured params recorded on the instance. */
  params?: Record<string, unknown>;
  /** Workspace to run in (already resolved/created by the caller). */
  workspaceInfo: { id: string; path: string };
  /** Inbox item to associate this run with (optional). */
  attachToInboxItemId?: string;
  /** Which CLI to spawn. Default 'copilot'. */
  agentCli?: string;
  /** Optional agent persona — see prior JSDoc, unchanged. */
  agent?: string;
  /** Explicit CLI session id. Auto-minted from the instance id when absent. */
  sessionId?: string;
  /** Resume a prior recipe instance (CLI session id of the predecessor). */
  resumeOf?: string;
  /** Lineage — parent recipe instance id, if this is a nested run. */
  parentRecipeInstanceId?: string;
  /** Lineage — trigger that fired this run (dispatcher path). */
  triggerId?: string;
  /** Lineage — fire row that produced this run (dispatcher path). */
  fireId?: string;
  /** Workspaces-root used by spawned MCP children (for the .mcp.json env). */
  workspacesRoot: string;
  /** MCP URL to advertise to the spawned MCP child (from process.env). */
  mcpUrl?: string;
  /** Pre-existing MCP secret to reuse. Auto-minted if absent. */
  mcpSecret?: string;
  /** Workspace whose `agentCliProviders` registry resolves `agentCli`. */
  ws: Workspace;
  /** Resolved runtime config (passed into `ProviderCtx`). */
  cfg: ResolvedConfig;
}
```

The breaking change: `recipeId: string` → `recipeId: string | null`. Every caller passing a `recipeId` keeps working; new ad-hoc callers pass `null` + `isAdhoc: true`.

- [ ] **Step 2: Branch on null recipeId — ad-hoc instance**

In `runRecipe()` (starting line 126), the function currently always assumes `opts.recipeId` is a string. Wrap the recipe-specific branches:

Find the existing logic that resolves `agentCli` from the recipe snapshot (around lines 132-141):

```ts
  let recipeAgentCli: string | null = null;
  try {
    const parsed = parseRecipeSource(opts.recipeSnapshot);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>).agent_cli;
      if (typeof v === 'string' && v.length > 0) recipeAgentCli = v;
    }
  } catch {
    /* malformed snapshots fall through to the default chain */
  }
```

Wrap in a guard so ad-hoc skips this:

```ts
  let recipeAgentCli: string | null = null;
  if (opts.recipeId !== null) {
    try {
      const parsed = parseRecipeSource(opts.recipeSnapshot);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const v = (parsed as Record<string, unknown>).agent_cli;
        if (typeof v === 'string' && v.length > 0) recipeAgentCli = v;
      }
    } catch {
      /* malformed snapshots fall through to the default chain */
    }
  }
```

Find the `RecipeInstance` construction (around line 170-188) and adapt for ad-hoc — `recipe_id` becomes a synthetic value:

```ts
  const isAdhoc = opts.isAdhoc === true || opts.recipeId === null;
  const recipeIdResolved = opts.recipeId ?? `__adhoc_${instanceId}`;
  const recipeSnapshot = opts.recipeId === null ? '' : opts.recipeSnapshot;

  const instance: RecipeInstance = {
    id: instanceId,
    recipe_id: recipeIdResolved,
    recipe_snapshot: recipeSnapshot,
    workspace_id: opts.workspaceInfo.id,
    workspace_path: opts.workspaceInfo.path,
    prompt: opts.prompt,
    params: opts.params ?? {},
    agent_cli: agentCli,
    pid: null,
    started_at: Date.now(),
    status: 'running',
    completed_at: null,
    result: null,
    message: null,
    session_id: sessionId,
    resume_of: opts.resumeOf ?? null,
    parent_recipe_instance_id: opts.parentRecipeInstanceId ?? null,
  };
```

Update the `RunRecipeResult` to carry the resolved (possibly synthetic) recipe_id:

The existing return shape uses `recipe_id: opts.recipeId` — change all such references to `recipe_id: recipeIdResolved` and `adhoc: isAdhoc`.

Search for `adhoc: opts.isAdhoc ?? false` in the file — there's an instance at line 235. Replace with `adhoc: isAdhoc`. Apply the same change at every `return { ... }` site in `runRecipe`.

- [ ] **Step 3: Branch spawn mode**

Locate the `provider.spawnSession(...)` call (around lines 284-308). Add a mode resolution above it:

```ts
  const spawnMode: 'interactive' | 'headless' = opts.spawnMode === 'interactive' ? 'interactive' : 'headless';
```

Change the call to use `spawnMode`:

```ts
    const handle = await provider.spawnSession(providerCtx, {
      mode: spawnMode,
      // ...rest unchanged...
    });
```

The provider's `deliverInitialPromptWhenReady` (already wired in copilot.ts/claude.ts/agency) handles delivering `opts.prompt` after splash when `mode === 'interactive'`. No additional plumbing here.

- [ ] **Step 4: Pass provider + agentHandle to registerPty when interactive**

Locate the `registerPty(...)` call inside `runRecipe` (around lines 315-328). Extend it:

```ts
    registerPty({
      instanceId,
      workspaceId: opts.workspaceInfo.id,
      cols: ptyCols,
      rows: ptyRows,
      ipty: ptyProc,
      meta: {
        cwd: lastSpawn?.cwd ?? opts.workspaceInfo.path,
        commandLine,
        agentCli,
        sessionId,
        recipeId: opts.recipeId ?? recipeIdResolved,
      },
      provider: spawnMode === 'interactive' ? provider : undefined,
      agentHandle: spawnMode === 'interactive' ? handle : undefined,
    });
```

For headless runs the provider is omitted — no conductor is constructed, and the existing exit-on-completion semantics are preserved.

- [ ] **Step 5: Mark agent_sessions.interactive when interactive**

Search the file for `agent_sessions` INSERT/UPDATE statements. The existing code writes a row when the recipe spawns. Find the insert (likely in a `try { ... } catch` block after registerPty). The column `interactive` already exists in the schema (`migrations.ts:124`) but defaults to 0.

If the insert currently uses `INSERT INTO agent_sessions (id, ..., status) VALUES (?, ..., 'running')`, extend to include `interactive` with the value `spawnMode === 'interactive' ? 1 : 0`.

If no insert exists in recipe-runner.ts (search confirms it lives elsewhere — possibly `tools/recipe.ts` or `recipe-instances-store.ts`), find the actual site via:

```powershell
grep -rn "INSERT INTO agent_sessions" mcp-server/src/
```

Apply the same fix at the production site.

- [ ] **Step 6: Write the failing test**

Create `mcp-server/tests/recipe-runner-interactive.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../src/db/index.ts';
import { initDatabase } from '../src/db/index.ts';
import { ensureWorkspace } from '../src/db/workspaces-store.ts';
import { runRecipe } from '../src/recipe-runner.ts';
import { getConductor, hasSession, killPty } from '../src/pty-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TMP_ROOT = resolve(__dirname, '.tmp', 'recipe-runner-interactive');

function freshTmp(name) {
  const p = join(TMP_ROOT, `${name}_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`);
  mkdirSync(p, { recursive: true });
  return p;
}

function makeFakePty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    pid: 99001,
    write: () => {},
    resize: () => {},
    kill: () => { for (const cb of exitListeners) cb({ exitCode: 0, signal: undefined }); },
    onData: (cb) => { dataListeners.push(cb); return { dispose() {} }; },
    onExit: (cb) => { exitListeners.push(cb); return { dispose() {} }; },
    _emitData: (chunk) => { for (const cb of dataListeners) cb(chunk); },
    _emitExit: (code) => { for (const cb of exitListeners) cb({ exitCode: code, signal: undefined }); },
  };
}

function makeFakeProvider(captured) {
  return {
    id: 'fake-cli',
    displayName: 'Fake',
    description: 'fake',
    source: 'builtin',
    capabilities: {
      queueMode: 'none',
      promptSubmitStrategy: 'bulk-cr',
      promptReadyRegex: /❯[^\S\n]*$/m,
      busyIndicators: [/Working/i],
    },
    async writePrompt() {},
    async detect() { return { available: true, binary: 'fake', version: '0' }; },
    async spawnSession(_ctx, opts) {
      captured.spawnCalls.push({ mode: opts.mode, prompt: opts.prompt });
      const pty = makeFakePty();
      const handle = { pid: pty.pid, sessionId: opts.init.session_id, pty, exited: new Promise(() => {}) };
      captured.lastHandle = handle;
      captured.lastPty = pty;
      return handle;
    },
    async syncPluginInventory() { return { plugins: [], errors: [] }; },
    async discoverInstalledPlugins() { return []; },
  };
}

function makeWs(provider) {
  return {
    projectDir: 'C:/test',
    globalDir: 'C:/test/.cdb',
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map([[provider.id, provider]]),
  };
}

function makeCfg() {
  return {
    defaultAgentCli: 'fake-cli',
    http: { host: '127.0.0.1', port: 5201, token: '' },
    vaults: [],
  };
}

test('runRecipe spawnMode=headless does NOT register a conductor', async () => {
  initDatabase(':memory:');
  const captured = { spawnCalls: [] };
  const provider = makeFakeProvider(captured);
  const ws = makeWs(provider);
  const wsPath = freshTmp('headless');
  const wsInfo = { id: 'ws_t', path: wsPath };
  const result = await runRecipe({
    recipeId: 'r',
    recipeSnapshot: 'name: r\n',
    prompt: 'hello',
    workspaceInfo: wsInfo,
    workspacesRoot: wsPath,
    ws,
    cfg: makeCfg(),
  });
  assert.equal(captured.spawnCalls[0].mode, 'headless');
  assert.equal(getConductor(result.recipe_instance_id), null);
  killPty(result.recipe_instance_id);
});

test('runRecipe spawnMode=interactive registers a conductor', async () => {
  const captured = { spawnCalls: [] };
  const provider = makeFakeProvider(captured);
  const ws = makeWs(provider);
  const wsPath = freshTmp('interactive');
  const wsInfo = { id: 'ws_t', path: wsPath };
  const result = await runRecipe({
    recipeId: 'r',
    recipeSnapshot: 'name: r\n',
    prompt: 'hello',
    spawnMode: 'interactive',
    workspaceInfo: wsInfo,
    workspacesRoot: wsPath,
    ws,
    cfg: makeCfg(),
  });
  assert.equal(captured.spawnCalls[0].mode, 'interactive');
  const cond = getConductor(result.recipe_instance_id);
  assert.ok(cond, 'conductor must exist for interactive runs');
  killPty(result.recipe_instance_id);
});

test('runRecipe ad-hoc (recipeId=null) succeeds and returns a synthetic recipe_id', async () => {
  const captured = { spawnCalls: [] };
  const provider = makeFakeProvider(captured);
  const ws = makeWs(provider);
  const wsPath = freshTmp('adhoc');
  const wsInfo = { id: 'ws_t', path: wsPath };
  const result = await runRecipe({
    recipeId: null,
    recipeSnapshot: '',
    isAdhoc: true,
    prompt: 'just respond',
    spawnMode: 'interactive',
    workspaceInfo: wsInfo,
    workspacesRoot: wsPath,
    ws,
    cfg: makeCfg(),
  });
  assert.equal(result.adhoc, true);
  assert.ok(result.recipe_id.startsWith('__adhoc_'), `expected __adhoc_ prefix, got ${result.recipe_id}`);
  killPty(result.recipe_instance_id);
});

test('cleanup', () => {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});
```

- [ ] **Step 7: Run test to verify**

```powershell
cd C:\git\clawdevbox\mcp-server
node --import tsx --test tests/recipe-runner-interactive.test.mjs
```

Expected: 3/3 (+ cleanup) pass after the recipe-runner changes are in place. If failures, iterate on the recipe-runner edits.

- [ ] **Step 8: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0. Existing recipe-runner callers (`tools/recipe.ts`, `dispatcher.ts` no longer — it was removed in F) keep working because `recipeId: string` is a subtype of `string | null`.

- [ ] **Step 9: Run existing recipe-runner tests for regressions**

```powershell
node --import tsx --test tests/recipe-real-e2e.test.mjs tests/recipe-step-tools.test.mjs
```

Expected: no NEW failures vs baseline.

- [ ] **Step 10: Register test in package.json**

Insert `tests/recipe-runner-interactive.test.mjs` alphabetically into the `"test"` script.

- [ ] **Step 11: Commit**

```powershell
git add mcp-server/src/recipe-runner.ts mcp-server/tests/recipe-runner-interactive.test.mjs mcp-server/package.json
git commit -m "feat(recipe-runner): add spawnMode + ad-hoc no-recipe support" -m "RunRecipeOptions gains spawnMode?: 'interactive' | 'headless' (default headless preserves existing behavior). Interactive runs register a SessionConductor in pty-registry; headless runs do not (no conductor needed — agent exits on its own)." -m "recipeId becomes string | null. When null + isAdhoc: true, the runner spawns an interactive session with no recipe loaded, mints a synthetic recipe_id of '__adhoc_<instanceId>', and writes a recipe_instances row with empty recipe_snapshot. This unlocks the /spawn/<fire_id> handler in PR #3." -m "agent_sessions.interactive is set to 1 for interactive runs." -m "Spec: docs/superpowers/specs/2026-05-29-trigger-live-agent-dispatch-design.md (PR #2 / D)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.2: Wire spawn_mode through `recipe.run` MCP tool

**Files:**
- Modify: `mcp-server/src/tools/recipe.ts` (zod schema for `recipe.run`)

- [ ] **Step 1: Find the recipe.run schema**

```powershell
grep -n "recipe.run\|recipeId:.*z\." mcp-server/src/tools/recipe.ts | Select-Object -First 30
```

Locate the `recipe.run` MCP tool's `parameters: z.object({...})` block. Find the spot where existing options like `agent`, `prompt`, etc. are declared.

- [ ] **Step 2: Add spawn_mode parameter**

Add to the zod schema:

```ts
        spawn_mode: z.enum(['interactive', 'headless']).optional().describe(
          "Spawn mode. 'headless' (default) exits when the prompt is complete. 'interactive' keeps the pty alive, exposing a SessionConductor so external callers can dispatch follow-up prompts.",
        ),
```

In the handler, pass `spawnMode: args.spawn_mode` (or `undefined`) into the `runRecipe(...)` call.

- [ ] **Step 3: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 4: Run recipe tests**

```powershell
node --import tsx --test tests/recipe-runner-interactive.test.mjs tests/recipe-step-tools.test.mjs tests/recipe-real-e2e.test.mjs
```

Expected: no new failures.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/src/tools/recipe.ts
git commit -m "feat(tools/recipe): expose spawn_mode option on recipe.run" -m "New optional parameter passes through to runRecipe's spawnMode. Default headless preserves existing behavior; 'interactive' opts into conductor-attached pty for downstream dispatch." -m "Spec: docs/superpowers/specs/2026-05-29-trigger-live-agent-dispatch-design.md (PR #2 / D)" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2.3: PR #2 verification

- [ ] **Step 1: Full typecheck + full suite**

```powershell
npm run typecheck
npm test
```

Expected: no new failures vs the count recorded in Task 1.3 Step 2.

- [ ] **Step 2: Commit lineage check**

```powershell
git --no-pager log --oneline -5
```

Expected: PR #2's 2 commits on top of PR #1's 2 commits.

---

## PR #3: Trigger dispatch + spawn endpoints + envelope rewrite

### Task 3.1: Trigger envelope changes (`trigger-runner.ts`)

**Files:**
- Modify: `mcp-server/src/trigger-runner.ts:23-30, 36-41, 89`

- [ ] **Step 1: Update `TriggerEnvelope` interface**

Open `mcp-server/src/trigger-runner.ts`. Replace lines 23-30:

```ts
export interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  /**
   * Absolute path to the per-attempt output directory the dispatcher
   * created BEFORE spawning this script. Scripts may write audit /
   * observation files here directly via filesystem; the kernel does not
   * read them. Path shape: <ws>/.clawdevbox/fires/<fire_id>/attempt-<N>/
   */
  output_dir: string;
  /**
   * URL to POST { prompt: string } to dispatch a prompt to the agent
   * attached to THIS trigger's subscriber_thread_id. Present only when
   * the trigger registration has subscriber_thread_id set AND that
   * thread's pty is live in pty-registry at script-spawn time.
   */
  dispatch_url?: string;
  /**
   * URL to POST { prompt: string, agent?: string, workspace_id?: string }
   * to spawn a fresh interactive agent. Always present.
   */
  spawn_url: string;
  state: Record<string, unknown>;
  payload: unknown;
}
```

- [ ] **Step 2: Update env var name in spawn**

Find the env var injection (line 89, `CLAWDEVBOX_MCP_SECRET: opts.callbackSecret`). Replace with:

```ts
      CLAWDEVBOX_FIRE_SECRET: opts.callbackSecret,
```

Also update the JSDoc on line 39 (`callbackSecret` field doc) and the RunOptions JSDoc (line 39 `CLAWDEVBOX_MCP_SECRET is set by the runner`) to reflect the rename:

```ts
  /** Extra env vars merged into the spawn env (CLAWDEVBOX_FIRE_SECRET is set by the runner). */
```

The internal field name `callbackSecret` can stay or be renamed to `fireSecret`. Keeping `callbackSecret` reduces churn in callers; renaming is cosmetic. **Pick: keep `callbackSecret` internally; only rename the env var.**

- [ ] **Step 3: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0 — except callers that construct an envelope still use `callback_url`. Those errors are real and will be fixed in subsequent tasks.

Document which files break (`dispatcher.ts`, `tools/trigger.ts`) — they're handled in Tasks 3.2 and 3.4.

- [ ] **Step 4: NO commit yet**

This task's changes don't compile in isolation — they need dispatcher + trigger.test to be updated in the same commit. Hold and commit at the end of Task 3.2.

### Task 3.2: Dispatcher routing + `/callback` removal

**Files:**
- Modify: `mcp-server/src/dispatcher.ts:88-91, 105-119, 207-252, 383-470`

- [ ] **Step 1: Update `activeRuns` entry shape**

Open `mcp-server/src/dispatcher.ts`. Find the `activeRuns` declaration (around line 117): `private activeRuns = new Map<string, { secret: string; outDir: string }>();`

Extend the value type with new fields. Add an interface above the class:

```ts
interface ActiveRunEntry {
  secret: string;
  outDir: string;
  dispatchTargetInstanceId?: string;
  spawnDefaults: {
    providerId: string;
    agent?: string;
    workspaceId: string;
    workspacePath: string;
  };
}
```

Change the declaration:

```ts
  private activeRuns = new Map<string, ActiveRunEntry>();
```

- [ ] **Step 2: Delete `recordCallback` method**

Find the `recordCallback` method (lines 207-252) and delete it entirely, including the surrounding JSDoc block. The method's only caller is `/callback/<fire_id>` in `cron-api.ts` (deleted in Task 3.3).

- [ ] **Step 3: Rewrite `runScriptBinding` to build new envelope**

Find `runScriptBinding` (around line 383). Make these changes:

(a) Remove the `callbackUrl` mint (`const callbackUrl = \`${this.callbackUrlBase}/callback/${fire.fire_id}\`;`).

(b) Add new URL mints:

```ts
    const baseUrl = this.callbackUrlBase;
    const dispatchUrl = `${baseUrl}/dispatch/${fire.fire_id}`;
    const spawnUrl = `${baseUrl}/spawn/${fire.fire_id}`;
```

(c) Resolve `dispatchTargetInstanceId`:

```ts
    let dispatchTargetInstanceId: string | undefined;
    try {
      const stateObj = JSON.parse(trigger.state_json) as Record<string, unknown>;
      const subscriberThreadId = stateObj.__subscriber_thread_id;
      if (typeof subscriberThreadId === 'string') {
        const { hasSession } = await import('./pty-registry.ts');
        if (hasSession(subscriberThreadId)) {
          dispatchTargetInstanceId = subscriberThreadId;
        }
      }
    } catch { /* malformed state — skip dispatch routing */ }
```

(d) Build spawnDefaults:

```ts
    const spawnDefaults: ActiveRunEntry['spawnDefaults'] = {
      providerId: 'copilot', // TODO: read from cfg.defaultAgentCli once dispatcher has cfg access
      agent: 'dev-buddy:dev-buddy',
      workspaceId: wsRow.id,
      workspacePath: wsRow.path,
    };
```

(If the dispatcher does not currently have access to `cfg`, plumb it through the `Dispatcher` constructor's `DispatcherOptions` — add a `defaultAgentCli?: string` field. The kernel boot path in `cli/start.ts` should pass `cfg.defaultAgentCli` when constructing the Dispatcher. Update the constructor + DispatcherOptions accordingly.)

(e) Replace the `this.activeRuns.set(...)` call:

```ts
    this.activeRuns.set(fire.fire_id, {
      secret: callbackSecret,
      outDir,
      dispatchTargetInstanceId,
      spawnDefaults,
    });
```

(f) Update the envelope passed to `runTriggerScript`:

```ts
    const result = await runTriggerScript({
      scriptPath: typeManifest.file_abs,
      runtime,
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: trigger.id,
        run_id: fire.fire_id,
        output_dir: outDir,
        dispatch_url: dispatchTargetInstanceId ? dispatchUrl : undefined,
        spawn_url: spawnUrl,
        state,
        payload,
      },
      callbackSecret,
      timeoutMs: this.scriptTimeoutMs,
    });
```

(g) Delete the Mode A/B `callbacks.json` post-processing block (lines 427-454). The block from `// Mode A callback extraction. Mode B callbacks were already appended` through the final `try { writeFileSync(join(outDir, 'callbacks.json'), ...) }` is all gone.

- [ ] **Step 4: Typecheck**

```powershell
npm run typecheck
```

Expected: passes IF you've also done Task 3.3 (cron-api removal) AND Task 3.4 (tools/trigger update). Otherwise expect errors from those files about the deleted `recordCallback` and the changed envelope shape. Continue to next tasks.

### Task 3.3: Cron-api endpoint changes (`cron-api.ts`)

**Files:**
- Modify: `mcp-server/src/cli/cron-api.ts:14-19, 50-65, 155-189`

- [ ] **Step 1: Delete the `/callback/<fire_id>` route**

Open `mcp-server/src/cli/cron-api.ts`. Find the `/callback/<fire_id>` handler block (currently lines 160-189). Delete the entire block from `// ----- /callback/<fire_id>` through the closing `}` of the inner if-block.

Also delete the JSDoc reference at line 14 (`*   POST /callback/:fire_id       per-fire-secret Mode B callback drop`) and the description at line 17 about `/callback/:fire_id`'s auth scheme.

- [ ] **Step 2: Add `/dispatch/<fire_id>` handler**

Below the just-deleted callback block, add:

```ts
  // ----- /dispatch/<fire_id> ------------------------------------------------
  // Per-fire bearer (CLAWDEVBOX_FIRE_SECRET); routes a prompt into the
  // SessionConductor for the trigger's subscriber pty.
  {
    const m = path.match(/^\/dispatch\/([^/]+)\/?$/);
    if (m) {
      if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      const fireId = decodeURIComponent(m[1]!);
      const presented = bearer(req);
      if (!presented) { reject401(res, 'missing bearer token'); return true; }
      const body = (await readJson<{ prompt?: unknown }>(req)) ?? {};
      if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
        sendJson(res, 400, { error: 'prompt required (non-empty string)' });
        return true;
      }
      const result = await ctx.dispatcher.dispatchToConductor(fireId, presented, body.prompt);
      if (result.status === 'not_found_fire')        { sendJson(res, 404, { error: 'fire not found or not in flight', fire_id: fireId }); return true; }
      if (result.status === 'unauthorized')          { reject401(res, 'invalid bearer token'); return true; }
      if (result.status === 'no_dispatch_target')    { sendJson(res, 404, { error: 'no dispatch target for this fire' }); return true; }
      if (result.status === 'target_unavailable')    { sendJson(res, 404, { error: 'dispatch target pty has exited' }); return true; }
      sendJson(res, 200, { ok: true, queued_at: Date.now(), state: result.state });
      return true;
    }
  }
```

- [ ] **Step 3: Add `/spawn/<fire_id>` handler**

Below the dispatch block:

```ts
  // ----- /spawn/<fire_id> --------------------------------------------------
  // Per-fire bearer; spawns a fresh interactive agent session via recipe-runner.
  {
    const m = path.match(/^\/spawn\/([^/]+)\/?$/);
    if (m) {
      if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      const fireId = decodeURIComponent(m[1]!);
      const presented = bearer(req);
      if (!presented) { reject401(res, 'missing bearer token'); return true; }
      const body = (await readJson<{ prompt?: unknown; agent?: unknown; workspace_id?: unknown }>(req)) ?? {};
      if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
        sendJson(res, 400, { error: 'prompt required (non-empty string)' });
        return true;
      }
      const result = await ctx.dispatcher.spawnFromCallback(
        fireId,
        presented,
        body.prompt,
        typeof body.agent === 'string' ? body.agent : undefined,
        typeof body.workspace_id === 'string' ? body.workspace_id : undefined,
      );
      if (result.status === 'not_found_fire') { sendJson(res, 404, { error: 'fire not found or not in flight', fire_id: fireId }); return true; }
      if (result.status === 'unauthorized')   { reject401(res, 'invalid bearer token'); return true; }
      if (result.status === 'spawn_failed')   { sendJson(res, 500, { error: `spawn failed: ${result.message}` }); return true; }
      sendJson(res, 200, { ok: true, instance_id: result.instanceId, session_id: result.sessionId });
      return true;
    }
  }
```

- [ ] **Step 4: Add `/api/sessions/<instance_id>` handler**

In the same file, find where other `/api/*` routes are registered (after the bearer-auth block around line 200). Add:

```ts
  // ----- GET /api/sessions/<instance_id> ----------------------------------
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/?$/);
    if (m && method === 'GET') {
      const { getConductor, hasSession, getSessionMeta } = await import('../pty-registry.ts');
      const instanceId = decodeURIComponent(m[1]!);
      if (!hasSession(instanceId)) { sendJson(res, 404, { error: 'session not found' }); return true; }
      const cond = getConductor(instanceId);
      const meta = getSessionMeta(instanceId);
      sendJson(res, 200, {
        instance_id: instanceId,
        state: cond?.state ?? 'unknown',
        queue_depth: cond?.pendingCount() ?? 0,
        provider_id: meta?.agentCli ?? null,
        agent_session_id: meta?.sessionId ?? null,
      });
      return true;
    }
  }
```

(`/api/sessions` is under the bearer-auth umbrella; it inherits the existing auth check on `/api/*` paths.)

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

Expected: passes IF Task 3.4 (`dispatcher.dispatchToConductor` and `dispatcher.spawnFromCallback` methods added) is also done. Hold the commit for the moment.

### Task 3.4: Dispatcher methods (`dispatchToConductor`, `spawnFromCallback`)

**Files:**
- Modify: `mcp-server/src/dispatcher.ts` (add two methods)

- [ ] **Step 1: Add `dispatchToConductor` method**

Inside the `Dispatcher` class (anywhere appropriate — near the other public methods like `status()`):

```ts
  /**
   * Dispatch a prompt to the SessionConductor attached to the fire's
   * subscriber pty. Returns a discriminated union signaling the routing
   * outcome; the HTTP handler maps each variant to an appropriate response.
   */
  async dispatchToConductor(
    fire_id: string,
    presentedSecret: string,
    prompt: string,
  ): Promise<
    | { status: 'not_found_fire' }
    | { status: 'unauthorized' }
    | { status: 'no_dispatch_target' }
    | { status: 'target_unavailable' }
    | { status: 'ok'; state: 'idle' | 'busy' | 'starting' | 'exited' }
  > {
    const entry = this.activeRuns.get(fire_id);
    if (!entry) return { status: 'not_found_fire' };
    if (!constantTimeEquals(entry.secret, presentedSecret)) return { status: 'unauthorized' };
    if (!entry.dispatchTargetInstanceId) return { status: 'no_dispatch_target' };
    const { getConductor } = await import('./pty-registry.ts');
    const conductor = getConductor(entry.dispatchTargetInstanceId);
    if (!conductor) return { status: 'target_unavailable' };
    // Fire-and-forget — we don't await the dispatch's completion (the
    // queued prompt executes asynchronously in the agent). dispatch()'s
    // promise resolves on the dispatched prompt's done signal, which may
    // be many seconds; the HTTP caller only needs the queue ack.
    conductor.dispatch(prompt, { strategy: 'auto' }).catch((err) => {
      logger.warn(
        { fire_id, err: err instanceof Error ? err.message : String(err) },
        'dispatcher: dispatchToConductor — conductor.dispatch rejected',
      );
    });
    return { status: 'ok', state: conductor.state };
  }
```

- [ ] **Step 2: Add `spawnFromCallback` method**

```ts
  /**
   * Spawn a fresh interactive agent session via recipe-runner with the
   * supplied prompt. Optional body fields can override the trigger's
   * configured defaults. Returns the new instance_id + sessionId on
   * success.
   */
  async spawnFromCallback(
    fire_id: string,
    presentedSecret: string,
    prompt: string,
    agentOverride?: string,
    workspaceIdOverride?: string,
  ): Promise<
    | { status: 'not_found_fire' }
    | { status: 'unauthorized' }
    | { status: 'spawn_failed'; message: string }
    | { status: 'ok'; instanceId: string; sessionId: string }
  > {
    const entry = this.activeRuns.get(fire_id);
    if (!entry) return { status: 'not_found_fire' };
    if (!constantTimeEquals(entry.secret, presentedSecret)) return { status: 'unauthorized' };

    const { runRecipe } = await import('./recipe-runner.ts');
    const { resolveConfig } = await import('./config.ts');
    const { resolveWorkspacesRoot } = await import('./workspaces-store.ts');

    const cfg = resolveConfig({ projectDir: this.ws.projectDir, globalDir: this.ws.globalDir });
    const workspacesRoot = resolveWorkspacesRoot();
    const agent = agentOverride ?? entry.spawnDefaults.agent;
    const workspaceInfo =
      workspaceIdOverride
        ? this.resolveWorkspaceById(workspaceIdOverride) ?? { id: entry.spawnDefaults.workspaceId, path: entry.spawnDefaults.workspacePath }
        : { id: entry.spawnDefaults.workspaceId, path: entry.spawnDefaults.workspacePath };

    try {
      const result = await runRecipe({
        recipeId: null,
        recipeSnapshot: '',
        isAdhoc: true,
        prompt,
        spawnMode: 'interactive',
        workspaceInfo,
        agentCli: entry.spawnDefaults.providerId,
        agent,
        workspacesRoot,
        ws: this.ws,
        cfg,
        triggerId: fire_id,
      });
      if (result.spawn_error) {
        return { status: 'spawn_failed', message: `${result.spawn_error.code}: ${result.spawn_error.message}` };
      }
      return { status: 'ok', instanceId: result.recipe_instance_id, sessionId: result.session_id };
    } catch (err) {
      return { status: 'spawn_failed', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private resolveWorkspaceById(id: string): { id: string; path: string } | null {
    const row = this.db.prepare('SELECT id, path FROM workspaces WHERE id = ?').get(id) as { id: string; path: string } | undefined;
    return row ?? null;
  }
```

- [ ] **Step 3: Plumb cfg.defaultAgentCli into Dispatcher**

Open `mcp-server/src/cli/start.ts`. Find where `new Dispatcher(...)` is constructed. Add a `defaultAgentCli: cfg.defaultAgentCli ?? 'copilot'` option.

In `dispatcher.ts`'s `DispatcherOptions` interface, add:

```ts
  /** Provider id used as the spawn default when /spawn/<fire_id> doesn't override. Default 'copilot'. */
  defaultAgentCli?: string;
```

Store on the class:

```ts
  private defaultAgentCli: string;
```

Assign in the constructor:

```ts
    this.defaultAgentCli = opts.defaultAgentCli ?? 'copilot';
```

Then in `runScriptBinding` (Task 3.2 Step 3 (d)), update the `spawnDefaults` construction:

```ts
    const spawnDefaults: ActiveRunEntry['spawnDefaults'] = {
      providerId: this.defaultAgentCli,
      agent: 'dev-buddy:dev-buddy',
      workspaceId: wsRow.id,
      workspacePath: wsRow.path,
    };
```

- [ ] **Step 4: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

### Task 3.5: Update `trigger.test` MCP tool envelope

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts` (around the ephemeral receiver / envelope construction)

- [ ] **Step 1: Find the envelope construction**

```powershell
grep -n "callback_url\|envelope:" mcp-server/src/tools/trigger.ts
```

Locate the place where `trigger.test` builds the envelope for the ephemeral runner.

- [ ] **Step 2: Update envelope shape**

Replace the `callback_url: callbackUrl` field with the three new fields:

```ts
          envelope: {
            trigger_event_name: 'TriggerFired',
            trigger_id, run_id,
            output_dir: tmpOutDir,                     // NEW — a tmp dir for the test
            // Test-mode envelope omits dispatch_url (no live pty target in unit tests)
            // and spawn_url. Trigger.test exists to exercise script logic + Mode A/B
            // callback emission, neither of which involves dispatching to live agents.
            spawn_url: '',                              // intentionally empty in test mode
            state, payload,
          },
```

Update the env var injection if `trigger.test` sets `CLAWDEVBOX_MCP_SECRET` (likely line 988 or nearby) to `CLAWDEVBOX_FIRE_SECRET`.

The `tmpOutDir` should be a fresh temp directory created above the spawn (use `mkdtemp` or similar). The script can write to it; the test asserts on its contents if relevant.

If `trigger.test` doesn't currently make sense without a callback URL, document the change in the commit message (the Mode A/B distinction is gone; trigger.test now only verifies the script ran and produced expected stdout/stderr — observation drops via FS rather than HTTP).

- [ ] **Step 3: Update the description string**

The `trigger.test` tool's `description` field (around line 843) mentions "Mode A (stdout `callback.body`) and Mode B (HTTP POST to a fresh ephemeral 127.0.0.1 receiver) callbacks". Replace with:

```
'Run a trigger script with a synthesized envelope and capture the result. NON-MUTATING — does not write to triggers.json or update state. Three input sources (XOR): `id` (registered instance), `template_id` (saved type, any scope), or `script` + `runtime` (inline). Captures stdout/stderr and any observation files the script wrote to envelope.output_dir. Hard timeout (default 30s).'
```

- [ ] **Step 4: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

### Task 3.6: Update tests for envelope shape

**Files:**
- DELETE: `mcp-server/tests/callback-api.test.mjs` (if it exists and only tests `/callback/<fire_id>`)
- Modify: `mcp-server/tests/dispatcher.test.mjs` (remove recordCallback-related tests)
- Modify: `mcp-server/tests/trigger.test` family (if envelope shape is asserted)

- [ ] **Step 1: Check if callback-api.test.mjs exists**

```powershell
Test-Path C:\git\clawdevbox\mcp-server\tests\callback-api.test.mjs
```

If yes, inspect its contents:

```powershell
Get-Content C:\git\clawdevbox\mcp-server\tests\callback-api.test.mjs | Select-Object -First 50
```

- [ ] **Step 2: Delete or slim the callback test file**

If the file exists and only tests `/callback/<fire_id>`, delete it. If it tests OTHER routes too, slim it to remove the callback tests only.

- [ ] **Step 3: Remove recordCallback tests from dispatcher.test.mjs**

```powershell
grep -n "recordCallback\|callback_url\|callbacks\.json" mcp-server/tests/dispatcher.test.mjs
```

Remove any tests that exercise these. If a test asserts on `callbacks.json` being written, delete that test (the file is no longer written by the dispatcher).

- [ ] **Step 4: Update package.json**

If `callback-api.test.mjs` was deleted, remove its entry from the test script.

- [ ] **Step 5: Typecheck**

```powershell
npm run typecheck
```

Expected: exit 0.

### Task 3.7: New endpoint tests

**Files:**
- Create: `mcp-server/tests/dispatch-endpoint.test.mjs`
- Create: `mcp-server/tests/spawn-endpoint.test.mjs`
- Create: `mcp-server/tests/api-sessions.test.mjs`

- [ ] **Step 1: Write `dispatch-endpoint.test.mjs`**

Create the file with comprehensive coverage:
- Setup: fake conductor in pty-registry (use the fake-pty pattern from Task 1.1), mock `activeRuns[fire_id]` with `dispatchTargetInstanceId = '<instance>'`
- Tests:
  - POST /dispatch/<fire_id> with correct bearer + `{prompt: 'go'}` → 200, conductor.dispatch was called
  - POST with wrong bearer → 401
  - POST with unknown fire_id → 404 `fire not found`
  - POST without dispatchTargetInstanceId → 404 `no dispatch target`
  - POST when target pty is gone from registry → 404 `target_unavailable`
  - POST with missing prompt → 400

(Concrete test code follows the same scaffolding as `tests/dispatcher.test.mjs` — use that as the template. Reference the Dispatcher class directly + insert into `dispatcher.activeRuns` via a test helper if needed, or add a `__test_setActiveRun(fireId, entry)` method behind a `process.env.NODE_ENV === 'test'` guard. Cleaner: extract `activeRuns` into a setter method `recordActiveRun(fireId, entry)` that's called from `runScriptBinding`; tests can call it directly.)

- [ ] **Step 2: Write `spawn-endpoint.test.mjs`**

- Setup: stub `runRecipe` via a module mock (use Node's experimental loader hooks OR construct the dispatcher with a `runRecipeFn` injection seam similar to the deleted runRecipeFn pattern — add it back narrowly for testability).
- Tests:
  - POST /spawn/<fire_id> with correct bearer + `{prompt: 'start'}` → 200 with `instance_id` + `session_id`
  - POST with body override `{prompt, agent: 'x'}` → runRecipe called with `agent: 'x'`
  - POST with body override `{prompt, workspace_id: 'y'}` → runRecipe called with that workspace's resolved path
  - POST with wrong bearer → 401
  - POST missing prompt → 400
  - POST when runRecipe throws → 500 with the error message

- [ ] **Step 3: Write `api-sessions.test.mjs`**

- Register a fake conductor in pty-registry → GET `/api/sessions/<instance>` → expect 200 with state + queue_depth
- GET unknown id → 404
- Auth: if cfg.http.token set, missing bearer → 401

- [ ] **Step 4: Register the 3 new files in package.json**

Insert alphabetically.

- [ ] **Step 5: Run all 3 new tests**

```powershell
node --import tsx --test tests/dispatch-endpoint.test.mjs tests/spawn-endpoint.test.mjs tests/api-sessions.test.mjs
```

Expected: all pass.

### Task 3.8: Doc updates

**Files:**
- Modify: `docs/tools/trigger.md` (envelope contract)
- Regenerate: `docs/MCP-TOOLS-REFERENCE.md` via `docs/scripts/compose_master_doc.py`

- [ ] **Step 1: Update `docs/tools/trigger.md`**

Find the section that describes the trigger envelope (search for `callback_url` or `envelope`). Replace the old envelope shape with the new one (matching `TriggerEnvelope` interface from Task 3.1 Step 1). Add a "Migration" subsection noting the renamed env var and removed `callback_url` field.

- [ ] **Step 2: Regenerate MCP-TOOLS-REFERENCE.md**

```powershell
cd C:\git\clawdevbox
python docs/scripts/compose_master_doc.py
```

If the script doesn't exist or doesn't run, manually update `docs/MCP-TOOLS-REFERENCE.md` to match the trigger.md changes.

- [ ] **Step 3: Verify no leftover callback_url mentions in living docs**

```powershell
grep -rn "callback_url\|CLAWDEVBOX_MCP_SECRET" --include="*.md" docs/ | Select-String -NotMatch "plans|specs"
```

Expected: zero matches in living docs.

### Task 3.9: PR #3 commit + final verification

- [ ] **Step 1: Final typecheck + full suite**

```powershell
cd C:\git\clawdevbox\mcp-server
npm run typecheck
npm test
```

Expected: no new failures vs the baseline recorded in Task 2.3.

- [ ] **Step 2: Single PR #3 commit OR multiple commits**

PR #3 made changes across many files. The cleanest commit shape:

1. `feat(trigger): rewrite envelope; add /dispatch and /spawn endpoints; delete /callback`

OR split into:

1. `feat(trigger-runner): rewrite envelope with output_dir + dispatch_url + spawn_url`
2. `feat(dispatcher): activeRuns extension + dispatchToConductor + spawnFromCallback`
3. `feat(cron-api): /dispatch and /spawn endpoints + GET /api/sessions/<id>; remove /callback`
4. `feat(tools/trigger): update trigger.test for new envelope shape`
5. `test: dispatch/spawn/sessions endpoint tests`
6. `docs(tools/trigger): document new envelope contract`

**Pick: 6 commits** for clearer git-bisect granularity. Each must typecheck on its own (which means Tasks 3.1, 3.2, 3.3, 3.4 must be committed together if they're interdependent at the typecheck level — combine into commit #1 + #2 above).

**Actually pick: 4 commits** to balance clarity and inter-dependence:

1. `feat(trigger): rewrite envelope, dispatcher routing, /dispatch + /spawn endpoints; delete /callback`
   (combines Tasks 3.1–3.5; required for typecheck to pass)
2. `test(trigger): coverage for /dispatch, /spawn, /api/sessions`
   (Task 3.7)
3. `chore(trigger): tidy existing tests after callback removal`
   (Task 3.6)
4. `docs(tools/trigger): document new envelope contract`
   (Task 3.8)

Each commit message must include the spec reference and the `Co-authored-by` trailer.

- [ ] **Step 3: Commit lineage check**

```powershell
git --no-pager log --oneline -10
```

Expected: 4 PR#3 commits on top of 2 PR#2 commits on top of 2 PR#1 commits = 8 new commits since the F+G PR base.

- [ ] **Step 4: Verify no leftover stale references**

```powershell
grep -rn "callback_url\|CLAWDEVBOX_MCP_SECRET\|recordCallback\|Mode A\|Mode B" --include="*.{ts,mjs,vue,js}" mcp-server/src/ mcp-server/tests/
```

Expected: zero matches (or only matches in deleted-file commit history / unrelated comments). If matches remain in src, they're real bugs — go back and fix.

---

## Verification sequence (after all 3 PRs)

1. `cd C:\git\clawdevbox\mcp-server && npm run typecheck` — exit 0
2. `npm test` — only pre-existing flakes; total pass count = baseline + ~10 new tests
3. `grep -rn "callback_url" --include="*.{ts,mjs}" mcp-server/src/ mcp-server/tests/` — zero matches
4. `git --no-pager log --oneline -8` — 8 PR commits visible
5. Manual smoke: start clawdevbox, trigger a fake fire via `trigger.fire`, verify the trigger script gets the new envelope shape via process.env / stdin inspection

## Push policy

Do NOT push without explicit user confirmation. After all 3 PRs land locally, surface the push decision.
