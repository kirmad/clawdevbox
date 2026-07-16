# `skill.*` MCP tools

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

## Filesystem layout

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

## Skill file shape

A skill file is one markdown document split into two parts by a `---`-delimited
YAML frontmatter block. The split is enforced by this regex in
`parseSkill` (`validators.ts:175`):

```
/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
```

So the file MUST start with `---\n`, then YAML, then `\n---\n`, then the body.
No leading whitespace, no BOM, no trailing content before the opening fence.

### Frontmatter fields

`validateSkillSource` (`validators.ts:205`) enforces only two required fields:

| Field         | Required | Type         | Constraint                                    |
|---------------|----------|--------------|-----------------------------------------------|
| `name`        | yes      | string       | non-empty, must match `[a-z][a-z0-9-]*`       |
| `description` | yes      | string       | non-empty                                     |

Everything else is allowed and preserved verbatim — the frontmatter is parsed
as an arbitrary `Record<string, unknown>` (`ParsedSkill.frontmatter` in
`validators.ts:170`). Callers can add any extra keys they want (e.g. `tags`,
`author`, `version`); the validator only checks shape, not schema.

### Example

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

## Tools

### `skill.list`

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

### `skill.read`

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

### `skill.upsert`

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

### `skill.delete`

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

## Edge cases & gotchas

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
  in the plugin manifest (Claude `skills` field or auto-discovered
  `skills/<id>/SKILL.md`). `listAllInScope` (`scope.ts:235-249`) iterates the
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
