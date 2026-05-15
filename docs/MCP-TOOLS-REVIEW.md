# MCP Tools — Documentation Review

This document records issues and inconsistencies uncovered while composing the
[Clawdevbox MCP Tools — Complete Reference](./MCP-TOOLS-REFERENCE.md) from the
12 per-family docs under `docs/tools/`. Findings are evidence-backed —
file:line citations into both the docs and the runtime source — and graded by
severity. See [Methodology](#methodology) for what was actually verified.

## Summary

| Severity  | Count |
| --------- | ----: |
| 🔴 High   |     5 |
| 🟡 Medium |    12 |
| 🟢 Low    |     8 |
| **Total** |    25 |

| ID    | Severity | Title                                                                       | Category |
| ----- | -------- | --------------------------------------------------------------------------- | -------- |
| F-001 | 🔴 High   | `recipe.delete` and `skill.delete` skip `validateId` — limited path traversal | C        |
| F-002 | 🔴 High   | `/api/inbox/*` auth is loopback-only but undocumented in `inbox.md`         | D        |
| F-003 | 🔴 High   | `trigger.fire` is a no-op stub but appears live in the schema               | D        |
| F-004 | 🔴 High   | `recipe.upsert` / `recipe.delete` emit no SSE event for recipe authoring    | C        |
| F-005 | 🔴 High   | Renderer `source_id` (read) vs `sourceId` (list) — wire-shape inconsistency | C        |
| F-006 | 🟡 Medium | Two docs claim `notifications` SSE emit on every send; source only emits on prune | B        |
| F-007 | 🟡 Medium | `inbox.set_state` accepts `reason` but never writes it anywhere             | B        |
| F-008 | 🟡 Medium | `inbox.archive` references the `threads` global as a "future-cascade marker" — confusing dead code | C        |
| F-009 | 🟡 Medium | `validateId` not applied uniformly across `recipe.*` / `skill.*` (cross-ref of F-001) | A        |
| F-010 | 🟡 Medium | `thread.wake`'s `UNKNOWN_THREAD_STATE` is unreachable in single-threaded Node | C        |
| F-011 | 🟡 Medium | `thread.cancel` has no cycle guard; `childIndex` is monotonic               | C        |
| F-012 | 🟡 Medium | `inbox.read` cannot distinguish "missing sidecar" from "no body"            | C        |
| F-013 | 🟡 Medium | `artifact.list` silently ignores unknown `workspace_id`                     | D        |
| F-014 | 🟡 Medium | `inherit_plugins` is a no-op but `workspaces-store.ts:331` still gates on `callerProjectDir` | B/C |
| F-015 | 🟡 Medium | `approvals` are in-process only; survives no restart but has no SSE topic at all | D |
| F-016 | 🟡 Medium | `notify.send` silently doesn't fire the `notifications` SSE topic after sends | A/B |
| F-017 | 🟡 Medium | `triggers.json` corruption fails silently to an empty list                  | C        |
| F-018 | 🟢 Low    | `tools/notify.ts` has a stale comment about reading config from project-only | B        |
| F-019 | 🟢 Low    | `inbox.upsert` description rewrites `kind` and `source` on every update      | C        |
| F-020 | 🟢 Low    | `recipe.list_running` returns no error when terminal-server is down          | D        |
| F-021 | 🟢 Low    | `workspace.get` always reports `counts.plugins: 0`                          | A        |
| F-022 | 🟢 Low    | Body-sidecar safe-basename truncation at 200 chars is below any validation cap | C     |
| F-023 | 🟢 Low    | `approval.resolve` `answer` field is `unknown` — no shape validation, by design but easy to misuse | D |
| F-024 | 🟢 Low    | `renderer-registry.ts` source comment vs `RendererEntry.sourceId` documentation mismatch | B |
| F-025 | 🟢 Low    | `recipe.kill` instance lookup is O(workspaces × instances), undocumented   | D        |

Category key (per the task brief):

- **A** — Inter-doc inconsistency (two docs disagree).
- **B** — Doc-vs-source drift (doc claim doesn't match the code).
- **C** — Schema/behaviour bug visible in the source itself.
- **D** — User-facing gap (auth, examples, dead-code stubs).

## Findings

### F-001 🔴 `recipe.delete` and `skill.delete` skip `validateId` — limited path traversal

**Category:** C (schema/behaviour bug)
**Where:**
- `mcp-server/src/tools/recipe.ts:202-213` (recipe.delete handler)
- `mcp-server/src/tools/skill.ts:140-151` (skill.delete handler)
- `mcp-server/src/workspace.ts:247-256` (`recipePath` / `skillPath`)
- `docs/tools/recipe.md` ~line 233 ("`recipe.delete` does *not* validate `id`")
- `docs/tools/skill.md` ~line 303 ("Note: `validateId` is **not** called here")

**What's wrong:** Both delete handlers skip `validateId(args.id)` and forward
the `id` verbatim into `recipePath()` / `skillPath()`, which call
`join(...projectDir, '.clawdevbox', 'recipes', `${id}${RECIPE_EXT}`)`. A
malicious id like `../../sensitive` produces the resolved path
`<projectDir>/.clawdevbox/sensitive.yaml` (or `.md`), which is then guarded
only by `existsSync`. The docs acknowledge the inconsistency but frame it as
"fails safely" — that's true only because of the `existsSync` short-circuit
on a non-matching path. An attacker who *can* predict a writable file inside
`<projectDir>` whose name happens to end in `.yaml` (or `.md`) gets
`unlinkSync` on it. Concretely: `recipe.delete({ scope: "project", id:
"../skills/foo" })` would `unlink` `<projectDir>/.clawdevbox/skills/foo.yaml`
if such a file exists.

**Evidence:**
```ts
// recipe.ts:202-213 — no validateId call before recipePath
async (args) => {
  const guard = ensureWritableScope(args.scope);
  if (guard) return guard;
  const target = recipePath(ws, args.scope as 'project' | 'global', args.id);
  if (!existsSync(target)) return notFound('recipe', args.id);
  unlinkSync(target);
  ...
}
```

**Recommendation:** Add `validateId(args.id)` as the very first check in both
delete handlers (and also in `trigger.unregister`, which already keys on a
different id shape so isn't affected). This brings the surface in line with
`recipe.read` / `recipe.upsert` and closes the traversal even on hostile
inputs.

---

### F-002 🔴 `/api/inbox/*` auth is loopback-only but undocumented in `inbox.md`

**Category:** D (user-facing gap)
**Where:**
- `mcp-server/src/cli/start.ts:224` (`Home page UI (loopback only — bearer auth is on /mcp).`)
- `mcp-server/src/cli/start.ts:304-411` (`/api/inbox*` handlers)
- `docs/tools/inbox.md` (no mention of HTTP auth model)

**What's wrong:** The `inbox.md` doc walks readers through the `GET
/api/inbox/<id>` flow (e.g. line 397 "`GET /api/inbox/ado:pr:2401`") without
noting that **the entire `/api/*` HTTP surface is bound to 127.0.0.1 by
default** and trusts everything that connects. The MCP `/mcp` endpoint
requires a bearer token; `/api/inbox`, `/api/triggers`, `/api/approvals`, and
the push endpoints do not. When exposed via the devtunnel (which the notify
docs encourage for phone subscriptions), this means a leaked tunnel URL gives
the world `inbox.set_state`, `inbox.archive`, etc. via the HTTP endpoints —
*without* MCP credentials.

**Evidence:** `cli/start.ts:224` comment + every handler in 304-486 reads
input and writes state with no `Authorization` header check.

**Recommendation:** Document the loopback-only assumption in `inbox.md` (and
in `notify.md` and `ui.md` for the same `/api/push/*` and `/api/events`
endpoints). Note that exposing the tunnel URL to an untrusted party is
equivalent to giving them inbox-mutation capability. A future hardening
should at minimum require the same bearer token on `/api/*` as on `/mcp`.

---

### F-003 🔴 `trigger.fire` is a no-op stub but appears live in the schema

**Category:** D (user-facing gap)
**Where:**
- `mcp-server/src/tools/trigger.ts:427-453` (handler)
- `docs/tools/trigger.md` ~lines 315-340 (documents the no-op behaviour)
- `docs/tools/trigger.md` ~lines 460-490 (`Cron daemon is **not yet
  implemented**` block)

**What's wrong:** The doc *does* call out the stub clearly inside the "Edge
cases & gotchas" section — but the tool's **description string** (which is
what an LLM sees during tool selection) reads:

```
"Manually fire a registered trigger by id. Returns a queued run_id and logs
the fire intent. A future in-process cron daemon (or external scheduler)
handles the actual webhook POST to `/hooks/<id>`. Works regardless of cron
state — manual fires always succeed."
```

An LLM reading "Works regardless of cron state — manual fires always succeed"
will reasonably assume the trigger *fires*. In reality `trigger.fire` only
calls `logger.info(...)` and returns `status: 'queued'`. There is no
webhook POST, no script load, no `last_run_*` write, no schedule.

**Evidence:**
```ts
// trigger.ts:442-451
const reg = file.registered.find((r) => r.id === args.id);
if (!reg) return notFound('registered_trigger', args.id);
const runId = mintId('run');
logger.info(..., 'trigger.fire queued');
return { ..., status: 'queued' };
```

There is no other code path that consumes `'trigger.fire queued'` log lines.

**Recommendation:** Either (a) rewrite the description to lead with **"NOT
YET IMPLEMENTED — emits a log line and a queued run_id only."**, or (b) move
the tool behind a `--experimental` flag until the cron daemon ships.
Documentation in `trigger.md`'s edge-cases section is the right depth but
the discovery surface (description string + summary table) buries the lede.

---

### F-004 🔴 `recipe.upsert` / `recipe.delete` emit no SSE event for recipe authoring

**Category:** C (schema/behaviour bug)
**Where:**
- `mcp-server/src/tools/recipe.ts:162-213` (handlers)
- `docs/tools/recipe.md` line 213 ("There is **no** `emitChange('recipes')` SSE
  notification on upsert/delete")
- `mcp-server/src/event-bus.ts:17` (`ChangeTopic` includes `'recipes'`)

**What's wrong:** The `recipes` SSE topic only fires from
`recipe-instances-store.ts:writeRecipeInstance` — i.e. when a *recipe
instance* changes status. The CRUD operations themselves (`recipe.upsert`,
`recipe.delete`) do not emit anything, so a SPA tab open on the Recipes panel
displays stale lists until the user does something that triggers a different
event. The doc accurately states this, so it's not doc drift; it's a
behaviour bug in the tool layer.

**Evidence:**
```bash
$ rg "emitChange" mcp-server/src/tools/recipe.ts
# no results
```

`grep` confirmed: `emitChange` does not appear anywhere in the recipe tool
handler. Compare with `inbox.ts` / `trigger.ts` which call it on every write.

**Recommendation:** Add `emitChange('recipes')` at the end of `recipe.upsert`
and `recipe.delete` (after `writeFileAtomic` / `unlinkSync` returns). The
topic already exists; the SPA already subscribes to it. This is a one-line
fix in each handler.

---

### F-005 🔴 Renderer `source_id` (read) vs `sourceId` (list) — wire-shape inconsistency

**Category:** C (schema bug)
**Where:**
- `mcp-server/src/tools/renderer.ts:96-102` (`renderer.read` returns `source_id`)
- `mcp-server/src/tools/renderer.ts:43-54` (`renderer.list` returns full
  `RendererEntry` array including `sourceId`)
- `mcp-server/src/renderer-registry.ts:26-35` (`RendererEntry` type uses `sourceId`)
- `docs/tools/renderer.md` lines 169-177 + 197-211

**What's wrong:** The same logical field — "where this renderer came from" —
is exposed under two different names depending on which tool you call:

| Tool             | Field name  | Casing       |
| ---------------- | ----------- | ------------ |
| `renderer.list`  | `sourceId`  | camelCase    |
| `renderer.read`  | `source_id` | snake_case   |

The doc accurately documents both — but the inconsistency itself is the bug.
Other tools in the same family / repo are uniformly snake_case in their wire
shapes (`view_url`, `workspace_id`, `recipe_instance_id`, `created_at`...),
so `sourceId` in `renderer.list` is the outlier.

**Evidence:**
```ts
// renderer.ts:96-102 (read)
structuredContent: {
  type: args.type,
  source: entry.source,
  source_id: entry.sourceId,         // ← snake_case projection
  file_path: entry.filePath,
  code: source,
},
// renderer.ts:43-54 (list)
structuredContent: { renderers: rows },   // ← rows are RendererEntry, sourceId camelCase
```

**Recommendation:** Normalize `renderer.list` to project each row to
`{ type, source, source_id, file_path, active }` for wire consistency. The
in-memory `RendererEntry` shape can keep its TS-idiomatic `sourceId`; only
the structured output needs renaming.

---

### F-006 🟡 Two docs claim `notifications` SSE emit on every send; source only emits on prune

**Category:** B (doc-vs-source drift)
**Where:**
- `docs/tools/notify.md` ~line 350 ("the *mutation* of `push-subscriptions.json`
  inside `sendNotification` — when an endpoint is pruned or `last_seen_at`
  is refreshed — *does* emit `emitChange('notifications')` from inside
  `writeSubscriptions`")
- `docs/tools/ui.md` ~line 149-151 ("A successful prune triggers an internal
  `emitChange('notifications')` from inside `sendNotification`")
- `mcp-server/src/notifications.ts:283-290`

**What's wrong:** `notify.md` says emit happens for **both** prune and
`last_seen_at` refresh, *and* claims it comes from inside `writeSubscriptions`.
The source shows:

```ts
// notifications.ts:283-290
if (dead.length > 0) {
  const remaining = list.filter((s) => !dead.includes(s.endpoint));
  writeSubscriptions(loc, remaining);
  emitChange('notifications');         // ← only on prune
} else {
  // Re-write to refresh last_seen_at timestamps and migrate from legacy.
  writeSubscriptions(loc, list);       // ← no emit on the no-dead branch
}
```

So:
1. The emit is in `sendNotification`, not `writeSubscriptions` (the
   `addSubscription` / `removeSubscription` helpers do emit, but
   `sendNotification` calls `writeSubscriptions` directly).
2. The `last_seen_at` refresh path does **not** emit. The SPA's subscriber
   list will appear stale until something else fires the topic.

The `ui.md` description is closer to right ("a successful prune") but still
says it's inside `sendNotification`, which is correct.

**Recommendation:** Correct `notify.md` to: "Emit happens from
`sendNotification` itself when at least one endpoint was pruned. The
no-dead-endpoint path (re-writing `last_seen_at` only) does **not** emit, so
SPA subscriber-list counts can stay stale until a subsequent send produces a
prune." Optionally, also emit on the no-dead path for symmetry.

---

### F-007 🟡 `inbox.set_state` accepts `reason` but never writes it anywhere

**Category:** B (doc-vs-source drift)
**Where:**
- `mcp-server/src/tools/inbox.ts:354-373`
- `docs/tools/inbox.md` ~line 264 + line 435

**What's wrong:** The tool **description** in `inbox.ts:358` reads "reason is
recorded as a message attribution." The inbox doc itself correctly calls
this out as a no-op:

> `reason` is accepted but not yet wired — it'll become a message
> attribution on the item once the SQLite kernel lands.

But the **tool description** (what LLMs see during selection) still claims
the field is recorded. An LLM relying on the description will think
`reason: "user clicked away"` is persisted — it isn't.

**Evidence:**
```ts
// inbox.ts:354-373 — no use of args.reason anywhere
async (args) => {
  const item = inbox.setState(args.id, args.state as InboxState);
  if (!item) return notFound('inbox_item', args.id);
  return { ... };
},
```

**Recommendation:** Either implement message attribution (when threads are
durable) or update the tool description string to **"`reason` is accepted
but currently a no-op — reserved for the SQLite kernel landing."**

---

### F-008 🟡 `inbox.archive` references `threads` as a "future-cascade marker" — dead code

**Category:** C (schema bug / dead-code marker)
**Where:**
- `mcp-server/src/tools/inbox.ts:414`
- `docs/tools/inbox.md` ~line 302 + line 437

**What's wrong:**

```ts
// inbox.ts:402-420
async (args) => {
  const item = inbox.archive(args.id);
  if (!item) return notFound('inbox_item', args.id);
  // Threads attached to an archived inbox item could cascade-terminate;
  // current build leaves them running and lets `thread.cancel` clean up
  // explicitly. Add cascade once the SQLite kernel lands.
  threads;                               // ← bare expression statement
  return { ... };
},
```

The bare `threads;` is a no-op expression statement intended only as a
"reminder that we'll need this import later." It produces a TS lint warning
under strict rules and confuses readers (every code reviewer asks "what does
this line do?"). The doc honestly calls it "a marker for the future cascade"
but the marker mechanism is hostile to readers.

**Recommendation:** Replace with a `// TODO(sqlite-kernel): cascade
thread.cancel for threads attached to this item.` comment and remove the
unused import.

---

### F-009 🟡 `validateId` not applied uniformly across `recipe.*` / `skill.*`

**Category:** A (inter-doc inconsistency)
**Where:**
- `recipe.md` ~line 233 (acknowledges delete skips it)
- `skill.md` ~line 303 (acknowledges delete skips it)
- `mcp-server/src/tools/recipe.ts:162-213`
- `mcp-server/src/tools/skill.ts:117-151`

**What's wrong:** Both docs surface "this is a small inconsistency" inside
edge-case sections, but the result is a non-uniform contract: identical id
goes through validation for `read`/`upsert` and bypasses it for `delete`. A
caller cannot predict which error code (`INVALID_ID` vs `NOT_FOUND`) they'll
get for a malformed id, which is bad ergonomics independent of the security
concern in F-001. The docs accept the inconsistency as a fact of life instead
of flagging it as a bug.

**Recommendation:** Either:
1. Add `validateId` to both `delete` handlers (and document the consistent
   contract), or
2. Remove `validateId` from `read`/`upsert` so the inconsistency is gone
   either way (this is worse — read/upsert benefit from early rejection).

Option 1 closes F-001 as a side effect.

---

### F-010 🟡 `thread.wake`'s `UNKNOWN_THREAD_STATE` is unreachable in single-threaded Node

**Category:** C (dead-code path)
**Where:**
- `mcp-server/src/tools/thread.ts:164-178`
- `docs/tools/thread.md` line 320

**What's wrong:**

```ts
// thread.ts:164-178
const t = threads.read(args.thread_id);
if (!t) return notFound('thread', args.thread_id);
...
const updated = threads.setState(args.thread_id, 'running');
if (!updated) {
  return structuredError('UNKNOWN_THREAD_STATE', '...');
}
```

The `setState` call cannot return `undefined` between the `read` (synchronous,
in-memory) and itself (also synchronous, in-memory). There is no `await`,
no other handler runnable. The doc concedes "in single-threaded Node...
unreachable" — and then explicitly keeps the branch "as defence-in-depth for
the SQLite kernel where row deletion will become possible." That's
defensible, but the **error code** `UNKNOWN_THREAD_STATE` will then need
documentation, schema-stability guarantees, and a UI handler. None exist.

**Recommendation:** Either (a) gate the branch behind a comment + assertion
that throws (since it's unreachable, an assertion failure makes the bug loud
when the SQLite kernel makes it reachable), or (b) document
`UNKNOWN_THREAD_STATE` in the user-facing schema today and design the SPA's
behaviour for it. The current state — branch in code, no documented contract
— is the worst of both options.

---

### F-011 🟡 `thread.cancel` has no cycle guard; `childIndex` is monotonic

**Category:** C
**Where:**
- `mcp-server/src/store.ts:cancel` (DFS visit function)
- `docs/tools/thread.md` ~line 273-278

**What's wrong:** The cancel walk does no cycle detection. The thread doc
correctly notes that `parent_thread_id` is set once at spawn and never edited,
so cycles "are impossible" today. But:

1. `appendMessage('cancel', ...)` is called inside the visit, which calls
   `bumpUpdatedAt` etc. — none of which clear cycles either.
2. The doc itself says "the SQLite kernel should add a `seen` set for
   safety" — so the doc and the code agree that the right fix is a seen-set,
   but neither has it today.

The DFS is finite *by construction* under current invariants. Add a seen-set
now to harden against any future code path that lets a thread re-parent.

**Recommendation:** Wrap the visit closure with a `seen = new Set<string>()`
in `ThreadStore.cancel`. Three lines, zero behavioural change today, eliminates
a class of bugs the SQLite migration may unintentionally introduce.

---

### F-012 🟡 `inbox.read` cannot distinguish "missing sidecar" from "no body"

**Category:** C
**Where:**
- `mcp-server/src/tools/inbox.ts:120-145`
- `docs/tools/inbox.md` ~line 154

**What's wrong:** When `description_size > 0` but the sidecar file is
missing on disk, `readInboxBody` returns `null` (gated by `description_size`).
The tool's response shape can't disambiguate this from "no body, never had
one". Both cases produce `description: null`. The doc acknowledges this:

> If the sidecar is missing on disk but the metadata claims a body exists,
> `description` comes back `null` (no error...).

This is OK from an error-handling perspective, but the SPA cannot signal
"body lost" to the user. A user expecting to read a PR review body sees an
empty body without explanation.

**Recommendation:** Add an explicit `body_status: 'present' | 'absent' |
'orphaned'` enum to `inbox.read`'s structured response. 'orphaned' = metadata
claims a body but sidecar is missing. The SPA can render a "body lost"
toast in that case.

---

### F-013 🟡 `artifact.list` silently ignores unknown `workspace_id`

**Category:** D
**Where:**
- `mcp-server/src/tools/artifact.ts:237-244`
- `docs/tools/artifact.md` line 275-277

**What's wrong:**

```ts
// artifact.ts:237-244
const workspaces = args.workspace_id
  ? (() => {
      const w = getWorkspace(root, args.workspace_id);
      return w ? [w] : [];        // ← silent empty
    })()
  : listWorkspaces(root);
```

The doc admits this ("missing — yes, silently") but it's still an error-handling
gap. `artifact.get` returns `ARTIFACT_NOT_FOUND` for a known artifact id under
an unknown workspace; `artifact.list` returns `{ artifacts: [] }` with no
error code. A caller piping `artifact.list` into a follow-up workflow cannot
distinguish "no artifacts" from "you typo'd the workspace id."

**Recommendation:** Return `WORKSPACE_NOT_FOUND` when `args.workspace_id` is
set and doesn't resolve. Aligns with `artifact.add` / `artifact.get` /
`workspace.get`, which all return that code today.

---

### F-014 🟡 `inherit_plugins` is a no-op but `workspaces-store.ts:331` still gates on `callerProjectDir`

**Category:** B / C
**Where:**
- `mcp-server/src/workspaces-store.ts:331-337`
- `docs/tools/workspace.md` line 184 + line 358

**What's wrong:** The workspace store has:

```ts
// workspaces-store.ts:331-337
if (args.inherit_plugins && args.callerProjectDir) {
  // No-op since plugins moved to the global store at <global_dir>/plugins/
  // and are visible to every workspace automatically. We still set
  // `inheritedPlugins` to [] so older clients reading the structured
  // response don't crash on `undefined`.
  inheritedPlugins = [];
}
```

Two notes:

1. The condition gates on `args.inherit_plugins && args.callerProjectDir`.
   `callerProjectDir` is **always** set by `workspace.ts:78`
   (`callerProjectDir: ws.projectDir`), so the second condition is effectively
   tautological. It can mislead a reader into thinking the caller can opt out.
2. The doc accurately calls this a no-op, but the code still reads as if it
   does something — `inheritedPlugins = []` is functionally equivalent to
   `inheritedPlugins = undefined` once you consider the `result.inheritedPlugins
   ?? []` projection in `tools/workspace.ts:95`.

**Recommendation:** Delete the conditional entirely or replace it with a
log-once warning that the user passed a deprecated flag. The structured
response can default `inherited_plugins: []` without any branching.

---

### F-015 🟡 Approvals are in-process only; no SSE topic at all

**Category:** D
**Where:**
- `mcp-server/src/store.ts:373-414` (ApprovalStore)
- `mcp-server/src/tools/approval.ts:23-93`
- `docs/tools/approval.md` ~line 105-107

**What's wrong:** Despite the SSE bus declaring an `approvals` topic
(`event-bus.ts:17`), `approval.request` and `approval.resolve` do **not** call
`emitChange('approvals')`. The doc explicitly notes this:

> No event-bus emit and no `ui.notify` topic fire from this tool — the SPA
> discovers new approvals by polling `/api/approvals`.

So the topic is reserved but never fired. The SPA polls every 2 seconds (per
the `cli/start.ts` source). For a tool whose latency expectation is "the user
just clicked something and is waiting", 2-second polling is too slow.

**Recommendation:** Add `emitChange('approvals')` to both
`approval.request` and `approval.resolve`. The SPA topic subscription already
exists. This is one line in each tool.

---

### F-016 🟡 `notify.send` silently doesn't fire `notifications` SSE topic after sends

**Category:** A / B (inter-doc + drift)
**Where:**
- `mcp-server/src/tools/notify.ts:82-93` (no `emitChange` call)
- `docs/tools/notify.md` ~line 410 ("`notify.send` is independent of the SSE bus")
- `docs/tools/ui.md` ~line 169 (notes `notify.send` doesn't emit; correct)

**What's wrong:** Two docs disagree subtly. `notify.md` (line 410) says
"`notify.send` does **not** emit a `change` event on any topic." But earlier
in the same doc (line 320, "Dead-endpoint pruning is mutation-on-read"), the
prose claims the *mutation* of `push-subscriptions.json` inside
`sendNotification` "*does* emit `emitChange('notifications')`". The latter is
true only on prune (F-006). So a reader following the line-410 advice ("if
you want SPA refresh too, use `ui.notify`") is correct *if* there were no
prune, and accidentally still gets a refresh otherwise. The behaviour is
non-deterministic from the caller's point of view.

**Recommendation:** Either always emit (whether or not pruning happened, in
`sendNotification`), or never emit from `sendNotification` (move the emit to
`addSubscription`/`removeSubscription` only and document the subscription
helpers as the only SSE-emitting paths). Consistent semantics in either
direction.

---

### F-017 🟡 `triggers.json` corruption fails silently to an empty list

**Category:** C
**Where:**
- `mcp-server/src/triggers-store.ts:readTriggersFile`
- `docs/tools/trigger.md` ~lines 49-51 + 510-520

**What's wrong:** `readTriggersFile` swallows parse errors and returns
`{ registered: [] }`. The doc acknowledges this:

> The agent has no way to tell the difference between "nothing is registered"
> and "the file was just truncated by a process crash."

`trigger.list_registered` then returns an empty list with no error. Users
deleting their triggers by editing the file by hand and breaking the JSON
will see all their registrations "disappear" with no diagnostic. The same
hazard applies to `inbox.json` and `<workspacesRoot>/index.json` — both
swallow parse errors.

**Recommendation:** Log a `logger.warn` with the parse error and the file
path on corruption recovery. Surface a `load_errors` field in
`trigger.list_registered` so the agent can detect "your registry file is
broken, here's the JSON error" — analogous to the `load_errors` field
already in `trigger.list_types`.

---

### F-018 🟢 `tools/notify.ts` has a stale comment about config from project-only

**Category:** B
**Where:**
- `mcp-server/src/tools/notify.ts:5-7` (header comment)

**What's wrong:**

```ts
// notify.ts:5-7
* `notify.send` — push a notification to every browser device that
* subscribed via the home page. Reads VAPID keys from
* `<projectDir>/.clawdevbox/config.json`; refuses to send when notifications
* are disabled in config.
```

The actual code (line 64-67) calls `loadNotificationsConfig({ projectDir,
globalDir })` and reads BOTH layers. The doc/comment lies about project-only.
`notify.md` correctly describes the two-layer merge.

**Recommendation:** Update the header comment to reflect the merged
project+global lookup.

---

### F-019 🟢 `inbox.upsert` description rewrites `kind` and `source` on every update

**Category:** C (subtle behaviour)
**Where:**
- `mcp-server/src/tools/inbox.ts:148-211` (schema marks `kind` + `source`
  required)
- `docs/tools/inbox.md` line 417 (correctly calls this out)

**What's wrong:** The doc says `kind` and `source` are "always required, even
on update" and gives the rationale. The Zod schema enforces this. But the
tool **description** doesn't mention it — a caller reading the description
sees a normal-looking partial-update schema with `id`, `kind`, `source`
required and assumes updates need only the changing fields. This causes
confusion: a "fix the preview" call must re-send the original `kind` and
`source`, which the caller may not still have.

**Recommendation:** Add the rationale to the tool description string itself
(not just the doc): "Note: kind and source are required on every call. They
are re-asserted on every update so partial updates must re-send the current
values."

---

### F-020 🟢 `recipe.list_running` returns no error when terminal-server is down

**Category:** D
**Where:**
- `mcp-server/src/tools/recipe.ts:866-880` (approx)
- `docs/tools/recipe.md` ~line 433

**What's wrong:** Sessions are listed via `ptyListSessions()`, but the
returned `view_url` is `null` whenever the terminal-server isn't running.
The caller has no way to distinguish "no terminal server" from "no live
sessions" from a single response. The doc mentions sessions linger for
`EXIT_RETAIN_MS = 10_000` but doesn't note this disambiguation gap.

**Recommendation:** Include a `terminal_server_running: boolean` field in
the response so the caller can choose to retry / surface a hint.

---

### F-021 🟢 `workspace.get` always reports `counts.plugins: 0`

**Category:** A (inter-doc inconsistency)
**Where:**
- `mcp-server/src/workspaces-store.ts:387` (`plugins: 0` hard-coded)
- `docs/tools/workspace.md` line 256-258 (calls it out)
- `docs/tools/plugin.md` (says plugins are global)

**What's wrong:** The doc acknowledges this is intentional, but the field
name (`plugins`) suggests "plugins available to this workspace". An LLM
reading `counts.plugins: 0` will likely conclude there are no plugins, not
"plugins are global and we don't count them here". The field is a
backward-compat artefact; the doc admits this but doesn't suggest deprecating
it.

**Recommendation:** Either drop `plugins` from the structured response and
add a one-time deprecation warning for clients that ask, or rename to
something honest like `plugins_legacy_field: 0`.

---

### F-022 🟢 Body-sidecar safe-basename truncation at 200 chars is below any validation cap

**Category:** C
**Where:**
- `mcp-server/src/inbox-persistence.ts` (`safeBodyBasename`)
- `docs/tools/inbox.md` ~line 423

**What's wrong:** The doc acknowledges:

> `safeBodyBasename` truncates at 200 chars. Ids longer than 200 chars are
> still legal in `inbox.json` (no length validation on `id`)...

So an id of length 250 has a collision risk with any other id sharing its
first 200 safe-encoded characters. The Zod schema for `inbox.upsert.id` has
no `.max()` constraint (line 154). There is no validation gate matching the
truncation.

**Recommendation:** Add `.max(200)` to the `id` field in the
`inbox.upsert` Zod schema and document the limit.

---

### F-023 🟢 `approval.resolve` `answer` field is `unknown` — easy to misuse

**Category:** D
**Where:**
- `mcp-server/src/tools/approval.ts:67-68`
- `docs/tools/approval.md` ~line 124-130 + 211-216

**What's wrong:** The doc explains the design ("intentionally `z.unknown()`")
and the rationale ("some pickers want to attach metadata to a choice"). Fine.
But the consequence is that a misbehaving caller can resolve with literally
any JSON value — including `null`, `[]`, `{}` — and the tool succeeds. The
host UI must validate. The doc calls this out at line 211 ("Renderers that
care should validate against `approval.options[].value` themselves"). It's
documented but the gap remains: there's no opt-in strict-validation mode.

**Recommendation:** Add an optional `validate_answer: boolean` to
`approval.resolve`. When true, the tool checks `answer` against either an
`options[].value` or — when `allow_freetext` was set — that `answer` is a
string. Default `false` preserves backward compat.

---

### F-024 🟢 `renderer-registry.ts` source comment vs `RendererEntry.sourceId` documentation mismatch

**Category:** B
**Where:**
- `mcp-server/src/renderer-registry.ts:31-32`

**What's wrong:**

```ts
// renderer-registry.ts:31-32
  /** Source-specific id: workspace_id, plugin id, or 'builtin'. */
  sourceId: string;
```

The comment says "workspace_id" — but the value set at line 62 is
`ws.projectDir` (an absolute path), not the workspace id (`ws_<base36>...`).
The renderer.md doc says "projectDir" (correct); the source comment says
"workspace_id" (incorrect). A reader of the TypeScript source learns the
wrong thing.

**Recommendation:** Update the TS doc comment to read "projectDir absolute
path, plugin id, or 'builtin'."

---

### F-025 🟢 `recipe.kill` instance lookup is O(workspaces × instances), undocumented

**Category:** D
**Where:**
- `mcp-server/src/tools/recipe.ts:799-866` (approx — `recipe.kill` handler)
- `docs/tools/recipe.md` ~line 396-406

**What's wrong:** The doc covers the killing of the pty but doesn't note that
the `cancelled` status write involves a `listWorkspaces` scan plus
`readRecipeInstance` per workspace. For a user with many workspaces, this is
an O(N) disk read on every kill. The doc mentions O(workspaces) only in the
context of `recipe.instance_info`, not `recipe.kill`.

**Recommendation:** Add a one-liner to the recipe.md edge-cases section:
"`recipe.kill` performs an O(workspaces × instances) scan to locate the
instance row that needs the `cancelled` status. Future versions should
either index running instances or thread the workspace id from
`pty-registry` into the kill handler."

---

## Methodology

The 12 source docs under `docs/tools/` were read end-to-end (some
required multiple `view` passes because of the 50KB tool truncation). For
each family, between three and six high-stakes claims were spot-checked
against the live source files in `mcp-server/src/tools/` and the underlying
stores (`mcp-server/src/store.ts`, `mcp-server/src/notifications.ts`,
`mcp-server/src/renderer-registry.ts`, `mcp-server/src/workspaces-store.ts`,
`mcp-server/src/triggers-store.ts`, `mcp-server/src/artifact-store.ts`,
`mcp-server/src/inbox-persistence.ts`). Cross-doc consistency was checked by
keyword search over the `docs/tools/` folder for shared concepts (scope
chain, `inherit_plugins`, push subscription paths, `validateId`,
`emitChange`, `findArtifact`, project pseudo-workspace, `.clawdevbox/` paths).

What was NOT verified:

- The actual runtime behaviour of any tool (this is a static review only).
- The web SPA's consumption of SSE topics — claims about
  `store.refreshInbox()` / `store.refreshTriggers()` were taken at face value
  from `notify.md` / `ui.md`.
- The hostable-tools subsystem (`hosted.ts`) — no docs were submitted for it,
  so it's out of scope.
- The `tunnel`, `main-agent`, and `service` modules — referenced from docs
  but not part of the 12 tool families.

## Out of scope

A few interesting threads I noticed but did not investigate deeply:

- **`recipe.run`'s `mcpSecret` lifecycle.** The fresh 16-byte secret per
  spawn is good hygiene, but it is written to `.mcp.json` in plaintext. On
  Windows that file may be world-readable depending on the user's ACLs.
  Worth a security review pass independent of this doc audit.
- **`pty-registry.ts` ring-buffer size (256 KiB).** Hard-coded constant
  with no override; agents producing dense output (a large `npm install`)
  can flush their initial scrollback before a viewer attaches.
- **`approval.options[].value` URL safety.** Values flow through
  `JSON.stringify` to the SPA but the SPA's renderer may interpolate them
  into the DOM. Not audited here.
- **`triggers.json` schema migration story.** No version field; future
  schema changes will need a migration path that doesn't exist today.
- **`hosted.ts`-loaded tools' isolation.** Plugin tool modules run in the
  same Node process as the MCP server (no VM, no separate worker). A
  malicious plugin owns the process. The docs don't address this trust
  model.
