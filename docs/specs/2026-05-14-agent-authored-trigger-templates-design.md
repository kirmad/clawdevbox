# Agent-Authored Trigger Templates, One-Off Triggers & `trigger.test`

**Status:** Draft (design)
**Date:** 2026-05-14
**Scope:** `mcp-server/src/tools/trigger.ts`, `mcp-server/src/workspace.ts`,
`mcp-server/src/triggers-store.ts`, `mcp-server/src/validators.ts`, plus a new
`mcp-server/src/trigger-runner.ts`.

## 1. Problem

Today the trigger system has three structural gaps that block agents from
authoring and validating triggers without plugin author intervention:

1. **Trigger TYPES are plugin-author-only.** They live in
   `<globalDir>/plugins/<id>/plugin.yaml` under `provides.trigger_types[]`.
   An agent who needs a new TYPE has to either edit a plugin (out of scope at
   runtime) or open a feature request. There is no way for the agent to
   declare a new capability inside the project.
2. **`trigger.register` requires an existing `type_id`.** There is no
   one-off / inline path. Compare with `recipe.run` which accepts an inline
   `source` YAML — triggers have no equivalent.
3. **There is no way to run a trigger script for testing.** `trigger.fire`
   is a metadata-only stub that just queues a `run_id` and logs; no script is
   ever spawned, no envelope is built, no callback is captured. The agent
   has no feedback loop on whether a script is well-formed.

These three gaps share the same primitive: **spawn a trigger script with the
documented `TriggerEnvelope` and capture its callbacks.** This spec adds the
primitive plus three layered MCP surfaces that use it.

## 2. Goals & Non-Goals

### Goals

- Agents can create, update, list, and delete trigger TYPES at runtime,
  scoped to either the current project or the global config dir.
- Agents can register a one-off trigger from inline script content (or a path
  under `.clawdevbox/`) without first creating a TYPE.
- Agents can test any trigger script — inline, agent-authored template,
  plugin-shipped TYPE, or registered instance — by spawning it with a
  synthesized envelope and capturing exit, stdout, stderr, Mode A stdout
  callback, and Mode B HTTP POST callbacks.
- The script protocol (stdin envelope, stdout response, Mode A/B callbacks)
  matches the existing plugin trigger contract documented in
  `docs/tools/trigger.md` and exercised by `samples/triggers/test/mock-conductor.ts`.

### Non-Goals

- Building the cron daemon. `trigger.fire` stays a stub. `trigger.test` is
  the only path that actually spawns a script; production scheduling is a
  separate workstream.
- Writing back `state` / `last_run_*` on registered instances. `trigger.test`
  is non-mutating.
- Changing the existing plugin trigger model on disk.

## 3. Concepts & Terminology

| Term | Meaning |
|---|---|
| **Trigger TYPE** | A reusable capability with a parameter schema. Three sources: plugin-shipped, agent-authored global, agent-authored project. |
| **Agent-authored template** | A TYPE the agent wrote at runtime. Persisted as a `template.yaml` + script-file pair in a per-template directory. |
| **Registered trigger** | A concrete instance of a TYPE with bound params. Lives in `.clawdevbox/triggers.json` `registered[]`. (Existing concept; unchanged shape.) |
| **One-off trigger** | A registered trigger backed by an inline / file-referenced script with no TYPE. Stored as a hidden auto-template under `.clawdevbox/trigger-types/_oneoff/<id>/`. Defaults `once: true`. |
| **TriggerEnvelope** | The JSON object passed on stdin to a trigger script. Already documented in `samples/triggers/test/fixtures/test-plugin/triggers/heartbeat.ts`. |
| **Mode A / Mode B** | Existing callback protocols. Mode A returns a `callback` object on stdout; Mode B POSTs to `callback_url` directly while running. |

## 4. Design

### 4.1 Disk layout

A new per-template directory layout, used for both agent-authored templates
and the auto-template that backs each one-off:

