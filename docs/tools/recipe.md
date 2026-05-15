# `recipe.*` MCP tools

Recipes are short YAML documents (`id`, `name`, `description`, optional `steps[]`,
`mcp_servers[]`, `kind`, `default_client`, `timeout_minutes`) that describe a unit
of agent work. The `recipe.*` family is the CRUD surface for those YAML files
*plus* the runtime that actually executes one: `recipe.run` spawns a hidden
agent-CLI (Claude Code, Copilot, or a test stub) inside a node-pty, wires the
spawned process back to this MCP server via a generated `.mcp.json`, and records
the run as a `RecipeInstance` JSON row. The spawned agent calls `recipe.done`
to mark itself complete; viewers attach to the pty through the terminal-server
HTTP/WS surface.

All twelve tools are registered in `mcp-server/src/tools/recipe.ts` via
`server.registerTool`:

| Tool                          | Purpose                                                                  |
|-------------------------------|--------------------------------------------------------------------------|
| `recipe.list`                 | Enumerate recipes across scopes.                                         |
| `recipe.read`                 | Read one recipe by id, with project → plugin → global precedence.        |
| `recipe.upsert`               | Write/replace a recipe in project or global scope (YAML or JSON).        |
| `recipe.delete`               | Remove a recipe from project or global scope.                            |
| `recipe.run`                  | Mint an instance, write `.mcp.json`, spawn an agent CLI inside a pty.    |
| `recipe.done`                 | Called *from inside* the spawn to mark the instance success/failure.     |
| `recipe.instance_info`        | Read an instance row by id, or via env vars from inside a spawn.         |
| `recipe.view_url`             | Get a browser URL that attaches xterm.js to the live pty.                |
| `recipe.kill`                 | Terminate the pty and mark the instance cancelled.                       |
| `recipe.list_running`         | List every pty currently registered with this MCP server.                |
| `recipe.update_steps`         | Mutate the materialized step plan of a running instance (spec §10.5).    |
| `recipe.steps.update_status`  | Transition one step through the monotonic status machine (spec §10.5).   |

### Ambient environment variables

When `recipe.run` spawns an agent CLI, the child process inherits a small
ambient bag of identifiers in its environment. The new step tools
(`recipe.update_steps`, `recipe.steps.update_status`) and `recipe.done`
read these as defaults so the spawned agent can omit them as arguments:

| Variable | Source | Tools that default from it |
|---|---|---|
| `CLAWDEVBOX_WORKSPACE_ID` | id of the workspace the recipe is running in | scope helpers; trigger registration |
| `CLAWDEVBOX_RECIPE_INSTANCE_ID` | the spawned `RecipeInstance.id` | `recipe.update_steps`, `recipe.steps.update_status`, `recipe.done`, `recipe.instance_info` |
| `CLAWDEVBOX_AGENT_SESSION_ID` | the agent CLI session id (`cdb_<base36>`) | step-event audit `agent_session_id` column |
| `CLAWDEVBOX_RECIPE_STEP_ID` | the current `recipe_steps.id` when one is in flight | step-bound helpers; lets the agent omit `step_id` when only one step is active (subject to per-tool support) |

If the env var is absent **and** the tool argument is also absent, the
tool returns `RECIPE_INSTANCE_NOT_FOUND` (or analogous) so the failure mode
is explicit rather than silent.

## Filesystem layout

Three scopes are recognized with strict precedence **project → `plugin:<id>` →
global** (see `resolveRead` in `mcp-server/src/scope.ts:150`). Recipes live at:

| Scope          | On-disk path                                                | Writable via tools? |
|----------------|-------------------------------------------------------------|---------------------|
| `project`      | `<projectDir>/.clawdevbox/recipes/<id>.yaml`                | ✅ yes              |
| `plugin:<id>`  | `<globalDir>/plugins/<id>/<file-from-manifest>`             | ❌ no — read-only   |
| `global`       | `<globalDir>/recipes/<id>.yaml`                             | ✅ yes              |

The writable paths come from `recipePath()` (`workspace.ts:247`):

```ts
export function recipePath(ws: Workspace, scope: WritableScope, id: string): string {
  if (scope === 'project') return join(ws.projectDir, '.clawdevbox', 'recipes', `${id}${RECIPE_EXT}`);
  return join(ws.globalDir, 'recipes', `${id}${RECIPE_EXT}`);
}
```

`RECIPE_EXT` is `'.yaml'` (`workspace.ts:232`). The directory scanner used by
`recipe.list` (`listAllInScope` in `scope.ts:186-217`) additionally accepts
`*.yml` as an alternate extension, but `recipePath` only ever writes `.yaml`.

Plugin-scope recipes are *not* found by directory scan — they are resolved
through the plugin's `provides.recipes[]` manifest entry (`scope.ts:127-136`).
`pluginFileResolve` (`scope.ts:139`) rejects any `entry.file` that escapes
the plugin root, so a malicious plugin can't ship `provides.recipes` pointing
outside its own directory.

`<projectDir>` comes from the required `CLAWDEVBOX_PROJECT_DIR` env var.
`<globalDir>` defaults to `~/.clawdevbox` (override via `CLAWDEVBOX_GLOBAL_DIR`).

Recipe **runs** add a fourth on-disk layout — one instance JSON per spawn — at:

```
<workspace>/.clawdevbox/recipe-instances/<recipe_instance_id>.json   // status row
<workspace>/.clawdevbox/recipe-instances/<recipe_instance_id>.log    // pty output
<workspace>/.clawdevbox/recipe-instances/<recipe_instance_id>.script.cjs  // echo-stub only
<workspace>/.mcp.json                                                // for the spawned CLI
```

The `<workspace>` here is the *spawned* workspace under
`<workspacesRoot>/<workspace_id>/` (default `<workspacesRoot>` =
`~/.clawdevbox/workspaces`), not the calling agent's project_dir. Paths and id
minting are owned by `recipe-instances-store.ts` and `workspaces-store.ts`.

## Recipe file shape

Validated server-side before every disk write by `validateRecipeSource()` in
`mcp-server/src/validators.ts:56` (which YAML-parses and then defers to
`validateRecipeParsed`, `validators.ts:67-158`). Required fields:

| Field            | Type       | Notes                                                                        |
|------------------|------------|------------------------------------------------------------------------------|
| `id`             | string     | Must match `[a-z][a-z0-9-]*` and equal the upsert `id` arg (see ID_MISMATCH).|
| `name`           | string     | Non-empty.                                                                    |
| `description`    | string     | Non-empty.                                                                    |
| `kind`           | string?    | Enum: `pr_review` \| `workitem` \| `incident` \| `epic` \| `custom`.         |
| `default_client` | string?    | Any registered agent-CLI provider id (built-ins: `claude`, `copilot`; plugins may add more — see [`agent-clis.md`](../agent-clis.md)). Validated against `ws.agentCliProviders` at run time, not parse time. |
| `mcp_servers`    | string[]?  | Array of strings.                                                             |
| `timeout_minutes`| number?    | `>= 0`.                                                                       |
| `steps`          | object[]?  | Each step: integer `id` (unique), non-empty `goal`, optional `depends: int[]`.|

Step `depends[]` entries are checked against the set of declared step ids, so
forward references are caught at write time (`validators.ts:117-153`).

## Tools

### `recipe.list`

