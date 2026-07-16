// comment-overlay.mjs — the artifact-comments library.
//
// Single export: enableComments(root, ctx)
//
// Adds three commenting affordances to whatever DOM `root` already contains:
//   1. Text-selection comments        — select text → 💬 toolbar → sidebar card
//   2. Element-click comments         — hover img / mermaid / pre → click → snapshot
//   3. Region screenshot comments     — Alt+drag a rectangle → screenshot
//
// Drafts persist via the generic JSON store at /api/store/artifact-comments/<artifactId>.
// PNG attachments persist via the same store at /api/store/artifact-comment-attachments/<id>.
// "Send" posts a markdown bundle to the parent frame via postMessage; the parent
// performs the real session.send.
//
// This file is intentionally framework-free — vanilla DOM + fetch only — so it
// can drop into the artifact iframe with zero build step.

import html2canvas from 'https://esm.sh/html2canvas@1.4.1';

// =============================================================================
// Public entry point
// =============================================================================

export async function enableComments(root, ctx) {
  const overlay = new CommentOverlay(root, ctx);
  await overlay.init();
  return overlay;  // for tests / debugging
}

// =============================================================================
// Constants & helpers
// =============================================================================

const DRAFTS_COLLECTION = 'artifact-comments';
const ATTACH_COLLECTION = 'artifact-comment-attachments';
const HISTORY_COLLECTION = 'artifact-comment-history';
const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 400;

const COMMENTABLE_SELECTOR = 'img, .mermaid-rendered, pre.hljs';

const mintId = (prefix) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

const escapeHtml = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function sha1Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-1', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// =============================================================================
// Styles — one stylesheet for the whole overlay
// =============================================================================