```
<projectDir>/.clawdevbox/trigger-types/<id>/
   template.yaml      # the manifest entry — same shape as plugin.yaml's trigger_types[] item, plus runtime
   trigger.<ext>      # the script (.ts | .js | .py | .sh — extension chosen from runtime)
```

For `scope: "global"`, the same layout is rooted at:

```
<globalDir>/trigger-types/<id>/
   template.yaml
   trigger.<ext>
```

For one-off triggers, the auto-created directory is hidden under a reserved
namespace:

```
<projectDir>/.clawdevbox/trigger-types/_oneoff/<minted-id>/
   template.yaml
   trigger.<ext>
```

`template.yaml` is exactly one entry from a plugin's `provides.trigger_types[]`,
with one extra field — `runtime`:

```yaml
id: local.my-pr-watcher
file: trigger.ts
runtime: tsx                      # one of: node | tsx | python | bash
description: ...
default_cron: "*/5 * * * *"
identity_param: repo
accepts_webhook: true
binds_callback_to_recipe: pr-review
parameters:
  - { name: repo, type: string, required: true, description: "ADO repo name." }
```

Plugin-shipped TYPEs do not carry `runtime` today; they implicitly default
to `tsx` for backward compatibility. The `runtime` field is required on
agent-authored templates.

### 4.2 Type registry merge

`workspace.ts`'s `reloadPluginRegistry()` is extended (renamed to
`reloadTypeRegistries()` for clarity) so `ws.triggerTypes` becomes a merge of:

1. Project agent-authored templates (`<projectDir>/.clawdevbox/trigger-types/*`,
   excluding `_oneoff/`).
2. Global agent-authored templates (`<globalDir>/trigger-types/*`).
3. Plugin-shipped TYPEs (existing path).

**Merge precedence: project > global > plugin.** Earlier sources win — this
lets an agent override a plugin TYPE locally for testing without touching
the plugin. Conflicts are recorded to `ws.triggerTypeErrors[]` with
`{ winning_scope, losing_scope, type_id }` so the agent can see what was
shadowed.

Each `RegisteredTriggerType` projection now exposes `scope` as one of:
- `"plugin:<id>"` (existing)
- `"global"` (new)
- `"project"` (new)

`_oneoff/*` templates are excluded from this merge — they are bookkeeping
for one-off registrations, not browsable TYPEs. They are loaded only by id
when their backing registered instance is fired or tested.

### 4.3 Naming rule

Agent-authored type ids **must** match `^local\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`.
The `local.` prefix is reserved and cannot appear in plugin-shipped ids. This
guarantees agents can never accidentally shadow a plugin id by chance, while
the precedence rule above still allows deliberate shadowing if the agent
explicitly creates a `local.<plugin-id-suffix>` template.

(One-off auto-template ids use `local.oneoff.<base36>` and do not require
agent-supplied ids.)

### 4.4 Tools

#### 4.4.1 `trigger.create_template`

Creates a new agent-authored TYPE on disk, validates it, and reloads the
registry.

Inputs:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Required. Must match `^local\..+`. |
| `scope` | `"project"` \| `"global"` | Default `"project"`. |
| `description` | string | Required. |
| `runtime` | `"node"` \| `"tsx"` \| `"python"` \| `"bash"` | Required. Drives the script extension and the spawn command. |
| `script` | string | XOR with `script_file`. Inline source. |
| `script_file` | string | XOR with `script`. Path **relative to `<projectDir>`**, pointing at an existing file under `.clawdevbox/`. The file is **copied** into the template dir at write time so the template is self-contained. |
| `default_cron` | string | Optional. Validated by `isValidCronExpression`. |
| `identity_param` | string | Optional. Must reference a declared param. |
| `accepts_webhook` | boolean | Optional, default `true`. |
| `binds_callback_to_recipe` | string | XOR with `binds_callback_to`. |
| `binds_callback_to` | `"thread_resume"` | XOR with `binds_callback_to_recipe`. |
| `parameters` | array | Same schema as plugin types. |

