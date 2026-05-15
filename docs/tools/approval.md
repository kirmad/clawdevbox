# `approval.*` MCP tools

Approvals are the "agent needs a decision" channel. An agent running inside a
thread calls `approval.request` with a question and a fixed set of options;
the host (the Clawdevbox desktop app, or any other UI) renders that as a modal
picker and calls `approval.resolve` once the user has answered. The thread
sits in `awaiting_user` between those two calls.

The family is intentionally tiny — three tools — and the data model mirrors
the option-picker UI shape so a renderer never has to translate between the
two.

Registered in `mcp-server/src/tools/approval.ts`; backed by `ApprovalStore`
in `mcp-server/src/store.ts`.

## Persistence model

**In-process only**, same as threads. `ApprovalStore` is a `Map<string, Approval>`
held on a module-level singleton (`approvals` in `store.ts`). There is no
disk file, no SQLite, no cross-process replication — when the MCP server
restarts, every approval (pending or resolved) disappears.

This is fine in practice because approvals are tightly coupled to a live
thread: if the server has restarted, the thread is also gone, so there is
nothing left to resolve. Durable approvals land with the SQLite kernel
alongside durable threads.

The HTTP service exposes the pending list to the SPA at
`GET /api/approvals` (see `mcp-server/src/cli/start.ts:486`), which the
"needs your input" badge in the home page polls.

### `Approval` row shape

```ts
interface Approval {
  id: string;                       // 'apr_<base36-rand>' (mintId('apr'))
  thread_id: string;
  question: string;
  options: Array<{
    value: string;                  // required, opaque
    label?: string;                 // display text; falls back to value
    description?: string;           // secondary text under the option
    recommended?: boolean;          // UI hint — pre-select / highlight
  }>;
  allow_freetext: boolean;          // default false
  default_view?: string;            // optional view_id to render the question with
  state: 'pending' | 'resolved' | 'cancelled';
  answer?: unknown;                 // populated on resolve; shape NOT validated
  created_at: number;               // unix ms
  resolved_at?: number;             // unix ms — set on resolve
}
```

`optionSchema` in the tool layer additionally accepts `confidence: number ∈ [0,1]`
on each option (used by some pickers as a "the agent is X% sure" hint), but
the store's row type doesn't persist that field explicitly — it rides along
in the option object because the field is structurally compatible.

## Tools

### `approval.request`

Open a new approval bound to a thread and put the thread into
`awaiting_user`. The caller is **not** suspended by this tool — the agent
process must yield on its own (typically by appending a message and
returning). The host UI sees the new `approval_request` message + the
`awaiting_user` state flip and renders a modal.

**Input**

```ts
{
  thread_id: string,                  // min 1 — must reference an existing thread
  question: string,                   // min 1
  options: Array<{
    value: string,                    // min 1
    label?: string,
    description?: string,
    recommended?: boolean,
    confidence?: number,              // 0..1
  }>,                                 // min 1 entry
  allow_freetext?: boolean,           // default false
  default_view?: string,              // optional view_id hint for the renderer
}
```

**Return**

```ts
{ approval: Approval }                // structuredContent
```

**Errors**

- `NOT_FOUND` — `thread_id` does not resolve via `threads.read()`.

**Side effects**

1. `approvals.request(...)` mints a new `apr_<rand>` row in state `pending`.
2. `threads.appendMessage(thread_id, 'approval_request', { approval_id, question, options }, 'agent')`
   appends an audit-trail message so the thread transcript shows the question.
3. `threads.setState(thread_id, 'awaiting_user')` — UI hosts watch this
   transition to surface the picker.

