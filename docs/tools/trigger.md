# `trigger.*` MCP tools

The trigger surface is the kernel that turns plugin-declared and
agent-authored **capabilities** (trigger TYPES) into concrete, addressable
**registered instances** (`<type_id>#<key>`) that the in-process scheduler
+ dispatcher fire on cron, manual fires, and Mode-B callbacks. As of the
trigger-kernel work, `trigger.fire` is **no longer a metadata stub** — it
enqueues a real row into the `fires` table, the dispatcher claims it, and
outputs land on disk under `<workspace>/.clawdevbox/fires/<fire_id>/`. See
[`cron.md`](./cron.md) for the kernel control plane (`/api/cron/*`,
`/api/fires/*`, `/callback/<fire_id>`) and the fire lifecycle diagram.

The surface is now **thirteen** MCP tools — the eight original metadata
tools plus five added in Phases 3-5 for agent-authored templates and
out-of-band test execution:

| Group | Tools |
|---|---|
| TYPE introspection | `trigger.list_types`, `trigger.list_templates` |
| TYPE authoring (agent) | `trigger.create_template`, `trigger.update_template`, `trigger.delete_template` |
| Registration | `trigger.register`, `trigger.unregister`, `trigger.update_params`, `trigger.enable`, `trigger.disable` |
| Execution | `trigger.fire` (stub), `trigger.test` (real) |
| Listing | `trigger.list_registered` |

`trigger.register` accepts **three mutually-exclusive trigger sources**:

1. `type_id` — bind to an existing TYPE (plugin-shipped or agent-authored).
2. `script` + `runtime` — inline one-off; the server mints an auto-template
   under a hidden `_oneoff/<id>/` namespace and registers against it.
3. `script_file` + `runtime` — same, but the script is read from a path
   under `<projectDir>/.clawdevbox/`.

The implementation lives in:

- `mcp-server/src/tools/trigger.ts` — the thirteen MCP tools below.
- `mcp-server/src/triggers-store.ts` — disk shape + atomic writer + id minter.
- `mcp-server/src/template-store.ts` — agent-authored template I/O (project,
  global, and `_oneoff/` scopes) plus the auto-template helpers used by
  `trigger.register`'s one-off path.
- `mcp-server/src/trigger-runner.ts` — script spawn + stdin envelope +
  stdout capture used by `trigger.test` (and, eventually, the cron daemon).
- `mcp-server/src/workspace.ts` — trigger-type discovery at workspace boot.
- `mcp-server/src/validators.ts` — `validateTriggerParams`,
  `validateAgentAuthoredTemplate`, `validateRuntime`,
  `isValidCronExpression`.
- `mcp-server/src/event-bus.ts` — `emitChange('triggers')` for SSE fan-out.

## Filesystem layout

