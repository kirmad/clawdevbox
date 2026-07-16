# `thread.*` MCP tools

The `thread.*` family is the in-process kernel for Conductor's side-terminal
agent sessions. A **thread** is the persistent conversation row attached to an
inbox item (and, optionally, to a parent thread); **messages** are the
append-only log of everything the agent and the system want to surface — agent
text, tool calls, tool results, view emissions, state changes.

These tools are deliberately thin: they create rows, append messages, transition
state, and cascade cancellation. They do **not** spawn or supervise the agent
CLI process — spec §6.1 reserves that for the scheduler (today, the desktop
app's shell IPC).

Source: [`mcp-server/src/tools/thread.ts`](../../mcp-server/src/tools/thread.ts),
backed by `ThreadStore` in [`mcp-server/src/store.ts`](../../mcp-server/src/store.ts).

## Persistence model

> ⚠️ **In-process only.** `ThreadStore` is a plain `Map<string, Thread>` plus
> `Map<string, Message[]>` plus `Map<string, string[]>` (child index) living in
> the single Node process that hosts the MCP server. **Restarting the server
> clears every thread and every message.** There is no disk write, no WAL, no
> recovery.
>
> This is a known limitation tagged for the **SQLite kernel phase** (`design.md`
> §1: "the only durable state is a single SQLite file at `~/.conductor.db`").
> Until that lands, treat threads as ephemeral session state — fine for the
> live agent loop, unsafe to depend on across restarts.

Contrast with the **inbox** (file-backed at `<globalDir>/inbox.json`) and
**recipe instances** (per-workspace JSON files) — those survive restarts today.
Threads do not.

### Row shapes

```ts
type ThreadState = 'running' | 'suspended' | 'awaiting_user' | 'done' | 'cancelled' | 'error';

interface Thread {
  id: string;                  // `thr_<base36-rand>`
  inbox_item_id: string;       // every thread is bound to an inbox item
  recipe_id?: string;          // the recipe that seeded the thread, if any
  parent_thread_id?: string;   // for child threads spawned by the agent
  prompt: string;              // the initial user message
  state: ThreadState;
  created_at: number;          // unix ms
  updated_at: number;          // bumped on appendMessage / setState / cancel
}

interface Message {
  id: string;                  // `msg_<base36-rand>`
  thread_id: string;
  type: string;                // free-form: 'agent_text', 'tool_call', 'tool_result', ...
  payload: unknown;            // opaque to the kernel
  attribution?: 'agent' | 'user' | 'system' | 'trigger';
  created_at: number;          // unix ms — stamped server-side
}
```

Ids are minted as `<prefix>_<8-char-base36>` (see `mintId()` in `store.ts`).
They are not cryptographically random — they're meant to be human-recognizable
in logs, not unguessable.

## Tools

### `thread.spawn`

**Signature**

```ts
input: {
  inbox_item_id: string;            // required, must exist in the InboxStore
  prompt: string;                   // required, the seed user message
  recipe_id?: string;               // optional, links the thread to a recipe
  parent_thread_id?: string;        // optional, sets the parent edge
}

returns: {
  content: [{ type: 'text', text: 'Spawned thread thr_... (recipe=...).' }],
  structuredContent: { thread: Thread }
}

errors:
  NOT_FOUND { kind: 'inbox_item', id }   // when inbox_item_id is unknown
```

**What it does.** Inserts a fresh `Thread` row in state `running`, allocates an
empty message list for it, and (if `parent_thread_id` is supplied) registers
the child in the parent's entry inside `childIndex`. Returns the new row.

**What it does NOT do.** Spawn the agent CLI process. That's the scheduler's
job (spec §6.1). The Clawdevbox desktop app — or any future external scheduler —
watches for new threads and launches the actual `claude` / `copilot` process.
The MCP server only owns the row.

**How it does it.** Calls `inbox.read()` for existence, then
`threads.spawn({...})`. The child index update is unconditional when
`parent_thread_id` is set:

```ts
const arr = this.childIndex.get(parent_thread_id) ?? [];
arr.push(id);
this.childIndex.set(parent_thread_id, arr);
```

### `thread.append_message`

**Signature**

```ts
input: {
  thread_id: string;                              // required
  type: string;                                   // free-form
  payload: unknown;                               // opaque
  attribution?: 'agent' | 'user' | 'system' | 'trigger';
}

returns: {
  content: [{ type: 'text', text: 'Appended message msg_... to thr_... (type=...).' }],
  structuredContent: { message: Message }
}

errors:
  NOT_FOUND { kind: 'thread', id }
```

**What it does.** Mints a new `msg_<rand>` id, stamps `created_at = Date.now()`
server-side, appends to the thread's message list, and bumps the thread's
`updated_at` to match. Per the inline doc in `thread.ts`: "the side-terminal
agent calls this after every meaningful step so the user sees its progress."

**Common `type` values** (none are validated — the field is free-form):

| `type`         | When the agent emits it                                   |
| -------------- | --------------------------------------------------------- |
| `agent_text`   | A chunk of streamed assistant prose                       |
| `tool_call`    | An MCP tool invocation the agent just issued              |
| `tool_result`  | The result returned by that tool                          |
| `view_emitted` | The agent published a renderer artifact for the UI        |
| `step_close`   | End-of-step marker, useful for collapsing in the timeline |
| `state_change` | Auto-emitted by `thread.set_state` when `reason` is given |
| `cancel`       | Auto-emitted by `thread.cancel` on every cancelled thread |
| `wake_requested` | Auto-emitted by `thread.wake`                           |

**How it does it.** Single call to `threads.appendMessage(id, type, payload, attribution)`.
No event-bus emit today (cf. inbox, which fans out via `emitChange('inbox')`) —
the kernel does not yet push thread changes to the SPA. That subscription is
expected to land with the SQLite kernel.

### `thread.read`

**Signature**

```ts
input: {
  thread_id: string;                // required
  since_message_id?: string;        // optional cursor — exclusive
  limit?: number;                   // optional, max 1000
}

returns: {
  content: [{ type: 'text', text: 'thread thr_... [running]; N message(s)' }],
  structuredContent: {
    thread: Thread,
    messages: Message[]             // ordered by created_at ascending
  }
}

errors:
  NOT_FOUND { kind: 'thread', id }
```

**What it does.** Returns the thread row plus its messages. Useful for the SPA's
"timeline" pane and for polling agents that want to see what's happened since a
known cursor.

**Cursor semantics.** `since_message_id` is **exclusive** — `read` calls
`findIndex(...)` then slices from `idx + 1`. If the cursor message is not found
in the thread, the filter is silently a no-op and **all** messages are returned.
This is intentional (clients can pass a fresh-looking id without crashing) but
means clients can't distinguish "cursor lost" from "no new messages."

**Limit semantics.** `limit` is applied **after** the since-cursor slice and
takes the **first** N messages — i.e. it's a head, not a tail. Callers wanting
the latest N must page from the start.

### `thread.set_state`

**Signature**

```ts
input: {
  thread_id: string;
  state: 'running' | 'suspended' | 'awaiting_user' | 'done' | 'cancelled' | 'error';
  reason?: string;                  // optional — when set, also emits a `state_change` message
}

returns: {
  content: [{ type: 'text', text: 'Set thread thr_... → <state>.' }],
  structuredContent: { thread: Thread }
}

errors:
  NOT_FOUND { kind: 'thread', id }
```

**What it does.** Unconditionally writes the new `state` and bumps `updated_at`.
If `reason` is provided, also appends a `state_change` message with
`{ state, reason }` and `attribution: 'system'` so the audit trail explains
*why* the transition happened.

**No transition validation.** The store will happily flip `done → running` or
`cancelled → suspended`. The state machine described below is convention, not
enforcement — callers are responsible for sensible transitions. The SQLite
kernel may tighten this.

### `thread.cancel`

**Signature**

```ts
input: {
  thread_id: string;
  recursive?: boolean;              // default true at the tool boundary
  reason?: string;                  // recorded on every cancelled thread
}

returns: {
  content: [{ type: 'text', text: 'Cancelled N thread(s).' }],
  structuredContent: { cancelled: string[] }   // ids in visit order, parent first
}

errors:
  NOT_FOUND { kind: 'thread', id }   // when the root thread is unknown
```

**What it does.** Walks the parent → child graph from `thread_id`, flipping
each visited thread to `cancelled` and appending a system-attributed `cancel`
message with the supplied (or default `'cancelled'`) reason.

> Per the tool description: *"the cascade is the only kill switch (mission-memory:
> no wallclock budgets)."* — there are no timeouts in the kernel; the only way
> to stop a thread tree is `thread.cancel`.

