# `ui.*` MCP tools

The `ui.*` family is the **plugin-facing facade for "tell the user something
happened"**. From a plugin author's perspective there is one verb — fire a
notification — and the runtime has two distinct mechanisms to deliver it:

1. The **SSE bus** (`/api/events`), which keeps every open Clawdevbox SPA tab
   in sync. Tabs subscribe once on load; the server fans out `change` events
   that carry a topic (`inbox`, `recipes`, ...) and the tab re-fetches that
   topic's API endpoint.
2. The **Web Push subsystem** (VAPID + browser PushManager), which delivers
   OS-level notifications to phones / laptops that subscribed via the home
   page — even when the tab is closed or the device is asleep.

A plugin author shouldn't have to know that those are two separate systems
with two separate config blocks. `ui.notify` wraps both behind a single MCP
tool: pass `topic` for an in-app refresh, `push` for a phone buzz, or (most
commonly) both.

Source: [`mcp-server/src/tools/ui.ts`](../../mcp-server/src/tools/ui.ts).
Supporting modules: [`event-bus.ts`](../../mcp-server/src/event-bus.ts),
[`notifications.ts`](../../mcp-server/src/notifications.ts),
[`config.ts`](../../mcp-server/src/config.ts) (`loadNotificationsConfig`).

---

## ChangeTopic catalog

The SSE bus carries one of seven topics defined by the `ChangeTopic` union in
`event-bus.ts`. Each topic maps to a piece of data the SPA already knows how
to re-fetch via its store. Sending a topic is a hint, not a payload: the bus
deliberately ships no data so stale-state bugs are impossible.

| Topic           | SPA store call (`web/src/realtime.ts`)        | Typical use                                                                 |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `inbox`         | `store.refreshInbox()`                        | New/updated inbox item (also fired automatically by `inbox.upsert`).         |
| `recipes`       | `store.refreshRecipes()`                      | Recipe instance state changed — spawned, completed, cancelled.              |
| `agent`         | `store.refreshAgent()`                        | Main agent status changed (idle → running, exit, etc.).                     |
| `tunnel`        | `store.refreshTunnel()`                       | Devtunnel came up / went down / URL changed.                                |
| `notifications` | `store.refreshPush()` (handled out-of-band)   | Push-subscription set changed, or a one-off "something happened" fanout.    |
| `triggers`      | `store.refreshTriggers()`                     | Trigger registered, fired, or its `last_run` updated.                       |
| `approvals`     | `store.refreshApprovals()`                    | A new pending approval landed, or one was resolved.                         |
| `custom`        | (rewritten to `notifications` by `ui.notify`) | Escape hatch — plugins inventing their own panel can still nudge the SPA.    |

`custom` is **not** part of the typed `ChangeTopic` union. `ui.notify`
rewrites it to `'notifications'` before calling `emitChange`, on the
reasoning that the SPA already reacts to the notifications topic by
refreshing the push pill / badge counts — i.e. it's the safest existing
channel for "something happened, take a look".

---

## Tools

### `ui.notify`

**Inputs (`inputSchema`):**

- `topic?` — `enum(['inbox', 'recipes', 'agent', 'tunnel', 'notifications', 'triggers', 'approvals', 'custom'])`.
  When present, emits an SSE `change` event on the in-process bus.
- `push?` — object describing a Web Push notification. When present, also
  fires a browser push to every subscribed device. Shape (matches the
  `NotifyPayload` interface in `notifications.ts`):
  - `title: string` (required, 1–120 chars) — bold one-liner.
  - `body?: string` (≤ 400 chars) — secondary line shown under the title.
  - `url?: string` — path or absolute URL the service worker opens on tap.
    Defaults to `/`.
  - `tag?: string` (≤ 80 chars) — collapse key; newer notifications with
    the same tag replace older ones at the OS level. Defaults to
    `clawdevbox`.
  - `icon?: string` — icon override. Defaults to `/icon.svg`.
  - `require_interaction?: boolean` — keep the notification visible until
    the user dismisses it (used sparingly — bypasses OS DND).

At least one of `topic` or `push` must be supplied. Both is the common
case.

**Returns (`structuredContent`):**

```ts
{
  topic: ChangeTopic | null,           // what was actually emitted (null if topic was omitted)
  push: {                              // null if push was omitted OR notifications disabled
    attempted: number,                 // subscriptions tried
    delivered: number,                 // 2xx from push service
    pruned: number,                    // 404/410 → endpoint removed from store
    errors: string[],                  // human-readable per-endpoint failures
  } | null,
  push_error_code: 'NOTIFICATIONS_DISABLED' | null,
}
```

