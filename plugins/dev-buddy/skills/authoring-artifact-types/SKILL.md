---
name: authoring-artifact-types
description: Use when adding a brand-new artifact type (renderer) to clawdevbox, changing how an existing type renders, writing or shadowing a workspace renderer via renderer.write, deciding which files a type requires, or when a new type still lacks a companion build-<type>-artifact creation skill.
---

# Authoring artifact types (renderers)

## Overview

An artifact **type** is a renderer: a small ES module that turns the files in
an artifact folder into a DOM view. `artifact.add`'s `type` field selects the
renderer, resolved through a **workspace → plugin → builtin** chain
(`docs/tools/artifact.md:135`). This skill covers creating a new type, updating
an existing one, and — critically — pairing every type with a companion
creation skill so agents can actually produce it.

Core rule: **a renderer is data-in / DOM-out.** It runs in the viewer iframe
(browser, not Node) and only reads files through `ctx`. There is no `fs`.

## When to use / not

- **Use when:** adding a new `type`, customizing how an existing type looks in
  one workspace (shadow it), or writing the `build-<type>-artifact` skill for a
  type you just added.
- **Not for producing an artifact of an existing type** — that's the per-type
  creation skill's job (e.g. `build-html-artifact`). Read that instead.

## Renderer contract (quick reference)

`renderer.write({ type, code })` saves `code` to
`<workspace>/.clawdevbox/renderers/<type>.mjs` and shadows any plugin/builtin
renderer of the same name. The module MUST be:

```js
export default {
  type: 'note',              // optional label; the *filename* is what the resolver keys on
  comments: false,           // OPTIONAL — opt out of the universal comment overlay (see below)
  async render(root, ctx) {  // root = DOM element to fill; ctx = the data gateway
    // build DOM under `root`
  },
};
```

`ctx` exposes exactly (verified against `mcp-server/src/renderers/markdown.mjs:91`
and all sibling renderers):

| `ctx` member | Returns | Used by |
|---|---|---|
| `manifest` | the artifact manifest (incl. `meta.entry`) | `markdown.mjs:98` |
| `artifactId` | string id | `pr-walkthrough.mjs` |
| `fetchFile(name)` | `Promise<string>` | `markdown.mjs:101`, `html.mjs:169` |
| `fetchFileJson(name)` | `Promise<any>` | `walkthrough.mjs:228`, `pr-review.mjs:457` |
| `listFiles()` | `Promise<string[]>` | `markdown.mjs:103` |

Notes from the real renderers: import third-party deps by URL
(`https://esm.sh/marked@12`, `markdown.mjs:11`); share code via sibling
`_`-prefixed modules imported relatively (`import { PR_WALKTHROUGH_STYLES }
from './_pr-walkthrough-styles.mjs'`, `pr-walkthrough.mjs:30`; also
`_comment-overlay.mjs`). Set `comments: false` when the renderer ships its own
comment UI (`pr-review.mjs:448`, `walkthrough.mjs:215`, `pr-walkthrough.mjs:1634`).

## Precedence & shadowing

`resolveRendererFile` returns the first existing file
(`docs/tools/artifact.md:137`):

1. **workspace** — `<workspace>/.clawdevbox/renderers/<type>.mjs` (written by `renderer.write`, highest)
2. **plugin** — `<plugin_dir>/renderers/<type>.mjs` (first plugin wins; how plugins add *new* types)
3. **builtin** — `mcp-server/src/renderers/<type>.mjs`

`renderer.list` returns every renderer in precedence order; the one with
`active: true` is served at `/__renderer/<type>.mjs` and used by `artifact.add`;
shadowed entries are `active: false`. Use `renderer.read` to study a renderer
before shadowing it, and `renderer.delete` to drop a workspace override.

## Built-in types + required files

Run `artifact.types` for the authoritative live list. On-disk renderers today:

| type | renderer | files `render()` fetches |
|---|---|---|
| `markdown` | `markdown.mjs` | `content.md` (or `manifest.meta.entry`) |
| `html` | `html.mjs` | `content.html` / `index.html` (or `meta.entry`) |
| `walkthrough` | `walkthrough.mjs` | `walkthrough.json` (+ `files__<safe>.txt` per step) |
| `pr-review` | `pr-review.mjs` | `review.json` (+ optional `walkthrough.json`, `pr.json`, `diffs/*.diff`) |
| `pr-walkthrough` | `pr-walkthrough.mjs` | `walkthrough.json` (+ `original__`/`modified__`/`diff__` per step) |

Ship exactly the files your `render()` fetches, or `fetchFile` rejects and the
view errors.

## Worked minimal renderer (distilled from `markdown.mjs`)

```js
// <workspace>/.clawdevbox/renderers/note.mjs — workspace renderer for type="note".
export default {
  type: 'note',
  async render(root, ctx) {
    const name = ctx.manifest?.meta?.entry ?? 'content.md';
    let text;
    try {
      text = await ctx.fetchFile(name);            // Promise<string>
    } catch (err) {
      const files = await ctx.listFiles();          // list what IS present, for a useful error
      throw new Error(`Missing "${name}". Files: ${files.join(', ')}. ${err?.message ?? err}`);
    }
    const el = document.createElement('div');
    el.textContent = text;
    root.appendChild(el);
  },
};
```

For JSON-shaped types, use `ctx.fetchFileJson('data.json')` (see
`walkthrough.mjs:228`).

## Companion per-type creation skill (do not skip)

**Every type needs a paired `build-<type>-artifact` skill** that teaches an
agent how to PRODUCE that type's files and call `artifact.add`. The renderer
alone is useless if no one knows what to feed it. Model after the two existing
examples:

- `build-html-artifact` → `type: 'html'` (produces `index.html`).
- `build-pr-walkthrough` → `pr-walkthrough` / `walkthrough` (produces
  `walkthrough.json` + per-step diff files). `artifact.types` advertises this
  pairing via its `skill` / `recipe` fields.

When you add a type: (1) write/verify the renderer with `renderer.write`, then
(2) author the `build-<type>-artifact` reference skill using the
**writing-skills** discipline (RED baseline → minimal skill → refactor),
documenting the required files, the `artifact.add` call, and a validation step.

## `artifact.add` target-workspace note

`artifact.add({ id, type, title, files?, workspace_id? })` needs a target
workspace. It resolves `workspace_id` arg → `CLAWDEVBOX_WORKSPACE_ID` env →
`CLAWDEVBOX_PROJECT_DIR` registry lookup. When the project dir isn't a
registered workspace it fails `NO_TARGET_WORKSPACE` — pass `workspace_id`
explicitly, resolving the id via `workspace.list` (or `workspace.current`).
`manifest.json` is reserved; never pass it in `files`.

## Gotchas

- **Not a valid ESM default export** — a bare function or named export won't
  load. It must be `export default { render }`. `render` may be `async`.
- **Using Node APIs** (`fs`, `require`) — renderers run in the browser iframe;
  only `ctx.*` reaches the files.
- **Forgetting precedence** — a workspace renderer shadows builtin/plugin
  *completely*; check `renderer.list` (active vs shadowed) first.
- **Missing required files** — the renderer throws when `fetchFile` rejects.
- **`ARTIFACT_TYPE_CONFLICT`** — re-adding an id with a different `type`; delete
  the artifact first.
- **New type, no companion skill** — agents can't produce it. Always pair.

## See also

- `build-html-artifact` — reference companion skill for the `html` type.
- `build-pr-walkthrough` — reference companion skill for PR walkthrough types.
- `using-clawdevbox` — the `renderer.*` / `artifact.*` tool reference and
  meta-tool (`list_tools` → `learn_tool` → `run_tool`) protocol.
