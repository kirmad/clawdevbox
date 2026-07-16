# Trigger → Live Agent Dispatch — Design

**Date:** 2026-05-29
**Author:** session 817a3d5e (paired with devuser)
**Status:** Approved, ready for implementation plan
**Predecessor:** `docs/superpowers/specs/2026-05-28-callback-binding-cleanup-design.md` (F+G PR that cleared the way for this)

## Goal

Wire the existing **L1 provider capabilities** + **L2 SessionConductor** (both landed in earlier PRs) into the trigger → agent flow. After this design lands, the user-visible behavior is:

> A trigger fires → trigger script runs → script POSTs a prompt to either an **existing** live agent (queued + coalesced) or a **freshly spawned** agent. The kernel routes the prompt via SessionConductor; no recipe-binding shortcut required.

This is the payoff for the `binds_callback_to_*` cleanup in the predecessor PR.

## Non-goals

- **UI surface for conductor state.** This PR exposes `GET /api/sessions/<id>` only; visual treatment lands later.
- **Pre-bound dispatch URLs for non-fire callers.** The SPA "send prompt to agent" feature reaches SessionConductor in-process via a direct API; this PR is HTTP-callback-driven (for trigger scripts).
- **Auto-resume of spawned sessions on restart.** Per Q5 of brainstorming, spawned sessions live in `agent_sessions` (audit history) but do NOT auto-resume after `clawdevbox restart`. The user must re-spawn.
- **Multi-pty fan-out.** Current model is 1 dispatch → 1 pty. Fan-out is a separate future design.
- **Auth model for non-trigger callers.** This PR uses the per-fire bearer that already exists; broader API auth is unchanged.

## Why now

