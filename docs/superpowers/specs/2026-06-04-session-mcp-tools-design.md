# Session MCP Tools — Design

**Date:** 2026-06-04
**Author:** session 630f7d56 (paired with devuser)
**Status:** Ready for implementation plan

## Goal

Expose clawdevbox's existing in-process spawn / dispatch / read / kill HTTP endpoints as MCP tools in a new `session.*` namespace, so the main agent (and any plugin agent with workspace access) can:

1. **Spawn a fresh agent CLI session** in any registered workspace.
2. **Read its terminal scrollback** incrementally.
3. **Send follow-up prompts** to a session that's already alive.
4. **Enumerate live sessions** for discovery.
5. **Kill a session** for lifecycle hygiene.

Today these are HTTP-only (`POST /spawn`, `POST /dispatch`, `GET /api/sessions`, `DELETE /api/sessions/:id`, `WS /terminal/:id/ws`) and not callable from inside an agent. The new tools let agents orchestrate sub-agents while the human user retains full visibility (every spawned session shows up in the Terminals tab).

## Non-goals

- **No new safety gates.** No approval requirement, no per-agent concurrency cap. Same posture as the existing `recipe.run`. The fork-bomb risk is acknowledged and documented in the tool description; the human can intervene via the Terminals tab.
- **No archived-log fallback for GC'd sessions.** After `EXIT_RETAIN_MS` (10 s), `session.read` returns `NOT_FOUND`. Adding archive replay is a separate, larger design that requires solving "tmux-backed sessions don't currently persist their pane output".
- **No parent-attribution / ownership metadata in DB.** Useful for caps and audit trails, but ships with the safety cap feature, not this MVP.
- **No tmux-backed true incremental cursor.** MVP serves tmux scrollback via `capture-pane` snapshots; cursor is opaque and may re-send full content. True incremental requires `tmux pipe-pane` plumbing — follow-up.
- **No replacement for `recipe.run`.** Recipes are still the right surface for *structured* multi-step work. `session.send` is for ad-hoc prompts.

## Use cases

| Pattern | How |
|---|---|
| Agent A needs help on a task — spawns Agent B with a prompt | `session.send({prompt, session_id: 'task-X'})` returns `mode: 'spawn'`, agent A polls `session.read` until B answers |
| Agent A wants to send a follow-up to the same B | `session.send({prompt: 'now do Y', session_id: 'task-X'})` returns `mode: 'dispatch'` (same alias, B is live) |
| Agent A wants to know what existing sessions are running | `session.list()` |
| Agent A wants to terminate a session it spawned | `session.kill({session_id: 'task-X'})` |

Crucially, every spawned session is a normal first-class clawdevbox session: it appears in the Terminals tab, the human can read the scrollback, type into it, kill it, or resume it.

## Architecture

### Refactor first

Extract the bodies of the 4 HTTP handlers into a new module that both HTTP routes and MCP tools share. No protocol drift, no duplicated business logic, no race-window divergence.

```
cron-api.ts (POST /spawn)        \
cron-api.ts (POST /dispatch)      \       session-helpers.ts (NEW)
cron-api.ts (GET  /api/sessions)   ─────> ┌─ spawnOrDispatch(ctx, args)
cron-api.ts (DEL  /api/sessions/:id)      │  dispatchOnly(ctx, instanceId, prompt)
                                          │  listSessions(ctx, opts)
tools/session.ts (NEW MCP tools) ───────> │  killSession(ctx, idOrAlias)
                                          └─ readScrollback(ctx, idOrAlias, opts)
```

### Files touched

```
NEW       mcp-server/src/tools/session.ts            — registerSessionEntries
NEW       mcp-server/src/session-helpers.ts          — extracted shared helpers
MODIFIED  mcp-server/src/pty-registry.ts             — + readScrollback for legacy pty
MODIFIED  mcp-server/src/cli/cron-api.ts             — refactor 4 handlers to call helpers
MODIFIED  mcp-server/src/server.ts                   — registerAllBuiltinEntries(ws) wires it
NEW       mcp-server/tests/tools-session.test.mjs    — unit + e2e coverage
```

### Workspace defaulting