const OVERLAY_STYLES = `
:root {
  --cdb-accent: #ffb86c;
  --cdb-accent-bg: rgba(255, 184, 108, 0.22);
  --cdb-blue: #2563eb;
  --cdb-card: #22252b;
  --cdb-card-edge: #3e3e42;
  --cdb-sidebar-bg: #1b1d22;
  --cdb-text: #e6e6e6;
  --cdb-muted: #8b949e;
}

/* Make room for the sidebar without clobbering the renderer's own width */
body.cdb-has-sidebar { margin-right: 340px; transition: margin-right 180ms ease; }
body.cdb-sidebar-collapsed { margin-right: 36px; }

/* Anchored highlight on a text-selection comment */
.cdb-comment-anchor {
  background: var(--cdb-accent-bg);
  border-bottom: 2px solid var(--cdb-accent);
  cursor: pointer;
  border-radius: 2px;
}
.cdb-comment-anchor.cdb-focus { box-shadow: 0 0 0 2px var(--cdb-blue); }

/* Element-click hover outline */
.cdb-hover-target {
  outline: 2px dashed var(--cdb-accent) !important;
  outline-offset: 3px;
  cursor: pointer;
}
.cdb-elem-anchored {
  position: relative;
  outline: 2px solid var(--cdb-accent) !important;
  outline-offset: 3px;
}
.cdb-elem-anchored::after {
  content: '💬';
  position: absolute; top: -10px; right: -10px;
  background: var(--cdb-accent); color: #15171d;
  border-radius: 10px; padding: 0 5px; font-size: 11px;
}

/* Floating selection toolbar */
.cdb-toolbar {
  position: absolute;
  z-index: 9999;
  background: var(--cdb-card);
  border: 1px solid #4d5664;
  border-radius: 6px;
  padding: 6px 10px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  display: flex; gap: 8px; align-items: center;
  font: 11px 'Segoe UI', system-ui, sans-serif; color: var(--cdb-text);
  cursor: pointer; user-select: none;
}
.cdb-toolbar .shortcut { opacity: 0.5; font-size: 10px; }

/* Rectangle drag selection (when Alt is held) */
.cdb-rect-layer {
  position: fixed; inset: 0; z-index: 9998;
  background: rgba(0, 0, 0, 0); cursor: crosshair;
}
.cdb-rect-box {
  position: absolute;
  background: rgba(37, 99, 235, 0.18);
  border: 1.5px dashed #2563eb;
}

/* Sidebar */
.cdb-sidebar {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: 340px; background: var(--cdb-sidebar-bg);
  border-left: 1px solid #2d3138;
  display: flex; flex-direction: column;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: var(--cdb-text);
  z-index: 9997; transition: transform 180ms ease;
}
.cdb-sidebar.cdb-collapsed { transform: translateX(304px); }
.cdb-sidebar header {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 12px; border-bottom: 1px solid #2d3138;
  font-weight: 600; color: #fff;
}
.cdb-sidebar header .grow { flex: 1; }
.cdb-sidebar header button {
  background: transparent; border: 1px solid #3e3e42; color: var(--cdb-muted);
  padding: 3px 7px; border-radius: 3px; font-size: 10px; cursor: pointer;
}
.cdb-sidebar header button.primary {
  background: var(--cdb-blue); border-color: var(--cdb-blue);
  color: #fff; font-weight: 600; padding: 3px 10px;
}
.cdb-sidebar header button.primary:disabled {
  background: #2a2d33; border-color: #3e3e42; color: var(--cdb-muted);
  cursor: not-allowed;
}
.cdb-sidebar .toggle {
  position: absolute; left: -28px; top: 10px;
  width: 28px; height: 32px; line-height: 32px; text-align: center;
  background: var(--cdb-sidebar-bg); border: 1px solid #2d3138; border-right: 0;
  border-radius: 4px 0 0 4px; cursor: pointer; color: var(--cdb-muted);
}
.cdb-cards { flex: 1; overflow-y: auto; padding: 8px; }
.cdb-cards .empty { color: var(--cdb-muted); font-style: italic; padding: 20px 4px; text-align: center; }
.cdb-card {
  background: var(--cdb-card); border: 1px solid var(--cdb-card-edge);
  border-left: 3px solid var(--cdb-accent);
  border-radius: 4px; padding: 8px 10px; margin-bottom: 8px;
  cursor: pointer;
}
.cdb-card.cdb-focus { background: #1b3a52; border-color: var(--cdb-blue); }
.cdb-card.cdb-orphan { border-left-color: #f14c4c; opacity: 0.85; }
.cdb-card .meta { font-size: 10px; color: var(--cdb-muted); margin-bottom: 4px; }
.cdb-card .orphan-badge { color: #f14c4c; }
.cdb-card .body { font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
.cdb-card .thumb {
  display: block; max-width: 100%; max-height: 120px; margin-bottom: 6px;
  border: 1px solid #3e3e42; border-radius: 3px;
}
.cdb-card textarea {
  width: 100%; background: #0e1117; color: var(--cdb-text);
  border: 1px solid #4d5664; border-radius: 3px; padding: 6px;
  font: inherit; font-size: 11px; resize: vertical; min-height: 48px; box-sizing: border-box;
}
.cdb-card .row {
  display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end;
}
.cdb-card .row button {
  background: transparent; border: 0; color: var(--cdb-muted);
  font-size: 10px; cursor: pointer; padding: 2px 6px;
}
.cdb-card .row button.primary {
  background: var(--cdb-blue); color: #fff; font-weight: 600;
  padding: 3px 10px; border-radius: 3px;
}
.cdb-card .row button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.cdb-sidebar footer {
  padding: 6px 12px; border-top: 1px solid #2d3138;
  font-size: 10px; color: var(--cdb-muted);
}
`;

// =============================================================================
// CommentOverlay
// =============================================================================