After the F PR landed:
- Dispatcher has exactly one binding mode: script binding
- SessionConductor exists, fully tested (12/12), and is **completely unused**
- The four ado/* trigger scripts that used to bind to recipes are deleted; no in-tree consumer exists yet

This PR plugs the conductor in and gives trigger scripts a way to actually wake agents.

## Architecture — three PRs

Each PR is independently shippable and reviewable. Each is a strict subset of the full feature:

```
PR #1 (B+E)  — pty-registry stores SessionConductor;
                main-agent migrates to construct one.
                No HTTP changes, no behavior change.

PR #2 (D)    — recipe-runner gains spawnMode: 'interactive'.
                When interactive, registers conductor in pty-registry.
                No caller wired; opt-in via recipe.run MCP tool flag.

PR #3 (C)    — Trigger envelope drops callback_url, adds
                output_dir + dispatch_url + spawn_url.
                /callback/<fire_id> route DELETED.
                New POST /dispatch/<fire_id> and POST /spawn/<fire_id>.
                New GET /api/sessions/<id> for state inspection.
                CLAWDEVBOX_MCP_SECRET env var renamed to
                CLAWDEVBOX_FIRE_SECRET.
                This is the user-visible payoff.
```

The PRs are sequential — each depends on the prior.

## End-state data flow

```
1. cron timer or webhook fires → enqueueFire → dispatcher.runFire
2. dispatcher.runScriptBinding:
   - mints per-fire secret (existing)
   - registers activeRuns[fire_id] = {
       secret,                              // bearer for all per-fire URLs
       outDir,                              // <ws>/.clawdevbox/fires/<id>/attempt-N/
       dispatchTargetInstanceId?: <set if trigger has subscriber_thread_id
                                  AND that thread's pty is live in pty-registry>,
       spawnDefaults: { providerId, agent, workspaceId, workspacePath }
     }
   - spawns trigger script with envelope:
       { trigger_event_name, trigger_id, run_id, output_dir,
         dispatch_url?, spawn_url, state, payload }
   - injects CLAWDEVBOX_FIRE_SECRET=<secret> into script env
3. Script does its work, decides what to do:
   - Write audit observations directly to output_dir/*.json   (FS, no HTTP)
   - POST {prompt} to dispatch_url                            (existing pty)
   - POST {prompt} to spawn_url                               (fresh agent)
4. dispatcher.runFire returns; activeRuns[fire_id] entry cleaned up
   on script exit (NOT on HTTP callback completion — the queued prompts
   execute asynchronously in the agent).
5. Conductor handles queue + coalesce internally on the receiving pty.
```

## Components — PR #1 (B+E)

### 1.1 `pty-registry.ts` — conductor lifecycle

`PtyRegisterOptions` gains:

```ts
export interface PtyRegisterOptions {
  instanceId: string;
  workspaceId: string;
  cols: number;
  rows: number;
  ipty: IPty;
  meta?: PtySessionMeta;
  /**
   * Provider that spawned this pty. Required for the registry to build a
   * SessionConductor. When omitted (e.g. legacy callers, playwright fixture),
   * the session has no conductor and getConductor(instanceId) returns null.
   */
  provider?: AgentCliProvider;
  /**
   * Agent handle that wraps `ipty`. Required iff `provider` is provided —
   * the conductor needs handle.exited to track the exited state transition.
   */
  agentHandle?: AgentHandle;
}
```

New module-level export:

```ts
export function getConductor(instanceId: string): SessionConductor | null;
```

When both `provider` and `agentHandle` are supplied, the registry constructs `createSessionConductor(provider, agentHandle, {...})` and stores it on the session record. The conductor's lifecycle binds to the pty: when `handle.exited` resolves, the conductor moves to `exited` automatically (already wired in session-conductor.ts).

Existing `writePty(instanceId, data)`, `resizePty(instanceId, cols, rows)`, `killPty(instanceId)` are **unchanged** — they bypass the conductor and write raw bytes. This is intentional: the terminal viewer's keystroke forwarding (Ctrl+C, arrow keys, etc.) must NOT go through the conductor's queue.

### 1.2 `main-agent.ts` — pass provider to registerPty

The `startMainAgent` flow already has the resolved `provider` (line 114). After spawning and obtaining the `handle`, pass both into `registerPty`:

```ts
registerPty({
  instanceId: MAIN_AGENT_INSTANCE_ID,
  workspaceId: 'project',
  cols: 120,
  rows: 30,
  ipty: handle.pty,
  provider,           // NEW
  agentHandle: handle, // NEW
});
```

`getMainAgentStatus()` projection unchanged — the conductor state is not surfaced in MainAgentStatus yet (that's PR #3 via `GET /api/sessions/main`).

### 1.3 Tests

- `tests/pty-registry.test.mjs` (extend or create): "registerPty with provider+handle builds a conductor; getConductor returns it; conductor moves to exited when pty exits"
- `tests/main-agent.test.mjs` (existing if present; otherwise extend a smoke test): "main agent registers a conductor in pty-registry"
- Targeted only; no full-suite changes

## Components — PR #2 (D)

### 2.1 `recipe-runner.ts` — spawnMode option AND ad-hoc support

Add to `RunRecipeOptions`:

```ts
export interface RunRecipeOptions {
  // ...existing...
  /**
   * 'headless' (default) preserves current behavior — provider spawns with
   * --print/-p, agent exits on completion. 'interactive' keeps the pty
   * alive after the first turn; opts.prompt becomes the seed prompt
   * delivered via deliverInitialPromptWhenReady (already in the provider).
   */
  spawnMode?: 'interactive' | 'headless';
}
```

Today `runRecipe` requires a `recipeId`. PR #3 will use `runRecipe` for ad-hoc no-recipe spawns (the `/spawn/<fire_id>` handler). **PR #2 makes `recipeId` optional**:

```ts
export interface RunRecipeOptions {
  // ...existing fields...
  /** When null, no recipe is loaded — the agent starts with just opts.prompt as the seed message. */
  recipeId: string | null;
  /** When true AND recipeId is null, signals an ad-hoc interactive session. */
  isAdhoc?: boolean;
}
```

When `recipeId === null && isAdhoc === true`, runRecipe:
- Skips recipe yaml resolution
- Skips recipe_instance row creation (`recipe_instance_id` becomes a synthetic `ri_adhoc_<rand>` so downstream code that wants an instance id has one)
- Still creates an `agent_sessions` row with `recipe_instance_id = ri_adhoc_<rand>`, `interactive = 1`, no `recipe_id`

PR #2 implements both spawnMode AND ad-hoc support to keep recipe-runner's surface coherent. PR #3 consumes them.

In `runRecipe()`, the existing `provider.spawnSession({ mode: 'headless', ... })` call branches on `spawnMode`:

```ts
const mode: SessionMode = opts.spawnMode === 'interactive' ? 'interactive' : 'headless';
const handle = await provider.spawnSession(providerCtx, {
  mode,
  // ...rest unchanged...
});

