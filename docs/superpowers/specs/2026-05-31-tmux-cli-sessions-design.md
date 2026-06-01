# Tmux-Backed CLI Sessions — Design Spec

**Date:** 2026-05-31
**Branch:** `feat/tmux-migration`
**Status:** Approved for implementation planning

## Goal

Replace direct `node-pty` agent process management with `tmux`-backed sessions. Every agent CLI (copilot, claude, agency, future providers) runs inside a tmux pane, addressed by session name. clawdevbox interacts with the agent exclusively through `tmux` commands (`send-keys`, `resize-window`, `capture-pane`, `kill-session`). Done-detection moves from byte-level sentinel markers to an explicit MCP tool the agent calls.

## Motivation

In priority order:

1. **Easier debugging.** Any agent's terminal is reachable from any shell via `tmux -L clawdevbox attach -t cdb_<id>`. Developers see exactly what the LLM sees, can interact directly, can scroll back through history.
2. **More reliable I/O.** Tmux mediates keystrokes and resize as a real TUI client. The viewer-input/CR-submit race classes we fought (xterm DA1 replies corrupting input boxes; resize-during-prompt-delivery; multi-line input bracket-paste confusion) are structurally eliminated because viewer bytes go to `tmux attach` (which consumes capability replies as its own TTY input) and never reach the agent.
3. **Session survival across clawdevbox restarts.** Tmux sessions persist beyond the parent server's lifetime. If clawdevbox crashes or is restarted, agents keep running; clawdevbox reconciles them on startup via `tmux list-sessions`.

## Architecture (v4 — "tmux attach in IPty")

```
Browser xterm.js ◄──WS── terminal-server ◄──pty-registry──► IPty (node-pty)
                  ──WS──►                  (per-viewer)        │
                                                                │ stdin/stdout/resize
                                                                ▼
                                                       ┌────────────────────┐
                                                       │ tmux attach        │
                                                       │ -L clawdevbox      │
                                                       │ -t cdb_ri_xxx      │
                                                       └────────┬───────────┘
                                                                │ tmux client protocol
                                                                ▼
                                            ┌──────────────────────────────────┐
                                            │  tmux server (-L clawdevbox)     │
                                            │    session: cdb_ri_xxx           │
                                            │    pane: copilot.exe             │
                                            └──────────────────────────────────┘
                                                                ▲
                                                                │ tmux send-keys / resize-window
                                                                │ (subprocess invocations)
   dispatcher.dispatchToInstance(...) ──────────────────────────┘
       awaits update_status(task_complete=true) MCP tool call
```

### Two distinct concerns, cleanly separated

**Agent lifecycle** — new `tmux-session-registry`:
- `instanceId → { tmux_session_name, agent_pid }`
- Created by `provider.spawnSession()` via `tmux new-session -d -s cdb_<instanceId> -c <cwd> '<env... binary args...>'`
- Destroyed by `tmux kill-session -t cdb_<instanceId>`
- Survives clawdevbox restarts; reconciled on startup via `tmux list-sessions -F '#{session_name}'` filtered by `cdb_` prefix.

**Viewer rendering** — existing `pty-registry` reused but pivoted:
- Each WebSocket viewer spawns its OWN `tmux -L clawdevbox attach -t cdb_<id>` in an `IPty` (node-pty).
- Bytes flow naturally: viewer types → WS → `IPty.write` → `tmux attach` stdin → tmux server → pane → agent.
- DA1/cursor capability replies go to `tmux` (consumed as TUI client TTY negotiation), never reach the agent.
- WebSocket protocol UNCHANGED: `{type:'input', data}`, `{type:'resize', cols, rows}`, `{type:'snapshot', content}`, `{type:'data', chunk}`, `{type:'exit'}`.
- Lazy: WS open on user-visible terminal; WS closed (via Page Visibility API + manual nav-away) → server kills the `tmux attach` IPty.
- Pty-registry entries become viewer-scoped (`viewer-${websocket-id}`) instead of instance-scoped.

### Configurable tmux socket

