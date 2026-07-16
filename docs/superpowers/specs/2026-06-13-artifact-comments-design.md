# Artifact Comments — Design

**Status:** Spec (awaiting review)
**Date:** 2026-06-13
**Owner:** @devuser
**Brainstorm session:** `.superpowers/brainstorm/25572-1781397587/`

---

## 1. Problem

Today the artifact viewer at `/artifact/<id>` is read-only. A user reviewing
a markdown plan, an HTML report, a mermaid diagram, or an embedded screenshot
has no way to give the agent that produced it focused, in-context feedback —
they have to switch back to the terminal and re-explain what they're pointing
at, losing the artifact's structure and visual references in translation.

We want **GitHub-PR-style inline review for any artifact**: select text (or a
visual region), attach a comment, accumulate a few, then push the whole bundle
to the active agent session as a single, well-formed user-turn that the agent
can act on immediately.

## 2. Goals & non-goals

**Goals**
1. Users can anchor comments to **text selections** in markdown and HTML
   artifacts, with highlights surviving an iframe re-render.
2. Users can anchor comments to **non-text content**: `<img>` elements, mermaid
   diagrams, code blocks, and **arbitrary drag-selected rectangular regions** of
   the artifact (whole-element click + rect drag).
3. A **collapsible sidebar** shows every pending comment as a card, with a
   prominent "Send (N) →" action.
4. "Send" delivers a single, human-readable markdown message to the active
   agent session via the existing `session.send` MCP path.
5. Drafts **persist per-artifact across iframe remounts, browser refreshes,
   and clawdevbox restarts**.
6. Implementation is **shared across renderers**: a single client-side library,
   opt-in from any renderer (built-in or plugin) with one line.
7. Server side reuses a **new generic workspace-scoped JSON+blob document
   store** — no commenting-specific endpoints.

**Non-goals (v1)**
- Threaded replies on comments. v1 is one-shot feedback, not a conversation.
- Multi-user collaboration. clawdevbox is single-user-on-one-machine.
- Sending to inbox or to a queued/non-running agent. v1 requires an active
  session in the workspace. (Disabled-with-tooltip; future work.)
- Auto-enabling on `pr-review.mjs` / `walkthrough.mjs` / plugin renderers.
  They can opt in with one line later — v1 ships markdown + html only.
- An MCP tool for agents to read drafts. The agent only sees the assembled
  bundle that the user explicitly Sends.

## 3. UX

```
┌──────────────────────────────────────────────┬──────────────────────────┐
│ # Q3 Engineering Plan                        │ Comments (3)  [Send (3)]│
│                                              ├──────────────────────────┤
│ ## Goals                                     │ § Goals · "Drive 30%…"  │
│ ▒▒Drive 30% YoY growth in active users▒▒ … │ Needs a baseline.       │
│                                              │                          │
│ ## Architecture                              │ § Budget · "$420k…"     │
│  ┌──────────────────────────┐                │ GPU cluster?             │
│  │  [ mermaid SVG diagram ] │ ← click to    │                          │
│  │  ▒ outlined on hover  ▒  │   comment      │ § diagram in Arch.       │
│  └──────────────────────────┘                │ [thumb] branch at step 3 │
│                                              │                          │
│         ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                    │ Draft saved · syncs to   │
│         ▒  drag-rect    ▒ ← release → snap  │ .clawdevbox/store/…      │
│         ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒                    │                          │
└──────────────────────────────────────────────┴──────────────────────────┘
```

**Three ways to anchor a comment:**

| Trigger | Anchor kind | What's captured |
|---|---|---|
| Mouse-select text → click 💬 toolbar (or `⌘⏎`) | `text` | Selected text + nearest heading + fingerprint |
| Hover on `<img>` / `.mermaid-rendered` / `<pre>` → click 💬 outline | `image` | PNG snapshot of that element |
| Hold `Alt` + drag a rectangle → release | `image` (region) | PNG screenshot of that rectangle |

**Sidebar behaviour:**
- Collapsed when zero comments. Auto-expands on the first comment of the session.
- Click a card → scroll + flash the matching anchor in the artifact.
- Click an anchor → focus + scroll-into-view the matching card.
- Per-card actions: `edit`, `delete`.
- Header actions: `Clear all`, `Send (N) →`.
- "Send" is disabled with tooltip when no active agent session exists in this
  workspace. Tooltip text: *"Start an agent session in this workspace to send
  comments."*