```
<projectDir>/.clawdevbox/triggers.json     ← registered instances (this file)
<globalDir>/plugins/<plugin_id>/.claude-plugin/plugin.json ← TYPE declarations live here
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
| **Trigger TYPE** | three sources (see below) | the plugin author OR the agent | `plugin.install` / `plugin.update` for plugin-shipped; `trigger.create_template` / `.update_template` / `.delete_template` for agent-authored | `RegisteredTriggerType` in `workspace.ts` |
| **Registered instance** | `<projectDir>/.clawdevbox/triggers.json` | the agent / user | `trigger.register` / `.unregister` / `.update_params` / `.enable` / `.disable` | `RegisteredTrigger` in `triggers-store.ts` |

TYPES now come from **three sources**, merged into the single
`ws.triggerTypes: Map<id, RegisteredTriggerType>` registry by
`reloadTypeRegistries()` (`workspace.ts`) at boot and after every
template/plugin mutation. Precedence is **lowest → highest**:

| Precedence | Source | Layout | `scope` field |
|---|---|---|---|
| 1 (lowest) | Plugin-shipped | `<globalDir>/plugins/<plugin_id>/.claude-plugin/plugin.json`'s `clawdevbox.trigger_types[]` | `plugin:<id>` |
| 2 | Global agent-authored | `<globalDir>/trigger-types/<id>/template.yaml` + `trigger.<ext>` | `global` |
| 3 (highest) | Project agent-authored | `<projectDir>/.clawdevbox/trigger-types/<id>/template.yaml` + `trigger.<ext>` | `project` |

If the same `id` appears at multiple precedence levels, the higher-precedence
entry wins; the displaced entries are dropped and surfaced via
`trigger.list_types`' `load_errors`. Within the plugin layer, ID collisions
across plugins are resolved alphabetically (first plugin wins) — same
behaviour as before.

There is also a **hidden** namespace at:

```
<projectDir>/.clawdevbox/trigger-types/_oneoff/<id>/
```

…used by `trigger.register`'s one-off path (inline `script` /
`script_file`). One-off auto-templates are loaded into `ws.triggerTypes`
on demand by `trigger.register` and unloaded by `trigger.unregister`. They
are deliberately **not** browsable via `trigger.list_templates` or
`trigger.list_types` (filtered out by id prefix `local.oneoff.`); they
exist only to back the matching registered row.

Loading happens in two phases:

1. Walk `<globalDir>/plugins/*/.claude-plugin/plugin.json`, validate, and populate
   `ws.plugins`.
2. For every **enabled** plugin (sorted by id, deterministic), append each
   `clawdevbox.trigger_types[]` entry into `ws.triggerTypes`. Then layer the
   global, then project, agent-authored templates on top. ID collisions
   across plugins go to `ws.triggerTypeErrors[]` — **first plugin wins**,
   the rest are dropped and surfaced through `trigger.list_types`'
   `load_errors` field.

A `RegisteredTriggerType` carries everything from the manifest plus
`source_plugin_id`, `scope: 'plugin:<id>'`, and `file_abs` (the resolved
absolute path of the trigger script). The TYPE's interesting fields:

- `parameters[]` — schema (name, type, required, default, description) consumed
  by `validateTriggerParams`.
- `default_cron` — inherited by registrations whose `cron` is `null`.
- `identity_param` — drives the `register` id-minting strategy (see below).
- `accepts_webhook` — informational; the agent reads it to decide whether
  webhook-only firing is supported.

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

Lists registered instances from the `triggers` table, with cron inheritance
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
    // recipe-lineage columns (populated when the trigger was auto-declared
    // by a recipe step — see recipe.steps.update_status):
    recipe_instance_id: string | null;
    recipe_step_id: string | null;
    auto_declared: boolean;             // true iff the row was inserted by a step entry hook
    auto_registered_by_step_id: string | null;  // recipe_steps.id of the declaring step
    // kernel retry policy (per-trigger overrides; spec §6.2):
    max_attempts: number;               // default 3
    backoff_ms: number[];               // default [30000, 120000, 600000]
  }>;
  count: number;
}
```

**What it does.** Reads the `triggers` table, projects each row through
`projectRegistered(reg, ws)` (which resolves `cron === null` against the TYPE's
`default_cron`), and applies the optional filters.

**How it does it.** `readTriggersFile(triggersJsonPath(ws))` →
`projectRegistered` for each row → filter. The `type_exists` field is `false`
when the TYPE has been uninstalled out from under the registration — that's
the cue for the agent to either `unregister` or reinstall the plugin. Errors:
none — corrupt files return an empty list.

The `auto_declared` / `auto_registered_by_step_id` / `recipe_instance_id` /
`recipe_step_id` columns are populated when a recipe step's `triggers[]`
declaration was materialized at step-entry time (see
[`recipe.steps.update_status`](./recipe.md#recipestepsupdate_status)). They
let the dispatcher cascade-disable a step's triggers when the step
transitions to a terminal state.

### `trigger.register`

Binds a trigger source to concrete `params` and appends a new row to
`triggers.json`. Three mutually-exclusive trigger sources (XOR):

1. **`type_id`** — a TYPE already known to the server (plugin-shipped or
   agent-authored).
2. **`script`** + **`runtime`** — an inline one-off. The server mints
   `local.oneoff.<rand>`, writes a hidden auto-template under
   `.clawdevbox/trigger-types/_oneoff/<id>/`, loads it into
   `ws.triggerTypes`, and registers against it.
3. **`script_file`** + **`runtime`** — same as `script`, but the script is
   read from a path that **must** resolve under
   `<projectDir>/.clawdevbox/`.

For the one-off paths, `cron` defaults to `false` (manual/webhook only),
`once` defaults to `true`, `enabled` is `true`, and the auto-template is
configured for hot-trigger thread resume when `subscriber_thread_id` is
supplied.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `type_id` | `string` (min length 1) | XOR | A TYPE id from `trigger.list_types`. |
| `script` | `string` | XOR | Inline script source for a one-off. |
| `script_file` | `string` | XOR | Path under `.clawdevbox/` to read the one-off script from. |
| `runtime` | `'node' \| 'tsx' \| 'python' \| 'bash'` | required when `script` or `script_file` is supplied | Interpreter the runner spawns. |
| `params` | `Record<string, unknown>` | no | Concrete values. Validated against the TYPE's `parameters[]` (which is empty for one-offs). |
| `cron` | `string \| null \| false \| ''` | no | See [cron normalization](#cron-normalization). One-off paths default to `false` when omitted. |
| `subscriber_thread_id` | `string` (min length 1) | no | Hot-trigger thread binding. For one-offs, configures the auto-template for hot-trigger thread resume. |
| `expires_at` | `number` (unix-ms) | no | Auto-delete after this timestamp. |
| `once` | `boolean` | no | Self-delete after the first successful run. Defaults to `true` for one-off registrations, `false` otherwise. |
| `max_attempts` | `integer` (1..100) | no | Override the kernel default of **3** attempts before a fire is moved to `dead`. Per-trigger; the value is stored on the registration row and read by the dispatcher when scheduling retries (spec §6.2). |
| `backoff_ms` | `number[]` (non-empty; each `0..86400000`) | no | Override the kernel default retry ladder of `[30000, 120000, 600000]` ms (30 s → 2 min → 10 min). The dispatcher reads `backoff_ms[attempt - 1]`; if `attempt` exceeds the array length the last entry is reused. |

**Returns** `structuredContent`:

```ts
{
  id: string;                  // newly minted, e.g. "ado.new-pr-watcher#auth-svc"
  type: string;                // resolved TYPE id (for one-offs, "local.oneoff.<rand>")
  registered: RegisteredTrigger & { resolved_cron, type_exists };
  adhoc: boolean;              // true iff this came from `script` or `script_file`
  template_id: string | null;  // the minted auto-template id, when adhoc; else null
}
```

**Error codes**

| Code | Trigger |
|---|---|
| `INVALID_REQUEST` | Zero or more than one of `type_id` / `script` / `script_file` was supplied. |
| `RUNTIME_REQUIRED` | `script` or `script_file` was supplied without `runtime`. |
| `SCRIPT_FILE_OUTSIDE_WORKSPACE` | `script_file` resolved outside `<projectDir>/.clawdevbox/`. |
| `SCRIPT_FILE_NOT_FOUND` | `script_file` resolves under `.clawdevbox/` but no file exists at that path. |
| `TRIGGER_TEMPLATE_WRITE_FAILED` | One-off auto-template was written but could not be re-read (filesystem race / permission). |
| `TRIGGER_TYPE_NOT_FOUND` | `type_id` is not in `ws.triggerTypes`. |
| `PARAM_VALIDATION` | One or more `params` failed schema validation, or `cron` failed `isValidCronExpression`. The `errors[]` array lists `{ path, code, message }`. For one-off paths the auto-template is rolled back when this fires. |
| `TRIGGER_ALREADY_REGISTERED` | The minted id already exists in `triggers.json`. The response includes the colliding `id`. For one-off paths the auto-template is rolled back when this fires. |

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

Removes a registered instance. The TYPE survives **except** for one-off
auto-templates, which are deleted alongside the registration.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |

**Returns** `{ id, removed: 1, oneoff_template_removed: boolean }`.

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No row with that id. `kind: 'registered_trigger'`. |

**How it does it.** Read → filter the array → write atomically. If the
filter removes nothing, return `notFound('registered_trigger', id)` without
touching disk. **Cleanup:** if the row's `type` starts with `local.oneoff.`,
also delete the `_oneoff/<id>/` directory and remove the auto-template
entry from `ws.triggerTypes`. Plugin-shipped and named agent-authored
templates are untouched.

### `trigger.update_params`

Mutates `params` and/or `cron` on an existing registration **without**
remitting the id — even when the change touches an identity param.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |
| `params` | `Record<string, unknown>` | no | **Replaces** params entirely; re-validated. |
| `cron` | `string \| null \| false \| ''` | no | Replaces cron; same three-state semantics as `register`. |
| `max_attempts` | `integer` (1..100) | no | Replace the per-trigger retry cap. Validated by `validateMaxAttempts`. |
| `backoff_ms` | `number[]` (non-empty; each `0..86400000`) | no | Replace the per-trigger retry ladder. Validated by `validateBackoffMs`. |

**Returns** `{ id, registered: <projected row> }`.

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No row with that id. |
| `NO_CHANGES` | None of `params`, `cron`, `max_attempts`, or `backoff_ms` were supplied. |
| `TRIGGER_TYPE_NOT_FOUND` | Can't re-validate `params` because the TYPE has been uninstalled. (Only fires if `params` is supplied; cron-only updates are fine on orphaned rows.) |
| `PARAM_VALIDATION` | `params` failed schema validation, or `cron` is invalid. |
| `INVALID_MAX_ATTEMPTS` | `max_attempts` failed the integer / range check (`1..100`). |
| `INVALID_BACKOFF_MS` | `backoff_ms` failed the array / per-entry range check (non-empty, integers in `[0, 86400000]`). |

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

Manually enqueues a fire for a registered trigger. **DB-backed**: a row is
inserted into the `fires` table with `source = 'manual'` and is picked up
by the dispatcher on the next `pickUp()` cycle. Honors `enabled = false`
the same as cron — manual fires always run.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Registered-instance id. |
| `payload` | `unknown` | no | Free-form data forwarded into the trigger script's stdin envelope (Mode A) and re-presented in the `/callback/<fire_id>` URL contract (Mode B). |

**Returns** `structuredContent`:

```ts
{
  id: string;            // registered trigger id (echoed)
  type: string;          // resolved TYPE id
  trigger_id: string;    // alias of id (for forward-compat with fire-list responses)
  fire_id: string;       // newly minted fire row id; the lookup key for /api/fires/:id
  status: 'queued';
}
```

**Error codes**

| Code | Trigger |
|---|---|
| `NOT_FOUND` | No registered trigger with that id. |

**What it does.** Resolves the registration, calls
`enqueueFire(db, { workspace_id, trigger_id, source: 'manual', scheduled_at:
Date.now(), max_attempts: reg.max_attempts ?? 3, payload })`, logs the
intent, and returns. The dispatcher's bus subscription on `'fires'` wakes
within ~50 ms; outputs are persisted under
`<workspace>/.clawdevbox/fires/<fire_id>/attempt-N/`. To follow the fire to
completion, poll `GET /api/fires/<fire_id>` (see [`cron.md`](./cron.md)).

### `trigger.create_template`

Write a new agent-authored TYPE on disk and load it into `ws.triggerTypes`.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` matching `/^local\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/` | **yes** | Template id. The `local.` prefix is mandatory; this namespace is reserved for agent-authored TYPES (and one-offs at `local.oneoff.*`). |
| `scope` | `'project' \| 'global'` | no, default `'project'` | `project` writes under `<projectDir>/.clawdevbox/trigger-types/<id>/`; `global` writes under `<globalDir>/trigger-types/<id>/`. |
| `description` | `string` (min length 1) | **yes** | Human-readable summary; surfaced via `trigger.list_types`. |
| `runtime` | `'node' \| 'tsx' \| 'python' \| 'bash'` | **yes** | Picks the script extension (`.js`, `.ts`, `.py`, `.sh`) and the interpreter the runner will spawn. |
| `script` | `string` | XOR with `script_file` | Inline script source. |
| `script_file` | `string` | XOR with `script` | Path under `<projectDir>/.clawdevbox/`; the file is **read** and its contents copied into the new template directory. |
| `default_cron` | `string` | no | Inherited by registrations whose `cron` is `null`. Validated by `isValidCronExpression` indirectly through the manifest validator. |
| `identity_param` | `string` | no | Drives id minting in `trigger.register`. |
| `accepts_webhook` | `boolean` | no | Informational; defaults to `true` in projection. |
| `parameters` | `Array<{ name, type, required?, default?, description? }>` | no | TriggerType parameter schema, same shape as plugin-shipped types. |

**Returns** `structuredContent`:

```ts
{
  id: string;
  scope: 'project' | 'global';
  path: string;          // absolute path of the template directory
  script_path: string;   // absolute path of the written trigger.<ext> script
  type_exists: true;     // always true on success — the type was just loaded
}
```

**Error codes**

| Code | Trigger |
|---|---|
| `INVALID_REQUEST` | Both or neither of `script` / `script_file` was supplied. |
| `VALIDATION_FAILED` | Manifest failed `validateAgentAuthoredTemplate` — id pattern, runtime enum, default_cron validity, parameter schema, etc. The `errors[]` array lists `{ path, code, message }`. |
| `TRIGGER_TEMPLATE_EXISTS` | A template with this id already exists in the chosen scope. (To overwrite, use `trigger.update_template`; to move scopes, delete + create.) |
| `SCRIPT_FILE_OUTSIDE_WORKSPACE` | `script_file` resolved outside `<projectDir>/.clawdevbox/`. |
| `SCRIPT_FILE_NOT_FOUND` | `script_file` resolved under `.clawdevbox/` but no file exists at that path. |

**Side effects.** Writes `template.yaml` and `trigger.<ext>` atomically into
the template directory, then calls `reloadTypeRegistries(ws)` so the new
TYPE is immediately visible to `trigger.list_types` / `trigger.list_templates`
/ `trigger.register`.

### `trigger.update_template`

Update an existing agent-authored TYPE in place. Manifest fields omitted
from the call are **preserved**; the script is replaced **only** when
`script` or `script_file` is supplied. Scope is **not** updatable — to move
a template between `project` and `global`, delete it and create it fresh.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Template id. Must already exist (project or global scope). |
| `description` | `string` | no | Replaces the existing description. |
| `runtime` | `'node' \| 'tsx' \| 'python' \| 'bash'` | no | Replaces the runtime. **If this changes**, the old `trigger.<ext>` is `rmSync`ed before the new one is written, and `manifest.file` is updated to the new extension. |
| `script` | `string` | no (XOR with `script_file`) | Inline replacement script. |
| `script_file` | `string` | no (XOR with `script`) | Path under `<projectDir>/.clawdevbox/`; contents replace the script. |
| `default_cron` | `string` | no | Replaces the field. |
| `identity_param` | `string` | no | Replaces the field. |
| `accepts_webhook` | `boolean` | no | Replaces the field. |
| `parameters` | parameter schema array | no | Replaces the field entirely (not merged). |

**Returns** `{ id, scope, path }`.

**Error codes**

| Code | Trigger |
|---|---|
| `TRIGGER_TEMPLATE_NOT_FOUND` | No agent-authored template with that id (project or global). Plugin-shipped TYPES are not updatable through this tool. |
| `INVALID_REQUEST` | Both `script` and `script_file` were supplied. |
| `NO_CHANGES` | None of the manifest fields, `script`, or `script_file` was supplied. |
| `VALIDATION_FAILED` | The merged manifest failed `validateAgentAuthoredTemplate`. |
| `SCRIPT_FILE_OUTSIDE_WORKSPACE` | `script_file` resolved outside `<projectDir>/.clawdevbox/`. |
| `SCRIPT_FILE_NOT_FOUND` | `script_file` resolved under `.clawdevbox/` but no file exists. |

**Side effects.** Atomically rewrites `template.yaml` and `trigger.<ext>`,
then calls `reloadTypeRegistries(ws)`. Existing registrations against this
TYPE keep their stable ids and `params` — the next fire will pick up the
new script and manifest.

### `trigger.delete_template`

Remove an agent-authored TYPE from disk. Refuses to delete plugin-shipped
TYPES (use `plugin.uninstall` instead) and templates currently referenced
by registered instances (the caller must `trigger.unregister` those first).

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | **yes** | Template id. |

**Returns** `{ id, scope, removed: boolean }`.

**Error codes**

| Code | Trigger |
|---|---|
| `TRIGGER_TEMPLATE_NOT_FOUND` | No template with that id (and not a plugin-shipped TYPE either). |
| `TRIGGER_TEMPLATE_NOT_AUTHORED` | The id resolves to a plugin-shipped TYPE (`scope` starts with `plugin:`). Use `plugin.uninstall`. The response includes the `scope`. |
| `TRIGGER_TEMPLATE_IN_USE` | One or more rows in `triggers.json` reference this TYPE. The response includes `registered_ids[]`. Unregister those first. |

**Side effects.** Rename-to-tomb (atomic move out of the live tree) followed
by recursive remove, then `reloadTypeRegistries(ws)`. The matching entry in
`ws.triggerTypes` disappears; existing registrations stay on disk and start
projecting `type_exists: false` (same orphan flow as plugin uninstall).

### `trigger.list_templates`

Convenience filter over `trigger.list_types` that returns **only**
agent-authored TYPES (`scope ∈ {project, global}`). One-off auto-templates
under `local.oneoff.*` are excluded — this surface is for browsing
intentionally authored templates.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `scope` | `'project' \| 'global'` | no | Filter to one scope. Default: both. |
| `search` | `string` (min length 1) | no | Case-insensitive substring filter against `id` or `description`. |

**Returns** `structuredContent`:

```ts
{
  trigger_types: Array<projectType(...)>;  // same shape as trigger.list_types
  count: number;
}
```

No errors — this tool is read-only over the in-memory registry.

### `trigger.test`

Run a trigger script with a synthesized envelope and capture both Mode A
(stdout `callback.body`) and Mode B (HTTP POST) callbacks. **Non-mutating:**
does not write to `triggers.json`, does not update `last_run_*`, does not
touch `ws.triggerTypes`. Three mutually-exclusive sources (XOR):

1. `id` — a registered instance from `triggers.json` (params/state default
   from the row).
2. `template_id` — any saved TYPE (plugin-shipped, agent-authored, or a
   loaded one-off auto-template).
3. `script` + `runtime` — an inline script.

This is currently the **only** MCP tool that actually spawns a trigger
script (`trigger.fire` is still a metadata stub). It uses
`trigger-runner.ts` — the same runner the cron daemon will adopt when it
ships.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (min length 1) | XOR | Registered-instance id. |
| `template_id` | `string` (min length 1) | XOR | TYPE id. |
| `script` | `string` | XOR | Inline script source. |
| `runtime` | `'node' \| 'tsx' \| 'python' \| 'bash'` | required when `script` is supplied | Interpreter; for `id` / `template_id` paths the runtime is read from the resolved TYPE/template. |
| `params` | `Record<string, unknown>` | no | Overrides the row's params (`id` path) or supplies them fresh (`template_id` / `script` paths). Validated against the TYPE's parameter schema when one is available. |
| `state` | `Record<string, unknown>` | no | Overrides the synthesized envelope's `state`. Defaults: row state for `id`, copy of `params` otherwise. |
| `payload` | `unknown` | no | Forwarded into the envelope's `payload` field. Default: `null`. |
| `timeout_ms` | `number` (positive integer, max 600000) | no, default 30000 | Hard wall-clock timeout for the spawned script. |

**Returns** `structuredContent`:

```ts
{
  run_id: string;            // mintId('run')
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;            // captured raw stdout
  stderr: string;            // captured raw stderr
  stdout_parsed: unknown;    // last JSON object on stdout, or null
  callbacks: Array<{
    mode: 'A' | 'B';         // A = stdout `callback.body`; B = HTTP POST
    path: string;            // request URL (B) or the synthesized callback_url (A)
    method: string;          // 'POST' for both today
    body: unknown;
    received_at: number;     // unix-ms
  }>;
}
```

**Error codes**

| Code | Trigger |
|---|---|
| `INVALID_REQUEST` | Zero or more than one of `id` / `template_id` / `script` was supplied. |
| `RUNTIME_REQUIRED` | `script` was supplied without `runtime`. |
| `TRIGGER_TEMPLATE_NOT_FOUND` | `template_id` resolves to neither a saved template nor a one-off auto-template nor an entry in `ws.triggerTypes`. |
| `NOT_FOUND` (`kind: 'registered_trigger'`) | `id` does not match any row in `triggers.json`. |
| `TRIGGER_TYPE_NOT_FOUND` | `id` resolves a row but its TYPE has been uninstalled. |
| `PARAM_VALIDATION` | The chosen `params` failed schema validation. |

**How it does it.**

1. Resolve the script path and runtime from one of the three sources.
2. For `tsx` / `node` runtimes, copy the script into a fresh `mkdtemp`
   directory beside a `{"type":"module"}` `package.json` so top-level-await
   ESM scripts run cleanly. This step is implementation-only and
   non-mutating — the tmp dir is `rmSync`ed on completion (success **or**
   error). For `python` / `bash` runtimes the original script path is used
   in place.
3. Mint a fresh per-run `Bearer <secret>` (24-byte random hex) and start an
   ephemeral receiver bound to `127.0.0.1:0`. The receiver enforces
   `Authorization: Bearer <secret>` (returns 401 otherwise) — same contract
   as the production `/callback/*` endpoints. The synthesized
   `callback_url` is `http://127.0.0.1:<port>/callback/test/<run_id>`.
4. Call `runTriggerScript(...)` with the envelope `{ trigger_event_name:
   'TriggerFired', trigger_id, run_id, callback_url, state, payload }` on
   stdin and `callbackSecret`. Honor `timeout_ms`.
5. After the script exits (or times out), shut the receiver down. Mode A
   captures are reconstructed from `stdout_parsed.callback.body`; Mode B
   captures come from the receiver's request log. Both lists are merged into
   `callbacks[]` (Mode A first).

> **Note on the `package.json` sidecar.** This is an implementation detail
> to support ESM + top-level await for `tsx`/`node` scripts. The agent
> doesn't see it: the original script file on disk is **not** modified,
> and the tmp directory is cleaned up before this tool returns.

## Lifecycle: agent-authored templates

The typical author-then-deploy flow:

```
1. trigger.create_template(
     id="local.my-trigger", runtime="tsx",
     description="...", script="...")
2. trigger.test(template_id="local.my-trigger")
     → confirm captured Mode A/B callbacks match expectations
3. trigger.register(type_id="local.my-trigger", params={...})
     → live registration
4. (optionally) trigger.update_template(id="local.my-trigger", script="// v2")
     to iterate; existing registrations keep their ids
5. trigger.unregister(id) + trigger.delete_template(id)
     to tear down
```

The one-off flow (no named template, single registration):

```
1. trigger.register(script="...", runtime="bash")
     → mints local.oneoff.<id>; defaults once:true, cron:false
2. trigger.fire(id)
     → manually fire (cron daemon is still a stub)
3. trigger.unregister(id)
     → drops both the registered row AND the _oneoff/<id>/ directory
```

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
│ 1. Plugin author declares a TYPE in .claude-plugin/plugin.json      │
│                                                                     │
│    "clawdevbox": {                                                  │
│      "trigger_types": [                                             │
│        {                                                            │
│          "id": "ado.new-pr-watcher",                                │
│          "file": "triggers/new-pr-watcher.ts",                      │
│          "default_cron": "*/5 * * * *",                             │
│          "identity_param": "repo",                                  │
│          "parameters": [                                            │
│            { "name": "repo", "type": "string", "required": true }   │
│          ]                                                          │
│        }                                                            │
│      ]                                                              │
│    }                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  plugin.install copies plugin
                                  │  into <globalDir>/plugins/<id>/
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Workspace boot — reloadPluginRegistry() in workspace.ts          │
│                                                                     │
│    Phase 1: ws.plugins from <globalDir>/plugins/*/.claude-plugin/plugin.json │
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

### Cron daemon now exists (kernel landed)

This gotcha used to say "none of the cron daemon exists." That is no
longer true as of the trigger-kernel work:

- An in-process **scheduler** (`scheduler.ts`) wakes on cron boundaries and
  enqueues fires; bursty inserts coalesce into a 50 ms debounce.
- A concurrency-capped **dispatcher** (`dispatcher.ts`) claims fires (with
  the §6.3 overlap-skip protocol), runs trigger scripts via
  `trigger-runner.ts`, and writes outputs to
  `<workspace>/.clawdevbox/fires/<fire_id>/attempt-N/`.
- The dispatcher writes back `last_run_at` / `last_run_status` /
  `last_run_error` on completion; `success` fires with `once: true`
  self-disable; failures retry through the per-trigger `backoff_ms`
  ladder and dead-letter to the inbox after `max_attempts`.
- TTL enforcement: `expires_at` is honored by the scheduler when it
  scans the `triggers` table.
- Mode-B callbacks land at `POST /callback/<fire_id>` (see
  [`cron.md`](./cron.md)); hot-trigger thread resume is wired through the
  registration's `subscriber_thread_id`.

`trigger.fire` returns a real `fire_id` you can follow via
`GET /api/fires/<fire_id>` — the row transitions through
`queued → running → success | failed → retrying | dead | skipped` as
described in [`cron.md`](./cron.md).

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
