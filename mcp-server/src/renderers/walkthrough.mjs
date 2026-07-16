// renderers/walkthrough.mjs — built-in renderer for type="walkthrough".
//
// Mirrors TaskDock's walkthrough-ui pattern (src/renderer/components/
// walkthrough-ui.ts): the code/diff pane fills the viewport, and the
// step UI is a draggable, resizable floating overlay layered on top.
//
// Data shape (CodeWalkthrough from src/shared/ai-types.ts):
//
//   interface CodeWalkthrough {
//     id; prId; summary;                 // markdown
//     architectureDiagram?;              // mermaid (global)
//     steps: WalkthroughStep[];
//     totalSteps; estimatedReadTime;
//   }
//   interface WalkthroughStep {
//     stepNumber; title; description;    // markdown
//     filePath; startLine; endLine;
//     relatedFiles?: string[];
//     diagram?;                          // mermaid (per-step)
//   }
//
// Expected files in the artifact folder:
//   walkthrough.json
//   files__<safe>.txt   — optional pre-fetched file content, filename is
//                         step.filePath with '/' replaced by '__'. When
//                         present the code pane shows the full file with
//                         the step's range highlighted.
//
// Overlay features:
//   - Default position: bottom-right, 460×520 px
//   - Drag by the header (top bar)
//   - Resize: 8 edge/corner handles
//   - Header buttons: ⌃ minimize, ✕ close (close returns to a "Reopen
//     walkthrough" mini-button in the same corner)
//   - Progress bar
//   - Step dots: click any dot to jump
//   - Body: current step's title + file:line link + description (markdown)
//     + optional per-step mermaid + related-files chips
//   - Footer: ← Prev / Next → and "step N of M"
//   - Keyboard: ←/→ navigate steps when overlay is focused
//   - Architecture diagram available via a "🌐 Overview" header button
//   - Minimized state: collapses to a compact pill (title · step N/M · Prev/Next)
//   - Deep-link: #step=N

import { marked } from 'https://esm.sh/marked@12';
import hljs from 'https://esm.sh/highlight.js@11.10.0';
import mermaid from 'https://esm.sh/mermaid@11.4.0';

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

// ============================================================================
// Styles
// ============================================================================

