// _comment-overlay.mjs — the artifact-comments library.
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
// "Send" talks to the server directly from inside the iframe. Routing order:
//   1. GET /artifact/<id>/session  — server-side resolution: returns the
//      artifact's remembered session_id (from its recipe-instance JSON) and,
//      if the agent is currently alive, the live recipe_instance_id. The
//      overlay then POSTs to /dispatch (live pty) or /spawn (resume) as
//      appropriate. This lets Send work even when no live session exists
//      in the workspace right now — /spawn smart-routes to a resume.
//   2. Fallback: GET /api/sessions?status=active → pick any live session
//      in the artifact's workspace → POST /dispatch. Covers ad-hoc
//      artifacts that were never bound to a recipe instance.
// No postMessage hop, so the standalone /artifact/<id> page works exactly
// like the SPA-embedded one.
//
// This file is intentionally framework-free — vanilla DOM + fetch only — so it
// can drop into the artifact iframe with zero build step.
//
// The leading underscore in the filename is intentional: the renderer registry
// excludes `_`-prefixed `.mjs` files from its type listing so this shared
// library can sit next to renderer modules without being treated as one.

// Lazy-loaded so an esm.sh outage doesn't break text-selection comments.
let _html2canvasPromise = null;
function loadHtml2Canvas() {
  if (!_html2canvasPromise) {
    _html2canvasPromise = import('https://esm.sh/html2canvas@1.4.1').then(m => m.default);
  }
  return _html2canvasPromise;
}

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
/** localStorage key for the user-chosen sidebar width (px), shared across artifacts. */
const SIDEBAR_WIDTH_KEY = 'cdb:sidebar-width';
const SIDEBAR_WIDTH_DEFAULT = 340;
const SIDEBAR_WIDTH_MIN = 280;

const COMMENTABLE_SELECTOR = 'img, .mermaid-rendered, pre.hljs';

/** JSON.stringify replacer: strip live DOM refs (which serialize as {})
 *  before persisting drafts to disk or to the history archive. */
const STRIP_DOM_REFS = (key, value) => key === 'element_ref' ? undefined : value;

const mintId = (prefix) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

const escapeHtml = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Minimal, XSS-safe markdown for agent answers: escape first, then render
 *  `code`, **bold**, and newlines. Same subset the pr-walkthrough rail uses. */
function renderMarkdownish(s = '') {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

async function sha1Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-1', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Compact ISO-timestamp → "just now"/"2m ago"/"3h ago"/"6/12/2026" formatter.
 *  Used to label sent cards without overpowering the comment body. */
function formatRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
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
body.cdb-has-sidebar {
  /* padding-right + box-sizing so the sidebar gutter is INSIDE the body,
     not appended after — prevents horizontal overflow on constrained host
     layouts (e.g. iframe-based renderers where html and body are pinned to
     100% height/width). Width is user-resizable via the drag handle
     (persisted); defaults to 340px. */
  padding-right: var(--cdb-sidebar-width, 340px);
  box-sizing: border-box;
  transition: padding-right 180ms ease;
}
body.cdb-sidebar-collapsed { padding-right: 36px; }

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
  width: var(--cdb-sidebar-width, 340px); background: var(--cdb-sidebar-bg);
  border-left: 1px solid #2d3138;
  display: flex; flex-direction: column;
  font: 12px 'Segoe UI', system-ui, sans-serif; color: var(--cdb-text);
  z-index: 9997; transition: width 180ms ease;
}
.cdb-sidebar.cdb-collapsed { width: 36px; }
/* Drag-to-resize handle on the panel's left edge. The panel is pinned to the
   right, so dragging left widens it. A persistent line + grip dots make the
   affordance visible (not hover-only); width persists in localStorage, shared
   across every artifact. Double-click resets to the default width. */
.cdb-resize-handle {
  position: absolute; left: -5px; top: 0; bottom: 0; width: 11px;
  cursor: ew-resize; z-index: 9998; touch-action: none;
  display: flex; align-items: center; justify-content: center;
}
.cdb-resize-handle::before {
  content: ''; position: absolute; left: 5px; top: 0; bottom: 0; width: 2px;
  background: #3a3f4a; transition: background 120ms ease;
}
.cdb-resize-handle::after {
  content: '⋮'; position: relative; color: var(--cdb-muted); font-size: 15px;
  line-height: 1; opacity: 0.7; transition: opacity 120ms ease, color 120ms ease;
}
.cdb-resize-handle:hover::before,
body.cdb-resizing .cdb-resize-handle::before { background: var(--cdb-accent); }
.cdb-resize-handle:hover::after,
body.cdb-resizing .cdb-resize-handle::after { opacity: 1; color: var(--cdb-accent); }
.cdb-sidebar.cdb-collapsed .cdb-resize-handle { display: none; }
/* Track the cursor 1:1 while dragging (no width/padding easing). */
body.cdb-resizing, body.cdb-resizing .cdb-sidebar { transition: none !important; }
body.cdb-resizing { user-select: none; }
.cdb-sidebar.cdb-collapsed > header,
.cdb-sidebar.cdb-collapsed > .cdb-stream,
.cdb-sidebar.cdb-collapsed > .cdb-publish-bar,
.cdb-sidebar.cdb-collapsed > .cdb-qa-composer,
.cdb-sidebar.cdb-collapsed > footer { display: none !important; }
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
.cdb-sidebar header button.cdb-collapse-btn {
  border: 0; padding: 0 4px; font-size: 14px; color: var(--cdb-muted);
}
.cdb-sidebar header button.cdb-collapse-btn:hover { color: var(--cdb-accent); background: transparent; }
/* Header count badge (mirrors the pr-walkthrough Comments tab badge) */
.cdb-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: var(--cdb-card); color: var(--cdb-accent);
  border: 1px solid #3e3e42; margin-left: 6px; font-weight: 600;
}
/* Collapsed → thin vertical strip (mirrors the pr-walkthrough rail collapse) */
.cdb-collapsed-strip {
  display: none;
  flex-direction: column; align-items: center; justify-content: flex-start;
  gap: 14px; padding: 12px 4px; width: 100%; height: 100%;
  background: transparent; border: 0; cursor: pointer; color: var(--cdb-muted); font: inherit;
}
.cdb-sidebar.cdb-collapsed .cdb-collapsed-strip { display: flex; }
.cdb-collapsed-strip:hover { color: var(--cdb-accent); }
.cdb-strip-icon { font-size: 14px; }
.cdb-strip-label {
  writing-mode: vertical-rl; transform: rotate(180deg);
  font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
}
.cdb-strip-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 8px;
  background: var(--cdb-card); color: var(--cdb-accent);
  border: 1px solid #3e3e42; min-width: 18px; text-align: center;
}

