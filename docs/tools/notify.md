# `notify.*` MCP tools

The `notify` family is Clawdevbox's lower-level browser push primitive. There
is exactly one tool — **`notify.send`** — and its job is to encrypt a payload
with the workspace's VAPID keypair and POST it to every subscribed device via
the Web Push protocol.

## Relationship to `ui.notify`

`notify.send` is a thin wrapper around
[`sendNotification`](../../mcp-server/src/notifications.ts). It does **one**
thing: fan a payload out to every subscribed device.

The separate **`ui.notify`** tool (see [`ui.md`](./ui.md)) is the higher-level
"tell the user something happened" tool. It can:

1. Emit a typed SSE event on the in-process [`event-bus`][bus] so every open
   SPA tab refreshes the affected panel (inbox, recipes, triggers, …).
2. *Optionally* also call `sendNotification` to buzz the user's phone.

Rule of thumb:

| If you want to…                                          | Use            |
| -------------------------------------------------------- | -------------- |
| Refresh a panel in the SPA                               | `ui.notify`    |
| Buzz the user's phone *and* refresh a panel              | `ui.notify`    |
| Buzz the user's phone *without* refreshing any SPA panel | `notify.send`  |

In practice `notify.send` is what you reach for from agents that don't care
about the SPA — "Sev 3 incident, ping the user's phone" — or when you need to
send a notification whose semantics don't fit any of the standard SSE topics.

Both tools call into the same `sendNotification` function and share the
config + subscription store. The only behavioural difference is that `ui.notify`
adds the SSE emit step.

[bus]: ../../mcp-server/src/event-bus.ts

## Architecture

```
┌─────────────────────────┐
│ clawdevbox init         │  mints VAPID keys → config.json
└───────────┬─────────────┘
            │ writes { publicKey, privateKey, subject }
            ▼
   <globalDir>/config.json     (or <projectDir>/.clawdevbox/config.json)
            │
            ├──── GET /api/push/vapid ─────┐
            │                              ▼
            │                  ┌───────────────────────┐
            │                  │ SPA (clawdevbox web)  │
            │                  │  pushManager.subscribe│
            │                  └────────────┬──────────┘
            │                               │ POST /api/push/subscribe
            │                               ▼
            │                  <globalDir>/push-subscriptions.json
            │                  (legacy: <projectDir>/.clawdevbox/…)
            │
            ▼
  ┌──────────────────────┐    payload    ┌──────────────────────┐
  │  notify.send  (MCP)  │ ────────────▶ │  sendNotification    │
  └──────────────────────┘               │  (web-push lib)      │
                                         └──────────┬───────────┘
                                                    │ encrypted POST
                                                    ▼
                              FCM / Mozilla autopush / Apple APNs
                                                    │
                                                    ▼
                                          Service worker on phone
                                                    │
                                                    ▼
                                            OS notification
```

The MCP tool itself only owns the top-right box — read config, read
subscriptions, fan out. Subscription **creation** happens out-of-band
through the HTTP server in
[`mcp-server/src/cli/start.ts`](../../mcp-server/src/cli/start.ts) (`/api/push/subscribe`).

## Configuration

### VAPID keys

Push services (FCM / Mozilla autopush / APNs) demand a signed JWT proving
that the sender controls a stable identity. That signature uses a P-256
keypair plus a `subject` field (`mailto:` or `https://`). Together those
three pieces are the **VAPID details**.