List recipes across scopes. Project shadows plugin shadows global on id
collisions in `all` mode; the listing reports every `(id, scope)` pair so a
shadowed plugin recipe is still visible in the response.

**Inputs:**

| Name     | Type                                                | Required | Description                                                 |
|----------|-----------------------------------------------------|----------|-------------------------------------------------------------|
| `scope`  | `'project' \| 'global' \| 'all' \| 'plugin:<id>'`   | no       | Default `'all'`.                                            |
| `search` | string                                              | no       | Case-insensitive substring filter against id/name/desc.     |

**Returns** `structuredContent`:

```ts
{
  recipes: Array<{
    id: string;
    scope: 'project' | 'global' | `plugin:${string}`;
    name: string;          // falls back to id when not in YAML
    description: string;
    kind?: string;
    mcp_servers?: string[];
    step_count: number;
  }>;
  count: number;
}
```

**Errors:** none specific (Zod schema rejects malformed `scope`).

**How it works:** delegates to `listAllInScope(ws, scope, 'recipe', recipePath)`
which scans `<projectDir>/.clawdevbox/recipes/` for `*.yaml`/`*.yml`, walks each
plugin's `provides.recipes[]` manifest list, and scans `<globalDir>/recipes/`
(`scope.ts:186-260`). For each hit it reads the file (`safeRead` →
`readFileSync`; failures return `null`), YAML-parses it (`safeParse`; failures
return `null`), then pulls `name`, `description`, `kind`, `mcp_servers`, and
`steps.length` off the parsed object. The `id` slot in the response is the
*filename* id, not the YAML body's `id` — these will match in any sane
recipe because `recipe.upsert` enforces ID_MISMATCH.

### `recipe.read`

Read a single recipe by id with project → plugin → global precedence. Returns
both the raw YAML and a parsed object plus the scope it resolved from.

**Inputs:**

| Name    | Type                                                 | Required | Description                              |
|---------|------------------------------------------------------|----------|------------------------------------------|
| `id`    | string                                               | yes      | Must match `[a-z][a-z0-9-]*`.            |
| `scope` | `'project' \| 'global' \| 'all' \| 'plugin:<id>'`    | no       | Default `'all'`.                         |

**Returns** `structuredContent`:

```ts
{
  id: string;
  scope: 'project' | 'global' | `plugin:${string}`;
  source: string;     // raw YAML
  parsed: unknown;    // js-yaml load result, or null on parse failure
}
```

**Errors:** `INVALID_ID`, `NOT_FOUND`.

**How it works:** `validateId(args.id)` (`workspace.ts:236`) rejects malformed
ids with `INVALID_ID`. `resolveRead(ws, scope, 'recipe', id, recipePath)`
(`scope.ts:150`) walks the scope chain — for `scope='all'`, it tries
`<projectDir>/.clawdevbox/recipes/<id>.yaml`, then each enabled plugin's
`provides.recipes` (sorted by plugin id, first hit wins), then
`<globalDir>/recipes/<id>.yaml`. A miss returns the standard `NOT_FOUND`
shape. The parsed body is best-effort: if `js-yaml` throws, `parsed` is `null`
but `source` is still returned so callers can debug malformed files.

### `recipe.upsert`

Write a recipe to project or global scope. Plugin scope is **rejected** —
the design rule is "copy to `project` to customize a plugin-shipped recipe"
(spec §10.6).

**Inputs:**

| Name     | Type                                       | Required | Description                                            |
|----------|--------------------------------------------|----------|--------------------------------------------------------|
| `id`     | string                                     | yes      | Must match `[a-z][a-z0-9-]*` and equal `body.id`.      |
| `scope`  | `'project' \| 'global' \| 'plugin:<id>'`   | yes      | `plugin:<id>` returns `PLUGIN_SCOPE_READONLY`.         |
| `source` | string                                     | yes      | Full recipe body. Either YAML or JSON depending on `format`. |
| `format` | `'yaml' \| 'json'`                         | no       | On-disk encoding. Default `'yaml'` → `<id>.yaml`; `'json'` → `<id>.json`. The sibling file in the other extension is atomically removed so a single recipe id always maps to exactly one file. |

**Returns** `structuredContent`:

```ts
{ id: string; scope: 'project' | 'global'; path: string; format: 'yaml' | 'json'; }
```

**Errors:** `INVALID_ID`, `PLUGIN_SCOPE_READONLY`, `INVALID_SCOPE`,
`VALIDATION_FAILED` (with `errors[]` per `validators.ts`), and an explicit
`ID_MISMATCH` validation error when `parsed.id !== args.id`.

**How it works** (`recipe.ts:162-189`):
1. `validateId(args.id)` → `INVALID_ID` on failure.
2. `ensureWritableScope(args.scope)` (`scope.ts:80`) → `PLUGIN_SCOPE_READONLY`
   for `plugin:<id>` scopes, `INVALID_SCOPE` for unknown values, `null` for
   the two writable scopes.
3. `validateRecipeSource(args.source)` parses the YAML and shape-checks it; on
   failure it returns the structured `VALIDATION_FAILED` payload via
   `validationError(...)`.
4. After parsing, `parsed.id` is compared to `args.id`; mismatch returns a
   targeted `ID_MISMATCH` validation error so the caller can't accidentally
   write a recipe under the wrong filename.
5. `writeFileAtomic(target, args.source)` (`fs-util.ts:22`) writes to a
   tempfile in the same directory then `fs.renameSync` into place. This is the
   only durable side effect.

There is **no** `emitChange('recipes')` SSE notification on upsert/delete —
those events fire only when `RecipeInstance` rows change (see
`recipe-instances-store.ts:136`).

### `recipe.delete`

Delete a recipe from project or global scope.

**Inputs:**

| Name    | Type                                       | Required | Description                                       |
|---------|--------------------------------------------|----------|---------------------------------------------------|
| `id`    | string                                     | yes      |                                                   |
| `scope` | `'project' \| 'global' \| 'plugin:<id>'`   | yes      | `plugin:<id>` → `PLUGIN_SCOPE_READONLY`.          |

**Returns** `structuredContent`: `{ id, scope, path }`.

**Errors:** `PLUGIN_SCOPE_READONLY`, `INVALID_SCOPE`, `NOT_FOUND`.

