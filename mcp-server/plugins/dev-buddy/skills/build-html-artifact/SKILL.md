---
name: build-html-artifact
description: Create rich, interactive, self-contained HTML artifacts (design docs, implementation plans, reports, dashboards, visualizations, org charts, trackers, comparisons) via artifact.add. Produces visual documents designed for 5-minute human comprehension — NOT rendered markdown. Two paths — a self-contained single HTML file (default) or a bundled React + shadcn/ui app for complex tools. Every artifact MUST use the clawdevbox theme variables defined in this skill.
license: Complete terms in LICENSE.txt
triggers:
  - "create a visual artifact"
  - "build an HTML artifact"
  - "make an interactive report"
  - "design doc as HTML"
  - "visual implementation plan"
  - "create a dashboard"
  - "build an interactive tool"
  - "data visualization"
---

# Building Interactive HTML Artifacts

## Why HTML instead of Markdown

A design doc or implementation plan as markdown is a **wall of text**. A busy
reviewer has 5 minutes — they won't read 40 paragraphs. They need:

- An architecture diagram that shows the system at a glance
- A flowchart that traces the data path in 10 seconds
- A risk matrix where red cells jump out immediately
- A dependency graph where the critical path is obvious
- A comparison table where the chosen approach is highlighted

**The HTML artifact exists to make the human's decision fast.** It's the
difference between "I read for 20 minutes and I think I understand" vs
"I looked for 2 minutes and I see exactly what's changing and why."

The markdown artifact remains the canonical detailed record. The HTML is
the **comprehension accelerator** — diagrams, flowcharts, visual layouts
that communicate structure faster than prose ever can.

---

## What every artifact gets for free (you write NO code for these)

The clawdevbox renderer adds these to **every** `html` (and `markdown`) artifact
automatically — do not hand-roll them:

- **Comments** — reviewers select text, click an image/diagram, or Alt-drag a
  region to leave an anchored comment; the agent replies inline.
- **Q&A** — a "Q&A" tab with an "Ask about this artifact…" composer. Questions
  are dispatched to the owning agent, which answers inline (usually <15s).
  Both comments and Q&A persist per-artifact and sync live across viewers.
- **Diagram pan/zoom** — any diagram in a `.diagram` / `.mermaid` /
  `[data-zoomable]` box gets a ⤢ zoom button → full-viewport drag-to-pan,
  scroll/±-to-zoom overlay.

So: focus on the CONTENT. Don't build your own comment box, question form, or
zoom widget — they're provided and would conflict.

---

## ⚠️ MANDATORY: clawdevbox theme (read this FIRST)

**Every HTML artifact you generate MUST include all of the following.** Do not
skip any part. Do not invent your own color scheme. Do not hardcode colors.

clawdevbox renders artifacts inside a **dark** viewer (the artifact host page
and the SPA are dark), so the theme defaults to **dark**. A light variant is
available and opt-in via `?theme=light` on the artifact URL.

### 1. Theme detection script (put this FIRST in a `<script>` tag, before any other JS)

```html
<script>
  (() => {
    // clawdevbox renders on a dark surface → default dark. ?theme=light opts in.
    const param = new URLSearchParams(window.location.search).get("theme");
    const theme = param === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
  })();
</script>
```

### 2. CSS variables (copy this EXACTLY into your `<style>` block)

```css
:root {
  color-scheme: dark;
  --cdb-bg: #14161b;
  --cdb-bg-elevated: #1a1d24;
  --cdb-surface: #1c1f27;
  --cdb-surface-soft: #20232c;
  --cdb-border: #2a2e38;
  --cdb-border-strong: #3a4150;
  --cdb-text: #d8dee9;
  --cdb-text-muted: #8b95a5;
  --cdb-text-soft: #a8b4c4;
  --cdb-accent: #4a8ae8;
  --cdb-accent-hover: #5c98ee;
  --cdb-accent-soft: rgba(74, 138, 232, 0.14);
  --cdb-accent-fg: #ffffff;
  --cdb-success: #4ade80;
  --cdb-danger: #f87171;
  --cdb-warning: #f5c85a;
  --cdb-link: #4da6ff;
  --cdb-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  --cdb-radius: 10px;
}
html[data-theme="light"] {
  color-scheme: light;
  --cdb-bg: #f5f6f8;
  --cdb-bg-elevated: #ffffff;
  --cdb-surface: #ffffff;
  --cdb-surface-soft: #eef0f3;
  --cdb-border: #d5d9e0;
  --cdb-border-strong: #b6bcc7;
  --cdb-text: #1c2027;
  --cdb-text-muted: #5a6270;
  --cdb-text-soft: #6f7885;
  --cdb-accent: #2563eb;
  --cdb-accent-hover: #1d4ed8;
  --cdb-accent-soft: rgba(37, 99, 235, 0.08);
  --cdb-accent-fg: #ffffff;
  --cdb-success: #16a34a;
  --cdb-danger: #dc2626;
  --cdb-warning: #d97706;
  --cdb-link: #0078d4;
  --cdb-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cdb-radius: 10px;
}
```