MCP HTTP requests carry `X-Clawdevbox-Project-Dir` (and optionally `X-Clawdevbox-Workspace-Id`, `X-Clawdevbox-Recipe-Instance-Id`, `X-Clawdevbox-Session-Id`) in headers — already wired through `context-resolver.ts` via `extra.requestInfo.headers`. When `session.send` is called without an explicit `workspace_id`/`workspace_path`, the tool defaults to the calling agent's project dir and passes it as `workspace_path` to `spawnFromCallback`, which calls `ensureWorkspace()` to mint a row if needed.

## Tool specs

### 1. `session.send` — smart spawn-or-dispatch-or-resume

```ts
parameters: {
  prompt: string,                  // required — user-style message
  session_id?: string,             // alias OR canonical GUID.
                                   //   See mode resolution below.
  provider?: string,               // 'copilot' | 'claude' | 'agency' | ...
                                   //   defaults to cfg.defaultAgentCli
                                   //   neither set → PROVIDER_REQUIRED error
  agent?: string,                  // persona, e.g. 'dev-buddy:dev-buddy'
  model?: string,                  // LLM model override
  workspace_id?: string,           // existing workspace id
  workspace_path?: string,         // OR absolute path (creates workspace if new)
                                   //   if both omitted → calling agent's project dir
}
returns: {
  ok: true,
  mode: 'spawn' | 'dispatch' | 'resume',
  instance_id: string,             // for resume: NEW instance id (not the resumed one)
  session_id: string,              // canonical GUID (preserved across resume)
  session_alias?: string,          // human-friendly alias if provided
  state?: 'dispatched',            // only on mode='dispatch'
  resumed_from?: string,           // only on mode='resume' — the old instance_id
}
```

**Mode resolution**:
```
session_id given?
  no  → SPAWN with fresh GUID (mode='spawn')
  yes → resolve to canonical GUID
        ↓
        live pty exists for GUID?
          yes → DISPATCH the prompt (mode='dispatch')
          no  → look up latest archived agent_sessions row for GUID
                ↓
                row found AND row.cli_session_id != null
                  AND provider(row.agent_cli).supportsResume?
                    yes → RESUME (runRecipe with resumeOf=cli_session_id)
                          then dispatch prompt (mode='resume')
                    no  → fresh SPAWN with this GUID (mode='spawn')
                row not found → fresh SPAWN with this GUID (mode='spawn')
```

**Resume path**: when triggered, internally calls `runRecipe({resumeOf: row.cli_session_id, isAdhoc: <inferred>, recipeId: <inferred from original row>, spawnMode: 'interactive', workspaceInfo: {id: row.workspace_id, path: <looked-up>}, agentCli: row.agent_cli, ...})`. This is the same call the existing `POST /api/sessions/<id>/resume` makes. After the new pty is alive, the resolved instance_id is FIFO-dispatched the prompt. The OLD archived row is marked via `markResumedInto(db, oldInstanceId, newInstanceId)` so the UI's "Resumed as <new-id>" badge renders.

**Behavior**: wrapper around `spawnDispatchOrResume(ctx, args)` (extracted from `/spawn` handler + extended with the resume branch).

**Concurrency safety**: per-canonical-`sessionGuid` async mutex around `findLiveInstanceForSession → lookup-archive → dispatch/resume/spawn` block. Without this, two concurrent `session.send` calls with the same alias for a not-yet-live session both observe "no live instance" and both spawn duplicates. The mutex serializes the check-and-act atomically; subsequent calls inside the lock see the just-spawned instance and route to dispatch.