Errors:
- `INVALID_REQUEST` — XOR violations, missing required fields.
- `VALIDATION_FAILED` — id format, cron, parameter schema.
- `TRIGGER_TEMPLATE_EXISTS` — id already exists in the same scope. Agent
  must call `trigger.update_template` or `trigger.delete_template` first.

Side effects:
- Creates the per-template directory atomically (write to `<dir>.tmp`,
  rename).
- Reloads `ws.triggerTypes` and emits `emitChange('triggers')`.

Returns: `{ id, scope, path, type: <projection>, type_exists: true }`.

#### 4.4.2 `trigger.update_template`

Updates an existing agent-authored TYPE in place. Same input shape as
`create_template` minus `id` (always required) and `scope` (looked up from
existing template). Either or both of `script` / `script_file` may be
omitted to keep the existing script. Manifest fields omitted in the call
are kept as-is. Reloads registry on success. Errors:

- `notFound("trigger_template", id)` if the template doesn't exist in
  either scope.
- `VALIDATION_FAILED` for the same reasons as create.

#### 4.4.3 `trigger.delete_template`

Deletes an agent-authored TYPE by id. Refuses to delete:
- Plugin-shipped TYPEs (would have to be removed via `plugin.uninstall`).
- A template that is referenced by any registered instance (returns
  `TRIGGER_TEMPLATE_IN_USE` with a list of registered ids). The agent must
  unregister the instances first.

Side effects: removes the directory recursively (atomic rename to a
`.deleted-<ts>` sibling, then `rm -rf` on success), reloads registry,
emits `emitChange('triggers')`.

#### 4.4.4 `trigger.list_templates`

Convenience filter over `trigger.list_types` that returns only `scope`
in `{ "project", "global" }` (i.e. agent-authored only). Same projection
shape. Optional `scope` filter to narrow to one of the two.

`trigger.list_types` continues to be the universal listing — agent-authored
TYPEs appear there too with `scope: "project" | "global"`.

#### 4.4.5 `trigger.register` (extended)

`trigger.register` gains XOR(`type_id` | `script` | `script_file`):

| Field | Type | Notes |
|---|---|---|
| `type_id` | string | Existing path. XOR with `script`/`script_file`. |
| `script` | string | Inline source for a one-off. XOR with `type_id`/`script_file`. |
| `script_file` | string | Path relative to `<projectDir>`, must resolve under `.clawdevbox/` (no `..` escape). XOR with the other two. |
| `runtime` | `"node"` \| `"tsx"` \| `"python"` \| `"bash"` | Required when `script` or `script_file` is supplied. Ignored otherwise. |
| `params` | record | Existing — defaults to `{}` for one-offs since the auto-template declares no parameters by default. |
| `cron` | string \| null \| false | Existing semantics. **Default for one-offs is `false`** (manual/webhook only). |
| `subscriber_thread_id` | string | Existing. |
| `expires_at` | number | Existing. |
| `once` | boolean | Existing. **Default for one-offs is `true`**. |

When `script` or `script_file` is provided:
1. A template id is minted as `local.oneoff.<base36>` (the registry id
   AND the directory name on disk).
2. The script is written to `<projectDir>/.clawdevbox/trigger-types/_oneoff/local.oneoff.<base36>/trigger.<ext>` (script_file is copied in).
3. A minimal `template.yaml` is written next to it with
   `id: local.oneoff.<base36>`, `runtime`, `accepts_webhook: true`,
   no parameters by default, `binds_callback_to: thread_resume` if a
   `subscriber_thread_id` is supplied, otherwise no binding.
3. The auto-template is loaded into `ws.triggerTypes` (it lives outside
   the merged registry so it is not browsable via `list_templates` /
   `list_types`).
4. A registered row is appended to `triggers.json` with `type:
   local.oneoff.<base36>`, `enabled: true`, `once: true` (overridable),
   `cron: false` (overridable).