const STYLES = `
  /* code pane = the canvas underneath everything */
  .wt-fullscreen { position: absolute; inset: 0; display: flex; flex-direction: column; background: #1b1b1b; }
  .wt-fullscreen header.code-bar { padding: 6px 12px; background: #2d2d30; color: #d4d4d4; font-size: 12px; font-family: Consolas, monospace; display: flex; justify-content: space-between; border-bottom: 1px solid #3e3e42; flex: 0 0 auto; }
  .wt-fullscreen header.code-bar .lang { color: #b0b0b0; font-size: 11px; }
  .wt-fullscreen .code-body { overflow: auto; flex: 1; min-height: 0; padding-bottom: 100px; }
  .wt-fullscreen .row { display: grid; grid-template-columns: 56px 1fr; gap: 8px; padding: 0 12px; white-space: pre; line-height: 1.55; font-family: Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; }
  .wt-fullscreen .row .ln { color: #6e6e6e; text-align: right; user-select: none; }
  .wt-fullscreen .row.hl { background: rgba(255, 184, 108, 0.16); }
  .wt-fullscreen .row.hl.start { box-shadow: inset 3px 0 0 #ffb86c; }
  .wt-fullscreen .empty { padding: 32px; color: #888; font-style: italic; text-align: center; }

  /* draggable, resizable overlay */
  .wt-overlay {
    position: fixed; right: 24px; bottom: 24px;
    width: 480px; height: 540px;
    min-width: 340px; min-height: 240px; max-width: 90vw; max-height: 90vh;
    background: #252526; color: #d4d4d4;
    border: 1px solid #4d4d4d; border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    display: flex; flex-direction: column;
    z-index: 10;
  }
  .wt-overlay.dragging { transition: none; }
  .wt-overlay header.wt-head {
    cursor: move; user-select: none;
    background: #2d2d30; border-bottom: 1px solid #3e3e42;
    padding: 6px 8px 6px 12px; display: flex; gap: 8px; align-items: center;
    border-top-left-radius: 8px; border-top-right-radius: 8px;
  }
  .wt-overlay header.wt-head .wt-grip { width: 16px; color: #888; font-size: 12px; cursor: move; }
  .wt-overlay header.wt-head .wt-name { font-weight: 600; color: #fff; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wt-overlay header.wt-head .wt-pill { background: #1b1b1b; border: 1px solid #3e3e42; color: #b0b0b0; font-size: 10px; padding: 1px 6px; border-radius: 8px; }
  .wt-overlay header.wt-head button { background: transparent; border: 0; color: #b0b0b0; font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 3px; line-height: 1; }
  .wt-overlay header.wt-head button:hover { background: #3e3e42; color: #fff; }

  .wt-overlay .wt-progress { height: 3px; background: #3e3e42; }
  .wt-overlay .wt-progress > div { height: 100%; background: #0e639c; transition: width 200ms; }

  .wt-overlay .wt-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; }
  .wt-overlay .wt-crumb { color: #888; font-size: 11px; }
  .wt-overlay .wt-title { font-size: 18px; color: #fff; margin: 4px 0 6px; line-height: 1.25; }
  .wt-overlay .wt-loc { color: #4daafc; font-family: Consolas, monospace; font-size: 12px; cursor: pointer; text-decoration: underline dashed; display: inline-block; }
  .wt-overlay .wt-desc { line-height: 1.55; font-size: 13px; color: #d4d4d4; margin-top: 8px; }
  .wt-overlay .wt-desc p { margin: 0.4em 0; }
  .wt-overlay .wt-desc code { background: #1b1b1b; padding: 1px 5px; border-radius: 3px; font-family: Consolas, monospace; font-size: 0.92em; }
  .wt-overlay .wt-related { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .wt-overlay .wt-related b { color: #b0b0b0; font-size: 11px; margin-right: 4px; }
  .wt-overlay .wt-related .chip { background: #1b1b1b; border: 1px solid #3e3e42; border-radius: 12px; padding: 2px 8px; font-family: Consolas, monospace; font-size: 11px; color: #4daafc; cursor: pointer; }
  .wt-overlay .wt-related .chip:hover { background: #2d2d30; }
  .wt-overlay .wt-mermaid { margin-top: 10px; background: #1b1b1b; border: 1px solid #3e3e42; border-radius: 4px; padding: 8px; }

  .wt-overlay .wt-foot { border-top: 1px solid #3e3e42; padding: 8px 12px; display: flex; gap: 10px; align-items: center; }
  .wt-overlay .wt-foot button.nav { background: #0e639c; color: #fff; border: 0; padding: 5px 12px; border-radius: 3px; font-size: 12px; cursor: pointer; }
  .wt-overlay .wt-foot button.nav:disabled { background: #4d4d4d; cursor: not-allowed; }
  .wt-overlay .wt-foot .wt-counter { color: #b0b0b0; font-size: 12px; }
  .wt-overlay .wt-dots { display: flex; gap: 4px; margin-left: auto; flex-wrap: wrap; max-width: 60%; justify-content: flex-end; }
  .wt-overlay .wt-dots button { width: 18px; height: 18px; border-radius: 50%; background: #3e3e42; border: 0; color: #d4d4d4; font-size: 9px; cursor: pointer; padding: 0; }
  .wt-overlay .wt-dots button.active { background: #0e639c; color: #fff; }

  /* resize handles */
  .wt-overlay .wt-rh { position: absolute; }
  .wt-overlay .wt-rh.n  { top: -3px; left: 6px; right: 6px; height: 6px; cursor: ns-resize; }
  .wt-overlay .wt-rh.s  { bottom: -3px; left: 6px; right: 6px; height: 6px; cursor: ns-resize; }
  .wt-overlay .wt-rh.e  { top: 6px; bottom: 6px; right: -3px; width: 6px; cursor: ew-resize; }
  .wt-overlay .wt-rh.w  { top: 6px; bottom: 6px; left: -3px; width: 6px; cursor: ew-resize; }
  .wt-overlay .wt-rh.ne { top: -3px; right: -3px; width: 10px; height: 10px; cursor: nesw-resize; }
  .wt-overlay .wt-rh.nw { top: -3px; left: -3px; width: 10px; height: 10px; cursor: nwse-resize; }
  .wt-overlay .wt-rh.se { bottom: -3px; right: -3px; width: 10px; height: 10px; cursor: nwse-resize; }
  .wt-overlay .wt-rh.sw { bottom: -3px; left: -3px; width: 10px; height: 10px; cursor: nesw-resize; }

  /* minimized state */
  .wt-mini { position: fixed; right: 24px; bottom: 24px; background: #252526; color: #d4d4d4;
    border: 1px solid #4d4d4d; border-radius: 18px; padding: 6px 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    display: flex; gap: 8px; align-items: center; font-size: 12px; z-index: 10; }
  .wt-mini b { color: #fff; }
  .wt-mini .step-name { color: #b0b0b0; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wt-mini button { background: transparent; border: 0; color: #b0b0b0; cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; }
  .wt-mini button:hover { color: #fff; }
  .wt-mini .step-num { color: #888; font-family: Consolas, monospace; }

  /* overview modal (architecture diagram) */
  .wt-overview-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 20; }
  .wt-overview-card { background: #252526; border: 1px solid #4d4d4d; border-radius: 8px; width: 95vw; max-width: 95vw; height: 90vh; max-height: 90vh; overflow: auto; padding: 18px 22px; display: flex; flex-direction: column; }
  .wt-overview-card header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .wt-overview-card header h2 { margin: 0; font-size: 14px; color: #fff; }
  .wt-overview-card header button { background: transparent; border: 0; color: #b0b0b0; cursor: pointer; font-size: 18px; }
  .wt-overview-card .summary { margin-bottom: 10px; color: #d4d4d4; line-height: 1.55; font-size: 13px; }
  .wt-overview-card .arch { background: #1b1b1b; border: 1px solid #3e3e42; border-radius: 4px; padding: 8px; overflow: hidden; flex: 1; min-height: 0; cursor: grab; }
  .wt-overview-card .arch svg { width: 100%; height: 100%; }
  .wt-zoom-controls { display: flex; align-items: center; gap: 4px; margin-left: auto; margin-right: 12px; }
  .wt-zoom-btn { background: transparent; border: 1px solid #4d4d4d; color: #b0b0b0; cursor: pointer; font-size: 16px; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: 4px; }
  .wt-zoom-btn:hover { background: #3e3e42; color: #fff; }
  .wt-zoom-label { font-size: 11px; color: #888; min-width: 36px; text-align: center; }

  /* hljs theme */
  .hljs { color: #d4d4d4; }
  .hljs-keyword, .hljs-built_in, .hljs-type { color: #c586c0; }
  .hljs-string, .hljs-attr, .hljs-symbol { color: #ce9178; }
  .hljs-number, .hljs-literal { color: #b5cea8; }
  .hljs-comment, .hljs-meta { color: #6a9955; font-style: italic; }
  .hljs-title, .hljs-function, .hljs-section { color: #dcdcaa; }
  .hljs-variable, .hljs-params { color: #9cdcfe; }
  .hljs-tag, .hljs-name { color: #569cd6; }
`;