**Foreign tmux is read-only**: if `session_id` resolves to a foreign tmux session (live in tmux, not in our registry, no archived row in our DB), `session.send` rejects with `FOREIGN_NOT_WRITABLE`. Rationale: we don't know what's running inside a foreign tmux (could be the user's shell, a `vim` session, anything) — typing into it could break the user's work. `session.read` and `session.list` work fine on foreign sessions; only writes are blocked.

**Async semantics — documented in description**:
> "Returns immediately. For `mode='spawn'`, the initial prompt is delivered fire-and-forget after a readiness poll (the agent CLI's input box must render before bytes are typed). Don't assume the spawned agent has started work — poll `session.read` to observe progress. For `mode='dispatch'`, the prompt is FIFO-queued via the pending-dispatch-registry; bytes are typed when prior dispatches resolve."

**Fork-bomb risk — documented**:
> "Calling this in a loop creates new tmux sessions and agent CLI processes (each ~50-200 MB). The human can see and kill them in the Terminals tab, but consider the cost before recursing."

---

### 2. `session.read` — terminal scrollback

```ts
parameters: {
  instance_id?: string,            // direct pty key. EITHER this OR session_id required.
  session_id?: string,             // alias/GUID → resolved to current live instance.
                                   //   no live instance → NOT_FOUND
  since?: string,                  // opaque cursor from prior call. Default: read from tail.
  full?: boolean,                  // default false (last 32 KB).
                                   //   true = entire buffer (up to backend's cap).
  raw?: boolean,                   // default false (strips ANSI + TUI noise via
                                   //   stripTuiNoise from agent-clis/shared.ts).
                                   //   true = raw bytes incl. ANSI.
}
returns: {
  instance_id: string,
  backend: 'pty' | 'tmux' | 'archive',
  supports_incremental: boolean,   // true for 'pty'; false for 'tmux' (MVP)
  content: string,
  cursor: string,                  // opaque: '<instance_id>:<spawn_ts>:<offset>'
                                   //   pass back as `since` on next call
  truncated_before: boolean,       // true if caller's `since` is invalid
                                   //   (mismatched stream id OR offset below ring head)
  exited: boolean,
  exit_code?: number,
}
```

**Cursor encoding**: opaque string `<instance_id>:<spawn_ts>:<offset>`. Offset is UTF-16 code-unit count into the agent's output stream as observed by clawdevbox (matches JS string length). Tool parses the cursor and:
- If `<instance_id>:<spawn_ts>` doesn't match the current live session → `truncated_before: true`, full snapshot returned, new cursor minted.
- If `<offset>` is below the ring buffer's current head → `truncated_before: true`, content starts from head.
- Otherwise → content from offset to current head, new cursor reflects current head.

This single guard covers restart, respawn, ring-GC, and tmux-restart with one mechanism.

**Backend handling**:

| `backend` | When | Source | `supports_incremental` |
|---|---|---|---|
| `pty` | legacy IPty in `pty-registry` (e.g., e2e-test-runner sessions) | ring buffer + cursor | `true` |
| `tmux` | tmux-backed via `tmuxSessionRegistry` (Copilot/Claude/Agency — the dominant path) OR a foreign tmux session whose name resolves | `tmux capture-pane -p -t <name> -S -<lines>` | `false` (MVP) |
| `archive` | reserved — not used in MVP. Future: when ring/tmux is gone, fall back to on-disk log. | — | — |

For `tmux` backend in MVP, `cursor` is still returned and accepted, but every call re-issues `capture-pane` and returns the full snapshot. `supports_incremental: false` tells the caller polling is wasteful — they should rely on stable-tail detection.

**Foreign tmux read**: when `instance_id` matches a tmux session that's live in the system but NOT in `tmuxSessionRegistry` (e.g., user spawned it with `tmux new -s my-shell`, or it's a leftover `cdb_*` from a prior clawdevbox the orphan sweep didn't catch), `session.read` still works — same `capture-pane` path. The tool resolves to the tmux session name via `tmux has-session -t <id>` and reads. `backend: 'tmux'`, `supports_incremental: false`. This is how agents can observe foreign sessions surfaced by `session.list`.

**Stronger ANSI strip**: non-raw mode uses `stripTuiNoise` (not just `stripAnsi`) — strips SGR colors, cursor movement, erase-line, OSC sequences, control bytes. This is the same helper `agent-clis/shared.ts` uses for done-detection.

---

### 3. `session.kill` — terminate

```ts
parameters: {
  instance_id?: string,            // OR session_id (one required)
  session_id?: string,
}
returns: {
  ok: true,
  killed: boolean,
  kind: 'pty' | 'tmux' | 'foreign-tmux' | 'not_live',
}
```

Reuses the existing `DELETE /api/sessions/:id` body, refactored into `killSession(ctx, idOrAlias)`. Tries in order:
1. `pty-registry.killPty()` (legacy)
2. `tmuxSessionRegistry.get()` → kill (clawdevbox-owned tmux)
3. Bare `tmux has-session` + `kill-session` (foreign or post-restart tmux)
4. `kind: 'not_live'`

No `signal` parameter (semantics differ across backends — tmux kill is always session-level). Backend-appropriate termination always.

---

### 4. `session.list` — enumerate

```ts
parameters: {
  status?: 'all' | 'active' | 'archived',  // default 'active'
  include_foreign?: boolean,               // default true — include user-spawned tmux
                                           //   sessions (kind='foreign'). Set false to
                                           //   only see clawdevbox-owned sessions.
  since?: number,                          // epoch ms for archived pagination
  limit?: number,                          // default 50, max 200
}
returns: {
  items: Array<{
    instance_id: string,                   // for foreign sessions: the tmux session name
    session_id?: string,
    session_alias?: string,
    live: boolean,
    state: string,                         // 'idle' | 'busy' | 'starting' | 'foreign' | etc.
    provider_id?: string,
    workspace_id: string,
    kind: 'main' | 'recipe' | 'adhoc' | 'foreign',
    label: string,
    started_at: number,
    ended_at?: number,
  }>,
  next_since?: number,                     // pagination cursor for archived rows
}
```

Identical shape to `GET /api/sessions` JSON, served by the same extracted `listSessions(ctx, opts)` helper. Foreign sessions are tmux sessions live in the system that clawdevbox didn't spawn (e.g., user's own `tmux new -s test1`, or clawdevbox-spawned sessions from a prior process whose parent PID is now dead but somehow escaped the startup orphan sweep). They're surfaced so agents can discover them. **Writing** to foreign sessions via `session.send` is intentionally disallowed (see `session.send` below).