5. Response includes `adhoc: true`, `template_id: local.oneoff.<base36>`,
   plus the existing `id` and `registered` fields.

When `trigger.unregister` removes a one-off row, the auto-template
directory under `_oneoff/<id>/` is also removed. When `trigger.unregister`
removes a regular registration, no template cleanup happens.

#### 4.4.6 `trigger.test` (new)

Runs a trigger script with a synthesized envelope, captures everything,
returns it.

Inputs (XOR on the source field, exactly one required):

| Field | Type | Notes |
|---|---|---|
| `id` | string | Registered instance id — uses its bound type + params + state. |
| `template_id` | string | Saved TYPE id (any scope, including plugin-shipped) — uses default state, caller-supplied params. |
| `script` | string | Inline source. Requires `runtime`. |
| `runtime` | `"node"` \| `"tsx"` \| `"python"` \| `"bash"` | Required when `script` is supplied. |
| `params` | record | Override / supply params. Validated against the declared schema. For `id`, defaults to the registered row's `params`. For `script`, defaults to `{}`. |
| `state` | record | Override the envelope's `state` field. For `id`, defaults to the registered row's `state`. Otherwise defaults to a copy of `params`. |
| `payload` | unknown | Sets the envelope's `payload`. Default `null`. |
| `timeout_ms` | number | Default 30000. Hard kill after this. |

Behaviour:
1. Resolves the script path + runtime + parameters.
2. Validates `params` against the declared schema (when there is one).
3. Spins up a localhost HTTP server on a random port that:
   - Requires `Authorization: Bearer <secret>` (a fresh per-test secret,
     passed to the script via `CLAWDEVBOX_MCP_SECRET` env). Same auth
     contract as the real `/callback/*` endpoints.
   - Accepts any path. Records `{ path, method, body, status: 200 }` in
     a captured-callbacks list. Always responds `200 { ok: true }`.
4. Mints a `run_id` (`run_<base36>`), builds a `TriggerEnvelope`:
   ```json
   {
     "trigger_event_name": "TriggerFired",
     "trigger_id": "<id or template_id or 'inline'>",
     "run_id": "run_<base36>",
     "callback_url": "http://127.0.0.1:<random-port>/callback/test/<run_id>",
     "state": <resolved state>,
     "payload": <resolved payload>
   }
   ```
5. Spawns the script using the runtime's spawn command:
   - `tsx` → `tsx <file>`
   - `node` → `node <file>`
   - `python` → `python <file>` (Windows: `python`; POSIX: `python3` if available, else `python`)
   - `bash` → `bash <file>`
   Pipes the envelope JSON to stdin, captures stdout/stderr.
6. Hard timeout fires after `timeout_ms` — kills the process tree, marks
   `timed_out: true`.
7. After the process exits (or is killed), parses stdout as JSON if
   possible. If it contains a `callback: { body }` object, that is treated
   as a Mode A callback and prepended to the captured list with
   `mode: "A"`. Mode B captures are tagged `mode: "B"`.
8. Tears down the receiver, returns:
   ```json
   {
     "run_id": "run_<base36>",
     "exit_code": 0,
     "duration_ms": 142,
     "timed_out": false,
     "stdout": "...",
     "stderr": "...",
     "stdout_parsed": { "state": {...}, "systemMessage": "..." },
     "callbacks": [
       { "mode": "B", "path": "/callback/...", "method": "POST", "body": {...} }
     ]
   }
   ```

`trigger.test` is **non-mutating**. It does not write to `triggers.json`,
does not update `state` / `last_run_*`, does not deliver Mode A callbacks
to real recipe / thread endpoints. The captured list is purely diagnostic.

Errors:
- `INVALID_REQUEST` — XOR violations, missing `runtime` for inline `script`.
- `notFound("registered_trigger", id)` / `notFound("trigger_template", id)`.
- `PARAM_VALIDATION` — params don't match the declared schema.