A short human summary is also written to `content[0].text` (e.g.
`"UI refresh: topic=triggers\nPush: delivered 2/2"`).

**Error codes:**

| Code                     | When it fires                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `NO_EFFECT`              | Neither `topic` nor `push` was supplied. Returned as `isError: true` with `structuredContent.code`. |
| `NOTIFICATIONS_DISABLED` | `push` was supplied but `notifications.enabled` is false or no VAPID keys exist. Returned in `push_error_code`; the SSE emission (if requested) still succeeds. |

**How it works:**

1. **Up-front validation.** If both inputs are absent, return an error
   tool-call result (`isError: true`, `structuredContent.code = 'NO_EFFECT'`).
   This is a strict requirement: a call that does literally nothing would
   silently waste a tool turn.

2. **SSE fan-out.** If `topic` is set, the tool calls
   `emitChange(topic)` from `event-bus.ts`. That writes to a process-local
   `EventEmitter`. The SSE handler in `cli/start.ts` (mounted at
   `/api/events`) subscribes via `onChange` on every incoming request; on
   each emit it writes a `event: change\ndata: {"topic":"..."}` frame to all
   connected SPA tabs. Each tab's `setupRealtime()` (web/realtime.ts) maps
   the topic to a debounced `store.refresh*()` call (80 ms coalescing
   window).

   The `'custom'` value is rewritten to `'notifications'` *before* the
   `emitChange` call, because `ChangeTopic` is a closed union and the bus
   subscribers only know about the canonical topics. Emitting
   `'notifications'` causes the SPA's push pill / badge to refetch, which
   is the safest universal "look at me" signal.

3. **Browser push fan-out.** If `push` is set, the tool calls
   `loadNotificationsConfig({ projectDir, globalDir })` (config.ts) to
   merge the project + global `notifications` blocks. The project layer
   wins where present; the global layer is the fallback so that a single
   `clawdevbox init` run on the account is enough to enable push for every
   project on that machine.

   If the merged config has `enabled: false` or no VAPID keys, the tool
   sets `push_error_code = 'NOTIFICATIONS_DISABLED'` and returns without
   attempting any sends. The SSE emit from step 2 is unaffected.

   Otherwise, the tool calls `sendNotification({globalDir, projectDir},
   vapid, payload)` (notifications.ts). That:
   - reads the subscription list from `<globalDir>/push-subscriptions.json`
     (plus the legacy `<projectDir>/.clawdevbox/push-subscriptions.json`
     for migration);
   - signs the payload with the VAPID private key via `web-push`;
   - fires the encrypted POST to every subscribed endpoint in parallel
     (`Promise.all`);
   - prunes endpoints that respond `404` (Gone) or `410` (revoked) — these
     get written back out so the list shrinks on its own;
   - returns `{attempted, delivered, pruned, errors}` exactly as ends up
     in the `push` field of the response.

   A successful prune triggers an internal `emitChange('notifications')`
   from inside `sendNotification` so the SPA refreshes its subscriber list
   without the plugin having to ask.

4. **Response.** The tool stitches a human-readable summary
   (`content[0].text`) and the structured fields (`topic`, `push`,
   `push_error_code`) and returns. Both effects are independent — a push
   failure with `topic` set still reports `topic: '<emitted>'` in the
   response.

---

## Comparison: `ui.notify` vs `inbox.upsert` vs `notify.send`

These three tools overlap deliberately — they all "tell the user something" —
but they sit at different layers:

| Tool          | Persistent state?                          | SSE emit?            | Push?                | When to use                                                                                                          |
| ------------- | ------------------------------------------ | -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `inbox.upsert`| **Yes** — writes an inbox row + body file | Yes (`inbox`)        | Yes (on create / when `notify: true`) | Anything the user should be able to come back to later — PR review, comment, finished recipe artifact, etc. |
| `ui.notify`   | No                                         | Optional (any topic) | Optional             | One-off "fired and forgotten" events with no row to attach to — webhook arrived, trigger fired, status flipped.       |
| `notify.send` | No                                         | **No**               | Yes (only)           | Lower-level: just the push, no SSE refresh. Plugins should generally prefer `ui.notify` so SPA tabs stay in sync too. |

Rule of thumb for plugin authors:

- If you're about to **create or update an inbox item**, use `inbox.upsert`.
  It already fires the right SSE topic + (on creation) a push for free.
- If the event has **no corresponding inbox row** but the user should still
  see/feel it, use `ui.notify`. Pick the topic that maps to whichever panel
  the user would look at; pass `push` so phones also buzz.