**Recursion default.** The Zod schema makes `recursive` optional, but the tool
handler defaults it to `true` (`args.recursive ?? true`). Pass `recursive: false`
explicitly to cancel only the root.

**Visit logic** (from `ThreadStore.cancel`):

```ts
const visit = (tid: string) => {
  const t = this.threads.get(tid);
  if (!t) return;
  if (t.state === 'done' || t.state === 'cancelled') return;   // idempotent
  t.state = 'cancelled';
  t.updated_at = Date.now();
  cancelled.push(tid);
  this.appendMessage(tid, 'cancel', { reason: reason ?? 'cancelled' }, 'system');
  if (recursive) {
    const kids = this.childIndex.get(tid) ?? [];
    kids.forEach(visit);
  }
};
```

Key properties:

- **Idempotent.** Already-`done` and already-`cancelled` threads are skipped
  (not re-cancelled, no second `cancel` message). This means cancelling a tree
  that's partially completed is safe.
- **Depth-first, pre-order.** Parent is added to `cancelled[]` before its
  children, so the returned array doubles as a topological cancel log.
- **No cycle detection.** `childIndex` is append-only; if anything ever inserts
  a cycle, `visit` will recurse forever. In practice cycles are impossible —
  `parent_thread_id` is set once at spawn time and never edited — but the
  SQLite kernel should add a `seen` set for safety.