### 4.5 Shared module: `trigger-runner.ts`

A new module that owns the spawn-script-and-capture-envelope primitive.
Used by `trigger.test` today, designed so the future cron daemon can reuse
it for `trigger.fire`. Public surface:

```ts
export interface RunOptions {
  scriptPath: string;            // absolute path
  runtime: 'node' | 'tsx' | 'python' | 'bash';
  envelope: TriggerEnvelope;     // already constructed
  callbackSecret: string;        // injected as CLAWDEVBOX_MCP_SECRET env
  timeoutMs: number;
}

export interface RunResult {
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  stdout_parsed: unknown | null;
}

export async function runTriggerScript(opts: RunOptions): Promise<RunResult>;
```

`trigger.test` orchestrates: build envelope → start receiver →
`runTriggerScript` → stop receiver → merge Mode A from `stdout_parsed` with
Mode B from receiver → return.

### 4.6 Validators

`validators.ts` gains:

- `validateLocalTriggerTypeId(id: string): { ok: true } | { ok: false; message: string }` — enforces the `local.<...>` rule.
- `validateRuntime(value: unknown): { ok: true; runtime: Runtime } | { ok: false; message: string }`.
- `validateTriggerTemplateManifest(raw: unknown): ValidationResult<TemplateManifest>` — wraps the existing parameter / cron / binding XOR checks plus the new `runtime` field.

### 4.7 Workspace boot

`workspace.ts`:

- New helper `loadAgentAuthoredTemplates(rootDir, scope): Map<id, RegisteredTriggerType>`
  walks `<rootDir>/trigger-types/*` (excluding `_oneoff/` for the project
  root), reads `template.yaml`, validates, and returns the map. Errors are
  collected into `ws.triggerTypeErrors[]` keyed by the template directory
  name.
- `reloadTypeRegistries(ws)` (renamed from `reloadPluginRegistry`) builds
  the merged map in precedence order (project > global > plugin), recording
  every override into `triggerTypeErrors` so `trigger.list_types`'
  `load_errors` field surfaces them.
- A new `loadOneOffTemplate(ws, id): RegisteredTriggerType | null` lazy-loads
  `_oneoff/<id>/template.yaml` on demand from `trigger.test` and the
  cron-daemon-to-be.

## 5. Behavior Specifications

### 5.1 Lifecycle: agent creates a template and registers it

```
agent → trigger.create_template(id="local.my-cron", scope="project",
                                runtime="python", script="...", parameters=[...])
clawdevbox:
  - validates manifest
  - writes <projectDir>/.clawdevbox/trigger-types/local.my-cron/template.yaml
  - writes <projectDir>/.clawdevbox/trigger-types/local.my-cron/trigger.py
  - reloadTypeRegistries() — adds to ws.triggerTypes
  - emits 'triggers' change
  - returns { id: "local.my-cron", scope: "project", path: "...", ... }

agent → trigger.register(type_id="local.my-cron", params={...})
clawdevbox:
  - resolves type from ws.triggerTypes (existing path, unchanged)
  - validates params, mints id "local.my-cron#<key>"
  - appends row to triggers.json
  - returns { id, registered: {...} }
```

### 5.2 Lifecycle: agent registers a one-off

```
agent → trigger.register(script="...", runtime="bash", params={...})
clawdevbox:
  - mints oneoff id "local.oneoff.<base36>"
  - writes <projectDir>/.clawdevbox/trigger-types/_oneoff/local.oneoff.<id>/template.yaml
  - writes .../trigger.sh
  - registers row with type="local.oneoff.<id>", enabled=true,
    once=true, cron=false (defaults)
  - returns { id, adhoc: true, template_id: "local.oneoff.<id>", registered: {...} }

agent → trigger.unregister(id)
clawdevbox:
  - removes row from triggers.json
  - removes _oneoff/<template_id>/ directory
  - emits 'triggers'
```

