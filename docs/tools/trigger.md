# `trigger.*` MCP tools

The trigger surface is the kernel that turns plugin-declared **capabilities**
(trigger TYPES) into concrete, addressable **registered instances**
(`<type_id>#<key>`) that an external scheduler can later fire. The MCP tools
here only read and mutate metadata — they never spawn cron tickers, post
webhooks, or run scripts. All of that is the job of the (not-yet-built) cron
daemon. See [Edge cases & gotchas](#edge-cases--gotchas) for the long list.

The implementation lives in:

- `mcp-server/src/tools/trigger.ts` — the eight MCP tools below.
- `mcp-server/src/triggers-store.ts` — disk shape + atomic writer + id minter.
- `mcp-server/src/workspace.ts` — trigger-type discovery at workspace boot.
- `mcp-server/src/validators.ts` — `validateTriggerParams` + `isValidCronExpression`.
- `mcp-server/src/event-bus.ts` — `emitChange('triggers')` for SSE fan-out.

## Filesystem layout

```
<projectDir>/.clawdevbox/triggers.json     ← registered instances (this file)
<globalDir>/plugins/<plugin_id>/plugin.yaml ← TYPE declarations live here
```

`triggers.json` has exactly one top-level key:

```jsonc
{
  "registered": [
    {
      "id": "ado.new-pr-watcher#auth-svc",
      "type": "ado.new-pr-watcher",
      "params": { "repo": "auth-svc" },
      "cron": null,                    // null=inherit, "<expr>"=override, false=disable
      "enabled": true,
      "subscriber_thread_id": null,
      "expires_at": null,
      "once": false,
      "registered_at": 1715380000000,
      "state": { "repo": "auth-svc" },
      "last_run_at": null,
      "last_run_status": null,
      "last_run_error": null
    }
  ]
}
```

Reads of a missing or corrupt `triggers.json` return `{ registered: [] }` —
`readTriggersFile` swallows parse errors deliberately so a stray newline never
takes down the SPA. Writes go through `writeFileAtomic` (tempfile + rename) and
then fire `emitChange('triggers')` so any SSE subscriber (the SPA, primarily)
re-fetches `/api/triggers`.

## Two-layer model: types vs registered instances

| Layer | Source of truth | Owned by | Mutated by | Shape |
|---|---|---|---|---|
| **Trigger TYPE** | `plugin.yaml`'s `provides.trigger_types[]` | the plugin author | only `plugin.install` / `plugin.update` (read-only via `trigger.*`) | `RegisteredTriggerType` in `workspace.ts` |
| **Registered instance** | `<projectDir>/.clawdevbox/triggers.json` | the agent / user | `trigger.register` / `.unregister` / `.update_params` / `.enable` / `.disable` | `RegisteredTrigger` in `triggers-store.ts` |

Types live in `ws.triggerTypes: Map<id, RegisteredTriggerType>`, populated once
at workspace boot by `reloadPluginRegistry()` (`workspace.ts`). Two-phase load:

1. Walk `<globalDir>/plugins/*/plugin.yaml`, validate, and populate
   `ws.plugins`.
2. For every **enabled** plugin (sorted by id, deterministic), append each
   `provides.trigger_types[]` entry into `ws.triggerTypes`. ID collisions
   across plugins go to `ws.triggerTypeErrors[]` — **first plugin wins**, the
   rest are dropped and surfaced through `trigger.list_types`' `load_errors`
   field.

A `RegisteredTriggerType` carries everything from the manifest plus
`source_plugin_id`, `scope: 'plugin:<id>'`, and `file_abs` (the resolved
absolute path of the trigger script). The TYPE's interesting fields:

- `parameters[]` — schema (name, type, required, default, description) consumed
  by `validateTriggerParams`.
- `default_cron` — inherited by registrations whose `cron` is `null`.
- `identity_param` — drives the `register` id-minting strategy (see below).
- `accepts_webhook` — informational; the agent reads it to decide whether
  webhook-only firing is supported.
- `binds_callback_to_recipe` **xor** `binds_callback_to: 'thread_resume'` —
  what to do when this trigger fires. Mutually exclusive (enforced by the
  manifest validator).

Registrations are concrete bindings. The fields you don't see on a TYPE that
appear here: `enabled`, `subscriber_thread_id` (hot-trigger thread binding),
`expires_at` (unix-ms TTL), `once` (self-delete after first success),
`registered_at`, `state` (initialized from `params`; the cron daemon writes
back here), and the `last_run_*` triple.

## Tools

All tools return a `CallToolResult` with `content[0].text` (one-line human
summary) plus `structuredContent` (machine-readable payload). Error responses
set `isError: true` and put `{ code, message, ...extra }` in
`structuredContent`.

### `trigger.list_types`

Lists every plugin-declared TYPE the server can see, optionally filtered.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `scope` | `string` matching `/^plugin:[a-z][a-z0-9-]*$/` | no | Filter to a single plugin scope (e.g. `plugin:ado`). |
| `search` | `string` (min length 1) | no | Case-insensitive substring filter against `id` or `description`. |

**Returns** `structuredContent`:

```ts
{
  trigger_types: Array<{
    id: string;
    source_plugin_id: string;
    scope: `plugin:${string}`;
    description: string;
    file: string;                   // relative to plugin root
    file_abs: string;               // absolute path of the trigger script
    default_cron: string | null;
    accepts_webhook: boolean;
    identity_param: string | null;
    parameters: TriggerTypeParameter[];
    binds_callback_to_recipe?: string;
    binds_callback_to?: 'thread_resume';
  }>;
  count: number;
  load_errors: Array<{ plugin_id: string; type_id: string; error: string }>;
}
```

**What it does.** Returns a deterministic, alphabetically-sorted snapshot of
`ws.triggerTypes` projected through `projectType()`. The `load_errors` array
forwards `ws.triggerTypeErrors` so the agent can see collisions / missing
script files without re-reading the workspace.

**How it does it.** Reads `ws.triggerTypes` (an in-memory `Map` populated at
boot). No filesystem I/O. No mutation. Filtering is done by iteration over the
projected list. Errors: none — there are no failure modes.

### `trigger.list_registered`

Lists registered instances from `triggers.json`, with cron inheritance
resolved.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `enabled` | `boolean` | no | Filter to only enabled / disabled registrations. |
| `type_id` | `string` (min length 1) | no | Restrict to a single TYPE id. |
| `subscriber_thread_id` | `string` (min length 1) | no | Restrict to hot triggers bound to a specific thread. |

**Returns** `structuredContent`:

```ts
{
  registered: Array<RegisteredTrigger & {
    resolved_cron: string | false | null;
    type_exists: boolean;
  }>;
  count: number;
}
```

**What it does.** Reads the on-disk `triggers.json`, projects each row through
`projectRegistered(reg, ws)` (which resolves `cron === null` against the TYPE's
`default_cron`), and applies the optional filters.

**How it does it.** `readTriggersFile(triggersJsonPath(ws))` →
`projectRegistered` for each row → filter. The `type_exists` field is `false`
when the TYPE has been uninstalled out from under the registration — that's
the cue for the agent to either `unregister` or reinstall the plugin. Errors:
none — corrupt files return an empty list.

### `trigger.register`

Binds a TYPE to concrete `params` and appends a new row to `triggers.json`.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `type_id` | `string` (min length 1) | **yes** | A TYPE id from `trigger.list_types`. |
| `params` | `Record<string, unknown>` | **yes** | Concrete values. Validated against the TYPE's `parameters[]`. |
| `cron` | `string \| null \| false \| ''` | no | See [cron normalization](#cron-normalization). |
| `subscriber_thread_id` | `string` (min length 1) | no | Hot-trigger thread binding. |
| `expires_at` | `number` (unix-ms) | no | Auto-delete after this timestamp. |
| `once` | `boolean` | no | Self-delete after the first successful run. |

**Returns** `structuredContent`:

```ts
{
  id: string;                  // newly minted, e.g. "ado.new-pr-watcher#auth-svc"
  type: string;
  registered: RegisteredTrigger & { resolved_cron, type_exists };
}
```

**Error codes**

| Code | Trigger |
|---|---|
| `TRIGGER_TYPE_NOT_FOUND` | `type_id` is not in `ws.triggerTypes`. |
| `PARAM_VALIDATION` | One or more `params` failed schema validation, or `cron` failed `isValidCronExpression`. The `errors[]` array lists `{ path, code, message }`. |
| `TRIGGER_ALREADY_REGISTERED` | The minted id already exists in `triggers.json`. The response includes the colliding `id`. |

**What it does.** Validates input, mints a stable id, and appends to the
registry. The agent **does not** retain ordering — new rows are appended at
the end of `registered[]`.

**How it does it.**

1. Look up the TYPE in `ws.triggerTypes`. Bail with `TRIGGER_TYPE_NOT_FOUND`
   if missing.
2. Call `validateTriggerParams(type.parameters, args.params)`:
   - Required params missing → `REQUIRED` error.
   - Wrong runtime type (e.g. number where string expected) → `TYPE` error.
   - Absent optional params with declared `default` → defaults are filled in
     on the returned `params` object.
   - Extra params not on the schema → kept verbatim (forward-compatible).
3. Call `normalizeCron(args.cron)` — see below. CRON parsing errors come back
   wearing `PARAM_VALIDATION` clothing with `path: 'cron'`.
4. Mint the id via `mintRegisteredId(type.id, params, type.identity_param)`:
   - If the TYPE declares `identity_param` **and** the (non-empty) param is
     present → `<type_id>#<encodeURIComponent(value)>`.
   - Otherwise → sort the param keys, `JSON.stringify` the entries,
     `sha256` the result, take the first 8 hex chars: `<type_id>#<hash8>`.
5. Read `triggers.json`. If a row with the minted id already exists →
   `TRIGGER_ALREADY_REGISTERED`.
6. Build the row. `enabled: true`, `state` is seeded as a shallow copy of
   `params` (this is what the cron daemon will eventually mutate), and the
   three `last_run_*` fields are `null`.
7. Push the row, call `writeTriggersFile(path, file)` — atomic rename plus
   `emitChange('triggers')`.

### `trigger.unregister`

Removes a registered instance. The TYPE survives.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |

**Returns** `{ id, removed: 1 }`.

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No row with that id. `kind: 'registered_trigger'`. |

**How it does it.** Read → filter the array → write atomically. If the filter
removes nothing, return `notFound('registered_trigger', id)` without touching
disk.

### `trigger.update_params`

Mutates `params` and/or `cron` on an existing registration **without**
remitting the id — even when the change touches an identity param.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |
| `params` | `Record<string, unknown>` | no | **Replaces** params entirely; re-validated. |
| `cron` | `string \| null \| false \| ''` | no | Replaces cron; same three-state semantics as `register`. |

**Returns** `{ id, registered: <projected row> }`.

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No row with that id. |
| `NO_CHANGES` | Neither `params` nor `cron` was supplied. |
| `TRIGGER_TYPE_NOT_FOUND` | Can't re-validate `params` because the TYPE has been uninstalled. (Only fires if `params` is supplied; cron-only updates are fine on orphaned rows.) |
| `PARAM_VALIDATION` | `params` failed schema validation, or `cron` is invalid. |

**How it does it.** Find the row by id. Reject `NO_CHANGES` if both fields are
absent. If `params` is supplied, re-run `validateTriggerParams` against the
**current** TYPE (which is why an uninstalled plugin makes this fail). Cron is
re-normalized. The row is rebuilt via spread + override and written back. The
id is **not** recomputed — see [Edge cases](#edge-cases--gotchas) for why this
matters when changing an identity param.

### `trigger.enable` / `trigger.disable`

Flip the `enabled` flag.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |

**Returns** `{ id, enabled: true | false }`.

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No row with that id. |

**What it does.** Pure metadata write. Disabled rows survive on disk and stay
visible in `trigger.list_registered` — the cron daemon is expected to skip
them, but `trigger.fire` ignores the flag (manual fires always work).

### `trigger.fire`

Manually queues a fire. **Today this only writes a log line.**

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |
| `payload` | `unknown` | no | Free-form data forwarded to the eventual webhook POST. |

**Returns** `{ id, type, run_id, status: 'queued' }`, where `run_id` is minted
via `mintId('run')` (`run_<rand36>`).

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No row with that id. |

**What it does.** Looks up the registration, mints a `run_id`, calls
`logger.info({ triggerId, triggerType, runId, payload }, 'trigger.fire queued')`,
and returns. **No webhook is dispatched, no script is executed, no state is
mutated, no `last_run_*` field is updated.** That work is reserved for the
not-yet-implemented in-process cron daemon. The `status: 'queued'` response is
forward-compatible with the eventual implementation.

## cron normalization

`normalizeCron(raw)` collapses the four input shapes into a tri-state stored
field:

| Input | Stored on disk | Resolved by `projectRegistered` |
|---|---|---|
| `undefined` | `null` | TYPE's `default_cron` (may itself be `null`) |
| `null` | `null` | TYPE's `default_cron` |
| `false` | `false` | `false` — cron disabled (webhook/manual only) |
| `''` (empty string) | `false` | `false` — cron disabled |
| valid cron string | the string | the string |
| invalid cron string | — | error: `CRON_INVALID` |
| any other type | — | error: `cron must be a string (override), null (inherit), or false (disable).` |

Validity is checked by `isValidCronExpression` (`validators.ts`): a 5- or
6-field expression where every field matches `/^[*?\/0-9,A-Za-z-]+$/`. The
check is intentionally lenient — full semantic validation (e.g. "is day-30
valid in February") happens lazily in `cron-utils.ts` when the SPA computes
`nextRunAfter`.

`cron-utils.ts` is **not** used by the MCP tools themselves; it's a
per-request enrichment helper for the `/api/triggers` HTTP endpoint. The tool
surface deliberately returns the raw `resolved_cron` and leaves humanization
(`cronstrue`) and next-fire computation (`cron-parser`) to the consumer.

## Story: from plugin manifest to fired trigger

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Plugin author declares a TYPE in plugin.yaml                     │
│                                                                     │
│    provides:                                                        │
│      trigger_types:                                                 │
│        - id: ado.new-pr-watcher                                     │
│          file: triggers/new-pr-watcher.ts                           │
│          default_cron: "*/5 * * * *"                                │
│          identity_param: repo                                       │
│          binds_callback_to_recipe: handle-new-pr                    │
│          parameters:                                                │
│            - { name: repo, type: string, required: true }           │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  plugin.install copies plugin
                                  │  into <globalDir>/plugins/<id>/
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Workspace boot — reloadPluginRegistry() in workspace.ts          │
│                                                                     │
│    Phase 1: ws.plugins from <globalDir>/plugins/*/plugin.yaml       │
│    Phase 2: ws.triggerTypes from the enabled plugins (alphabetical) │
│                                                                     │
│    Collisions go to ws.triggerTypeErrors[]; first plugin wins.      │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  agent calls trigger.list_types
                                  │  → sees ado.new-pr-watcher
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Agent calls trigger.register                                     │
│                                                                     │
│    { type_id: "ado.new-pr-watcher", params: { repo: "auth-svc" } }  │
│                                                                     │
│    • validateTriggerParams → ok (defaults filled in)                │
│    • normalizeCron(undefined) → null (inherit default_cron)         │
│    • mintRegisteredId → "ado.new-pr-watcher#auth-svc"               │
│      (identity_param is "repo", value URL-encoded)                  │
│    • collision check against triggers.json                          │
│    • build row, push, writeFileAtomic                               │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  writeTriggersFile fires emitChange
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. emitChange('triggers') over event-bus.ts                         │
│    Every SSE subscriber (the SPA) gets { topic: 'triggers' }        │
│    The SPA's Triggers panel re-fetches /api/triggers and re-renders │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  later: cron daemon or webhook
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. trigger.fire(id) — TODAY this only logs.                         │
│                                                                     │
│    • look up the registration                                       │
│    • mintId('run') → "run_xy7p4qs2"                                 │
│    • logger.info(..., 'trigger.fire queued')                        │
│    • return { run_id, status: 'queued' }                            │
│                                                                     │
│    No webhook POST. No script execution. No last_run_* mutation.    │
│    The in-process cron daemon that does the rest is deferred.       │
└─────────────────────────────────────────────────────────────────────┘
```

## Edge cases & gotchas

### Identity-param collision handling

`mintRegisteredId` is purely deterministic — two `register` calls with the
same `identity_param` value get the **same** id. The second one will hit the
`TRIGGER_ALREADY_REGISTERED` branch and return the structured error pointing
at the existing id. The agent's intended remedy is in the error message:
"Use `trigger.update_params` or `trigger.unregister` first."

When `identity_param` is declared but the param value is empty (`null`,
`undefined`, or `''`), the id minter **falls through** to the hash strategy
rather than producing `type_id#` with an empty suffix. This is mostly a
robustness guard — `validateTriggerParams` will already have rejected a
missing required param before id minting runs, so the fallback only matters
when the identity param is optional.

### `trigger.update_params` does **not** re-mint the id

When you change an identity param (e.g. `repo: auth-svc` → `repo: billing`),
the registered row's id stays `ado.new-pr-watcher#auth-svc`. This is by
design: the id is a stable handle that external systems (webhook URLs,
subscriber threads) may already be holding. If you want a fresh id, the only
correct flow is `trigger.unregister` followed by `trigger.register`. The tool
description calls this out explicitly.

### Hash-based ids are not RFC-8785-stable

Hash-based id minting sorts top-level keys but uses `JSON.stringify`'s
natural ordering for nested objects/arrays. If a plugin declares a TYPE
without `identity_param` and its `params` schema includes nested object
values whose key order differs between callers, two semantically-identical
registrations could produce different ids. The fix (canonical JSON per
RFC 8785) is documented as a future upgrade in `mintRegisteredId`'s docstring;
for the MVP every shipped TYPE either declares `identity_param` or has flat
params.

### Cron daemon is **not yet implemented**

This is the big one. None of the following exist today:

- An in-process timer that wakes on cron boundaries and POSTs to webhooks.
- An external scheduler subscribing to `emitChange('triggers')`.
- Any code path that writes back to `last_run_at` / `last_run_status` /
  `last_run_error`.
- Any code path that actually loads `file_abs` and executes the trigger
  script.
- TTL enforcement for `expires_at`.
- Self-delete after success for `once: true`.
- Hot-trigger wake-up via `subscriber_thread_id`.

`trigger.fire` produces a `run_id` and a log line — that's it. Consumers
treating `status: 'queued'` as "the work is now in flight" will be
disappointed. The shape of `RegisteredTrigger` is deliberately forward-
compatible so the eventual daemon can land without breaking the wire format.

### Type uninstall leaves orphan registrations

`plugin.uninstall` removes a TYPE from `ws.triggerTypes` but does not touch
`triggers.json`. Existing registrations stay on disk; `projectRegistered`
flags them with `type_exists: false`. They cannot be fired (the daemon won't
have a script to run) but **can** still be `trigger.unregister`ed,
`trigger.disable`d, and even `trigger.update_params({ cron })`-ed
(cron-only updates skip the TYPE lookup). Updates that change `params`
will fail with `TRIGGER_TYPE_NOT_FOUND` because the param schema is gone.

### `disable` ≠ "off"; `cron: false` ≠ "stopped"

Two independent kill switches:

- `enabled: false` — the eventual cron daemon must skip this row, but
  `trigger.fire` ignores the flag (manual fires always succeed).
- `cron: false` (or `''`) — this registration never fires on a schedule, but
  it may still fire via webhook (if `accepts_webhook`) or manual fire.

To disable a trigger *completely*, set `enabled: false`. To turn off
scheduling but keep the webhook hookable, set `cron: false`.

### `triggers.json` corruption is silent

`readTriggersFile` catches all parse errors and returns `{ registered: [] }`.
This is intentional — a corrupt file should never crash the MCP server — but
it means a partially-written file silently presents as an empty registry. The
agent has no way to tell the difference between "nothing is registered" and
"the file was just truncated by a process crash." Atomic writes
(`writeFileAtomic`) keep this from happening in practice; the safety net is
there for editor crashes and disk-full conditions.
