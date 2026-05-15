# `workspace.*` MCP tools

The `workspace.*` family is a 4-tool surface for managing **Clawdevbox
workspaces** — the unit a recipe runs in. A workspace is just a directory
with a `.clawdevbox/` tree inside it; the registry at
`<workspaces_root>/index.json` is the source of truth for which workspaces
exist.

All four tools are registered in
[`mcp-server/src/tools/workspace.ts`](../../mcp-server/src/tools/workspace.ts)
and delegate to pure functions in
[`mcp-server/src/workspaces-store.ts`](../../mcp-server/src/workspaces-store.ts).

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

## Filesystem layout

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

### `<workspaces_root>` resolution

Defined by [`resolveWorkspacesRoot`](../../mcp-server/src/workspaces-store.ts):

1. Explicit override passed to the function (used by tests).
2. `$CLAWDEVBOX_WORKSPACES_ROOT` env var.
3. Default: `~/.clawdevbox/workspaces`.

`workspace.create` additionally accepts a `base_path` argument that overrides
the *parent* directory for a single create — the workspace dir still becomes
`<base_path>/<id>`, and the registry entry still records the resolved
`workspaces_root` (NOT `base_path`).

### Workspace id format

[`mintWorkspaceId`](../../mcp-server/src/workspaces-store.ts) returns
`ws_<base36-ts>_<4hex>`:

```ts
`ws_${Date.now().toString(36)}_${randomHex(4)}`
// e.g. ws_m3kqj9z2_a17f
```

The base36 timestamp prefix keeps the directory listing roughly chronological;
the 4-hex random suffix avoids collisions when two `workspace.create` calls
land in the same millisecond. There is no retry-on-collision — the random
suffix is the only collision defense.

### Registry shape (`index.json`)

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

## Tools

### `workspace.create`

#### Signature

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

#### What it does

Mints a new workspace id, creates the workspace directory plus its
`.clawdevbox/` scaffolding, optionally clones the `.clawdevbox/` tree of an
existing workspace, then registers the new row in `<workspaces_root>/index.json`.

#### How it does it

In [`createWorkspace`](../../mcp-server/src/workspaces-store.ts):

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
> plugins live under `<global_dir>/plugins/` (see [`globalPluginsDir`](../../mcp-server/src/workspace.ts))
> and are visible to *every* workspace automatically via the plugin registry
> that the MCP server builds at boot. There is no per-workspace
> `.clawdevbox/plugins/` directory anymore, and no junctioning happens.
> `inheritedPlugins` in the response is always `[]`. The flag is accepted
> only so that older clients don't crash on schema-validation; new code
> should omit it.

---

### `workspace.list`

#### Signature

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

#### What it does

Reads `<workspaces_root>/index.json` and returns every row.

#### How it does it

[`listWorkspaces(root)`](../../mcp-server/src/workspaces-store.ts):

1. `readIndex(root)` — if the file is missing or corrupt, returns
   `{ workspaces: {} }` (corruption is swallowed; the registry is treated as
   recoverable rather than fatal).
2. `Object.values(idx.workspaces).sort((a, b) => a.created_at - b.created_at)`.

No directory-existence check is performed — a row whose directory has been
deleted on disk will still appear in the list. Use `workspace.get` (which
reports `dir_exists`) when liveness matters.

---

### `workspace.get`

#### Signature

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

#### What it does

O(1) lookup of one workspace's metadata, augmented with best-effort counts
of what's inside its `.clawdevbox/` tree.

#### How it does it

1. `getWorkspace(root, id)` — single `readIndex` followed by
   `idx.workspaces[id]`. Returns `null` if absent (→ `WORKSPACE_NOT_FOUND`).
2. `existsSync(info.path)` — flips `dir_exists`. The registry entry and the
   directory can drift apart (e.g. someone `rm -rf`'d the workspace);
   `dir_exists: false` is the way callers detect that.
3. If the directory exists, [`countWorkspaceContents(info.path)`](../../mcp-server/src/workspaces-store.ts):
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

### `workspace.current`

#### Signature

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

#### What it does

Maps `CLAWDEVBOX_PROJECT_DIR` (the env var the MCP server is booted with)
to a registry row by reverse-looking-up `index.json` by path.

#### How it does it

[`findWorkspaceByPath(root, ws.projectDir)`](../../mcp-server/src/workspaces-store.ts):

1. `target = resolve(ws.projectDir)`.
2. `readIndex(root)`.
3. Linear scan: returns the first `WorkspaceInfo` whose `resolve(ws.path) === target`.

If nothing matches, the tool returns `{ found: false }` plus the project
dir and root it tried — this is the common case when a user runs
`clawdevbox mcp` against an arbitrary directory that was never registered
via `workspace.create`.

---

## `inherit_plugins` vs `copy_from`

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

## Story: spawning a fresh workspace

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

## Edge cases & gotchas

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
