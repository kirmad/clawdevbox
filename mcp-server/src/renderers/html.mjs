// renderers/html.mjs — built-in renderer for type="html".
//
// Loads `content.html` (or manifest.meta.entry, falling back to index.html)
// into a container, then enables the comment overlay.
//
// No sanitization: artifact HTML is author-trusted (agent-generated, rendered
// in the author's own viewer). We inject it verbatim so inline <style>, SVG,
// tables, and layout render exactly as authored. (A prior DOMPurify pass ran
// in fragment mode and silently dropped the <head> <style>, breaking themes.)

const STYLES = `
  /* Fill the available width (viewport minus the comment sidebar). The host
     immunizes its <body> from leaked author page-level rules, so content width
     is owned here — no 1240px centered cap, matching the full-width PR walkthrough. */
  .html-body { max-width: none; margin: 0; line-height: 1.6; }
  .html-body img { max-width: 100%; }

  /* Renderer-provided pan/zoom for diagrams (.diagram / .mermaid / [data-zoomable]) */
  .cdb-diagram-zoombtn {
    position: absolute; top: 8px; right: 10px; z-index: 4;
    display: inline-flex; align-items: center; gap: 5px;
    background: #1c1f27; border: 1px solid #2a2e38; color: #8b95a5;
    border-radius: 6px; padding: 3px 9px; font: 12px 'Segoe UI', system-ui, sans-serif;
    cursor: pointer;
  }
  .cdb-diagram-zoombtn:hover { color: #58a6ff; border-color: #58a6ff; }
  .cdb-zoom-overlay { position: fixed; inset: 0; z-index: 2147483000; background: rgba(6,8,12,0.94); display: flex; flex-direction: column; }
  .cdb-zoom-overlay[hidden] { display: none; }
  .cdb-zoom-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #161b22; border-bottom: 1px solid #2a2e38; color: #c9d1d9; font: 12px 'Segoe UI', system-ui, sans-serif; }
  .cdb-zoom-bar button { background: #1c2230; border: 1px solid #2a323e; color: #c9d1d9; border-radius: 6px; min-width: 30px; height: 28px; cursor: pointer; font-size: 14px; line-height: 1; }
  .cdb-zoom-bar button:hover { border-color: #58a6ff; color: #58a6ff; }
  .cdb-zoom-title { font-weight: 600; margin-right: 4px; }
  .cdb-zoom-pct { min-width: 52px; text-align: center; font-family: ui-monospace, Consolas, monospace; color: #8b949e; }
  .cdb-zoom-hint { color: #6e7681; margin-left: 4px; }
  .cdb-zoom-sp { flex: 1; }
  .cdb-zoom-stage { flex: 1; position: relative; overflow: hidden; cursor: grab; touch-action: none; background: #0d1117; }
  /* stage background is overridden per-diagram at open() to match the source */
  .cdb-zoom-stage.cdb-grabbing { cursor: grabbing; }
  .cdb-zoom-stage svg { position: absolute; left: 0; top: 0; max-width: none !important; }
`;

function ensureStyles() {
  if (document.getElementById('html-renderer-styles')) return;
  const el = document.createElement('style');
  el.id = 'html-renderer-styles';
  el.textContent = STYLES;
  document.head.appendChild(el);
}

