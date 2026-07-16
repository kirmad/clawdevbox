# `artifact.*` MCP tools

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

## Filesystem layout

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

### `ARTIFACT_ID_RE`

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

### Filename validation

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

## Manifest shape

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

## Renderer dispatch chain

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

## Tools

### `artifact.add`

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

### `artifact.list`

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

### `artifact.get`

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

### `artifact.delete`

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

## HTTP viewer routes

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

## Story: agent produces an artifact, user opens it

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

## Edge cases & gotchas

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