- Only reach for `notify.send` directly if you specifically want a push with
  no in-app side effects — e.g. an end-of-build chime where there's nothing
  in the SPA to refresh.

---

## Story: a trigger fires from a plugin

Concrete walk-through of the canonical use case.

1. A plugin registered an `ado.new-pr-watcher` trigger; the cron daemon
   pings the plugin's webhook every minute. The handler discovers a new
   PR.
2. The handler decides this is one-off news, not an inbox row. It calls
   `ui.notify`:

   ```jsonc
   {
     "topic": "triggers",
     "push": {
       "title": "Trigger fired: ado.new-pr-watcher",
       "body": "Found 2 new PRs in repo/auth-svc",
       "url": "/?tab=triggers",
       "tag": "trigger-ado-new-pr-watcher"
     }
   }
   ```

3. The MCP tool validates the input — both effects are present, so it
   proceeds.
4. `emitChange('triggers')` writes to the in-process `EventEmitter`. The
   SSE handler in `cli/start.ts` (`handleSse`) flushes a
   `event: change\ndata: {"topic":"triggers"}` frame to every connected
   SPA tab. Each tab's `setupRealtime()` matches the topic and
   debounce-schedules `store.refreshTriggers()`, which re-fetches
   `/api/triggers`. The Triggers panel re-renders with the updated
   `last_run` and any new run history rows.
5. In parallel, the tool calls `loadNotificationsConfig` → finds
   `enabled: true` + VAPID in `<globalDir>/config.json` → calls
   `sendNotification`. `web-push` signs and POSTs the payload to every
   endpoint in `<globalDir>/push-subscriptions.json`. The user's phone,
   subscribed yesterday over the devtunnel, buzzes; the notification's
   `tag` ensures it replaces (rather than stacks on top of) the previous
   `ado.new-pr-watcher` notification.
6. The tool returns `{topic: 'triggers', push: {attempted: 1, delivered: 1,
   pruned: 0, errors: []}, push_error_code: null}`. The plugin logs the
   result; nothing more to do.

If the user had revoked their phone's push subscription between yesterday
and now, the push service would respond `410 Gone`, `sendNotification`
would prune that endpoint, write a shrunken `push-subscriptions.json`,
and emit an internal `notifications` SSE event — so the home page's push
pill quietly drops from "1 device" to "0 devices" without the plugin
having to know any of that happened.

---

## Edge cases & gotchas

- **Both effects optional but at least one required.** Calling `ui.notify`
  with no arguments returns `NO_EFFECT`. This is deliberate — a no-op tool
  call is almost always a bug in the caller.
- **`custom` is rewritten to `notifications`.** If you're emitting a topic
  for a panel you invented, you'll need to subscribe to the
  `notifications` topic in your panel's setup code, *or* trigger
  `store.refresh*()` calls some other way. The bus type-system can't be
  extended from plugins.
- **SSE without push is fine; push without SSE is unusual.** A `topic`-only
  call is useful when the change is purely cosmetic (e.g. a tab indicator
  count) — nobody wants a phone buzz for that. A `push`-only call usually
  means you're using the wrong tool; consider `notify.send` if you really
  want push with no SPA refresh.
- **`NOTIFICATIONS_DISABLED` is non-fatal.** The tool still returns success
  (`isError` is not set) and the SSE emit, if requested, still fired. The
  caller can inspect `push_error_code` to decide whether to surface the
  config gap to the user.
- **Coalescing is browser-side, not server-side.** The bus emits every
  call; the SPA debounces refreshes per topic on an 80 ms window. Firing
  `ui.notify({topic: 'triggers'})` ten times in quick succession produces
  ten SSE frames and *one* refresh.
- **Per-endpoint push failures don't fail the call.** Transient 5xx from a
  push service stays in `errors[]` but the subscription is retained. Only
  404/410 prunes the endpoint. `delivered + pruned + errors.length ==
  attempted` always holds.
- **The `tag` field is your friend.** Triggers / cron-style notifications
  should set a stable `tag` (e.g. the trigger registration id) so a slow
  user doesn't accumulate ten copies of the same alert in their tray.
- **The merged config matters for global installs.** A user who runs
  `clawdevbox init` once at the account level (VAPID + `enabled: true`
  in `<globalDir>/config.json`, no per-project config) still gets push
  from MCP-issued calls because `loadNotificationsConfig` merges the two
  layers. The pure HTTP path (`/api/push/*`) uses the same loader, so the
  behavior is consistent.