**How it works:** `ensureWritableScope` guard, then `recipePath(...)`, then
`existsSync` (returns `NOT_FOUND` if absent) and `unlinkSync`. No backup, no
trash bin. `recipe.delete` does *not* validate `id` against the regex — the
combination of `recipePath()` + `existsSync` makes a malformed id harmless
(it just resolves to a path that doesn't exist).

### `recipe.run`

Spawn a fresh agent-CLI session running a recipe. **Two ways to specify the
recipe**: load a saved one via `id` (the original behavior) OR pass inline
YAML via `source` for an **ad-hoc, non-persisted run**. Either way, creates
(or reuses) a workspace, writes that workspace's `.mcp.json` so the spawned
CLI sees this MCP server, mints a `RecipeInstance` row, then detach-spawns
the CLI inside a node-pty and returns immediately. See the **Story** section
below for the end-to-end mechanism.

**Inputs:**

| Name                       | Type                                       | Required                | Description                                                                                  |
|----------------------------|--------------------------------------------|-------------------------|----------------------------------------------------------------------------------------------|
| `id`                       | string                                     | one of `id`/`source`    | Recipe id to load from the scope chain (`project` → `plugin:<id>` → `global`).               |
| `source`                   | string (YAML)                              | one of `id`/`source`    | Inline recipe YAML for an ad-hoc run. **Not persisted to disk.** Validates against the same rules as `recipe.upsert` (must include `id`, `name`, `description`). The embedded `id` becomes the instance's `recipe_id`. |
| `prompt`                   | string                                     | yes                     | First user message handed to the spawned agent.                                              |
| `params`                   | `Record<string, unknown>`                  | no                      | Recorded on the instance for downstream consumption. Not passed to the CLI.                  |
| `workspace_id`             | string                                     | no                      | Reuse an existing workspace; otherwise a fresh one is minted via `createWorkspace`.          |
| `attach_to_inbox_item_id`  | string                                     | no                      | Echoed in the response; not used internally.                                                 |
| `agent_cli`                | string                                     | no                      | Any registered provider id (built-ins: `copilot`, `claude`, `echo-stub`; plugins may add more). Default resolution chain below. `echo-stub` is a test no-op. |
| `session_id`               | string                                     | no                      | Explicit agent-CLI session id. Auto-minted as `cdb_<base36>` if omitted.                     |
| `resume_of`                | string                                     | no                      | Recipe-instance id to resume; switches the CLI flag from `--name=` (or `--session-id`) to `--resume`. |

`id` and `source` are **mutually exclusive** — passing both returns
`INVALID_REQUEST`; passing neither returns `INVALID_REQUEST`.

**Returns** `structuredContent`:

```ts
{
  recipe_instance_id: string;        // ri_<base36-ts>_<4hex>
  recipe_id: string;                 // either args.id or the id field from inline source
  adhoc: boolean;                    // true when source was provided (recipe not in any scope)
  workspace_id: string;              // ws_<base36-ts>_<4hex>
  workspace_path: string;
  attach_to_inbox_item_id: string | null;
  pid: number | null;                // null if spawn never returned a pid (echo-stub may already have exited)
  agent_cli: string;                 // provider id (built-in or plugin-registered)
  session_id: string;                // explicit CLI session id (cdb_<...> when auto-minted)
  resume_of: string | null;
  status: 'spawned';                 // initial; the instance row is the source of truth thereafter
  log_path: string;                  // <workspace>/.clawdevbox/recipe-instances/<id>.log
  view_url: string | null;           // null if terminal-server isn't running
}
```

**Errors:** `INVALID_REQUEST` (id+source XOR), `INVALID_ID`, `NOT_FOUND`
(recipe), `VALIDATION_FAILED` (inline source malformed), `WORKSPACE_NOT_FOUND`,
`WORKSPACE_CREATE_FAILED`, `UNKNOWN_AGENT_CLI` (resolved provider id not
in `ws.agentCliProviders`), `SPAWN_FAILED`.

#### `agent_cli` argument

The `agent_cli` argument accepts **any registered provider id**, not
just the OSS built-ins. Built-ins are `copilot`, `claude`, and
`echo-stub`; plugin-supplied providers register through
`provides.agent_clis[]` in `plugin.yaml`. The current list is
discoverable via `GET /api/agent-clis`. See
[`docs/agent-clis.md`](../agent-clis.md) for authoring details.

Resolution order if omitted (first hit wins):

1. explicit `agent_cli` on the `recipe.run` call
2. recipe-level `default_client` field
3. project config `default_agent_cli`
4. global config `default_agent_cli`
5. hardcoded fallback: `'copilot'`

If the resolved id is not registered, `recipe.run` returns
`UNKNOWN_AGENT_CLI` and lists the available providers in the error
message.

**Ad-hoc vs saved**: ad-hoc runs are useful when the agent composes a one-off
recipe on the fly (e.g. "summarize this list of files"). The full YAML is still
preserved on the `RecipeInstance.recipe_snapshot` field so audit/replay still
works — only the `<scope>/.clawdevbox/recipes/<id>.yaml` write is skipped. To
turn an ad-hoc into a saved recipe later, the agent can call `recipe.upsert`
with the same source.

### `recipe.done`

Called by the spawned agent (or any code running inside the same pty) to mark
the recipe instance complete. Reads `CLAWDEVBOX_RECIPE_INSTANCE_ID` and
`CLAWDEVBOX_WORKSPACE_ID` from `process.env` — both are seeded by `recipe.run`
into the spawn's environment.

**Inputs:**

| Name      | Type                                       | Required | Description                                  |
|-----------|--------------------------------------------|----------|----------------------------------------------|
| `status`  | `'success' \| 'failure' \| 'cancelled'`    | no       | Default `'success'`.                         |
| `result`  | `unknown`                                  | no       | Arbitrary structured result.                 |
| `message` | string                                     | no       | Optional human summary.                      |

**Returns** `structuredContent`: `{ recipe_instance_id, recorded_at, status }`.

**Errors:** `NOT_IN_RECIPE_INSTANCE` (env var missing), `WORKSPACE_NOT_FOUND`,
`RECIPE_INSTANCE_NOT_FOUND`.

**How it works** (`recipe.ts:620-675`):
1. Read both env vars; either missing → `NOT_IN_RECIPE_INSTANCE`.
2. `resolveWorkspacesRoot()` + `getWorkspace(root, workspaceId)` to find the
   workspace directory; absent → `WORKSPACE_NOT_FOUND`.
3. `readRecipeInstance(wsInfo.path, instanceId)` (returns null on missing
   file or JSON parse error → `RECIPE_INSTANCE_NOT_FOUND`).
4. Merge `{ status, completed_at: Date.now(), result: args.result ?? null,
   message: args.message ?? null }` into the existing instance object and
   `writeRecipeInstance(...)` it back. The write goes through
   `writeFileAtomic` and *also* calls `emitChange('recipes')`, which feeds the
   SSE bus and refreshes any UI viewers.

### `recipe.instance_info`

Read an instance row by id, or — when called from inside a spawned session —
by reading `CLAWDEVBOX_RECIPE_INSTANCE_ID` + `CLAWDEVBOX_WORKSPACE_ID` env
vars. Returns the full row in a flattened shape (no `steps` — only the
top-level lifecycle fields).

**Inputs:**

| Name | Type   | Required | Description                                                                  |
|------|--------|----------|------------------------------------------------------------------------------|
| `id` | string | no       | Optional recipe-instance id. When omitted, falls back to env vars.           |

**Returns** `structuredContent`:

```ts
{
  recipe_instance_id: string;
  workspace_id: string;
  workspace_path: string;
  recipe_id: string;
  prompt: string;
  params: Record<string, unknown>;
  agent_cli: string;
  pid: number | null;
  started_at: number;
  status: 'running' | 'success' | 'failure' | 'cancelled';
  completed_at: number | null;
  result: unknown;
  message: string | null;
}
```

**Errors:** `NOT_IN_RECIPE_INSTANCE`, `WORKSPACE_NOT_FOUND`,
`RECIPE_INSTANCE_NOT_FOUND`.

**How it works:** when `id` is passed, it iterates `listWorkspaces(root)` and
calls `readRecipeInstance(wsi.path, id)` against each one until it finds a
match — O(workspaces) scan but acceptable because the workspace registry is
small. When `id` is omitted, the env-var branch is used and the file is
located directly via `workspaceId → wsInfo.path`.

### `recipe.view_url`

Return a browser URL that opens an xterm.js viewer attached to the hidden pty
running a recipe instance. Multiple clients may attach simultaneously; each
gets a scrollback snapshot followed by live data, and can send keystrokes,
resize, or kill.

**Inputs:**

| Name | Type   | Required | Description                                                                              |
|------|--------|----------|------------------------------------------------------------------------------------------|
| `id` | string | no       | Recipe-instance id. Falls back to `CLAWDEVBOX_RECIPE_INSTANCE_ID`.                       |

**Returns** `structuredContent`: `{ recipe_instance_id, view_url, terminal_port }`.

**Errors:** `MISSING_INSTANCE_ID`, `PTY_SESSION_NOT_FOUND` (either it never
spawned, the agent exited and the registry already cleaned it up, or the MCP
server was restarted), `TERMINAL_SERVER_NOT_RUNNING` (e.g. `index.ts` never
called `startTerminalServer()`).

**How it works:** checks `ptyHasSession(instanceId)` against the in-memory
registry in `pty-registry.ts`, then `getTerminalServer().url(instanceId)` to
format the URL as
`http://<host>:<port>/terminal/<encodedInstanceId>`
(`terminal-server.ts:141-142`). The terminal-server is the same HTTP server
the SPA uses; it accepts the WS upgrade at `/terminal/<id>/ws` and bridges to
the pty via `pty-registry.subscribe(...)`.

### `recipe.kill`

Terminate a running recipe pty, mark the instance `cancelled`, and let the
regular `onExit` event disconnect all attached viewers.

**Inputs:**

| Name     | Type   | Required | Description                                                                                  |
|----------|--------|----------|----------------------------------------------------------------------------------------------|
| `id`     | string | no       | Recipe-instance id. Falls back to `CLAWDEVBOX_RECIPE_INSTANCE_ID`.                           |
| `signal` | string | no       | Optional POSIX signal name (default `SIGTERM`). Ignored by ConPTY on Windows.                |

**Returns** `structuredContent`: `{ recipe_instance_id, status: 'cancelled' }`.

**Errors:** `MISSING_INSTANCE_ID`, `PTY_SESSION_NOT_FOUND`, `PTY_KILL_FAILED`.

**How it works:** `ptyKill(instanceId, signal)` calls `IPty.kill(signal)` on
the registered session (`pty-registry.ts:181`). Then it scans
`listWorkspaces(root)` for an instance whose `status === 'running'` and
writes it back as `status: 'cancelled'` with `completed_at = Date.now()` and
`message = 'Cancelled via recipe.kill'`. Note: the *only* place that flips
the instance to `cancelled` is `recipe.kill`; the pty `onExit` handler in
`recipe.run` derives `success` / `failure` from the exit code and never
writes `cancelled`. If the instance has already moved to a terminal status,
the rewrite is skipped.

### `recipe.list_running`

List every recipe instance currently holding a live pty session in this MCP
server process. Useful for dashboards and Playwright tests.

**Inputs:** none.

**Returns** `structuredContent`:

```ts
{
  sessions: Array<{
    recipe_instance_id: string;
    workspace_id: string;
    exited: boolean;       // true for sessions still in the EXIT_RETAIN_MS grace window
    view_url: string | null;
  }>;
}
```

**Errors:** none.

**How it works:** calls `ptyListSessions()` (`pty-registry.ts:192`) which
returns `{ instanceId, workspaceId, exited }` per live entry, and joins each
to a `view_url` if the terminal-server is running. Sessions linger in the
registry for `EXIT_RETAIN_MS = 10_000` after exit so late-attaching viewers
still see the final scrollback; those will show up here with `exited: true`.

### `recipe.update_steps`

Mutate the materialized step plan of a running recipe instance (spec §10.5).
The three sub-operations run inside a **single DB transaction** — any
failure rolls all of them back. `add` / `remove` / `update_meta` may be
combined in one call; removals are applied first so a subsequent add can
re-use a freed `step_id`.

**Inputs:**

| Name | Type | Required | Description |
|---|---|---|---|
| `recipe_instance_id` | string | no | Defaults to `$CLAWDEVBOX_RECIPE_INSTANCE_ID` when omitted. |
| `add` | `Step[]` | no | New steps to materialize. See [Canonical Step schema](#canonical-step-schema). |
| `remove` | `string[]` | no | `step_id`s to delete. Only `pending`, `done`, `failed`, or `skipped` steps may be removed; `running` and `awaiting_user` are rejected with `CANNOT_REMOVE_RUNNING_STEP`. |
| `update_meta` | `Array<Partial<Step> & { id: string }>` | no | Patch existing steps' meta (goal, depends, params, triggers, artifacts). Status fields are **not** patchable here — use `recipe.steps.update_status`. |

**Returns** `structuredContent`:

```ts
{
  recipe_instance_id: string;
  added:   Array<{ id: string; step_id: string }>;
  removed: string[];
  updated: Array<{ id: string; step_id: string }>;
  trigger_changes: Array<{
    step_id: string;
    added_triggers:   TriggerDecl[];
    removed_triggers: TriggerDecl[];
    registered_trigger_ids: string[];   // populated only when the step is already running
    disabled_trigger_ids: string[];     // populated when an auto-declared trigger was removed
  }>;
}
```

**Trigger-registration side effects.** If `update_meta` adds triggers to a
step that is already `running` or `awaiting_user`, the new declarations are
materialized as auto-declared rows in the `triggers` table immediately
(`auto_declared = 1`, `auto_registered_by_step_id` = the step's row id).
Pending steps register their declarations later, when they transition to
`running` (see `recipe.steps.update_status`). Removed declarations
auto-disable the matching `triggers` rows that were registered by this
step.

A `step_added`, `step_removed`, `step_meta_updated`, `trigger_registered`,
or `trigger_unregistered` row is appended to `step_events` for each
mutation so the SPA timeline has a complete causal log.

**Errors:**

| Code | Trigger |
|---|---|
| `RECIPE_INSTANCE_NOT_FOUND` | No matching `recipe_instances` row, or neither arg nor env var was supplied. |
| `STEP_NOT_FOUND` | A `remove[]` or `update_meta[].id` entry doesn't match any step in the instance. |
| `CANNOT_REMOVE_RUNNING_STEP` | A `remove[]` entry targets a step in status `running` or `awaiting_user`. |
| `INVALID_STEP_SCHEMA` | A step in `add[]` / `update_meta[]` failed shape validation. |
| `INVALID_DEPENDENCY` | A step's `depends[]` references an unknown step id, or `update_meta` introduces an unknown dep. |
| `CIRCULAR_DEPENDENCY` | The post-mutation dependency graph would contain a cycle. The whole transaction is rolled back. |

Emits `emitChange('recipes')` on success.

### `recipe.steps.update_status`

Transition a single step through the monotonic status machine and record
side effects (entry/exit hooks, attachments, audit events). The full
transition matrix is:

```
pending → running | skipped
running → done | failed | skipped | awaiting_user
awaiting_user → running | done | failed | skipped
done | failed | skipped: terminal (no further transitions)
```

Any transition that violates this matrix returns `INVALID_TRANSITION`.

**Inputs:**

| Name | Type | Required | Description |
|---|---|---|---|
| `recipe_instance_id` | string | no | Defaults to `$CLAWDEVBOX_RECIPE_INSTANCE_ID`. |
| `step_id` | string | **yes** | Step's logical id (matches `Step.id`). |
| `status` | `'running' \| 'done' \| 'failed' \| 'skipped' \| 'awaiting_user'` | no | New status. Omit to update state/attachments only. |
| `message` | string | no | Free-form human note for the step row. |
| `state` | `Record<string, unknown>` | no | Shallow-merged into the step's `state_json`. |
| `state_replace` | `Record<string, unknown>` | no | **Replaces** `state_json` entirely. Mutually exclusive with `state`. |
| `result` | string | no | Set on terminal transitions (`done` / `failed` / `skipped`). |
| `error` | string | no | Typically paired with `status: 'failed'`. |
| `attach_artifact_ids` | `string[]` | no | Append to the step's artifact attachment list (idempotent). |
| `attach_inbox_item_ids` | `string[]` | no | Append to the step's inbox attachment list (idempotent). |
| `request_user_input` | `{ message: string; options?: string[]; inbox_item?: { title?: string; labels?: string[] } }` | no | Shortcut that atomically (a) transitions the step to `awaiting_user`, (b) sets `awaiting_user_message`, and (c) creates a linked inbox item. Mutually exclusive with `status`. |

**Entry hook (transition into `running`):** the step's declared
`triggers[]` are materialized as `auto_declared = 1` rows in the
`triggers` table. The dispatcher will pick them up on the next scheduler
wake.

**Exit hook (transition into `done` / `failed` / `skipped`):** every
trigger with `auto_registered_by_step_id` = this step is flipped to
`enabled = 0`. The dispatcher's overlap-skip logic and the kernel's TTL
sweep treat disabled rows as inert. If *all* sibling steps of the
instance are now terminal, the parent `recipe_instances.status` cascades
to `done` (any-failed → `failed`).

**Returns** `structuredContent`:

```ts
{
  recipe_instance_id: string;
  step: {
    id: string;
    step_id: string;
    status: RecipeStepStatus;
    started_at: number | null;
    completed_at: number | null;
    message: string | null;
    awaiting_user_message: string | null;
    state: Record<string, unknown>;
  };
  registered_trigger_ids: string[];     // auto-declared triggers materialized by an entry hook
  disabled_trigger_ids:   string[];     // triggers disabled by an exit hook
  attached_artifact_ids:  string[];
  attached_inbox_item_ids: string[];
  created_inbox_item_id:  string | null;  // populated when request_user_input fires
  recipe_instance_status: 'running' | 'done' | 'failed' | string;
  trigger_registration_errors: Array<{ trigger_type: string; reason: string }>;
}
```

**Errors:**

| Code | Trigger |
|---|---|
| `RECIPE_INSTANCE_NOT_FOUND` | No matching `recipe_instances` row. |
| `STEP_NOT_FOUND` | Step with that `step_id` doesn't exist in this instance. |
| `INVALID_TRANSITION` | The requested transition violates the monotonic matrix. The error detail includes `from` and `to`. |
| `CONFLICTING_ARGS` | `state` and `state_replace` were both supplied, or `request_user_input` was combined with an explicit `status`. |
| `INTERNAL_ERROR` | Unexpected exception inside the transaction. The transition does **not** apply — the DB transaction is rolled back. |

Emits `emitChange('recipes')` on success; additionally emits
`emitChange('inbox')` when `created_inbox_item_id` is non-null.

## Recipe file formats

Both YAML and JSON are first-class on-disk encodings. `js-yaml` parses
both transparently — JSON is a strict subset of YAML — so the reader
(`recipe.read`, `recipe.list`, the scope walker) never branches on
extension. Only `recipe.upsert` needs to pick a writer; it honors the
`format` arg (default `'yaml'`).

The directory scanner accepts `<id>.yaml`, `<id>.yml`, and `<id>.json`.
`recipe.upsert` removes the sibling files in the other extension after a
successful write so a recipe id maps to exactly one file. This avoids the
"is `foo.yaml` or `foo.json` canonical?" ambiguity.

Plugins may ship either format (`provides.recipes[].file` in
`plugin.yaml`); the scope chain resolves through the manifest, so the
file extension is opaque to the resolver.

## Canonical Step schema

`Step` is the shape consumed by `recipe.update_steps` (`add[]` and
`update_meta[]`) and emitted by `materializeSteps` when `recipe.run`
inflates a recipe's `steps[]` block into rows. The TypeScript declaration
lives in `db/recipe-steps-store.ts`.

```ts
interface Step {
  id: string;              // logical step id, unique within the instance
  name?: string;           // short human label
  goal: string;            // required prose goal
  depends?: string[];      // other Step.ids that must complete first
  params?: StepParamDecl[];        // declared params (validated when step starts)
  triggers?: TriggerDecl[];        // auto-declared on entry, disabled on exit
  artifacts?: ArtifactDecl[];      // expected outputs
}

interface StepParamDecl {
  name: string;
  type: string;            // primitive type name; matches validators.ts
  required?: boolean;
  default?: unknown;
  description?: string;
}

interface TriggerDecl {
  type: string;            // registered trigger TYPE id
  params?: Record<string, unknown>;
  cron?: string | null | false;   // three-state, same as trigger.register
  binds_callback_to?: string;             // e.g. 'thread_resume'
  binds_callback_to_recipe?: string;      // recipe id to invoke on fire
  once?: boolean;
  expires_at?: number;
  max_attempts?: number;          // per-trigger override; default 3
  backoff_ms?: number[];          // per-trigger override; default [30000, 120000, 600000]
}

interface ArtifactDecl {
  id: string;
  type: string;
  title?: string;
}
```

**Example.** A step that watches a PR and posts back a review:

```yaml
- id: collect-pr-events
  name: Watch the target PR for new comments
  goal: |
    Subscribe to GitHub PR comment + review events so the next step
    has a complete event stream to summarise.
  depends: [open-pr]
  params:
    - name: pr_number
      type: integer
      required: true
  triggers:
    - type: github.pr_comment
      params: { repo: '$repo', pr_number: '$pr_number' }
      cron: false
      binds_callback_to_recipe: handle-new-pr-comment
      max_attempts: 5
      backoff_ms: [10000, 60000, 300000, 600000, 1800000]
  artifacts:
    - id: pr-summary
      type: pr-review-summary
      title: 'PR review summary'
```

## Story: from `recipe.upsert` to `recipe.done`

This walks the full life of a recipe, from the moment it lands on disk to the
moment the spawned agent writes the final `status: 'success'` row.

### 1. `recipe.upsert` — recipe YAML lands on disk

Call shape:

```jsonc
{
  "id": "review-pr",
  "scope": "project",
  "source": "id: review-pr\nname: Review a PR\ndescription: ...\nsteps:\n  - id: 1\n    goal: ...\n"
}
```

The handler at `recipe.ts:162-189` runs four checks in order:

1. **Id syntax** — `validateId(args.id)` enforces `[a-z][a-z0-9-]*`
   (`workspace.ts:240`). Failure → `INVALID_ID`.
2. **Writable-scope guard** — `ensureWritableScope(args.scope)` (`scope.ts:80`):
   - `project` / `global` → returns `null`, write proceeds.
   - `plugin:<id>` → returns `PLUGIN_SCOPE_READONLY`. Plugin recipes are
     shipped inside the plugin directory under `<globalDir>/plugins/<id>/` and
     resolved through `provides.recipes[]` in the plugin manifest; writing
     them through this tool would mean mutating plugin-owned files in place,
     which we explicitly forbid. The user-facing escape hatch is to call
     `recipe.read scope=plugin:<id>` and then `recipe.upsert scope=project`
     with the same source — that produces a `project`-scope override that
     shadows the plugin's copy on every subsequent `resolveRead`.
   - Anything else → `INVALID_SCOPE`.
3. **Shape validation** — `validateRecipeSource(args.source)` YAML-parses and
   then shape-checks. Required fields (`id`, `name`, `description`) plus enum
   checks on `kind` / `default_client` plus step graph integrity (unique
   integer `id`, declared `depends[]` references). Failure →
   `VALIDATION_FAILED` with a per-path `errors[]` array.
4. **Id consistency** — `parsed.id !== args.id` returns `ID_MISMATCH`. Without
   this guard a caller could write a recipe file whose body claims a
   different id than the filename, causing `resolveRead` to find it (by
   filename) but downstream tools to see a stale id (from the body).

Then the write:

```ts
const target = recipePath(ws, args.scope as 'project' | 'global', args.id);
writeFileAtomic(target, args.source);
```

`writeFileAtomic` (`fs-util.ts:22-37`) writes to `<target>.<pid>.<ts>.tmp` in
the same directory, then `fs.renameSync` over the target. The target's parent
directory is ensured first (`ensureDirSync` = `mkdirSync({recursive:true})`),
so the first ever recipe write in a workspace will create
`.clawdevbox/recipes/` on the fly. There is **no** SSE event — `recipes` is
not in the change-bus topic list for upsert. Existing instance rows for the
old recipe content keep working: each `RecipeInstance` snapshots the YAML at
spawn time (`recipe_snapshot` field), so a recipe edit can't retroactively
corrupt a running instance.

### 2. `recipe.run` — from intent to running pty

Call shape:

```jsonc
{ "id": "review-pr", "prompt": "Look at PR #4123 and post a review", "agent_cli": "copilot" }
```

The handler (`recipe.ts:254-599`) walks through the following sequence.

**2a. Validate the recipe id.** Same `validateId` regex; failure →
`INVALID_ID`.

**2b. Resolve the recipe** via the full scope chain:

```ts
const hit = resolveRead(ws, 'all', 'recipe', args.id, recipePath);
if (!hit) return notFound('recipe', args.id);
```

`'all'` walks **project → every plugin (sorted by id, first match wins) →
global** (`scope.ts:150-174`). The hit's `source` is held in memory for
**2g** below — the spawned instance will store a verbatim snapshot.

**2c. Resolve or create the workspace.** Two branches:

- `args.workspace_id` provided: `getWorkspace(workspacesRoot, args.workspace_id)`
  (`workspaces-store.ts:121`) reads `<workspacesRoot>/index.json` and pulls
  the matching `WorkspaceInfo`. Missing → `WORKSPACE_NOT_FOUND`.
- Omitted: `createWorkspace({ inherit_plugins: true, callerProjectDir: ws.projectDir })`
  (`workspaces-store.ts:276`):
   - Mints a fresh `ws_<base36-ts>_<4hex>` id (`mintWorkspaceId`).
   - Creates `<workspacesRoot>/<id>/` (failure → `WORKSPACE_PATH_EXISTS`).
   - Scaffolds `.clawdevbox/recipes/`, `.clawdevbox/skills/`,
     `.clawdevbox/recipe-instances/`, writes an empty
     `.clawdevbox/triggers.json`, and a `.clawdevbox/workspace.json` meta file
     (`initClawdevboxTree`, `workspaces-store.ts:148-174`).
   - `inherit_plugins: true` is a no-op since the move to a global plugin
     store under `<globalDir>/plugins/`. The flag remains in the signature
     for back-compat — the comment at `workspaces-store.ts:331-336` is
     explicit about this.
   - Appends to `<workspacesRoot>/index.json` (`writeIndex`).
   - Exceptions are caught and mapped to `WORKSPACE_CREATE_FAILED`.

`<workspacesRoot>` itself comes from `resolveWorkspacesRoot()`:
`$CLAWDEVBOX_WORKSPACES_ROOT` if set, otherwise
`~/.clawdevbox/workspaces`.

**2d. Mint the recipe-instance id.** `mintRecipeInstanceId()`
(`recipe-instances-store.ts:90`) → `ri_<base36-ts>_<4hex>`. Time-prefix gives
chronological listings; the 4-hex suffix avoids collisions when two spawns
land in the same millisecond.

**2e. Mint or accept the agent-CLI session id.** From the inline comment at
`recipe.ts:289-293`:

> We ALWAYS pass an explicit id to the CLI rather than let it auto-mint, so:
> the recipe instance can be resumed deterministically later; the UI can show
> the id and offer a "Resume" action; logs in
> `<workspace>/.clawdevbox/sessions/<id>/` are addressable.

```ts
const sessionId =
  typeof args.session_id === 'string' && args.session_id.length > 0
    ? args.session_id
    : `cdb_${instanceId.slice(3)}`;     // strip the "ri_" prefix, prepend "cdb_"
const isResume = !!args.resume_of;
```

The minted form is `cdb_<base36-ts>_<4hex>` — same suffix as the instance id
so an operator scanning logs can correlate them by eye. `isResume` flips the
CLI flag from `--name=`/`--session-id` to `--resume`/`--resume` later in
**2g**.

**2f. Write `.mcp.json`** at `<workspace>/.mcp.json` so the spawned CLI
discovers the same MCP server it was spawned from:

```ts
const mcpSecret = randomBytes(16).toString('hex');
const { command: spawnCmd, args: spawnArgs } = resolveSpawnedMcpCommand();
const mcpConfig = {
  mcpServers: {
    clawdevbox: {
      type: 'local',
      command: spawnCmd,
      args: spawnArgs,
      env: pruneUndefined({
        CLAWDEVBOX_PROJECT_DIR: workspaceInfo.path,
        CLAWDEVBOX_RECIPE_INSTANCE_ID: instanceId,
        CLAWDEVBOX_WORKSPACE_ID: workspaceInfo.id,
        CLAWDEVBOX_WORKSPACES_ROOT: workspacesRoot,
        CLAWDEVBOX_MCP_URL: process.env.CLAWDEVBOX_MCP_URL,
        CLAWDEVBOX_MCP_SECRET: mcpSecret,
        ADO_ORG: process.env.ADO_ORG,
        ADO_PROJECT: process.env.ADO_PROJECT,
        ADO_BEARER_TOKEN: process.env.ADO_BEARER_TOKEN,
      }),
      tools: ['*'],
    },
  },
};
writeFileAtomic(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
```

`resolveSpawnedMcpCommand()` (`recipe.ts:925`) picks `npx -y clawdevbox mcp`
in production; if `CLAWDEVBOX_SPAWN_TSX=1` is set (test fixture) it switches
to `npx -y tsx <src/index.ts>` so the spawn runs against unbuilt source.
`mcpSecret` is a fresh 16-byte hex token — a different one per spawn — that
the spawned CLI must present back to the MCP server over `CLAWDEVBOX_MCP_URL`.
`pruneUndefined` drops any keys whose values are `undefined` so the JSON
stays clean when optional envs (`CLAWDEVBOX_MCP_URL`, `ADO_*`) aren't set.

**2g. Write the initial `RecipeInstance` row** with `pid: null` and
`status: 'running'`. This happens **before** spawning so a crashed pty still
leaves a row on disk for `recipe.instance_info` to find:

```ts
const instance: RecipeInstance = {
  id: instanceId,
  recipe_id: args.id,
  recipe_snapshot: hit.source,           // verbatim YAML at spawn time
  workspace_id: workspaceInfo.id,
  workspace_path: workspaceInfo.path,
  prompt: args.prompt,
  params: args.params ?? {},
  agent_cli: agentCli,
  pid: null,
  started_at: Date.now(),
  status: 'running',
  completed_at: null,
  result: null,
  message: null,
  session_id: sessionId,
  resume_of: args.resume_of ?? null,
};
writeRecipeInstance(workspaceInfo.path, instance);
```

`writeRecipeInstance` (`recipe-instances-store.ts:128-137`) writes
`<workspace>/.clawdevbox/recipe-instances/<instanceId>.json` atomically and
fires `emitChange('recipes')` so SPA viewers refresh immediately.

**2h. Build the pty spawn env.** All of `process.env` is copied in (so the
agent inherits PATH, HOME, etc.) and then the Clawdevbox envs are overlaid:

```ts
spawnEnv.CLAWDEVBOX_PROJECT_DIR = workspaceInfo.path;
spawnEnv.CLAWDEVBOX_RECIPE_INSTANCE_ID = instanceId;
spawnEnv.CLAWDEVBOX_WORKSPACE_ID = workspaceInfo.id;
spawnEnv.CLAWDEVBOX_WORKSPACES_ROOT = workspacesRoot;
spawnEnv.CLAWDEVBOX_MCP_SECRET = mcpSecret;
spawnEnv.CLAWDEVBOX_SESSION_ID = sessionId;
```

These envs are *both* in `.mcp.json` (for the spawned MCP child process the
CLI starts) and in the CLI's own env (so the CLI itself can read e.g.
`CLAWDEVBOX_SESSION_ID`). `recipe.done` reads them straight off
`process.env`.

**2i. Open the log file.** `mkdirSync(instancesDir, {recursive:true})` then a
`createWriteStream(<id>.log, {flags:'a'})` — append mode lets multiple PTYs
flush concurrently without truncating each other should the registry ever
re-attach.

**2j. Per-agent branch — pick the binary & args.**

- **`echo-stub`** (`recipe.ts:381-450`): a test harness. We write a CommonJS
  script to `<id>.script.cjs` that creates a markdown artifact under the
  spawned workspace's `artifacts/<recipe-id>-<...>/` directory and then
  rewrites the instance row to `status: 'success'` with `result.artifact_id`
  + a fully-populated `steps[]`. The script is generated inline as a string
  with `${JSON.stringify(...)}` interpolation for every dynamic value, so
  command-line escaping issues on Windows are avoided. Spawn target:
  `process.execPath <id>.script.cjs`.
- **`copilot`** (`recipe.ts:451-477`):
  ```
  copilot.exe <sessionFlag> --allow-all-tools --additional-mcp-config @<mcpConfigPath> -p <prompt>
  ```
  where `sessionFlag = isResume ? '--resume=<sessionId>' : '--name=<sessionId>'`.
  The inline comment is explicit: "Bypass the agency wrapper and call
  `copilot.exe` directly so we get explicit session-id control without
  depending on agency's internal `--resume` handling." This is a phase-12
  change — before that this branch went through agency. The binary path can
  be overridden via `CLAWDEVBOX_COPILOT_PATH` (useful when the user installs
  to a non-standard location).
- **`claude`** (`recipe.ts:478-491`):
  ```
  claude <sessionFlag> -p <prompt>
  ```
  where `sessionFlag = isResume ? ['--resume', sessionId] : ['--session-id', sessionId]`.
  On Windows the binary is typically `claude.cmd`, so we route through
  `cmd.exe /d /s /c claude ...` to let `PATHEXT` resolve the `.cmd`
  extension. On Unix we invoke `claude` directly.

**2k. Spawn the pty.**

```ts
const ptyProc = pty.spawn(ptyFile, ptyArgs, {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: workspaceInfo.path,
  env: spawnEnv,
});
pid = ptyProc.pid;
```

`node-pty` uses ConPTY on Windows, so there's *no* visible console window —
the child runs against a virtual terminal buffer that the registry reads
from. `cwd` is the spawned workspace path so the agent sees `.mcp.json` and
`.clawdevbox/` siblings of its working directory. Any throw from `pty.spawn`
is caught, the log stream is ended, the instance row is rewritten to
`status: 'failure'` with `message: 'spawn failed: ...'`, and the call
returns `SPAWN_FAILED`.

**2l. Register the pty with the in-process registry:**

```ts
registerPty({ instanceId, workspaceId: workspaceInfo.id, cols: 120, rows: 30, ipty: ptyProc });
```

`pty-registry.ts:86-125` stores the IPty handle, attaches its own `onData`
to append every chunk to a 256 KiB rolling ring buffer, and broadcasts to
every current subscriber. The terminal-server's `/terminal/<id>/ws` handler
calls `subscribe()` per WS connection — each new viewer immediately gets a
`snapshot` event containing the buffer concatenation followed by live
`data` events. This is what `recipe.view_url` URLs land you on.

**2m. Hook the pty's own `onData` and `onExit`** *in addition* to the
registry's hooks:

```ts
ptyProc.onData((data) => { logStream.write(data); });
ptyProc.onExit(({ exitCode, signal }) => {
  logStream.end();
  const current = readRecipeInstance(workspaceInfo.path, instanceId);
  if (current && current.status === 'running') {
    const ok = (signal === undefined || signal === 0) && exitCode === 0;
    writeRecipeInstance(workspaceInfo.path, {
      ...current,
      status: ok ? 'success' : 'failure',
      completed_at: Date.now(),
      message:
        signal !== undefined && signal !== 0
          ? `agent exited via signal ${signal}`
          : `agent exited with code ${exitCode}${ok ? ' (no recipe.done call; treating as success)' : ''}`,
    });
  }
});
```

Two things matter here:

1. The disk-log stream is *separate* from the registry's ring buffer. The
   ring buffer is bounded (256 KiB) and lives in memory only; the disk log
   captures the full session and survives MCP-server restarts.
2. The `onExit` handler **only** rewrites the row when `current.status ===
   'running'`. If the agent already called `recipe.done` (success / failure
   / cancelled), or if `recipe.kill` already cancelled the run, this skip
   is what preserves their authoritative status. The "no recipe.done call;
   treating as success" message in the `message` field is the breadcrumb
   for "the CLI exited cleanly without explicitly marking itself done" —
   which is the normal case for Claude/Copilot, since neither knows about
   our `recipe.done` MCP tool unless the prompt told them to call it.

**2n. Re-read before writing pid.** A subtle correctness point. The
`echo-stub` script runs synchronously and can finish — including writing
`status: 'success'` — before `pty.spawn` returns to JavaScript. If we
blindly wrote `{ ...instance, pid }` we'd clobber that completed status with
the original `status: 'running'` snapshot we built in **2g**. Hence
(`recipe.ts:569-576`):

```ts
if (typeof pid === 'number') {
  const current = readRecipeInstance(workspaceInfo.path, instanceId);
  if (current) {
    writeRecipeInstance(workspaceInfo.path, { ...current, pid });
  } else {
    writeRecipeInstance(workspaceInfo.path, { ...instance, pid });
  }
}
```

The fallback path (no row found) handles the pathological case where the
file was deleted out from under us; we re-write our in-memory snapshot.

**2o. Return** with the structured payload listed above. `view_url` is
`getTerminalServer()?.url(instanceId) ?? null` — `null` means the
terminal-server was never started in this MCP process (e.g. a test that only
exercises `recipe.run` end-to-end). The recipe is now running asynchronously
and the calling agent has its handles.

### 3. `recipe.done` — the spawned agent reports completion

Inside the pty, the spawned CLI eventually calls a tool over its `.mcp.json`:

```jsonc
{ "name": "recipe.done", "arguments": { "status": "success", "result": {"artifact_id":"..."} } }
```

That MCP call lands back at *this same* MCP server (because the spawned
`.mcp.json` pointed at `npx -y clawdevbox mcp`, and the `CLAWDEVBOX_MCP_URL`
in the env steers it to the right endpoint when the server is HTTP-mode).
The handler (`recipe.ts:620-675`) executes:

1. **Env-var lookup.** Pull `CLAWDEVBOX_RECIPE_INSTANCE_ID` and
   `CLAWDEVBOX_WORKSPACE_ID` from `process.env`. Either missing →
   `NOT_IN_RECIPE_INSTANCE` with the message
   *"recipe.done can only run inside a spawned recipe-run session"*. This is
   the only env-gated tool in the family — `instance_info`, `view_url`, and
   `kill` all accept an explicit id and only *fall back* to envs.
2. **Locate the workspace.** `getWorkspace(resolveWorkspacesRoot(), workspaceId)`
   → `wsInfo.path`. Missing → `WORKSPACE_NOT_FOUND`. Note this is a
   completely separate workspace-registry lookup from the one `recipe.run`
   did — it reads the same `<workspacesRoot>/index.json` file.
3. **Locate the instance row.**
   `readRecipeInstance(wsInfo.path, instanceId)` → opens
   `<workspace>/.clawdevbox/recipe-instances/<instanceId>.json`. Missing or
   JSON-parse-fail → `RECIPE_INSTANCE_NOT_FOUND`.
4. **Merge.** Build an updated `RecipeInstance` with the spread of the
   existing row and `{ status, completed_at, result, message }` overlaid.
   Defaults: `status='success'`, `result=null`, `message=null`. Everything
   else (id, recipe_id, recipe_snapshot, started_at, pid, session_id, etc.)
   is preserved.
5. **Write atomically + emit.** `writeRecipeInstance` writes via
   `writeFileAtomic` and fires `emitChange('recipes')`. The SSE bus wakes
   every SPA viewer subscribed to the `recipes` topic; they re-fetch the
   instance row and see the new status.

Soon after, the agent CLI exits. The pty's `onExit` fires in the MCP
server. `readRecipeInstance` finds `status: 'success'` (or whatever the
agent wrote), the `status !== 'running'` check short-circuits, and the
`onExit` handler leaves the row alone. The ring buffer survives in
`pty-registry` for 10 seconds (`EXIT_RETAIN_MS`) so a late viewer can still
see the tail, then the registry entry is dropped. The instance JSON, the
disk log, and any artifacts the agent wrote remain.

## Edge cases & gotchas

- **`recipe.upsert` does not require the recipe to be loadable as YAML in
  every reader.** It calls `validateRecipeSource` which uses `js-yaml`'s
  default `load`; that allows YAML 1.2 syntax that older parsers might
  reject. `recipe.list` and `recipe.read` both use the same `js-yaml`, so
  practically this only matters if an external consumer parses the file
  themselves.
- **`recipe.upsert` writes through `writeFileAtomic`**, but the atomicity is
  per-file. There is no global lock — two concurrent `recipe.upsert` calls
  on the same id will race; the later `renameSync` wins. The
  `.<pid>.<ts>.tmp` filenames are unique per call, so neither write
  corrupts the other's tempfile.
- **Plugin scope is unreachable from `recipe.upsert` / `recipe.delete`** —
  `ensureWritableScope` returns the structured `PLUGIN_SCOPE_READONLY` error
  before any path resolution runs. The escape hatch is to copy to `project`
  scope: `resolveRead(..., 'plugin:<id>', ...)` → take `hit.source` → call
  `recipe.upsert scope=project`. The `project` copy shadows the plugin copy
  on every subsequent `resolveRead`.
- **`recipe.list` scope filter caveat.** When `scope='plugin:<id>'`, the
  scanner enumerates *only that plugin's* `provides.recipes[]` list; when
  `scope='all'`, it walks every enabled plugin (sorted by id) plus project
  + global. There is no "all plugin scopes" shorthand other than `'all'`.
- **`recipe.run` is never blocking.** The handler returns as soon as
  `pty.spawn` succeeds and the pid is recorded. The recipe runs to
  completion asynchronously; status transitions are visible only through
  `recipe.instance_info` or by subscribing to the SSE `recipes` topic.
- **The pty is bound to the MCP-server process.** From the inline comment:
  *"If the server exits while a recipe is running, the agent dies with it.
  That's acceptable for Clawdevbox — the MCP server lives as long as the
  client (Claude Code, Clawdevbox app, etc.) is open, and recipes finish in
  tens of seconds."* This is intentionally a different trade-off from
  `child_process.spawn({detached:true})`. If you need true survivability,
  the agency wrapper handles that on a different layer.
- **`echo-stub` is a race-friendly test fixture.** It writes
  `status: 'success'` from inside the spawned `node` process before the
  outer `pty.spawn(...)` JavaScript call has even returned. The re-read in
  step 2n is the only thing keeping us honest. Any new code that touches
  the instance row after `registerPty` must use the same read-then-merge
  pattern.
- **`recipe.done` is the only tool that uses env-var-only addressing**
  (no explicit `id` input). This is deliberate: a spawned agent shouldn't be
  able to mark *another* instance done by accident, and the envs are
  per-spawn so there's no ambiguity. `recipe.instance_info` and
  `recipe.view_url` accept an explicit id precisely because the *caller*
  often isn't the spawned agent (the SPA, the parent agent, an operator).
- **`recipe.kill` is the only path to `status: 'cancelled'`.** The pty
  `onExit` handler never writes `cancelled` — non-zero exit becomes
  `failure`. If you want a graceful self-cancel, call `recipe.done
  status=cancelled` from inside the spawn.
- **Workspace registry is global to the user.** Every spawned workspace
  appears in `<workspacesRoot>/index.json` regardless of which calling
  project_dir requested it. `recipe.instance_info` scans every workspace
  in the registry when given an explicit id — O(workspaces) but bounded
  in practice.
- **`mcpSecret` is regenerated per spawn.** A leaked `.mcp.json` from a
  previous run cannot authenticate against the current MCP server. The
  secret is also not stored in the instance row; once `.mcp.json` is
  overwritten or the workspace is deleted, it's gone.
- **`inherit_plugins: true` is a no-op.** It's left in the signature for
  back-compat. The actual plugin discovery is global — every workspace sees
  every plugin under `<globalDir>/plugins/`. The structured response still
  echoes `inherited_plugins: []` so old clients don't crash.
- **`recipe.list_running` ≠ `recipe.list of instances with status=running`.**
  The former lists pty sessions in *this MCP server process*; instances
  whose ptys were spawned by a previous MCP-server boot won't appear (their
  ptys are dead). The latter would require a workspace scan via
  `listRecipeInstancesInWorkspace` and a status filter — there is no such
  tool today.