## Data flow

### `session.send` (spawn path)

```
agent → run_tool(session.send, {prompt: 'X', session_id: 'alias-Y'})
  → tools/session.ts handler reads ctx headers (X-Clawdevbox-Project-Dir)
  → session-helpers.spawnOrDispatch(ctx, args)
    → resolveSessionId('alias-Y') → {guid: 'GUID-Y', alias: 'alias-Y'}
    → withSendLock('GUID-Y', async () => {
        → dispatcher.findLiveInstanceForSession('GUID-Y') → null
        → dispatcher.spawnFromCallback(null, 'X', {sessionId: 'GUID-Y', workspacePath: '<project_dir>'})
          → recipe-runner.runRecipe({isAdhoc: true, spawnMode: 'interactive', ...})
            → provider.spawnSession({mode: 'interactive', init: {kind: 'new', session_id: 'GUID-Y'}})
              → tmux new-session -s cdb_<instance_id> -- copilot --session-id GUID-Y ...
              → tmuxSessionRegistry.register(instance_id, session)
          → registerPty / agent_sessions row in DB
        → returns {status: 'ok', instanceId, sessionId: 'GUID-Y'}
      })
    → returns {ok, mode: 'spawn', instance_id, session_id: 'GUID-Y', session_alias: 'alias-Y'}
  ← tool returns to MCP client
```

### `session.send` (dispatch path — same alias, second call)

```
agent → run_tool(session.send, {prompt: 'Z', session_id: 'alias-Y'})
  → spawnOrDispatch(ctx, args)
    → resolveSessionId('alias-Y') → {guid: 'GUID-Y', ...}
    → withSendLock('GUID-Y', async () => {
        → dispatcher.findLiveInstanceForSession('GUID-Y') → 'instance_id_from_first_call'
        → dispatcher.dispatchToInstance('instance_id_from_first_call', 'Z')
          → pending-dispatch-registry.registerPending(instanceId, 'Z')  // FIFO queues if mid-turn
          → tmuxSession.sendText('Z') → sendKey('Enter')
        → returns {status: 'ok', state: 'dispatched', dispatchId}
      })
    → returns {ok, mode: 'dispatch', instance_id, session_id, session_alias, state: 'dispatched'}
```

### `session.read` (pty backend)