### 5.3 Lifecycle: agent tests a script

```
agent → trigger.test(script="...", runtime="tsx", params={repo: "x"})
clawdevbox:
  - mints test secret + run_id
  - writes script to a temp file (or uses inline file)
  - starts http server on random localhost port
  - builds envelope with callback_url = "http://127.0.0.1:<port>/callback/test/<run_id>"
  - spawns 'tsx <tmp>' with CLAWDEVBOX_MCP_SECRET=<secret>, pipes envelope to stdin
  - script POSTs to callback_url with Authorization: Bearer <secret> (Mode B)
  - script writes JSON envelope to stdout (Mode A optional)
  - process exits
  - server stops
  - returns { exit_code, stdout, stderr, stdout_parsed, callbacks: [...] }

(no triggers.json mutation, no state writeback)
```

## 6. Data Shapes

### 6.1 `template.yaml` (agent-authored)

Identical to a plugin's `provides.trigger_types[]` entry, plus `runtime`:

```yaml
id: local.my-pr-watcher
file: trigger.ts
runtime: tsx
description: ...
default_cron: "*/5 * * * *"
accepts_webhook: true
identity_param: repo
binds_callback_to_recipe: pr-review     # XOR
binds_callback_to: thread_resume         # XOR
parameters:
  - { name: repo, type: string, required: true, description: "..." }
```

### 6.2 `_oneoff/<id>/template.yaml`

Minimal — the auto-template that backs a one-off registration:

```yaml
id: local.oneoff.<base36>
file: trigger.<ext>
runtime: <runtime>
accepts_webhook: true
description: "One-off trigger registered at <iso8601>."
binds_callback_to: thread_resume   # only if subscriber_thread_id was supplied
parameters: []
```

### 6.3 `triggers.json` `registered[]` row

Existing shape, unchanged. The `type` field for one-offs is
`"local.oneoff.<base36>"`.

### 6.4 `trigger.test` response

```json
{
  "run_id": "run_<base36>",
  "exit_code": 0,
  "duration_ms": 142,
  "timed_out": false,
  "stdout": "<full text>",
  "stderr": "<full text>",
  "stdout_parsed": { "state": {...}, "systemMessage": "..." } | null,
  "callbacks": [
    {
      "mode": "A" | "B",
      "path": "/callback/test/run_<base36>",
      "method": "POST",
      "body": { "prompt": "...", "context": {...} },
      "received_at": 1715380000123
    }
  ]
}
```

## 7. Error Codes

New codes added to the trigger surface:

| Code | When |
|---|---|
| `INVALID_REQUEST` | XOR violations on create_template / register / test. |
| `TRIGGER_TEMPLATE_EXISTS` | create_template hits an id already in the same scope. |
| `TRIGGER_TEMPLATE_IN_USE` | delete_template called while registered instances reference the type. |
| `TRIGGER_TEMPLATE_NOT_FOUND` | update_template / delete_template / test miss the id. |
| `TRIGGER_TEMPLATE_NOT_AUTHORED` | delete_template targets a plugin-shipped TYPE. |
| `RUNTIME_REQUIRED` | register/test with `script` but no `runtime`. |
| `SCRIPT_FILE_OUTSIDE_WORKSPACE` | register/create with `script_file` resolving outside `.clawdevbox/`. |
| `TEST_TIMEOUT` | trigger.test exceeded `timeout_ms` (also surfaced as `timed_out: true` in the response). |

Existing codes (PARAM_VALIDATION, TRIGGER_TYPE_NOT_FOUND, etc.) are reused
unchanged.

## 8. Security & Sandbox Considerations

- `script_file` arguments are resolved with `path.resolve()` and rejected
  unless they remain inside the project's `.clawdevbox/` directory. Same
  rule the recipe path validator already uses.
- `_oneoff/` and `<scope>/trigger-types/` directory creation goes through
  `writeFileAtomic` so a crash mid-write doesn't leave half a template.