No event-bus emit and no `ui.notify` topic fire from this tool — the SPA
discovers new approvals by polling `/api/approvals`. (Threads are entirely
in-process and don't have an SSE topic yet.)

### `approval.resolve`

Answer a pending approval. Records the answer on the row, flips its state
to `resolved`, sets `resolved_at`, appends an `approval_resolved` message
to the thread, and returns the thread to `running`.

**Input**

```ts
{
  approval_id: string,                // min 1
  answer: unknown,                    // ⚠️  no validation
}
```

`answer` is intentionally `z.unknown()`. Callers are expected to pass one
of the `options[].value` strings, or — when `allow_freetext` was true on
the request — a freeform string. Nothing in the tool layer or
`ApprovalStore.resolve()` checks the shape; the stored value is whatever
the caller sent, including objects / arrays / null. This is by design:
some pickers want to attach metadata to a choice (e.g.
`{ value: 'merge', note: 'looks good' }`) without forcing a schema change.

**Return**

```ts
{ approval: Approval }                // structuredContent — state: 'resolved'
```

**Errors**

- `NOT_FOUND` — no approval with that id has ever existed in this process.
- `ALREADY_RESOLVED` — the approval exists but was no longer `pending` at
  call time. Both transitions (`pending → resolved` and `pending →
  cancelled`) leave the approval in a state where this error fires; the
  message says "was not in pending state". The thread's state and message
  log are **not** touched in this case.

**Side effects (on success)**

1. `approvals.resolve(id, answer)` mutates the row in place
   (`state = 'resolved'`, `answer = args.answer`, `resolved_at = now`).
2. `threads.appendMessage(thread_id, 'approval_resolved', { approval_id, answer }, 'user')`
   — note the `user` attribution: this message represents the user's input
   even when a programmatic caller answered on their behalf.
3. `threads.setState(thread_id, 'running')` — wakes the thread.

### `approval.list_pending`

Read all approvals currently waiting for an answer.

**Input**

```ts
{ thread_id?: string }                // optional — restrict to one thread
```

**Return**

```ts
{ approvals: Approval[], count: number }
```

**Errors** — none. Unknown `thread_id` is not an error; it simply yields
an empty array.

**Ordering** — `created_at` ascending (oldest first). Verified at
`store.ts:412`. The HTTP endpoint at `/api/approvals` calls
`approvals.listPending()` directly so the SPA sees the same order.

## State machine

```
            approval.request
                 │
                 ▼
            ┌─────────┐    approval.resolve     ┌──────────┐
            │ pending │ ──────────────────────► │ resolved │
            └────┬────┘                          └──────────┘
                 │
                 │  (no tool — reserved for a future
                 ▼   thread-cancel cascade)
            ┌───────────┐
            │ cancelled │
            └───────────┘
```

- `pending` → `resolved`: only via `approval.resolve`.
- `pending` → `cancelled`: **no tool exists for this yet**. The state is
  declared on `ApprovalState` and `Approval.state` so a future
  `thread.cancel` cascade can mark in-flight approvals as cancelled
  instead of resolving them, but as of today nothing writes that value.
- `resolved` / `cancelled` → anything: no transitions out. `ApprovalStore.resolve`
  is a no-op (returns the row unchanged) once the state is non-pending,
  and the tool layer turns that into `ALREADY_RESOLVED`.

## Edge cases & gotchas

- **No `approval.cancel` tool.** If you cancel a thread today, any
  approvals it owned stay `pending` forever (until the process restarts).
  They will still appear in `approval.list_pending` and in `/api/approvals`.
  Hosts should treat "thread cancelled but approval still pending" as
  ignorable.
- **`answer` is unvalidated.** A misbehaving caller can resolve with any
  value at all. Renderers that care should validate against
  `approval.options[].value` themselves before trusting it. The
  `allow_freetext` flag is purely advisory — the tool layer does not
  enforce it.
- **Double-resolve races.** Two concurrent `approval.resolve` calls on
  the same id: the first wins (mutates the row), the second sees
  `state !== 'pending'` inside the store, gets the row back unchanged,
  and the tool layer reports `ALREADY_RESOLVED`. The thread message log
  is only appended on the winning call.
- **Process restart drops everything.** Persistence is per-process. Any
  agent that survives a restart must be prepared to re-request its
  approval — there is no recovery.
- **`thread_id` must exist.** Unlike most tools, `approval.request`
  validates that `threads.read(thread_id)` returns a row before minting
  the approval. You cannot pre-create approvals for threads that haven't
  spawned yet.
- **`default_view` is opaque.** The tool stores it verbatim; resolving
  it to an actual renderer is the host's job. There is no validation
  that the view id exists.
- **No SSE / UI event on creation.** The SPA discovers pending approvals
  by polling `/api/approvals`. If you want instant notification, fire
  `ui.notify { topic: 'approvals' }` (or a `push`) from your agent after
  `approval.request` returns.