/* Thin, theme-matched scrollbars across the artifact page + comments panel
   (mirrors the pr-walkthrough renderer). WebKit + Firefox fallback. */
@supports not selector(::-webkit-scrollbar) {
  * { scrollbar-width: thin; scrollbar-color: rgba(139,148,158,0.42) transparent; }
}
*::-webkit-scrollbar { width: 11px; height: 11px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: rgba(139,148,158,0.34); border-radius: 8px;
  border: 3px solid transparent; background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover { background: rgba(139,148,158,0.62); background-clip: padding-box; }
*::-webkit-scrollbar-corner { background: transparent; }
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

/* Sent (already dispatched) comment cards. Kept in the sidebar as a
   historical record of what was previously sent to the agent. */
.cdb-card.cdb-sent {
  border-left-color: #4ade80;
  opacity: 0.78;
}
.cdb-card.cdb-sent .body { font-style: italic; }
.cdb-card .sent-meta {
  color: #4ade80;
  font-size: 10px;
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Comment state badges */
.cdb-state-badge {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 6px;
  vertical-align: middle;
}
.cdb-state-in-progress {
  background: rgba(74, 138, 232, 0.15);
  color: #4a8ae8;
  border: 1px solid rgba(74, 138, 232, 0.3);
}
.cdb-state-resolved {
  background: rgba(74, 222, 128, 0.15);
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.3);
}
.cdb-card.cdb-resolved {
  opacity: 0.65;
}

/* Agent reply thread */
.cdb-replies {
  margin-top: 8px;
  padding-left: 10px;
  border-left: 2px solid rgba(74, 138, 232, 0.3);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cdb-reply {
  font-size: 11.5px;
  line-height: 1.4;
}
.cdb-reply-author {
  font-weight: 600;
  color: #4a8ae8;
  margin-right: 6px;
}
.cdb-reply-time {
  color: var(--cdb-muted, #888);
  font-size: 10px;
}
.cdb-reply-text {
  margin-top: 2px;
  color: var(--cdb-fg, #e0e0e0);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Unified discussion stream — comments + Q&A share ONE time-ordered timeline */
.cdb-title { font-weight: 600; color: #fff; }
.cdb-mode { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--cdb-muted, #8b949e); cursor: pointer; user-select: none; white-space: nowrap; }
.cdb-mode input { margin: 0; cursor: pointer; accent-color: #2563eb; }
.cdb-mode .cdb-mode-text { font-weight: 600; }
.cdb-stream { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }
.cdb-stream-empty { color: var(--cdb-muted, #8b949e); font-style: italic; padding: 22px 10px; text-align: center; line-height: 1.7; }
.cdb-qa-group { margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
/* Pending-publish action bar — shown only when unsent comment drafts exist. */
.cdb-publish-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-top: 1px solid #2d3138; background: rgba(37,99,235,0.06); }
.cdb-publish-bar[hidden] { display: none; }
.cdb-publish-bar .cdb-sp { flex: 1; }
.cdb-publish-bar .cdb-pub-note { font-size: 10px; color: var(--cdb-muted, #8b949e); }
.cdb-publish-bar button { background: transparent; border: 1px solid #3e3e42; color: var(--cdb-muted, #8b949e); padding: 4px 9px; border-radius: 3px; font-size: 11px; cursor: pointer; }
.cdb-publish-bar button:hover:not(:disabled) { color: var(--cdb-text, #e6e6e6); }
.cdb-publish-bar button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
.cdb-publish-bar button.primary:disabled { background: #2a2d33; border-color: #3e3e42; color: var(--cdb-muted, #8b949e); cursor: not-allowed; }
.cdb-publish-bar button:disabled { opacity: 0.6; cursor: not-allowed; }
.cdb-qa-empty { color: var(--cdb-muted, #8b949e); font-style: italic; text-align: center; padding: 24px 8px; }
.cdb-qa-empty .ic { font-size: 22px; margin-bottom: 6px; }
.cdb-qa-bubble { border-radius: 6px; padding: 8px 11px; font-size: 12px; line-height: 1.5; }
.cdb-qa-bubble.q { background: var(--cdb-card, #22252b); border-left: 2px solid var(--cdb-muted, #8b949e); }
.cdb-qa-bubble.a { background: rgba(74,138,232,0.08); border-left: 2px solid #4a8ae8; margin-left: 12px; }
.cdb-qa-bubble.pending { color: var(--cdb-muted, #8b949e); font-style: italic; background: transparent; }
.cdb-qa-who { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--cdb-muted, #8b949e); margin-bottom: 3px; }
.cdb-qa-who .ts { text-transform: none; letter-spacing: 0; margin-left: 6px; opacity: 0.7; }
.cdb-qa-text { white-space: pre-wrap; word-break: break-word; color: var(--cdb-text, #e6e6e6); }
.cdb-qa-composer { flex: 0 0 auto; border-top: 1px solid #2d3138; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
.cdb-qa-composer textarea {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 54px;
  background: #0e1117; color: var(--cdb-text, #e6e6e6); border: 1px solid #4d5664;
  border-radius: 4px; padding: 7px; font: inherit; font-size: 12px;
}
.cdb-qa-name {
  width: 100%; box-sizing: border-box;
  background: #0e1117; color: var(--cdb-text, #e6e6e6); border: 1px solid #4d5664;
  border-radius: 4px; padding: 6px 8px; font: inherit; font-size: 12px;
}
.cdb-qa-name[hidden] { display: none; }
.cdb-qa-name::placeholder { color: var(--cdb-muted, #8b949e); }
.cdb-qa-name:focus { outline: none; border-color: #2563eb; }
.cdb-qa-row { display: flex; align-items: center; gap: 8px; }
.cdb-qa-row .hint { flex: 1; color: var(--cdb-muted, #8b949e); font-size: 10px; }
.cdb-qa-ask { background: #2563eb; border: 1px solid #2563eb; color: #fff; font-weight: 600; padding: 5px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.cdb-qa-ask:disabled { background: #2a2d33; border-color: #3e3e42; color: var(--cdb-muted, #8b949e); cursor: not-allowed; }
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
    // Q&A tab state — a single general thread per artifact (qa-store stepN=1).
    // Reuses the exact endpoints pr-walkthrough proved out: POST/GET
    // /artifact/<id>/qa/step-1.json (persist), POST /artifact/<id>/ask
    // (durable dispatch), /artifact/<id>/qa/events (live), and the generic
    // pr-walkthrough.answer tool for the agent's reply.
    this.qaThread = [];
    this.QA_STEP = 1;
    // Comment send mode: 'publish' (stage drafts → Publish button, the
    // default/legacy batch flow) or 'immediate' (each saved comment dispatches
    // to the agent right away). Toggle persists across artifacts.
    this.sendMode = 'publish';
    try { const m = localStorage.getItem('cdb-comment-send-mode'); if (m === 'immediate' || m === 'publish') this.sendMode = m; } catch { /* sandboxed iframe */ }
    // Shared mode: this page was served by the tenant-scoped share server
    // (window.__CDB_SHARED__ injected by the host page). Colleagues must
    // self-identify before asking; the owner's local (non-shared) questions
    // render as "You". The chosen name persists across artifacts.
    this.shared = !!(typeof window !== 'undefined' && window.__CDB_SHARED__);
    this.authorName = '';
    if (this.shared) { try { this.authorName = localStorage.getItem('cdb-qa-author') || ''; } catch { /* sandboxed */ } }
    this.persistDebounced = debounce(() => this.persist().catch(console.error), SAVE_DEBOUNCE_MS);
  }

  async init() {
    this.injectStyles();
    this.buildSidebar();
    document.body.classList.add('cdb-has-sidebar');
    // Q&A loads in PARALLEL with the comment drafts/highlights — the two are
    // independent, so Q&A renders as soon as its thread arrives instead of
    // waiting behind comment loading (each server round-trip can be ~1-2s).
    // Each phase is isolated: a failure in one (e.g. a stale/orphan comment
    // anchor that throws in renderHighlights) must NEVER block the others, so
    // every artifact reliably gets BOTH comments and Q&A.
    const qaReady = this.loadQaThread()
      .then(() => this.renderQaThread())
      .catch((e) => console.warn('[cdb] Q&A init failed', e));
    try { await this.loadDrafts(); } catch (e) { console.warn('[cdb] loadDrafts failed', e); }
    try { await this.renderHighlights(); } catch (e) { console.warn('[cdb] renderHighlights failed', e); }
    try { this.renderCards(); } catch (e) { console.warn('[cdb] renderCards failed', e); }
    await qaReady;
    try { this.wireSelectionToolbar(); } catch (e) { console.warn('[cdb] wireSelectionToolbar failed', e); }
    try { this.wireElementHover(); } catch (e) { console.warn('[cdb] wireElementHover failed', e); }
    try { this.wireRectangleDrag(); } catch (e) { console.warn('[cdb] wireRectangleDrag failed', e); }
    try { this.wireKeyboard(); } catch (e) { console.warn('[cdb] wireKeyboard failed', e); }
    try { this.wireSSERefresh(); } catch (e) { console.warn('[cdb] wireSSERefresh failed', e); }
    try { this.wireQaSSE(); } catch (e) { console.warn('[cdb] wireQaSSE failed', e); }
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
      const r = await fetch(`/api/store/${DRAFTS_COLLECTION}/${this.artifactId}?artifact=${encodeURIComponent(this.artifactId)}`);
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
    // element_ref is a live DOM node — strip it before serializing or it
    // becomes {} on the wire and causes TypeError on delete after reload.
    const body = JSON.stringify(doc, STRIP_DOM_REFS);
    try {
      await fetch(`/api/store/${DRAFTS_COLLECTION}/${this.artifactId}?artifact=${encodeURIComponent(this.artifactId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      this.notifyHost('artifact:drafts-changed', { artifactId: this.artifactId });
    } catch (err) {
      console.warn('[cdb] persist failed', err);
    }
  }

  async uploadAttachment(blob) {
    const id = mintId('att');
    const r = await fetch(`/api/store/${ATTACH_COLLECTION}/${id}?artifact=${encodeURIComponent(this.artifactId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    });
    if (!r.ok) {
      const detail = r.status === 413
        ? 'screenshot too large (4 MB limit) — try a smaller region'
        : `upload failed: ${r.status}`;
      throw new Error(detail);
    }
    // Build extension from blob.type so the path matches what the server
    // actually writes (server uses EXT_FOR_TYPE in json-doc-store.ts).
    // Mirror keeps the table small; if you add a new content-type here,
    // also add it to the server's EXT_FOR_TYPE map.
    const EXT_FOR_BLOB_TYPE = {
      'image/png':     'png',
      'image/jpeg':    'jpg',
      'image/svg+xml': 'svg',
      'text/plain':    'txt',
    };
    const blobType = blob.type || 'image/png';
    const ext = EXT_FOR_BLOB_TYPE[blobType] ?? 'bin';
    return {
      id,
      path: `.clawdevbox/store/${ATTACH_COLLECTION}/${id}.${ext}`,
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
    // Walk the root in document order, tracking the most recent heading
    // text. Return the heading that was last seen before we encountered `node`.
    // Matches countSectionTextMatches's algorithm so anchor section and
    // re-anchor section are always computed identically — important for
    // nested layouts (sections, articles, details) that html.mjs may render.
    const root = this.root;
    let currentSection = '';
    let found = '';
    const targetEl = node.nodeType === 1 ? node : node.parentElement;
    if (!targetEl) return '';
    function walk(el) {
      for (const child of el.childNodes) {
        if (found) return;
        if (child === targetEl || (child.nodeType === 1 && child.contains(targetEl))) {
          if (child.nodeType === 1 && /^H[1-6]$/i.test(child.tagName)) {
            // We landed inside a heading itself; its text is the section name.
            currentSection = child.textContent.trim();
          }
          found = currentSection;
          return;
        }
        if (child.nodeType === 1 && /^H[1-6]$/i.test(child.tagName)) {
          currentSection = child.textContent.trim();
        } else if (child.nodeType === 1) {
          walk(child);
        }
      }
    }
    walk(root);
    return found;
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
    // Re-anchor image comments. Restores the visual outline AND repopulates
    // element_ref so deleteDraft can remove the class cleanly.
    for (const d of this.drafts) {
      if (d.anchor?.kind !== 'image') continue;
      if (d.anchor.element === 'region') continue;  // regions are always orphan on re-render
      const el = this.findImageAnchorElement(d.anchor);
      if (el) {
        d.anchor.element_ref = el;
        el.classList.add('cdb-elem-anchored');
        d.orphan = false;
      } else {
        d.orphan = true;
      }
    }
  }

  findImageAnchorElement(anchor) {
    // <img>: match by src
    if (anchor.element === 'img' && anchor.src) {
      const imgs = this.root.querySelectorAll('img');
      for (const img of imgs) {
        if (img.src === anchor.src && !img.classList.contains('cdb-elem-anchored')) {
          return img;
        }
      }
      return null;
    }
    // mermaid / pre: match by (section, kind, position-within-section)
    // We don't store position-within-section today; treat the first
    // matching element in the section as the anchor. Good enough for v1.
    const selector = anchor.element === 'mermaid' ? '.mermaid-rendered' : 'pre.hljs';
    const candidates = this.root.querySelectorAll(selector);
    for (const el of candidates) {
      if (el.classList.contains('cdb-elem-anchored')) continue;
      const section = this.nearestHeading(el);
      if (section === anchor.section) return el;
    }
    return null;
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
      <header>
        <button class="cdb-collapse-btn" title="Collapse panel">⟩</button>
        <span class="cdb-title">Discussion</span>
        <span class="cdb-badge cdb-count">0</span>
        <span class="grow"></span>
        <label class="cdb-mode" title="How comments reach the agent: instantly, or staged until you Publish">
          <input type="checkbox" class="cdb-mode-input" checked>
          <span class="cdb-mode-text">Publish manually</span>
        </label>
      </header>
      <div class="cdb-stream"></div>
      <div class="cdb-publish-bar" hidden>
        <span class="cdb-pub-note">Unpublished comments</span>
        <span class="cdb-sp"></span>
        <button class="clear">Clear</button>
        <button class="send primary" disabled>Publish (0) →</button>
      </div>
      <div class="cdb-qa-composer">
        <input type="text" class="cdb-qa-name" maxlength="80" placeholder="Your name (required to ask)" hidden>
        <textarea class="cdb-qa-input" placeholder="Ask the agent about this artifact…" rows="3"></textarea>
        <div class="cdb-qa-row">
          <span class="hint">Ask the agent · ⌘/Ctrl+Enter · select text or Alt-drag to comment</span>
          <button type="button" class="cdb-qa-ask">Ask →</button>
        </div>
      </div>
      <footer>Comments &amp; Q&amp;A save to this artifact and sync live.</footer>
      <button class="cdb-collapsed-strip" title="Expand comments">
        <span class="cdb-strip-icon">⟨</span>
        <span class="cdb-strip-label">Comments</span>
        <span class="cdb-strip-badge cdb-strip-count">0</span>
      </button>
    `;
    document.body.appendChild(aside);
    this.sidebar = aside;
    this.streamHost = aside.querySelector('.cdb-stream');
    this.cardsHost = this.streamHost;    // legacy alias (focusCard/_removeDraft/renderCard)
    this.qaThreadEl = this.streamHost;   // legacy alias
    this.countEl = aside.querySelector('.cdb-count');
    this.stripCountEl = aside.querySelector('.cdb-strip-count');
    this.publishBar = aside.querySelector('.cdb-publish-bar');
    this.sendBtn = aside.querySelector('.send');
    this.clearBtn = aside.querySelector('.clear');
    this.collapseBtn = aside.querySelector('.cdb-collapse-btn');
    this.stripEl = aside.querySelector('.cdb-collapsed-strip');
    this.qaInput = aside.querySelector('.cdb-qa-input');
    this.qaAskBtn = aside.querySelector('.cdb-qa-ask');
    this.modeInput = aside.querySelector('.cdb-mode-input');
    this.modeText = aside.querySelector('.cdb-mode-text');

    this.sendBtn.addEventListener('click', () => this.sendAll());
    this.clearBtn.addEventListener('click', () => this.clearAll());
    this.collapseBtn.addEventListener('click', () => this.toggleSidebar(true));
    this.stripEl.addEventListener('click', () => this.toggleSidebar(false));
    // Send-mode toggle (stage-and-publish vs immediate); reflect saved state.
    this.modeInput.checked = this.sendMode === 'publish';
    this.modeText.textContent = this.sendMode === 'publish' ? 'Publish manually' : 'Send instantly';
    this.modeInput.addEventListener('change', () =>
      this.setSendMode(this.modeInput.checked ? 'publish' : 'immediate'));
    // Q&A send via button click (never blocked by iframe sandbox) + Ctrl/Cmd+Enter.
    this.qaAskBtn.addEventListener('click', () => this.submitQuestion());
    this.qaInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.submitQuestion(); }
    });
    // Shared mode: reveal the mandatory name field, prefill the remembered
    // name, and gate the Ask button until a name is entered.
    this.qaNameInput = aside.querySelector('.cdb-qa-name');
    if (this.shared && this.qaNameInput) {
      this.qaNameInput.hidden = false;
      this.qaNameInput.value = this.authorName;
      this.qaNameInput.addEventListener('input', () => {
        this.authorName = this.qaNameInput.value;
        try { localStorage.setItem('cdb-qa-author', this.authorName.trim()); } catch { /* sandboxed */ }
        this.updateAskEnabled();
      });
      this.qaNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.qaInput?.focus(); }
      });
    }
    this.updateAskEnabled();

    // Drag-to-resize handle on the left edge.
    const handle = document.createElement('div');
    handle.className = 'cdb-resize-handle';
    handle.title = 'Drag to resize · double-click to reset';
    aside.appendChild(handle);
    this.resizeHandle = handle;
    this.restoreSidebarWidth();
    this.wireResize();
  }

  /** Clamp a candidate sidebar width (px) to [MIN, 80% of viewport]. */
  clampSidebarWidth(w) {
    const max = Math.max(SIDEBAR_WIDTH_MIN, Math.round(window.innerWidth * 0.8));
    return Math.min(Math.max(Math.round(w), SIDEBAR_WIDTH_MIN), max);
  }

  /** Apply a width via the shared CSS var that drives both the panel and body gutter. */
  applySidebarWidth(w) {
    document.documentElement.style.setProperty('--cdb-sidebar-width', this.clampSidebarWidth(w) + 'px');
  }

  restoreSidebarWidth() {
    try {
      const saved = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
      if (Number.isFinite(saved)) this.applySidebarWidth(saved);
    } catch { /* localStorage unavailable (sandboxed iframe) — keep default */ }
  }

  wireResize() {
    const handle = this.resizeHandle;
    if (!handle) return;
    let dragging = false;
    // Panel is pinned to the right edge, so its width == distance from the
    // cursor to the right edge of the viewport.
    const widthFor = (e) => this.clampSidebarWidth(window.innerWidth - e.clientX);
    handle.addEventListener('pointerdown', (e) => {
      if (this.sidebarCollapsed) return;
      dragging = true;
      document.body.classList.add('cdb-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (dragging) this.applySidebarWidth(window.innerWidth - e.clientX);
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('cdb-resizing');
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthFor(e))); } catch { /* ignore */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => {
      this.applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
      try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_WIDTH_DEFAULT)); } catch { /* ignore */ }
    });
  }

  setSendMode(mode) {
    this.sendMode = mode === 'immediate' ? 'immediate' : 'publish';
    try { localStorage.setItem('cdb-comment-send-mode', this.sendMode); } catch { /* sandboxed */ }
    if (this.modeInput) this.modeInput.checked = this.sendMode === 'publish';
    if (this.modeText) this.modeText.textContent = this.sendMode === 'publish' ? 'Publish manually' : 'Send instantly';
    this.render();
  }

  scrollStreamToBottom() {
    if (this.streamHost) this.streamHost.scrollTop = this.streamHost.scrollHeight;
  }

  /** The asker's display name — only meaningful in shared mode (else ''). */
  getAuthorName() {
    if (!this.shared) return '';
    return (this.qaNameInput?.value ?? this.authorName ?? '').trim();
  }

  /** In shared mode the Ask button stays disabled until a name is entered. */
  updateAskEnabled() {
    if (!this.qaAskBtn || this._asking) return;
    this.qaAskBtn.disabled = this.shared && !this.getAuthorName();
  }

  toggleSidebar(force) {
    this.sidebarCollapsed = force ?? !this.sidebarCollapsed;
    this.sidebar.classList.toggle('cdb-collapsed', this.sidebarCollapsed);
    document.body.classList.toggle('cdb-sidebar-collapsed', this.sidebarCollapsed);
  }

  // ---------------------------------------------------------------------------
  // Q&A tab — free-form questions with inline agent answers. Mirrors the
  // pr-walkthrough Q&A flow but generic (single thread, no per-step/file):
  //   1. POST /artifact/<id>/qa/step-1.json {text}        → persist question
  //   2. POST /artifact/<id>/ask {prompt}                 → durable dispatch
  //   3. agent calls pr-walkthrough.answer (step_n=1)     → writes answer
  //   4. /artifact/<id>/qa/events SSE (or poll)           → answer shows here
  // ---------------------------------------------------------------------------
  async loadQaThread() {
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(this.artifactId)}/qa/step-${this.QA_STEP}.json`, { cache: 'no-store' });
      if (r.ok) {
        const thread = await r.json();
        if (Array.isArray(thread)) this.qaThread = thread;
      }
    } catch { /* network blip — keep local */ }
  }

  // Back-compat entry point — Q&A and comment renders now flow through the
  // single unified stream renderer (render()).
  renderQaThread() { this.render(); }

  renderQaBubbleGroup(qa) {
    const wrap = document.createElement('div');
    wrap.className = 'cdb-qa-group';
    wrap.innerHTML = `
      <div class="cdb-qa-bubble q"><div class="cdb-qa-who">${qa.askedBy ? '👤 ' + escapeHtml(qa.askedBy) : 'You'} <span class="ts">${escapeHtml(formatRelative(qa.askedAt))}</span></div><div class="cdb-qa-text">${escapeHtml(qa.q || '')}</div></div>
      ${qa.a
        ? `<div class="cdb-qa-bubble a"><div class="cdb-qa-who">🤖 Agent <span class="ts">${escapeHtml(formatRelative(qa.ts))}</span></div><div class="cdb-qa-text">${renderMarkdownish(qa.a)}</div></div>`
        : `<div class="cdb-qa-bubble pending">Agent is thinking…</div>`}`;
    return wrap;
  }

  async submitQuestion() {
    const text = (this.qaInput?.value || '').trim();
    if (!text) return;
    // Shared viewers must self-identify before their question is attributed.
    const askedBy = this.getAuthorName();
    if (this.shared && !askedBy) {
      this.notifyHost('artifact:toast', { text: 'Enter your name before asking.' });
      this.qaNameInput?.focus();
      return;
    }
    this.qaInput.value = '';
    this._asking = true;
    this.qaAskBtn.disabled = true;
    const base = `/artifact/${encodeURIComponent(this.artifactId)}`;
    let entry;
    try {
      const res = await fetch(`${base}/qa/step-${this.QA_STEP}.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(askedBy ? { text, askedBy } : { text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entry = await res.json();
    } catch (err) {
      this._asking = false;
      this.updateAskEnabled();
      this.qaInput.value = text;
      this.notifyHost('artifact:toast', { text: `Couldn't send: ${err?.message ?? err}` });
      return;
    }
    this.qaThread.push(entry);
    this.renderQaThread();
    this.scrollStreamToBottom();
    this._asking = false;
    this.updateAskEnabled();

    // Dispatch to the agent via the durable outbox (resumes a closed session,
    // retries on failure). Fire-and-forget — the question is already saved.
    const prompt = [
      `Question about artifact ${this.artifactId}${askedBy ? ` (asked by ${askedBy})` : ''}`,
      '',
      `Question (id: ${entry.id}):`,
      `> ${entry.q}`,
      '',
      'When you have an answer, call the `pr-walkthrough.answer` MCP tool:',
      `  artifact_id="${this.artifactId}", step_n=${this.QA_STEP}, question_id="${entry.id}", text="<your answer>"`,
    ].join('\n');
    try {
      const r = await fetch(`${base}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!r.ok) {
        this.notifyHost('artifact:toast', { text: `Question saved, but couldn't reach the agent (HTTP ${r.status}).` });
        return;
      }
    } catch (err) {
      this.notifyHost('artifact:toast', { text: `Question saved, but dispatch failed: ${err?.message ?? err}` });
      return;
    }
    this.pollForQaAnswer(entry.id);
  }

  pollForQaAnswer(questionId, attempts = 0) {
    if (attempts >= 60) return; // 60 × 3s = 3 min
    setTimeout(async () => {
      try {
        const r = await fetch(`/artifact/${encodeURIComponent(this.artifactId)}/qa/step-${this.QA_STEP}.json`, { cache: 'no-store' });
        if (r.ok) {
          const thread = await r.json();
          const matched = Array.isArray(thread) && thread.find(e => e.id === questionId);
          if (matched && matched.a) { this.qaThread = thread; this.renderQaThread(); return; }
          if (Array.isArray(thread)) { this.qaThread = thread; this.renderQaThread(); }
        }
      } catch { /* retry */ }
      this.pollForQaAnswer(questionId, attempts + 1);
    }, 3000);
  }

  // Live cross-client Q&A: re-read the thread whenever the server pushes a
  // qa change for this artifact (question/answer from any browser or machine).
  wireQaSSE() {
    try {
      const es = new EventSource(`/artifact/${encodeURIComponent(this.artifactId)}/qa/events`);
      const refresh = debounce(async () => { await this.loadQaThread(); this.renderQaThread(); }, 400);
      es.addEventListener('qa', refresh);
      es.addEventListener('open', refresh);
    } catch (err) {
      console.warn('[cdb] Q&A SSE wiring failed', err);
    }
  }

  renderCards() { this.render(); }

  commentTs(d) { return Date.parse(d.sent_at || d.updated_at || d.created_at || '') || 0; }
  qaTs(qa) { return Date.parse(qa.askedAt || qa.ts || '') || 0; }

  /**
   * Unified renderer: comments (anchored drafts) and Q&A (question/answer
   * bubbles) share ONE time-ordered stream (oldest → newest, chat-style).
   * Also refreshes the header count and the pending-publish bar (shown only
   * when unsent comment drafts exist).
   */
  render() {
    if (!this.streamHost) return;
    const unsent = this.drafts.filter(d => !d.sent);
    const qaItems = (this.qaThread || []).filter(e => e.kind !== 'comment');
    const total = this.drafts.length + qaItems.length;

    if (this.countEl) this.countEl.textContent = String(total);
    if (this.stripCountEl) this.stripCountEl.textContent = String(total);

    // Publish bar shows whenever unsent drafts exist. In 'immediate' mode saves
    // auto-dispatch so none normally accumulate; in 'publish' mode this is the
    // batch button. Either way it can flush a draft left over after toggling.
    if (this.publishBar) this.publishBar.hidden = unsent.length === 0;
    if (this.sendBtn) {
      this.sendBtn.textContent = `Publish (${unsent.length}) →`;
      this.sendBtn.disabled = unsent.length === 0 || this._sending;
    }
    if (this.clearBtn) this.clearBtn.disabled = unsent.length === 0;

    // Preserve in-progress textarea content before rebuilding the DOM.
    if (this.editingCardId) {
      const editing = this.draftsById.get(this.editingCardId);
      const card = this.streamHost.querySelector(`[data-comment-id="${this.editingCardId}"]`);
      const ta = card?.querySelector('textarea');
      if (editing && ta) editing.comment = ta.value;
    }

    if (total === 0) {
      this.streamHost.innerHTML = `<div class="cdb-stream-empty">💬 No comments or questions yet.<br>Select text or Alt-drag a region to comment, or ask the agent below.</div>`;
      return;
    }

    const items = [];
    for (const d of this.drafts) items.push({ ts: this.commentTs(d), make: () => this.renderCard(d) });
    for (const qa of qaItems) items.push({ ts: this.qaTs(qa), make: () => this.renderQaBubbleGroup(qa) });
    items.sort((a, b) => a.ts - b.ts);

    this.streamHost.innerHTML = '';
    for (const it of items) this.streamHost.appendChild(it.make());
  }

  renderCard(d) {
    const card = document.createElement('div');
    card.className = 'cdb-card';
    if (d.id === this.activeCardId) card.classList.add('cdb-focus');
    if (d.orphan) card.classList.add('cdb-orphan');
    if (d.sent) card.classList.add('cdb-sent');
    if (d.state === 'resolved') card.classList.add('cdb-resolved');
    card.dataset.commentId = d.id;

    const orphanBadge = d.orphan ? `<span class="orphan-badge">🔗❌</span> ` : '';
    const sectionLabel = d.anchor.section || '(no section)';

    const anchorLabel = d.anchor.kind === 'text'
      ? `§ ${escapeHtml(sectionLabel)} · "${escapeHtml(d.anchor.text.slice(0, 60))}${d.anchor.text.length > 60 ? '…' : ''}"`
      : `§ ${escapeHtml(sectionLabel)} · ${escapeHtml(d.anchor.element)} snapshot`;

    // State badge
    const stateBadge = d.state === 'in_progress'
      ? '<span class="cdb-state-badge cdb-state-in-progress">In progress</span>'
      : d.state === 'resolved'
        ? '<span class="cdb-state-badge cdb-state-resolved">Resolved</span>'
        : '';

    const thumb = d.anchor.kind === 'image' && d.anchor.attachment_id
      ? `<img class="thumb" src="/api/store/${ATTACH_COLLECTION}/${d.anchor.attachment_id}?artifact=${encodeURIComponent(this.artifactId)}" alt="snapshot">`
      : '';

    // Sent cards are read-only: no edit, no delete, no editing state.
    const isEditing = !d.sent && d.id === this.editingCardId;
    const bodyHtml = isEditing
      ? `<textarea autofocus>${escapeHtml(d.comment ?? '')}</textarea>`
      : `<div class="body">${escapeHtml(d.comment || '(empty — click to write)')}</div>`;

    const sentMeta = d.sent
      ? `<div class="sent-meta">✓ Sent ${escapeHtml(formatRelative(d.sent_at))}</div>`
      : '';

    // Agent reply thread
    const repliesHtml = Array.isArray(d.replies) && d.replies.length > 0
      ? `<div class="cdb-replies">${d.replies.map(r =>
          `<div class="cdb-reply">
            <span class="cdb-reply-author">🤖 Agent</span>
            <span class="cdb-reply-time">${escapeHtml(formatRelative(r.created_at))}</span>
            <div class="cdb-reply-text">${escapeHtml(r.text)}</div>
          </div>`
        ).join('')}</div>`
      : '';

    const actions = d.sent
      ? ''
      : (isEditing
        ? `<button class="cancel">Cancel</button>
           <button class="save primary" ${(d.comment ?? '').trim() ? '' : 'disabled'}>Save</button>`
        : `<button class="edit">edit</button><button class="delete">delete</button>`);

    card.innerHTML = `
      <div class="meta">${orphanBadge}${anchorLabel}${stateBadge}</div>
      ${thumb}
      ${bodyHtml}
      ${sentMeta}
      ${repliesHtml}
      ${actions ? `<div class="row">${actions}</div>` : ''}
    `;

    // Card behaviors
    card.addEventListener('click', (e) => {
      // Don't override button clicks inside the card
      if (e.target.closest('button, textarea')) return;
      // Sent cards are read-only — focus the anchor but don't trigger editing.
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
  // Draft lifecycle (add / edit / delete / clear)
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

    if (anchor.kind === 'text') draft.orphan = !this.applyTextHighlight(draft);
    // Element anchors get a permanent outline via cdb-elem-anchored
    if (anchor.kind === 'image' && anchor.element_ref) {
      anchor.element_ref.classList.add('cdb-elem-anchored');
    }

    this.activeCardId = draft.id;
    this.editingCardId = draft.id;
    this.toggleSidebar(false);
    this.renderCards();
    this.scrollStreamToBottom();
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
      this.editingCardId = null;
      this.renderCards();
      // Immediate mode: dispatch this one comment to the agent right away.
      if (this.sendMode === 'immediate') this.sendOne(d);
      return;
    }
    // Cancelled: if it was a brand-new empty comment, drop it.
    if (!d.comment) this._removeDraft(id);
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
    if (removed?.anchor?.kind === 'image' && removed.anchor.element_ref?.classList?.remove) {
      removed.anchor.element_ref.classList.remove('cdb-elem-anchored');
    }
  }

  async clearAll() {
    // Keep sent drafts as a historical record — only discard the unsent
    // ones. Without this guard, Clear would erase prior dispatches and
    // make the sidebar useless as an audit trail.
    const unsent = this.drafts.filter(d => !d.sent);
    if (unsent.length === 0) return;
    if (!confirm(`Discard ${unsent.length} unsent comment${unsent.length === 1 ? '' : 's'}?`)) return;
    unsent.forEach(d => this._removeDraft(d.id));
    await this.persist();
    this.renderCards();
  }

  buildMarkdownBundle(drafts = this.drafts) {
    const title = this.ctx.manifest?.title ?? this.artifactId;
    const lines = [];
    lines.push(`Review of artifact **${title}** (\`${this.artifactId}\`):\n`);
    drafts.forEach((d, i) => {
      const n = i + 1;
      const section = d.anchor.section || '(no section)';
      const orphan = d.orphan ? ' — orphan' : '';
      if (d.anchor.kind === 'text') {
        lines.push(`— Comment ${n} [id: ${d.id}] (on §"${section}"${orphan}):`);
        lines.push(`> ${d.comment.split('\n').join('\n> ')}\n`);
        lines.push(`> "${d.anchor.text}"\n`);
      } else {
        const what = d.anchor.element === 'region' ? 'region' : `${d.anchor.element} snapshot`;
        lines.push(`— Comment ${n} [id: ${d.id}] (on ${what} in §"${section}"${orphan}):`);
        lines.push(`> ${d.comment.split('\n').join('\n> ')}\n`);
        if (d.anchor.attachment_path) lines.push(`📎 Snapshot: \`${d.anchor.attachment_path}\`\n`);
      }
    });
    lines.push('Please address these and reply to each using `artifact.comment_reply` with the comment id.');
    return lines.join('\n');
  }

  async sendAll() {
    if (this._sending) return;  // guard against double-clicks
    const unsent = this.drafts.filter(d => !d.sent);
    if (unsent.length === 0) return;
    this._sending = true;
    if (this.sendBtn) this.sendBtn.disabled = true;
    try {
      await this._dispatchDrafts(unsent);
    } finally {
      this._sending = false;
      this.render();
      // render() disables the button when nothing is unsent; on early-return /
      // failure paths some drafts remain unsent, so re-enable explicitly.
      if (this.sendBtn && this.drafts.some(d => !d.sent)) this.sendBtn.disabled = false;
    }
  }

  /** Immediate-mode single-comment dispatch (same pipeline as Publish). */
  async sendOne(draft) {
    if (!draft || draft.sent || this._sending) return;
    this._sending = true;
    try {
      await this._dispatchDrafts([draft]);
    } finally {
      this._sending = false;
      this.render();
    }
  }

  /**
   * Bundle the given unsent drafts into ONE agent message, archive them
   * (best-effort audit log), smart-route to THIS artifact's session, dispatch,
   * and mark them sent in place. Shared by Publish (all unsent) and immediate
   * mode (one). Alerts on failure; does not manage the _sending guard or the
   * Publish button (callers do).
   */
  async _dispatchDrafts(unsentDrafts) {
    if (!unsentDrafts || unsentDrafts.length === 0) return;
    try {
      const markdown = this.buildMarkdownBundle(unsentDrafts);
      const payload = { artifactId: this.artifactId, draftCount: unsentDrafts.length, markdown };

      // Smart routing: prefer the artifact's remembered session over a
      // workspace-wide search. See resolveTargetSession for the chain.
      const target = await this.resolveTargetSession();
      if (!target || target.kind === 'none') {
        const wsLabel = target?.workspace_id ? ` in workspace "${target.workspace_id}"` : '';
        alert(`No agent session for this artifact${wsLabel}. Start one and try again.`);
        return;
      }

      // Archive the bundle first. STRIP_DOM_REFS keeps image-anchored drafts
      // (which carry a live DOM node) from serializing to "{}" and losing data.
      const archiveId = `${this.artifactId}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        const ar = await fetch(`/api/store/${HISTORY_COLLECTION}/${archiveId}?artifact=${encodeURIComponent(this.artifactId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, sent_at: new Date().toISOString(), drafts: unsentDrafts, target }, STRIP_DOM_REFS),
        });
        if (!ar.ok) console.warn('[cdb] archive PUT returned non-OK', ar.status);
      } catch (err) { console.warn('[cdb] archive failed', err); }

      // Scoped, share-safe dispatch: /artifact/<id>/ask resolves THIS artifact's
      // own session and smart-routes (dispatch if a pty is live, resume if
      // archived, spawn otherwise) — the caller can only message the
      // conversation that produced this artifact.
      const dr = await fetch(`/artifact/${encodeURIComponent(this.artifactId)}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: markdown }),
      });
      if (!dr.ok) {
        const txt = await dr.text().catch(() => '');
        alert(`Send failed: HTTP ${dr.status} ${txt.slice(0, 200)}`);
        return;
      }

      // Mark shipped drafts sent, in place. They stay in the stream as a record.
      const sentAt = new Date().toISOString();
      for (const d of unsentDrafts) { d.sent = true; d.sent_at = sentAt; }
      await this.persist();
    } catch (err) {
      console.warn('[cdb] dispatch error', err);
      alert(`Send failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Resolve where this artifact's comments should go. Chain:
   *
   *   1. GET /artifact/<id>/session — server has authoritative knowledge
   *      of which session_id created the artifact (via its recipe
   *      instance) and whether that session has a live pty right now.
   *        - { live_instance_id }  → { kind: 'live',  ... } → /dispatch
   *        - { session_id }        → { kind: 'spawn', ... } → /spawn
   *      Either way, the user's review lands on the agent that actually
   *      produced the artifact (or its resumed continuation), even from
   *      a standalone /artifact/<id> page with no SPA in scope.
   *
   *   2. Workspace fallback — for artifacts that were never bound to a
   *      recipe instance (e.g., one-off skill outputs), pick the newest
   *      live session in the artifact's workspace. Same behaviour as
   *      the pre-/session implementation, preserved so legacy artifacts
   *      keep working.
   *
   * Returns { kind, ... } where kind is 'live' | 'spawn' | 'none'.
   */
  async resolveTargetSession() {
    let workspaceId = null;
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(this.artifactId)}/session`);
      if (r.ok) {
        const { session_id, workspace_id, live_instance_id } = await r.json();
        workspaceId = workspace_id ?? null;
        if (workspaceId) this._workspaceId = workspaceId;
        if (live_instance_id) {
          return { kind: 'live', instance_id: live_instance_id, workspace_id: workspaceId };
        }
        if (session_id) {
          return { kind: 'spawn', session_id, workspace_id: workspaceId };
        }
      }
    } catch {
      // /session unreachable — fall through to workspace fallback.
    }

    // Fallback: workspace-wide live-session search.
    if (!workspaceId) {
      workspaceId = await this.resolveWorkspaceId();
    }
    if (!workspaceId) return { kind: 'none', workspace_id: null };
    const sessions = await this.fetchActiveSessions();
    const candidates = sessions
      .filter(s => s.live && s.workspace_id === workspaceId)
      .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
    if (candidates.length > 0) {
      return { kind: 'live', instance_id: candidates[0].instance_id, workspace_id: workspaceId };
    }
    return { kind: 'none', workspace_id: workspaceId };
  }

  async resolveWorkspaceId() {
    if (this._workspaceId) return this._workspaceId;
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(this.artifactId)}/manifest`);
      if (!r.ok) return null;
      const m = await r.json();
      this._workspaceId = m?.workspace_id ?? null;
      return this._workspaceId;
    } catch { return null; }
  }

  async fetchActiveSessions() {
    try {
      const r = await fetch('/api/sessions?status=active');
      if (!r.ok) return [];
      const body = await r.json();
      return Array.isArray(body?.items) ? body.items : [];
    } catch { return []; }
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

  /** Listen for server-sent 'artifacts' change events and reload comments
   *  when the agent replies via artifact.comment_reply. Debounced to avoid
   *  rapid re-renders during bulk replies. */
  wireSSERefresh() {
    try {
      const es = new EventSource('/api/events');
      const refresh = debounce(async () => {
        await this.loadDrafts();
        await this.renderHighlights();
        this.renderCards();
      }, 500);
      es.addEventListener('change', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data?.topic === 'artifacts') refresh();
        } catch { /* ignore malformed */ }
      });
    } catch (err) {
      console.warn('[cdb] SSE refresh wiring failed', err);
    }
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

  // ---------------------------------------------------------------------------
  // Element-click capture (img, mermaid SVG, pre code blocks)
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

      let blob, att;
      try {
        blob = await this.captureElement(target, elementKind);
        if (!blob) throw new Error('Could not capture this element to an image.');
        att = await this.uploadAttachment(blob);
      } catch (err) {
        console.warn('[cdb] element capture failed', err);
        alert(`Could not save comment: ${err?.message ?? err}`);
        return;
      }
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
      startX = undefined;  // reset so a re-armed drag doesn't start from a stale point
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

      let blob, att;
      try {
        blob = await regionToBlob(document.documentElement, { x, y, w, h });
        if (!blob) throw new Error('Could not capture region.');
        att = await this.uploadAttachment(blob);
      } catch (err) {
        console.warn('[cdb] region capture failed', err);
        alert(`Could not save region comment: ${err?.message ?? err}`);
        return;
      }
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
      if (wasActive && e.altKey) onKeyDown({ key: 'Alt', repeat: false });
    };

    const forceTeardown = () => {
      if (!active) return;
      active = false;
      layer?.remove();
      layer = null; box = null;
      startX = undefined;
    };
    window.addEventListener('blur', forceTeardown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  findSectionAtViewportPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return '';
    return this.nearestHeading(el);
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
  const html2canvas = await loadHtml2Canvas();
  const canvas = await html2canvas(el, {
    backgroundColor: '#15171d', logging: false, useCORS: true, scale: window.devicePixelRatio || 1,
  });
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function regionToBlob(rootEl, { x, y, w, h }) {
  const html2canvas = await loadHtml2Canvas();
  const canvas = await html2canvas(rootEl, {
    backgroundColor: '#15171d', logging: false, useCORS: true,
    x, y, width: w, height: h, windowWidth: document.documentElement.scrollWidth,
    scale: window.devicePixelRatio || 1,
  });
  return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