- Default: `tmux -L clawdevbox ...` (isolated from user's other tmux work).
- Configurable to share default socket (`tmux ...` no `-L`) via a setting picked at install/start time.
- All clawdevbox subprocess invocations consult the configured socket arg.

### Bundled tmux config

`mcp-server/assets/cdb.tmux.conf`:
- `set -g aggressive-resize on` — each client sees the pane at its own size (otherwise smallest-client-wins disrupts other viewers)
- `set -g history-limit 100000` — large scrollback so long-running agents don't lose history
- `set -g default-size 120x30` — sane initial pane size
- `set -g status off` — no status bar bytes (the agent doesn't need to see tmux UI)
- `set -g remain-on-exit on` — pane stays open after process exits (so we can capture-pane for archive log)

Used via `tmux -L clawdevbox -f assets/cdb.tmux.conf <subcommand>` for the first session that creates the server.

## Components

### 1. `CliSession` interface
**Path:** `mcp-server/src/cli-sessions/types.ts`

```ts
export type SpecialKey =
  | 'Enter' | 'Escape' | 'Tab' | 'Backspace'
  | 'C-q' | 'C-c' | 'C-d' | 'C-u' | 'Up' | 'Down' | 'Left' | 'Right';

export interface CliSession {
  /** tmux session name, e.g. "cdb_ri_abc123_4567". */
  readonly name: string;

  /** Agent process pid inside the tmux pane. */
  pid(): Promise<number | null>;

  /** Resolved when the agent process inside the pane exits. */
  readonly exited: Promise<{ exitCode: number | null }>;

  // Input — programmatic; the conductor/dispatcher path uses these
  /** Send literal text. Never interprets key names. */
  sendText(text: string): Promise<void>;

  /** Send a single special key. */
  sendKey(key: SpecialKey): Promise<void>;

  // Display
  /** Resize the pane to cols×rows. */
  resize(cols: number, rows: number): Promise<void>;

  /** Capture-pane snapshot of full scrollback. */
  snapshot(opts?: { ansi?: boolean }): Promise<string>;

  // Lifecycle
  /** Kill the agent process and the tmux session. Idempotent. */
  kill(): Promise<void>;
}

export interface CliSessionSpawnOpts {
  /** Becomes `cdb_${name}` as the tmux session name. Must be unique. */
  name: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Command + args to run inside the pane. */
  command: string;
  args: string[];
}

export interface CliSessionRuntime {
  spawn(opts: CliSessionSpawnOpts): Promise<CliSession>;
  attach(name: string): Promise<CliSession | null>;
  list(): Promise<Array<{ name: string; alive: boolean }>>;
}

/** Singleton concrete instance, backed by tmux. Created at startup. */
export const tmuxSessionRuntime: CliSessionRuntime;
```

**Key design choices:**
- **No `sendRaw(bytes)` escape hatch.** Forcing all input through `sendText` / `sendKey` is what eliminates the xterm-DA1-reply class of bugs structurally. New `SpecialKey` entries (e.g. `'F1'`, `'M-x'`) are added as needed.
- **No `attachOutputStream` method.** Viewers don't use `CliSession`; they spawn their own `tmux attach` IPty in terminal-server. `CliSession` is for the dispatcher/conductor only.
- **`snapshot()` exists** for: (a) initial-prompt-ready detection (poll for `❯` + `context (N%)`); (b) archive log written on session-exit.
- **`attach(name)`** powers startup reconciliation: walk `tmux list-sessions`, rebuild handles for DB rows that match.
- **All operations async** (vs `IPty`'s sync `.write()`) because each shells out to `tmux ...`. Latency ~1ms per call locally; negligible per dispatch.

### 2. `tmux-client.ts` — thin tmux subprocess wrapper
**Path:** `mcp-server/src/cli-sessions/tmux-client.ts`

```ts
export interface TmuxClientOpts {
  /** -L flag value, or null to share default socket. */
  socket: string | null;
  /** -f flag value (config file path), or null for tmux defaults. */
  configPath: string | null;
}

export function tmuxRun(
  client: TmuxClientOpts,
  args: string[],
  opts?: { input?: string; cwd?: string; env?: Record<string, string> },
): { exitCode: number; stdout: string; stderr: string };

export function tmuxRunAsync(
  client: TmuxClientOpts,
  args: string[],
  opts?: { input?: string; cwd?: string; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

Synchronous variant for hot-path operations (`send-keys`, `resize-window`); async for snapshot/list. Both prepend the socket/config flags.

### 3. `tmux-session.ts` — `CliSession` implementation
**Path:** `mcp-server/src/cli-sessions/tmux-session.ts`

```ts
export async function createTmuxSession(
  client: TmuxClientOpts,
  opts: CliSessionSpawnOpts,
): Promise<CliSession>;
```

Internally:
- `spawn`: `tmux new-session -d -s cdb_<name> -x <cols> -y <rows> -c <cwd> -e <KEY=VAL>... '<cmd> <args...>'`.
- `sendText`: `tmux send-keys -t cdb_<name> -l "<text>"`. For multi-line text containing newlines, uses `tmux load-buffer -t cdb_<name> -` (stdin) + `tmux paste-buffer -t cdb_<name> -p -d` to avoid newline-as-key-boundary confusion.
- `sendKey`: `tmux send-keys -t cdb_<name> <Key>` where `<Key>` is tmux's key vocabulary (`Enter`, `Escape`, `C-q`, etc.).
- `resize`: `tmux resize-window -t cdb_<name> -x <cols> -y <rows>`.
- `snapshot`: `tmux capture-pane -p -t cdb_<name> -S - -E -` (optionally `-e` for ANSI).
- `kill`: `tmux kill-session -t cdb_<name>`. Idempotent — ignores "session not found".
- `exited`: polled or watched via tmux session-closed hook. Implementation: `tmux pipe-pane -O 'echo CDB_PANE_EXITED >> <fifo>'` is not ideal; simpler is to poll `tmux list-sessions` for the name every 1s until gone, then resolve. Alternative: tmux hook `set-hook -t cdb_<name> pane-died "run-shell 'curl http://localhost:5201/internal/pane-exit/<name>'"`.

`pid` queried via `tmux display-message -p -t cdb_<name> '#{pane_pid}'`.

### 4. `tmux-session-registry.ts` — agent-lifecycle bookkeeping
**Path:** `mcp-server/src/cli-sessions/tmux-session-registry.ts`

```ts
export interface TmuxSessionRegistry {
  register(instanceId: string, session: CliSession): void;
  get(instanceId: string): CliSession | null;
  list(): Array<{ instanceId: string; sessionName: string }>;
  unregister(instanceId: string): void;
  /** On startup: query tmux, match against DB rows, adopt or mark orphans. */
  reconcileOnStartup(): Promise<{ adopted: number; orphaned: number }>;
}
```

### 5. `update_status` MCP tool
**Path:** `mcp-server/src/tools/update-status.ts`

```ts
mcp.registerTool({
  name: 'update_status',
  description: `Report your current status to clawdevbox.

Call this:
  • Periodically during long operations — keeps the orchestrator and
    user informed of progress.
  • Exactly once with task_complete=true when you finish responding
    to the current dispatched prompt. (REQUIRED — the orchestrator
    blocks the next dispatch until you do this.)
  • With needs_user_input=true if you cannot proceed without
    clarification from the user.`,
  parameters: {
    status_text: {
      type: 'string',
      description: 'Short human-readable status, e.g. "Searching for foo", "Running tests", "Done — wrote 3 files".',
      maxLength: 4096,
    },
    needs_user_input: {
      type: 'boolean',
      default: false,
      description: 'True if you cannot proceed without user clarification. The UI surfaces this.',
    },
    task_complete: {
      type: 'boolean',
      default: false,
      description: 'True exactly once when you finish responding. Marks the dispatched prompt as done.',
    },
  },
  handler: async ({ status_text, needs_user_input, task_complete }, ctx) => {
    const instanceId = ctx.sessionContext.recipeInstanceId;
    updateInstanceStatus(instanceId, {
      text: status_text,
      needs_user_input,
      task_complete,
      ts: Date.now(),
    });
    emitChange('instance.status', instanceId);

    // EITHER flag resolves a pending dispatch.
    if (task_complete || needs_user_input) {
      const pending = getPendingDispatch(instanceId);
      if (pending) {
        pending.resolve({
          status_text,
          needs_user_input,
          task_complete,
          doneAt: Date.now(),
        });
      }
    }
    return { ok: true };
  },
});
```

System-prompt prepend (per provider):

> You are running inside clawdevbox. You have access to a tool called `update_status`. Use it to:
> - Report progress periodically during long operations (every 30-60s of work, or after each meaningful step).
> - Signal `needs_user_input=true` when you require clarification.
> - **Always** call `update_status` with `task_complete=true` exactly once when you finish responding. This is mandatory — the orchestrator depends on it.

### 6. `pending-dispatch-registry.ts`
**Path:** `mcp-server/src/pending-dispatch-registry.ts`

```ts
export interface PendingDispatch {
  instanceId: string;
  dispatchId: string;
  startedAt: number;
  prompt: string;
  resolve(payload: { status_text?: string; needs_user_input: boolean; task_complete: boolean; doneAt: number }): void;
  reject(err: Error): void;
}

export function registerPendingDispatch(instanceId: string, prompt: string): PendingDispatch & { promise: Promise<...> };
export function getPendingDispatch(instanceId: string): PendingDispatch | null;
```

One pending dispatch per `instanceId`. Subsequent `/dispatch` calls for the same instance BLOCK on the existing one's promise — matches today's `SessionConductor` serial-drain semantics. Documented in the API surface as "FIFO-ordered, single in-flight per instance."

### 7. Dispatcher pivot
**Path:** `mcp-server/src/dispatcher.ts` (existing, modified)

```ts
async function dispatchToInstance(instanceId: string, prompt: string): Promise<DispatchResult> {
  const session = tmuxSessionRegistry.get(instanceId);
  if (!session) return { status: 'not_found' };

  const pending = registerPendingDispatch(instanceId, prompt);

  // Inject prompt: ESC for overlay-dismiss + split-cr-250ms for copilot/agency
  await session.sendKey('Escape');
  await sleep(200);
  await session.sendText(prompt);
  await sleep(250);
  await session.sendKey('Enter');

  return await Promise.race([
    pending.promise,
    timeoutAfter(DISPATCH_TIMEOUT_MS),  // default 5 min
  ]);
}
```

`SessionConductor` and `session-conductor.test.mjs` are deleted. The new dispatcher serializes per-instance via the pending-dispatch map: a second `/dispatch` call for the same instance awaits the first's promise.

### 8. Per-viewer `tmux attach` in terminal-server
**Path:** `mcp-server/src/terminal-server.ts` (existing, modified)

WebSocket flow:
- On `/terminal/<instanceId>/ws` open:
  - Look up `session = tmuxSessionRegistry.get(instanceId)`.
  - If found: spawn `tmux -L clawdevbox attach -t cdb_<instanceId>` in an IPty (node-pty), cols/rows from initial resize.
  - Register IPty in `pty-registry` with viewer-scoped key (e.g. `viewer-<random-id>`).
  - Wire up: `IPty.onData` → `WebSocket.send({type:'data', chunk})`; `WebSocket.on('input')` → `IPty.write`; `WebSocket.on('resize')` → `IPty.resize`.
- On WebSocket close: `IPty.kill()` (which detaches the tmux client; tmux session keeps running for other viewers/the agent).

`pty-registry.ts` becomes viewer-IPty-only. Drop:
- `initialPromptGateActive`, `pendingResize`, `flushPendingResize`
- `INITIAL_PROMPT_VIEWER_GATE_GRACE_MS`
- The conductor wiring (no more conductor)

### 9. Provider changes (copilot, claude, agency, echo-stub)

Each provider's `spawnSession`:
- Replace `ctx.spawnPty(file, args, opts)` with `tmuxSessionRuntime.spawn({ name: instanceId, cwd, env, command: file, args, cols, rows })`.
- Return a lightweight `AgentHandle` whose methods delegate to `CliSession` (`sendText`, `sendKey`, `resize`, `kill`, `exited`, `pid`).
- Drop `pty: IPty` from the handle.
- Prepend `update_status` instructions to the system prompt (or per-provider `--system-prompt` / `agent` flag).

`writePrompt` shrinks dramatically:
```ts
async writePrompt(handle, { text, strategy }) {
  if (strategy === 'submit') {
    await handle.sendKey('Escape');
    await sleep(200);
  }
  await handle.sendText(text);
  await sleep(250);
  await handle.sendKey(strategy === 'queue' ? 'C-q' : 'Enter');
}
```

Delete: `deliverInitialPromptWhenReady`, `fullyRenderedRegex`, `notReadyRegex`, `initialPromptDelivery`-on-handle, `INITIAL_PROMPT_VIEWER_GATE_GRACE_MS`. Initial prompt becomes a regular dispatch (after snapshot-poll for `❯` + `context (N%)` → 2500ms stable → first `dispatchToInstance`).

### 10. Recipe-runner + startup reconciliation

`recipe-runner.ts`:
- Stop creating IPty for agents. Call `provider.spawnSession` → CliSession-backed handle.
- Register the new handle in `tmuxSessionRegistry`.
- Hook `session.exited` → `tmux capture-pane -p -t cdb_<id> -S - -E -` → write to `<id>.log` for archive.

`cli/start.ts`:
- On startup: `tmuxSessionRegistry.reconcileOnStartup()`. Match `tmux list-sessions` against running DB rows; adopt the ones that match, mark orphans as `crashed`.
- Health-check: `tmux -L clawdevbox list-sessions` must succeed. If tmux binary missing, hard-error with install hint.

## Data flow

### Spawning an agent
1. `POST /spawn` → `dispatcher.spawnFromCallback`
2. `provider.spawnSession` → `tmux new-session -d -s cdb_<id> -c <cwd> '<env vars> <binary> <args>'`
3. `tmuxSessionRegistry.register(instanceId, session)`
4. Snapshot poll: every 500ms, `session.snapshot()`, look for `❯` + `context (N%)`. When found AND stable for 2500ms → ready.
5. First user-supplied prompt → `dispatcher.dispatchToInstance(instanceId, prompt)` (same path as any dispatch).

### Dispatching a prompt
1. `POST /dispatch` → `dispatcher.dispatchToInstance(instanceId, prompt)`
2. `registerPendingDispatch(instanceId)` → promise + dispatchId
3. `session.sendKey('Escape')` (overlay dismiss); `sleep(200)`
4. `session.sendText(prompt)`; `sleep(250)`
5. `session.sendKey('Enter')`
6. Await `pending.promise` OR `timeoutAfter(5min)`
7. Agent eventually calls `update_status(task_complete=true)` → MCP tool resolves the pending promise
8. Return result to caller

### Viewer attach
1. Browser opens `/terminal/<instanceId>/ws` WebSocket
2. terminal-server looks up `tmuxSessionRegistry.get(instanceId)` → exists
3. Spawn `tmux -L clawdevbox attach -t cdb_<instanceId>` in an IPty (cols/rows from first resize)
4. Wire IPty ↔ WebSocket (data/input/resize)
5. WebSocket close → `IPty.kill()` → tmux attach detaches; tmux session keeps running

### Restart reconciliation
1. clawdevbox starts up
2. `tmuxSessionRegistry.reconcileOnStartup()` queries `tmux list-sessions -F '#{session_name}'`
3. For each `cdb_*`, look up corresponding DB row
4. Adopt: rebuild `CliSession` handle, register in registry, mark DB row `running`
5. Orphaned DB rows (running in DB, missing in tmux): mark as `crashed`

## Migration plan (phases)

### Phase 1 — Foundations (~1-2 days)
| File | Change |
|---|---|
| **NEW** `mcp-server/src/cli-sessions/tmux-client.ts` | `tmuxRun(args, opts)` subprocess wrapper. |
| **NEW** `mcp-server/src/cli-sessions/tmux-session.ts` | `createTmuxSession(opts)` → `CliSession` impl. |
| **NEW** `mcp-server/src/cli-sessions/tmux-session-registry.ts` | Agent registry + `reconcileOnStartup()`. |
| **NEW** `mcp-server/src/cli-sessions/types.ts` | `CliSession`, `SpecialKey`, `CliSessionSpawnOpts`. |
| **NEW** `mcp-server/assets/cdb.tmux.conf` | Bundled tmux config (aggressive-resize, history-limit, etc.). |
| **NEW** `mcp-server/tests/cli-sessions/tmux-session.test.mjs` | Unit tests against real tmux: create → sendText → snapshot → assert; sendKey; resize; kill → exited resolves. |
| **NEW** smoke test on Windows: spawn `copilot.exe` inside tmux on the actual deployment platform — verify before proceeding. |

### Phase 2 — MCP tool + dispatch refactor (~1 day)
| File | Change |
|---|---|
| **NEW** `mcp-server/src/tools/update-status.ts` | The MCP tool. |
| **NEW** `mcp-server/src/pending-dispatch-registry.ts` | Per-instance pending-dispatch map with promise + timeout. |
| Modify `mcp-server/src/server.ts` | Register `update_status`. |
| Modify `mcp-server/src/dispatcher.ts` | Replace conductor with pending-dispatch. |
| Modify `mcp-server/src/db/migrations/` | V5 migration: `agent_sessions.status_text TEXT, needs_user_input INTEGER, last_status_at INTEGER`. |
| **DELETE** `mcp-server/src/agent-clis/session-conductor.ts` |
| **DELETE** `mcp-server/tests/session-conductor.test.mjs` |
| **NEW** `mcp-server/tests/update-status-tool.test.mjs` | task_complete; needs_user_input; both; timeout; double-call. |

### Phase 3 — Provider migration (~1-2 days, one at a time)
For each of `echo-stub` → `copilot` → `claude` → `agency`:
- `spawnSession`: replace `ctx.spawnPty` with `tmuxSessionRuntime.spawn`.
- Return lightweight `AgentHandle` backed by `CliSession`.
- Prepend `update_status` system-prompt instructions.
- Shrink `writePrompt` (see code above).
- Delete `deliverInitialPromptWhenReady`, `fullyRenderedRegex`, etc.
- Update `agent-clis-capabilities.test.mjs` for the new handle shape.

### Phase 4 — pty-registry pivot (~0.5 day)
- Strip gate plumbing.
- Pty-registry hosts per-viewer `tmux attach` IPty instances ONLY. Viewer-scoped keys.
- `terminal-server`: on WS open, look up tmux session, spawn `tmux attach` in IPty. On WS close, kill IPty.
- WebSocket protocol unchanged.

### Phase 5 — recipe-runner + startup reconciliation (~0.5 day)
- recipe-runner: don't spawn IPty for agents. Register in `tmuxSessionRegistry`. Archive log via `capture-pane` on exit.
- `cli/start.ts`: tmux binary detection (hard-error if missing). `tmuxSessionRegistry.reconcileOnStartup()`.

### Phase 6 — Cleanup + verification (~0.5 day)
- Remove dead code (`INITIAL_PROMPT_VIEWER_GATE_GRACE_MS`, etc.).
- Run full suite. Update tests.
- Stress: `repro-spawn-stuck.mjs 10 --rapid`. UI loop rapid dispatch.
- Manual: `tmux -L clawdevbox attach -t cdb_<id>` from a real shell, type, verify.

**Total: ~4-5 days.**

**Rollback:** branch `feat/tmux-migration` isolated; main untouched.

**Out of scope (deferred):**
- `tunnel.ts` (devtunnel host pty) — non-agent, no TUI. Stays as `pty.spawn` for now.
- `e2e-test-runner.ts` (node test script in pty) — non-agent. Defers.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Windows tmux fragility (MSYS, path handling) | Medium | High | Phase 1 smoke test on Windows BEFORE proceeding. |
| Agent doesn't call `update_status` reliably | Medium | Medium | 5-min timeout + snapshot-poll fallback for stable-idle-prompt. |
| Tmux server crash | Low | High | tmux is famously stable; health-check via `list-sessions` in `/healthz`. |
| Multiple viewers, "smallest client wins" pane sizing | Medium | Low | `aggressive-resize on` in cdb.tmux.conf. |
| node-pty version conflict | Low | Low | Accept; v4 explicitly keeps node-pty for viewers. |
| Session-name collisions across restart | Medium | Low | Reconciliation marks orphan rows `crashed`. |
| `send-keys -l` text escaping with newlines/quotes | Medium | Medium | Use `load-buffer` + `paste-buffer` for multi-line text. |
| `update_status` from nested sub-agent contexts | Medium | Medium | `sessionContext.recipeInstanceId` is per-process; integration test required. |
| Per-viewer subprocess cost | Low | Low | Page Visibility API + lazy attach. |

## Open questions (deferred to plan/implementation)

1. Exact contents of `cdb.tmux.conf` — empirically tune `history-limit`, `default-size`, etc.
2. `update_status` payload size cap policy (chose 4KB; revisit if too small).
3. Should `tunnel.ts` migrate too for consistency, or stay non-tmux? Pick when easy.
4. Should we add a `dispatch_progress` event to `update_status` history for replay? Or keep it as latest-state-only?

## Approval

Approved for implementation planning on 2026-05-31. Next step: invoke `writing-plans` skill to produce the task-by-task implementation plan.