// ============================================================================
// Helpers
// ============================================================================

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function safeFileName(filePath) {
  return filePath.replace(/[\\/]/g, '__');
}

function langGuess(path) {
  const ext = (path?.split('.').pop() ?? '').toLowerCase();
  if (!ext) return 'plaintext';
  if (hljs.getLanguage(ext)) return ext;
  return 'plaintext';
}

async function renderMermaidInto(into, source, idHint) {
  try {
    const { svg } = await mermaid.render(`wt-mer-${idHint}-${Math.random().toString(36).slice(2)}`, source);
    into.innerHTML = svg;
  } catch (err) {
    into.textContent = `Mermaid render error: ${err?.message ?? err}\n\n${source}`;
    into.style.color = '#f14c4c';
  }
}

function renderCodeRows(text, lang) {
  const lines = String(text).split(/\r?\n/);
  const fullHtml = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  const rows = fullHtml.split(/\r?\n/);
  while (rows.length < lines.length) rows.push('');
  while (rows.length > lines.length) rows.pop();
  return rows.map((html, i) => {
    const lineNum = i + 1;
    return `<div class="row" data-line="${lineNum}"><span class="ln">${lineNum}</span><span class="txt">${html || ' '}</span></div>`;
  }).join('');
}

// ============================================================================
// Renderer
// ============================================================================