**Orphaned highlights:** if a comment's anchor fingerprint no longer matches
anything after a re-render, the card stays in the sidebar with a 🔗❌ badge.
Still send-able; the markdown bundle marks it `(orphan — original text:
"…")`. User can delete or send anyway.

**Keyboard:**
- `⌘⏎` (or `Ctrl+Enter`) — save the active comment card.
- `Esc` — cancel edit.
- `Alt+drag` — start a rectangle screenshot selection.

## 4. Architecture

```
┌────────────── browser (Vue SPA, parent frame) ──────────────┐
│                                                              │
│   ArtifactPanel.vue ──postMessage('artifact:send-comments')──┐
│        │                                                     │ │
│        └─ on message → call existing session.send MCP path   │ │
│                                                              │ │
└──────────────────────────────────────────────────────────────┘ │
                              ▲                                  │
                              │  postMessage to parent           │
                              │                                  │
┌────────────── iframe sandbox (artifact host page) ───────────┐ │
│                                                              │ │
│   renderers/markdown.mjs   ──┐                               │ │
│   renderers/html.mjs       ──┼─ enableComments(root, ctx)    │ │
│   renderers/<plugin>.mjs  …──┘         │                     │ │
│                                        │ owns selection,     │ │
│   renderers/_comment-overlay.mjs ◀─────┘ toolbar, sidebar,   │ │
│        │                                 drafts, capture,    │ │
│        │ fetch()                         postMessage          │ │
│        ▼                                                     │ │
└────────│─────────────────────────────────────────────────────┘ │
         │                                                       │
┌────────▼──────────── mcp-server (Node) ──────────────────────┐ │
│                                                              │ │
│  terminal-server.ts  (HTTP/WS server, already exists)        │ │
│        │                                                     │ │
│        ├─ /api/store/:collection/:id   (NEW — generic store) │ │
│        │     │                                               │ │
│        │     ▼                                               │ │
│        │   json-doc-store.ts  (NEW)                          │ │
│        │     │  reads/writes:                                │ │
│        │     ▼  <workspace>/.clawdevbox/store/<col>/<id>     │ │
│        │     ▼                          (.json or .<ext> +   │ │
│        │     ▼                           .meta.json sidecar) │ │
│        │                                                     │ │
│        └─ /artifact/<id>  (already exists, unchanged)        │ │
│                                                              │ │
└──────────────────────────────────────────────────────────────┘ │
                                                                 │
                                  session.send MCP tool ─────────┘
                                  (already exists)
```

**Why the parent SPA performs the send, not the iframe:**
The iframe is `sandbox="allow-scripts allow-same-origin …"` and has no MCP
client. The SPA already holds the MCP session for the workspace. The iframe
posts a `{type, payload}` message; the SPA validates the origin, looks up the
active agent session for the artifact's workspace, and calls `session.send`.

## 5. Components

### 5.1 `mcp-server/src/json-doc-store.ts` (new, ~120 LOC)

Generic, workspace-scoped, content-type-aware document store with HTTP routes
registered on `terminal-server.ts`.

```ts
export interface JsonDocStore {
  get(workspaceDir: string, collection: string, id: string):
    Promise<{ body: Buffer, contentType: string, etag: string } | null>;
  put(workspaceDir: string, collection: string, id: string,
      body: Buffer, contentType: string, ifMatch?: string):
    Promise<{ etag: string }>;
  delete(workspaceDir: string, collection: string, id: string): Promise<void>;
  listIds(workspaceDir: string, collection: string): Promise<string[]>;
}
```

**HTTP routes** (mounted on the existing terminal-server):
- `GET    /api/store/:collection/:id`  → `200 <body>` with `Content-Type` + `ETag` headers, or `404`
- `PUT    /api/store/:collection/:id`  → `204` (or `412 Precondition Failed` if `If-Match` mismatch); returns new `ETag` header
- `DELETE /api/store/:collection/:id`  → `204`
- `GET    /api/store/:collection`      → `200 { ids: string[] }`

**Constraints:**
- `:collection` and `:id` match `^(?!\.)[A-Za-z0-9._-]{1,128}(?<!\.)$` AND must not contain
  the `..` substring (path-safe, no `/`, no hidden-file names, no traversal).
  Tightened from the initial `^[A-Za-z0-9._-]{1,64}$` after the spike caught
  that the simple form accepted things like `bad..name`.
- Max **256 KB** per JSON document, **4 MB** per binary (PNG/JPEG) — config
  constants near the top of the file.
