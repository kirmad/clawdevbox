# Clawdevbox MCP Tools — Complete Reference

> **Single composed reference.** This document is a verbatim composition of every
> per-family doc under `docs/tools/`, normalized to a single heading scheme and
> stitched together with shared cross-references. The per-family docs remain the
> canonical sources; this file is regenerated from them via
> [`scripts/compose_master_doc.py`](./scripts/compose_master_doc.py).

Clawdevbox is a developer-buddy runtime that the [Model Context Protocol
(MCP)](https://modelcontextprotocol.io) exposes to coding agents through a
single Node.js server (`mcp-server/`). This document covers all **12 tool
families** that ship today — 63 tools in total — and the storage, scope, and
event-bus model that holds them together. The rough mental model is:

- A **workspace** is a directory with a `.clawdevbox/` subtree. Workspaces hold
  project-scope recipes, skills, registered triggers, recipe-instances, and
  rendered artifacts.
- **Plugins** live globally under `<globalDir>/plugins/` and are visible to
  every workspace. They ship recipes, skills, hostable tools, trigger types,
  and renderers.
- **Inbox**, **threads**, and **approvals** are the agent-to-user signalling
  layer — the inbox is durable, threads/approvals are in-process today and
  durable once the SQLite kernel lands.
- An in-process **event bus** fans `change` events to every connected SPA tab
  over SSE; `ui.notify` and `notify.send` add browser **Web Push** so a closed
  laptop or sleeping phone can still buzz.

The combined reference below preserves the per-doc "Story" and "Edge cases &
gotchas" sections — those are where most of the practical wisdom lives.

A companion document, [`MCP-TOOLS-REVIEW.md`](./MCP-TOOLS-REVIEW.md), records
issues and inconsistencies uncovered while composing this reference.

## Table of contents

- [Configuration & paths](#configuration--paths)
- [Workspace](#workspace) — `workspace.*` (4 tools)
- [Plugin](#plugin) — `plugin.*` (7 tools)
- [Recipe](#recipe) — `recipe.*` (10 tools)
- [Skill](#skill) — `skill.*` (4 tools)
- [Trigger](#trigger) — `trigger.*` (13 tools)
- [Artifact](#artifact) — `artifact.*` (4 tools)
- [Renderer](#renderer) — `renderer.*` (4 tools)
- [Inbox](#inbox) — `inbox.*` (6 tools)
- [Thread](#thread) — `thread.*` (6 tools)
- [Approval](#approval) — `approval.*` (3 tools)
- [Notify](#notify) — `notify.*` (1 tool)
- [UI](#ui) — `ui.*` (1 tool)
- [Glossary](#glossary)
## Configuration & paths

The whole MCP server hangs off three environment variables plus a small set of
scoping conventions every family doc below assumes. They are summarised here
once.

### `<projectDir>` — `CLAWDEVBOX_PROJECT_DIR`

Required. Identifies the directory the MCP server was booted against. The
in-process `Workspace` object loaded by `loadWorkspaceFromEnv` captures it
verbatim. It is what `recipe.upsert scope=project`, `skill.upsert
scope=project`, `renderer.write`, and the workspace-renderer chain look at.

### `<globalDir>` — `CLAWDEVBOX_GLOBAL_DIR`

Optional. Defaults to `~/.clawdevbox`. Holds account-wide state shared by every
workspace on the machine:

```
<globalDir>/
├── plugins/                     ← every plugin (real dir or junction)
│   └── <id>.install.json        ← sidecar install record per plugin
├── recipes/                     ← global-scope recipes (.yaml)
├── skills/                      ← global-scope skills (.md)
├── inbox.json                   ← inbox metadata (one file, atomic writes)
├── inbox-bodies/                ← per-item body sidecars
├── push-subscriptions.json      ← Web Push subscriptions
├── config.json                  ← `clawdevbox init` output (VAPID, notifications)
├── state.json                   ← per-plugin { enabled } flags
└── node_modules → <repo>/node_modules  ← junction for plugin tool imports
```

### `<workspacesRoot>` — `CLAWDEVBOX_WORKSPACES_ROOT`

Optional. Defaults to `<globalDir>/workspaces`. Houses the workspace registry
(`<workspacesRoot>/index.json`) plus one subdir per minted workspace
(`ws_<base36-ts>_<4hex>`). The MCP server's own `<projectDir>` is *not*
required to live under `<workspacesRoot>` — `clawdevbox mcp` can be launched
against any directory; `workspace.current` simply returns `found: false`.

### The `.clawdevbox/` subtree

Every workspace (and the project dir, if you've registered it) holds a
`.clawdevbox/` directory:

```
<workspace>/
├── .clawdevbox/
│   ├── recipes/                  ← project-scope recipes (.yaml)
│   ├── skills/                   ← project-scope skills (.md)
│   ├── renderers/                ← workspace-shadow renderers (.mjs)
│   ├── recipe-instances/         ← per-spawn JSON rows + .log + .script.cjs
│   ├── triggers.json             ← registered trigger instances
│   └── workspace.json            ← { id, name, created_at, ... }
└── artifacts/                    ← user-facing rendered bundles
    └── <artifact_id>/
        ├── manifest.json
        └── ...content files
```

`.clawdevbox/` is agent-private state; `artifacts/` is deliberately a sibling
so the user can browse / `zip` / commit it without leaking recipe internals.

### Scope chain

Several families (recipes, skills, triggers, renderers) accept a `scope`
parameter. The union is:

```
'project'        →  <projectDir>/.clawdevbox/<family>/...
'plugin:<id>'    →  <globalDir>/plugins/<id>/... (read-only)
'global'         →  <globalDir>/<family>/...
'all'            →  walk project → plugin (sorted by plugin id) → global,
                    first hit wins
```

Read tools accept all four scope values. Write tools accept only `project`
and `global` — plugin scope is read-only via MCP (`PLUGIN_SCOPE_READONLY`)
because plugins ship their definitions inside the plugin directory; the
escape hatch is to copy to `project` scope, which shadows the plugin copy.

Renderers use a slightly different chain — `workspace → plugin → builtin` —
but the same first-hit-wins rule.

### SSE topics

The in-process event bus exposes seven typed topics (`ChangeTopic` in
`event-bus.ts`): `inbox`, `recipes`, `agent`, `tunnel`, `notifications`,
`triggers`, `approvals`. Mutation tools emit a topic; SPA tabs subscribed to
`GET /api/events` re-fetch the corresponding endpoint. `ui.notify` exposes a
`custom` value that the tool rewrites to `notifications` (the typed union has
no `custom` member). `notify.send` does NOT emit anything.

### IDs

Three id patterns recur across families:

| Pattern               | Used by                                | Validator              |
|-----------------------|----------------------------------------|------------------------|
| `[a-z][a-z0-9-]*`     | recipe id, skill id, plugin id         | `validateId`           |
| `[a-z0-9][a-z0-9._-]*` | artifact id, renderer type            | `ARTIFACT_ID_RE` / `TYPE_REGEX` (case-insensitive) |
| `<prefix>_<base36...>`| workspace (`ws_`), recipe-instance (`ri_`), thread (`thr_`), approval (`apr_`), message (`msg_`), run (`run_`) | `mintId` / `mintWorkspaceId` |

`validateId` is enforced by `recipe.upsert`, `recipe.read`, `skill.upsert`,
`skill.read`. It is **not** called by `recipe.delete` or `skill.delete`; see
[`MCP-TOOLS-REVIEW.md`](./MCP-TOOLS-REVIEW.md) F-009.

---
## Workspace

_4 tools — Manage Clawdevbox workspaces — the registry + on-disk `.clawdevbox/` tree._

The `workspace.*` family is a 4-tool surface for managing **Clawdevbox
workspaces** — the unit a recipe runs in. A workspace is just a directory
with a `.clawdevbox/` tree inside it; the registry at
`<workspaces_root>/index.json` is the source of truth for which workspaces
exist.

All four tools are registered in
[`mcp-server/src/tools/workspace.ts`](../mcp-server/src/tools/workspace.ts)
and delegate to pure functions in
[`mcp-server/src/workspaces-store.ts`](../mcp-server/src/workspaces-store.ts).

| Tool                | What it does                                                                            |
| ------------------- | --------------------------------------------------------------------------------------- |
| `workspace.create`  | Mint a new id, scaffold the `.clawdevbox/` subtree, append to the registry.             |
| `workspace.list`    | Read the registry and return every known workspace.                                     |
| `workspace.get`     | O(1) lookup by id; returns the registry row plus best-effort directory-content counts.  |
| `workspace.current` | Reverse-look-up the registry by `CLAWDEVBOX_PROJECT_DIR`; returns `found: false` if no match. |

> **A note on `Workspace` (the type) vs. a workspace (the directory).** The
> MCP server boots with a single read-only `Workspace` from
> `loadWorkspaceFromEnv` (it captures `CLAWDEVBOX_PROJECT_DIR` +
> `CLAWDEVBOX_GLOBAL_DIR` and the plugin registry). The `workspace.*` tools
> operate on the *registry* and the *filesystem*, NOT on that in-process
> `Workspace`. The only thing they read off `ws` is `ws.projectDir`, used
> by `workspace.current` for reverse lookup.

---

### Filesystem layout

```
<workspaces_root>/
  index.json                 ← single registry; map of id → WorkspaceInfo
  <id>/                      ← one directory per workspace
    .clawdevbox/
      recipes/               ← project-scope recipes (.yaml)
      skills/                ← project-scope skills (.md)
      recipe-instances/      ← per-run state for spawned recipes
      triggers.json          ← { "registered": [ ... ] } (file, not a dir)
      workspace.json         ← { id, name, created_at, parent_workspace_id, clawdevbox_workspaces_root }
    ... (whatever the agent puts at the project root) ...
```

#### `<workspaces_root>` resolution

Defined by [`resolveWorkspacesRoot`](../mcp-server/src/workspaces-store.ts):

1. Explicit override passed to the function (used by tests).
2. `$CLAWDEVBOX_WORKSPACES_ROOT` env var.
3. Default: `~/.clawdevbox/workspaces`.

`workspace.create` additionally accepts a `base_path` argument that overrides
the *parent* directory for a single create — the workspace dir still becomes
`<base_path>/<id>`, and the registry entry still records the resolved
`workspaces_root` (NOT `base_path`).

#### Workspace id format

[`mintWorkspaceId`](../mcp-server/src/workspaces-store.ts) returns
`ws_<base36-ts>_<4hex>`:

```ts
`ws_${Date.now().toString(36)}_${randomHex(4)}`
// e.g. ws_m3kqj9z2_a17f
```

The base36 timestamp prefix keeps the directory listing roughly chronological;
the 4-hex random suffix avoids collisions when two `workspace.create` calls
land in the same millisecond. There is no retry-on-collision — the random
suffix is the only collision defense.

#### Registry shape (`index.json`)

```json
{
  "workspaces": {
    "ws_m3kqj9z2_a17f": {
      "id": "ws_m3kqj9z2_a17f",
      "path": "C:\\Users\\me\\.clawdevbox\\workspaces\\ws_m3kqj9z2_a17f",
      "name": "auth-refactor",
      "created_at": 1730000000000,
      "parent_workspace_id": null
    }
  }
}
```

Writes go through `writeFileAtomic` (write to a sibling `*.tmp` file, then
`fs.rename` into place). On POSIX that's atomic; on Windows it's
best-effort-atomic but at minimum partial writes are not observable.

---

### Tools

#### `workspace.create`

##### Signature

```ts
inputSchema: {
  name?:                z.string().min(1),
  parent_workspace_id?: z.string().min(1),
  base_path?:           z.string().min(1),
  inherit_plugins?:     z.boolean(),   // DEPRECATED — no-op
  copy_from?:           z.string().min(1),
}
```

Return `structuredContent`:

```ts
{
  id:                  string,            // newly minted ws_<ts>_<rand>
  path:                string,            // resolved absolute path
  name:                string | null,
  created_at:          number,            // Date.now() at create time
  parent_workspace_id: string | null,
  workspaces_root:     string,            // <workspaces_root> the registry lives in
  inherited_plugins:   string[],          // always [] — see note below
  copied_from_subtrees:string[],          // entries copied from copy_from's .clawdevbox/
}
```

Error codes:

| Code                       | When                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `INVALID_ARGS`             | Both `inherit_plugins` and `copy_from` are set (mutually exclusive).          |
| `WORKSPACE_PATH_EXISTS`    | `<parent>/<id>` already exists on disk (extremely unlikely — id is random).   |
| `WORKSPACE_NOT_FOUND`      | `copy_from` references an id that isn't in the registry.                      |
| `WORKSPACE_CREATE_FAILED`  | Anything else thrown by the create pipeline (mkdir failure, JSON write, ...). |

##### What it does

Mints a new workspace id, creates the workspace directory plus its
`.clawdevbox/` scaffolding, optionally clones the `.clawdevbox/` tree of an
existing workspace, then registers the new row in `<workspaces_root>/index.json`.

##### How it does it

In [`createWorkspace`](../mcp-server/src/workspaces-store.ts):

1. **Resolve root + parent dir.**
   `workspacesRoot = resolveWorkspacesRoot(process.env, args.workspacesRootOverride)`.
   `parentDir = args.base_path ? resolve(args.base_path) : workspacesRoot`.
2. **Mint the id.** `id = mintWorkspaceId()` → `ws_<base36-ts>_<4hex>`.
3. **Compute final path.** `workspacePath = join(parentDir, id)`. Throws
   `WORKSPACE_PATH_EXISTS` if that path already exists.
4. **Re-validate the mutual exclusion** in case any caller bypassed the
   tool layer (`inherit_plugins && copy_from` throws a plain `Error`).
5. **`mkdirSync(workspacePath, { recursive: true })`** — creates the
   directory.
6. **Build the `WorkspaceInfo` row** with `created_at = Date.now()`,
   `name = args.name ?? null`, `parent_workspace_id = args.parent_workspace_id ?? null`.
7. **If `copy_from` is set**, look up the source workspace in the registry
   (`getWorkspace`) and call `copyClawdevboxTreeFrom`. That function
   `cpSync(..., { recursive: true })`s every entry of the source's
   `.clawdevbox/` directory into the new workspace EXCEPT:
    - `recipe-instances/` (per-run state — would be nonsensical to clone)
    - `workspace.json` (gets regenerated for the new id)
    - any path containing `node_modules` or `_legacy-mcp-server`
      (filtered out by the `cp` filter function — these can sneak in if the
      source is a junction-installed local plugin checkout).
   Note `triggers.json` IS copied — the new workspace inherits the same
   registered trigger instances.
8. **Always call `initClawdevboxTree`** (even after `copy_from`). This:
    - `mkdirSync`s `recipes/`, `skills/`, `recipe-instances/` (any subdirs
      not seeded by `copy_from` get filled in here);
    - writes `triggers.json` with `{ "registered": [] }` IF the file doesn't
      already exist (so `copy_from`'s triggers.json survives);
    - writes `workspace.json` with the new workspace metadata, UNCONDITIONALLY
      (so even a `copy_from` workspace gets the *new* id recorded). The
      `cpSync` skip list already excludes `workspace.json` so there's no
      conflict.
9. **`inherit_plugins` handling.** If set with a `callerProjectDir`, the
   code sets `inheritedPlugins = []` and does nothing else. The flag is
   kept purely for API-shape stability — see the note below.
10. **Register in the index.** Read `index.json`, set
    `idx.workspaces[id] = info`, `writeIndex` (atomic).

> **`inherit_plugins` is a deprecated no-op.** In the current build,
> plugins live under `<global_dir>/plugins/` (see [`globalPluginsDir`](../mcp-server/src/workspace.ts))
> and are visible to *every* workspace automatically via the plugin registry
> that the MCP server builds at boot. There is no per-workspace
> `.clawdevbox/plugins/` directory anymore, and no junctioning happens.
> `inheritedPlugins` in the response is always `[]`. The flag is accepted
> only so that older clients don't crash on schema-validation; new code
> should omit it.

---

#### `workspace.list`

##### Signature

```ts
inputSchema: {}  // no arguments
```

Return `structuredContent`:

```ts
{
  workspaces: WorkspaceInfo[],   // sorted by created_at ascending
  count:      number,
  workspaces_root: string,
}
```

No error codes — empty registry returns `count: 0`.

##### What it does

Reads `<workspaces_root>/index.json` and returns every row.

##### How it does it

[`listWorkspaces(root)`](../mcp-server/src/workspaces-store.ts):

1. `readIndex(root)` — if the file is missing or corrupt, returns
   `{ workspaces: {} }` (corruption is swallowed; the registry is treated as
   recoverable rather than fatal).
2. `Object.values(idx.workspaces).sort((a, b) => a.created_at - b.created_at)`.

No directory-existence check is performed — a row whose directory has been
deleted on disk will still appear in the list. Use `workspace.get` (which
reports `dir_exists`) when liveness matters.

---

#### `workspace.get`

##### Signature

```ts
inputSchema: {
  id: z.string().min(1),   // ws_<base36-ts>_<4hex>
}
```

Return `structuredContent`:

```ts
{
  id:                  string,
  path:                string,
  name:                string | null,
  created_at:          number,
  parent_workspace_id: string | null,
  dir_exists:          boolean,
  counts: {
    plugins:             number,   // always 0 — plugins are global now
    recipes:             number,   // count of *.yaml / *.yml in .clawdevbox/recipes/
    skills:              number,   // count of *.md in .clawdevbox/skills/
    registered_triggers: number,   // length of .clawdevbox/triggers.json["registered"]
  }
}
```

Error codes:

| Code                 | When                                     |
| -------------------- | ---------------------------------------- |
| `WORKSPACE_NOT_FOUND`| The id isn't in `index.json`.            |

##### What it does

O(1) lookup of one workspace's metadata, augmented with best-effort counts
of what's inside its `.clawdevbox/` tree.

##### How it does it

1. `getWorkspace(root, id)` — single `readIndex` followed by
   `idx.workspaces[id]`. Returns `null` if absent (→ `WORKSPACE_NOT_FOUND`).
2. `existsSync(info.path)` — flips `dir_exists`. The registry entry and the
   directory can drift apart (e.g. someone `rm -rf`'d the workspace);
   `dir_exists: false` is the way callers detect that.
3. If the directory exists, [`countWorkspaceContents(info.path)`](../mcp-server/src/workspaces-store.ts):
    - Reads `<path>/.clawdevbox/recipes/` and filters by `.yaml`/`.yml`.
    - Reads `<path>/.clawdevbox/skills/` and filters by `.md`.
    - Reads `<path>/.clawdevbox/triggers.json` and returns the length of its
      `registered[]` array (parse errors → `0`).
    - `plugins` is hard-coded to `0` — kept in the response shape only so
      that older clients don't crash on `undefined`.
   If the directory doesn't exist, counts come back as
   `{ plugins: 0, recipes: 0, skills: 0, registered_triggers: 0 }`.

Counts are **best-effort**: any `readdirSync`/`readFileSync` failure is
caught and reported as `0` rather than propagating.

---

#### `workspace.current`

##### Signature

```ts
inputSchema: {}  // no arguments
```

Return `structuredContent`:

```ts
// match found
{
  found:               true,
  id:                  string,
  path:                string,
  name:                string | null,
  created_at:          number,
  parent_workspace_id: string | null,
  workspaces_root:     string,
}

// no match
{
  found:               false,
  project_dir:         string,           // the CLAWDEVBOX_PROJECT_DIR we tried to match
  workspaces_root:     string,
}
```

No error codes — a missing match is a normal `{ found: false }` result, not
an error.

##### What it does

Maps `CLAWDEVBOX_PROJECT_DIR` (the env var the MCP server is booted with)
to a registry row by reverse-looking-up `index.json` by path.

##### How it does it

[`findWorkspaceByPath(root, ws.projectDir)`](../mcp-server/src/workspaces-store.ts):

1. `target = resolve(ws.projectDir)`.
2. `readIndex(root)`.
3. Linear scan: returns the first `WorkspaceInfo` whose `resolve(ws.path) === target`.

If nothing matches, the tool returns `{ found: false }` plus the project
dir and root it tried — this is the common case when a user runs
`clawdevbox mcp` against an arbitrary directory that was never registered
via `workspace.create`.

---

### `inherit_plugins` vs `copy_from`

These two arguments are **mutually exclusive** — passing both returns
`INVALID_ARGS`. The check happens once in the tool layer
(`workspace.create`) and once defensively in `createWorkspace` (the store
function). Today the choice is much narrower than the name suggests:

| Argument          | Today                                                                                       | Use when                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inherit_plugins` | **Deprecated no-op.** Plugins are global; every workspace already sees every plugin.        | Don't. Omit it. Provided only so older clients don't crash on the schema.                                                                            |
| `copy_from`       | Recursive `cpSync` of the source's whole `.clawdevbox/` tree (except `recipe-instances/` and `workspace.json`). | You want to fork an existing workspace — same recipes, same skills, same trigger registrations, but a fresh run history (`recipe-instances/` empty). |

Both options leave the **plugin set** untouched: plugins live globally
under `<global_dir>/plugins/`, so a fresh workspace and a `copy_from`
workspace see the same plugins regardless of which option (if any) was
passed. The two flags are gated against each other purely as
forward-compatibility hygiene — a future build that re-introduces
per-workspace plugin copies should not silently combine "copy plugins
from source" with "junction plugins from caller".

---

### Story: spawning a fresh workspace

What actually happens when an agent calls
`workspace.create({ name: "auth-refactor", copy_from: "ws_old_1234" })`:

1. **Tool handler** in `tools/workspace.ts`:
    - Validates the args via Zod (`name` non-empty, `copy_from` non-empty).
    - Rejects `inherit_plugins && copy_from` with `INVALID_ARGS`. (Only
      `copy_from` set here, so the check passes.)
    - Calls `createWorkspace({ name, copy_from, callerProjectDir: ws.projectDir })`.
2. **`createWorkspace`** in `workspaces-store.ts`:
    - Resolves `workspacesRoot` → `~/.clawdevbox/workspaces` (or the env
      override).
    - Mints id → `ws_m3kqj9z2_a17f`.
    - Computes `workspacePath` → `<workspacesRoot>/ws_m3kqj9z2_a17f`.
    - `existsSync` check: the path is brand new, so no conflict.
    - `mkdirSync(workspacePath, { recursive: true })`.
    - Builds the `WorkspaceInfo` row with `created_at = Date.now()`,
      `name = "auth-refactor"`.
    - Resolves `copy_from` against the registry — `getWorkspace(root, "ws_old_1234")`.
      If absent → throws `WorkspaceNotFoundError` (the tool maps this to
      `WORKSPACE_NOT_FOUND`).
    - Calls `copyClawdevboxTreeFrom` — `cpSync`s `recipes/`, `skills/`,
      `triggers.json`, and anything else in the source's `.clawdevbox/`
      directory, skipping `recipe-instances/` and `workspace.json` (and
      filtering out any nested `node_modules` / `_legacy-mcp-server`).
      Records the copied entries in `copiedFromSubtrees`.
    - Calls `initClawdevboxTree` to fill in missing scaffolding: ensures
      `recipes/`, `skills/`, `recipe-instances/` exist; writes
      `triggers.json` ONLY if not already present (i.e. won't clobber the
      copy); writes the new `workspace.json` recording the new id, name,
      and timestamp.
    - `inherit_plugins` was not set, so no `inheritedPlugins`.
    - Reads `index.json`, inserts the new row, `writeIndex(root, idx)`
      with `writeFileAtomic`.
    - Returns `{ info, workspacesRoot, copiedFromSubtrees: [...] }`.
3. **Tool handler** packs the result into `structuredContent` and returns:
   ```
   Created workspace ws_m3kqj9z2_a17f at <path>.
   ```
   The agent can now call `workspace.get({ id })` to verify, or hand the
   id to `recipe.run` / similar to actually do work inside it.

---

### Edge cases & gotchas

- **The registry can drift from disk.** `workspace.list` doesn't check
  filesystem existence — a workspace that was `rm -rf`'d still appears in
  the list. Use `workspace.get` (which reports `dir_exists`) when you need
  to know whether the directory is still there. Nothing in the store
  auto-prunes drift; cleanup is the caller's responsibility.

- **`workspace.create` is not idempotent.** Each call mints a fresh id and
  inserts a new registry row. Calling it twice with `name: "foo"` produces
  two separate workspaces. There is no name uniqueness check (`name` is
  human-readable only).

- **`base_path` ≠ `workspaces_root`.** Passing `base_path: "C:\\projects"`
  puts the workspace at `C:\projects\<id>\` but the registry stays at
  `<workspaces_root>\index.json`. The registry entry's `path` is the
  resolved absolute path, so `workspace.current` still works as long as
  `CLAWDEVBOX_PROJECT_DIR` points at the same absolute path. Don't expect
  the registry to follow `base_path`.

- **Corrupt `index.json` returns empty.** `readIndex` swallows JSON parse
  errors and returns `{ workspaces: {} }`. This means `workspace.list` can
  silently report `count: 0` after a partial write. Atomic writes via
  `writeFileAtomic` make this unlikely in practice, but if you see an
  empty list where you expected rows, the first thing to inspect is the
  file on disk.

- **Id collisions are theoretically possible.** `mintWorkspaceId` combines
  `Date.now().toString(36)` with a 4-hex random suffix. Two simultaneous
  `workspace.create` calls in the same millisecond have a `1/65536` chance
  of colliding. The code does NOT retry on collision; the
  `existsSync(workspacePath)` check fires `WORKSPACE_PATH_EXISTS` and the
  caller has to retry. In practice this is irrelevant — no agent loops
  fast enough to matter.

- **`copy_from` does not validate the source's `.clawdevbox/` structure.**
  Whatever's in the source dir gets copied (minus the skip list).
  Non-canonical files at the root of `.clawdevbox/` survive the copy.
  This is intentional — it lets plugins drop sidecar config files into a
  workspace and have them propagate to forks — but it does mean that a
  malformed source dir can produce a malformed copy.

- **`workspace.current` is path-exact.** `findWorkspaceByPath` compares
  resolved absolute paths only. A workspace at
  `C:\Users\me\.clawdevbox\workspaces\ws_X` will NOT match
  `CLAWDEVBOX_PROJECT_DIR=C:\Users\me\.clawdevbox\workspaces\ws_X\src`.
  This is by design — projects inside a workspace shouldn't claim to *be*
  the workspace — but it's a frequent source of `found: false` confusion
  when users `cd` into a subfolder before starting the MCP server.

- **`parent_workspace_id` is metadata only.** It's recorded on the row,
  exposed by every read tool, and used by the recipe engine for run
  lineage, but the store applies no cascade behavior: deleting a parent
  does NOT delete (or unparent) its children, and `workspace.create` does
  NOT validate that `parent_workspace_id` resolves to an existing row.
  Treat it as a free-form audit field.

- **Plugins are global; do not look in `.clawdevbox/plugins/`.** The
  legacy project-scope plugins directory is no longer scanned. If
  `loadWorkspaceFromEnv` sees a populated legacy folder at server boot
  it emits a one-time `console.warn` pointing users at `plugin.install`,
  but the `workspace.*` tools have no awareness of it.

---

## Plugin

_7 tools — Install, list, and toggle global plugins under `<globalDir>/plugins/`._

Source: `mcp-server/src/tools/plugin.ts` (registered by
`registerPluginTools(server, ws)`). Seven tools total:
`plugin.list`, `plugin.read`, `plugin.install`, `plugin.update`,
`plugin.uninstall`, `plugin.enable`, `plugin.disable`.

These tools manage the **global plugin store** at
`<globalDir>/plugins/`. The store is shared by every workspace on the
account — there is no per-project plugin scope. (Phase 1 of the spec
collapsed the old `<projectDir>/.clawdevbox/plugins/` tree; the legacy
location is only scanned to print a one-shot migration warning, see
`warnIfLegacyProjectPlugins` in `workspace.ts`.) Anything you install
via `plugin.install` becomes visible to every existing and future
workspace as soon as their plugin registry reloads.

### Filesystem layout

```
<globalDir>/                       ← default: ~/.clawdevbox
├── plugins/
│   ├── <id>/                      ← plugin directory (real dir OR junction)
│   │   ├── plugin.yaml            ← manifest (id, name, version, provides[...])
│   │   ├── tools/                 ← hostable tool .ts/.js/.mjs files
│   │   ├── recipes/               ← recipe .yaml files
│   │   ├── skills/                ← skill .md files
│   │   ├── triggers/              ← trigger-type .ts callbacks
│   │   └── .git/                  ← preserved for git installs only
│   ├── <id>.install.json          ← sidecar install record (NEVER inside the plugin dir)
│   └── .tmp-install-<rand>/       ← atomic-publish scratch dir
├── node_modules → <clawdevbox repo>/node_modules   ← junction for `import 'zod'` etc.
└── state.json                     ← { plugins: { <id>: { enabled: bool } } }
```

Key invariants:

- **Sidecar lives outside the plugin dir.** `pluginInstallRecordPath()`
  in `workspace.ts` deliberately places `<id>.install.json` next to —
  not inside — `<id>/`, so junction-installed plugins don't get extra
  files written into the user's source folder.
- **Plugin dir name == `manifest.id`.** Enforced at reload, not install
  (install picks the dir name from the manifest itself).
- **Atomic publish.** Real-directory installs (git, builtin) always
  write to a sibling `.tmp-install-…/` and `renameSync` into place.
  Discovery never sees a half-written plugin.

### Three install kinds

The sidecar's `kind` field records how the on-disk entry was created.
It drives `plugin.update`'s behavior and is shown in `plugin.read`'s
`origin` block.

| `kind`     | Source spec                                | On-disk representation                                 | `plugin.update`                                  | `plugin.uninstall`                                 |
|------------|--------------------------------------------|--------------------------------------------------------|--------------------------------------------------|----------------------------------------------------|
| `git`      | `git+https://…`, `git+ssh://…` (+ `ref?`)  | Full clone moved into `<globalDir>/plugins/<id>/`; `.git/` retained | `git fetch --prune origin` + `git reset --hard origin/<ref or HEAD>`, then re-validate manifest | `rmSync -r` the directory + delete sidecar |
| `local`    | Absolute path to an existing directory     | `symlink` (POSIX) / `junction` (Windows) at `<globalDir>/plugins/<id>` → user's folder | Error `LOCAL_SOURCE_NO_UPDATE` (edits are already live) | `unlinkSync` the junction (user's source folder is untouched) + delete sidecar |
| `builtin`  | A plugin id under the package's `plugins/` (or `samples/plugins/`) tree | `cpSync` from `resolveBuiltinPluginSource(id)` into a temp dir, then atomic rename | Error `NOT_GIT_INSTALLED` (the message says "reinstall to refresh") | `rmSync -r` the directory + delete sidecar |

A fourth `kind` exists — `manual` — and is written by
`installPluginFromDir` in `cli/plugin-sources.ts` when the user picks
**one subdir out of a multi-plugin git collection** during
`clawdevbox init`. The subdir is `cpSync`'d (filtering `node_modules`,
`_legacy*`, `.git`), so there's no recoverable git history bound to
that specific plugin — `plugin.update` rejects with `NOT_GIT_INSTALLED`
("reinstall to refresh"). The MCP `plugin.install` tool itself never
produces `manual` records; it's an init-time artifact.

Note that `plugin.install` only handles the `git` and `local` paths
directly — it has no `from: "builtin:<id>"` syntax. Built-ins are
installed implicitly by `clawdevbox init` calling
`installBuiltinPlugin(globalDir, id)` for each pick.

### Tools

#### `plugin.list`

**Input:** `{}`

**Output:**

```ts
{
  plugins: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    status: "enabled" | "disabled" | "error";
    provides_summary: string;   // e.g. "3 skills, 1 recipe, 2 tools"
    error?: string;             // populated when status === "error"
  }>;
  count: number;
}
```

Lists every entry already loaded into `ws.plugins` (the in-memory
registry rebuilt by `reloadPluginRegistry`). Does NOT re-scan disk —
if you just dropped a plugin folder into `<globalDir>/plugins/`
out-of-band, you won't see it until the next time something triggers a
reload. The `provides_summary` is computed by `summarizeProvides()` and
counts non-empty `provides.{skills,recipes,triggers,tools,mcp_servers}`
arrays.

**Errors:** none — always succeeds (an empty store returns
`{ plugins: [], count: 0 }`).

#### `plugin.read`

**Input:** `{ id: string (min 1) }`

**Output:**

```ts
{
  id: string;
  dir: string;                                // resolved on-disk path
  status: "enabled" | "disabled" | "error";
  error?: string;
  manifest: PluginManifest;                   // full parsed plugin.yaml
  origin: InstallRecord | null;               // sidecar contents, or null
}
```

Returns the full parsed manifest plus the sidecar install record. The
`origin` is read fresh from disk via `readInstallRecord(ws, id)` rather
than cached — useful for diagnosing drift between sidecar and registry.

**Errors:**
- `NOT_FOUND` — the id isn't in `ws.plugins`. Note: a plugin whose
  manifest failed validation IS still registered with `status:
  "error"`, so `plugin.read` returns it (with the validation message in
  `error`) rather than 404'ing.

#### `plugin.install`

**Input:**

```ts
{
  from: string;       // "git+https://…", "git+ssh://…", or absolute local dir
  ref?: string;       // optional git branch/tag for the `git+` path
}
```

**Output:**

```ts
{
  id: string;                       // manifest.id (== final dir name)
  dir: string;                      // <globalDir>/plugins/<id>
  source_path?: string;             // local-folder installs only
  origin: InstallRecord;            // newly written sidecar
}
```

Branches on `from`:

1. **`from.startsWith("git+")`** → `installFromGit(ws, from, ref)`:
   - `mkdtempSync` a sibling `<globalDir>/plugins/.tmp-install-…/`.
   - `spawnSync("git", ["clone", ...(ref ? ["--branch", ref] : []), gitUrl, tmp])`.
     A full clone — no `--depth 1` — because `plugin.update` needs to
     `git fetch && git reset --hard` across arbitrary refs later.
   - Read `<tmp>/plugin.yaml`, parse YAML, run
     `validatePluginManifest`.
   - Refuse if `<globalDir>/plugins/<manifest.id>/` already exists
     (`PLUGIN_ALREADY_INSTALLED`).
   - `renameSync(tmp, destDir)` — atomic publish.
   - Write `<id>.install.json` with `kind: "git", from, ref, installed_at`.
   - Call `reloadPluginRegistry(ws)` so subsequent `plugin.*` /
     `recipe.list` / etc. see the new entry immediately.

2. **`isAbsolute(from) && existsSync(from) && stat.isDirectory()`** →
   `installFromLocalFolder(ws, from)`:
   - Validate the manifest at `<from>/plugin.yaml`.
   - `createPluginLink(absoluteSource, destDir)` → `symlinkSync(target,
     destDir, "junction" | "dir")`. The user's folder is **never
     copied, never modified**.
   - Sidecar records `kind: "local"`, `source_path:
     <absoluteSource>`.
   - If `manifest.provides.tools[]` is non-empty, best-effort junction
     `<absoluteSource>/node_modules` → host node_modules (see
     `ensureLocalSourceNodeModulesLink`). Failures surface as a
     `nodeModulesHint` in the text output, NOT a structured error —
     declarative plugins (no hostable tools) don't need this.
   - `reloadPluginRegistry(ws)`.

3. **Anything else** → `UNSUPPORTED_FROM` error. In particular, bare
   `https://…` URLs (no `git+` prefix) are rejected here even though
   `cli/plugin-sources.ts::isGitSource` would accept them — the MCP
   tool is stricter on purpose so callers state their intent explicitly.

**Errors:**

| Code                       | When                                                                                  |
|----------------------------|---------------------------------------------------------------------------------------|
| `UNSUPPORTED_FROM`         | `from` is not `git+…` and not an absolute existing directory                          |
| `INVALID_SOURCE`           | `from` is a path that exists but is a file, not a directory                           |
| `GIT_CLONE_FAILED`         | `git clone` returned non-zero (stderr forwarded in `message`)                         |
| `MANIFEST_MISSING`         | `plugin.yaml` not found at the source root                                            |
| `MANIFEST_PARSE_ERROR`     | YAML parse exception                                                                  |
| `VALIDATION_FAILED`        | `validatePluginManifest` returned errors (see below); `errors[]` carries per-field detail |
| `PLUGIN_ALREADY_INSTALLED` | `<globalDir>/plugins/<manifest.id>/` already exists                                   |
| `LINK_FAILED`              | `symlinkSync` failed for a local-folder install (usually permissions on POSIX)        |

On any failure during the git path the temp clone is `rmSync`'d in a
`finally` block — no leftover `.tmp-install-…` directories survive.

#### `plugin.update`

**Input:** `{ id: string }`

**Output:**

```ts
{
  id: string;
  reset_to: string;        // "origin/main", "v1.2.3", or a SHA
  output: string;          // `git reset --hard` stdout (trimmed)
}
```

Behavior:

1. Look up `ws.plugins.get(id)` → `NOT_FOUND` if missing.
2. Load sidecar → `NOT_GIT_INSTALLED` if no record exists ("Reinstall
   via plugin.install or update manually").
3. If `record.kind === "local"` → `LOCAL_SOURCE_NO_UPDATE` ("Edits in
   that folder are already live; there's nothing to pull.").
4. If `record.kind !== "git"` (i.e. `builtin` or `manual`) →
   `NOT_GIT_INSTALLED` ("Reinstall to refresh.").
5. `git fetch --prune origin` in `plugin.dir`. Failure →
   `GIT_FETCH_FAILED`.
6. Determine `resetTarget`:
   - If `record.ref` is empty → resolve `refs/remotes/origin/HEAD` via
     `git symbolic-ref` and strip the `refs/remotes/` prefix. Falls
     back to literal `origin/HEAD` if the symbolic ref lookup fails.
   - If `record.ref` is set → probe `refs/remotes/origin/<ref>` via
     `git show-ref --verify`. If present (it's a branch),
     `resetTarget = "origin/<ref>"`; otherwise (tag, sha)
     `resetTarget = "<ref>"` verbatim.
7. `git reset --hard <resetTarget>`. Failure → `GIT_RESET_FAILED`.
8. Re-check that `plugin.yaml` still exists after the reset →
   `MANIFEST_MISSING` if not (catches the case where the upstream
   renamed/deleted the manifest).
9. `reloadPluginRegistry(ws)` so any manifest changes (new tools,
   altered triggers) take effect immediately.

The deliberate choice of `fetch + reset --hard` over `git pull` avoids
merge conflicts on top of whatever state the working tree was left in
(detached HEAD from a previous pinned ref, local edits a user shouldn't
have made, etc.). The plugin dir is owned by clawdevbox; any local
modifications to a git-installed plugin are unsupported and will be
discarded.

**Errors:** `NOT_FOUND`, `NOT_GIT_INSTALLED`, `LOCAL_SOURCE_NO_UPDATE`,
`GIT_FETCH_FAILED`, `GIT_RESET_FAILED`, `MANIFEST_MISSING`.

#### `plugin.uninstall`

**Input:** `{ id: string }`

**Output:** `{ id: string, dir: string }`

Tolerant of partial state — accepts the call even if the plugin failed
to load and isn't in `ws.plugins`, as long as **any** of (registry
entry, on-disk dir, sidecar) exists. Returns `NOT_FOUND` only when all
three are absent.

Removal sequence:

1. If the entry exists on disk, `lstatSync` it. Symlinks/junctions →
   `unlinkSync(targetDir)` (removes the link, NOT the link target).
   Real directories → `rmSync(targetDir, { recursive: true, force:
   true })`. Failure → `UNINSTALL_FAILED`.
2. `removeInstallRecord(ws, id)` → `unlinkSync` the sidecar (silently
   tolerated if it's already missing).
3. `reloadPluginRegistry(ws)`.

**Crucial guarantee for local installs:** because `lstatSync` reports
the junction as a symlink and we call `unlinkSync` instead of `rmSync
-r`, the user's source folder is never touched. Without that branch,
`rmSync` with `recursive: true` would follow the junction on POSIX and
nuke the source tree.

Project-scope artifacts that were copied out of the plugin during
`recipe.upsert` / `skill.upsert` etc. (under
`<projectDir>/.clawdevbox/`) are NOT touched.

**Errors:** `NOT_FOUND`, `UNINSTALL_FAILED`.

#### `plugin.enable` / `plugin.disable`

**Input:** `{ id: string }`

**Output:** `{ id: string, enabled: boolean }`

Both tools share an implementation (the `for (const action of
['enable', 'disable'] as const)` loop). They flip a flag in
`<globalDir>/state.json`:

```json
{
  "plugins": {
    "ado":   { "enabled": true },
    "myext": { "enabled": false }
  }
}
```

After writing the file, `reloadPluginRegistry(ws)` runs:
`readStateFlags` reads each plugin's flag (default `true` if absent),
and `reloadPluginRegistry` flips `status` to `'disabled'` on entries
where `enabled !== false`. Disabled plugins are then skipped by the
trigger-type registry build pass (lines 412–414 of `workspace.ts`:
`if (plugin.status !== 'enabled') continue`), so their declared
trigger_types, tools, recipes, and skills disappear from every
`*.list` tool until they're re-enabled.

Note that "disabled" still keeps the plugin discoverable by
`plugin.list` and `plugin.read` — only the *provides* sides drop out.

**Errors:** `NOT_FOUND` (the id must already be in `ws.plugins`,
including in `error` state).

### Story: installing a git plugin

A typical end-to-end install of `git+https://github.com/example/clawdevbox-foo.git`:

1. **Caller invokes** `plugin.install({ from:
   "git+https://github.com/example/clawdevbox-foo.git" })`.
2. **Dispatch** in `registerPluginTools`: `from` starts with `git+`,
   call `installFromGit(ws, from, null)`.
3. **Temp clone.** `mkdtempSync` creates
   `<globalDir>/plugins/.tmp-install-XYZ/`. We deliberately put the
   temp dir under `plugins/` (not under `tmpdir()`) so the eventual
   `renameSync` happens within the same volume — `renameSync` is
   POSIX-atomic only when source and destination share a filesystem.
4. **Clone.** `git clone https://github.com/example/clawdevbox-foo.git
   <tmp>` runs synchronously via `spawnSync`. No `--depth 1` because
   `plugin.update` later needs the full history to resolve tags / SHAs
   / branch upstreams. Failure → `GIT_CLONE_FAILED` with the git
   stderr verbatim, then the `finally` block `rmSync`s the temp dir.
5. **Manifest parse.** Read `<tmp>/plugin.yaml`, `yamlLoad` it. Parse
   errors → `MANIFEST_PARSE_ERROR`. Missing file →
   `MANIFEST_MISSING` (the hint mentions `clawdevbox init --plugin
   <url>` as the route for multi-plugin repos).
6. **Manifest validation.** `validatePluginManifest(parsed)` checks:
   - `id` present, matches `[a-z][a-z0-9-]*`.
   - `name`, `description` present.
   - `version` is a valid semver.
   - `provides.{skills,recipes,tools,mcp_servers}[]` each have an
     `id` matching the appropriate pattern (tools use the namespaced
     `TOOL_ID_PATTERN`), a `file` that doesn't contain `..`, and for
     tools specifically a `.ts`/`.js`/`.mjs` extension.
   - `provides.trigger_types[]` pass `validateTriggerTypeEntry` (id,
     callback module, parameters[] shape, optional cron field).
   - Duplicate ids within a family are rejected.

   Failures → `validationError(errors)` → MCP returns
   `code: "VALIDATION_FAILED"` with an `errors[]` array. The temp
   clone is `rmSync`'d.
7. **Conflict check.** If `<globalDir>/plugins/<manifest.id>/` already
   exists, fail with `PLUGIN_ALREADY_INSTALLED`. Reinstall requires an
   explicit `plugin.uninstall` first — we don't silently clobber, even
   on the same source URL.
8. **Atomic publish.** `renameSync(tmp, destDir)`. The plugin
   directory appears in the global store in a single filesystem op —
   `reloadPluginRegistry` running concurrently from another MCP tool
   call would either see the old (absent) state or the new (complete)
   state, never a half-cloned tree.
9. **Sidecar write.** `writeInstallRecord(ws, manifest.id, {
   kind: "git", from, ref: null, installed_at: Date.now() })`
   serializes the record to `<globalDir>/plugins/<id>.install.json`.
10. **Registry rebuild.** `reloadPluginRegistry(ws)`:
    - Clears `ws.plugins`, `ws.triggerTypes`, `ws.triggerTypeErrors`.
    - `readdirSync` the plugins root; for each directory entry:
      parse `plugin.yaml`, validate it (again — this is the defense
      against on-disk tampering between install and use), confirm
      `manifest.id === entry` (the **directory-name security check**;
      a malicious manifest can't declare `id: "ado"` to shadow another
      plugin if its containing dir is named differently).
    - Build the trigger-type registry from `enabled` plugins, sorted
      by id for deterministic collision resolution.
11. **Response.** `{ content: [{ type: "text", text: "Installed plugin
    foo from git+https://github.com/example/clawdevbox-foo.git." }],
    structuredContent: { id: "foo", dir: "<globalDir>/plugins/foo",
    origin: { kind: "git", from, ref: null, installed_at: <ms> } } }`.

The plugin's tools, recipes, skills, and trigger types are now visible
to every workspace on this account on its next plugin-registry read.
Most workspaces will pick the changes up the next time *any* tool
reads the registry (the MCP server's in-memory `ws` reflects the
reload immediately; only out-of-process consumers need to restart).

### Edge cases & gotchas

- **`plugin.install` does not call `ensureGlobalNodeModulesLink`.**
  Only `installBuiltinPlugin` and `clawdevbox init` do. If a user
  bootstraps a workspace with `init` but no plugin picks, then later
  installs a hostable-tool plugin via `plugin.install`, the
  `<globalDir>/node_modules` junction may not exist and tool imports
  of `zod` etc. can fail. Workaround: install at least one plugin
  during `init`, or manually run `init` again.

- **Bare `https://` URLs are rejected.** `plugin.install` requires the
  `git+` prefix. `cli/plugin-sources.ts::isGitSource` is more
  permissive (it accepts `https://`, `ssh://`, `git@`) and is used by
  `clawdevbox init`; the MCP tool intentionally narrowed this so the
  caller's intent is unambiguous.

- **Cross-volume `renameSync` failures.** The git install uses
  `<globalDir>/plugins/.tmp-install-…/` precisely so the final
  `renameSync` is intra-volume. The init-time installer also uses
  `mkdtempSync(tmpdir(), …)` for git clones, then a *whole-clone
  rename* into the global store; on Windows this can fail with
  `EXDEV` if `tmpdir()` and `<globalDir>` are on different drives.
  `plugin.install` avoids this by cloning *directly* into the plugins
  root.

- **Multi-plugin repos aren't supported by `plugin.install`.** The
  tool insists on `plugin.yaml` at the repo root. Repos like
  `clawdevbox-plugins` (one git repo containing many plugins under
  subdirs) have to go through `clawdevbox init --plugin <url>`, which
  uses `discoverPluginsInDir` and the `installPluginFromDir` helper.
  Those subdir installs end up with `kind: "manual"` records, which
  `plugin.update` then refuses to refresh.

- **Local install + manifest id rename.** Because the junction's
  directory name is fixed to `manifest.id` at install time, if a user
  later edits the manifest to a different id, the next
  `reloadPluginRegistry` flags the entry as `status: "error"` with
  message `manifest.id ("bar") does not match plugin directory name
  ("foo"). Rename one to match.` The plugin's provides[] disappear
  from registries until either the manifest is reverted or the user
  `plugin.uninstall foo` and reinstalls.

- **Local install removes only the link.** The branch on
  `lstatSync(targetDir).isSymbolicLink()` in `plugin.uninstall` is
  load-bearing — without it, `rmSync(targetDir, { recursive: true })`
  would follow the junction on POSIX and delete the user's source
  folder. (Windows junctions are not followed by `rmSync` per Node's
  docs, but the unlink path is the same code on both platforms for
  correctness.)

- **Hostable-tool dep resolution.** Plugin tool modules import
  runtime deps like `zod` via standard ESM. Node's resolver walks up
  from the importing file looking for `node_modules`. Two junctions
  cooperate to make that work:
  1. `<globalDir>/node_modules` → clawdevbox's `node_modules` (one
     level above any plugin dir under the global store). Created by
     `ensureGlobalNodeModulesLink`.
  2. For local-folder plugins where the user's source path is *not*
     under `<globalDir>`, Node's `realpath`-based resolution would
     follow the junction back to the user's folder before walking up.
     To cover that case, `ensureLocalSourceNodeModulesLink` creates an
     additional junction `<userSource>/node_modules` → host
     node_modules. Failures here are non-fatal and surfaced as a
     `nodeModulesHint` in the install's text output.

- **`reloadPluginRegistry` is in-process only.** It rebuilds the
  current MCP server's `ws.plugins` map. Other MCP server processes
  (e.g. a second clawdevbox attached to a different project) won't
  see the change until they perform their own reload — typically on
  next boot. Hot plugin install across multiple concurrent workspaces
  is therefore eventually-consistent.

- **`state.json` defaults.** A plugin with no entry in
  `state.plugins[<id>]` is treated as enabled — `readStateFlags`
  returns `{}` on miss and `enabled !== false` is true for `undefined`.
  This means a fresh install is enabled by default; you have to
  explicitly `plugin.disable` to opt out.

---

## Recipe

_10 tools — CRUD for recipe YAML, plus spawning agent CLIs inside hidden ptys._

Recipes are short YAML documents (`id`, `name`, `description`, optional `steps[]`,
`mcp_servers[]`, `kind`, `default_client`, `timeout_minutes`) that describe a unit
of agent work. The `recipe.*` family is the CRUD surface for those YAML files
*plus* the runtime that actually executes one: `recipe.run` spawns a hidden
agent-CLI (Claude Code, Copilot, or a test stub) inside a node-pty, wires the
spawned process back to this MCP server via a generated `.mcp.json`, and records
the run as a `RecipeInstance` JSON row. The spawned agent calls `recipe.done`
to mark itself complete; viewers attach to the pty through the terminal-server
HTTP/WS surface.

All ten tools are registered in `mcp-server/src/tools/recipe.ts` via
`server.registerTool` (lines 68, 121, 151, 193, 216, 603, 679, 747, 799, 866):

| Tool                   | Purpose                                                                  |
|------------------------|--------------------------------------------------------------------------|
| `recipe.list`          | Enumerate recipes across scopes.                                         |
| `recipe.read`          | Read one recipe by id, with project → plugin → global precedence.        |
| `recipe.upsert`        | Write/replace a recipe in project or global scope (plugin scope is RO).  |
| `recipe.delete`        | Remove a recipe from project or global scope.                            |
| `recipe.run`           | Mint an instance, write `.mcp.json`, spawn an agent CLI inside a pty.    |
| `recipe.done`          | Called *from inside* the spawn to mark the instance success/failure.     |
| `recipe.instance_info` | Read an instance row by id, or via env vars from inside a spawn.         |
| `recipe.view_url`      | Get a browser URL that attaches xterm.js to the live pty.                |
| `recipe.kill`          | Terminate the pty and mark the instance cancelled.                       |
| `recipe.list_running`  | List every pty currently registered with this MCP server.                |

### Filesystem layout

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

### Recipe file shape

Validated server-side before every disk write by `validateRecipeSource()` in
`mcp-server/src/validators.ts:56` (which YAML-parses and then defers to
`validateRecipeParsed`, `validators.ts:67-158`). Required fields:

| Field            | Type       | Notes                                                                        |
|------------------|------------|------------------------------------------------------------------------------|
| `id`             | string     | Must match `[a-z][a-z0-9-]*` and equal the upsert `id` arg (see ID_MISMATCH).|
| `name`           | string     | Non-empty.                                                                    |
| `description`    | string     | Non-empty.                                                                    |
| `kind`           | string?    | Enum: `pr_review` \| `workitem` \| `incident` \| `epic` \| `custom`.         |
| `default_client` | string?    | Enum: `claude` \| `copilot`.                                                 |
| `mcp_servers`    | string[]?  | Array of strings.                                                             |
| `timeout_minutes`| number?    | `>= 0`.                                                                       |
| `steps`          | object[]?  | Each step: integer `id` (unique), non-empty `goal`, optional `depends: int[]`.|

Step `depends[]` entries are checked against the set of declared step ids, so
forward references are caught at write time (`validators.ts:117-153`).

### Tools

#### `recipe.list`

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

#### `recipe.read`

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

#### `recipe.upsert`

Write a recipe to project or global scope. Plugin scope is **rejected** —
the design rule is "copy to `project` to customize a plugin-shipped recipe"
(spec §10.6).

**Inputs:**

| Name     | Type                                       | Required | Description                                            |
|----------|--------------------------------------------|----------|--------------------------------------------------------|
| `id`     | string                                     | yes      | Must match `[a-z][a-z0-9-]*` and equal `body.id`.      |
| `scope`  | `'project' \| 'global' \| 'plugin:<id>'`   | yes      | `plugin:<id>` returns `PLUGIN_SCOPE_READONLY`.         |
| `source` | string                                     | yes      | Full YAML body.                                        |

**Returns** `structuredContent`:

```ts
{ id: string; scope: 'project' | 'global'; path: string; }
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

#### `recipe.delete`

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

#### `recipe.run`

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
| `agent_cli`                | `'copilot' \| 'claude' \| 'echo-stub'`     | no                      | Default `'copilot'`. `echo-stub` is a test no-op.                                            |
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
  agent_cli: 'copilot' | 'claude' | 'echo-stub';
  session_id: string;                // explicit CLI session id (cdb_<...> when auto-minted)
  resume_of: string | null;
  status: 'spawned';                 // initial; the instance row is the source of truth thereafter
  log_path: string;                  // <workspace>/.clawdevbox/recipe-instances/<id>.log
  view_url: string | null;           // null if terminal-server isn't running
}
```

**Errors:** `INVALID_REQUEST` (id+source XOR), `INVALID_ID`, `NOT_FOUND`
(recipe), `VALIDATION_FAILED` (inline source malformed), `WORKSPACE_NOT_FOUND`,
`WORKSPACE_CREATE_FAILED`, `SPAWN_FAILED`.

**Ad-hoc vs saved**: ad-hoc runs are useful when the agent composes a one-off
recipe on the fly (e.g. "summarize this list of files"). The full YAML is still
preserved on the `RecipeInstance.recipe_snapshot` field so audit/replay still
works — only the `<scope>/.clawdevbox/recipes/<id>.yaml` write is skipped. To
turn an ad-hoc into a saved recipe later, the agent can call `recipe.upsert`
with the same source.

#### `recipe.done`

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

#### `recipe.instance_info`

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

#### `recipe.view_url`

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

#### `recipe.kill`

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

#### `recipe.list_running`

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

### Story: from `recipe.upsert` to `recipe.done`

This walks the full life of a recipe, from the moment it lands on disk to the
moment the spawned agent writes the final `status: 'success'` row.

#### 1. `recipe.upsert` — recipe YAML lands on disk

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

#### 2. `recipe.run` — from intent to running pty

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

#### 3. `recipe.done` — the spawned agent reports completion

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

### Edge cases & gotchas

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

---

## Skill

_4 tools — CRUD for markdown+frontmatter skill files._

Skills are short markdown documents — a YAML frontmatter block followed by free-form
prose — that the agent consults at runtime. The frontmatter holds the structured
metadata Clawdevbox shows in its UI (name, description, scope); the body is the
instructional content the agent reads. The `skill.*` family is the CRUD surface
for these files. It mirrors `recipe.*` one-for-one, sharing the same scope chain,
the same `structuredError` shape, and the same `ensureWritableScope` guard — only
the on-disk format differs (markdown+frontmatter vs. YAML).

All four tools are registered in `mcp-server/src/tools/skill.ts` via
`server.registerTool` (lines 37, 76, 106, 134):

- `skill.list`
- `skill.read`
- `skill.upsert`
- `skill.delete`

### Filesystem layout

Three scopes are recognized, with strict precedence **project → plugin:&lt;id&gt; → global**
(see `resolveRead` in `mcp-server/src/scope.ts:150`). Each lives at a specific path:

| Scope          | Path on disk                                                   | Writable via tools? |
|----------------|----------------------------------------------------------------|---------------------|
| `project`      | `<projectDir>/.clawdevbox/skills/<id>.md`                      | ✅ yes              |
| `plugin:<id>`  | `<globalDir>/plugins/<id>/<file-from-manifest>`                | ❌ no — read-only   |
| `global`       | `<globalDir>/skills/<id>.md`                                   | ✅ yes              |

The writable paths are constructed by `skillPath()` in
`mcp-server/src/workspace.ts:253`:

```ts
export function skillPath(ws: Workspace, scope: WritableScope, id: string): string {
  if (scope === 'project') return join(ws.projectDir, '.clawdevbox', 'skills', `${id}${SKILL_EXT}`);
  return join(ws.globalDir, 'skills', `${id}${SKILL_EXT}`);
}
```
`SKILL_EXT` is `'.md'` (`workspace.ts:233`).

Plugin-scope skills are *not* a filesystem convention — they are looked up
through the plugin's `provides.skills[]` manifest entry. `readFromScope` in
`scope.ts:109` finds the entry by id, resolves `entry.file` relative to the
plugin's installed directory under `<globalDir>/plugins/<id>/`, and rejects
any path that escapes the plugin root (`pluginFileResolve` in `scope.ts:139`).
A plugin can therefore ship its skills at any path inside its own tree — the
manifest is the source of truth, not the filename.

Project-dir and global-dir scopes are enumerated by directory scan
(`listAllInScope` in `scope.ts:186`): the scanner accepts any `*.md` whose
basename matches `[a-z][a-z0-9-]*` and ignores everything else.

`<projectDir>` comes from the `CLAWDEVBOX_PROJECT_DIR` env var (required);
`<globalDir>` defaults to `~/.clawdevbox` but can be overridden via
`CLAWDEVBOX_GLOBAL_DIR` (`workspace.ts:177-200`).

### Skill file shape

A skill file is one markdown document split into two parts by a `---`-delimited
YAML frontmatter block. The split is enforced by this regex in
`parseSkill` (`validators.ts:175`):

```
/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
```

So the file MUST start with `---\n`, then YAML, then `\n---\n`, then the body.
No leading whitespace, no BOM, no trailing content before the opening fence.

#### Frontmatter fields

`validateSkillSource` (`validators.ts:205`) enforces only two required fields:

| Field         | Required | Type         | Constraint                                    |
|---------------|----------|--------------|-----------------------------------------------|
| `name`        | yes      | string       | non-empty, must match `[a-z][a-z0-9-]*`       |
| `description` | yes      | string       | non-empty                                     |

Everything else is allowed and preserved verbatim — the frontmatter is parsed
as an arbitrary `Record<string, unknown>` (`ParsedSkill.frontmatter` in
`validators.ts:170`). Callers can add any extra keys they want (e.g. `tags`,
`author`, `version`); the validator only checks shape, not schema.

#### Example

```markdown
---
name: writing-skills
description: How to author skills that survive the validator and read well at runtime.
tags: [authoring, meta]
---

# Writing skills

The first line of the body conventionally repeats the name as an H1, but
that's editorial — only the frontmatter is structurally significant.

Everything after the closing `---` is free-form prose. The agent reads
this body verbatim and uses it as guidance.
```

Body content is returned to consumers as the captured second group from the
parse regex — leading `---` fences are stripped, but the body is otherwise
untouched (no markdown rendering happens server-side).

### Tools

#### `skill.list`

Enumerate every skill across the requested scope(s), de-duplicated by id with
project shadowing plugin shadowing global. Lightweight: returns only id, name,
description, and the resolved scope — not the body.

**Inputs** (`skill.ts:42-45`):

| Name     | Type                                                 | Required | Description                                     |
|----------|------------------------------------------------------|----------|-------------------------------------------------|
| `scope`  | `'project' \| 'global' \| 'all' \| 'plugin:<id>'`    | no       | Defaults to `'all'`.                            |
| `search` | string (min length 1)                                | no       | Case-insensitive substring filter applied to id, name, and description. |

**Returns** (`structuredContent`):

```ts
{
  skills: Array<{
    id: string;
    scope: 'project' | 'global' | `plugin:${string}`;
    name: string;        // from frontmatter; falls back to id
    description: string; // from frontmatter; '' when missing or unparseable
  }>;
  count: number;
}
```

**Errors:** none. Files whose frontmatter fails to parse are *silently skipped*
(falling back to `name = id, description = ''`) rather than raising — listing
is best-effort by design.

**How it works:**

1. Calls `listAllInScope(ws, scope, 'skill', skillPath)` (`scope.ts:186`).
2. The helper scans, in this order, only the scope(s) implied by the
   request:
   - **project** → `<projectDir>/.clawdevbox/skills/` (directory walk;
     filenames must end in `.md` and the stem must match `[a-z][a-z0-9-]*`).
   - **plugins** → every enabled plugin's `manifest.provides.skills[]`,
     iterated in plugin-id sort order; each entry's `file` is resolved
     under the plugin's installed dir and skipped if it doesn't exist.
   - **global** → `<globalDir>/skills/` (same directory-walk rules).
3. For each hit, the file is read (`safeRead`, swallowing errors), parsed
   with `parseSkill`, and projected to `{ id, scope, name, description }`.
4. Optional `search` filter is applied client-side: substring match against
   `id`, `name`, or `description` (all lowercased).
5. Returns the filtered list and its count.

The de-dup precedence claimed in the description ("project shadows plugin
shadows global") is implemented at the *enumeration* level: when scope is
`'all'`, the listing visits project first, plugins next (sorted by plugin
id), global last. The returned array therefore contains the highest-priority
entry for each id in that natural order — but the helper does **not** strip
duplicates. If a skill `foo` exists in both `project` and `global`, two rows
are returned, one for each scope. UI consumers (and `resolveRead`) interpret
the first project hit as the active definition.

#### `skill.read`

Resolve a single skill id through the scope chain, return its raw markdown
plus a parsed split of frontmatter and body.

**Inputs** (`skill.ts:81`):

| Name    | Type                                                 | Required | Description                                             |
|---------|------------------------------------------------------|----------|---------------------------------------------------------|
| `id`    | string (min length 1)                                | yes      | Must match `[a-z][a-z0-9-]*` (`validateId`).            |
| `scope` | `'project' \| 'global' \| 'all' \| 'plugin:<id>'`    | no       | Defaults to `'all'` (walk the chain).                   |

**Returns** (`structuredContent`):

```ts
{
  id: string;
  scope: 'project' | 'global' | `plugin:${string}`;  // the scope it resolved from
  source: string;                                     // raw, unmodified file contents
  frontmatter: Record<string, unknown>;               // parsed YAML map, or {} on parse failure
  body: string;                                       // text after the closing `---`,
                                                      // or the entire source if parse failed
}
```

**Errors:**

| Code         | When                                                                |
|--------------|---------------------------------------------------------------------|
| `INVALID_ID` | `id` violates `[a-z][a-z0-9-]*` (`workspace.ts:236`).               |
| `NOT_FOUND`  | No file found in the requested scope (or anywhere when `scope='all'`). |

**How it works:**

1. `validateId(args.id)` — kebab-case guard; structuredError `INVALID_ID`
   on miss (`skill.ts:85`).
2. `resolveRead(ws, scope, 'skill', id, skillPath)` (`scope.ts:150`).
   - For an explicit scope, just one lookup.
   - For `'all'`, the walk is **project → every enabled plugin (sorted by
     id) → global**, first hit wins (`scope.ts:161-170`).
   - Plugin lookups go through the manifest, not by filename guessing.
3. On miss, return `notFound('skill', id)`.
4. On hit, run `parseSkill(hit.source)`. The handler is deliberately
   tolerant: if the parse fails (no fence, bad YAML, non-map frontmatter),
   it falls back to `frontmatter = {}` and `body = hit.source` so that
   reads of malformed files still succeed — clients can show the raw text
   and let the user fix it.

Consumers of the response typically use the three pieces independently:
- `source` — what `skill.upsert` would write back; round-trippable.
- `frontmatter` — drives UI (label, tags, version chips) without re-parsing.
- `body` — fed straight into the agent's prompt as instructional context.

#### `skill.upsert`

Create or overwrite a skill in the project or global scope. Writes are atomic.

**Inputs** (`skill.ts:111-115`):

| Name     | Type                                              | Required | Description                                                                                  |
|----------|---------------------------------------------------|----------|----------------------------------------------------------------------------------------------|
| `id`     | string (min length 1)                             | yes      | Must match `[a-z][a-z0-9-]*`.                                                                |
| `scope`  | `'project' \| 'global'` (also accepts `'plugin:<id>'` — rejected at runtime) | yes | Where to write.                                                                              |
| `source` | string (min length 1)                             | yes      | Full markdown body INCLUDING the leading `---` frontmatter block.                            |

**Returns** (`structuredContent`):

```ts
{
  id: string;
  scope: 'project' | 'global';
  path: string;  // absolute path of the written file
}
```

**Errors:**

| Code                     | When                                                                                |
|--------------------------|-------------------------------------------------------------------------------------|
| `INVALID_ID`             | `id` violates `[a-z][a-z0-9-]*`.                                                    |
| `PLUGIN_SCOPE_READONLY`  | `scope` begins with `plugin:` (`scope.ts:50`).                                      |
| `INVALID_SCOPE`          | `scope` is neither `project`, `global`, nor `plugin:<id>`.                          |
| `VALIDATION_FAILED`      | `parseSkill` rejects the source, or required frontmatter fields are missing/empty. |

`VALIDATION_FAILED` carries an `errors[]` array with the specific paths
(e.g. `frontmatter.name: REQUIRED`, `$: FRONTMATTER_MISSING`).

**How it works:**

1. `validateId(id)` — kebab-case guard.
2. `ensureWritableScope(scope)` (`scope.ts:80`). Plugin scope is read-only
   *via tools* because plugins ship their skills inside the plugin
   package; the only way to "customize" a plugin skill is to copy it to
   project scope. The check returns `PLUGIN_SCOPE_READONLY` for any
   `plugin:*` input and `INVALID_SCOPE` for anything else outside
   `{project, global}`.
3. `validateSkillSource(source)` (`validators.ts:205`). This:
   - Calls `parseSkill` (so frontmatter delimiters and YAML parsing are
     pre-checked).
   - Then requires `frontmatter.name` (non-empty, matches `[a-z][a-z0-9-]*`)
     and `frontmatter.description` (non-empty).
   - Returns a flat `errors[]` of `{path, code, message}` triples.
   - Note: `name` is NOT required to equal `id`. The validator only checks
     shape, not cross-field consistency.
4. `skillPath(ws, scope, id)` — resolves the target file (`workspace.ts:253`).
5. `writeFileAtomic(target, source)` (`fs-util.ts`) — temp-file rename
   write so partial writes don't corrupt readers. Parent directories are
   created as needed by that helper.

#### `skill.delete`

Remove a skill file from project or global scope.

**Inputs** (`skill.ts:138`):

| Name    | Type                                              | Required | Description                  |
|---------|---------------------------------------------------|----------|------------------------------|
| `id`    | string (min length 1)                             | yes      | Skill id to delete.          |
| `scope` | `'project' \| 'global'` (also accepts `'plugin:<id>'` — rejected) | yes | Where to delete from.        |

**Returns** (`structuredContent`):

```ts
{
  id: string;
  scope: 'project' | 'global';
  path: string;  // absolute path of the deleted file
}
```

**Errors:**

| Code                     | When                                                            |
|--------------------------|-----------------------------------------------------------------|
| `PLUGIN_SCOPE_READONLY`  | `scope` begins with `plugin:`.                                  |
| `INVALID_SCOPE`          | `scope` is neither `project`, `global`, nor `plugin:<id>`.      |
| `NOT_FOUND`              | No file exists at the resolved path.                            |

Note: `validateId` is **not** called here (unlike `read`/`upsert`). An
invalid id won't match the kebab-case regex, so `skillPath` builds a path
that simply won't exist, and the tool returns `NOT_FOUND`. This is a small
inconsistency with `skill.read`, which rejects invalid ids up front; in
practice both paths fail safely.

**How it works:**

1. `ensureWritableScope(scope)` — same guard as `upsert`.
2. `skillPath(ws, scope, id)` — resolve target.
3. `existsSync(target)` — if absent, return `NOT_FOUND`.
4. `unlinkSync(target)` — synchronous removal. No trash/undo. No
   `recipe-instances/`-style sweep — skills don't have associated runtime
   state.

### Edge cases & gotchas

- **Validation is shape-only.** `validateSkillSource` accepts any extra
  frontmatter keys. If you rely on a `version` or `tags` field you must
  validate it yourself.
- **`frontmatter.name` is independent of `id`.** The validator forces both
  to match `[a-z][a-z0-9-]*` but doesn't require them to be equal. This is
  by design: `id` is the on-disk filename (drives lookups + URLs), `name`
  is the human-friendly display string. Convention is to match them — the
  built-in plugins do — but it isn't enforced.
- **Plugin-scope reads bypass the filesystem convention.** A plugin's
  `provides.skills[]` may point at any path inside the plugin tree; the
  filename does *not* have to be `<id>.md`. Conversely, a `.md` file
  sitting in a plugin folder is invisible to `skill.*` if it isn't listed
  in `plugin.yaml`. `listAllInScope` (`scope.ts:235-249`) iterates the
  manifest, not `readdir`.
- **Plugin-scope writes are always rejected.** Even if the manifest path
  points back into `<globalDir>/plugins/<id>/skills/<id>.md`, you cannot
  edit it through `skill.upsert`. Copy to `project` scope and edit there;
  the project copy shadows the plugin one for the same id.
- **CRLF is tolerated.** The frontmatter regex matches both `\n` and
  `\r?\n`, so Windows-edited files with CRLF line endings parse correctly.
- **List view never reads the body.** Only `parseSkill` runs (to extract
  frontmatter); the body is read into memory but discarded. Listing 1000
  skills is cheap.
- **Listing is best-effort.** Files with broken frontmatter still appear
  in `skill.list`, falling back to `name = id, description = ''`. They
  show up as nameless rows so users can find and fix them; they don't
  cause the whole listing to error.
- **`skill.read` is more forgiving than `skill.upsert`.** A malformed
  on-disk file can be read (you'll get `frontmatter = {}` and the entire
  source as `body`) but cannot be written back unchanged — `upsert` will
  reject it. This is intentional: read tolerates legacy/corrupt content,
  write enforces the contract.
- **No locking.** Concurrent `skill.upsert` calls for the same id race on
  the atomic rename; last writer wins. Concurrent `delete` + `upsert` is
  undefined and depends on rename/unlink ordering. The expected usage is
  single-agent edits via the MCP server, so this is fine in practice.
- **De-dup is the caller's job.** `skill.list` with `scope='all'` will
  return the same id more than once if it exists in multiple scopes.
  Treat the result list as the authoritative *set of definitions* visible
  to the agent, sorted in resolution order — the first entry per id is
  what `skill.read` would resolve.

---

## Trigger

_13 tools — Plugin-declared trigger types, agent-authored templates, registered instances, and `trigger.test`._

The trigger surface is the kernel that turns plugin-declared and
agent-authored **capabilities** (trigger TYPES) into concrete, addressable
**registered instances** (`<type_id>#<key>`) that an external scheduler can
later fire. The MCP tools here mostly read and mutate metadata — with one
exception (`trigger.test`) they never spawn cron tickers, post webhooks, or
run scripts in production paths. The cron daemon that drives `trigger.fire`
is still a stub; today only `trigger.test` actually executes a script (via
`trigger-runner.ts`). See [Edge cases & gotchas](#edge-cases--gotchas) for
the long list.

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

### Filesystem layout

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

### Two-layer model: types vs registered instances

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
| 1 (lowest) | Plugin-shipped | `<globalDir>/plugins/<plugin_id>/plugin.yaml`'s `provides.trigger_types[]` | `plugin:<id>` |
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

1. Walk `<globalDir>/plugins/*/plugin.yaml`, validate, and populate
   `ws.plugins`.
2. For every **enabled** plugin (sorted by id, deterministic), append each
   `provides.trigger_types[]` entry into `ws.triggerTypes`. Then layer the
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
- `binds_callback_to_recipe` **xor** `binds_callback_to: 'thread_resume'` —
  what to do when this trigger fires. Mutually exclusive (enforced by the
  manifest validator).

Registrations are concrete bindings. The fields you don't see on a TYPE that
appear here: `enabled`, `subscriber_thread_id` (hot-trigger thread binding),
`expires_at` (unix-ms TTL), `once` (self-delete after first success),
`registered_at`, `state` (initialized from `params`; the cron daemon writes
back here), and the `last_run_*` triple.

### Tools

All tools return a `CallToolResult` with `content[0].text` (one-line human
summary) plus `structuredContent` (machine-readable payload). Error responses
set `isError: true` and put `{ code, message, ...extra }` in
`structuredContent`.

#### `trigger.list_types`

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

#### `trigger.list_registered`

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

#### `trigger.register`

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
`once` defaults to `true`, `enabled` is `true`, and
`binds_callback_to: 'thread_resume'` is set on the auto-template when
`subscriber_thread_id` is supplied.

**Signature**

| Param | Type | Required | Description |
|---|---|---|---|
| `type_id` | `string` (min length 1) | XOR | A TYPE id from `trigger.list_types`. |
| `script` | `string` | XOR | Inline script source for a one-off. |
| `script_file` | `string` | XOR | Path under `.clawdevbox/` to read the one-off script from. |
| `runtime` | `'node' \| 'tsx' \| 'python' \| 'bash'` | required when `script` or `script_file` is supplied | Interpreter the runner spawns. |
| `params` | `Record<string, unknown>` | no | Concrete values. Validated against the TYPE's `parameters[]` (which is empty for one-offs). |
| `cron` | `string \| null \| false \| ''` | no | See [cron normalization](#cron-normalization). One-off paths default to `false` when omitted. |
| `subscriber_thread_id` | `string` (min length 1) | no | Hot-trigger thread binding. For one-offs, also flips the auto-template's `binds_callback_to` to `'thread_resume'`. |
| `expires_at` | `number` (unix-ms) | no | Auto-delete after this timestamp. |
| `once` | `boolean` | no | Self-delete after the first successful run. Defaults to `true` for one-off registrations, `false` otherwise. |

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

#### `trigger.unregister`

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

#### `trigger.update_params`

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

#### `trigger.enable` / `trigger.disable`

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

#### `trigger.fire`

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

> **Want to actually run a script today?** Use [`trigger.test`](#triggertest).
> It's currently the only path that spawns a script (via `trigger-runner.ts`).
> When the cron daemon ships, `trigger.fire` will reuse the same runner.

#### `trigger.create_template`

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
| `binds_callback_to_recipe` | `string` | XOR with `binds_callback_to` | Recipe id to invoke on fire. |
| `binds_callback_to` | `'thread_resume'` | XOR with `binds_callback_to_recipe` | Resume the subscriber thread instead of invoking a recipe. |
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
| `VALIDATION_FAILED` | Manifest failed `validateAgentAuthoredTemplate` — id pattern, runtime enum, callback-binding XOR, default_cron validity, parameter schema, etc. The `errors[]` array lists `{ path, code, message }`. |
| `TRIGGER_TEMPLATE_EXISTS` | A template with this id already exists in the chosen scope. (To overwrite, use `trigger.update_template`; to move scopes, delete + create.) |
| `SCRIPT_FILE_OUTSIDE_WORKSPACE` | `script_file` resolved outside `<projectDir>/.clawdevbox/`. |
| `SCRIPT_FILE_NOT_FOUND` | `script_file` resolved under `.clawdevbox/` but no file exists at that path. |

**Side effects.** Writes `template.yaml` and `trigger.<ext>` atomically into
the template directory, then calls `reloadTypeRegistries(ws)` so the new
TYPE is immediately visible to `trigger.list_types` / `trigger.list_templates`
/ `trigger.register`.

#### `trigger.update_template`

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
| `binds_callback_to_recipe` | `string` | no | Replaces the field. |
| `binds_callback_to` | `'thread_resume'` | no | Replaces the field. |
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

#### `trigger.delete_template`

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

#### `trigger.list_templates`

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

#### `trigger.test`

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

### Lifecycle: agent-authored templates

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

### cron normalization

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

### Story: from plugin manifest to fired trigger

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

### Edge cases & gotchas

#### Identity-param collision handling

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

#### `trigger.update_params` does **not** re-mint the id

When you change an identity param (e.g. `repo: auth-svc` → `repo: billing`),
the registered row's id stays `ado.new-pr-watcher#auth-svc`. This is by
design: the id is a stable handle that external systems (webhook URLs,
subscriber threads) may already be holding. If you want a fresh id, the only
correct flow is `trigger.unregister` followed by `trigger.register`. The tool
description calls this out explicitly.

#### Hash-based ids are not RFC-8785-stable

Hash-based id minting sorts top-level keys but uses `JSON.stringify`'s
natural ordering for nested objects/arrays. If a plugin declares a TYPE
without `identity_param` and its `params` schema includes nested object
values whose key order differs between callers, two semantically-identical
registrations could produce different ids. The fix (canonical JSON per
RFC 8785) is documented as a future upgrade in `mintRegisteredId`'s docstring;
for the MVP every shipped TYPE either declares `identity_param` or has flat
params.

#### Cron daemon is **not yet implemented**

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

#### Type uninstall leaves orphan registrations

`plugin.uninstall` removes a TYPE from `ws.triggerTypes` but does not touch
`triggers.json`. Existing registrations stay on disk; `projectRegistered`
flags them with `type_exists: false`. They cannot be fired (the daemon won't
have a script to run) but **can** still be `trigger.unregister`ed,
`trigger.disable`d, and even `trigger.update_params({ cron })`-ed
(cron-only updates skip the TYPE lookup). Updates that change `params`
will fail with `TRIGGER_TYPE_NOT_FOUND` because the param schema is gone.

#### `disable` ≠ "off"; `cron: false` ≠ "stopped"

Two independent kill switches:

- `enabled: false` — the eventual cron daemon must skip this row, but
  `trigger.fire` ignores the flag (manual fires always succeed).
- `cron: false` (or `''`) — this registration never fires on a schedule, but
  it may still fire via webhook (if `accepts_webhook`) or manual fire.

To disable a trigger *completely*, set `enabled: false`. To turn off
scheduling but keep the webhook hookable, set `cron: false`.

#### `triggers.json` corruption is silent

`readTriggersFile` catches all parse errors and returns `{ registered: [] }`.
This is intentional — a corrupt file should never crash the MCP server — but
it means a partially-written file silently presents as an empty registry. The
agent has no way to tell the difference between "nothing is registered" and
"the file was just truncated by a process crash." Atomic writes
(`writeFileAtomic`) keep this from happening in practice; the safety net is
there for editor crashes and disk-full conditions.

---

## Artifact

_4 tools — Renderable bundles produced by agents._

Artifacts are agent-produced renderable bundles — a folder containing a
`manifest.json` and a handful of free-form content files (markdown, JSON,
diffs, SVGs, …). The agent doesn't ship rendered HTML; it ships *data plus a
renderer type*, and a renderer module is resolved at view time. This lets the
same artifact look different in different workspaces (workspace-shadowed
renderer), and lets plugins introduce new artifact types without touching the
core.

The MCP family that creates, lists, fetches and deletes those bundles lives in
`mcp-server/src/tools/artifact.ts`:

- `artifact.add` — register an artifact (creates the folder, writes
  `manifest.json`, optionally writes inline files), returns a `view_url`.
- `artifact.list` — enumerate artifacts across workspaces, optionally
  filtered by `workspace_id` / `recipe_instance_id` / `step_id`.
- `artifact.get` — fetch a single artifact (manifest + file names +
  `view_url`) by id.
- `artifact.delete` — `rm -rf` the artifact folder.

The on-disk format is owned by `mcp-server/src/artifact-store.ts`. The HTTP
viewer routes live in `mcp-server/src/terminal-server.ts`. The renderer
resolution chain is in `mcp-server/src/renderer-registry.ts`. All three are
referenced repeatedly below.

### Filesystem layout

```
<workspace>/
  .clawdevbox/                 ← agent-private config (recipes, skills,
                                  triggers, workspace renderers)
  artifacts/                   ← user-facing publishables
    <artifact_id>/
      manifest.json            ← always present
      <content files>          ← free-form, named per the renderer's contract
```

**Why `artifacts/` is a sibling of `.clawdevbox/`, not inside it.**
`.clawdevbox/` is private state: recipe definitions, skill markdown,
trigger registrations, renderer shadows — things the user typically
doesn't open by hand. Artifacts are the opposite end of the spectrum:
they're the *output* an agent produces for the user to look at. Keeping
them at the workspace root makes them:

- easy to spot when poking around the workspace folder,
- safe to commit to a sibling repo if the user wants to (no recipe
  internals leak),
- and trivially `cp -r`'able / `zip`'able as a publishable bundle.

The renderer-shadow mechanism (workspace-level renderers at
`.clawdevbox/renderers/<type>.mjs`) lives on the config side because it *is*
agent-authored override behavior; the artifact content itself does not.

**One artifact per folder; folder name == artifact id.** This invariant is
load-bearing: every HTTP route, every find helper, and every
`artifact.get` lookup keys off `<workspace>/artifacts/<id>/`. The
manifest is required (a folder without a readable `manifest.json` is
silently dropped by `listArtifacts`), and `id` inside the manifest
must equal the folder name (set automatically by `writeArtifact`).

#### `ARTIFACT_ID_RE`

```ts
const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
```

Enforced by `validateArtifactId` at write time and by every HTTP route
regex (`/^\/artifact\/([A-Za-z0-9._-]+)\//`). Allowed characters:
alphanumerics, dots, dashes, underscores. The leading character must
not be a dot or dash, which keeps the folder out of "hidden file"
territory and rules out IDs like `..`, `.foo`, or `-rf`. There are no
slashes anywhere in the regex, so the id can never escape the
`artifacts/` root via a traversal sequence.

#### Filename validation

`validateArtifactFilename(name)` rejects:

- empty string
- any string containing `..`
- any string containing `/` or `\`
- the literal name `manifest.json`

The first three protect the folder boundary. The fourth is the more
interesting one: it stops callers from overwriting (or, worse,
*replacing*) the manifest by sneaking it in as an inline file. The
manifest is authored only by `writeArtifact` itself; callers that want
to update fields call `artifact.add` again. The terminal-server's
`/artifact/<id>/file/<name>` handler re-validates the filename after
URL decoding, so a percent-encoded `manifest.json` can't be fetched
through that route either.

### Manifest shape

`ArtifactManifest` (defined in `artifact-store.ts`):

```ts
interface ArtifactManifest {
  id: string;                              // folder name; matches ARTIFACT_ID_RE
  type: string;                            // renderer discriminator (see below)
  title: string;                           // human-readable header text
  workspace_id: string;                    // owning workspace
  recipe_instance_id?: string | null;      // optional UI grouping link
  step_id?: string | null;                 // optional UI grouping link
  created_at: number;                      // unix ms; preserved on re-add
  meta?: Record<string, unknown>;          // free-form, renderer-specific
}
```

A few notes:

- **`type`** is the renderer dispatcher key. The HTML host page
  dynamically imports `/__renderer/<type>.mjs`, and the terminal-server
  resolves that URL through the renderer chain below. There is no
  enum — `type` is just a string; plugins can introduce new types.
- **`recipe_instance_id` / `step_id`** exist purely for UI grouping
  ("show me everything this recipe run produced"). They do **not**
  affect storage and do **not** make the artifact GC'd when the
  recipe instance ends. If `recipe_instance_id` is omitted at
  `artifact.add` time, the tool falls back to
  `process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID` (set by `recipe.run` in
  spawned sessions), so artifacts produced inside a recipe pty are
  auto-tagged without the agent having to remember.
- **`created_at`** is set to `Date.now()` on first write and **preserved**
  on subsequent re-adds with the same id. (`artifact.add` reads the
  existing manifest and reuses `created_at` if found.)
- **`meta`** is whatever the renderer wants. The built-in markdown
  renderer, for example, honors `meta.entry` to pick which markdown
  file to load (defaults to `content.md`).

The manifest is written via `writeFileAtomic` (rename-over-temp) so a
concurrent reader never sees a half-written JSON document.

### Renderer dispatch chain

`resolveRendererFile(type, ws)` in `renderer-registry.ts` walks three
candidates in order and returns the first existing file:

1. `<workspace>/.clawdevbox/renderers/<type>.mjs` — **workspace-level**
   override authored by the agent (via `renderer.*` tools). Highest
   priority; lets a workspace customize how, e.g., `pr-review` looks
   without affecting any other workspace.
2. `<plugin_dir>/renderers/<type>.mjs` — **plugin-shipped**. Iterates
   `ws.plugins.entries()` in insertion order; first plugin wins.
   Plugins introduce *new* types this way (e.g., the ADO plugin can
   ship a `pr-review` renderer that knows about ADO-specific fields).
3. `<mcp-server>/src/renderers/<type>.mjs` — **built-in**, the
   fallback. Three are shipped:
   - `markdown.mjs` — loads `meta.entry ?? 'content.md'`, parses with
     `marked@12`, syntax-highlights fenced blocks via `highlight.js`,
     renders fenced ` ```mermaid ` blocks via `mermaid@11`.
   - `pr-review.mjs` — expects `review.json` + `walkthrough.json` +
     `diffs/*.diff`.
   - `walkthrough.mjs` — expects `walkthrough.json`.

The chain is "first match wins" — a workspace renderer for `markdown`
shadows the built-in completely, including when no plugin renderer
exists. `renderer.list` (in `renderer-registry.ts:listAllRendererSources`)
exposes the shadowed entries so the agent can see what it would be
replacing.

The terminal-server serves the resolved file at
`GET /__renderer/<type>.mjs`, so the host page's
`import('/__renderer/markdown.mjs')` call doesn't care which layer
provided the module.

### Tools

#### `artifact.add`

**Input**

```ts
{
  id: string,                              // matches ARTIFACT_ID_RE
  type: string,                            // renderer discriminator
  title: string,                           // header text
  files?: Record<string, unknown>,         // inline name → content map
  workspace_id?: string,                   // explicit target workspace
  recipe_instance_id?: string,             // UI link; env fallback applies
  step_id?: string,
  meta?: Record<string, unknown>,
}
```

**Output (`structuredContent`)**

```ts
{
  id: string,
  type: string,
  title: string,
  workspace_id: string,
  recipe_instance_id: string | null,
  step_id: string | null,
  dir: string,                             // absolute folder path
  files: string[],                         // content files actually on disk
                                            // (excludes manifest.json)
  view_url: string | null,                 // null when terminal server is down
}
```

**Error codes**

| Code | When |
| --- | --- |
| `INVALID_ARTIFACT_ID` | id fails `ARTIFACT_ID_RE` |
| `INVALID_ARTIFACT_FILENAME` | any inline file name fails `validateArtifactFilename` |
| `WORKSPACE_NOT_FOUND` | explicit `workspace_id` (or `CLAWDEVBOX_WORKSPACE_ID` env) is not in the registry |
| `NO_TARGET_WORKSPACE` | no `workspace_id` arg, no env, and `CLAWDEVBOX_PROJECT_DIR` is not a registered workspace |
| `ARTIFACT_TYPE_CONFLICT` | id already exists in the target workspace with a different `type` |

**What it does.** Registers a renderable bundle. The agent typically
writes the heavy content (multi-MB diffs, walkthrough JSON, …) to
`<workspace>/artifacts/<id>/` from a skill first, then calls
`artifact.add` to drop the manifest next to those files. The inline
`files` argument is a convenience for small payloads — strings are
written verbatim as utf-8, anything else is `JSON.stringify(v, null, 2)`'d.

**How it does it.**

1. `validateArtifactId(args.id)` — throws → `INVALID_ARTIFACT_ID`.
2. `resolveTargetWorkspace(ws, args.workspace_id)`:
   - if `args.workspace_id` is set, `getWorkspace(root, id)` against
     `workspaces/index.json`; missing → `WORKSPACE_NOT_FOUND`;
   - else if `CLAWDEVBOX_WORKSPACE_ID` env is set, same lookup;
   - else `findWorkspaceByPath(root, ws.projectDir)` (the MCP
     server's project dir); missing → `NO_TARGET_WORKSPACE`.
3. For each `Object.keys(files)`, `validateArtifactFilename(name)`.
4. `readArtifact(workspacePath, id)` — if it exists with a different
   `type`, `ARTIFACT_TYPE_CONFLICT`; otherwise reuse its `created_at`.
5. Build the `ArtifactManifest`. `recipe_instance_id` falls back to
   `process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID` (set by `recipe.run`).
6. `writeArtifact({ workspacePath, manifest, files })`:
   - `mkdirSync(dir, { recursive: true })`,
   - `writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n')`,
   - for each `[name, value]` in files, `writeFileAtomic` it
     (strings utf-8; objects pretty-JSON).
7. Build `view_url` from `getTerminalServer().url('x')` → origin +
   `/artifact/<id>`. Returns `null` if the terminal server isn't
   running (e.g., in unit tests).
8. Return manifest + on-disk file list + `view_url`.

#### `artifact.list`

**Input**

```ts
{
  workspace_id?: string,                   // narrow to one workspace
  recipe_instance_id?: string,             // filter by manifest field
  step_id?: string,                        // filter by manifest field
}
```

**Output**

```ts
{
  artifacts: Array<ArtifactManifest & { dir: string; view_url: string | null }>
}
```

**Error codes.** None — invalid filters return an empty list rather
than an error.

**What it does.** Enumerates every artifact in the targeted scope.
Default scope is every registered workspace; `workspace_id` narrows to
one.

**How it does it.**

1. Resolve the workspace set:
   - `workspace_id` set → `[getWorkspace(root, id)]` (or `[]` if
     missing — yes, silently).
   - otherwise → `listWorkspaces(root)`.
2. For each workspace, `listArtifacts(w.path)` reads
   `<workspace>/artifacts/` and returns every subfolder with a
   readable `manifest.json`, sorted by `created_at` ascending.
3. Apply optional filters on `recipe_instance_id` and `step_id`
   (strict equality).
4. Annotate each manifest with `dir` (absolute folder path) and
   `view_url` (`/artifact/<id>`, null if terminal server is down).

Note: the listing is across *registered* workspaces only — it does
**not** include the `project` pseudo-workspace that `findArtifact` in
the terminal-server adds. That's deliberate: `artifact.list` is meant
to enumerate publishable artifacts an agent or UI can act on, and the
"loose artifact under the current project dir" case is an HTTP-routing
convenience, not a listed entity.

#### `artifact.get`

**Input**

```ts
{
  id: string,
  workspace_id?: string,                   // narrow search to one workspace
}
```

**Output**

```ts
{
  ...ArtifactManifest,                     // flattened
  dir: string,                             // absolute folder path
  files: string[],                         // content files (no manifest.json)
  view_url: string | null,
}
```

**Error codes**

| Code | When |
| --- | --- |
| `ARTIFACT_NOT_FOUND` | id not present in any of the searched workspaces |

**What it does.** Returns full info for one artifact — the manifest,
the list of content file names, and the viewer URL.

**How it does it.** Iterates the same workspace set as `artifact.list`
(`workspace_id` → singleton; otherwise `listWorkspaces`). For each, it
tries `readArtifact(w.path, id)` and returns on the **first** hit.
Falls through to `ARTIFACT_NOT_FOUND` if nothing matches.

The first-hit-wins semantics matter when two workspaces have an
artifact with the same id — see "Edge cases" below.

#### `artifact.delete`

**Input**

```ts
{
  id: string,
  workspace_id?: string,
}
```

**Output**

```ts
{
  id: string,
  deleted: boolean,                        // false if no folder found
  workspace_id?: string,                   // set on successful delete
}
```

**Error codes.** None. A missing artifact returns `deleted: false`
rather than `ARTIFACT_NOT_FOUND`.

**What it does.** `rm -rf` the artifact folder.

**How it does it.** Iterates the workspace set; the first workspace
whose `artifactDir(w.path, id)` exists wins. Calls
`deleteArtifact(w.path, id)` → `rmSync(dir, { recursive: true, force: true })`.
Returns the workspace id on success.

There is **no cascade**. Inbox items whose `attachments[].artifact_id`
points at a deleted artifact are not touched — their on-disk state
is unchanged. The `/api/inbox` enrichment helper in
`mcp-server/src/cli/start.ts` (`enrichInboxItemsForList`) detects the
missing artifact at read time and sets the transient
`resolved: false` flag plus a `view_url: null` on the attachment, so
the SPA can render a "dangling" chip without exploding. There is no
event fired and no warning logged.

### HTTP viewer routes

Served by `mcp-server/src/terminal-server.ts`:

| Method & path | Purpose |
| --- | --- |
| `GET /artifact/<id>` | HTML host page (CSP-styled shell + `<script type="module">` that dynamic-imports the renderer) |
| `GET /artifact/<id>/manifest` | `application/json` — the raw `ArtifactManifest` |
| `GET /artifact/<id>/files` | `application/json` — `{ id, dir, files: string[] }` (manifest.json excluded) |
| `GET /artifact/<id>/file/<name>` | raw bytes; `Content-Type` derived from filename extension |
| `GET /__renderer/<type>.mjs` | the resolved renderer module (workspace → plugin → builtin) |

All five routes route through `findArtifact(id)`, which searches:

1. `CLAWDEVBOX_PROJECT_DIR` (the env-set project dir, treated as a
   pseudo-workspace with id `'project'`), then
2. every workspace in `listWorkspaces(resolveWorkspacesRoot())`.

The project-dir fallback exists so an agent running directly against a
folder that isn't a registered workspace (typical `clawdevbox start`
in a checkout) can still serve its artifacts.

The host page (see `renderArtifactHostHtml` in `terminal-server.ts`)
builds a minimal dark-themed shell with a header (id, type pill, title)
and a single `<div id="artifact-root">`. Its `<script type="module">`
fetches the manifest and file list, builds a `ctx` object:

```ts
{
  manifest,
  artifactId: id,
  listFiles: () => Promise<string[]>,
  fetchFile: (name) => Promise<string>,    // text via /artifact/<id>/file/<name>
  fetchFileJson: (name) => Promise<any>,
}
```

then `await import('/__renderer/<type>.mjs')`, asserts the module has
a `.render(root, ctx)` function, and awaits it. Renderer errors are
caught and rendered as a red-text `<pre>` so the host page never goes
blank. The page also stashes the loaded data on
`window.__clawdevboxArtifact` to help with debugging.

The `/artifact/<id>/file/<name>` handler **re-validates** `name` after
URL decoding (rejects `..`, `/`, `\`, and `manifest.json`) so a
malicious renderer can't escape the artifact folder via
`fetchFile('../../etc/passwd')`. Content-Type is picked from a small
extension map (`.md`, `.json`, `.txt`, `.html`, `.css`, `.js`, `.svg`,
`.png`, `.jpg`, `.gif`, `.diff`, `.patch`) and falls back to
`application/octet-stream`. Bodies are streamed via `createReadStream`,
not buffered, so multi-MB diffs don't eat heap.

### Story: agent produces an artifact, user opens it

A realistic end-to-end trace, walking from skill invocation to pixels:

1. **Agent invokes a skill.** Say the agent is reviewing a PR and the
   `pr-review` skill is responsible for emitting the artifact. The
   skill's job is to write the data files; it doesn't touch the MCP
   surface yet. It runs something like:
   ```
   $workspace/artifacts/pr-1234-review/
     review.json           ← author wrote this
     walkthrough.json
     diffs/auth.ts.diff
     diffs/router.ts.diff
   ```
2. **Agent calls `artifact.add`.**
   ```ts
   artifact.add({
     id: 'pr-1234-review',
     type: 'pr-review',
     title: 'Auth service · PR 1234 review',
     recipe_instance_id: 'ri_…',   // or omitted; env-fallback applies
     meta: { pr_id: 1234 },
   });
   ```
   The tool resolves the target workspace, sees the files already on
   disk, validates the id, builds the `ArtifactManifest`, and writes
   `manifest.json` atomically next to the files. Because no `files`
   arg was passed, nothing else is written. The response includes
   `view_url: http://127.0.0.1:<port>/artifact/pr-1234-review`.
3. **Agent links the artifact from an inbox item.** The same agent
   then calls `inbox.upsert` with
   `attachments: [{ artifact_id: 'pr-1234-review', title: '…' }]`.
   The SPA receives an SSE `change: inbox` event.
4. **SPA refetches `/api/inbox`.** `enrichInboxItemsForList` in
   `cli/start.ts` builds an index of every artifact across the project
   dir + registered workspaces; for each attachment it sets
   `view_url: /artifact/<id>` and `resolved: true`. The inbox card
   shows a clickable chip.
5. **User clicks the chip.** `ui.ts:openArtifact` pushes a tab keyed
   `artifact:pr-1234-review` and renders `ArtifactPanel.vue`, which
   embeds the artifact via a *sandboxed* `<iframe src="/artifact/pr-1234-review">`
   (`sandbox="allow-scripts allow-same-origin allow-popups …"`). The
   `allow-same-origin` flag is required so the iframe's dynamic
   `import('/__renderer/…')` can fetch from the same origin; the rest
   of the sandbox keeps renderer code from navigating the parent SPA.
6. **Terminal-server serves the host page.** `serveArtifactHost`
   calls `findArtifact('pr-1234-review')`, finds it in the resolved
   workspace, and emits the dark-themed HTML shell with an embedded
   `<script type="module">`.
7. **Browser bootstraps the viewer.** That script `fetch`es
   `/artifact/pr-1234-review/manifest` and `/files`, then
   `import('/__renderer/pr-review.mjs')`. The terminal-server walks
   the chain — no workspace shadow, no plugin renderer, so it serves
   the built-in `mcp-server/src/renderers/pr-review.mjs`.
8. **Renderer paints the DOM.** The built-in `pr-review` module calls
   `ctx.fetchFileJson('review.json')`, `fetchFileJson('walkthrough.json')`,
   iterates the diffs through `ctx.fetchFile`, and writes its HTML into
   the host page's `<div id="artifact-root">`. (The `markdown` renderer
   takes the same shape: marked → highlight.js → mermaid; **no
   DOMPurify** — the artifact is sandbox-isolated, so the renderer
   trusts its own content.)
9. **User finishes reading.** Closing the tab is a no-op; the artifact
   stays on disk. Re-clicking later re-runs steps 5–8 against the
   same files.

When the agent later runs `artifact.delete('pr-1234-review')`, the
folder vanishes. The inbox item still references the id, but the next
`/api/inbox` refresh enrichment turns it into a `resolved: false`
chip with `view_url: null` and the SPA renders a greyed-out "dangling"
state.

### Edge cases & gotchas

- **Artifact-id collisions across workspaces.** `findArtifact` (HTTP
  routes), `artifact.get`, and `artifact.delete` all iterate the
  workspace set and take the **first** hit. The order is "project
  dir first, then `listWorkspaces` order" for HTTP routes, and just
  `listWorkspaces` order for the MCP tools (no project pseudo-fallback).
  If two workspaces both contain an artifact named `pr-1234-review`,
  whichever the iteration sees first wins — the other is invisible
  via id-only lookups. Pass `workspace_id` to disambiguate, or use
  workspace-scoped ids like `ws-acct123-pr-1234-review`.
- **`manifest.json` is reserved.** You cannot write a content file
  named `manifest.json` through `artifact.add(files: { … })` — the
  filename validator rejects it. You also cannot fetch it through
  `/artifact/<id>/file/manifest.json` — the route validator rejects
  the same name (use `/artifact/<id>/manifest` instead). This makes
  the manifest authoritative and prevents stale shadow copies.
- **Type conflicts are sticky.** If you write `pr-1234` as
  `type=markdown` and then re-add it as `type=pr-review`,
  `artifact.add` fails with `ARTIFACT_TYPE_CONFLICT`. Delete first
  (or pick a different id). The intent is to keep the renderer
  contract stable for a given id — downstream code that points at
  `/artifact/<id>` shouldn't have the renderer change under it.
- **`created_at` is preserved on re-add.** Re-adding the same id
  reuses the existing `created_at` and overwrites everything else
  (including `recipe_instance_id`, `step_id`, `meta`). If you want
  a fresh timestamp, delete first.
- **No `recipe_instance_id` GC.** Deleting a recipe instance does
  **not** delete its artifacts. This is deliberate: artifacts are
  meant to outlive the ephemeral recipe state that produced them.
  The reverse is also true — deleting an artifact leaves the
  recipe instance's `result.artifact_id` reference dangling, and
  the recipe UI shows it as such.
- **No view_url when the terminal server isn't running.** Unit tests
  and headless agents that spin the MCP server up without the HTTP
  layer get `view_url: null` from `artifact.add` / `list` / `get`.
  All other behavior is unchanged; you can still inspect the manifest
  on disk.
- **`artifact.list` does not include the project pseudo-workspace.**
  Loose artifacts under `CLAWDEVBOX_PROJECT_DIR/artifacts/` are
  visible to the HTTP routes (so `view_url` works) but not to
  `artifact.list`. If you want them enumerable, register the project
  dir as a workspace.
- **Atomic writes, non-atomic groups.** `writeFileAtomic` makes each
  individual file safe against torn reads. But `writeArtifact` writes
  the manifest first, then each content file in turn; if the process
  dies between writes, a reader can see the manifest pointing at
  files that don't exist yet. Renderers should `await ctx.fetchFile(name)`
  and tolerate 404s rather than assuming everything in
  `ctx.listFiles()` is readable.
- **Filename URL decoding.** The HTTP route decodes `:filename` once;
  the validator runs on the decoded value. A percent-encoded
  traversal (`%2E%2E%2Fpasswd`) decodes to `../passwd`, fails the
  `'..'` check, and gets a 400. Don't add a second decode pass — the
  current logic is correct as a single decode.
- **Renderer crashes don't break the host page.** Errors thrown from
  `renderer.render(root, ctx)` are caught and rendered as a red
  `<pre id="artifact-error">` block. The error includes the renderer
  stack, which is invaluable for debugging workspace shadows that
  forgot to `export default { render }`.
- **No write API for content files.** There is no `artifact.write_file`
  tool. Agents are expected to write content via normal filesystem
  tools (their own `Bash` / `edit` / skill-internal logic) into
  `<workspace>/artifacts/<id>/` and then call `artifact.add`. The
  inline `files` arg in `artifact.add` is a convenience for tiny
  bundles; it's not the primary path for anything large.

---

## Renderer

_4 tools — Workspace-shadowable `.mjs` renderers for artifact `type`s._

Artifacts in Clawdevbox are folders on disk (`<workspace>/artifacts/<id>/`) that
ship their own client-side renderer. When a browser opens
`GET /artifact/:id`, the terminal-server emits a tiny host page that
dynamically imports the renderer for the artifact's `type` from
`GET /__renderer/<type>.mjs`. That `.mjs` is resolved through a three-layer
**scope chain**: workspace → plugin → built-in.

The `renderer.*` MCP surface lets an agent inspect that chain, read the source
of whatever is currently active, and **shadow** any plugin or built-in by
dropping a workspace-level `.mjs` file. Plugin and built-in renderers are
read-only through MCP — to change them you ship a new plugin version
(`plugin.install` / `plugin.update`) or change the mcp-server source.

Tools (all in [`mcp-server/src/tools/renderer.ts`](../mcp-server/src/tools/renderer.ts)):

| Tool              | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `renderer.list`   | Enumerate every renderer in every scope, flag the winner |
| `renderer.read`   | Return the source of the active renderer for a type      |
| `renderer.write`  | Author / overwrite a **workspace** renderer (`<type>.mjs`)|
| `renderer.delete` | Remove a workspace renderer (falls back to next scope)   |

---

### Filesystem layout

```
<projectDir>/                         ← workspace root
└── .clawdevbox/
    └── renderers/
        ├── custom-report.mjs         ← agent-authored, highest priority
        └── markdown.mjs              ← shadows the built-in markdown

<globalDir>/plugins/<plugin-id>/
└── renderers/
    └── pr-review.mjs                 ← plugin-shipped, middle priority

<package-root>/dist/renderers/        ← (src/renderers/ at dev time)
├── markdown.mjs                      ← built-in, lowest priority
├── pr-review.mjs
└── walkthrough.mjs
```

`workspaceRenderersDir(projectDir)` = `<projectDir>/.clawdevbox/renderers/`
(see [`renderer-registry.ts`](../mcp-server/src/renderer-registry.ts) line 41).

`BUILTIN_DIR` is resolved relative to the registry module itself:
`dirname(fileURLToPath(import.meta.url))` + `/renderers`. At build time
[`scripts/build.mjs`](../mcp-server/scripts/build.mjs) copies
`src/renderers/` verbatim to `dist/renderers/` so the same path works in
both dev (`tsx`) and packaged runs.

Plugin renderers are discovered by iterating `ws.plugins` (the
`PluginEntry` map populated during plugin discovery) and looking for
`<plugin.dir>/renderers/<type>.mjs`. A plugin contributes at most one
renderer per type.

---

### Three-layer scope chain

`resolveRendererFile(type, ws)` walks the chain top-to-bottom and returns the
first file that exists:

| # | Scope       | Path                                                              | Writable via MCP? |
| - | ----------- | ----------------------------------------------------------------- | ----------------- |
| 1 | `workspace` | `<projectDir>/.clawdevbox/renderers/<type>.mjs`                   | ✅ `renderer.write` / `renderer.delete` |
| 2 | `plugin`    | `<plugin.dir>/renderers/<type>.mjs` (iterated in plugin-map order)| ❌ ship via plugin |
| 3 | `builtin`   | `<package-root>/{src,dist}/renderers/<type>.mjs`                  | ❌ ship via mcp-server |

A workspace renderer **completely** replaces the lower layers for that
type — there is no inheritance, no super-call. If you want behaviour
derived from a built-in, use `renderer.read` to get its source, copy it,
modify, and `renderer.write` the result.

Type names must match `/^[a-z0-9][a-z0-9._-]*$/i` — anything else is
rejected with `INVALID_TYPE`.

---

### Module contract

Every renderer is a browser ES module loaded via dynamic `import()`. The
shape is the same in all three scopes:

```js
export default {
  type: '<type>',                    // documentation only, not enforced
  async render(rootElement, ctx) {
    // mutate rootElement: append children, set styles, etc.
  },
};
```

Verified by reading the three built-ins:

- `markdown.mjs` line 91: `export default { type: 'markdown', async render(root, ctx) { ... } }`
- `pr-review.mjs` line 442: `export default { type: 'pr-review', async render(root, ctx) { ... } }`
- `walkthrough.mjs` line 203: `export default { type: 'walkthrough', async render(root, ctx) { ... } }`

The host page does `const renderer = mod.default ?? mod;` and then
`await renderer.render(root, ctx)`. If `.render` isn't a function the host
displays a red error in `#artifact-error`.

#### The `ctx` object

Constructed by the artifact host page in
[`terminal-server.ts`](../mcp-server/src/terminal-server.ts) (around line 450):

```ts
const ctx = {
  manifest,                                                       // ArtifactManifest
  artifactId: id,                                                 // string
  listFiles: async () => filesList,                               // Promise<string[]>
  fetchFile:     (name) => fetchText(`/artifact/${id}/file/${name}`),  // Promise<string>
  fetchFileJson: (name) => fetchJson(`/artifact/${id}/file/${name}`),  // Promise<unknown>
};
```

| Field           | Type                            | Notes |
| --------------- | ------------------------------- | ----- |
| `manifest`      | `ArtifactManifest`              | parsed `manifest.json`; `manifest.meta` is the agent-supplied bag |
| `artifactId`    | `string`                        | same value as the URL slug |
| `listFiles()`   | `Promise<string[]>`             | every content file in the artifact folder except `manifest.json` |
| `fetchFile(n)`  | `Promise<string>`               | raw text body of one file |
| `fetchFileJson(n)` | `Promise<unknown>`           | parsed JSON body of one file |

The renderer is responsible for choosing which files it needs. Conventions
(e.g. `content.md`, `review.json`, `walkthrough.json`) are per-type and
documented in each built-in module.

---

### HTTP route

The browser loads the resolved module from a single endpoint:

```
GET /__renderer/<type>.mjs
```

Implementation: [`terminal-server.ts`](../mcp-server/src/terminal-server.ts)
function `serveRenderer` (line 361). It calls `resolveRendererFile(type, activeWorkspace)`,
reads the file with `readFileSync`, and serves with
`Content-Type: application/javascript; charset=utf-8`.

| Condition                                  | Response                                         |
| ------------------------------------------ | ------------------------------------------------ |
| Type matches a workspace / plugin / builtin| `200`, body = `.mjs` source                      |
| `resolveRendererFile` returns `null`       | `404` `{ "error": "RENDERER_NOT_FOUND", "type" }`|
| `readFileSync` throws                      | `500` `{ "error": "RENDERER_READ_FAILED", ... }` |
| Terminal-server started without a workspace| `500` `{ "error": "NO_WORKSPACE_CONTEXT" }`      |

The type segment of the URL is constrained by the route regex
`^/__renderer/([A-Za-z0-9._-]+)\.mjs$`, which matches the validation
regex used by the MCP tools.

---

### Tools

#### `renderer.list`

```ts
input: {}
output: {
  renderers: Array<{
    type: string;
    source: 'workspace' | 'plugin' | 'builtin';
    sourceId: string;       // projectDir | plugin id | 'builtin'
    filePath: string;       // absolute path on disk
    active: boolean;        // true = served by /__renderer/<type>.mjs
  }>;
}
```

**What it does.** Returns every `.mjs` the resolver can see across every
scope. For each `type`, the highest-priority entry has `active: true` and
all shadowed entries have `active: false`, so the agent can see exactly
what would be displaced by writing a workspace shadow.

**How it does it.** Delegates to `listAllRendererSources(ws)` in the
registry. That function:

1. Lists workspace `.mjs` files via `listMjsTypesIn(workspaceRenderersDir(projectDir))`.
2. Iterates `ws.plugins.entries()` and lists `.mjs` files under each plugin's `renderers/` dir.
3. Lists built-in `.mjs` files via `listMjsTypesIn(BUILTIN_DIR)`.
4. Sorts the union of all types and, for each, emits entries in scope-chain
   order — the first entry gets `active: true`, the rest get `active: false`.

Read-only, no side effects.

#### `renderer.read`

```ts
input: {
  type: string;             // /^[a-z0-9][a-z0-9._-]*$/i
}
output: {
  type: string;
  source: 'workspace' | 'plugin' | 'builtin';
  source_id: string;
  file_path: string;
  code: string;             // the full .mjs source
}
errors:
  INVALID_TYPE              // type fails the regex
  RENDERER_NOT_FOUND        // no scope provides this type
  RENDERER_READ_FAILED      // existsSync passed but readFileSync threw
```

**What it does.** Returns the source code of the **active** renderer for a
type — i.e. whichever one would currently be served by
`/__renderer/<type>.mjs`. The intended use is "show me the built-in so I
can copy / fork it into a workspace shadow".

**How it does it.** Calls `resolveRendererFile(type, ws)` (same function
the HTTP route uses, so the result is guaranteed to match what the browser
sees), then `readFileSync(entry.filePath, 'utf8')`.

#### `renderer.write`

```ts
input: {
  type: string;             // /^[a-z0-9][a-z0-9._-]*$/i
  code: string;             // full .mjs source body, must be non-empty
}
output: {
  type: string;
  source: 'workspace';
  file_path: string;        // <projectDir>/.clawdevbox/renderers/<type>.mjs
}
errors:
  INVALID_TYPE
  RENDERER_WRITE_FAILED     // mkdir / writeFileAtomic failed
```

**What it does.** Creates or overwrites
`<projectDir>/.clawdevbox/renderers/<type>.mjs` with `code`. On the next
artifact load, that file becomes the active renderer for `type`,
**shadowing** any plugin or built-in renderer of the same name.

**How it does it.**

1. Validate `type` against `TYPE_REGEX`.
2. `mkdirSync(workspaceRenderersDir(ws.projectDir), { recursive: true })`
   — the `.clawdevbox/renderers/` folder is created on demand, so a fresh
   workspace doesn't need any scaffolding.
3. `writeFileAtomic(filePath, code)` — see
   [`fs-util.ts`](../mcp-server/src/fs-util.ts). Atomic write means the
   browser will never see a half-written module.

The body is **not** validated as ES module syntax — a syntax error only
surfaces when the browser tries to `import()` it. Test by opening the
artifact page.

#### `renderer.delete`

```ts
input: {
  type: string;             // /^[a-z0-9][a-z0-9._-]*$/i
}
output: {
  type: string;
  deleted: boolean;         // false when there was no workspace file
  file_path?: string;       // present only when deleted: true
}
errors:
  INVALID_TYPE
  RENDERER_DELETE_FAILED    // unlinkSync threw
```

**What it does.** Removes the workspace-level `<type>.mjs` if it exists.
After deletion, the type falls back to the next scope in the chain —
typically a plugin or built-in.

**How it does it.** Computes `filePath` directly (no `resolveRendererFile`
call — we only want to touch the workspace layer). If `existsSync` is
false, returns `deleted: false` and exits cleanly. Otherwise calls
`unlinkSync(filePath)`. Plugin / built-in files are never reached by this
tool — they live in different directories.

---

### Built-in renderers

All three live in [`mcp-server/src/renderers/`](../mcp-server/src/renderers/)
and are loaded as browser ES modules from `https://esm.sh` deps (`marked`,
`highlight.js`, `mermaid`, `diff`). No bundling.

#### `markdown`

**Files expected in the artifact folder:**

- `content.md` (default), or whatever filename is given in `manifest.meta.entry`

**What it does.** Parses the markdown with `marked@12`, injects it into a
`.markdown-body` container under `root`. Code fences with the
`mermaid` info-string get rendered as SVG via `mermaid@11.4.0`; everything
else gets syntax-highlighted with `highlight.js@11.10.0`. Self-contained
CSS — no external stylesheet.

**Use it for:** plain documentation artifacts, summaries, agent reports.

#### `pr-review`

**Files expected in the artifact folder:**

- `review.json` — `{ files: [{ path, changeType }], comments: AIReviewComment[] }`
- `walkthrough.json` (optional) — see below
- `pr.json` (optional) — `PRContext { prId, title, sourceBranch, targetBranch, repository, ... }`
- `original__<safe>.txt` and `modified__<safe>.txt` for every file in the
  review, where `<safe>` is the file path with `/` replaced by `__`

**What it does.** Renders a three-pane PR review UI: hierarchical file
tree on the left, full-file diff in the middle (every line tagged
`add`/`del`/`ctx` via the `diff` library's `diffLines()`), and a
right-rail comments thread. Diffs are chunked into 50-line
`content-visibility: auto` blocks for large files. Comments anchor to
modified-file line numbers and appear inline below the anchor.
Keyboard: `j`/`k` next/prev change-group, `n`/`p` next/prev comment.

**Use it for:** AI-generated PR reviews, code-review artifacts produced by
recipes.

#### `walkthrough`

**Files expected in the artifact folder:**

- `walkthrough.json` — `CodeWalkthrough { id, prId, summary, architectureDiagram?, steps: WalkthroughStep[], ... }`
- `files__<safe>.txt` (optional, per step) — full file content with the
  step's range highlighted in the code pane

**What it does.** Full-viewport code pane with a draggable, resizable,
minimizable step overlay floating on top. Per-step markdown description,
optional per-step mermaid diagram, related-files chips, step dots for
random-access navigation, `←`/`→` keyboard nav, deep-link via `#step=N`.

**Use it for:** explainer artifacts walking through a change or
codebase — used standalone or embedded into a `pr-review` artifact
alongside `review.json`.

---

### Story: writing a custom renderer

Suppose your project produces nightly perf reports as JSON and you want a
custom renderer that draws a sparkline. Step by step:

**1. Inspect the chain.**

```
renderer.list
→ [{ type: 'markdown', source: 'builtin', active: true }, ...]
```

There's no `perf-report` type registered, so no shadowing concern.

**2. Author the module.**

```
renderer.write
  type: "perf-report"
  code:  |
    export default {
      type: 'perf-report',
      async render(root, ctx) {
        const data = await ctx.fetchFileJson('metrics.json');
        const max = Math.max(...data.points);
        const w = 600, h = 120;
        root.innerHTML = `
          <h2>${ctx.manifest.title}</h2>
          <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
            <polyline fill="none" stroke="#4daafc" stroke-width="2"
              points="${data.points.map((v, i) =>
                `${(i / (data.points.length - 1)) * w},${h - (v / max) * h}`
              ).join(' ')}" />
          </svg>`;
      },
    };
```

`renderer.write` lands the file at
`<projectDir>/.clawdevbox/renderers/perf-report.mjs`.

**3. Produce an artifact that uses it.**

```
artifact.add
  id: "perf-2025-05-11"
  type: "perf-report"
  title: "Latency p99 — last 7 days"
  files: { "metrics.json": { points: [12, 14, 11, 18, 22, 17, 13] } }
```

`artifact.add` writes `manifest.json` + `metrics.json` into
`<workspace>/artifacts/perf-2025-05-11/`, returns a `view_url`.

**4. Open the URL.**

The host page fetches `/artifact/perf-2025-05-11/manifest`, reads
`type: "perf-report"`, and `import()`s
`/__renderer/perf-report.mjs`. The terminal-server resolves that through
the scope chain, finds the workspace file (no plugin / built-in needed),
and serves it. Your `render` runs, fetches `metrics.json` via `ctx`, and
mounts the SVG.

**5. Iterate.**

Use `renderer.read type=perf-report` to confirm the file on disk, or
`renderer.write` again to overwrite. The browser picks up the new
version on the next page load (no cache busting needed — `import()` is
URL-keyed and the URL is stable, so a hard refresh is required if your
browser caches aggressively).

**6. Promote the renderer.**

If multiple workspaces need this, move it into a plugin's `renderers/`
directory and `plugin.install` that plugin globally. Or, if it's
genuinely general-purpose, contribute it as a new built-in.

To roll back:

```
renderer.delete type=perf-report
```

The file is unlinked; if you had been shadowing a plugin or built-in it
would now take over, but here the type vanishes entirely and any artifact
of that type 404s on the renderer load.

---

### Edge cases & gotchas

- **Type regex.** All four tools validate `type` against
  `/^[a-z0-9][a-z0-9._-]*$/i`. Anything else returns `INVALID_TYPE`. The
  HTTP route regex (`[A-Za-z0-9._-]+`) is a slight superset but in
  practice they match the same names because `artifact.add` enforces the
  same constraint on its `type` field.
- **`.render` is the only required export field.** `type:` inside the
  default export is documentation only — the host derives the type from
  the manifest, not the module. The bare-minimum module is
  `export default { render(root, ctx) {} };`.
- **No sandboxing.** The renderer runs in the artifact host page's
  origin with full DOM access. Don't run unfetched user input through
  `innerHTML` in a renderer you write — same XSS rules as any web app.
- **`ctx.fetchFile` is plain HTTP.** Files are streamed from
  `/artifact/:id/file/:filename`. Binary files are returned as text
  (UTF-8 decoded); use a base64 sidecar or a JSON wrapper for binary
  data.
- **No hot reload.** A renderer module is loaded fresh on every artifact
  page navigation, but the browser may cache the URL. After
  `renderer.write` you may need to force-refresh the artifact tab.
- **`renderer.delete` of plugin / built-in is a no-op.** It only ever
  touches `<projectDir>/.clawdevbox/renderers/`. If you want to disable
  a built-in for one workspace, write an empty shadow that throws (or
  renders an explanatory error).
- **Plugin order is map-iteration order.** When two plugins both ship a
  renderer for the same type, whichever appears first in
  `ws.plugins.entries()` wins. That order is the order plugins were
  registered during workspace bootstrap — don't rely on it for tie
  breaks. Author a workspace shadow instead.
- **Built-ins live under `dist/` after build.** In source the path is
  `mcp-server/src/renderers/<type>.mjs`; in the published package it's
  `dist/renderers/<type>.mjs`. The registry computes the path from
  `import.meta.url`, so both work without configuration. The build
  script (`scripts/build.mjs` line 77–82) copies the directory verbatim
  rather than passing it through TypeScript — the files are already
  browser ES modules.
- **`renderer.list` doesn't validate modules.** A `.mjs` with broken
  syntax shows up as a normal entry; the failure only surfaces when the
  browser dynamic-imports it.
- **No content cap.** `renderer.write` accepts an arbitrary `code`
  string; there is no size limit beyond filesystem constraints. Keep
  renderers small — they ship over the wire on every artifact load.
- **`writeFileAtomic`.** A simultaneous browser load during write will
  see either the old file or the new one, never a partial — the file is
  written to a temp path and renamed.

---

## Inbox

_6 tools — Persistent notification center the user reviews from desktop or phone._

The inbox is the user's **persistent, mobile-friendly notification center**. Whenever a trigger, recipe, or agent has something the human should know about — a new PR to review, a freshly-fired incident, an epic that decomposed into thirty work items — it lands as an *inbox item*. The SPA renders the list as a stack of cards; the user expands one to read the body, then archives, snoozes, or marks it done.

The MCP tools in this family (`inbox.list`, `inbox.read`, `inbox.upsert`, `inbox.set_state`, `inbox.snooze`, `inbox.archive`) are the **only** way to create, mutate, and read inbox state. All six are registered by `mcp-server/src/tools/inbox.ts` and back onto a single `InboxStore` singleton declared in `mcp-server/src/store.ts`.

Three design notes that govern the whole surface:

1. **Two-tier storage.** The list endpoint is hot (the SPA polls it every time the user switches tabs, opens the app, or receives an SSE refresh hint). It cannot read hundreds of KB of markdown per card. So metadata lives in a single small JSON file and bodies live in per-item sidecars — fetched only when the user expands a card.
2. **File-of-truth, no in-memory cache.** Both the stdio MCP server (one process) and `clawdevbox start --service` (another process) operate on the same inbox concurrently. The store re-reads `<globalDir>/inbox.json` on every operation and writes it back atomically on every mutation, so the processes stay consistent without a database.
3. **Mutations fan out.** Every successful mutation calls `emitChange('inbox')` (see `mcp-server/src/event-bus.ts`), which fires an SSE event on the `inbox` topic. Any open SPA tab re-fetches `/api/inbox` and re-renders. `inbox.upsert` additionally fires a browser **push notification** on creation (and optionally on update) so the user's phone buzzes the moment something lands.

---

### Filesystem layout

Everything inbox-related lives under the **global** directory (default `~/.clawdevbox`, override with `CLAWDEVBOX_GLOBAL_DIR`). The inbox is intentionally account-wide, not project-scoped — a notification fired from project A must be reachable from a phone subscribed via project B's tunnel.

```
<globalDir>/
├── inbox.json                                  ← all metadata, one file
└── inbox-bodies/
    ├── ado_pr_2401.md                          ← body sidecar (markdown)
    ├── icm_incident_482991123.md
    └── manual_test-item.txt                    ← body sidecar (text)
```

#### `inbox.json` shape

```json
{
  "version": 1,
  "items": [ { /* InboxItem */ }, ... ]
}
```

Read by `loadInboxFromDisk(globalDir)` and written by `saveInboxToDisk(globalDir, items)` in `mcp-server/src/inbox-persistence.ts`. The reader filters out malformed rows silently (any object missing `id`, `kind`, `source`, `state`, `created_at`, or `updated_at` is dropped). The writer is **atomic**: it goes through `writeFileAtomic` (tempfile + rename) so a crash mid-write can never produce a half-written `inbox.json`.

If the file doesn't exist or is unparseable, the loader returns `[]` and the warning is logged — the inbox quietly resets to empty rather than aborting startup.

#### Body sidecars

A body file lives at `<globalDir>/inbox-bodies/<safeBasename>.<ext>` where:

- `<safeBasename> = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)` (see `safeBodyBasename` in `inbox-persistence.ts`)
- `<ext>` is `md` for `description_format: 'markdown'` (the default) or `txt` for `'text'`

So an item with id `ado:pr:2401` and a markdown body lands at `inbox-bodies/ado_pr_2401.md`. The colons are replaced with underscores because Windows filesystems reject them; the dot and dash characters survive because they're legal everywhere.

Collisions between safe basenames are theoretically possible (e.g. `ado:pr:2401` and `ado_pr_2401` would collide) but inbox ids are conventionally namespaced (`<source>:<kind>:<localId>`) and 200 chars is plenty of headroom. The full unmodified id remains the canonical key in `inbox.json`.

#### Body sidecar lifecycle

| Operation | Function | Behavior |
|---|---|---|
| Write | `writeInboxBody(globalDir, id, body, format)` | Creates `inbox-bodies/` if missing; writes atomically; **also deletes any opposite-format sidecar** so a markdown ↔ text flip doesn't orphan the old file. |
| Read | `readInboxBody(globalDir, id, format)` | Returns the file contents, or `null` if the sidecar is missing or unreadable. |
| Delete | `deleteInboxBody(globalDir, id)` | Unlinks **both** `.md` and `.txt` sidecars for the id. Idempotent — missing files are not an error. |

The path helpers (`inboxFilePath`, `inboxBodiesDir`, `inboxBodyPath`) are exported for code that needs to reason about disk layout (e.g. the HTTP server's `GET /api/inbox/<id>` handler).

#### Why two tiers?

A bare `GET /api/inbox` (used by the SPA's home page on every tab activation) reads `inbox.json` once and returns the whole array. If we stuffed bodies in there, a single 256KB markdown item would slow down every list render. Splitting bodies into sidecars keeps the list endpoint flat — and the SPA only fetches a body via `GET /api/inbox/<id>` once the user actually expands a card. The `description_size` field on `InboxItem` lets the SPA decide whether the card has a body to fetch without hitting the disk.

#### In-memory fallback

`InboxStore.bind(globalDir)` switches the store from in-memory mode to file-backed mode. Until it's called (e.g. in test harnesses, or ad-hoc unit tests that don't have a global dir), `load()` returns the private `memory: Map<string, InboxItem>` and `save()` replaces it. The public API is identical in both modes — the only difference is durability. `bind()` is idempotent; calling it twice with different paths simply swaps the target. `buildServer()` in the MCP server bootstrap calls `inbox.bind(globalDir)` once at startup.

The in-memory mode **does not** write body sidecars; bodies in test mode survive only as long as the `InboxStore` instance exists, because `writeInboxBody` writes to disk unconditionally but `readInboxBody` returns `null` when `description_size` is 0. Tests that don't go through tools generally just set `description_format` and accept `description: null` from `inbox.read`.

---

### Schema

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
| `agent_message` | string | optional | **Legacy** "agent banner" — kept for backwards compat. Prefer `preview`. |
| `agent_tone` | `'info' \| 'warn' \| 'err' \| 'ok'` | optional | **Legacy** tone hint for `agent_message`. |
| `state` | `'new' \| 'open' \| 'snoozed' \| 'archived' \| 'done'` | system | Lifecycle state. New rows always start at `'new'`. |
| `snoozed_until` | number (unix ms) | optional | Set by `inbox.snooze`. Only meaningful while `state === 'snoozed'`. |
| `created_at` | number (unix ms) | system | First-seen timestamp. Frozen on creation. |
| `updated_at` | number (unix ms) | system | Refreshed on every mutation. Drives list ordering (newest-first). |

#### Field constraints (Zod, enforced at the tool boundary)

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

### Tools

#### `inbox.list`

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

#### `inbox.read`

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

#### `inbox.upsert`

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

#### `inbox.set_state`

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

#### `inbox.snooze`

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

#### `inbox.archive`

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

### Errors

All inbox tools return the standard MCP `CallToolResult` shape with structured errors when something goes wrong:

| Code | Source | Meaning |
|---|---|---|
| `NOT_FOUND` | `notFound('inbox_item', id)` in `scope.ts` | The id doesn't exist. Returned by `read`, `set_state`, `snooze`, `archive`. Payload: `{ code:'NOT_FOUND', kind:'inbox_item', id }`. |
| `INVALID_SNOOZE_TIME` | `structuredError(...)` in `inbox.snooze` | `until` is not strictly greater than `Date.now()`. Payload includes both the offending `until` and current `Date.now()` in the message string. |
| `VALIDATION_FAILED` | Zod, automatically by the MCP SDK | Any Zod constraint violation (preview too long, body too big, illegal `artifact_id`, illegal state value, invalid type, etc.) before the handler runs. |
| `NOTIFICATIONS_DISABLED` | `inbox.upsert` | Returned in `structuredContent.push_error_code` (the tool itself succeeds — push is best-effort, not a hard requirement). Set when `notifications.enabled !== true` or no VAPID keypair is configured. |

Note that an `inbox.upsert` that successfully creates the item but fails to send any pushes (e.g. all subscribed phones are offline) is **not** a tool failure. The tool surfaces the push errors in `structuredContent.push.errors[]` but `isError` stays false and the item is persisted.

---

### State machine

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

### Story: a new mail arrives

Walk through the lifecycle of a single PR-review notification, from a watcher trigger firing all the way to the user marking it done from their phone.

#### 1. Trigger fires

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

#### 2. Body sidecar lands

`inbox.upsert` sees `description !== undefined && description !== ''` and calls `writeInboxBody(globalDir, 'ado:pr:2401', '## Summary\n...', 'markdown')`. The body lands at `<globalDir>/inbox-bodies/ado_pr_2401.md` (atomic tempfile + rename). `descriptionSize` is computed as `Buffer.byteLength(description, 'utf8')`.

#### 3. Metadata persists

The patch (with `description_format: 'markdown'`, `description_size: 1847`, `attachments`, `trigger_id`, `labels`) is handed to `InboxStore.upsert('ado:pr:2401', 'pr_review', 'ado', patch)`. The store sees no existing row, mints a fresh `InboxItem` with `state: 'new'`, `created_at: now`, `updated_at: now`, and the patch spread on top. It writes the whole inbox array to `<globalDir>/inbox.json` atomically. `created` comes back `true`.

#### 4. SSE fans out

`emitChange('inbox')` fires on the in-process event bus. The HTTP server's `/sse` endpoint pushes `event: change\ndata: {"topic":"inbox"}\n\n` to every connected browser. Each open SPA tab's event listener re-fetches `GET /api/inbox`, gets the enriched list (including the new row), and re-renders. The PR card appears at the top of the list.

#### 5. Push fires

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

#### 6. User opens the SPA from the notification

Tap → SW opens `/` → SPA mounts → inbox tab is selected by default. The user sees the new card. They tap to expand it. The SPA calls `GET /api/inbox/ado:pr:2401`. The HTTP handler in `cli/start.ts`:

- Calls `inbox.read('ado:pr:2401')` for metadata.
- Sees `description_size > 0 && description_format === 'markdown'`.
- Calls `readInboxBody(globalDir, 'ado:pr:2401', 'markdown')` to slurp the sidecar.
- Returns `{ item, description }` JSON.

The SPA renders the full markdown body inline.

#### 7. User marks it done

The user reviews the PR in another tab, then taps "Done" on the card. The SPA POSTs to `/api/inbox/ado:pr:2401/done`. The HTTP handler calls `inbox.setState('ado:pr:2401', 'done')`, which spreads `state: 'done'`, persists, and emits `emitChange('inbox')`. The SSE event fans out again; every open tab (including the laptop the user has open in the background) re-fetches `/api/inbox`, and the card disappears from the default-filtered list.

#### 8. Body sidecar is still on disk

The done item — and its body sidecar — stay on disk. No GC. If the user un-dones it tomorrow (`inbox.set_state` back to `open`), the card re-appears with its body intact.

---

### Edge cases & gotchas

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

---

## Thread

_6 tools — In-process side-terminal kernel — rows + append-only messages._

The `thread.*` family is the in-process kernel for Conductor's side-terminal
agent sessions. A **thread** is the persistent conversation row attached to an
inbox item (and, optionally, to a parent thread); **messages** are the
append-only log of everything the agent and the system want to surface — agent
text, tool calls, tool results, view emissions, state changes.

These tools are deliberately thin: they create rows, append messages, transition
state, and cascade cancellation. They do **not** spawn or supervise the agent
CLI process — spec §6.1 reserves that for the scheduler (today, the desktop
app's shell IPC).

Source: [`mcp-server/src/tools/thread.ts`](../mcp-server/src/tools/thread.ts),
backed by `ThreadStore` in [`mcp-server/src/store.ts`](../mcp-server/src/store.ts).

### Persistence model

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

#### Row shapes

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

### Tools

#### `thread.spawn`

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

#### `thread.append_message`

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

#### `thread.read`

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

#### `thread.set_state`

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

#### `thread.cancel`

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

#### `thread.wake`

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

### State machine

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

### Parent/child graph

Threads can spawn child threads (e.g. a top-level PR-review thread spawns one
child per file). The relationship is **one-way**: the child knows its parent
via `parent_thread_id`, and the store maintains a reverse `childIndex` for
cascade operations.

#### How `childIndex` is maintained

- **Set on `spawn`.** When `thread.spawn` is called with `parent_thread_id`,
  the new child's id is appended to `childIndex[parent_thread_id]`.
- **Never re-parented.** `parent_thread_id` is a field on `Thread` set once at
  spawn and never edited.
- **Never pruned.** When a thread is cancelled or marked `done`, its row stays
  in `this.threads` and its entry stays in `childIndex`. The graph is monotonic
  for the lifetime of the process. (Restart clears everything; see persistence
  notes.)

#### How cancel cascades

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

### Edge cases & gotchas

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

---

## Approval

_3 tools — Modal picker for agent ↔ user decisions._

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

### Persistence model

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

#### `Approval` row shape

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

### Tools

#### `approval.request`

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

#### `approval.resolve`

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

#### `approval.list_pending`

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

### State machine

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

### Edge cases & gotchas

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

---

## Notify

_1 tool — Low-level Web Push fan-out._

The `notify` family is Clawdevbox's lower-level browser push primitive. There
is exactly one tool — **`notify.send`** — and its job is to encrypt a payload
with the workspace's VAPID keypair and POST it to every subscribed device via
the Web Push protocol.

### Relationship to `ui.notify`

`notify.send` is a thin wrapper around
[`sendNotification`](../mcp-server/src/notifications.ts). It does **one**
thing: fan a payload out to every subscribed device.

The separate **`ui.notify`** tool (see [`ui.md`](#ui)) is the higher-level
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

[bus]: ../mcp-server/src/event-bus.ts

### Architecture

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
[`mcp-server/src/cli/start.ts`](../mcp-server/src/cli/start.ts) (`/api/push/subscribe`).

### Configuration

#### VAPID keys

Push services (FCM / Mozilla autopush / APNs) demand a signed JWT proving
that the sender controls a stable identity. That signature uses a P-256
keypair plus a `subject` field (`mailto:` or `https://`). Together those
three pieces are the **VAPID details**.

- **Generation** — [`generateVapidKeys()`](../mcp-server/src/notifications.ts#L77)
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

#### `loadNotificationsConfig`

MCP tools don't get the full `ResolvedConfig` object — they only get a
`Workspace` (i.e. `projectDir` + `globalDir`). To see the same merged
notifications view the HTTP server uses, both `notify.send` and `ui.notify`
call [`loadNotificationsConfig({ projectDir, globalDir })`](../mcp-server/src/config.ts#L195).

That function:

1. Reads `<projectDir>/.clawdevbox/config.json` (project layer).
2. Reads `<globalDir>/config.json` (global layer).
3. Picks `enabled` from project if set, else global.
4. Picks `vapid` from project if set, else global.
5. Returns `{ enabled: enabled && !!vapid, vapid }` — so `enabled: true`
   in config with no VAPID keys still resolves to disabled.

A missing config file (or a malformed one) does not throw — both reads are
wrapped in `try / catch` and fall through to the next layer.

### Subscription storage

#### Canonical: `<globalDir>/push-subscriptions.json`

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

#### Legacy: `<projectDir>/.clawdevbox/push-subscriptions.json`

Older versions of clawdevbox stored subscriptions per-project. The
migration path is automatic:

- **`listSubscriptions(loc)`** reads **both** files and de-duplicates by
  endpoint. Global entries win; legacy project entries fill gaps.
- **`writeSubscriptions(loc, list)`** always writes to the global path
  and `unlinkSync`s the legacy file if it exists. The unlink is best-effort
  — failure logs a warning and is retried on the next write.
- Any code path that calls `sendNotification` therefore consolidates the
  files on its first run.

#### `SubsLocation`

The location is passed around as:

```ts
interface SubsLocation {
  globalDir?:  string;   // preferred (account-wide)
  projectDir?: string;   // legacy (read-for-migration only)
}
```

Both are optional only in the type signature — in practice `notify.send`
always passes both, sourced from `ws.globalDir` / `ws.projectDir`.

#### Mutation helpers

| Function                          | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `listSubscriptions(loc)`          | Read + merge global + legacy, de-dup by endpoint.                  |
| `addSubscription(loc, sub)`       | Idempotent insert keyed by endpoint. Bumps `last_seen_at`.         |
| `removeSubscription(loc, ep)`     | Delete by endpoint. Returns `false` if not found.                  |
| `sendNotification(loc, vapid, p)` | Fan out a payload; prune dead endpoints; rewrite the file.         |

Every mutation calls `emitChange('notifications')` so the SPA's push pill
re-renders.

### Tools

#### `notify.send`

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
[`mcp-server/src/tools/notify.ts`](../mcp-server/src/tools/notify.ts):

1. **Config check** — `loadNotificationsConfig({ projectDir, globalDir })`.
   Fail fast with `NOTIFICATIONS_DISABLED` if not enabled or no VAPID keys.
2. **Send** — call
   `sendNotification({ globalDir, projectDir }, vapid, payload)` in
   [`notifications.ts`](../mcp-server/src/notifications.ts).
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

### Payload reference

#### `NotifyPayload` (TypeScript)

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

#### On-the-wire shape (after defaults applied)

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
[`pwa-assets.ts`](../mcp-server/src/pwa-assets.ts) and turns into a
native `Notification(title, { body, data: { url }, icon, tag, requireInteraction })`.

#### Field semantics

| Field                 | Notes                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`               | Always shown bold on a single line. Truncated by the OS if too long (~80 chars on most platforms).                                                                                                                                                                   |
| `body`                | Wraps to ~2 lines on iOS, ~3 on Android. Empty string is fine — the title alone shows.                                                                                                                                                                               |
| `url`                 | Passed to the SW as `event.notification.data.url`. On tap the SW calls `clients.openWindow(url)` or focuses an existing tab. Relative paths are resolved against the home origin (devtunnel URL when one is up).                                                     |
| `tag`                 | Collapse key. Two pushes with the same tag display as one — the second replaces the first. Use unique tags per subject (`ado-pr-1234`, `icm-552-mitigated`) to avoid overwriting unrelated pushes. Default `clawdevbox` is intentional so noisy code self-collapses. |
| `icon`                | Path inside the SPA bundle, served from the HTTP server. Absolute https URLs work too.                                                                                                                                                                               |
| `require_interaction` | True keeps the notification on screen until the user dismisses it (Android). On iOS this is a no-op — iOS always auto-dismisses banners. Use sparingly.                                                                                                              |

### Edge cases & gotchas

#### iOS Safari requires the page to be installed as a PWA

`PushManager.subscribe` throws `NotAllowedError` on iOS unless the page is
running in `display-mode: standalone` — i.e. the user has tapped
**Share → Add to Home Screen** and opened the resulting icon.

The detection lives in `requiresIosPwaInstall()` on the SPA
([`mcp-server/web/src/stores/ui.ts`](../mcp-server/web/src/stores/ui.ts)):

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

#### Dead-endpoint pruning is mutation-on-read

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

#### Subscriptions outlive VAPID keypair rotation — sort of

The `endpoint` URL the browser hands back from `pushManager.subscribe`
includes a hash of the public key it was subscribed with. If you rotate
the VAPID keypair (e.g. by deleting `config.json` and re-running
`clawdevbox init`), every existing subscription becomes invalid and the
next send prunes them en masse. There is no automated re-subscription —
users have to tap **Enable** again on each device.

#### The HTTP push API is unauthenticated

`/api/push/subscribe`, `/api/push/unsubscribe`, `/api/push/status`,
`/api/push/vapid`, and `/api/push/test` do **not** require the bearer token
that `/mcp` does. This matches the rest of the home-page API surface
(loopback-only by default). When exposed over a devtunnel, anyone with the
URL can subscribe their device — which is the intended behaviour for
"point your phone at the tunnel URL once and tap Enable".

#### `notify.send` is independent of the SSE bus

It does **not** emit a `change` event on any topic. If you want the SPA to
also refresh its push pill / subscriber count alongside a phone buzz, use
`ui.notify({ topic: 'notifications', push: { ... } })` instead.

(That said, the *mutation* of `push-subscriptions.json` inside
`sendNotification` — when an endpoint is pruned or `last_seen_at` is
refreshed — *does* emit `emitChange('notifications')` from inside
`writeSubscriptions`. So pruning is visible in the UI even if the caller
didn't ask for an SSE fan-out.)

#### Per-send file rewrite is unavoidable

Every successful call to `sendNotification` rewrites the subscriptions
file, even when no endpoint died. That's because `last_seen_at` is updated
on each successful send. If you have hundreds of subscribers and a tight
send loop, this becomes an O(N²) cost — but in practice clawdevbox tops
out at a handful of devices per user, so the cost is negligible.

#### `subject` must look like a URL or mailto

`webpush.setVapidDetails(subject, ...)` validates the subject and throws
if it's not a valid `mailto:` or `https://` URI. The default
`mailto:clawdevbox@localhost` is intentionally fake — push services accept
it. If you customise it, keep the scheme.

#### What `notify.send` does **not** do

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

### See also

- [`ui.notify`](#ui) — the SSE-aware wrapper most agents should use.
- [`inbox.upsert`](#inbox) — has a built-in `notify` field that wraps
  `sendNotification` for new inbox items.
- [`mcp-server/src/notifications.ts`](../mcp-server/src/notifications.ts) — the
  `web-push` integration + subscription store.
- [`mcp-server/src/config.ts`](../mcp-server/src/config.ts) —
  `loadNotificationsConfig` + VAPID schema.
- [`mcp-server/src/cli/start.ts`](../mcp-server/src/cli/start.ts) — the
  `/api/push/*` HTTP endpoints that handle SPA-side subscribe / unsubscribe.

---

## UI

_1 tool — Plugin-facing facade combining SSE refresh + push._

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

Source: [`mcp-server/src/tools/ui.ts`](../mcp-server/src/tools/ui.ts).
Supporting modules: [`event-bus.ts`](../mcp-server/src/event-bus.ts),
[`notifications.ts`](../mcp-server/src/notifications.ts),
[`config.ts`](../mcp-server/src/config.ts) (`loadNotificationsConfig`).

---

### ChangeTopic catalog

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

### Tools

#### `ui.notify`

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

### Comparison: `ui.notify` vs `inbox.upsert` vs `notify.send`

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

### Story: a trigger fires from a plugin

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

### Edge cases & gotchas

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

---

## Glossary

| Term | Definition |
|---|---|
| **Workspace** | A directory with a `.clawdevbox/` subtree, registered in `<workspacesRoot>/index.json`. The unit a recipe runs in. See [Workspace](#workspace). |
| **`<projectDir>`** | The `CLAWDEVBOX_PROJECT_DIR` the MCP server was booted with. Read-only context loaded by `loadWorkspaceFromEnv`. Distinct from a registered workspace — it may or may not be one. |
| **`<globalDir>`** | The account-wide config root (`CLAWDEVBOX_GLOBAL_DIR`, default `~/.clawdevbox`). Holds the plugin store, global recipes/skills, inbox, push subscriptions, VAPID keys, and the per-plugin enabled flag. |
| **`<workspacesRoot>`** | Parent dir for minted workspaces; defaults to `<globalDir>/workspaces`. The registry `index.json` lives here. |
| **Plugin** | A directory under `<globalDir>/plugins/<id>/` with a `plugin.yaml` manifest declaring `provides.{recipes,skills,trigger_types,tools,mcp_servers}`. Global to the account. |
| **Plugin install record** | A sidecar `<globalDir>/plugins/<id>.install.json` written next to (not inside) the plugin dir. Records `kind` (`git` / `local` / `builtin` / `manual`), source spec, optional `ref`, and `installed_at`. |
| **Scope** | One of `'project'`, `'plugin:<id>'`, `'global'`, `'all'`. Resolution order on `'all'`: project → plugin (sorted by id) → global. Writes accept only `project` and `global`. |
| **Scope chain** | The walk used by `resolveRead` and `listAllInScope` to look up a recipe/skill/trigger across scopes, taking the first hit. |
| **Renderer chain** | The same idea for `.mjs` renderer modules, but `workspace → plugin → builtin` instead. |
| **Recipe** | A YAML file at `<scope>/.clawdevbox/recipes/<id>.yaml` (or a plugin-shipped equivalent) declaring `id`, `name`, `description`, optional `steps[]`, etc. |
| **Recipe instance** | A row at `<workspace>/.clawdevbox/recipe-instances/<id>.json` recording one spawn of a recipe — id, workspace, prompt, agent CLI, pid, status, snapshot of the recipe YAML, etc. |
| **Session id** | The agent CLI's own session id. Recipe runs always pass an explicit id (`cdb_<base36>`) so resume is deterministic. |
| **Skill** | A markdown file with YAML frontmatter at `<scope>/.clawdevbox/skills/<id>.md` (or plugin-shipped). The body is the agent-readable prose; frontmatter holds `name` + `description` + arbitrary extra keys. |
| **Trigger type** | A plugin-declared capability (`provides.trigger_types[]`): id, parameter schema, default cron, callback binding. Read-only via MCP. |
| **Registered trigger** | A concrete `<type>#<key>` instance written to `<projectDir>/.clawdevbox/triggers.json`. Has bound params, cron override, enabled flag, and `last_run_*` audit fields. |
| **Identity param** | A parameter named in the trigger TYPE's manifest whose value becomes the suffix of the registered instance id (`<type>#<value>`). Falls back to an 8-hex hash of the params object. |
| **Artifact** | A folder `<workspace>/artifacts/<id>/` containing `manifest.json` plus free-form content files. Rendered by an `.mjs` module resolved through the renderer chain. |
| **Manifest** | `<workspace>/artifacts/<id>/manifest.json` — `{ id, type, title, workspace_id, recipe_instance_id?, step_id?, created_at, meta? }`. |
| **Inbox item** | A row in `<globalDir>/inbox.json` with kind/source/state plus optional body sidecar at `<globalDir>/inbox-bodies/<safe-id>.<md\|txt>`. |
| **Body sidecar** | The per-item markdown/text file holding an inbox item's full description. Read lazily; the list endpoint never opens it. |
| **Thread** | An in-process conversation row (`thr_<rand>`) tied to an inbox item, with an append-only message list (`Message[]`). Today: in-memory only. Future: SQLite kernel. |
| **Approval** | An in-process row (`apr_<rand>`) representing a question + options + answer, owned by a thread. The thread sits in `awaiting_user` while the approval is pending. |
| **SSE topic** | One of the seven `ChangeTopic` enum values fired by `emitChange` and consumed by `/api/events` subscribers. Topics carry no payload — the SPA always re-reads the source endpoint. |
| **Hostable tool** | A `.ts`/`.js`/`.mjs` file under a plugin's `tools/` dir, declared in `provides.tools[]`. Loaded by `hosted.ts` at workspace boot, given access to the MCP server. |
| **VAPID** | Voluntary Application Server Identification — the P-256 keypair + `subject` Web Push services demand. Lives in `config.json`. Minted by `clawdevbox init`. |
| **`writeFileAtomic`** | Helper in `fs-util.ts`: write to a sibling tempfile, then `renameSync` into place. Used by every config write. POSIX-atomic, best-effort on Windows. |
| **`structuredError`** | The standard MCP error shape produced by `scope.ts`: `{ isError: true, structuredContent: { code, message, ...extra } }`. |
| **`emitChange(topic)`** | One-line pub/sub call into `event-bus.ts`. No payload — SPA re-reads the source endpoint for that topic. |