- **No `error` short-circuit.** Threads in state `running`, `suspended`,
  `awaiting_user`, or `error` are all cancellable.

### `thread.wake`

**Signature**

```ts
input: { thread_id: string }

returns: {
  content: [{ type: 'text', text: 'Woke thread thr_...' }],
  structuredContent: { thread: Thread }
}

errors:
  NOT_FOUND          { kind: 'thread', id }
  UNKNOWN_THREAD_STATE                          // race between read + setState (single-threaded JS: unreachable)
```

**What it does.**

1. Logs the wake intent (`logger.info({ threadId }, 'thread.wake requested')`).
2. Appends a `wake_requested` system message with `{ ts: Date.now() }` payload.
3. Sets the thread's state to `running`.

The tool **only updates kernel state and emits the intent**. Restarting the
underlying CLI process is the host's responsibility — today that's the
Clawdevbox desktop app's shell-command IPC; in the future, an external
scheduler tool will watch for `wake_requested` messages and re-spawn.

**Trigger story.** This is the integration point for cron-scheduled triggers
(`design.md` §3 — triggers are TS scripts that poll something on a schedule and
decide whether to act). A trigger that wants to revive a paused investigation
calls `thread.wake` on the suspended thread; the host sees the state flip plus
the `wake_requested` message and re-launches the agent process pointing at the
existing message log. The trigger doesn't need to know about CLI processes —
just kernel state.

**No transition check.** `wake` will set **any** thread to `running`, including
threads already in `running`, `done`, `cancelled`, or `error`. The
`UNKNOWN_THREAD_STATE` branch only fires if `setState` returns undefined
between the `read` and the `setState` call, which is impossible in
single-threaded Node — but it stays in the code as defence-in-depth for the
SQLite kernel where row deletion will become possible.

## State machine