- Atomic writes via `tmp file + rename`.
- ETag = `"sha1:<hex>"` of the bytes.
- Storage layout: `<workspace>/.clawdevbox/store/<collection>/<id>.<ext>`
  with a sibling `<id>.meta.json` containing `{ content_type, sha1, size, created_at, updated_at }`.
  `<ext>` is derived from content-type (`json`, `png`, `jpg`, etc.).
- Workspace is resolved from the request the same way `artifact-store.ts` does
  today (X-Clawdevbox-Workspace header / cookie — whatever the existing pattern
  is; spike during implementation).

**Why a generic store rather than a comments-specific endpoint:**
- Future surfaces (annotation drafts, scratch notes, transient UI state) reuse
  it for free.
- The server has zero knowledge of "comments" — it stores opaque documents.
  All comment semantics live client-side in the overlay library.

### 5.2 `mcp-server/src/renderers/_comment-overlay.mjs` (new, ~400 LOC)

Shared ES module loaded in the artifact iframe. Exports:

```js
export async function enableComments(root, ctx) {
  // root: HTMLElement the renderer used as the content container
  // ctx:  { manifest, fetchFile, ... } — same ctx the renderer received
}
```

**Internal responsibilities:**
- DOM injection: floating selection toolbar, hover-outline for non-text
  elements, rectangle-drawing layer (Alt+drag), comments sidebar.
- Drafts state — single `Map<commentId, Comment>` source of truth.
- Persistence — debounced `PUT /api/store/artifact-comments/<artifactId>` on
  every mutation (500 ms trailing). Initial `GET` on mount to restore drafts.
- Re-anchoring: on mount, walk `root` once, find every saved text anchor by
  `(section, fingerprint, occurrence)`, wrap match in
  `<span class="cdb-comment-anchor" data-comment-id="…">`. Anchors that don't
  match get an `orphan: true` flag.
- Capture-to-PNG:
  - `<img>` → draw to canvas, `toBlob('image/png')`. Same-origin assumed.
  - `.mermaid-rendered` → `XMLSerializer` the inner `<svg>`, paint via
    `Image` + data-URL, `canvas.toBlob`. Pure browser APIs, no deps.
  - **Rectangle drag** → `html2canvas` (NEW dep, see §10), cropped to the
    rectangle.
- Upload attachment → `PUT /api/store/artifact-comment-attachments/att_<rand>`
  with `Content-Type: image/png`.
- Bundle build & send: assembles the markdown body (§7), then
  `window.parent.postMessage({ type: 'artifact:send-comments', payload: { artifactId, markdown, draftCount } }, location.origin)`.
- After parent ACKs send: `PUT` empty draft list AND `PUT` the bundle to
  `artifact-comment-history/<artifactId>-<isoTimestamp>` (same generic store).

### 5.3 `mcp-server/src/renderers/markdown.mjs` (edit)

One-line addition at the end of `render()`:

```js
const { enableComments } = await import('./_comment-overlay.mjs');
await enableComments(body, ctx);
```

### 5.4 `mcp-server/src/renderers/html.mjs` (new, ~50 LOC)

New built-in renderer for type `html`. Loads `content.html` (or
`manifest.meta.entry`), inserts into a `<div class="html-body">` container
(after a minimal DOMPurify pass or `iframe` sandbox — TBD during impl; prefer
sanitize since we already trust artifact content but want to be defensive
about script tags inside artifact HTML), then calls `enableComments(body, ctx)`.

### 5.5 `mcp-server/web/src/components/ArtifactPanel.vue` (edit)

Add a `window.addEventListener('message', …)` listener:

```ts
window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  if (ev.source !== iframeRef.value?.contentWindow) return;
  if (ev.data?.type !== 'artifact:send-comments') return;
  void handleSendComments(ev.data.payload);
});
```

`handleSendComments` looks up the active agent session for this workspace and
invokes the existing `session.send` MCP path with the markdown body, then
posts an `{type: 'artifact:send-comments:ack'}` back to the iframe so the
overlay can clear the live draft and archive.

## 6. Storage format

### 6.1 Per-artifact draft list

`/api/store/artifact-comments/<artifactId>`:

```json
{
  "schema_version": 1,
  "artifact_id": "art_qx2u8...",
  "updated_at": "2026-06-13T17:55:00Z",
  "drafts": [
    {
      "id": "c_kxa8a3",
      "created_at": "2026-06-13T17:54:00Z",
      "updated_at": "2026-06-13T17:54:30Z",
      "anchor": {
        "kind": "text",
        "section": "Goals",
        "text": "Drive 30% YoY growth in active users",
        "fingerprint": "sha1:abc123…",
        "occurrence": 0
      },
      "comment": "Needs a baseline. 30% of what?"
    },
    {
      "id": "c_kxa8a4",
      "anchor": {
        "kind": "image",
        "element": "mermaid",
        "section": "Architecture",
        "attachment_id": "att_kxa8",
        "attachment_path": ".clawdevbox/store/artifact-comment-attachments/att_kxa8.png"
      },
      "comment": "The data flow should branch at step 3."
    },
    {
      "id": "c_kxa8a5",
      "anchor": {
        "kind": "image",
        "element": "region",
        "section": "Architecture",
        "attachment_id": "att_kxb1",
        "attachment_path": ".clawdevbox/store/artifact-comment-attachments/att_kxb1.png",
        "rect": { "x": 120, "y": 340, "w": 480, "h": 200 }
      },
      "comment": "This whole region needs a legend."
    }
  ]
}
```

### 6.2 Attachments (PNG blobs)

Stored at `/api/store/artifact-comment-attachments/<att_id>` with
`Content-Type: image/png`. On disk:
`<workspace>/.clawdevbox/store/artifact-comment-attachments/<att_id>.png` +
`<att_id>.meta.json`.

### 6.3 History (after a successful send)

`/api/store/artifact-comment-history/<artifactId>-<isoTimestamp>` — stores
the bundle exactly as it was sent, including the markdown body and a copy of
the draft array. Used for "what did I send last time" review; not surfaced
in v1 UI but available on disk.

## 7. Payload format sent to the agent

Pure markdown via `session.send`, exactly as previewed in mockup §4-A from the
brainstorm. Example with 3 comments (text, image, region):

```
Review of artifact **Q3 Engineering Plan** (`art_qx2u8r0v`):

— Comment 1 (on §"Goals"):
> Needs a baseline. 30% of what?

> "Drive 30% YoY growth in active users"

— Comment 2 (on diagram in §"Architecture"):
> The data flow should branch at step 3.

📎 Snapshot: `.clawdevbox/store/artifact-comment-attachments/att_kxa8.png`

— Comment 3 (on region in §"Architecture"):
> This whole region needs a legend.

📎 Snapshot: `.clawdevbox/store/artifact-comment-attachments/att_kxb1.png`

Please address these and confirm.
```

**Notes:**
- Attachment paths are workspace-relative POSIX paths; the agent can resolve
  them against the workspace root, which is already in its context.
- No base64 inlining: paths only. Agent can use its file-read tool to fetch
  the image when needed.
- The trailing `Please address these and confirm.` line is hard-coded; users
  who want different framing can re-prompt the agent normally.

## 8. Anchoring & re-anchoring

### Text anchors
- `fingerprint = sha1(section + '\u0000' + text)` — computed at capture time.
- `occurrence` = 0-based index among matches in the same `section` at capture
  time (handles repeats).
- On re-mount: build the same fingerprint for every text node grouped by its
  nearest heading. Match by `(section, fingerprint, occurrence)`. If no match
  → orphan.

### Image / element anchors
- `<img>` — match by `src`. If no match → orphan.
- mermaid — match by index among `.mermaid-rendered` within the same section.
  If structure changed → orphan.
- `<pre>` — match by first 80 chars of the code text + language. If no match
  → orphan.

### Region anchors
- Always orphan on re-render (rect coords are relative to one specific layout).
  The PNG is preserved; the highlight is dropped; the card still sends with
  its snapshot attached.

## 9. Edge cases

| Case | Behavior |
|---|---|
| Empty comment text | `Save` disabled; `⌘⏎` no-op |
| Selection spans multiple top-level blocks | Clamp to topmost contiguous; show toast "Comment clamped to one paragraph" |
| Same text appears 5× in one section | `occurrence` indexes disambiguate; OK |
| User adds 50 comments before sending | No special handling; bundle grows; no token-count guard in v1 (track in follow-up if it bites) |
| `.clawdevbox/store/` exceeds quota / disk full | `PUT` returns `507 Insufficient Storage`; overlay shows toast and keeps draft in memory until refresh |
| Two artifact tabs open for the same `artifactId` | Last-write-wins on PUT; we don't implement realtime sync between iframes in v1 |
| No active agent session | `Send` disabled with tooltip; rectangle/text capture and draft persistence still work |
| `<img>` from a different origin (CORS) | Canvas tainted, `toBlob` throws; we fall back to anchoring by `src` only (no PNG), comment card shows the URL instead of a thumb |
| Workspace dir read-only | `PUT` returns `403`; overlay shows toast; behaves like quota case |