### 3. Use ONLY `var(--cdb-*)` for all colors

- `body { background: var(--cdb-bg); color: var(--cdb-text); }`
- Borders: `var(--cdb-border)`
- Cards/panels: `var(--cdb-surface)`
- Muted text: `var(--cdb-text-muted)`
- Accent/primary: `var(--cdb-accent)`
- Semantics: `var(--cdb-success)` / `var(--cdb-danger)` / `var(--cdb-warning)`
- **NEVER hardcode hex/rgb/hsl color values in component styles**

### 4. Typography

- **Font**: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
- **Monospace**: `"Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace`
- Do NOT use Inter, Geist, or generic system-ui as the primary font.

### 5. Shape & Spacing

- Border radius: `var(--cdb-radius)` (10px) for cards/panels, `6px` for controls/chips
- Card shadow: subtle — prefer `1px` borders (`var(--cdb-border)`) over dramatic drop shadows
- Use consistent 4px-based spacing

### 6. Do / Don't

- ✅ Dark charcoal backgrounds (`--cdb-bg`), clean surfaces, subtle 1px borders
- ✅ GitHub-style blue as the single accent (`--cdb-accent`); green=safe, yellow=caution, red=risk
- ❌ No purple gradients, teal, or generic "AI blue" glassmorphism
- ❌ No excessive rounded corners or heavy drop shadows
- ❌ No Inter font
- ❌ No hardcoded colors — always use `var(--cdb-*)` variables

---

## Design Principles

1. **Lead with diagrams** — architecture, data flow, sequence diagrams. If
   the reader understands the diagram, they may not need to read anything else.
2. **Use spatial layout** — cards, grids, columns communicate relationships
   that paragraphs cannot.
3. **Color encodes meaning** — green=safe, yellow=caution, red=risk. The
   reviewer's eye finds the problem areas in 2 seconds.
4. **Progressive disclosure** — headline visible, detail behind a click.
   Don't overwhelm; let the reader drill down on what matters to them.
5. **Interactivity saves time** — tabs switch between views, collapsibles
   hide noise, hover shows context. One page replaces 5 documents.

---

## Choosing a path

- **Simple path (default):** single self-contained HTML file. Use for design
  docs, implementation plans, reports, dashboards, and most visualizations.
  Fast, zero build. Jump to **Simple Path** below.
- **Complex path:** a full React 19 + TypeScript + Tailwind + shadcn/ui app,
  bundled to a single HTML file. Use only for genuinely interactive multi-view
  tools (rich forms, data tables with sorting/filtering, wizards). Jump to
  **Complex Path** below.

Both paths deliver the artifact the same way — via `artifact.add` with the
entrypoint named exactly `index.html`.

---

## artifact.add call format

```json
{
  "tool": "artifact.add",
  "args": {
    "id": "<unique-artifact-id>",
    "type": "html",
    "title": "<Human-readable title>",
    "files": {
      "index.html": "<full self-contained HTML>"
    }
  }
}
```

**CRITICAL:** The entrypoint MUST be named exactly `index.html`. Any other
name (e.g. `report.html`, `content.html`, `design.html`) also works *only*
because the renderer now falls back to `content.html` then `index.html` — but
`index.html` is the canonical, guaranteed name. Prefer it.

---

## Simple Path — single self-contained HTML file

The HTML file MUST be:

1. **Self-contained** — all CSS and JS inline. No external CDN links, no
   `fetch()` calls, no `<img src>` to external URLs. Everything in one file.
   (Mermaid, if used, must be rendered to inline SVG at build time — the
   clawdevbox viewer will not fetch external scripts for you.)

2. **clawdevbox-themed** — include the theme-detection script + `--cdb-*` CSS
   variables from the MANDATORY section above, and use `var(--cdb-*)` for all
   colors.