| State            | Meaning                                                | Reached by                                 | Exits to                                  |
| ---------------- | ------------------------------------------------------ | ------------------------------------------ | ----------------------------------------- |
| `running`        | Agent CLI alive (or expected alive); messages flowing  | `thread.spawn`; `thread.wake`; approval resolve | `suspended`, `awaiting_user`, `done`, `cancelled`, `error` |
| `suspended`      | Agent exited waiting for an external nudge             | `thread.set_state`                         | `running` (via `thread.wake`)             |
| `awaiting_user`  | Approval requested — UI must answer                    | `approval.request` (writes store directly) | `running` (via `approval.resolve`)        |
| `done`           | Terminal success                                       | `thread.set_state`                         | — (skipped by `cancel`'s visit)           |
| `cancelled`      | Terminal abort                                         | `thread.cancel`; `thread.set_state`        | — (skipped by `cancel`'s visit)           |
| `error`          | Terminal failure                                       | `thread.set_state`                         | —                                         |

**Convention, not enforcement.** `thread.set_state` accepts any → any
transition. The table describes what the agent loop *should* do, not what the
store *prevents*. Future SQLite kernel may add transition guards.

**External writers.** `approval.ts` writes `awaiting_user` ↔ `running`
directly via `threads.setState`, bypassing the `thread.set_state` tool. The
store is the source of truth, not the tool wrapper.

## Parent/child graph

Threads can spawn child threads (e.g. a top-level PR-review thread spawns one
child per file). The relationship is **one-way**: the child knows its parent
via `parent_thread_id`, and the store maintains a reverse `childIndex` for
cascade operations.

### How `childIndex` is maintained

- **Set on `spawn`.** When `thread.spawn` is called with `parent_thread_id`,
  the new child's id is appended to `childIndex[parent_thread_id]`.
- **Never re-parented.** `parent_thread_id` is a field on `Thread` set once at
  spawn and never edited.
- **Never pruned.** When a thread is cancelled or marked `done`, its row stays
  in `this.threads` and its entry stays in `childIndex`. The graph is monotonic
  for the lifetime of the process. (Restart clears everything; see persistence
  notes.)

### How cancel cascades

`thread.cancel { recursive: true }` does a DFS pre-order over `childIndex`:

1. Visit the root thread → flip to `cancelled`, append `cancel` message, push
   to the result array.
2. Look up `childIndex[root_id]`. For each child id, recurse.
3. Already-`done` and already-`cancelled` threads short-circuit (no message,
   no descent into their subtree).

Because the visit short-circuits on terminal states, **dead subtrees don't
accumulate cancel messages on every parent cancellation** — exactly the
"idempotent cascade" property you want.

When `recursive: false`, only the root is cancelled; children keep running.
This is rarely what callers want, hence the tool defaulting `recursive` to
`true` even though the schema marks it optional.

## Edge cases & gotchas

- **Restart = everything is gone.** No persistence yet. Tests that span a
  server restart must re-spawn from scratch. Tracked under the SQLite kernel
  phase.
- **`thread.spawn` requires the inbox item to exist.** No anonymous threads.
- **No deletion tool.** `thread.cancel` flips state but leaves the row +
  messages in memory until process restart.
- **`thread.set_state` validates nothing.** Both the target state value (Zod
  enum) and the *current* state are unchecked. `done → running` is a legal
  call.
- **`thread.wake` is not a guard.** It does not check that the thread is
  `suspended` or `awaiting_user`; it unconditionally flips state to `running`.
  Callers needing a guard should `thread.read` first.
- **`thread.read` cursor with unknown id returns everything.** Silent
  fallback — distinguish "cursor lost" from "no new messages" client-side.
- **`limit` is a head, not a tail** (`slice(0, n)`). For the latest N, page
  from the cursor or slice client-side.
- **`appendMessage` updates `thread.updated_at`.** Sorting by `updated_at`
  sorts by last-message-time, not last-state-change.
- **`childIndex` is unbounded growth.** Entries are never removed; fine for a
  session, costly for long-lived processes.
- **Message ordering is insertion order.** A plain array pushed in call order
  — the SQLite kernel will need an explicit `ORDER BY created_at, id`.
- **No change-event fan-out.** Unlike the inbox (`emitChange('inbox')`),
  thread/message writes are silent. SSE subscribers cannot live-tail a thread
  today — the SPA polls via `thread.read`. Wiring `emitChange('thread')` is
  on the roadmap.
