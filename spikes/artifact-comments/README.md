# Artifact Comments — Standalone Spike

A self-contained runnable prototype of the artifact-commenting feature
described in
`docs/superpowers/specs/2026-06-13-artifact-comments-design.md`.

**Purpose:** validate the UX and the architecture before integrating into
clawdevbox, and serve as a copy-from reference when building the real version
inside `mcp-server/`.

## What it covers (everything risky)

- ✅ Text selection → floating toolbar → sidebar card
- ✅ Comment ↔ highlight focus sync (click-through both ways)
- ✅ Per-artifact draft persistence via the generic JSON document store API
  (`PUT /api/store/:collection/:id`) — exact same shape we'll ship
- ✅ Re-anchoring after a "Re-render artifact" event
- ✅ Element-click anchors: `<img>` and mermaid SVG → PNG snapshot saved as a
  binary in the same store, referenced by path
- ✅ `Alt` + drag rectangle → screenshot of any region via `html2canvas`
- ✅ iframe → host `postMessage` → host posts to `/api/session-send` which
  prints the assembled markdown bundle (stand-in for the real `session.send`
  MCP path)
- ✅ Draft archive on send → `artifact-comment-history/<id>-<ts>`

## What it deliberately does *not* cover

- Real MCP integration (`session.send` is faked with a stdout echo).
- Workspace resolution (the spike uses a single hard-coded store dir under
  `./.store/`).
- The Vue SPA integration (`ArtifactPanel.vue`) — the spike uses a plain
  parent page + `<iframe>` to mimic the architecture.
- DOMPurify on the HTML renderer (the spike's HTML body is inline-trusted).

## Run it

```powershell
cd C:\git\clawdevbox\spikes\artifact-comments
node server.mjs
# → Spike listening on http://localhost:7777
```

Open <http://localhost:7777> in any modern browser.

## Verify the design

Click through each of these to confirm the design works:

1. **Select** the phrase *"30% YoY growth"* in the text → toolbar appears
   next to selection → click 💬 → sidebar opens with a card → type a
   comment → save.
2. **Refresh** the page → the comment is still there, highlighted on the
   exact same text.
3. Click **"Re-render artifact"** → markdown body destroyed and rebuilt →
   highlight re-attaches by fingerprint.
4. **Hover** the embedded `<img>` → outline appears → click → sidebar card
   with thumbnail; PNG saved at `.store/artifact-comment-attachments/att_*.png`.
5. **Hover** the mermaid diagram → click → SVG-to-PNG snapshot saved.
6. **Hold `Alt`** and drag a rectangle over any region (mix of text + image)
   → release → region screenshot saved.
7. Click **"Send (N) →"** → assembled markdown prints in the `server.mjs`
   terminal AND in the "Last send" panel on the host page; drafts clear; an
   archive entry appears under `.store/artifact-comment-history/`.

## File layout

```
spikes/artifact-comments/
├── README.md             ← you are here
├── server.mjs            ← tiny Node HTTP server: generic store + faked send
├── index.html            ← parent page hosting the artifact iframe + send panel
├── viewer.html           ← iframe content (loads renderer + overlay)
├── comment-overlay.mjs   ← the library being designed (~400 LOC, ships ~as-is)
├── markdown-renderer.mjs ← thin stub of renderers/markdown.mjs
├── sample-artifact.md    ← demo markdown with text, an <img>, a mermaid diagram
└── .store/               ← created at runtime; safe to delete to reset state
```

## Reset state

```powershell
Remove-Item -Recurse -Force .\.store
```