```
agent → run_tool(session.read, {session_id: 'alias-Y', since: 'instance_id:1717536000000:1024'})
  → tools/session.ts handler
  → session-helpers.readScrollback(ctx, 'alias-Y', {since, full, raw})
    → resolve idOrAlias → live instance_id ('instance_id_from_spawn')
    → tmuxSessionRegistry.get(instance_id) → null  (not tmux-backed)
    → pty-registry.readScrollback(instance_id, {since, full, raw})
      → parse cursor → {instanceId, spawnTs, offset: 1024}
      → if instanceId/spawnTs mismatch → truncated_before: true, content from head
      → if offset < head_byte → truncated_before: true, content from head
      → else → content = bytes[offset .. totalBytes]
      → ANSI strip via stripTuiNoise unless raw
      → return {content, cursor: 'instance_id:spawn_ts:<new_offset>', truncated_before, exited, exit_code}
    → returns {instance_id, backend: 'pty', supports_incremental: true, ...}
```

### `session.read` (tmux backend)

```
agent → run_tool(session.read, {session_id: 'alias-Y'})
  → readScrollback(ctx, 'alias-Y', opts)
    → resolve → instance_id
    → tmuxSessionRegistry.get(instance_id) → session (found)
    → tmux capture-pane -p -t cdb_<instance_id> -S -<lines>
    → lines = opts.full ? full : 200 (caps at ~32 KB)
    → ANSI strip via stripTuiNoise unless raw
    → cursor = 'instance_id:spawn_ts:0' (always 0 — snapshot semantics)
    → return {content, cursor, truncated_before: false, backend: 'tmux',
              supports_incremental: false, exited: false}
```

## Error handling

All errors returned via `structuredError(code, message)` (matches existing tool convention):

| Code | When |
|---|---|
| `PROVIDER_REQUIRED` | `session.send` called without `provider` and no `cfg.defaultAgentCli` configured |
| `WORKSPACE_NOT_FOUND` | `workspace_id` given but no matching DB row (and no `workspace_path` to create from) |
| `SESSION_NOT_FOUND` | `session.read` or `session.kill` with `session_id` whose GUID has no live instance |
| `INSTANCE_NOT_FOUND` | `session.read` or `session.kill` with `instance_id` not in pty-registry/tmux-registry, and (for read) no archive fallback |
| `INVALID_CURSOR` | `session.read` cursor string fails to parse — different shape from `truncated_before` (which is "valid cursor but data is gone") |
| `SPAWN_FAILED` | `session.send` spawn-mode path failed (provider not registered, recipe-runner threw, etc.) — surfaces underlying message |
| `RESUME_FAILED` | `session.send` resume-mode path failed (e.g., recipe-runner threw during resume). Distinct from `SPAWN_FAILED` so callers can tell which branch failed. |
| `FOREIGN_NOT_WRITABLE` | `session.send` resolved to a foreign tmux session — writes are blocked for safety |

## Testing strategy

`mcp-server/tests/tools-session.test.mjs`:

1. **session.send fresh** — no `session_id`, returns `mode: 'spawn'`, fresh GUID, instance appears in `pty-registry`/`tmuxSessionRegistry`.
2. **session.send same alias dispatches** — two calls with `session_id: 'X'`: first returns `mode: 'spawn'`, second returns `mode: 'dispatch'` with the same `instance_id`.
3. **session.send concurrent same alias → no duplicate** — fire 5 parallel calls with the same `session_id`; assert exactly 1 spawn + 4 dispatches (mutex working).
4. **session.send PROVIDER_REQUIRED** — call without provider on a config with no `defaultAgentCli`; assert structured error.
5. **session.send defaults workspace from header** — set `X-Clawdevbox-Project-Dir` in request; assert `workspaceInfo.path` matches.
6. **session.read pty incremental** — spawn echo-stub session, write 2 chunks; first read returns full + cursor C1; second read with `since: C1` returns only second chunk + cursor C2.
7. **session.read pty truncated_before** — fill ring buffer past 256 KB; old cursor's offset < head; assert `truncated_before: true` and content starts from head.
8. **session.read pty cursor mismatch on respawn** — kill + respawn same alias; old cursor's `<instance_id>:<spawn_ts>` doesn't match; assert `truncated_before: true` and fresh cursor.
9. **session.read raw vs stripped** — write content with ANSI escapes; assert raw mode preserves, default mode strips (test `\x1b[31mred\x1b[0m` → `red`).
10. **session.read tmux backend** — for a tmux-backed session, assert `backend: 'tmux'`, `supports_incremental: false`, content captured via `capture-pane`.
11. **session.kill of live pty** — `kind: 'pty'`, `killed: true`. Second call → `kind: 'not_live'`.
12. **session.kill of live tmux** — `kind: 'tmux'`, `killed: true`, tmux session gone after.
13. **session.list returns spawned session** — spawn 2 sessions, assert both in list with correct `live`/`kind`.
14. **session.list status filter** — kill one, set `status: 'archived'`, assert killed one is present and live one isn't.
15. **session.send auto-resume archived copilot session** — spawn a `copilot` session with alias `X`, kill it, send `session.send({prompt, session_id: 'X'})`, assert `mode: 'resume'`, response includes `resumed_from: <old_instance_id>`, the OLD row in agent_sessions has `resumed_into_instance_id` set.
16. **session.send falls through to spawn when provider can't resume** — spawn an `echo-stub` session with alias `Y`, kill it, send `session.send({prompt, session_id: 'Y'})`, assert `mode: 'spawn'` (echo-stub has `supportsResume: false`), fresh instance_id different from old.
17. **session.list include_foreign default true / false** — create a foreign tmux session via `tmux new-session -d -s test_foreign_X`, call `session.list()`, assert it appears with `kind: 'foreign'`; call `session.list({include_foreign: false})`, assert it's filtered out.
18. **session.read of foreign tmux works** — read the same foreign session, assert `backend: 'tmux'`, `supports_incremental: false`, content was captured via capture-pane.
19. **session.send to foreign tmux is rejected** — call `session.send({prompt, session_id: 'test_foreign_X'})`, assert `FOREIGN_NOT_WRITABLE` error.

## Open questions & follow-ups

- **`tmux pipe-pane` for true incremental tmux reads** — biggest UX gap. Spawn-time hook in `tmux-session.ts::createTmuxSession` to `tmux pipe-pane -O 'cat >> <log_path>'`. Logfile path can be the same `<workspace>/.clawdevbox/recipe-instances/<id>.log` that recipe-runner already uses for legacy. Need to verify psmux supports `pipe-pane` (it's a tmux 1.4+ feature). When this lands, both backends use file-tail cursors and the `tmux`/`archive` backends collapse into one.
- **Parent attribution + soft cap** — track `parent_session_id` (from `X-Clawdevbox-Session-Id` header) at spawn time, expose in `session.list`, optionally cap. Schema migration + lower-priority. User explicitly chose no cap for MVP.
- **`session.wait`** — synchronous "block until task_complete" wrapping `pending-dispatch-registry`'s promise. Tempting for ergonomics; deferred until users explicitly ask for it.
- **`session.kill` graceful drain** — currently force-terminates. Could add `drain_seconds: number` to send `\x03\x03` (double Ctrl+C), wait, then force.

## Acceptance criteria

- All 19 tests pass.
- `list_tools` filter `session` returns exactly the 4 new entries.
- `learn_tool` returns valid Zod schemas + non-trivial descriptions for each.
- An end-to-end run from the main agent in the Terminals tab successfully:
  - Calls `session.send({prompt: "say HELLO_E2E", session_id: "e2e-test"})` → returns `mode: 'spawn'`.
  - Polls `session.read({session_id: "e2e-test"})` 5×; eventually sees "HELLO_E2E" in content.
  - Calls `session.send({prompt: "say BYE_E2E", session_id: "e2e-test"})` → returns `mode: 'dispatch'`.
  - Calls `session.kill({session_id: "e2e-test"})` → returns `killed: true`.
  - Calls `session.send({prompt: "say WELCOME_BACK", session_id: "e2e-test"})` → returns `mode: 'resume'` (copilot session was killed but resumable from its on-disk jsonl).
- HTTP routes (`POST /spawn`, `POST /dispatch`, etc.) still pass their existing test suites after the refactor.
- No regressions in `tests/cli-sessions/`, `tests/dispatch-*`, or `tests/api-sessions*`.
