# `renderer.*` MCP tools

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

Tools (all in [`mcp-server/src/tools/renderer.ts`](../../mcp-server/src/tools/renderer.ts)):

| Tool              | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `renderer.list`   | Enumerate every renderer in every scope, flag the winner |
| `renderer.read`   | Return the source of the active renderer for a type      |
| `renderer.write`  | Author / overwrite a **workspace** renderer (`<type>.mjs`)|
| `renderer.delete` | Remove a workspace renderer (falls back to next scope)   |

---

## Filesystem layout

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
(see [`renderer-registry.ts`](../../mcp-server/src/renderer-registry.ts) line 41).

`BUILTIN_DIR` is resolved relative to the registry module itself:
`dirname(fileURLToPath(import.meta.url))` + `/renderers`. At build time
[`scripts/build.mjs`](../../mcp-server/scripts/build.mjs) copies
`src/renderers/` verbatim to `dist/renderers/` so the same path works in
both dev (`tsx`) and packaged runs.

Plugin renderers are discovered by iterating `ws.plugins` (the
`PluginEntry` map populated during plugin discovery) and looking for
`<plugin.dir>/renderers/<type>.mjs`. A plugin contributes at most one
renderer per type.

---

## Three-layer scope chain

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

## Module contract

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

### The `ctx` object

Constructed by the artifact host page in
[`terminal-server.ts`](../../mcp-server/src/terminal-server.ts) (around line 450):

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

## HTTP route

The browser loads the resolved module from a single endpoint:

```
GET /__renderer/<type>.mjs
```

Implementation: [`terminal-server.ts`](../../mcp-server/src/terminal-server.ts)
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

## Tools

### `renderer.list`

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

### `renderer.read`

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

### `renderer.write`

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
   [`fs-util.ts`](../../mcp-server/src/fs-util.ts). Atomic write means the
   browser will never see a half-written module.

The body is **not** validated as ES module syntax — a syntax error only
surfaces when the browser tries to `import()` it. Test by opening the
artifact page.

### `renderer.delete`

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

## Built-in renderers

All three live in [`mcp-server/src/renderers/`](../../mcp-server/src/renderers/)
and are loaded as browser ES modules from `https://esm.sh` deps (`marked`,
`highlight.js`, `mermaid`, `diff`). No bundling.

### `markdown`

**Files expected in the artifact folder:**

- `content.md` (default), or whatever filename is given in `manifest.meta.entry`

**What it does.** Parses the markdown with `marked@12`, injects it into a
`.markdown-body` container under `root`. Code fences with the
`mermaid` info-string get rendered as SVG via `mermaid@11.4.0`; everything
else gets syntax-highlighted with `highlight.js@11.10.0`. Self-contained
CSS — no external stylesheet.

**Use it for:** plain documentation artifacts, summaries, agent reports.

### `pr-review`

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

### `walkthrough`

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

## Story: writing a custom renderer

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

## Edge cases & gotchas

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