registerPty({
  // ...existing...
  provider: mode === 'interactive' ? provider : undefined,
  agentHandle: mode === 'interactive' ? handle : undefined,
});
```

The headless path passes neither (no conductor needed — agent exits on its own). The interactive path passes both.

### 2.2 `recipe.run` MCP tool

Add an optional `spawn_mode` parameter to the zod schema (default headless). Pass through to `runRecipe`.

### 2.3 `agent_sessions` row marking

The existing recipe-runner already creates an `agent_sessions` row for headless runs. When `spawnMode === 'interactive'`, set the `interactive` column to `1`. The column already exists in the schema (`mcp-server/src/db/migrations.ts` line 124).

### 2.4 Tests

- `tests/recipe-runner-interactive.test.mjs` (new): with a mock provider returning a fake pty, assert (a) conductor is registered, (b) agent_sessions.interactive = 1, (c) returns immediately after spawn (not after first idle)
- Update any existing `recipe-runner.test.mjs` tests that assert `mode === 'headless'` to either be neutral (don't assert mode) or to assert headless explicitly for the default-arg case

## Components — PR #3 (C)

### 3.1 Trigger envelope (`trigger-runner.ts`)

`TriggerEnvelope.callback_url` is **removed**. Replace with:

```ts
export interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  /**
   * Absolute path to <ws>/.clawdevbox/fires/<fire_id>/attempt-<N>/. The
   * dispatcher creates this directory before spawning the script. Scripts
   * may write audit / observation files (observations.json, debug.log, etc.)
   * here directly via filesystem — no HTTP roundtrip needed.
   */
  output_dir: string;
  /**
   * URL the script POSTs to dispatch a {prompt} to the agent attached to
   * THIS trigger's subscriber_thread_id. Present only when:
   *   (a) the trigger's registration has a subscriber_thread_id set, AND
   *   (b) that thread's pty is live in pty-registry at script spawn time.
   * Absent otherwise; scripts that find dispatch_url undefined must use
   * spawn_url (or do nothing).
   */
  dispatch_url?: string;
  /**
   * URL the script POSTs to spawn a fresh interactive agent. Always present.
   * Body: { prompt: string, agent?: string, workspace_id?: string }.
   * Returns the new instance_id + sessionId.
   */
  spawn_url: string;
  state: Record<string, unknown>;
  payload: unknown;
}
```

### 3.2 Dispatcher routing (`dispatcher.ts`)

`activeRuns[fire_id]` interface changes:

```ts
interface ActiveRunEntry {
  secret: string;                      // bearer for /dispatch and /spawn
  outDir: string;
  dispatchTargetInstanceId?: string;   // resolved at script spawn time
  spawnDefaults: {
    providerId: string;
    agent?: string;
    workspaceId: string;
    workspacePath: string;
  };
}
```

`recordCallback()` method is **deleted**. Its caller (`/callback/<fire_id>` route) is also deleted (see 3.3).

`runScriptBinding` no longer:
- mints `callbackUrl`
- reads `attempt-N/callbacks.json` after the script exits
- parses script stdout for `{callback: {body: ...}}` (Mode A)

`runScriptBinding` still:
- writes `stdout.txt` and `stderr.txt` to `outDir`
- enforces script timeout
- returns `{exit_code}`

The per-fire bearer is passed to the script as `CLAWDEVBOX_FIRE_SECRET` (was `CLAWDEVBOX_MCP_SECRET`).

When the dispatcher constructs `spawnDefaults`, it uses:
- `providerId = cfg.defaultAgentCli ?? 'copilot'`
- `agent = 'dev-buddy:dev-buddy'` (matches main-agent default)
- `workspaceId = trigger.workspace_id`
- `workspacePath = lookup workspaces.path WHERE id = workspace_id`

These can be overridden by the script's `/spawn` POST body (see 3.3).

### 3.3 HTTP endpoints (`cron-api.ts`)

**Removed:**
```
POST /callback/<fire_id>            ← DELETED
```

**Added:**

```
POST /dispatch/<fire_id>
  Auth: Authorization: Bearer <CLAWDEVBOX_FIRE_SECRET>
  Body: { prompt: string }
  Response 200: { ok: true, queued_at: <epoch_ms>, state: 'idle'|'busy' }
  Response 404: { error: 'fire not found or not in flight' }
  Response 404: { error: 'no dispatch target' }       — trigger has no subscriber pty
  Response 401: { error: 'invalid bearer token' }
```

Handler:
1. Look up `activeRuns[fire_id]`. If absent → 404.
2. Validate bearer. If mismatch → 401.
3. If `dispatchTargetInstanceId` is absent → 404 `no dispatch target`.
4. `getConductor(dispatchTargetInstanceId)` → if null → 404 `no dispatch target` (pty died after script spawn).
5. `conductor.dispatch({ text: body.prompt, roleHint: 'trigger' })` — fire and forget; returns the conductor's current state. (`SessionConductor.dispatch` is already async-returning; we await it briefly to capture queue-vs-immediate status.)
6. 200 with the conductor's `state` (`'idle'` if it ran immediately, `'busy'` if queued).

```
POST /spawn/<fire_id>
  Auth: Authorization: Bearer <CLAWDEVBOX_FIRE_SECRET>
  Body: { prompt: string, agent?: string, workspace_id?: string }
  Response 200: { ok: true, instance_id: <ri_xxx>, session_id: <sess_xxx> }
  Response 404: { error: 'fire not found or not in flight' }
  Response 401: { error: 'invalid bearer token' }
  Response 400: { error: 'prompt required' }
  Response 500: { error: 'spawn failed: <reason>' }