class CommentOverlay {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.artifactId = ctx.artifactId ?? ctx.manifest?.id ?? 'unknown';
    this.drafts = [];                  // Comment[]
    this.draftsById = new Map();
    this.activeCardId = null;
    this.activeAnchorEl = null;
    this.sidebarCollapsed = false;
    this.persistDebounced = debounce(() => this.persist().catch(console.error), SAVE_DEBOUNCE_MS);
  }

  async init() {
    this.injectStyles();
    this.buildSidebar();
    document.body.classList.add('cdb-has-sidebar');

    await this.loadDrafts();
    await this.renderHighlights();
    this.renderCards();

    this.wireSelectionToolbar();
    this.wireElementHover();
    this.wireRectangleDrag();
    this.wireKeyboard();

    // Tell the host that drafts changed (refreshes store-listing panel)
    this.notifyHost('artifact:drafts-changed', { artifactId: this.artifactId });
  }

  injectStyles() {
    if (document.getElementById('cdb-overlay-styles')) return;
    const el = document.createElement('style');
    el.id = 'cdb-overlay-styles';
    el.textContent = OVERLAY_STYLES;
    document.head.appendChild(el);
  }

  // ---------------------------------------------------------------------------
  // Storage round-trips
  // ---------------------------------------------------------------------------

  async loadDrafts() {
    try {
      const r = await fetch(`/api/store/${DRAFTS_COLLECTION}/${this.artifactId}`);
      if (r.status === 404) { this.drafts = []; this.indexDrafts(); return; }
      if (!r.ok) throw new Error('load failed: ' + r.status);
      const doc = await r.json();
      this.drafts = Array.isArray(doc.drafts) ? doc.drafts : [];
      this.indexDrafts();
    } catch (err) {
      console.warn('[cdb] loadDrafts failed', err);
      this.drafts = []; this.indexDrafts();
    }
  }

  indexDrafts() {
    this.draftsById = new Map(this.drafts.map(d => [d.id, d]));
  }

  async persist() {
    const doc = {
      schema_version: SCHEMA_VERSION,
      artifact_id: this.artifactId,
      updated_at: new Date().toISOString(),
      drafts: this.drafts,
    };
    try {
      await fetch(`/api/store/${DRAFTS_COLLECTION}/${this.artifactId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      this.notifyHost('artifact:drafts-changed', { artifactId: this.artifactId });
    } catch (err) {
      console.warn('[cdb] persist failed', err);
    }
  }

  async uploadAttachment(blob) {
    const id = mintId('att');
    await fetch(`/api/store/${ATTACH_COLLECTION}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    });
    return {
      id,
      // Use a workspace-relative-ish path for the bundle. In the real impl
      // this will be resolved against the workspace root server-side.
      path: `.store/${ATTACH_COLLECTION}/${id}.${(blob.type || 'image/png') === 'image/png' ? 'png' : 'bin'}`,
    };
  }

  notifyHost(type, payload) {
    try { window.parent.postMessage({ type, payload }, location.origin); }
    catch { /* host not present (standalone open) */ }
  }

  // ---------------------------------------------------------------------------
  // Anchors — text fingerprinting + re-anchoring
  // ---------------------------------------------------------------------------

  nearestHeading(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== this.root) {
      let prev = el.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/i.test(prev.tagName)) return prev.textContent.trim();
        prev = prev.previousElementSibling;
      }
      el = el.parentElement;
    }
    return '';
  }

  async makeTextAnchor(range) {
    const text = range.toString();
    if (!text.trim()) return null;
    const section = this.nearestHeading(range.startContainer);
    const fingerprint = 'sha1:' + await sha1Hex(section + '\u0000' + text);

    // occurrence = how many earlier identical (section, text) matches exist
    const sectionMatches = this.countSectionTextMatches(section, text);
    const occurrence = sectionMatches.indexOfRange(range);

    return { kind: 'text', section, text, fingerprint, occurrence };
  }

  // For occurrence accounting we need a positional walk inside the section.
  countSectionTextMatches(section, text) {
    // Walk the root; for each text node, find all start-index occurrences of `text`.
    // Track occurrences inside the right section only.
    const results = [];  // [{node, startOffset}]
    const matchesInSection = [];
    let currentSection = '';
    const root = this.root;

    function walk(el) {
      for (const child of el.childNodes) {
        if (child.nodeType === 1 && /^H[1-6]$/i.test(child.tagName)) {
          currentSection = child.textContent.trim();
        }
        if (child.nodeType === 3 && currentSection === section) {
          const t = child.nodeValue;
          let i = 0;
          while ((i = t.indexOf(text, i)) !== -1) {
            matchesInSection.push({ node: child, startOffset: i });
            i += text.length;
          }
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    }
    walk(root);

    return {
      list: matchesInSection,
      indexOfRange(range) {
        const startNode = range.startContainer;
        const startOffset = range.startOffset;
        const idx = matchesInSection.findIndex(m =>
          m.node === startNode && m.startOffset === startOffset);
        return idx === -1 ? 0 : idx;
      },
    };
  }

  async renderHighlights() {
    // For every TEXT anchor draft, find the right text position and wrap it.
    for (const d of this.drafts) {
      if (d.anchor?.kind !== 'text') continue;
      const ok = this.applyTextHighlight(d);
      d.orphan = !ok;
    }
  }

  applyTextHighlight(draft) {
    const { section, text, occurrence = 0 } = draft.anchor;
    const matches = this.countSectionTextMatches(section, text);
    const target = matches.list[occurrence] ?? matches.list[0];
    if (!target) return false;
    const range = document.createRange();
    range.setStart(target.node, target.startOffset);
    range.setEnd(target.node, target.startOffset + text.length);
    const span = document.createElement('span');
    span.className = 'cdb-comment-anchor';
    span.dataset.commentId = draft.id;
    try { range.surroundContents(span); }
    catch { return false; }
    span.addEventListener('click', (e) => { e.stopPropagation(); this.focusCard(draft.id, true); });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Sidebar UI
  // ---------------------------------------------------------------------------

  buildSidebar() {
    const aside = document.createElement('aside');
    aside.className = 'cdb-sidebar';
    aside.innerHTML = `
      <div class="toggle" title="Show/hide comments">›</div>
      <header>
        <span class="grow">Comments (<span class="cdb-count">0</span>)</span>
        <button class="clear">Clear</button>
        <button class="send primary" disabled>Send (0) →</button>
      </header>
      <div class="cdb-cards"></div>
      <footer>Drafts auto-save to <code>${DRAFTS_COLLECTION}/${escapeHtml(this.artifactId)}</code></footer>
    `;
    document.body.appendChild(aside);
    this.sidebar = aside;
    this.cardsHost = aside.querySelector('.cdb-cards');
    this.countEl = aside.querySelector('.cdb-count');
    this.sendBtn = aside.querySelector('.send');
    this.clearBtn = aside.querySelector('.clear');
    this.toggleBtn = aside.querySelector('.toggle');

    this.sendBtn.addEventListener('click', () => this.sendAll());
    this.clearBtn.addEventListener('click', () => this.clearAll());
    this.toggleBtn.addEventListener('click', () => this.toggleSidebar());
  }

  toggleSidebar(force) {
    this.sidebarCollapsed = force ?? !this.sidebarCollapsed;
    this.sidebar.classList.toggle('cdb-collapsed', this.sidebarCollapsed);
    document.body.classList.toggle('cdb-sidebar-collapsed', this.sidebarCollapsed);
    this.toggleBtn.textContent = this.sidebarCollapsed ? '‹' : '›';
  }

  renderCards() {
    this.countEl.textContent = String(this.drafts.length);
    this.sendBtn.textContent = `Send (${this.drafts.length}) →`;
    this.sendBtn.disabled = this.drafts.length === 0;

    if (this.drafts.length === 0) {
      this.cardsHost.innerHTML = `<div class="empty">No comments yet. Select text in the artifact, click an image, or Alt-drag a region.</div>`;
      return;
    }
    this.cardsHost.innerHTML = '';
    for (const d of this.drafts) this.cardsHost.appendChild(this.renderCard(d));
  }

  renderCard(d) {
    const card = document.createElement('div');
    card.className = 'cdb-card';
    if (d.id === this.activeCardId) card.classList.add('cdb-focus');
    if (d.orphan) card.classList.add('cdb-orphan');
    card.dataset.commentId = d.id;

    const orphanBadge = d.orphan ? `<span class="orphan-badge">🔗❌</span> ` : '';
    const sectionLabel = d.anchor.section || '(no section)';

    const anchorLabel = d.anchor.kind === 'text'
      ? `§ ${escapeHtml(sectionLabel)} · "${escapeHtml(d.anchor.text.slice(0, 60))}${d.anchor.text.length > 60 ? '…' : ''}"`
      : `§ ${escapeHtml(sectionLabel)} · ${escapeHtml(d.anchor.element)} snapshot`;

    const thumb = d.anchor.kind === 'image' && d.anchor.attachment_id
      ? `<img class="thumb" src="/api/store/${ATTACH_COLLECTION}/${d.anchor.attachment_id}" alt="snapshot">`
      : '';

    const isEditing = d.id === this.editingCardId;
    const bodyHtml = isEditing
      ? `<textarea autofocus>${escapeHtml(d.comment ?? '')}</textarea>`
      : `<div class="body">${escapeHtml(d.comment || '(empty — click to write)')}</div>`;

    const actions = isEditing
      ? `<button class="cancel">Cancel</button>
         <button class="save primary" ${(d.comment ?? '').trim() ? '' : 'disabled'}>Save</button>`
      : `<button class="edit">edit</button><button class="delete">delete</button>`;

    card.innerHTML = `
      <div class="meta">${orphanBadge}${anchorLabel}</div>
      ${thumb}
      ${bodyHtml}
      <div class="row">${actions}</div>
    `;

    // Card behaviors
    card.addEventListener('click', (e) => {
      // Don't override button clicks inside the card
      if (e.target.closest('button, textarea')) return;
      this.focusCard(d.id, true);
    });
    const edit = card.querySelector('.edit');
    const del = card.querySelector('.delete');
    const save = card.querySelector('.save');
    const cancel = card.querySelector('.cancel');
    const ta = card.querySelector('textarea');

    edit?.addEventListener('click', () => this.startEditing(d.id));
    del?.addEventListener('click', () => this.deleteDraft(d.id));
    cancel?.addEventListener('click', () => this.stopEditing(false));
    save?.addEventListener('click', () => this.stopEditing(true));
    if (ta) {
      ta.addEventListener('input', () => {
        save.disabled = !ta.value.trim();
      });
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); this.stopEditing(true); }
        if (e.key === 'Escape') { e.preventDefault(); this.stopEditing(false); }
      });
    }

    return card;
  }

  // ---------------------------------------------------------------------------
  // Draft lifecycle (add / edit / delete / send / clear)
  // ---------------------------------------------------------------------------

  async addDraft(anchor) {
    const draft = {
      id: mintId('c'),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      anchor,
      comment: '',
    };
    this.drafts.push(draft);
    this.draftsById.set(draft.id, draft);

    if (anchor.kind === 'text') this.applyTextHighlight(draft);
    // Element anchors get a permanent outline via cdb-elem-anchored
    if (anchor.kind === 'image' && anchor.element_ref) {
      anchor.element_ref.classList.add('cdb-elem-anchored');
    }

    this.activeCardId = draft.id;
    this.editingCardId = draft.id;
    this.toggleSidebar(false);
    this.renderCards();
    this.persistDebounced();
  }

  startEditing(id) {
    this.editingCardId = id;
    this.activeCardId = id;
    this.renderCards();
  }

  stopEditing(save) {
    const id = this.editingCardId;
    if (!id) return;
    const d = this.draftsById.get(id);
    if (!d) { this.editingCardId = null; this.renderCards(); return; }
    if (save) {
      const card = this.cardsHost.querySelector(`[data-comment-id="${id}"]`);
      const ta = card?.querySelector('textarea');
      const v = ta?.value.trim();
      if (!v) return;  // disabled save shouldn't reach here, but be safe
      d.comment = v;
      d.updated_at = new Date().toISOString();
      this.persistDebounced();
    } else {
      // If we cancelled on a brand-new empty comment, drop it
      if (!d.comment) this._removeDraft(id);
    }
    this.editingCardId = null;
    this.renderCards();
  }

  deleteDraft(id) {
    this._removeDraft(id);
    this.persistDebounced();
    this.renderCards();
  }

  _removeDraft(id) {
    const idx = this.drafts.findIndex(d => d.id === id);
    if (idx === -1) return;
    const [removed] = this.drafts.splice(idx, 1);
    this.draftsById.delete(id);
    // Remove DOM marker
    const span = this.root.querySelector(`.cdb-comment-anchor[data-comment-id="${id}"]`);
    if (span) {
      // unwrap
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    }
    if (removed?.anchor?.kind === 'image' && removed.anchor.element_ref) {
      removed.anchor.element_ref.classList.remove('cdb-elem-anchored');
    }
  }

  async clearAll() {
    if (!this.drafts.length) return;
    if (!confirm(`Discard ${this.drafts.length} draft comment${this.drafts.length === 1 ? '' : 's'}?`)) return;
    [...this.drafts].forEach(d => this._removeDraft(d.id));
    await this.persist();
    this.renderCards();
  }

  buildMarkdownBundle() {
    const title = this.ctx.manifest?.title ?? this.artifactId;
    const lines = [];
    lines.push(`Review of artifact **${title}** (\`${this.artifactId}\`):\n`);
    this.drafts.forEach((d, i) => {
      const n = i + 1;
      const section = d.anchor.section || '(no section)';
      const orphan = d.orphan ? ' — orphan' : '';
      if (d.anchor.kind === 'text') {
        lines.push(`— Comment ${n} (on §"${section}"${orphan}):`);
        lines.push(`> ${d.comment.split('\n').join('\n> ')}\n`);
        lines.push(`> "${d.anchor.text}"\n`);
      } else {
        const what = d.anchor.element === 'region' ? 'region' : `${d.anchor.element} snapshot`;
        lines.push(`— Comment ${n} (on ${what} in §"${section}"${orphan}):`);
        lines.push(`> ${d.comment.split('\n').join('\n> ')}\n`);
        if (d.anchor.attachment_path) lines.push(`📎 Snapshot: \`${d.anchor.attachment_path}\`\n`);
      }
    });
    lines.push('Please address these and confirm.');
    return lines.join('\n');
  }

  async sendAll() {
    if (this.drafts.length === 0) return;
    const markdown = this.buildMarkdownBundle();
    const payload = { artifactId: this.artifactId, draftCount: this.drafts.length, markdown };

    // Archive first (idempotent if send fails — we keep history of attempts)
    const archiveId = `${this.artifactId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      await fetch(`/api/store/${HISTORY_COLLECTION}/${archiveId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, sent_at: new Date().toISOString(), drafts: this.drafts }),
      });
    } catch (err) { console.warn('[cdb] archive failed', err); }

    // Hand off to the host
    const ackPromise = new Promise((resolve) => {
      const handler = (ev) => {
        if (ev.source !== window.parent) return;
        if (ev.data?.type !== 'artifact:send-comments:ack') return;
        window.removeEventListener('message', handler);
        resolve(ev.data.payload);
      };
      window.addEventListener('message', handler);
      setTimeout(() => { window.removeEventListener('message', handler); resolve({ ok: false, error: 'timeout' }); }, 8000);
    });
    this.notifyHost('artifact:send-comments', payload);

    const ack = await ackPromise;
    if (!ack.ok) {
      alert('Send failed: ' + (ack.error ?? 'unknown error'));
      return;
    }
    // Clear drafts after a successful send
    [...this.drafts].forEach(d => this._removeDraft(d.id));
    await this.persist();
    this.renderCards();
  }

  // ---------------------------------------------------------------------------
  // Selection toolbar
  // ---------------------------------------------------------------------------

  wireSelectionToolbar() {
    document.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { this.hideToolbar(); return; }
      const range = sel.getRangeAt(0);
      if (!this.root.contains(range.startContainer) || !this.root.contains(range.endContainer)) {
        this.hideToolbar(); return;
      }
      // Don't show toolbar inside the sidebar or on an existing highlight click
      if (range.startContainer.parentElement?.closest('.cdb-sidebar')) { this.hideToolbar(); return; }
      this.showToolbar(range);
    });
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this.hideToolbar();
    });
  }

  showToolbar(range) {
    this.hideToolbar();
    const rect = range.getBoundingClientRect();
    const tb = document.createElement('div');
    tb.className = 'cdb-toolbar';
    tb.innerHTML = `<span>💬 Add comment</span><span class="shortcut">⌘⏎</span>`;
    tb.style.left = `${window.scrollX + rect.left + rect.width / 2 - 80}px`;
    tb.style.top = `${window.scrollY + rect.top - 38}px`;
    tb.addEventListener('mousedown', async (e) => {
      e.preventDefault();
      const anchor = await this.makeTextAnchor(range);
      if (anchor) await this.addDraft(anchor);
      window.getSelection()?.removeAllRanges();
      this.hideToolbar();
    });
    document.body.appendChild(tb);
    this.toolbar = tb;
    this.pendingRange = range;
  }

  hideToolbar() {
    if (this.toolbar) { this.toolbar.remove(); this.toolbar = null; }
    this.pendingRange = null;
  }

  // ---------------------------------------------------------------------------
  // Element-click anchors (img, mermaid, pre)
  // ---------------------------------------------------------------------------

  wireElementHover() {
    let hovered = null;

    this.root.addEventListener('mouseover', (e) => {
      const target = e.target.closest(COMMENTABLE_SELECTOR);
      if (!target || hovered === target) return;
      if (target.classList.contains('cdb-elem-anchored')) return;  // already has a comment
      if (hovered) hovered.classList.remove('cdb-hover-target');
      hovered = target;
      target.classList.add('cdb-hover-target');
    });

    this.root.addEventListener('mouseout', (e) => {
      const target = e.target.closest(COMMENTABLE_SELECTOR);
      if (target === hovered) {
        target?.classList.remove('cdb-hover-target');
        hovered = null;
      }
    });

    this.root.addEventListener('click', async (e) => {
      const target = e.target.closest(COMMENTABLE_SELECTOR);
      if (!target) return;
      // Don't fire if user just selected text inside it
      if (!window.getSelection()?.isCollapsed) return;
      // Don't fire on already-anchored elements (let user click the matching card)
      if (target.classList.contains('cdb-elem-anchored')) return;

      target.classList.remove('cdb-hover-target');
      e.preventDefault();
      e.stopPropagation();

      const elementKind =
        target.tagName === 'IMG' ? 'img'
        : target.classList.contains('mermaid-rendered') ? 'mermaid'
        : 'pre';

      const blob = await this.captureElement(target, elementKind);
      if (!blob) { alert('Could not capture this element to an image.'); return; }
      const att = await this.uploadAttachment(blob);
      const anchor = {
        kind: 'image',
        element: elementKind,
        section: this.nearestHeading(target),
        attachment_id: att.id,
        attachment_path: att.path,
        src: target.tagName === 'IMG' ? target.src : undefined,
        element_ref: target,
      };
      await this.addDraft(anchor);
    });
  }

  async captureElement(el, kind) {
    if (kind === 'img') {
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth || el.width;
      canvas.height = el.naturalHeight || el.height;
      try {
        const ctx = canvas.getContext('2d');
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      } catch (err) {
        // CORS-tainted; fall through to html2canvas as a best effort
        console.warn('[cdb] canvas tainted, falling back to html2canvas', err);
      }
    }
    if (kind === 'mermaid') {
      const svg = el.querySelector('svg');
      if (!svg) return null;
      return await svgToPngBlob(svg);
    }
    // pre, or img fallback — use html2canvas for fidelity
    return await elementToBlob(el);
  }

  // ---------------------------------------------------------------------------
  // Rectangle screenshot (Alt + drag)
  // ---------------------------------------------------------------------------

  wireRectangleDrag() {
    let layer, box, startX, startY;
    let active = false;

    const onKeyDown = (e) => {
      if (e.key !== 'Alt' || active || e.repeat) return;
      active = true;
      layer = document.createElement('div');
      layer.className = 'cdb-rect-layer';
      box = document.createElement('div');
      box.className = 'cdb-rect-box';
      box.style.display = 'none';
      layer.appendChild(box);
      document.body.appendChild(layer);

      layer.addEventListener('mousedown', onDown);
      layer.addEventListener('mousemove', onMove);
      layer.addEventListener('mouseup', onUp);
    };
    const onKeyUp = (e) => {
      if (e.key !== 'Alt' || !active) return;
      active = false;
      layer?.remove();
      layer = null; box = null;
    };

    const onDown = (e) => {
      startX = e.clientX; startY = e.clientY;
      box.style.display = 'block';
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = '0'; box.style.height = '0';
    };
    const onMove = (e) => {
      if (startX === undefined) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      box.style.left = `${x}px`; box.style.top = `${y}px`;
      box.style.width = `${w}px`; box.style.height = `${h}px`;
    };
    const onUp = async (e) => {
      if (startX === undefined) return;
      const x = Math.min(startX, e.clientX) + window.scrollX;
      const y = Math.min(startY, e.clientY) + window.scrollY;
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      startX = undefined;

      // tear down rect overlay before capture so it doesn't end up in the screenshot
      const wasActive = active;
      layer?.remove(); layer = null; box = null; active = false;

      if (w < 6 || h < 6) return;  // too small, treat as cancel

      const blob = await regionToBlob(document.documentElement, { x, y, w, h });
      if (!blob) { alert('Could not capture region.'); return; }
      const att = await this.uploadAttachment(blob);
      const sectionAtPoint = this.findSectionAtViewportPoint(x - window.scrollX + w / 2, y - window.scrollY + h / 2);
      await this.addDraft({
        kind: 'image',
        element: 'region',
        section: sectionAtPoint,
        attachment_id: att.id,
        attachment_path: att.path,
        rect: { x, y, w, h },
      });

      // re-arm if Alt is still held
      if (wasActive && document.activeElement) onKeyDown({ key: 'Alt', repeat: false });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  findSectionAtViewportPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return '';
    return this.nearestHeading(el);
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (global)
  // ---------------------------------------------------------------------------

  wireKeyboard() {
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && this.pendingRange) {
        e.preventDefault();
        this.makeTextAnchor(this.pendingRange).then(anchor => {
          if (anchor) this.addDraft(anchor);
          window.getSelection()?.removeAllRanges();
          this.hideToolbar();
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Card focus
  // ---------------------------------------------------------------------------

  focusCard(id, scrollAnchor) {
    this.activeCardId = id;
    this.renderCards();
    const card = this.cardsHost.querySelector(`[data-comment-id="${id}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (scrollAnchor) {
      const span = this.root.querySelector(`.cdb-comment-anchor[data-comment-id="${id}"]`);
      if (span) {
        span.scrollIntoView({ block: 'center', behavior: 'smooth' });
        span.classList.add('cdb-focus');
        setTimeout(() => span.classList.remove('cdb-focus'), 1200);
      }
    }
  }
}

// =============================================================================
// Image-capture helpers (outside the class so they can be reused)
// =============================================================================

async function svgToPngBlob(svg) {
  const xml = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const w = svg.viewBox?.baseVal?.width || svg.getBoundingClientRect().width || 600;
    const h = svg.viewBox?.baseVal?.height || svg.getBoundingClientRect().height || 400;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1b1b1b'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function elementToBlob(el) {
  const canvas = await html2canvas(el, {
    backgroundColor: '#15171d', logging: false, useCORS: true, scale: window.devicePixelRatio || 1,
  });
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function regionToBlob(rootEl, { x, y, w, h }) {
  const canvas = await html2canvas(rootEl, {
    backgroundColor: '#15171d', logging: false, useCORS: true,
    x, y, width: w, height: h, windowWidth: document.documentElement.scrollWidth,
    scale: window.devicePixelRatio || 1,
  });
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