3. **Visual, not textual** — use:
   - Diagrams (inline SVG) — **made zoomable** (see *Zoomable diagrams* below)
   - Cards with icons for key sections
   - Color-coded grids for matrices (risk, comparison)
   - Progress bars, gauges, status indicators
   - Collapsible `<details>` for drill-down
   - Tables with zebra-striping for data

4. **Interactivity — JavaScript is allowed.** The clawdevbox `html` renderer
   executes your `<script>` tags (inline **and** `src`, in document order) and
   inline event handlers (`onclick`, …) — artifacts are first-party (agent-
   generated, rendered in your own viewer). Inline `<style>` and `<svg>` render
   as usual. Use whatever fits the job:
   - Native no-JS affordances are still great for simple cases and degrade
     gracefully if the file is opened bare: `<details><summary>…</summary></details>`,
     CSS-only radio tabs (`<input type="radio">` + `label` + `:checked ~ .panel`),
     anchor-link tables of contents, `:hover` tooltips.
   - Or drive tabs / filters / sorting / charts with your own `<script>`.
   Notes: content is injected **first**, then scripts run (progressive
   enhancement) — your script sees the DOM. `type="module"` works. Non-JS
   `<script>` blocks (e.g. `type="application/json"` data) are left inert.
   Prefer self-contained inline JS over external CDNs so the artifact still
   works offline / on the share tunnel.

5. **5-minute comprehension** — TL;DR / executive summary at the very top
   (3-5 bullets), visual overview (diagram or hero card) immediately below,
   detailed sections in collapsible blocks, clear headers with icons.