- **Generation** — [`generateVapidKeys()`](../../mcp-server/src/notifications.ts#L77)
  is a one-liner around `webpush.generateVAPIDKeys()`. It is called by
  `clawdevbox init` when the user opts into notifications and produces
  base64url-encoded public + private keys.
- **Default subject** — `mailto:clawdevbox@localhost`
  (`DEFAULT_VAPID_SUBJECT` in `notifications.ts`).
- **Storage** — written to either `<globalDir>/config.json` (preferred,
  account-wide) or `<projectDir>/.clawdevbox/config.json` (legacy
  project-scope).
- **Public key distribution** — the HTTP server exposes
  `GET /api/push/vapid` which returns `{ enabled, publicKey }`. The SPA's
  push store fetches that, base64url-decodes it into a `Uint8Array`, and
  feeds it to `pushManager.subscribe({ applicationServerKey })`.

### `loadNotificationsConfig`

MCP tools don't get the full `ResolvedConfig` object — they only get a
`Workspace` (i.e. `projectDir` + `globalDir`). To see the same merged
notifications view the HTTP server uses, both `notify.send` and `ui.notify`
call [`loadNotificationsConfig({ projectDir, globalDir })`](../../mcp-server/src/config.ts#L195).

That function:

1. Reads `<projectDir>/.clawdevbox/config.json` (project layer).
2. Reads `<globalDir>/config.json` (global layer).
3. Picks `enabled` from project if set, else global.
4. Picks `vapid` from project if set, else global.
5. Returns `{ enabled: enabled && !!vapid, vapid }` — so `enabled: true`
   in config with no VAPID keys still resolves to disabled.

A missing config file (or a malformed one) does not throw — both reads are
wrapped in `try / catch` and fall through to the next layer.

## Subscription storage

### Canonical: `<globalDir>/push-subscriptions.json`

Subscriptions are signed by the **VAPID private key**, which lives globally.
Storing subscriptions per-project would force every project to maintain its
own list, and a notification fired from project A wouldn't reach a phone
subscribed via project B. Hence subscriptions are global too.

File contents are a JSON array of `PushSubscriptionRecord`:

```ts
interface PushSubscriptionRecord {
  endpoint:     string;   // push-service URL the browser bound to
  keys: {
    p256dh:     string;   // base64url, used to encrypt payload
    auth:       string;   // base64url, HMAC auth secret
  };
  label?:       string;   // free-form, e.g. "Pixel 8 · Chrome"
  created_at:   number;   // unix ms
  last_seen_at: number;   // unix ms — refreshed on every successful send
}
```

The `endpoint` URL is unique within the file and is used as the de-dup key
in `addSubscription` / `removeSubscription`.

### Legacy: `<projectDir>/.clawdevbox/push-subscriptions.json`

Older versions of clawdevbox stored subscriptions per-project. The
migration path is automatic:

- **`listSubscriptions(loc)`** reads **both** files and de-duplicates by
  endpoint. Global entries win; legacy project entries fill gaps.
- **`writeSubscriptions(loc, list)`** always writes to the global path
  and `unlinkSync`s the legacy file if it exists. The unlink is best-effort
  — failure logs a warning and is retried on the next write.
- Any code path that calls `sendNotification` therefore consolidates the
  files on its first run.

### `SubsLocation`

The location is passed around as:

```ts
interface SubsLocation {
  globalDir?:  string;   // preferred (account-wide)
  projectDir?: string;   // legacy (read-for-migration only)
}
```

Both are optional only in the type signature — in practice `notify.send`
always passes both, sourced from `ws.globalDir` / `ws.projectDir`.

### Mutation helpers

| Function                          | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `listSubscriptions(loc)`          | Read + merge global + legacy, de-dup by endpoint.                  |
| `addSubscription(loc, sub)`       | Idempotent insert keyed by endpoint. Bumps `last_seen_at`.         |
| `removeSubscription(loc, ep)`     | Delete by endpoint. Returns `false` if not found.                  |
| `sendNotification(loc, vapid, p)` | Fan out a payload; prune dead endpoints; rewrite the file.         |

Every mutation calls `emitChange('notifications')` so the SPA's push pill
re-renders.

## Tools

### `notify.send`

**Description.** Send a browser push notification to every device that
subscribed via the Clawdevbox home page. Requires
`notifications.enabled: true` plus a VAPID keypair in the merged config.

**Input schema** (Zod flattened):

| Field                 | Type      | Required | Constraints              | Default          | Description                                                                                       |
| --------------------- | --------- | -------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------- |
| `title`               | `string`  | yes      | `min(1)`, `max(120)`     | —                | Bold one-liner shown as the notification title.                                                   |
| `body`                | `string`  | no       | `max(400)`               | `""`             | Body text shown under the title.                                                                  |
| `url`                 | `string`  | no       | —                        | `"/"`            | Path or absolute URL the SW opens on tap.                                                         |
| `tag`                 | `string`  | no       | `max(80)`                | `"clawdevbox"`   | Collapse key — newer notifications with the same tag replace older ones.                          |
| `icon`                | `string`  | no       | —                        | `"/icon.svg"`    | Icon override.                                                                                    |
| `require_interaction` | `boolean` | no       | —                        | `false`          | Persist the notification until the user dismisses it. Use sparingly — bypasses OS quiet hours.    |

**Success return** (`structuredContent`):

```ts
{
  attempted: number;     // == subscribers in the file
  delivered: number;     // 2xx from the push service
  pruned:    number;     // 404/410 endpoints removed
  errors:    string[];   // "<trunc-endpoint>: <message>" for other failures
}
```

`content[0].text` is a human summary like
`Delivered 2/3; pruned 1 dead endpoint(s)` — or, when no devices are
subscribed,
`No devices subscribed yet. Ask the user to open the clawdevbox home page on their phone and tap Enable notifications.`

**Error return.** Returns `isError: true` with
`structuredContent: { code: 'NOTIFICATIONS_DISABLED' }` and a hint to re-run
`clawdevbox init` if either:

- `notifications.enabled` is false, **or**
- no VAPID keypair is present in either config layer.

**What it does.** Reads the merged notifications config, looks up every
subscribed device under `<globalDir>/push-subscriptions.json` (plus the
legacy project file), and dispatches a Web Push message to each via the
[`web-push`](https://www.npmjs.com/package/web-push) npm package. Dead
endpoints are pruned from the file in the same call.

**How it does it.** From
[`mcp-server/src/tools/notify.ts`](../../mcp-server/src/tools/notify.ts):

1. **Config check** — `loadNotificationsConfig({ projectDir, globalDir })`.
   Fail fast with `NOTIFICATIONS_DISABLED` if not enabled or no VAPID keys.
2. **Send** — call
   `sendNotification({ globalDir, projectDir }, vapid, payload)` in
   [`notifications.ts`](../../mcp-server/src/notifications.ts).
3. Inside `sendNotification`:
   - `listSubscriptions(loc)` reads + merges + de-dups the two files.
   - If the list is empty, return early with `{ attempted: 0, delivered: 0, pruned: 0, errors: [] }`.
   - `webpush.setVapidDetails(subject, publicKey, privateKey)` configures
     the lib (it caches this on the module).
   - Serialise the payload into a fixed shape with defaults baked in
     (`url: "/"`, `icon: "/icon.svg"`, `tag: "clawdevbox"`,
     `body: ""`, `require_interaction: false`).
   - `Promise.all` over every subscription; for each one
     `webpush.sendNotification({ endpoint, keys }, body, { TTL: 3600 })`:
     - 2xx — increment `delivered`, bump `last_seen_at` in memory.
     - 404 or 410 — add endpoint to `dead[]`, increment `pruned`.
       *(404 = endpoint gone, 410 = subscription revoked. Both mean
       "permanently dead — stop trying".)*
     - any other error — append a truncated `"<endpoint>: <msg>"` line to
       `errors[]`, log a warning. The subscription is **kept** so a
       transient push-service outage doesn't lose phones.
   - If `dead` is non-empty, rewrite the file without those endpoints.
     Otherwise rewrite anyway to flush the refreshed `last_seen_at`
     timestamps and absorb the legacy-file migration.
   - `emitChange('notifications')` on any mutation so the SPA re-renders.
4. Format the human summary and return.

## Payload reference

### `NotifyPayload` (TypeScript)

```ts
interface NotifyPayload {
  title:                string;   // required, 1–120 chars
  body?:                string;   //          0–400 chars
  url?:                 string;   // default "/"
  tag?:                 string;   // default "clawdevbox", 0–80 chars
  icon?:                string;   // default "/icon.svg"
  require_interaction?: boolean;  // default false
}
```

### On-the-wire shape (after defaults applied)

```json
{
  "title": "PR #1234 is ready to merge",
  "body":  "all checks green; 1 approval",
  "url":   "/inbox#item-7",
  "icon":  "/icon.svg",
  "tag":   "ado-pr-1234",
  "require_interaction": false
}
```

This object is what the service worker sees in
[`pwa-assets.ts`](../../mcp-server/src/pwa-assets.ts) and turns into a
native `Notification(title, { body, data: { url }, icon, tag, requireInteraction })`.

### Field semantics

| Field                 | Notes                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`               | Always shown bold on a single line. Truncated by the OS if too long (~80 chars on most platforms).                                                                                                                                                                   |
| `body`                | Wraps to ~2 lines on iOS, ~3 on Android. Empty string is fine — the title alone shows.                                                                                                                                                                               |
| `url`                 | Passed to the SW as `event.notification.data.url`. On tap the SW calls `clients.openWindow(url)` or focuses an existing tab. Relative paths are resolved against the home origin (devtunnel URL when one is up).                                                     |
| `tag`                 | Collapse key. Two pushes with the same tag display as one — the second replaces the first. Use unique tags per subject (`ado-pr-1234`, `incidents-552-mitigated`) to avoid overwriting unrelated pushes. Default `clawdevbox` is intentional so noisy code self-collapses. |
| `icon`                | Path inside the SPA bundle, served from the HTTP server. Absolute https URLs work too.                                                                                                                                                                               |
| `require_interaction` | True keeps the notification on screen until the user dismisses it (Android). On iOS this is a no-op — iOS always auto-dismisses banners. Use sparingly.                                                                                                              |

## Edge cases & gotchas

### iOS Safari requires the page to be installed as a PWA

`PushManager.subscribe` throws `NotAllowedError` on iOS unless the page is
running in `display-mode: standalone` — i.e. the user has tapped
**Share → Add to Home Screen** and opened the resulting icon.

The detection lives in `requiresIosPwaInstall()` on the SPA
([`mcp-server/web/src/stores/ui.ts`](../../mcp-server/web/src/stores/ui.ts)):

```ts
const standalone =
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
return !standalone;
```

This check is purely SPA-side — `notify.send` itself doesn't know or care
how a subscription got into the file. But it's worth being aware of when
the user reports "I see no subscribers" — the most likely cause is they
opened the home page in mobile Safari and never installed it.

### Dead-endpoint pruning is mutation-on-read

Pruning is a side effect of `sendNotification`, not a periodic GC. If you
never call `notify.send` (or `ui.notify` with a `push` payload), dead
subscriptions accumulate forever. This is fine — they're cheap — but it
means the `subscriberCount` reported by `/api/push/status` can over-count
until the next send.

The pruning rules are:

- **HTTP 404** (Endpoint Gone) → prune.
- **HTTP 410** (Subscription Revoked) → prune.
- **Any other error** (4xx, 5xx, network) → keep, count in `errors[]`.
  A push service can return 503 during deploys; we don't want to nuke
  every subscription because of a transient outage.

### Subscriptions outlive VAPID keypair rotation — sort of

The `endpoint` URL the browser hands back from `pushManager.subscribe`
includes a hash of the public key it was subscribed with. If you rotate
the VAPID keypair (e.g. by deleting `config.json` and re-running
`clawdevbox init`), every existing subscription becomes invalid and the
next send prunes them en masse. There is no automated re-subscription —
users have to tap **Enable** again on each device.

### The HTTP push API is unauthenticated

`/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/status`,
`/api/push/vapid`, and `/api/push/test` do **not** require the bearer token
that `/mcp` does. This matches the rest of the home-page API surface
(loopback-only by default). When exposed over a devtunnel, anyone with the
URL can subscribe their device — which is the intended behaviour for
"point your phone at the tunnel URL once and tap Enable".

### `notify.send` is independent of the SSE bus

It does **not** emit a `change` event on any topic. If you want the SPA to
also refresh its push pill / subscriber count alongside a phone buzz, use
`ui.notify({ topic: 'notifications', push: { ... } })` instead.

(That said, the *mutation* of `push-subscriptions.json` inside
`sendNotification` — when an endpoint is pruned or `last_seen_at` is
refreshed — *does* emit `emitChange('notifications')` from inside
`writeSubscriptions`. So pruning is visible in the UI even if the caller
didn't ask for an SSE fan-out.)

### Per-send file rewrite is unavoidable

Every successful call to `sendNotification` rewrites the subscriptions
file, even when no endpoint died. That's because `last_seen_at` is updated
on each successful send. If you have hundreds of subscribers and a tight
send loop, this becomes an O(N²) cost — but in practice clawdevbox tops
out at a handful of devices per user, so the cost is negligible.

### `subject` must look like a URL or mailto

`webpush.setVapidDetails(subject, ...)` validates the subject and throws
if it's not a valid `mailto:` or `https://` URI. The default
`mailto:clawdevbox@localhost` is intentionally fake — push services accept
it. If you customise it, keep the scheme.

### What `notify.send` does **not** do

- It does **not** validate subscription cryptographic keys before
  attempting to send — that's the push service's job.
- It does **not** retry failed sends. The `web-push` library does no
  built-in retry either. If you need durability, wrap the call.
- It does **not** schedule, queue, or rate-limit. A loop of
  `notify.send` calls fires immediately and concurrently inside the
  `Promise.all`.
- It does **not** dedupe by content. Two consecutive sends with the same
  title and body will both fire — use `tag` to collapse them on the
  device side.

## See also

- [`ui.notify`](./ui.md) — the SSE-aware wrapper most agents should use.
- [`inbox.upsert`](./inbox.md) — has a built-in `notify` field that wraps
  `sendNotification` for new inbox items.
- [`mcp-server/src/notifications.ts`](../../mcp-server/src/notifications.ts) — the
  `web-push` integration + subscription store.
- [`mcp-server/src/config.ts`](../../mcp-server/src/config.ts) —
  `loadNotificationsConfig` + VAPID schema.
- [`mcp-server/src/cli/start.ts`](../../mcp-server/src/cli/start.ts) — the
  `/api/push/*` HTTP endpoints that handle SPA-side subscribe / unsubscribe.
