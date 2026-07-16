// _pr-walkthrough-styles.mjs
//
// All CSS for the pr-walkthrough renderer, packed as a single ES-module
// export. The renderer injects this into a <style> tag in document.head.
//
// Leading underscore: the renderer-registry skips _-prefixed .mjs files
// when listing renderer types (see renderer-registry.ts).
//
// Source of truth: spikes/pr-walkthrough/styles.css. If you edit the spike,
// re-export here. If you edit here, mirror to the spike.

export const PR_WALKTHROUGH_STYLES = String.raw`
/* =================================================================
   PR Walkthrough — Spike styles (real-PR edition)
   Goal: GitHub/Sapling-class polish. Tight typography. Clear hierarchy.
   ================================================================= */

:root {
  --bg: #0d1117;
  --panel: #161b22;
  --panel-2: #1c2230;
  --panel-3: #21283a;
  --line: #2a323e;
  --line-strong: #3a4150;
  --text: #c9d1d9;
  --text-strong: #ffffff;
  --text-dim: #8b949e;
  --accent: #58a6ff;
  --accent-strong: #79b8ff;
  --add: #56d364;
  --add-strong: #2ea043;
  --add-bg: rgba(86, 211, 100, 0.10);
  --add-bg-strong: rgba(86, 211, 100, 0.30);
  --del: #f85149;
  --del-strong: #da3633;
  --del-bg: rgba(248, 81, 73, 0.10);
  --del-bg-strong: rgba(248, 81, 73, 0.30);
  --warn: #f0a45c;
  --crit: #ff7b72;
  --shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  --shadow-soft: 0 2px 8px rgba(0, 0, 0, 0.30);
  --radius: 6px;
  --mono: 'Cascadia Code', 'JetBrains Mono', 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.hidden { display: none !important; }

/* =====================================================================
   HOST OVERRIDE — the artifact host page defines
   #artifact-root { overflow:auto; padding:12px 16px } which makes the
   whole page a single scroll container. For pr-walkthrough we make it a
   flex column with hidden overflow so inner columns own their scroll.
   (These styles are only injected on pr-walkthrough pages.)
   ===================================================================== */
/* Hide the generic artifact host header (brand + id + type + title + Share).
   The pr-walkthrough .topbar below already shows the title/PR and now carries
   its own Share button, so the host header is pure duplicated chrome. */
body > header { display: none !important; }
#artifact-root {
  display: flex !important;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden !important;
  padding: 0 !important;
}

/* Content row: main content (overview/step) + persistent right rail */
.content-row {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 12px;
  padding: 12px 16px;
  overflow: hidden;
}
.content-main {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* =====================================================================
   SCROLLBARS — thin, theme-matched, overlay-style. Replaces the chunky
   default OS scrollbars on every scroll region in the walkthrough
   (overview, diff body, step list, Q&A rail, etc.).

   Note: in Chromium 121+ setting the standard scrollbar-width/-color
   DISABLES ::-webkit-scrollbar. Since this UI renders in Chromium/Edge,
   we use the richer ::-webkit-scrollbar pill and only fall back to the
   standard properties on engines without it (Firefox).
   (These styles are only injected on pr-walkthrough pages.)
   ===================================================================== */
@supports not selector(::-webkit-scrollbar) {
  * {
    scrollbar-width: thin;
    scrollbar-color: rgba(139, 148, 158, 0.42) transparent;
  }
}
*::-webkit-scrollbar {
  width: 11px;
  height: 11px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: rgba(139, 148, 158, 0.34);
  border-radius: 8px;
  /* Transparent border + padding-box clip makes the thumb read as a slim
     pill with breathing room, GitHub/Sapling-style. */
  border: 3px solid transparent;
  background-clip: padding-box;
  transition: background-color 120ms ease;
}
*::-webkit-scrollbar-thumb:hover {
  background: rgba(139, 148, 158, 0.62);
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:active {
  background: rgba(139, 148, 158, 0.78);
  background-clip: padding-box;
}
*::-webkit-scrollbar-corner {
  background: transparent;
}

/* ============================ TOP BAR ============================ */
.topbar {
  flex: 0 0 auto;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 8px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 48px;
}
.topbar-left { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1; }
.topbar-right { display: flex; align-items: center; gap: 8px; }
#share-artifact.copied { color: var(--add); border-color: var(--add); }

.mode-toggle {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  font-weight: 600; color: var(--text-strong);
}
.mode-toggle:hover { color: var(--accent); }
.mode-toggle .mini { font-weight: normal; }

.pr-badge {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
  background: rgba(88, 166, 255, 0.12);
  padding: 3px 8px;
  border-radius: 12px;
  flex: 0 0 auto;
}
.pr-title {
  font-size: 14px;
  color: var(--text-strong);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.branch-pill {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
  padding: 2px 8px;
  border-radius: 12px;
  max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stat { font-size: 12px; color: var(--text-dim); }
.stat b { color: var(--text-strong); font-weight: 600; }
.add { color: var(--add); font-family: var(--mono); }
.del { color: var(--del); font-family: var(--mono); }
.stat-changes .add { margin-right: 6px; }
.dim { color: var(--text-dim); }
.mini { font-size: 11px; }

/* ============================ BUTTONS ============================ */
button.ghost, button.primary, button.ghost-mini {
  font-family: inherit; font-size: 12px;
  cursor: pointer; border-radius: 4px;
  padding: 5px 12px;
  transition: background 100ms, border-color 100ms, color 100ms;
}
button.ghost {
  background: transparent; color: var(--text); border: 1px solid var(--line-strong);
}
button.ghost:hover { background: var(--panel-2); border-color: var(--accent); color: var(--accent); }
button.ghost-mini {
  background: transparent; border: 0; color: var(--text-dim);
  padding: 2px 6px; font-size: 12px;
}
button.ghost-mini:hover { color: var(--accent); background: var(--panel-2); border-radius: 3px; }
button.primary {
  background: var(--add-strong); color: white; border: 1px solid var(--add-strong);
  font-weight: 600;
}
button.primary:hover:not(:disabled) { background: var(--add); border-color: var(--add); }
button.primary:disabled { background: var(--panel-2); border-color: var(--line); color: var(--text-dim); cursor: not-allowed; }
button.primary.block { display: block; width: 100%; margin-top: 14px; padding: 10px; font-size: 13px; }

/* ============================ CARDS (shared) ============================ */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 12px;
}
.card-head {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 10px;
}
.card-head h2 {
  margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--text-dim); font-weight: 700;
}

/* ============================ OVERVIEW MODE ============================ */
.overview {
  flex: 1; overflow: auto; padding: 16px;
}

/* ---- VERDICT BAR ---- */
.verdict-bar {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 20px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-bottom: 12px;
  max-width: 1400px; margin-left: auto; margin-right: auto;
}
.verdict-bar.verdict-approve { border-color: rgba(86, 211, 100, 0.40); background: linear-gradient(to right, rgba(86, 211, 100, 0.06), var(--panel) 40%); }
.verdict-bar.verdict-changes { border-color: rgba(248, 81, 73, 0.40); background: linear-gradient(to right, rgba(248, 81, 73, 0.06), var(--panel) 40%); }
.verdict-icon { font-size: 32px; flex-shrink: 0; }
.verdict-text { flex: 1; min-width: 0; }
.verdict-line { display: flex; align-items: baseline; gap: 12px; }
.verdict-rec { font-size: 15px; font-weight: 700; color: var(--text-strong); }
.verdict-approve .verdict-rec { color: var(--add); }
.verdict-changes .verdict-rec { color: var(--del); }
.verdict-conf { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.verdict-conf.conf-high { color: var(--add); background: rgba(86, 211, 100, 0.15); border: 1px solid rgba(86, 211, 100, 0.40); }
.verdict-conf.conf-medium { color: var(--warn); background: rgba(240, 164, 92, 0.15); border: 1px solid rgba(240, 164, 92, 0.40); }
.verdict-conf.conf-low { color: var(--crit); background: rgba(255, 123, 114, 0.15); border: 1px solid rgba(255, 123, 114, 0.40); }
.verdict-rationale { margin-top: 4px; color: var(--text); font-size: 13px; line-height: 1.55; }
.verdict-reviewers { margin-top: 4px; }

/* ---- CONFIDENCE DASHBOARD ---- */
.confidence-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  margin-bottom: 12px;
  max-width: 1400px; margin-left: auto; margin-right: auto;
}
.conf-gauge {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px; text-align: left; cursor: pointer; font-family: inherit;
  display: flex; flex-direction: column; gap: 4px;
  transition: border-color 100ms, transform 100ms;
}
.conf-gauge:hover { border-color: var(--accent); transform: translateY(-1px); }
.conf-gauge.grade-good { border-top: 2px solid var(--add); }
.conf-gauge.grade-caution { border-top: 2px solid var(--warn); }
.conf-gauge.grade-warn { border-top: 2px solid var(--warn); }
.conf-gauge.grade-crit { border-top: 2px solid var(--crit); }
.conf-emoji { font-size: 18px; }
.conf-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim); font-weight: 700; }
.conf-headline { font-size: 14px; font-weight: 600; color: var(--text-strong); }
.conf-claim { font-size: 11px; color: var(--text); line-height: 1.45; }
.conf-claim code { font-size: 0.9em; background: var(--panel-3); padding: 0 4px; border-radius: 2px; color: var(--accent); }
.conf-link { margin-top: 2px; font-size: 10px; }

/* ---- TWO-COL GRID ---- */
.overview-grid {
  display: grid;
  grid-template-columns: 1fr 1.1fr;
  gap: 12px;
  max-width: 1400px;
  margin: 0 auto;
}
.overview-col { display: flex; flex-direction: column; min-width: 0; }

.tldr { font-size: 14px; line-height: 1.6; color: var(--text); }
.tldr code { background: var(--panel-3); color: var(--accent); padding: 1px 5px; border-radius: 3px; font-family: var(--mono); font-size: 0.88em; }

/* ---- ATTENTION (What to look at) ---- */
.card.focused { border: 1px solid rgba(88, 166, 255, 0.30); background: linear-gradient(to bottom, rgba(88, 166, 255, 0.04), var(--panel)); }
.attention-list { list-style: none; padding: 0; margin: 0; }
.att-item {
  padding: 10px 12px;
  margin: 0 -10px 8px;
  border-radius: 6px;
  cursor: pointer;
  border-left: 3px solid transparent;
  background: var(--panel-2);
}
.att-item:hover { background: var(--panel-3); }
.att-item.priority-high { border-left-color: var(--crit); }
.att-item.priority-medium { border-left-color: var(--warn); }
.att-item.priority-low { border-left-color: var(--add); }
.att-item.priority-skip { opacity: 0.55; }
.att-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.att-priority { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.att-time { margin-left: auto; font-family: var(--mono); }
.att-step-link { font-size: 12.5px; color: var(--text-strong); font-weight: 500; flex: 1; }
.att-claim { font-size: 12px; line-height: 1.5; color: var(--text); padding-left: 0; }
.att-claim code { background: var(--panel); padding: 0 4px; border-radius: 2px; font-size: 0.9em; color: var(--accent); }

/* ---- DISQUALIFIERS ---- */
.disq-list { list-style: none; padding: 0; margin: 0; }
.disq-item {
  padding: 10px 12px;
  margin: 0 -10px 8px;
  border-radius: 6px;
  background: var(--panel-2);
  border-left: 3px solid transparent;
}
.disq-item.sev-block { border-left-color: var(--crit); }
.disq-item.sev-major { border-left-color: var(--warn); }
.disq-item.sev-minor { border-left-color: var(--text-dim); }
.disq-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; gap: 8px; }
.disq-sev { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text); }
.verified { color: var(--add); font-size: 10.5px; font-weight: 600; }
.unverified { color: var(--warn); font-size: 10.5px; font-weight: 600; }
.disq-text { font-size: 12.5px; color: var(--text-strong); line-height: 1.5; }
.disq-text code { background: var(--panel); padding: 0 4px; border-radius: 2px; font-size: 0.9em; color: var(--accent); }
.disq-check { margin-top: 4px; font-style: italic; }
.disq-check code { font-style: normal; background: var(--panel); padding: 0 3px; border-radius: 2px; color: var(--accent); }

/* ---- FAQ ---- */
.faq-list { display: flex; flex-direction: column; gap: 4px; }
.faq-item {
  background: var(--panel-2);
  border-radius: 6px;
  padding: 0;
  margin: 0;
}
.faq-item summary {
  padding: 9px 12px;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-strong);
  font-weight: 500;
  list-style: none;
  display: flex; align-items: center; gap: 8px;
}
.faq-item summary::before { content: '▸'; color: var(--text-dim); font-size: 10px; flex-shrink: 0; }
.faq-item[open] summary::before { content: '▾'; color: var(--accent); }
.faq-item summary:hover { background: var(--panel-3); border-radius: 6px; }
.faq-q { flex: 1; }
.faq-a {
  padding: 4px 14px 12px 28px;
  font-size: 12px; line-height: 1.6; color: var(--text);
}
.faq-a code { background: var(--panel); color: var(--accent); padding: 0 4px; border-radius: 2px; font-size: 0.9em; }
.faq-anchor {
  margin-left: 28px; margin-bottom: 10px;
  background: transparent; border: 1px solid var(--line-strong);
  color: var(--accent); font-family: inherit; font-size: 11px;
  padding: 3px 9px; border-radius: 10px; cursor: pointer;
}
.faq-anchor:hover { background: var(--panel-3); border-color: var(--accent); }

/* Bullets in overview */
.bullets { list-style: none; padding: 0; margin: 0; }
.bullets li {
  padding: 10px 0;
  border-bottom: 1px dashed var(--line);
  font-size: 13px;
  line-height: 1.55;
}
.bullets li:last-child { border-bottom: 0; padding-bottom: 0; }
.bullets li b {
  display: block; color: var(--text-strong);
  font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em;
  margin-bottom: 4px; font-weight: 700;
}
.bullets li.risk b { color: var(--warn); }
.bullets li.sdp b { color: var(--add); }
.bullets li.sdp { border-left: 2px solid var(--add); padding-left: 8px; margin-left: -10px; padding-right: 0; }
.bullets li code, .why code, .prev-why code, .qa-bubble code {
  background: var(--panel-3); color: var(--accent);
  padding: 1px 5px; border-radius: 3px;
  font-family: var(--mono); font-size: 0.88em;
}
.bullets-compact li { font-size: 12px; padding: 6px 0; }
.bullets-compact li b { font-size: 9.5px; }

/* Architecture */
.arch {
  background: var(--panel-2);
  border-radius: 4px;
  padding: 12px;
  font-size: 11px;
  overflow: auto;
  text-align: center;
}
.arch svg { max-width: 100%; height: auto; }

/* File tree */
.file-tree { list-style: none; padding: 0; margin: 0; }
.file-tree li {
  padding: 8px 10px;
  margin: 0 -10px;
  border-bottom: 1px solid var(--line);
}
.file-tree li:last-child { border-bottom: 0; }
.file-row { display: flex; align-items: center; gap: 8px; }
.file-icon { color: var(--text-dim); font-size: 14px; }
.file-path {
  font-family: var(--mono); font-size: 12px;
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.file-path b { color: var(--text-strong); font-weight: 600; }
.file-stats { font-family: var(--mono); font-size: 11px; }
.file-stats .add { margin-right: 6px; }

.file-steps { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; margin-left: 22px; }
.step-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--panel-2); border: 1px solid var(--line-strong);
  color: var(--text); font-family: inherit; font-size: 11px;
  padding: 3px 8px 3px 4px; border-radius: 12px; cursor: pointer;
  transition: border-color 100ms, color 100ms;
}
.step-chip:hover { border-color: var(--accent); color: var(--accent); }
.step-chip .num {
  background: var(--accent); color: #0a1320;
  width: 16px; height: 16px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 700;
}
.step-chip .t {
  max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Step preview cards (overview) */
.step-preview { list-style: none; padding: 0; margin: 0; counter-reset: step; }
.step-preview li {
  display: grid; grid-template-columns: 36px 1fr;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 100ms;
}
.step-preview li:last-child { border-bottom: 0; }
.step-preview li:hover { background: var(--panel-2); margin: 0 -10px; padding-left: 10px; padding-right: 10px; border-radius: 4px; }
.prev-num {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--accent); color: #0a1320;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
}
.prev-title { color: var(--text-strong); font-size: 13px; font-weight: 600; }
.prev-meta {
  display: flex; align-items: center; gap: 6px;
  margin-top: 4px;
  font-family: var(--mono); font-size: 11px; color: var(--text-dim);
  flex-wrap: wrap;
}
.prev-file { color: var(--accent); }
.prev-why { margin-top: 6px; font-size: 12.5px; line-height: 1.55; color: var(--text); }
.chip {
  font-family: inherit; font-size: 9.5px;
  padding: 1px 6px; border-radius: 8px;
  background: var(--panel-3); color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--line);
}
.chip-logic { color: var(--accent); border-color: rgba(88, 166, 255, 0.30); }
.chip-test { color: var(--add); border-color: rgba(86, 211, 100, 0.30); }
.chip-safety { color: var(--warn); border-color: rgba(240, 164, 92, 0.30); }
.chip-new\ method { color: var(--accent); border-color: rgba(88, 166, 255, 0.30); }
.chip-core\ path { color: var(--warn); border-color: rgba(240, 164, 92, 0.30); }
.chip-3\ data\ rows { color: var(--text-dim); }

/* ============================ STEP MODE ============================ */
.stepmode { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.grid {
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 12px;
  padding: 0;
  overflow: hidden;
}
/* Steps column collapsed → hand its width to the diff (a thin strip remains). */
.grid.steps-collapsed { grid-template-columns: 36px 1fr; }
aside, section.diff-pane {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Left rail in step mode */
.left { padding: 0; }
.left .card { border: 0; border-radius: 0; border-bottom: 1px solid var(--line); margin-bottom: 0; }
.left .card:last-child { border-bottom: 0; }

.steps { list-style: none; padding: 0; margin: 0; }
.steps li {
  display: grid; grid-template-columns: 22px 1fr;
  gap: 8px;
  padding: 8px 10px; margin: 0 -10px;
  border-radius: 4px;
  cursor: pointer;
  align-items: start;
}
.steps li:hover { background: var(--panel-2); }
.steps li.active { background: rgba(88, 166, 255, 0.10); }
.steps li.active .step-num { background: var(--accent); color: #0a1320; }
.step-num {
  width: 22px; height: 22px; border-radius: 50%;
  background: var(--panel-2); color: var(--text-dim);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; flex-shrink: 0;
}
.step-card .t {
  color: var(--text-strong);
  font-size: 12.5px; font-weight: 500;
  line-height: 1.3;
}
.step-card .sub {
  color: var(--text-dim); font-size: 11px;
  font-family: var(--mono);
  margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.step-card .badges { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.step-card .badge {
  font-size: 9.5px; padding: 1px 6px; border-radius: 6px;
  background: var(--panel-2); color: var(--text-dim);
  border: 1px solid var(--line);
}
.step-card .badge.qa { color: var(--accent); border-color: rgba(88, 166, 255, 0.30); }
.step-card .badge.com { color: var(--warn); border-color: rgba(240, 164, 92, 0.30); }

/* ============================ DIFF PANE ============================ */
.diff-pane { padding: 0; }
.step-head {
  padding: 12px 18px; border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  background: var(--panel-2);
  position: sticky; top: 0; z-index: 3;
}
.step-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; flex-wrap: wrap; }
.step-meta .step-n { color: var(--text-dim); }
.step-meta .step-n b { color: var(--text-strong); }
.step-meta .file { font-family: var(--mono); color: var(--accent); cursor: pointer; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-meta .file:hover { text-decoration: underline; }
.step-meta .range { font-family: var(--mono); color: var(--text-dim); font-size: 11px; }
.step-meta .dot { color: var(--text-dim); }
.step-actions { display: flex; gap: 8px; flex-shrink: 0; }

.why {
  padding: 14px 18px;
  background: rgba(88, 166, 255, 0.05);
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  font-style: italic;
}
.why::before { content: '“'; color: var(--accent); font-size: 22px; font-weight: bold; margin-right: 4px; vertical-align: -4px; }
.why::after { content: '”'; color: var(--accent); font-size: 22px; font-weight: bold; margin-left: 4px; vertical-align: -4px; }

/* ---- Collapse controls (steps column + "why" description) ---- */
.card-head-actions { display: flex; align-items: center; gap: 6px; }
.collapse-btn { font-size: 13px; line-height: 1; color: var(--text-dim); }
.why-toggle { display: inline-flex; align-items: center; gap: 4px; }
.why-toggle-caret { display: inline-block; transition: transform 120ms ease; font-size: 10px; }
.diff-pane.why-collapsed .why,
.diff-pane.why-collapsed .step-diagram-wrap { display: none !important; }
.diff-pane.why-collapsed .why-toggle-caret { transform: rotate(-90deg); }

/* ============================ DIFF — the centerpiece ============================ */
.diff-host { flex: 1; overflow: auto; padding: 0; }

.diff-file-header {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 18px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 2;
  font-family: var(--mono); font-size: 12px;
}
.dfh-icon { font-size: 14px; }
.dfh-path { color: var(--text-strong); flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dfh-range { font-size: 11px; }
.dfh-spacer { flex: 1; }

/* Kind badges in file header */
.kind-badge {
  font-family: var(--mono); font-size: 9.5px;
  padding: 2px 7px; border-radius: 8px;
  text-transform: uppercase; letter-spacing: 0.05em;
  font-weight: 700;
}
.kind-badge.new-file { color: var(--add); background: rgba(86, 211, 100, 0.15); border: 1px solid rgba(86, 211, 100, 0.40); }
.kind-badge.batch { color: var(--warn); background: rgba(240, 164, 92, 0.15); border: 1px solid rgba(240, 164, 92, 0.40); }

/* Batch step info block */
.batch-info {
  padding: 10px 18px;
  background: rgba(240, 164, 92, 0.06);
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}
.batch-note { color: var(--text); margin-bottom: 6px; }
.batch-note b { color: var(--text-strong); }
.batch-files {
  list-style: none; padding: 0; margin: 0;
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 2px 14px;
  font-family: var(--mono); font-size: 10.5px; color: var(--text-dim);
}
.batch-files li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.batch-files li.batch-more { color: var(--warn); font-style: italic; }

/* Batch-mention in file tree */
.batch-mention {
  margin-left: 22px; margin-top: 4px;
  font-size: 11px; color: var(--warn);
  font-style: italic;
}

/* New chip variants */
.chip-new { color: var(--add); border-color: rgba(86, 211, 100, 0.30); }
.chip-batch { color: var(--warn); border-color: rgba(240, 164, 92, 0.30); }
.chip-docs { color: #b392f0; border-color: rgba(179, 146, 240, 0.30); }
.chip-flighting { color: var(--warn); border-color: rgba(240, 164, 92, 0.30); }
.chip-public-api { color: var(--accent); border-color: rgba(88, 166, 255, 0.30); }
.chip-rollout { color: var(--warn); border-color: rgba(240, 164, 92, 0.30); }
.chip-regex { color: var(--accent); border-color: rgba(88, 166, 255, 0.30); }
.chip-wiring { color: var(--accent); border-color: rgba(88, 166, 255, 0.30); }
.chip-core { color: var(--crit); border-color: rgba(255, 123, 114, 0.40); }
.chip-config { color: var(--text-dim); }

.diff-body {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
}

.diff-line {
  display: grid;
  grid-template-columns: 26px 52px 52px 18px 1fr;
  align-items: stretch;
  white-space: pre;
  border-left: 3px solid transparent;
}
.diff-line:hover { background: rgba(255, 255, 255, 0.025); }
.diff-line.add {
  background: var(--add-bg);
  border-left-color: rgba(86, 211, 100, 0.50);
}
.diff-line.add:hover { background: rgba(86, 211, 100, 0.16); }
.diff-line.del {
  background: var(--del-bg);
  border-left-color: rgba(248, 81, 73, 0.50);
}
.diff-line.del:hover { background: rgba(248, 81, 73, 0.16); }
.diff-line.ctx .sign { color: transparent; }
.diff-line.ctx .ln-old, .diff-line.ctx .ln-new { color: var(--text-dim); }

.diff-line.commented { box-shadow: inset 0 0 0 1px rgba(240, 164, 92, 0.50); }
.diff-line.commented .line-comment-btn { opacity: 1; color: var(--warn); }

/* 💬 comment button */
.line-comment-btn {
  background: transparent; border: 0; color: var(--text-dim);
  cursor: pointer; padding: 0;
  font-size: 11px; line-height: 1;
  opacity: 0;
  transition: opacity 100ms, color 100ms, transform 100ms;
  align-self: center; justify-self: center;
}
.diff-line:hover .line-comment-btn { opacity: 0.55; }
.line-comment-btn:hover { opacity: 1 !important; color: var(--accent); transform: scale(1.15); }

/* line number gutters */
.ln-old, .ln-new {
  color: var(--text-dim); text-align: right;
  padding: 0 10px;
  user-select: none;
  font-size: 11px;
  align-self: center;
}
.diff-line.add .ln-new { color: var(--add); font-weight: 600; }
.diff-line.del .ln-old { color: var(--del); font-weight: 600; }

/* +/- sign column */
.sign {
  text-align: center;
  user-select: none;
  font-weight: 700;
  color: var(--text-dim);
  align-self: center;
}
.diff-line.add .sign { color: var(--add); }
.diff-line.del .sign { color: var(--del); }

/* content column — the actual code */
.diff-line .content {
  padding: 0 14px 0 6px;
  overflow: hidden;
  align-self: center;
}

/* word-level inline diff highlights */
.word-add {
  background: var(--add-bg-strong);
  border-radius: 2px;
  padding: 1px 1px;
}
.word-del {
  background: var(--del-bg-strong);
  border-radius: 2px;
  padding: 1px 1px;
  text-decoration: line-through;
  text-decoration-color: rgba(248, 81, 73, 0.50);
}

/* Clipped-region marker */
.diff-ellipsis {
  padding: 6px 18px;
  font-family: var(--mono); font-size: 11px;
  color: var(--text-dim);
  background: var(--panel-2);
  border-top: 1px dashed var(--line);
  border-bottom: 1px dashed var(--line);
  text-align: center;
  font-style: italic;
}

/* Hunk separator header (e.g. "@@ -195,7 +198,8 @@") */
.hunk-header {
  padding: 6px 18px;
  font-family: var(--mono); font-size: 11px;
  color: var(--accent);
  background: rgba(88, 166, 255, 0.05);
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

/* Diff loading state */
.diff-loading {
  padding: 20px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  font-style: italic;
}

/* Expand-context button between hunks */
.hunk-expand {
  display: block; width: 100%;
  padding: 6px 18px;
  background: var(--panel-2); border: 0;
  border-top: 1px dashed var(--line);
  border-bottom: 1px dashed var(--line);
  color: var(--text-dim); font-family: var(--mono); font-size: 11px;
  cursor: pointer;
}
.hunk-expand:hover { color: var(--accent); background: var(--panel-3); }

/* ============================ RIGHT RAIL ============================ */
.right {
  padding: 0;
  flex: 0 0 var(--rail-width, 380px);
  min-height: 0;
  overflow: hidden;
  position: relative;
}
/* Drag-to-resize handle on the rail's left edge. Sits at z-index 2 so the
   sticky rail-collapse-bar (z-index 3) stays above it — the collapse chevron
   and tabs remain clickable — while the handle is grabbable down the rest of
   the rail's left edge. A persistent line + grip dots make it visible (not
   hover-only). Width persists in localStorage; double-click resets. */
.rail-resize-handle {
  position: absolute; left: 0; top: 0; bottom: 0; width: 11px;
  cursor: ew-resize; z-index: 2; touch-action: none;
  display: flex; align-items: center; justify-content: flex-start;
}
.rail-resize-handle::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--line); transition: background 120ms ease;
}
.rail-resize-handle::after {
  content: '⋮'; position: relative; left: 1px; color: var(--text-dim);
  font-size: 15px; line-height: 1; opacity: 0.65;
  transition: opacity 120ms ease, color 120ms ease;
}
.rail-resize-handle:hover::before,
body.rail-resizing .rail-resize-handle::before { background: var(--accent); }
.rail-resize-handle:hover::after,
body.rail-resizing .rail-resize-handle::after { opacity: 1; color: var(--accent); }
.content-row.rail-collapsed .rail-resize-handle { display: none; }
/* Track the cursor 1:1 while dragging. */
body.rail-resizing, body.rail-resizing .content-main, body.rail-resizing .right { transition: none !important; }
body.rail-resizing { user-select: none; cursor: ew-resize; }
.rail-tabs {
  display: flex; border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  position: sticky; top: 0; z-index: 2;
}
.rail-tabs .tab {
  flex: 1; padding: 11px;
  background: transparent; border: 0; color: var(--text-dim);
  font-family: inherit; font-size: 12px; font-weight: 600;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  border-bottom: 2px solid transparent;
  transition: color 100ms, border-color 100ms;
}
.rail-tabs .tab:hover { color: var(--text); }
.rail-tabs .tab.active {
  color: var(--text-strong);
  border-bottom-color: var(--accent);
}
.rail-tabs .badge {
  font-size: 10px;
  background: var(--panel);
  color: var(--text-dim);
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--line);
}
.rail-tabs .tab.active .badge { color: var(--accent); border-color: var(--accent); }

.tab-body { padding: 14px; flex: 1; overflow: auto; display: flex; flex-direction: column; }
.tab-body.hidden { display: none; }

/* Q&A scope toggle (This step / All steps) */
.qa-scope {
  display: flex; gap: 2px;
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 6px; padding: 2px; margin-bottom: 10px;
  flex: 0 0 auto;
}
.qa-scope-btn {
  flex: 1; padding: 4px 8px;
  background: transparent; border: 0; border-radius: 4px;
  color: var(--text-dim); font-family: inherit; font-size: 11px; font-weight: 600;
  cursor: pointer; transition: background 100ms, color 100ms;
}
.qa-scope-btn:hover { color: var(--text); }
.qa-scope-btn.active { background: var(--panel-3); color: var(--text-strong); }

/* Step-group header shown in the "All steps" Q&A view */
.qa-group-head {
  display: flex; align-items: center; gap: 8px; width: 100%;
  margin: 10px 0 6px; padding: 5px 8px;
  background: var(--panel-2); border: 1px solid var(--line);
  border-left: 2px solid var(--accent);
  border-radius: 4px;
  color: var(--text); font-family: inherit; text-align: left; cursor: pointer;
}
.qa-group-head:first-child { margin-top: 0; }
.qa-group-head:hover { border-color: var(--accent); background: var(--panel-3); }
.qa-group-head.current { background: rgba(88, 166, 255, 0.10); }
.qa-group-n { font-size: 11px; font-weight: 700; color: var(--text-strong); white-space: nowrap; }
.qa-group-t { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.qa-group-c {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--panel); color: var(--accent);
  border: 1px solid rgba(88, 166, 255, 0.30); flex: 0 0 auto;
}

/* Q&A thread */
.qa-thread { flex: 1; overflow: auto; margin-bottom: 12px; }
.qa-bubble {
  border-radius: 6px;
  padding: 9px 11px;
  margin-bottom: 8px;
  font-size: 12.5px;
  line-height: 1.55;
}
.qa-bubble.q {
  background: var(--panel-2);
  border-left: 2px solid var(--text-dim);
}
.qa-bubble.a {
  background: rgba(88, 166, 255, 0.06);
  border-left: 2px solid var(--accent);
  margin-left: 14px;
}
.qa-bubble .who {
  font-size: 10px; text-transform: uppercase;
  color: var(--text-dim); letter-spacing: 0.05em;
  margin-bottom: 3px; font-weight: 600;
}
.qa-bubble.a .who { color: var(--accent); }
.qa-bubble .ts { color: var(--text-dim); font-size: 10px; font-weight: normal; margin-left: 6px; text-transform: none; letter-spacing: 0; }
.qa-bubble.pending {
  background: rgba(88, 166, 255, 0.04);
  color: var(--text-dim);
  font-style: italic;
}
.qa-bubble.pending::after {
  content: '...';
  display: inline-block;
  animation: dots 1s steps(3, end) infinite;
}
@keyframes dots {
  0%, 20% { content: '.'; }
  40% { content: '..'; }
  60%, 100% { content: '...'; }
}
.qa-empty {
  text-align: center; padding: 24px 12px;
  color: var(--text-dim); font-size: 12px;
}
.qa-empty .ic { font-size: 22px; margin-bottom: 6px; }

.qa-form {
  border-top: 1px solid var(--line); padding-top: 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.qa-form label { font-size: 11px; }
.qa-form textarea {
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  font-family: inherit; font-size: 12.5px;
  resize: vertical;
  min-height: 60px;
}
.qa-form textarea:focus { outline: none; border-color: var(--accent); }
.qa-form-row { display: flex; justify-content: space-between; align-items: center; }

/* Comments tab */
.comments-help {
  padding: 8px 10px; background: var(--panel-2); border-radius: 4px;
  margin-bottom: 12px; font-size: 11px; line-height: 1.55;
}
.kbd {
  font-family: var(--mono); font-size: 10px;
  background: var(--panel); border: 1px solid var(--line);
  padding: 1px 4px; border-radius: 3px;
}
.comments-thread { flex: 1; overflow: auto; }
.comment-card {
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 6px; padding: 10px 12px;
  margin-bottom: 8px;
  font-size: 12.5px;
}
.comment-card .anchor {
  font-family: var(--mono); font-size: 10.5px; color: var(--accent);
  margin-bottom: 4px;
  display: flex; align-items: center; gap: 6px;
}
.comment-card .anchor .side {
  font-weight: 700; padding: 0 4px; border-radius: 2px;
  font-size: 10px;
}
.comment-card .anchor .side.add { color: var(--add); background: var(--add-bg-strong); }
.comment-card .anchor .side.del { color: var(--del); background: var(--del-bg-strong); }
.comment-card .anchor .side.ctx { color: var(--text-dim); }

.comment-card .body { color: var(--text); }
.comment-card .actions { margin-top: 6px; display: flex; gap: 8px; font-size: 11px; }
.comment-card .actions button {
  background: transparent; border: 0; color: var(--text-dim);
  cursor: pointer; padding: 0; font-family: inherit; font-size: 11px;
}
.comment-card .actions button:hover { color: var(--accent); }
.comment-card .actions button.del:hover { color: var(--crit); }
.comment-card.sent { opacity: 1; }
.comment-card .comment-reply {
  margin-top: 8px; padding: 8px 10px; border-radius: 6px;
  background: var(--panel); border: 1px solid var(--line);
  border-left: 2px solid var(--accent);
}
.comment-card .comment-reply .who {
  font-size: 10px; color: var(--accent); font-weight: 600; margin-bottom: 3px;
}
.comment-card .comment-reply .who .ts { color: var(--text-dim); font-weight: 400; margin-left: 6px; }
.comment-card .comment-reply .reply-body { color: var(--text); font-size: 12.5px; line-height: 1.5; }
.comment-card .comment-reply.pending {
  color: var(--text-dim); font-style: italic; font-size: 11.5px;
  border-left-color: var(--text-dim);
}

.comments-empty {
  text-align: center; padding: 24px 12px;
  color: var(--text-dim); font-size: 12px;
}

/* New-comment composer */
.composer {
  background: var(--panel-2); border: 1px solid var(--accent);
  border-radius: 6px; padding: 10px 12px;
  margin-bottom: 12px;
}
.composer .anchor {
  font-family: var(--mono); font-size: 10.5px; color: var(--accent);
  margin-bottom: 6px;
  display: flex; align-items: center; gap: 6px;
}
.composer .anchor .side {
  font-weight: 700; padding: 0 4px; border-radius: 2px;
}
.composer .anchor .side.add { color: var(--add); background: var(--add-bg-strong); }
.composer .anchor .side.del { color: var(--del); background: var(--del-bg-strong); }
.composer textarea {
  width: 100%; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 4px;
  padding: 6px 8px; font-family: inherit; font-size: 12px;
  resize: vertical; min-height: 50px;
}
.composer textarea:focus { outline: none; border-color: var(--accent); }
.composer .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
.composer button { font-size: 11px; padding: 4px 10px; }

/* ============================ TOAST ============================ */
.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--panel); color: var(--text-strong);
  border: 1px solid var(--accent); border-radius: 6px;
  padding: 10px 18px; font-size: 12px;
  box-shadow: var(--shadow);
  z-index: 100;
  animation: toast-in 200ms ease-out;
}
@keyframes toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}

/* ============================ MODAL ============================ */
.modal[hidden] { display: none !important; }
.modal {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 99;
}
.modal-card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 20px 24px;
  width: 95vw; max-width: 95vw; height: 90vh; max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: var(--shadow);
}
.modal-card header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 14px;
}
.modal-card header h2 { margin: 0; font-size: 14px; color: var(--text-strong); }
.arch.big { background: var(--panel-2); padding: 0; border-radius: 4px; overflow: hidden; flex: 1; min-height: 0; cursor: grab; position: relative; }
.arch.big.grabbing { cursor: grabbing; }
.arch.big svg { transform-origin: 0 0; max-height: none; }
.zoom-controls { display: flex; align-items: center; gap: 4px; margin-left: auto; margin-right: 12px; }
.zoom-btn { font-size: 18px !important; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line) !important; border-radius: 4px; }
.zoom-btn:hover { background: var(--panel-2) !important; }
.zoom-level { font-size: 11px; color: var(--text-dim); min-width: 36px; text-align: center; }

/* ============================ RESPONSIVE ============================ */
@media (max-width: 1200px) {
  .grid { grid-template-columns: 260px 1fr; }
  .grid.steps-collapsed { grid-template-columns: 36px 1fr; }
  .overview-grid { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .grid { grid-template-columns: 1fr; grid-template-rows: auto auto auto; }
  aside, section.diff-pane { max-height: 60vh; }
}

/* ============================ COLLAPSIBLE RIGHT RAIL ============================ */
/* Ensure hidden state always wins over our default flex layouts */
.right[hidden], .rail-collapsed-strip[hidden], .left[hidden] { display: none !important; }

.rail-collapse-bar {
  display: flex; align-items: stretch;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 3;
}
.rail-collapse-btn {
  background: transparent; border: 0; cursor: pointer;
  padding: 0 8px;
  color: var(--text-dim);
  font-size: 14px;
  border-right: 1px solid var(--line);
}
.rail-collapse-btn:hover { color: var(--accent); background: var(--panel-3); }
.rail-collapse-bar .rail-tabs {
  flex: 1;
  border-bottom: 0;
  position: static;
}

.rail-collapsed-strip {
  flex: 0 0 36px;
  width: 36px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
  padding: 12px 4px;
  gap: 14px;
  cursor: pointer;
  color: var(--text-dim);
  font-family: inherit;
  margin: 0;
  height: 100%;
}
.rail-collapsed-strip:hover { color: var(--accent); border-color: var(--accent); }
.strip-icon { font-size: 14px; }
.strip-label {
  writing-mode: vertical-rl; transform: rotate(180deg);
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase;
}
.strip-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 8px;
  background: var(--panel-2); color: var(--accent);
  border: 1px solid rgba(88, 166, 255, 0.30);
  min-width: 18px; text-align: center;
}
.strip-divider {
  width: 18px; height: 1px; background: var(--line);
}

/* Rail collapsed: strip replaces the 380px rail in the content row.
   (The rail lives in .content-row now, not inside .grid.) */
.content-row.rail-collapsed .right { display: none; }

/* ============================ STEP DIAGRAM ============================ */
.step-diagram-wrap { position: relative; }
button.diagram-expand-btn {
  position: absolute; top: 8px; right: 10px; z-index: 2;
  background: var(--panel); border: 1px solid var(--line);
  color: var(--text-dim); border-radius: 4px; padding: 2px 7px;
  cursor: pointer; font-size: 13px; line-height: 1;
}
button.diagram-expand-btn:hover { color: var(--accent); border-color: var(--accent); background: var(--panel-3); }
.step-diagram {
  padding: 14px 18px;
  background: var(--panel-2);
  border-bottom: 1px solid var(--line);
  text-align: center;
  overflow: auto;
}
.step-diagram-inner { display: inline-block; max-width: 100%; }
.step-diagram svg { max-width: 100%; height: auto; }
.step-diagram-error { color: var(--crit); font-size: 12px; font-family: var(--mono); }

/* ============================ STEP HEAD — TIME BUDGET ============================ */
.step-meta .time-budget {
  font-family: var(--mono); color: var(--text-dim); font-size: 11px;
}

/* ============================ AGENT-NOTES MODAL ============================ */
.agent-notes-body {
  max-width: 700px;
}
.reviewers-list {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.reviewer-chip {
  background: var(--panel-2); border: 1px solid var(--line-strong);
  padding: 3px 10px; border-radius: 12px;
  font-family: var(--mono); font-size: 11px; color: var(--accent);
}
.agent-notes-list {
  list-style: none; padding: 0; margin: 0;
}
.agent-notes-list li {
  padding: 8px 0 8px 24px;
  position: relative;
  font-size: 12.5px; line-height: 1.55;
  border-bottom: 1px dashed var(--line);
}
.agent-notes-list li:last-child { border-bottom: 0; }
.agent-notes-list li::before {
  content: '✓';
  position: absolute; left: 0; top: 8px;
  color: var(--add); font-weight: 700;
}
.agent-notes-list li code {
  background: var(--panel-2); color: var(--accent);
  padding: 1px 5px; border-radius: 3px;
  font-family: var(--mono); font-size: 0.9em;
}

/* ============================ UNASSIGNED FILES BLOCK ============================ */
.unassigned-block { padding-top: 8px !important; border-top: 1px dashed var(--line); margin-top: 6px; }
.unassigned-block summary { cursor: pointer; padding: 4px 0; }
.unassigned-block summary:hover { color: var(--accent); }
.unassigned-block ul { list-style: none; padding: 0; margin-top: 6px; }

/* ============================ hljs overrides for inline use ============================ */
.diff-body .hljs-keyword, .diff-body .hljs-built_in, .diff-body .hljs-type { color: #ff7b72; }
.diff-body .hljs-string, .diff-body .hljs-attr { color: #a5d6ff; }
.diff-body .hljs-number, .diff-body .hljs-literal { color: #79c0ff; }
.diff-body .hljs-comment, .diff-body .hljs-meta { color: #8b949e; font-style: italic; }
.diff-body .hljs-title, .diff-body .hljs-function { color: #d2a8ff; }
.diff-body .hljs-variable, .diff-body .hljs-params { color: #ffa657; }
.diff-body .hljs-tag, .diff-body .hljs-name { color: #7ee787; }
.diff-body .hljs-string, .diff-body .hljs-attr { color: #a5d6ff; }
.diff-body .hljs-number, .diff-body .hljs-literal { color: #79c0ff; }
.diff-body .hljs-comment, .diff-body .hljs-meta { color: #8b949e; font-style: italic; }
.diff-body .hljs-title, .diff-body .hljs-function { color: #d2a8ff; }
.diff-body .hljs-variable, .diff-body .hljs-params { color: #ffa657; }
.diff-body .hljs-tag, .diff-body .hljs-name { color: #7ee787; }
`;