- `trigger.test` spins up its receiver on `127.0.0.1` only, on a random
  ephemeral port, with a fresh per-test secret. Server is torn down in
  `finally`. No record of the secret is logged.
- Running an agent-authored script is no more privileged than running an
  agent-authored skill or recipe step — no extra sandboxing is added in
  this spec. Document the trust model in the tool description.
- Plugin-shipped TYPEs cannot be deleted via `trigger.delete_template`;
  the agent must use `plugin.uninstall`.

## 9. Compatibility & Migration

- Existing plugin-shipped TYPEs continue to load with no manifest changes.
  The `runtime` field is optional for the plugin path and defaults to `tsx`.
- Existing registered triggers are unchanged.
- `trigger.fire` remains a metadata stub. `trigger.test` is the only path
  in this spec that actually spawns a script.
- The renamed `reloadTypeRegistries()` keeps an alias export
  `reloadPluginRegistry()` for any existing call sites.

## 10. Testing Strategy

### 10.1 Unit tests (`tests/triggers-store.test.mjs`, `tests/workspace.test.mjs`)

- `loadAgentAuthoredTemplates` happy path for project + global scopes.
- Precedence: project > global > plugin, with `triggerTypeErrors`
  capturing the shadowed entries.
- Manifest validator rejections: bad id format, missing runtime, bad cron,
  bad binding XOR.
- One-off auto-template lifecycle: register writes, unregister cleans up.

### 10.2 Tool tests (`tests/triggers.test.mjs` — new file)

For each new tool:
- Happy path: minimal valid input → expected disk + registry state.
- XOR violations → `INVALID_REQUEST`.
- Param validation failures → `PARAM_VALIDATION`.
- `delete_template` while registered → `TRIGGER_TEMPLATE_IN_USE`.
- `delete_template` on plugin TYPE → `TRIGGER_TEMPLATE_NOT_AUTHORED`.
- Update with no changes → `NO_CHANGES` (mirrors update_params).

### 10.3 Runner tests (`tests/trigger-runner.test.mjs` — new file)

- Mode B-only script → `callbacks` contains the POSTed body.
- Mode A-only script → `callbacks` contains the parsed stdout body.
- Mixed Mode A + Mode B → both appear, Mode A first, then Mode B in
  receive order.
- Bad `Authorization` header → script gets 401, `callbacks` empty.
- Timeout → process killed, `timed_out: true`.
- Each runtime (`node`, `tsx`, `python`, `bash`) → at least one happy-path
  fixture under `tests/fixtures/trigger-runner/`. Skip on hosts that
  don't have the runtime installed (with a `t.skip` reason).

### 10.4 Live verification

- Build, restart service.
- Stdio MCP: `trigger.create_template` (project, runtime=node) →
  `trigger.test(template_id=...)` → confirm Mode A + Mode B captures.
- `trigger.register(script, runtime=bash)` → `trigger.test(id=...)` →
  `trigger.unregister(id)` → confirm `_oneoff/<id>/` is gone.

## 11. Open Questions Deferred to Implementation

- Exact path-walking strategy on `<globalDir>/trigger-types/` when the
  directory does not exist (silent no-op vs warn).
- Whether `trigger.list_types` should grow a `kind: "plugin" | "agent"`
  field for filtering, or whether `scope` is enough. Default: just `scope`.
- Whether the test receiver should record the time-to-first-callback for
  perf diagnostics. Default: yes, as `received_at` per callback.

## 12. Out of Scope / Future Work

- Cron daemon. When it lands, it will reuse `trigger-runner.ts` and the
  `_oneoff/<id>/` template loader.
- Automatic `last_run_*` writeback on the registered row (cron daemon's job).
- A `trigger.test` mode that pipes captures back to the SPA in real time.
- `trigger.export_template` / `trigger.import_template` for sharing
  agent-authored templates across projects (could be a follow-on).