// Renderer-provided pan/zoom. Author <script> never runs (we inject via
// innerHTML), so we give every diagram a real pan/zoom overlay here — in
// trusted renderer code. A "⤢ zoom" button opens a full-viewport stage where
// the SVG can be dragged to pan and wheel/±-zoomed to any level.
function enableDiagramZoom(container) {
  const boxes = container.querySelectorAll('.diagram, .mermaid, [data-zoomable]');
  const targets = [];
  const seen = new Set();
  for (const box of boxes) {
    const svg = box.querySelector('svg');
    if (svg && !seen.has(svg)) { seen.add(svg); targets.push({ box, svg }); }
  }
  if (!targets.length) return;

  const overlay = document.createElement('div');
  overlay.className = 'cdb-zoom-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="cdb-zoom-bar">
      <span class="cdb-zoom-title">Diagram</span>
      <button data-act="out" title="Zoom out">−</button>
      <span class="cdb-zoom-pct">100%</span>
      <button data-act="in" title="Zoom in">+</button>
      <button data-act="fit" title="Fit / reset">⊙</button>
      <span class="cdb-zoom-hint">scroll to zoom · drag to pan</span>
      <span class="cdb-zoom-sp"></span>
      <button data-act="close" title="Close (Esc)">✕</button>
    </div>
    <div class="cdb-zoom-stage"></div>`;
  document.body.appendChild(overlay);
  const stage = overlay.querySelector('.cdb-zoom-stage');
  const pctEl = overlay.querySelector('.cdb-zoom-pct');
  let scale = 1, panX = 0, panY = 0, drag = null, nat = { w: 1, h: 1 };

  const apply = () => {
    const svg = stage.querySelector('svg');
    if (svg) { svg.style.transformOrigin = '0 0'; svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`; }
    pctEl.textContent = Math.round(scale * 100) + '%';
  };
  const fit = () => {
    const st = stage.getBoundingClientRect();
    const f = Math.min(st.width / nat.w, st.height / nat.h);
    scale = f > 0 && isFinite(f) ? Math.min(f, 1) : 1;
    panX = Math.max(0, (st.width - nat.w * scale) / 2);
    panY = Math.max(0, (st.height - nat.h * scale) / 2);
    apply();
  };
  const zoom = (dir, cx, cy) => {
    const prev = scale;
    scale = Math.min(16, Math.max(0.05, scale * (dir > 0 ? 1.15 : 1 / 1.15)));
    const ratio = scale / prev;
    panX = cx - ratio * (cx - panX);
    panY = cy - ratio * (cy - panY);
    apply();
  };
  const open = (svg, title) => {
    // Mermaid SVGs carry an INTERNAL <style> whose every selector is prefixed
    // with the svg's id (e.g. `#mermaid-abc .cluster rect{fill:…}`). Removing
    // the id kills those rules — cluster/subgraph backgrounds and edge-label
    // styling vanish (nodes keep classDef colors because those are inline).
    // So we RE-ID: rename the id everywhere (scoped <style>, child ids, and
    // url(#..) marker refs) via a single string replace, keeping the clone
    // internally consistent AND distinct from the original in the document.
    const oldId = svg.getAttribute('id') || '';
    let markup = svg.outerHTML;
    if (oldId) markup = markup.split(oldId).join(oldId + '-cdbzoom');
    const vb = svg.viewBox && svg.viewBox.baseVal;
    const r = svg.getBoundingClientRect();
    nat = { w: (vb && vb.width) || r.width || 800, h: (vb && vb.height) || r.height || 500 };
    stage.innerHTML = markup;
    const clone = stage.querySelector('svg');
    clone.style.maxWidth = 'none';
    clone.setAttribute('width', nat.w);
    clone.setAttribute('height', nat.h);
    clone.style.width = nat.w + 'px';
    clone.style.height = nat.h + 'px';
    // Match the stage backdrop to the source diagram so transparent areas of
    // the SVG look identical zoomed vs inline (don't change the styling).
    const host = svg.closest('.diagram, .mermaid, [data-zoomable]');
    const bg = host ? getComputedStyle(host).backgroundColor : '';
    stage.style.background = (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ? bg : '#0d1117';
    overlay.querySelector('.cdb-zoom-title').textContent = title || 'Diagram';
    overlay.hidden = false;
    requestAnimationFrame(fit);
  };
  const close = () => { overlay.hidden = true; stage.innerHTML = ''; };

  overlay.querySelector('[data-act="close"]').addEventListener('click', close);
  overlay.querySelector('[data-act="in"]').addEventListener('click', () => zoom(1, stage.clientWidth / 2, stage.clientHeight / 2));
  overlay.querySelector('[data-act="out"]').addEventListener('click', () => zoom(-1, stage.clientWidth / 2, stage.clientHeight / 2));
  overlay.querySelector('[data-act="fit"]').addEventListener('click', fit);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  stage.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY }; stage.classList.add('cdb-grabbing'); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => { if (!drag) return; panX += e.clientX - drag.x; panY += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; apply(); });
  window.addEventListener('mouseup', () => { drag = null; stage.classList.remove('cdb-grabbing'); });

  for (const { box, svg } of targets) {
    if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cdb-diagram-zoombtn';
    btn.textContent = '⤢ zoom';
    btn.title = 'Open pan & zoom view';
    const title = box.getAttribute('data-title')
      || box.closest('section, div')?.querySelector('h1,h2,h3')?.textContent?.trim()
      || 'Diagram';
    btn.addEventListener('click', () => open(svg, title));
    box.appendChild(btn);
  }
}