## 10. Dependencies

- **`html2canvas`** (new) — for the rectangle screenshot feature. ~30 KB
  minified+gzipped. Loaded from `https://esm.sh/html2canvas@1.4.1` to match the
  existing `marked`/`hljs`/`mermaid` ESM-CDN pattern in `markdown.mjs`. No
  `package.json` change.
- No new server-side deps. The JSON doc store uses `node:fs` and `node:crypto`.

## 11. Test plan

1. **`mcp-server/tests/json-doc-store-api.test.mjs`** (new)
   - PUT then GET round-trip (JSON, PNG).
   - `If-Match` mismatch returns 412.
   - Invalid collection / id rejected with 400.
   - Size cap enforced (413).
   - Atomic write — no partial file visible mid-write under contention.

2. **`mcp-server/tests/comment-overlay-unit.test.mjs`** (new — JSDOM)
   - Text selection → toolbar shown at correct position.
   - Comment save → `PUT` body matches expected shape.
   - Re-mount with saved drafts → highlights re-applied at right positions.
   - Orphan path: re-mount with drafts whose text no longer exists → orphan
     flag set; card still send-able.
   - Image capture: mock `<img>` → `PUT` to attachments collection fires with
     `Content-Type: image/png`.

3. **`mcp-server/tests/artifact-comments-e2e.playwright.test.mjs`** (new)
   - Open a markdown artifact, select text, type a comment, click `Send`.
   - Assert `session.send` mock was invoked with markdown matching §7.
   - Repeat with an `<img>` anchor and a region anchor; assert the
     attachment files exist on disk under
     `<workspace>/.clawdevbox/store/artifact-comment-attachments/`.
   - Refresh the iframe; assert all 3 drafts re-render with correct anchors.

4. **Existing tests** — `plugin-renderers.test.mjs`, `vue-spa-screenshots.playwright.test.mjs`:
   spot-check that the new overlay doesn't regress non-commenting rendering.

## 12. Rollout

- All work is additive. No migrations.
- Markdown-rendered artifacts gain the overlay automatically. HTML is a new
  renderer so it ships pre-commented from the start.
- A feature kill-switch via a one-liner in `_comment-overlay.mjs` (read
  `localStorage.getItem('clawdevbox.disableComments') === '1'` and short-circuit)
  for quick disable if a regression slips.

### Spike

A runnable standalone spike lives at `spikes/artifact-comments/` and validates
every risky piece end-to-end (text selection, re-anchoring, element-click
snapshots, Alt+drag region screenshots via html2canvas, generic JSON+blob
store, iframe→host postMessage hand-off). Run with `node server.mjs` and open
<http://localhost:7777>. The spike's `comment-overlay.mjs` is intended to drop
into `mcp-server/src/renderers/_comment-overlay.mjs` with only mechanical
changes (path constants, workspace resolution).

## 13. Open questions (deferred to implementation)

- DOMPurify vs sandboxed `<iframe srcdoc>` for `html.mjs` artifact body.
  Default proposal: DOMPurify in trusted-mode (we trust artifact authors but
  want defence-in-depth).
- Exact request that resolves "active agent session for this workspace"
  inside `ArtifactPanel.vue`. The store / realtime layer already knows the
  active session per workspace (per repo memory on session lifecycle), so this
  is a 1-line lookup, but the exact symbol name needs verification.

## 14. Decisions log (from brainstorm, 2026-06-13)

| # | Question | Answer |
|---|---|---|
| 1 | Comment mental model | **D** — Hybrid: selection-anchored highlights + sidebar cards (Notion / Figma) |
| 2 | Delivery mechanism | **A** — `session.send` live injection into the active agent session |
| 3 | Architecture & scope | **B** — Shared `_comment-overlay.mjs` library with opt-in `enableComments`; ships enabled in `markdown.mjs` + new `html.mjs` |
| 4 | Payload format | **A** — Pure markdown bundle (blockquote per comment, highlighted text inline) |
| 5 | Persistence | **C** — Server-side, via a NEW generic workspace-scoped JSON/blob document store (HTTP-only, no MCP tool) |
| 6 | Non-text anchors | **B** — Element click (img / mermaid / pre) **AND** Alt-drag rectangle screenshot via `html2canvas` |
