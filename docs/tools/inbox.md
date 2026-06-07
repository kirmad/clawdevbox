# `inbox.*` MCP tools

The inbox is the user's **persistent, mobile-friendly notification center**. Whenever a trigger, recipe, or agent has something the human should know about — a new PR to review, a freshly-fired incident, an epic that decomposed into thirty work items — it lands as an *inbox item*. The SPA renders the list as a stack of cards; the user expands one to read the body, then archives, snoozes, or marks it done.

The MCP tools in this family (`inbox.list`, `inbox.read`, `inbox.upsert`, `inbox.set_state`, `inbox.snooze`, `inbox.archive`) are the **only** way to create, mutate, and read inbox state. All six are registered by `mcp-server/src/tools/inbox.ts` and back onto a single `InboxStore` singleton declared in `mcp-server/src/store.ts`.

Three design notes that govern the whole surface:

1. **Two-tier storage.** The list endpoint is hot (the SPA polls it every time the user switches tabs, opens the app, or receives an SSE refresh hint). It cannot read hundreds of KB of markdown per card. So metadata lives in a single small JSON file and bodies live in per-item sidecars — fetched only when the user expands a card.
2. **File-of-truth, no in-memory cache.** Both the stdio MCP server (one process) and `clawdevbox start --service` (another process) operate on the same inbox concurrently. The store re-reads `<globalDir>/inbox.json` on every operation and writes it back atomically on every mutation, so the processes stay consistent without a database.
3. **Mutations fan out.** Every successful mutation calls `emitChange('inbox')` (see `mcp-server/src/event-bus.ts`), which fires an SSE event on the `inbox` topic. Any open SPA tab re-fetches `/api/inbox` and re-renders. `inbox.upsert` additionally fires a browser **push notification** on creation (and optionally on update) so the user's phone buzzes the moment something lands.

---

## Filesystem layout

Everything inbox-related lives under the **global** directory (default `~/.clawdevbox`, override with `CLAWDEVBOX_GLOBAL_DIR`). The inbox is intentionally account-wide, not project-scoped — a notification fired from project A must be reachable from a phone subscribed via project B's tunnel.

```
<globalDir>/
├── inbox.json                                  ← all metadata, one file
└── inbox-bodies/
    ├── ado_pr_2401.md                          ← body sidecar (markdown)
    ├── icm_incident_482991123.md
    └── manual_test-item.txt                    ← body sidecar (text)
```

### `inbox.json` shape

```json
{
  "version": 1,
  "items": [ { /* InboxItem */ }, ... ]
}
```

Read by `loadInboxFromDisk(globalDir)` and written by `saveInboxToDisk(globalDir, items)` in `mcp-server/src/inbox-persistence.ts`. The reader filters out malformed rows silently (any object missing `id`, `kind`, `source`, `state`, `created_at`, or `updated_at` is dropped). The writer is **atomic**: it goes through `writeFileAtomic` (tempfile + rename) so a crash mid-write can never produce a half-written `inbox.json`.

If the file doesn't exist or is unparseable, the loader returns `[]` and the warning is logged — the inbox quietly resets to empty rather than aborting startup.

### Body sidecars

A body file lives at `<globalDir>/inbox-bodies/<safeBasename>.<ext>` where:

- `<safeBasename> = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)` (see `safeBodyBasename` in `inbox-persistence.ts`)
- `<ext>` is `md` for `description_format: 'markdown'` (the default) or `txt` for `'text'`

So an item with id `ado:pr:2401` and a markdown body lands at `inbox-bodies/ado_pr_2401.md`. The colons are replaced with underscores because Windows filesystems reject them; the dot and dash characters survive because they're legal everywhere.

Collisions between safe basenames are theoretically possible (e.g. `ado:pr:2401` and `ado_pr_2401` would collide) but inbox ids are conventionally namespaced (`<source>:<kind>:<localId>`) and 200 chars is plenty of headroom. The full unmodified id remains the canonical key in `inbox.json`.

### Body sidecar lifecycle

| Operation | Function | Behavior |
|---|---|---|
| Write | `writeInboxBody(globalDir, id, body, format)` | Creates `inbox-bodies/` if missing; writes atomically; **also deletes any opposite-format sidecar** so a markdown ↔ text flip doesn't orphan the old file. |
| Read | `readInboxBody(globalDir, id, format)` | Returns the file contents, or `null` if the sidecar is missing or unreadable. |
| Delete | `deleteInboxBody(globalDir, id)` | Unlinks **both** `.md` and `.txt` sidecars for the id. Idempotent — missing files are not an error. |