// innerHTML never executes <script> elements it inserts. Artifacts are
// author-trusted (agent-generated, rendered in the author's own viewer), so we
// re-create each script so it runs. Scripts run in document order; external
// (src) scripts are awaited so a following inline script sees their globals.
// Non-JS <script> blocks (JSON / templates) are left untouched.
async function executeScripts(container) {
  const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);
  const scripts = Array.from(container.querySelectorAll('script'));
  for (const old of scripts) {
    const type = (old.getAttribute('type') || '').toLowerCase();
    if (!JS_TYPES.has(type)) continue; // leave data/template <script> blocks as-is
    const parent = old.parentNode;
    if (!parent) continue;
    const fresh = document.createElement('script');
    for (const attr of old.attributes) fresh.setAttribute(attr.name, attr.value);
    if (!old.src) fresh.textContent = old.textContent;
    if (old.src) {
      // External: await load/failure so ordering with later scripts holds, but
      // cap the wait so a stuck script can't hang render() (and the comment
      // overlay that mounts after it) forever.
      await new Promise((resolve) => {
        fresh.onload = resolve;
        fresh.onerror = resolve;
        setTimeout(resolve, 10000);
        parent.replaceChild(fresh, old);
      });
    } else {
      parent.replaceChild(fresh, old); // inline runs synchronously on insert
    }
  }
}

export default {
  type: 'html',
  async render(root, ctx) {
    ensureStyles();
    // Resolve the entry file. Authors can pin one via manifest.meta.entry;
    // otherwise we try the common defaults in order (content.html, index.html).
    // Trying candidates in sequence makes the renderer tolerant of artifacts
    // that ship only an index.html (or only a content.html).
    const explicit = ctx.manifest?.meta?.entry;
    const candidates = [];
    for (const name of [explicit, 'content.html', 'index.html']) {
      if (name && !candidates.includes(name)) candidates.push(name);
    }

    let html;
    let loadedFrom;
    const tried = [];
    for (const name of candidates) {
      tried.push(name);
      try {
        html = await ctx.fetchFile(name);
        loadedFrom = name;
        break;
      } catch { /* not present — try the next candidate */ }
    }

    // Last resort: if none of the named candidates exist but the artifact ships
    // exactly one .html file, use it.
    let files = [];
    if (html == null) {
      try { files = await ctx.listFiles(); } catch { /* ignore */ }
      const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
      if (htmlFiles.length === 1) {
        try {
          html = await ctx.fetchFile(htmlFiles[0]);
          loadedFrom = htmlFiles[0];
        } catch { /* fall through to error */ }
      }
    }

    if (html == null) {
      throw new Error(`Failed to load an HTML entry file (tried: ${tried.join(', ') || 'none'}). Files: ${files.join(', ')}.`);
    }

    // Inject the author HTML verbatim (no sanitization — trusted authors).
    // Inserting a full document string via innerHTML keeps <style> from the
    // author's <head>, so themes/layout apply. <script> tags don't run when set
    // via innerHTML, so executeScripts() re-creates them below (first-party JS
    // is allowed — artifacts are agent-generated and self-viewed).
    const body = document.createElement('div');
    body.className = 'html-body';
    body.innerHTML = html;
    root.appendChild(body);

    // Run author scripts (progressive enhancement — content is already visible).
    try { await executeScripts(body); } catch (err) { console.warn('[html renderer] script execution failed:', err); }

    // Attach pan/zoom to any diagrams (non-critical — never block the render).
    try { enableDiagramZoom(body); } catch (err) { console.warn('[html renderer] diagram zoom failed:', err); }
  },
};