export default {
  type: 'walkthrough',
  // Walkthrough ships its own draggable sidebar overlay (.wt-overlay) for
  // step navigation; the universal comment overlay would mount a second
  // sidebar that fights for the same screen real-estate. Opt out — users
  // who want comments on a walkthrough can express them in a sibling
  // markdown artifact.
  comments: false,
  async render(root, ctx) {
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    // The host page sets #artifact-root padding; for the full-screen layout
    // we want the code pane to fill the entire viewport. Reset that here.
    root.style.padding = '0';
    root.style.overflow = 'hidden';
    root.style.position = 'relative';
    root.style.height = '100%';

    const wt = await ctx.fetchFileJson('walkthrough.json');
    const steps = Array.isArray(wt.steps) ? wt.steps : [];
    const filesPresent = new Set(await ctx.listFiles());

    // ---------------- DOM ----------------------------------------------
    const code = document.createElement('div');
    code.className = 'wt-fullscreen';
    code.innerHTML = `
      <header class="code-bar">
        <span id="wt-code-file">—</span>
        <span class="lang" id="wt-code-lang"></span>
      </header>
      <div class="code-body" id="wt-code-body"><div class="empty">Select a step.</div></div>
    `;
    root.appendChild(code);

    const overlay = document.createElement('section');
    overlay.className = 'wt-overlay';
    overlay.tabIndex = 0;
    overlay.innerHTML = `
      <header class="wt-head">
        <span class="wt-grip">⠿</span>
        <span class="wt-name">${escapeHtml(ctx.manifest.title)}</span>
        <span class="wt-pill" id="wt-pill">${steps.length} step${steps.length === 1 ? '' : 's'}${wt.estimatedReadTime ? ` · ~${escapeHtml(String(wt.estimatedReadTime))}m` : ''}</span>
        <button title="Overview (architecture diagram)" id="wt-btn-overview">🌐</button>
        <button title="Minimize" id="wt-btn-min">⌃</button>
        <button title="Close" id="wt-btn-close">✕</button>
      </header>
      <div class="wt-progress"><div id="wt-progress-bar" style="width:0%"></div></div>
      <div class="wt-body" id="wt-body"></div>
      <div class="wt-foot">
        <button class="nav" id="wt-prev">← Prev</button>
        <button class="nav" id="wt-next">Next →</button>
        <span class="wt-counter" id="wt-counter"></span>
        <div class="wt-dots" id="wt-dots"></div>
      </div>
      <div class="wt-rh n"  data-dir="n"></div>
      <div class="wt-rh s"  data-dir="s"></div>
      <div class="wt-rh e"  data-dir="e"></div>
      <div class="wt-rh w"  data-dir="w"></div>
      <div class="wt-rh ne" data-dir="ne"></div>
      <div class="wt-rh nw" data-dir="nw"></div>
      <div class="wt-rh se" data-dir="se"></div>
      <div class="wt-rh sw" data-dir="sw"></div>
    `;
    root.appendChild(overlay);

    // Step dots
    const dotsEl = overlay.querySelector('#wt-dots');
    steps.forEach((_, i) => {
      const b = document.createElement('button');
      b.dataset.idx = String(i);
      b.textContent = String(i + 1);
      b.title = steps[i].title ?? `Step ${i + 1}`;
      dotsEl.appendChild(b);
    });

    // ---------------- State & caches -----------------------------------
    let active = 0;
    const fileTextCache = new Map();

    async function loadFileText(filePath) {
      if (!filePath) return null;
      if (fileTextCache.has(filePath)) return fileTextCache.get(filePath);
      const safe = safeFileName(filePath);
      const candidates = [`files__${safe}.txt`, `files__${safe}`, `${safe}.txt`, `${safe}`];
      for (const c of candidates) {
        if (filesPresent.has(c)) {
          try {
            const text = await ctx.fetchFile(c);
            fileTextCache.set(filePath, text);
            return text;
          } catch { /* try next */ }
        }
      }
      fileTextCache.set(filePath, null);
      return null;
    }

    function highlightLines(start, end) {
      const body = code.querySelector('#wt-code-body');
      for (const row of body.querySelectorAll('.row.hl')) row.classList.remove('hl', 'start');
      if (!start) return;
      const s = Number(start);
      const e = Number(end ?? start);
      let first = null;
      for (let i = s; i <= e; i++) {
        const r = body.querySelector(`.row[data-line="${i}"]`);
        if (!r) continue;
        r.classList.add('hl');
        if (i === s) { r.classList.add('start'); first = r; }
      }
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    async function showFileInPane(filePath, startLine, endLine, codeSnippet) {
      const fileEl = code.querySelector('#wt-code-file');
      const langEl = code.querySelector('#wt-code-lang');
      const body = code.querySelector('#wt-code-body');
      fileEl.textContent = filePath ?? '—';
      const lang = langGuess(filePath);
      langEl.textContent = lang;
      const text = await loadFileText(filePath);
      if (text != null) {
        body.innerHTML = renderCodeRows(text, lang);
        highlightLines(startLine, endLine);
      } else if (codeSnippet) {
        body.innerHTML = renderCodeRows(codeSnippet, lang);
        highlightLines(1, codeSnippet.split(/\r?\n/).length);
      } else {
        body.innerHTML = '<div class="empty">No file content shipped with the artifact for this path.</div>';
      }
    }

    function updateNav() {
      overlay.querySelector('#wt-prev').disabled = active === 0;
      overlay.querySelector('#wt-next').disabled = active === steps.length - 1;
      overlay.querySelector('#wt-counter').textContent = `Step ${active + 1} of ${steps.length}`;
      const pct = steps.length === 1 ? 100 : Math.round(((active + 1) / steps.length) * 100);
      overlay.querySelector('#wt-progress-bar').style.width = `${pct}%`;
      [...dotsEl.children].forEach((b, i) => b.classList.toggle('active', i === active));
    }

    async function show(idx) {
      active = Math.max(0, Math.min(steps.length - 1, idx));
      const s = steps[active];
      if (!s) {
        overlay.querySelector('#wt-body').innerHTML = '<div class="empty">No steps in this walkthrough.</div>';
        updateNav();
        return;
      }
      const range = s.endLine && s.endLine !== s.startLine
        ? `L${s.startLine}-L${s.endLine}` : (s.startLine ? `L${s.startLine}` : '');
      const descHtml = s.description ? marked.parse(String(s.description)) : '';
      const relatedChips = Array.isArray(s.relatedFiles) && s.relatedFiles.length
        ? `<div class="wt-related"><b>Related:</b>${s.relatedFiles.map((f) =>
            `<span class="chip" data-file="${escapeHtml(f)}">${escapeHtml(f)}</span>`,
          ).join('')}</div>` : '';
      overlay.querySelector('#wt-body').innerHTML = `
        <div class="wt-crumb">Step ${s.stepNumber ?? active + 1} of ${steps.length}</div>
        <div class="wt-title">${escapeHtml(s.title ?? '')}</div>
        ${s.filePath
          ? `<a class="wt-loc" data-file="${escapeHtml(s.filePath)}" data-line="${escapeHtml(String(s.startLine ?? ''))}" data-end-line="${escapeHtml(String(s.endLine ?? s.startLine ?? ''))}">${escapeHtml(s.filePath)}${range ? ' · ' + range : ''}</a>`
          : ''}
        <div class="wt-desc">${descHtml}</div>
        ${relatedChips}
        <div class="wt-mermaid" id="wt-step-mermaid" hidden></div>
      `;
      if (s.diagram) {
        const merEl = overlay.querySelector('#wt-step-mermaid');
        merEl.hidden = false;
        await renderMermaidInto(merEl, String(s.diagram), `step-${active}`);
      }
      updateNav();
      await showFileInPane(s.filePath, s.startLine, s.endLine, s.codeSnippet);
      try { history.replaceState(null, '', `#step=${s.stepNumber ?? active + 1}`); } catch {}
    }

    // ---------------- Click handlers -----------------------------------
    overlay.addEventListener('click', async (ev) => {
      const dot = ev.target.closest('.wt-dots button[data-idx]');
      if (dot) { await show(Number(dot.dataset.idx)); return; }
      const loc = ev.target.closest('a.wt-loc[data-file]');
      if (loc) {
        ev.preventDefault();
        await showFileInPane(loc.dataset.file, loc.dataset.line, loc.dataset.endLine);
        return;
      }
      const chip = ev.target.closest('.chip[data-file]');
      if (chip) {
        const file = chip.dataset.file;
        const ownerIdx = steps.findIndex((s) => s.filePath === file);
        if (ownerIdx >= 0) await show(ownerIdx);
        else await showFileInPane(file, null, null, null);
        return;
      }
    });
    overlay.querySelector('#wt-prev').addEventListener('click', () => show(active - 1));
    overlay.querySelector('#wt-next').addEventListener('click', () => show(active + 1));

    // ---------------- Overview modal (architecture diagram) ------------
    let overviewEl = null;
    async function openOverview() {
      if (overviewEl) return;
      overviewEl = document.createElement('div');
      overviewEl.className = 'wt-overview-modal';
      overviewEl.innerHTML = `
        <div class="wt-overview-card">
          <header>
            <h2>${escapeHtml(ctx.manifest.title)} — overview</h2>
            <span class="wt-zoom-controls">
              <button class="wt-zoom-btn" id="wt-zoom-out" title="Zoom out">−</button>
              <button class="wt-zoom-btn" id="wt-zoom-reset" title="Reset">⊙</button>
              <button class="wt-zoom-btn" id="wt-zoom-in" title="Zoom in">+</button>
              <span class="wt-zoom-label" id="wt-zoom-label">100%</span>
            </span>
            <button id="wt-overview-close" title="Close">✕</button>
          </header>
          ${wt.summary ? `<div class="summary">${marked.parse(String(wt.summary))}</div>` : ''}
          ${wt.architectureDiagram ? '<div class="arch"></div>' : '<div class="summary">No architecture diagram.</div>'}
        </div>`;
      document.body.appendChild(overviewEl);
      overviewEl.addEventListener('click', (ev) => {
        if (ev.target === overviewEl || ev.target.id === 'wt-overview-close') closeOverview();
      });
      if (wt.architectureDiagram) {
        const archEl = overviewEl.querySelector('.arch');
        await renderMermaidInto(archEl, String(wt.architectureDiagram), 'arch');
        // Pan + zoom
        let scale = 1, panX = 0, panY = 0, dragging = false, lastX = 0, lastY = 0;
        const label = overviewEl.querySelector('#wt-zoom-label');
        function applyT() {
          const svg = archEl.querySelector('svg');
          if (svg) svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
          svg.style.transformOrigin = '0 0';
          label.textContent = `${Math.round(scale * 100)}%`;
        }
        function resetZ() { scale = 1; panX = 0; panY = 0; applyT(); }
        function doZoom(d, cx, cy) {
          const prev = scale;
          scale = Math.min(10, Math.max(0.1, scale + d));
          const r = scale / prev;
          panX = cx - r * (cx - panX); panY = cy - r * (cy - panY);
          applyT();
        }
        overviewEl.querySelector('#wt-zoom-in').addEventListener('click', () => doZoom(0.2, archEl.clientWidth / 2, archEl.clientHeight / 2));
        overviewEl.querySelector('#wt-zoom-out').addEventListener('click', () => doZoom(-0.2, archEl.clientWidth / 2, archEl.clientHeight / 2));
        overviewEl.querySelector('#wt-zoom-reset').addEventListener('click', resetZ);
        archEl.style.overflow = 'hidden';
        archEl.style.cursor = 'grab';
        archEl.addEventListener('wheel', (e) => {
          e.preventDefault();
          const rect = archEl.getBoundingClientRect();
          doZoom(e.deltaY < 0 ? 0.15 : -0.15, e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });
        archEl.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; archEl.style.cursor = 'grabbing'; });
        window.addEventListener('mousemove', (e) => { if (!dragging) return; panX += e.clientX - lastX; panY += e.clientY - lastY; lastX = e.clientX; lastY = e.clientY; applyT(); });
        window.addEventListener('mouseup', () => { dragging = false; archEl.style.cursor = 'grab'; });
      }
    }
    function closeOverview() {
      if (overviewEl) { overviewEl.remove(); overviewEl = null; }
    }
    overlay.querySelector('#wt-btn-overview').addEventListener('click', openOverview);

    // ---------------- Minimize / close ---------------------------------
    let miniEl = null;
    function minimize() {
      overlay.style.display = 'none';
      miniEl = document.createElement('div');
      miniEl.className = 'wt-mini';
      miniEl.innerHTML = `
        <b>${escapeHtml(ctx.manifest.title)}</b>
        <span class="step-name" id="mini-step">${escapeHtml(steps[active]?.title ?? '')}</span>
        <span class="step-num" id="mini-counter">${active + 1}/${steps.length}</span>
        <button id="mini-prev" title="Prev">◀</button>
        <button id="mini-next" title="Next">▶</button>
        <button id="mini-restore" title="Restore">⌄</button>
      `;
      document.body.appendChild(miniEl);
      miniEl.querySelector('#mini-prev').addEventListener('click', () => show(active - 1).then(syncMini));
      miniEl.querySelector('#mini-next').addEventListener('click', () => show(active + 1).then(syncMini));
      miniEl.querySelector('#mini-restore').addEventListener('click', restore);
    }
    function syncMini() {
      if (!miniEl) return;
      miniEl.querySelector('#mini-step').textContent = steps[active]?.title ?? '';
      miniEl.querySelector('#mini-counter').textContent = `${active + 1}/${steps.length}`;
    }
    function restore() {
      if (miniEl) { miniEl.remove(); miniEl = null; }
      overlay.style.display = '';
    }
    overlay.querySelector('#wt-btn-min').addEventListener('click', minimize);
    overlay.querySelector('#wt-btn-close').addEventListener('click', () => {
      overlay.style.display = 'none';
      // close gives the same affordance as minimize so the user can recover.
      if (!miniEl) minimize();
    });

    // ---------------- Drag (head) -------------------------------------
    const head = overlay.querySelector('header.wt-head');
    let dragOffset = null;
    head.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('button')) return;
      const r = overlay.getBoundingClientRect();
      dragOffset = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
      overlay.classList.add('dragging');
      overlay.style.right = 'auto';
      overlay.style.bottom = 'auto';
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragOffset) return;
      const x = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dragOffset.dx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dragOffset.dy));
      overlay.style.left = `${x}px`;
      overlay.style.top = `${y}px`;
    });
    window.addEventListener('mouseup', () => {
      if (dragOffset) { dragOffset = null; overlay.classList.remove('dragging'); }
    });

    // ---------------- Resize handles ----------------------------------
    let resize = null;
    overlay.querySelectorAll('.wt-rh').forEach((h) => {
      h.addEventListener('mousedown', (ev) => {
        const r = overlay.getBoundingClientRect();
        resize = { dir: h.dataset.dir, startX: ev.clientX, startY: ev.clientY,
          left: r.left, top: r.top, width: r.width, height: r.height };
        overlay.style.right = 'auto'; overlay.style.bottom = 'auto';
        overlay.style.left = `${r.left}px`; overlay.style.top = `${r.top}px`;
        overlay.classList.add('dragging');
        ev.preventDefault();
      });
    });
    window.addEventListener('mousemove', (ev) => {
      if (!resize) return;
      const dx = ev.clientX - resize.startX;
      const dy = ev.clientY - resize.startY;
      const min = { w: 340, h: 240 };
      let { left, top, width, height } = resize;
      if (resize.dir.includes('e')) width = Math.max(min.w, resize.width + dx);
      if (resize.dir.includes('s')) height = Math.max(min.h, resize.height + dy);
      if (resize.dir.includes('w')) { width = Math.max(min.w, resize.width - dx); left = resize.left + (resize.width - width); }
      if (resize.dir.includes('n')) { height = Math.max(min.h, resize.height - dy); top = resize.top + (resize.height - height); }
      overlay.style.left = `${left}px`;
      overlay.style.top = `${top}px`;
      overlay.style.width = `${width}px`;
      overlay.style.height = `${height}px`;
    });
    window.addEventListener('mouseup', () => {
      if (resize) { resize = null; overlay.classList.remove('dragging'); }
    });

    // ---------------- Keyboard ----------------------------------------
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' && active > 0) { ev.preventDefault(); show(active - 1); }
      else if (ev.key === 'ArrowRight' && active < steps.length - 1) { ev.preventDefault(); show(active + 1); }
      else if (ev.key === 'Escape' && overviewEl) closeOverview();
    });

    // ---------------- Initial ------------------------------------------
    const frag = (location.hash || '').match(/step=(\d+)/);
    const initial = frag ? Math.max(1, Math.min(steps.length, Number(frag[1]))) - 1 : 0;
    if (steps.length) await show(initial);
    overlay.focus({ preventScroll: true });

    // Public API for Playwright + future embedders.
    window.__clawdevboxWalkthrough = {
      totalSteps: steps.length,
      goto: show,
      currentStep: () => active + 1,
      minimize, restore,
      openOverview, closeOverview,
    };
  },
};