The path helpers (`inboxFilePath`, `inboxBodiesDir`, `inboxBodyPath`) are exported for code that needs to reason about disk layout (e.g. the HTTP server's `GET /api/inbox/<id>` handler).

### Why two tiers?

A bare `GET /api/inbox` (used by the SPA's home page on every tab activation) reads `inbox.json` once and returns the whole array. If we stuffed bodies in there, a single 256KB markdown item would slow down every list render. Splitting bodies into sidecars keeps the list endpoint flat — and the SPA only fetches a body via `GET /api/inbox/<id>` once the user actually expands a card. The `description_size` field on `InboxItem` lets the SPA decide whether the card has a body to fetch without hitting the disk.

### In-memory fallback

`InboxStore.bind(globalDir)` switches the store from in-memory mode to file-backed mode. Until it's called (e.g. in test harnesses, or ad-hoc unit tests that don't have a global dir), `load()` returns the private `memory: Map<string, InboxItem>` and `save()` replaces it. The public API is identical in both modes — the only difference is durability. `bind()` is idempotent; calling it twice with different paths simply swaps the target. `buildServer()` in the MCP server bootstrap calls `inbox.bind(globalDir)` once at startup.

The in-memory mode **does not** write body sidecars; bodies in test mode survive only as long as the `InboxStore` instance exists, because `writeInboxBody` writes to disk unconditionally but `readInboxBody` returns `null` when `description_size` is 0. Tests that don't go through tools generally just set `description_format` and accept `description: null` from `inbox.read`.

---

## Schema

The full `InboxItem` row stored in `inbox.json`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✅ | Caller-chosen unique key. Conventionally `<source>:<kind>:<localId>` (e.g. `ado:pr:2401`, `icm:incident:482991123`). |
| `kind` | string | ✅ | Category — `pr_review`, `workitem`, `incident`, `epic`, or any caller-defined string. Filters the list. |
| `source` | string | ✅ | Origin system — `ado`, `icm`, `manual`, plugin id, etc. Used as the fallback push body when no preview/title is set. |
| `title` | string | optional | ≤500 chars. Card heading. |
| `preview` | string | optional | ≤500 chars. Brief tldr shown on the card. Also the preferred push-notification body. |
| `description_format` | `'markdown' \| 'text'` | optional | Format of the body sidecar. Defaults to `markdown` when a body is written. |
| `description_size` | number | optional | Byte length of the body (utf-8). 0 / missing ⇒ no body. The SPA uses this to decide whether to fetch `GET /api/inbox/<id>`. |
| `attachments` | `InboxItemAttachment[]` | optional | Max 20. Each entry: `{ artifact_id, workspace_id?, title?, type? }`. Clickable artifact chips in the SPA detail view. |
| `recipe_instance` | `{ id, workspace_id? } \| null` | optional / nullable | Link to a recipe instance (clicking jumps to the Recipes tab). Pass `null` to clear. |
| `trigger_id` | string `\| null` | optional / nullable | Link to a registered trigger (e.g. `ado.new-pr-watcher#auth-svc`). Pass `null` to clear. |
| `labels` | `string[]` | optional | Max 10 labels, each ≤40 chars. De-duplicated case-insensitively (first-seen casing wins). |
| `question` | `InboxQuestion \| null` | optional / nullable | Clickable question payload (prompt + options + dispatch routing). See [Questions & reply chains](#questions--reply-chains). Pass `null` to clear. |
| `replies` | `InboxReply[]` | optional | Append-only reply chain. Empty `[]` clears. Most agents should use `inbox.reply` to append a single message instead of rewriting this array. |
| `agent_message` | string | optional | **Legacy** "agent banner" — kept for backwards compat. Prefer `preview`. |
| `agent_tone` | `'info' \| 'warn' \| 'err' \| 'ok'` | optional | **Legacy** tone hint for `agent_message`. |
| `state` | `'new' \| 'open' \| 'snoozed' \| 'archived' \| 'done'` | system | Lifecycle state. New rows always start at `'new'`. |
| `snoozed_until` | number (unix ms) | optional | Set by `inbox.snooze`. Only meaningful while `state === 'snoozed'`. |
| `created_at` | number (unix ms) | system | First-seen timestamp. Frozen on creation. |
| `updated_at` | number (unix ms) | system | Refreshed on every mutation. Drives list ordering (newest-first). |

### Field constraints (Zod, enforced at the tool boundary)

```text
PREVIEW_MAX        = 500
DESCRIPTION_MAX    = 256 * 1024   (256 KB)
ATTACHMENTS_MAX    = 20
LABELS_MAX         = 10
LABEL_LEN_MAX      = 40
PUSH_BODY_MAX      = 120
ARTIFACT_ID_RE     = /^[a-z0-9][a-z0-9._-]*$/i
```

Bodies bigger than `DESCRIPTION_MAX` are rejected at the Zod layer with a `VALIDATION_FAILED` error. The label schema additionally `.trim()`s before length-checking, so a label that is whitespace-only fails the `min(1)` constraint.

---

## Tools

### `inbox.list`

```ts
inbox.list({
  kind?:   string,                                          // filter to one kind
  state?:  'new' | 'open' | 'snoozed' | 'archived' | 'done',
  label?:  string,         // case-insensitive label match (≤40 chars)
  limit?:  number,         // 1..500, default 100
  cursor?: string,         // id of the last-returned item; results start after it
})
  → { content: [{type:'text', text:'Found N inbox item(s).'}],
      structuredContent: { items: InboxItem[], count: number } }
```

**What it does.** Returns inbox items — **metadata only**, never bodies. Use `inbox.read` to fetch the body of a single item.

**How it does it.** Calls `InboxStore.list(filter)`. The store reads the entire inbox from disk (or memory), then applies in order: filter by `kind`, filter by `state`, filter by `label` (case-insensitive substring match against `labels[]`), sort newest-first by `updated_at`, slice from the cursor's position, return `limit` items.

The cursor is the **id of the last item the caller already has** — paging works by passing the previous page's tail. If the cursor id no longer exists in the inbox, `findIndex` returns `-1` and the next page starts from the beginning (`Math.max(0, -1 + 1) === 0`). This is intentionally forgiving: pages don't get stuck when items are deleted between fetches.

**No state transitions; no body sidecar reads; no events fired.** `inbox.list` is read-only.

---

### `inbox.read`

```ts
inbox.read({
  id: string,
  include_body?: boolean,    // default true
})
  → NOT_FOUND if id absent
  → { content: [{type:'text', text:'inbox <id> [<kind>/<state>] · body N bytes'}],
      structuredContent: { item: InboxItem, description: string | null } }
```

**What it does.** Fetches a single inbox item, optionally including the full body. The body lives on disk in a sidecar; if you only need metadata, pass `include_body: false` and skip the disk read.

**How it does it.** Calls `InboxStore.read(id)` to pull the metadata. If `include_body` is not `false` *and* the item has a non-empty body (`description_size > 0` and `description_format` set), it then calls `readInboxBody(globalDir, id, format)` to slurp the sidecar. If the sidecar is missing on disk but the metadata claims a body exists, `description` comes back `null` (no error — the metadata wins for the SPA's "has a body" decision, but the user sees an empty body when they expand the card).

**Errors:** `NOT_FOUND` (`{ kind: 'inbox_item', id }`) when the id doesn't exist.

---

### `inbox.upsert`

```ts
inbox.upsert({
  id:               string,                                     // required
  kind:             string,                                     // required
  source:           string,                                     // required

  // Display
  title?:           string,
  preview?:         string,                                     // ≤500 chars

  // Body
  description?:     string,                                     // ≤256 KB; "" deletes sidecar
  description_format?: 'markdown' | 'text',                     // default 'markdown'

  // Refs
  attachments?:     Attachment[],                               // max 20; [] clears
  recipe_instance?: { id, workspace_id? } | null,               // null clears
  trigger_id?:      string | null,                              // null clears
  labels?:          string[],                                   // max 10, ≤40 each, dedup CI; [] clears

  // Legacy
  agent_message?:   string,
  agent_tone?:      'info' | 'warn' | 'err' | 'ok',

  // Push
  notify?:          boolean,
})
  → {
      content: [{ type:'text', text: '<summary>' }],
      structuredContent: {
        item: InboxItem,
        created: boolean,
        push: { attempted, delivered, pruned, errors[] } | null,
        push_error_code: 'NOTIFICATIONS_DISABLED' | null,
      }
    }
```

**What it does.** Creates a new inbox item (when the id is unseen) or updates an existing one. Idempotent on `id`. This is the only entry point for "new mail" — and it doubles as the push-notification trigger.

**How it does it.**

1. **Body sidecar first.** If `description` was provided, decide between three cases *before* updating metadata so `description_size` ends up truthful:
   - `description === ''` → `deleteInboxBody(globalDir, id)`, set `descriptionSize = 0`.
   - `description !== ''` → `writeInboxBody(globalDir, id, description, format)`, set `descriptionSize = Buffer.byteLength(description, 'utf8')`.
   - Otherwise (omitted) → leave the sidecar alone.
2. **Format-only flip.** If `description_format` changed *without* a new body, the tool re-reads the existing sidecar in the old format, rewrites it in the new format (via `writeInboxBody`, which also deletes the old-format file), and updates `description_size` to match. If no sidecar existed, only the metadata format flips.
3. **Build the patch.** A `Record<string, unknown>` is populated with **only** the fields the caller actually sent. Omitted fields are absent from the patch — they pass through the spread merge in `InboxStore.upsert` unchanged.
4. **Dedup labels.** When `labels` is present, walk it once, trim each entry, lowercase-key into a `Set<string>`, and keep the first-seen casing in an output array. This lets a caller send `['UI', 'ui', 'Backend']` and end up with `['UI', 'Backend']` on disk.
5. **`InboxStore.upsert(id, kind, source, patch)`** spreads the patch over the existing row (or creates a fresh one with `state: 'new'`, `created_at`, `updated_at`), persists, and emits the `inbox` SSE event.
6. **Decide on push** (next subsection).

**Update semantics — the patch merge rules:**

| Field treatment | Behavior |
|---|---|
| Field **omitted** from the call | Unchanged on disk. |
| Field set to `null` (on nullable fields: `recipe_instance`, `trigger_id`) | Cleared — the field stays in the row as `null`. |
| `description: ""` | Body sidecar is deleted (`deleteInboxBody`), `description_size: 0`, `description_format` is wiped (`undefined` in the patch ⇒ deleted by spread). |
| `attachments: []` | Cleared — the array on the row becomes `[]`. |
| `labels: []` | Cleared — the array on the row becomes `[]`. |
| Anything else | The value replaces the existing value verbatim. |

Note that `kind` and `source` are **always** overwritten on update — the patch object passes them in explicitly (the merge is `{ ...existing, ...patch, kind, source, updated_at: now }`), so any update call effectively re-asserts both. Callers that don't want to change them should pass the existing values.

**Push behavior — the `notify` flag rules:**

| `notify` value | `created === true` (first arrival) | `created === false` (update) |
|---|---|---|
| Omitted | Push fires | No push |
| `true` | Push fires | Push fires |
| `false` | No push | No push |

Push wiring:

1. Call `loadNotificationsConfig({ projectDir, globalDir })` (from `config.ts`). This reads both `<projectDir>/.clawdevbox/config.json` (project layer) and `<globalDir>/config.json` (global layer), merges with **project wins**, and returns `{ enabled, vapid }`. `enabled` is true *only* if a layer explicitly sets `notifications.enabled: true` **and** a VAPID keypair is present.
2. If `enabled === false` or `vapid === null`, the structured response includes `push: null, push_error_code: 'NOTIFICATIONS_DISABLED'` and a `Push: skipped — ...` summary line. Nothing else is touched.
3. Otherwise, build the push payload:
   - **Title.** `item.title?.trim() || \`New ${item.kind}\``. Trimmed; falls back to a synthesized "New &lt;kind&gt;" string.
   - **Body.** Prefer `item.preview?.trim()` → fall back to `item.agent_message?.trim()` → final fallback `\`${source}${title ? '' : ` · ${id}`}\``. The body is clipped to `PUSH_BODY_MAX` (120 chars), with an ellipsis suffix if it overflowed. Never includes recipe/trigger ids — those are "private" metadata that shouldn't end up on a lock screen.
   - **Tag.** `\`inbox:${item.id}\``. Browsers collapse notifications with the same tag, so re-firing on the same inbox id replaces the previous lock-screen entry instead of stacking.
   - **URL.** `'/'` — taps land on the SPA home, which auto-routes to the inbox.
4. Call `sendNotification({ globalDir, projectDir }, vapid, payload)` (from `notifications.ts`). It walks every subscribed device, encrypts with VAPID, posts to the push service, and prunes endpoints that come back 404/410. The returned `{ attempted, delivered, pruned, errors }` is included verbatim in the structured response.

**SSE side-effect.** Every successful upsert (push enabled or not) emits `emitChange('inbox')`, so any open SPA tab refreshes its list within ~50ms.

---

### `inbox.set_state`

```ts
inbox.set_state({
  id:     string,
  state:  'new' | 'open' | 'snoozed' | 'archived' | 'done',
  reason?: string,        // recorded for audit; currently a no-op (kernel landing TODO)
})
  → NOT_FOUND if id absent
  → { content: [{type:'text', text:'Set <id> → <state>.'}], structuredContent: { item } }
```

**What it does.** Transitions an inbox item to a new state.

**How it does it.** The new state is validated by `inboxStateField` (a Zod enum) — anything outside the five legal values is rejected at the tool boundary with `VALIDATION_FAILED`. Then `InboxStore.setState(id, state)` looks up the row, spreads `{ state, updated_at: now }`, persists, and emits `emitChange('inbox')`. There is **no transition graph** — any state can move to any other state. Snooze unsets are implicit: setting `state` to anything other than `'snoozed'` leaves `snoozed_until` on the row (stale data) but the SPA ignores it unless `state === 'snoozed'`.

**`reason` is accepted but not yet wired** — it'll become a message attribution on the item once the SQLite kernel lands.

---

### `inbox.snooze`

```ts
inbox.snooze({
  id:    string,
  until: number,          // unix-ms; must be > Date.now()
})
  → INVALID_SNOOZE_TIME if until <= now
  → NOT_FOUND if id absent
  → { content: [{type:'text', text:'Snoozed <id> until <ISO>.'}], structuredContent: { item } }
```

**What it does.** Marks an item snoozed and stamps it with a wake-up time.

**How it does it.** The tool guards `until > Date.now()` before touching the store and returns a `structuredError('INVALID_SNOOZE_TIME', '...')` on miss (`{ isError: true, structuredContent: { code: 'INVALID_SNOOZE_TIME', message } }`). On success, `InboxStore.snooze(id, until)` spreads `{ state: 'snoozed', snoozed_until: until, updated_at: now }`, persists, and emits `emitChange('inbox')`.

There is no scheduler that wakes snoozed items automatically — `snoozed_until` is a hint the SPA uses to display "wakes at 3pm" and to let the user un-snooze manually. A future cron daemon may transition snoozed items back to `'open'` when their wake time passes; until then, snooze is essentially "hide from the default list view."

---

### `inbox.archive`

```ts
inbox.archive({
  id: string,
})
  → NOT_FOUND if id absent
  → { content: [{type:'text', text:'Archived <id>.'}], structuredContent: { item } }
```

**What it does.** Convenience wrapper for `set_state` with `state: 'archived'`.

**How it does it.** Calls `InboxStore.archive(id)`, which is literally `this.setState(id, 'archived')`. Same persistence, same SSE event, same idempotency. The tool body references `threads` (the global thread store) to flag a future cascade — when the SQLite kernel lands, archiving an item should cancel any threads attached to it. For now, threads survive their parent item's archival and must be cleaned up via `thread.cancel`.

---

### `inbox.reply`

```text
inbox.reply({
  id: string,                                  // existing item id
  reply: {
    author: 'user' | 'agent',                  // typically 'agent' for follow-ups
    text: string,                              // ≤16 KB
    option_ids?: string[],
    freeform?: string,
    attachments?: InboxItemAttachment[],       // same shape as item attachments
    created_at?: number,
    dispatch?: { mode, instance_id?, session_id?, code?, error? },
    id?: string,                               // auto-minted as `rep_<random>` when omitted
  },
  reopen?: boolean,                            // clear question.closed (agent follow-up)
  new_state?: 'new'|'open'|'snoozed'|'archived'|'done',
})
  → NOT_FOUND if id absent
  → { content: [{type:'text', text:'Appended reply <rid> to <id>.'}],
      structuredContent: { item, reply } }
```

**What it does.** Appends a reply to an existing item's `replies[]` chain. Designed for **agent-authored follow-ups** in multi-turn conversations (e.g. agent acknowledges the user's choice, then asks a refining question via `reopen: true` + a new `question` on the next `inbox.upsert`).

**For user answers, the SPA POSTs `/api/inbox/<id>/reply` instead** — that path validates the selection against `question.options`, compiles a prompt via `question.dispatch.prompt_template`, and dispatches via `spawnDispatchOrResume`. `inbox.reply` does NOT dispatch.

---

## Questions & reply chains

An inbox item can carry a **question** payload that renders as a clickable form (radio/checkbox buttons + optional freeform input) in the SPA detail pane. When the user picks an option and presses Send, the server compiles a prompt and dispatches it back to the agent via `spawnDispatchOrResume` — the same path `/spawn` uses, so the answer arrives at the live pty (dispatch) or wakes an archived session (resume) or spawns a fresh one as needed.

The user's answer is persisted on the item as a `replies[]` entry, so the selection is visible across page reloads. Agents can post follow-up replies via `inbox.reply` to keep the conversation going.

### Question shape

```ts
question: {
  prompt: string,                            // shown above the option buttons
  mode?: 'single' | 'multi' | 'text',        // default: 'single' if options exist, else 'text'
  options?: {
    id: string,                              // /^[A-Za-z0-9._\-:]+$/, ≤80 chars
    label: string,                           // display, ≤200 chars
    value?: string,                          // sent in {answer}; defaults to label
  }[],                                       // max 20
  allow_freeform?: boolean,                  // include a text box alongside options
  placeholder?: string,                      // hint for the text box
  close_on_answer?: boolean,                 // default true — close after first user reply
  closed?: boolean,                          // server sets true on user reply (when close_on_answer)
  dispatch?: {
    session_id?: string,                     // GUID/alias resolved via the standard chain
    provider?: string,                       // for fresh-spawn fallback ('copilot' | 'claude' | ...)
    workspace_id?: string,
    workspace_path?: string,
    prompt_template?: string,                // default: '{answer}'
  },
}
```

### Reply shape

```ts
replies: {
  id: string,                                // 'rep_<random>', server-minted when via API
  author: 'user' | 'agent',
  text: string,                              // rendered for the chain bubble
  option_ids?: string[],                     // selected options (user replies)
  freeform?: string,                         // raw freeform text
  attachments?: InboxItemAttachment[],       // per-reply artifact chips
  created_at: number,
  dispatch?: {                               // populated for user replies that dispatched
    mode: 'spawn' | 'dispatch' | 'resume' | 'noop' | 'failed',
    instance_id?: string,
    session_id?: string,
    code?: string,
    error?: string,
  },
}[]
```

### `POST /api/inbox/<id>/reply`

User-facing endpoint the SPA calls when the user presses Send. Validates `option_ids` against `question.options`, compiles the answer text + dispatched prompt, appends a `'user'` reply, then dispatches via `spawnDispatchOrResume`.

```text
POST /api/inbox/<id>/reply
Body: {
  option_ids?: string[],
  text?: string,
  dispatch?: boolean,                        // default true; set false to skip dispatch
}

200 → { item, reply, dispatch }
400 → {
  code: 'UNKNOWN_OPTION' | 'TEXT_REQUIRED'
      | 'EXPECTED_ONE_OPTION' | 'EXPECTED_OPTIONS',
  message: string,
  valid_ids?: string[],                       // on UNKNOWN_OPTION
}
404 → { error: 'inbox item not found', id }
409 → { code: 'NO_QUESTION' | 'QUESTION_CLOSED', error, id }
```

**Validation rules (`mcp-server/src/inbox-reply.ts:validateAnswer`):**

| mode | rule |
|---|---|
| `text` | `text` required (non-empty after trim). |
| `single` | Exactly one `option_id`, OR `allow_freeform === true` and freeform text supplied (no options). |
| `multi` | One or more `option_ids`, OR `allow_freeform === true` and freeform text supplied. |

Unknown option ids are always rejected with `UNKNOWN_OPTION` (regardless of mode). Option ids are deduplicated server-side, preserving the order the user sent them.

**Prompt compilation (`compileAnswer`):**

The dispatched prompt is the question's `prompt_template` with substitutions:

| Token | Replaced with |
|---|---|
| `{answer}` | Joined option `value`s (falling back to `label`), or freeform when no options selected. |
| `{option_ids}` | Selected ids joined by `,` (e.g. `"yes,maybe"`). |
| `{freeform}` | Raw freeform text (empty when none). |

Default template (when unset): `{answer}`. So a question with one option `{id: 'yes', label: 'Yes', value: 'YES_SIR'}` answered with `option_ids: ['yes']` dispatches the literal prompt `YES_SIR` to the agent.

**Bubble text** (rendered in the chain) prefers `label` for readability and joins with an em-dash when both options + freeform are supplied (e.g. `"Yes — but only after lunch"`).

**Dispatch outcome.** After spawnDispatchOrResume returns, the server patches the reply with `dispatch: { mode, instance_id?, session_id?, code?, error? }` so the UI can render `→ dispatch` / `→ spawn` / `dispatch failed: <code>` badges next to the user bubble. `mode: 'noop'` means dispatch was skipped (no `session_id` or `dispatch: false` in the request body).

**State transitions.** A user reply on a `'new'` item bumps it to `'open'`. Already-open / done / archived items keep their state. When `close_on_answer` is true (the default), the question's `closed` flag flips to `true` after the first user reply and the SPA hides the form.

### Multi-turn conversations

```
Agent: inbox.upsert(id, kind, source, { question: { prompt: 'Ship?', options: [yes/no], dispatch: { session_id: my_sess } } })
User:  POST /api/inbox/<id>/reply  { option_ids: ['yes'] }
       → server appends user reply, dispatches "yes" to my_sess via spawnDispatchOrResume
       → server marks question.closed = true (close_on_answer default)
Agent: receives the prompt, does the work, then calls
       inbox.reply(id, { reply: { author: 'agent', text: 'Shipped! See the diff →', attachments: [{...}] } })
       inbox.upsert(id, kind, source, {
         question: { prompt: 'Looks good?', options: [...], dispatch: { session_id: my_sess } },
       })   // posts a NEW question, reopening the form
```

For an agent follow-up that doesn't need a new question, `inbox.reply(id, { reply: { author: 'agent', text: '...' }, reopen: true })` clears `question.closed` so the user can answer the *same* question again.

---

## Errors

All inbox tools return the standard MCP `CallToolResult` shape with structured errors when something goes wrong:

| Code | Source | Meaning |
|---|---|---|
| `NOT_FOUND` | `notFound('inbox_item', id)` in `scope.ts` | The id doesn't exist. Returned by `read`, `set_state`, `snooze`, `archive`. Payload: `{ code:'NOT_FOUND', kind:'inbox_item', id }`. |
| `INVALID_SNOOZE_TIME` | `structuredError(...)` in `inbox.snooze` | `until` is not strictly greater than `Date.now()`. Payload includes both the offending `until` and current `Date.now()` in the message string. |
| `VALIDATION_FAILED` | Zod, automatically by the MCP SDK | Any Zod constraint violation (preview too long, body too big, illegal `artifact_id`, illegal state value, invalid type, etc.) before the handler runs. |
| `NOTIFICATIONS_DISABLED` | `inbox.upsert` | Returned in `structuredContent.push_error_code` (the tool itself succeeds — push is best-effort, not a hard requirement). Set when `notifications.enabled !== true` or no VAPID keypair is configured. |

Note that an `inbox.upsert` that successfully creates the item but fails to send any pushes (e.g. all subscribed phones are offline) is **not** a tool failure. The tool surfaces the push errors in `structuredContent.push.errors[]` but `isError` stays false and the item is persisted.

---

## State machine

```
                              ┌─────────────────────────┐
                              │                         │
   ┌────► new ──► open ──┬──► snoozed ──► open ──► done │
   │                     │                              │
upsert                   ├──────────────► archived ─────┘  (terminal)
                         │
                         └──────────────► done           (terminal)
```

- **`new`** is the initial state for every freshly-upserted item.
- **`open`** is the working state — typically set by the SPA the first time the user expands the card.
- **`snoozed`** carries a `snoozed_until` timestamp. The SPA hides snoozed items from the default view.
- **`archived`** and **`done`** are terminal — items in these states stay on disk forever (no GC yet) but are filtered out of the default list.

The store does **not** validate transitions; `inbox.set_state` accepts any legal state for any current state. This is deliberate: the inbox is a notification surface, not a workflow engine. Callers are free to undo an archive by setting back to `open`, or skip directly from `new` to `done`.

---

## Story: a new mail arrives

Walk through the lifecycle of a single PR-review notification, from a watcher trigger firing all the way to the user marking it done from their phone.

### 1. Trigger fires

A cron'd `ado.new-pr-watcher` trigger script wakes up, polls Azure DevOps, and finds a new PR titled `Add OAuth2 support to /auth`. The script's callback calls `inbox.upsert`:

```json
{
  "id": "ado:pr:2401",
  "kind": "pr_review",
  "source": "ado",
  "title": "Add OAuth2 support to /auth",
  "preview": "Replaces the legacy session cookie with a short-lived JWT...",
  "description": "## Summary\n\nThis PR migrates the `/auth` endpoint...\n\n## Files changed\n- `src/auth/jwt.ts` (new)\n- `src/auth/session.ts` (deleted)\n...",
  "description_format": "markdown",
  "attachments": [
    { "artifact_id": "pr-2401-walkthrough", "type": "walkthrough", "title": "PR walkthrough" }
  ],
  "trigger_id": "ado.new-pr-watcher#auth-svc",
  "labels": ["auth", "security"]
}
```

### 2. Body sidecar lands

`inbox.upsert` sees `description !== undefined && description !== ''` and calls `writeInboxBody(globalDir, 'ado:pr:2401', '## Summary\n...', 'markdown')`. The body lands at `<globalDir>/inbox-bodies/ado_pr_2401.md` (atomic tempfile + rename). `descriptionSize` is computed as `Buffer.byteLength(description, 'utf8')`.

### 3. Metadata persists

The patch (with `description_format: 'markdown'`, `description_size: 1847`, `attachments`, `trigger_id`, `labels`) is handed to `InboxStore.upsert('ado:pr:2401', 'pr_review', 'ado', patch)`. The store sees no existing row, mints a fresh `InboxItem` with `state: 'new'`, `created_at: now`, `updated_at: now`, and the patch spread on top. It writes the whole inbox array to `<globalDir>/inbox.json` atomically. `created` comes back `true`.

### 4. SSE fans out

`emitChange('inbox')` fires on the in-process event bus. The HTTP server's `/sse` endpoint pushes `event: change\ndata: {"topic":"inbox"}\n\n` to every connected browser. Each open SPA tab's event listener re-fetches `GET /api/inbox`, gets the enriched list (including the new row), and re-renders. The PR card appears at the top of the list.

### 5. Push fires

`created === true` and `args.notify === undefined`, so `shouldPush === true`. `loadNotificationsConfig` returns `enabled: true` plus a VAPID keypair. The tool builds:

```js
{
  title:  'Add OAuth2 support to /auth',
  body:   'Replaces the legacy session cookie with a short-lived JWT...',  // clipped to 120 chars
  tag:    'inbox:ado:pr:2401',
  url:    '/',
}
```

`sendNotification` reads `<globalDir>/push-subscriptions.json`, encrypts with VAPID, and posts to every endpoint. The user's phone (subscribed via the public devtunnel a week ago) buzzes.

### 6. User opens the SPA from the notification

Tap → SW opens `/` → SPA mounts → inbox tab is selected by default. The user sees the new card. They tap to expand it. The SPA calls `GET /api/inbox/ado:pr:2401`. The HTTP handler in `cli/start.ts`:

- Calls `inbox.read('ado:pr:2401')` for metadata.
- Sees `description_size > 0 && description_format === 'markdown'`.
- Calls `readInboxBody(globalDir, 'ado:pr:2401', 'markdown')` to slurp the sidecar.
- Returns `{ item, description }` JSON.

The SPA renders the full markdown body inline.

### 7. User marks it done

The user reviews the PR in another tab, then taps "Done" on the card. The SPA POSTs to `/api/inbox/ado:pr:2401/done`. The HTTP handler calls `inbox.setState('ado:pr:2401', 'done')`, which spreads `state: 'done'`, persists, and emits `emitChange('inbox')`. The SSE event fans out again; every open tab (including the laptop the user has open in the background) re-fetches `/api/inbox`, and the card disappears from the default-filtered list.

### 8. Body sidecar is still on disk

The done item — and its body sidecar — stay on disk. No GC. If the user un-dones it tomorrow (`inbox.set_state` back to `open`), the card re-appears with its body intact.

---

## Edge cases & gotchas

**1. `kind` and `source` are not patchable in the usual "omitted = unchanged" sense.** They're required on every `inbox.upsert` call and *always* overwritten on update. The `inbox.upsert` schema documents them as `required` precisely because the store's merge is `{ ...existing, ...patch, kind, source, updated_at }`. Callers that want a pure body-only update must still pass the existing `kind` and `source`.

**2. `description_size` reflects the patch, not necessarily disk reality.** If `writeInboxBody` succeeds but a subsequent crash prevents `saveInboxToDisk` from completing, the next process boot will load metadata with `description_size: 0` (or the previous value) while the sidecar still exists on disk. `readInboxBody` is gated by `description_size > 0`, so the orphan stays orphaned until the same id is re-upserted (which deletes the old format's sidecar via `writeInboxBody`'s cross-format cleanup) or the file is manually removed.

**3. Format-only flips rewrite the sidecar.** `inbox.upsert` with **only** `description_format` (no `description`) and a body in the other format will re-read the body, rewrite it in the new format, delete the old-format file, and update `description_size`. This is what makes `clawdevbox` happy when a trigger changes its mind about whether its body is markdown or plain text. The implementation lives in `inbox.ts` lines ~236–253.

**4. `safeBodyBasename` truncates at 200 chars.** Ids longer than 200 chars are still legal in `inbox.json` (no length validation on `id`), but two ids that differ only after the 200th character collide on the body sidecar filename. Don't generate ids that long. The convention `<source>:<kind>:<localId>` keeps you well under.

**5. `inbox.list` paginates strictly by `updated_at desc`.** Pages are not stable across mutations — if the user is paginating through "all items" and a new item arrives, the cursor still works (the cursor id's index is re-located on the new sorted list), but the new item will appear on a previous page, not the current one. The SPA doesn't paginate today; it just fetches `limit: 200` and renders. If a project needs strict pagination semantics, switch to the SQLite kernel.

**6. The `notify: false` escape hatch.** A high-volume trigger that creates many inbox items in quick succession (e.g. backfilling a queue) should pass `notify: false` to suppress per-item push notifications. SSE refreshes still happen — the SPA list updates in real time — but the user's phone doesn't buzz N times.

**7. Push body privacy.** The push body deliberately omits `recipe_instance.id`, `trigger_id`, and `attachments`. These can show internal scheduler/system identifiers that don't belong on a lock screen. The body comes from `preview` first, `agent_message` second, then a neutral `<source> · <id>` fallback only when neither is set.

**8. Push tag collapsing.** Re-upserting the same `id` (e.g. a PR getting a new comment) fires a fresh push with `tag: inbox:<id>`. The OS replaces the existing notification in place rather than stacking. This means a user who didn't open the original buzz will see only the *latest* state — by design, the inbox is a "now" surface, not an event log.

**9. `agent_message` / `agent_tone` are legacy.** They survive in the schema for backwards compat with early prototypes. New code should use `preview` (which is also what the push notification prefers). The SPA still renders `agent_message` as a tinted banner if present, with `agent_tone` controlling the color.

**10. `set_state`'s `reason` is currently a no-op.** It's accepted by the schema and intended to become a message attribution row once the SQLite kernel lands. Until then, the field is silently ignored.

**11. `archive` doesn't cascade to threads.** If a `thread` was spawned against an inbox item and the item is archived, the thread keeps running. The current build leaves this to explicit `thread.cancel`. The `threads;` no-op statement at the bottom of `inbox.archive` is a marker for the future cascade.

**12. In-memory mode discards bodies.** When the store is unbound (test harness or ad-hoc use without `bind()`), `inbox.upsert` still calls `writeInboxBody`/`deleteInboxBody` against the `globalDir` from the workspace — which may not exist or may be a tempdir. `inbox.read` then either finds the file or returns `description: null`. Tests that care about bodies should bind to a real (possibly temp) directory.

**13. Concurrent writers.** Two processes upserting the same id at the same instant can race: each reads `inbox.json`, applies its patch, and writes. The second write wins; the first patch's changes to the metadata are lost (body sidecars are per-id files so they don't race in the same way). The atomic-rename `writeFileAtomic` guarantees no half-written files, but it doesn't provide isolation. In practice this is rare because the stdio MCP server and the HTTP service rarely upsert the same id simultaneously; if it becomes a problem, the SQLite kernel is the answer.

**14. `loadNotificationsConfig` reads two files synchronously per upsert.** Both `<projectDir>/.clawdevbox/config.json` and `<globalDir>/config.json` are re-parsed on every `inbox.upsert` call that runs the push branch. This is cheap (config files are tiny) but means a config change takes effect immediately for the next call — no need to restart the MCP server.