### Template Structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{TITLE}}</title>
  <script>
    (() => {
      const param = new URLSearchParams(window.location.search).get("theme");
      document.documentElement.setAttribute("data-theme", param === "light" ? "light" : "dark");
    })();
  </script>
  <style>
    /* Paste the full :root + html[data-theme="light"] var blocks from the
       MANDATORY theme section here. */

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--cdb-bg);
      color: var(--cdb-text);
      line-height: 1.6;
      /* Fill the FULL available width. The renderer wraps your HTML in a full-width
         container (viewport minus the comment sidebar) and the host neutralizes any
         page-level `body { max-width }` / `margin: 0 auto`, so do NOT cap or center
         the body — design card grids / columns that fill 100%, matching the
         full-width PR walkthrough. (Insets are provided by the renderer.) */
      padding: 8px;
    }
    h1 { font-size: 1.8em; margin-bottom: 8px; color: var(--cdb-text); }
    h2 { font-size: 1.3em; margin: 24px 0 12px; color: var(--cdb-text); border-bottom: 1px solid var(--cdb-border); padding-bottom: 6px; }
    h3 { font-size: 1.1em; margin: 16px 0 8px; color: var(--cdb-text-soft); }

    .hero { background: var(--cdb-surface); border: 1px solid var(--cdb-border); border-radius: var(--cdb-radius); padding: 20px 24px; margin-bottom: 24px; }
    .hero .subtitle { color: var(--cdb-text-muted); font-size: 0.9em; }

    .tldr { background: var(--cdb-accent-soft); border-left: 3px solid var(--cdb-accent); padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px; }
    .tldr ul { list-style: none; padding: 0; }
    .tldr li { padding: 4px 0; }
    .tldr li::before { content: "→ "; color: var(--cdb-accent); font-weight: bold; }

    .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: var(--cdb-surface); border: 1px solid var(--cdb-border); border-radius: 8px; padding: 16px; }
    .card-title { font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
    .card-body { color: var(--cdb-text-muted); font-size: 0.9em; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600; }
    .badge-green { background: rgba(74, 222, 128, 0.15); color: var(--cdb-success); }
    .badge-yellow { background: rgba(245, 200, 90, 0.15); color: var(--cdb-warning); }
    .badge-red { background: rgba(248, 113, 113, 0.15); color: var(--cdb-danger); }
    .badge-blue { background: var(--cdb-accent-soft); color: var(--cdb-accent); }

    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.9em; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--cdb-border); }
    th { color: var(--cdb-text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.8em; letter-spacing: 0.5px; }
    tr:hover td { background: var(--cdb-surface-soft); }

    details { margin: 8px 0; }
    summary { cursor: pointer; font-weight: 500; padding: 8px 0; color: var(--cdb-text-soft); }
    summary:hover { color: var(--cdb-accent); }
    details[open] summary { color: var(--cdb-accent); margin-bottom: 8px; }

    .risk-matrix { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .risk-item { padding: 10px; border-radius: 6px; text-align: center; }
    .risk-low { background: rgba(74, 222, 128, 0.1); border: 1px solid rgba(74, 222, 128, 0.3); }
    .risk-medium { background: rgba(245, 200, 90, 0.1); border: 1px solid rgba(245, 200, 90, 0.3); }
    .risk-high { background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.3); }

    .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--cdb-border); margin-bottom: 16px; }
    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; color: var(--cdb-text-muted); font-size: 0.9em; }
    .tab:hover { color: var(--cdb-text); }
    .tab.active { color: var(--cdb-accent); border-bottom-color: var(--cdb-accent); }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    code { background: var(--cdb-surface-soft); padding: 2px 6px; border-radius: 3px; font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace; font-size: 0.85em; }
    pre { background: var(--cdb-bg-elevated); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; border: 1px solid var(--cdb-border); }
    pre code { background: none; padding: 0; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>{{TITLE}}</h1>
    <div class="subtitle">{{SUBTITLE / DATE / CONTEXT}}</div>
  </div>

  <div class="tldr">
    <ul>
      <li>Key point 1</li>
      <li>Key point 2</li>
      <li>Key point 3</li>
    </ul>
  </div>

  <div class="card-grid">
    <div class="card">
      <div class="card-title">🎯 Goal</div>
      <div class="card-body">What this achieves</div>
    </div>
    <div class="card">
      <div class="card-title">⚡ Approach</div>
      <div class="card-body">How it's done</div>
    </div>
    <div class="card">
      <div class="card-title">⚠️ Risk</div>
      <div class="card-body">Key risk + mitigation</div>
    </div>
  </div>

  <details open>
    <summary>Section Title</summary>
    <!-- content -->
  </details>

  <!-- "Tabs" WITHOUT JavaScript: one <details> per view (all reachable). -->
  <details open>
    <summary>View 1</summary>
    <!-- view 1 content -->
  </details>
  <details>
    <summary>View 2</summary>
    <!-- view 2 content -->
  </details>
</body>
</html>
```

---

## Zoomable diagrams (automatic — just use `.diagram`)

**Every diagram is automatically pan/zoomable — you do NOT write any zoom code.**
The clawdevbox `html` renderer detects diagrams and attaches a full pan/zoom
overlay in trusted renderer JS. A **"⤢ zoom"**
button appears on each diagram; clicking it opens a full-viewport stage where the
SVG can be **dragged to pan** and **scroll- or ±-button-zoomed** to any level,
with a Fit/reset (⊙) button and Esc/✕ to close.

### What you must do

Put each diagram's inline SVG inside a container the renderer recognizes —
any of `.diagram`, `.mermaid`, or `[data-zoomable]`:

```html
<div class="diagram" data-title="Architecture">
  <!-- inline <svg> … </svg>  (mermaid rendered to SVG at build time) -->
</div>
```

```css
/* The renderer adds the zoom button + overlay; you only style the inline box. */
.diagram { position: relative; background: var(--cdb-surface); border: 1px solid var(--cdb-border); border-radius: 8px; padding: 18px; overflow-x: auto; text-align: center; }
.diagram svg { max-width: 100%; height: auto; }
```

Notes:
- Optional `data-title="…"` labels the zoom overlay; otherwise the renderer uses
  the nearest heading.
- Diagrams **must** be inline SVG (self-contained). Do not embed `<iframe>`s or
  external images for diagrams.
- The renderer already provides diagram pan/zoom, so you don't need your own
  (svg-pan-zoom, panzoom); adding one just duplicates the built-in overlay.

### Fallback (viewing the raw file outside clawdevbox)

If an artifact will be opened as a bare `.html` file (no clawdevbox renderer),
add a no-JS CSS fallback: a checkbox toggle (`<input type="checkbox">` + `<label>`
+ `:checked ~ .diagram { position:fixed; inset:0; overflow:auto }`) that expands
the diagram to a scroll-to-pan overlay. Inside clawdevbox this is redundant with
the renderer's overlay, so it's optional.

---

## Complex Path — React + shadcn/ui, bundled to one HTML file

Use only for genuinely interactive multi-component tools. The pipeline
scaffolds a React app, you develop it, then bundle it to a single
self-contained `bundle.html` that you hand to `artifact.add`.

**Stack**: React 19 + TypeScript + Vite + Parcel (bundling) + Tailwind CSS +
shadcn/ui. Requires `bash`, Node 18+, and network access for the initial
dependency install (this runs inside the clawdevbox devbox, not in the
artifact iframe — the *shipped* artifact is still fully self-contained).

### Step 1 — Initialize the project

Run the init script from this skill's `scripts/` directory:

```bash
bash scripts/init-artifact.sh <project-name>
cd <project-name>
```

This creates a fully configured project with:

- ✅ React + TypeScript (via Vite)
- ✅ Tailwind CSS 3.4.1 with the shadcn/ui theming system
- ✅ The clawdevbox `--cdb-*` theme variables pre-seeded in `src/index.css`
- ✅ Path aliases (`@/`) configured
- ✅ 40+ shadcn/ui components pre-installed (from `scripts/shadcn-components.tar.gz`)
- ✅ All Radix UI dependencies included
- ✅ Parcel configured for bundling (via `.parcelrc`)
- ✅ Node 18+ compatibility (auto-detects and pins the Vite version)

### Step 2 — Develop your artifact

Edit the generated files. **All colors must use the `--cdb-*` CSS variables**
(pre-seeded in `src/index.css`) — do NOT use shadcn/ui's default color tokens
or hardcoded values. Add the theme-detection snippet from the MANDATORY
section to `index.html` so the app defaults to the clawdevbox dark theme.

### Step 3 — Bundle to a single HTML file

```bash
bash scripts/bundle-artifact.sh
```

This produces `bundle.html` — a self-contained artifact with all JavaScript,
CSS, and dependencies inlined. Requires an `index.html` in the project root.

**What the script does**: installs bundling deps (parcel, @parcel/config-default,
parcel-resolver-tspaths, html-inline), writes a `.parcelrc` with path-alias
support, builds with Parcel (no source maps), then inlines every asset into one
HTML file with html-inline.

### Step 4 — Deliver via artifact.add

Read the produced `bundle.html` and pass its **full contents** as the
`index.html` file:

```json
{
  "tool": "artifact.add",
  "args": {
    "id": "<unique-artifact-id>",
    "type": "html",
    "title": "<Human-readable title>",
    "files": { "index.html": "<full contents of bundle.html>" }
  }
}
```

The artifact then appears in the clawdevbox Artifacts tab (and is shareable via
the artifact's Share link). Point the user at the `view_url` from the
`artifact.add` result.

### Step 5 — Test / visualize (optional)

Only if requested or if issues arise. Use Playwright/Puppeteer against the
rendered artifact page. Avoid testing upfront — it adds latency; test after
delivering, if needed.

---

## Content-Type Specific Patterns

### Design Document HTML
- Hero: WI title + repo + date
- TL;DR: problem + solution in 3 bullets
- Architecture diagram (inline SVG)
- Goals vs Non-goals as a two-column card grid
- Approach as a numbered timeline
- Alternatives as a comparison table (columns: option, pros, cons, verdict)
- Risk matrix as a color-coded grid
- Acceptance criteria as an interactive checklist

### Implementation Plan HTML
- Hero: WI title + step count + estimated effort
- TL;DR: scope + critical path
- Dependency graph as an interactive DAG (SVG with hover highlights)
- Tasks as cards grouped by repo (color-coded)
- Timeline / Gantt as a horizontal bar chart; critical path highlighted in red
- Per-task detail in collapsible sections

### Status Report / Summary HTML
- Hero: title + date range
- Metrics as gauge cards (completed/total, pass/fail)
- Timeline of events
- Issues / risks as a sortable table
- Next steps as a checklist

---

## Validation Checklist

Before delivering any HTML artifact:

- [ ] Entrypoint is named `index.html`
- [ ] Fully self-contained (no external URLs / CDN / fetch)
- [ ] Theme-detection script present; `--cdb-*` variables included
- [ ] All colors use `var(--cdb-*)` — none hardcoded
- [ ] Dark by default (matches the clawdevbox viewer)
- [ ] TL;DR at top for a 30-second scan
- [ ] Visual elements (not just text)
- [ ] Every diagram is inline SVG in a `.diagram` box (renderer adds pan/zoom)
- [ ] Interactive via `<details>`/CSS or your own `<script>` (both run; prefer no-JS for simple cases)
- [ ] Renders full-width (fills the pane, no centered narrow column) and at narrow (768px) widths
- [ ] No console errors in the browser
- [ ] Delivered via `artifact.add` with `type: 'html'`

## Reference

- **shadcn/ui components**: https://ui.shadcn.com/docs/components
