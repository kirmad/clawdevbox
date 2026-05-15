# `plugin.*` MCP tools

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

## Filesystem layout

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

## Three install kinds

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

## Tools

### `plugin.list`

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

### `plugin.read`

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

### `plugin.install`

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

### `plugin.update`

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

### `plugin.uninstall`

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

### `plugin.enable` / `plugin.disable`

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

## Story: installing a git plugin

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

## Edge cases & gotchas

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