```

Handler:
1. Look up `activeRuns[fire_id]`. If absent → 404.
2. Validate bearer. If mismatch → 401.
3. Validate body has `prompt: string`. If not → 400.
4. Merge `spawnDefaults` + body overrides → resolve target provider, agent, workspace.
5. Call `recipe-runner.runRecipe({ spawnMode: 'interactive', prompt: body.prompt, recipeId: null, isAdhoc: true, ... })` — same machinery the `recipe.run` MCP tool uses, but with no recipe (just an interactive session with a seed prompt).
6. Return `{instance_id, session_id}` from the runRecipe result.

The ad-hoc-no-recipe path is **new**. `runRecipe` today requires a recipe. We extend it to accept `recipeId: null` + `isAdhoc: true` to mean "spawn an interactive session with the prompt as the first user message, no recipe loaded."

### 3.4 `GET /api/sessions/<instance_id>`

```
GET /api/sessions/<instance_id>
  Auth: existing /api/* bearer (cfg.http.token), or loopback-only if no token
  Response 200: {
    instance_id,
    state: 'starting'|'idle'|'busy'|'exited',
    queue_depth: number,
    last_dispatch_at?: <epoch_ms>,
    exit_code?: number,
    provider_id?: string,
    agent_session_id?: string
  }
  Response 404: { error: 'session not found' }
```

Handler reads from pty-registry + conductor; no DB writes.

### 3.5 Env var rename

Dispatcher injects `CLAWDEVBOX_FIRE_SECRET` (not `_MCP_SECRET`) into the trigger script env. The `trigger.test` MCP tool's ephemeral receiver also expects this new name. Update both call sites + any helper documentation.

The `cfg.http.token` (server bearer) is unrelated and keeps its current env name (`CLAWDEVBOX_HTTP_TOKEN`).

### 3.6 Tests

- `tests/callback-api.test.mjs` — DELETE (the route it tests is removed). If the file also tests other routes, slim down rather than delete.
- `tests/dispatcher.test.mjs` — remove any test asserting `recordCallback` behavior or `callback_url` envelope field
- `tests/dispatch-endpoint.test.mjs` (new):
  - Mock provider + fake pty + registered conductor in pty-registry
  - Mock `activeRuns[fire_id]` with `dispatchTargetInstanceId`
  - POST `/dispatch/<fire_id>` with `{prompt: 'go'}` + correct bearer
  - Assert: conductor.dispatch was called with the prompt; 200 + state returned
  - Negative tests: wrong bearer → 401; unknown fire_id → 404; missing dispatch target → 404
- `tests/spawn-endpoint.test.mjs` (new):
  - Mock provider + fake recipe-runner that returns `{instance_id, session_id}`
  - POST `/spawn/<fire_id>` with `{prompt: 'start fresh'}`
  - Assert: runRecipe called with `spawnMode: 'interactive'`; 200 + instance_id returned
  - Body overrides: `{prompt, agent: 'x', workspace_id: 'y'}` overrides spawnDefaults
  - Negative: wrong bearer → 401, no prompt → 400, runRecipe throws → 500
- `tests/api-sessions.test.mjs` (new):
  - Register a fake conductor in pty-registry → GET → expect state projection
- `tests/trigger-templates.test.mjs` / `tests/trigger.test` (if they ref envelope) — update for new envelope shape
- `tests/api-test-hooks.test.mjs` (pre-existing flake) — verify if envelope change breaks it; adjust the marker script if it referenced `callback_url`

### 3.7 Migration / compat notes

**Breaking changes for trigger authors:**
- `callback_url` is removed from the envelope. Scripts that POST to it will get 404.
- The `Mode A`/`Mode B` distinction is gone. Scripts emitting `{callback: {body: ...}}` on stdout will have that ignored (and the stdout still gets captured to `stdout.txt`).
- `CLAWDEVBOX_MCP_SECRET` env var is renamed to `CLAWDEVBOX_FIRE_SECRET`.

**Blast radius today:** Zero in-tree trigger scripts use `callback_url` (the F PR deleted all four ado/* scripts). Third-party trigger scripts are non-existent — clawdevbox isn't shipped as a plugin platform yet.

**Documentation updates:** `docs/tools/trigger.md` and `docs/MCP-TOOLS-REFERENCE.md` need new envelope contract.

## Cross-cutting concerns

### Error handling

| Scenario | Behavior |
|---|---|
| Script POSTs to `/dispatch` but pty died between spawn-time check and POST | 404 `no dispatch target`. Script can fall back to `/spawn`. |
| Script POSTs to `/spawn` but agent CLI binary is missing | 500 `spawn failed: <provider-specific reason>`. Same error path as `recipe.run` failures today. |
| Script POSTs to `/dispatch` AND `/spawn` for the same prompt | Both succeed independently. Two prompts hit two agents. Caller's responsibility to avoid duplication. |
| Script POSTs after script process exited | 404 `fire not found`. `activeRuns[fire_id]` is cleaned in the dispatcher's `finally` block. |
| Conductor's queue grows unbounded (script POSTs in a tight loop) | The SessionConductor coalesces all queued prompts into one delivery on next idle. Bounded by memory. No per-fire rate limit at the HTTP layer in v1. |
| Spawned session's pty exits before any dispatch | Standard pty-registry exit retention applies (10s scrollback). Subsequent `/dispatch` to it → 404. |

### Concurrency

- `activeRuns` is a `Map<fire_id, ActiveRunEntry>`. Dispatcher only writes during `runScriptBinding`. HTTP handlers only read. No locks needed (single Node event loop).
- Conductor's queue is single-threaded by construction (SessionConductor uses async/await; no shared state across awaits that isn't serialized through the conductor itself).
- The `/dispatch` endpoint awaits `conductor.dispatch(...)` to capture the immediate-vs-queued status. This is bounded — `dispatch()` returns within one event-loop tick (it either writes to the pty or enqueues). No HTTP timeout concerns.

### Security

- Per-fire bearer (`CLAWDEVBOX_FIRE_SECRET`) is 32 hex chars (16 random bytes). Constant-time compare against the presented bearer.
- The URLs `/dispatch/<fire_id>` and `/spawn/<fire_id>` use the same fire_id as `/callback` used to — predictable (fire IDs are not secret). The bearer is what gates access.
- `GET /api/sessions/<id>` uses the server-wide bearer (`cfg.http.token`), same as other `/api/*` routes.
- No new attack surface beyond what existed for `/callback`.

## Testing strategy

| Phase | Command | Pass criteria |
|---|---|---|
| Per-file dev loop | `npm run typecheck` | clean |
| Per-file dev loop | `node --import tsx --test tests/<file>.test.mjs` | targeted passes |
| Before PR #1 commit | `node --import tsx --test tests/pty-registry.test.mjs tests/main-agent.test.mjs tests/agent-clis-capabilities.test.mjs tests/session-conductor.test.mjs` | all touched tests pass |
| Before PR #2 commit | Above + `tests/recipe-runner-interactive.test.mjs` | all pass; existing recipe-runner tests not regressed |
| Before PR #3 commit | Above + `tests/dispatch-endpoint.test.mjs tests/spawn-endpoint.test.mjs tests/api-sessions.test.mjs tests/dispatcher.test.mjs tests/trigger.test (if applicable)` | all pass |
| After each PR | `npm test` (full suite) | no NEW failures vs baseline (484/3 after F+G) |

## Out-of-scope follow-ups

- UI panel showing conductor state per pty (header strip in terminal viewer, queue depth indicator). Wait until users ask.
- Pre-bound dispatch URLs for SPA "send prompt" feature. Direct in-process conductor calls suffice.
- Resume of spawned sessions on `clawdevbox restart`. Users re-spawn.
- Multi-pty fan-out (one dispatch → multiple agents). Future design.
- Rate-limiting / backpressure on `/dispatch` and `/spawn`. Per-fire bearer is implicit auth; rate limit if abuse appears.
- `subscriber_thread_id` lifecycle cleanup. Hot triggers whose subscriber pty exited should be flagged in the UI; today they silently lose `dispatch_url` availability.

## Open questions (none blocking, but worth tracking)

- Should `/dispatch` and `/spawn` echo the `fire_id` in the response body for audit? (Tiny ergonomic; cost is one field.)
- Should `output_dir` be a relative or absolute path in the envelope? Absolute matches the existing `run_id` pattern; relative makes scripts portable across hosts but trigger scripts run on the same host as the kernel anyway. **Picking absolute** for consistency.
- Should we add a `runtime_metrics` field to `GET /api/sessions/<id>` (last turn duration, total turns)? Out of scope for now.
