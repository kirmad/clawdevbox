<script setup lang="ts">
/**
 * TerminalTile — a single INTERACTIVE xterm bound to one session's
 * pty WebSocket, sized to fill its container.
 *
 * Designed for the Terminals tab's "Tiles" view, where many tiles
 * render simultaneously inside a CSS grid. Each tile takes keyboard
 * focus on click and forwards keystrokes to its session's pty via the
 * standard WS contract (same as TerminalsPanel's single-terminal view).
 * A "maximize" button in the tile header is the explicit way to switch
 * to the full-screen single-terminal interactive view — clicking the
 * tile body itself just focuses the embedded xterm so the user can
 * type into it in-place.
 *
 * Lifecycle mirrors TerminalsPanel's proven attach pattern:
 *   - Race-safe via attachGen monotonic counter.
 *   - rAF-poll for STABLE dimensions across 2 consecutive frames
 *     before opening the WS so initial cols/rows match the final
 *     layout (avoids the "renders at half height until you resize"
 *     class of bug).
 *   - ResizeObserver + window-resize feed debounced scheduleRefit.
 *
 * Renderer: Canvas (not WebGL) because (a) one WebGL context per tile
 * saturates GPU memory above ~6 tiles on Intel iGPUs, and (b) Canvas
 * is plenty fast for typical tile sizes.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';

const props = defineProps<{
  sessionId: string;
  /** Optional label shown in the tile chrome (e.g. session task title). */
  label?: string;
  /** Fires when the user explicitly clicks the "maximize" button in the
   *  tile header. TerminalsPanel uses this to switch back to the
   *  full-screen single-terminal view focused on this session. */
  onMaximizeRequest?: () => void;
  /** When true, the component renders ONLY the xterm host — no header
   *  bar. TerminalsTiledView uses this so its parent .tile-slot can
   *  draw its own header (which doubles as the HTML5 drag handle for
   *  tile reordering). */
  hideHeader?: boolean;
}>();

const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObs: ResizeObserver | null = null;
let onWindowResize: (() => void) | null = null;
let attachGen = 0;
let refitTimer: ReturnType<typeof setTimeout> | null = null;

function refit(): void {
  if (!term || !fit || !termHost.value) return;
  const host = termHost.value;
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  try { fit.fit(); } catch { /* layout not stable */ }
}
function scheduleRefit(): void {
  if (refitTimer) clearTimeout(refitTimer);
  refitTimer = setTimeout(() => { refitTimer = null; refit(); }, 100);
}

async function teardown(): Promise<void> {
  if (refitTimer) { clearTimeout(refitTimer); refitTimer = null; }
  if (resizeObs) { try { resizeObs.disconnect(); } catch { /* */ } resizeObs = null; }
  if (onWindowResize) { window.removeEventListener('resize', onWindowResize); onWindowResize = null; }
  if (ws) {
    try { ws.onmessage = null; ws.onopen = null; ws.onclose = null; ws.onerror = null; } catch { /* */ }
    try { ws.close(); } catch { /* */ }
    ws = null;
  }
  if (term) { try { term.dispose(); } catch { /* */ } term = null; }
  fit = null;
}

async function attach(): Promise<void> {
  if (!termHost.value || !props.sessionId) return;
  const myGen = ++attachGen;
  await teardown();
  if (attachGen !== myGen) return;

  const localTerm = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, "Liberation Mono", Cascadia Code, ui-monospace, Menlo, monospace',
    fontSize: 11,
    scrollback: 1000,
    theme: { background: '#15171d', foreground: '#d8dee9' },
  });
  const localFit = new FitAddon();
  localTerm.loadAddon(localFit);
  if (!termHost.value) { localTerm.dispose(); return; }
  localTerm.open(termHost.value);
  try { localTerm.loadAddon(new CanvasAddon()); } catch { /* fall back to DOM renderer */ }

  await nextTick();
  if (attachGen !== myGen) { localTerm.dispose(); return; }

  // Stability-based rAF poll — same pattern as MainAgentPanel.
  let initCols = 0;
  let initRows = 0;
  let prevCols = 0;
  let prevRows = 0;
  for (let i = 0; i < 16; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (attachGen !== myGen) { localTerm.dispose(); return; }
    const h2 = termHost.value;
    if (!h2 || h2.clientWidth === 0 || h2.clientHeight === 0) continue;
    try { localFit.fit(); } catch { continue; }
    const c = localTerm.cols, r = localTerm.rows;
    if (c < 20 || r < 5 || c === 80) {
      prevCols = c; prevRows = r;
      continue;
    }
    if (c === prevCols && r === prevRows) {
      initCols = c; initRows = r;
      break;
    }
    prevCols = c; prevRows = r;
    initCols = c; initRows = r;
  }
  if (initCols === 0) { initCols = 80; initRows = 24; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const localWs = new WebSocket(
    `${proto}//${location.host}/terminal/${encodeURIComponent(props.sessionId)}/ws?cols=${initCols}&rows=${initRows}`,
  );

  localTerm.onResize(({ cols, rows }) => {
    if (localWs.readyState === 1) {
      try { localWs.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* */ }
    }
  });

  localWs.onmessage = (ev) => {
    let msg: { type?: string; content?: string; chunk?: string };
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot' && msg.content) localTerm.write(msg.content);
    if (msg.type === 'data' && msg.chunk) localTerm.write(msg.chunk);
  };

  // Forward keystrokes from the tile's xterm to the backend pty —
  // this is what makes the tile INTERACTIVE (previously we set
  // disableStdin so tiles were read-only previews; the user pointed
  // out that you should be able to type into a tile without first
  // switching back to single-terminal mode).
  localTerm.onData((d) => {
    if (localWs.readyState === 1) {
      try { localWs.send(JSON.stringify({ type: 'input', data: d })); } catch { /* */ }
    }
  });

  if (attachGen !== myGen) {
    try { localWs.close(); } catch { /* */ }
    try { localTerm.dispose(); } catch { /* */ }
    return;
  }

  term = localTerm;
  fit = localFit;
  ws = localWs;

  const localResizeObs = new ResizeObserver(() => scheduleRefit());
  if (termHost.value) localResizeObs.observe(termHost.value);
  resizeObs = localResizeObs;
  onWindowResize = () => scheduleRefit();
  window.addEventListener('resize', onWindowResize);
}

onMounted(() => { void attach(); });
onBeforeUnmount(() => { void teardown(); });
watch(() => props.sessionId, () => { void attach(); });

/**
 * Click anywhere on the tile body → focus the xterm so keystrokes
 * land in this session. Standard browser focus behaviour (xterm
 * listens on its own textarea proxy), so multiple tiles share
 * keyboard focus the same way multiple iframes do — last clicked
 * wins, document.activeElement tracks it.
 */
function focusTerm(): void {
  if (term) {
    try { term.focus(); } catch { /* */ }
  }
}

function onMaximize(e: MouseEvent): void {
  e.stopPropagation();
  props.onMaximizeRequest?.();
}
</script>

<template>
  <div class="term-tile" @mousedown="focusTerm">
    <header v-if="!hideHeader" class="term-tile__head">
      <span class="term-tile__label" :title="label">{{ label || '—' }}</span>
      <button
        v-if="onMaximizeRequest"
        type="button"
        class="term-tile__btn"
        title="Maximize: open this terminal in the full single-pane view"
        @click="onMaximize"
        @mousedown.stop
      >
        <i class="pi pi-window-maximize" />
      </button>
    </header>
    <div class="term-tile__host" ref="termHost" />
  </div>
</template>

<style scoped>
.term-tile {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: #15171d;
  border: 1px solid #1f222a;
  border-radius: 4px;
  overflow: hidden;
  transition: border-color 120ms ease;
}
.term-tile:hover { border-color: #2a3344; }
.term-tile:focus-within { border-color: var(--p-primary-color, #88c0d0); }
.term-tile__head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--p-text-color-secondary, #c0c5ce);
  padding: 2px 4px 2px 8px;
  border-bottom: 1px solid #1f222a;
  flex-shrink: 0;
  background: #181b22;
}
.term-tile__label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.term-tile__btn {
  background: transparent;
  border: none;
  color: var(--p-text-color-secondary, #99a3b3);
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 3px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.term-tile__btn:hover { background: #2a2e38; color: var(--p-text-color); }
.term-tile__btn i { font-size: 10px; }
.term-tile__host {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  overflow: hidden;
  padding: 2px;
  box-sizing: border-box;
}
.term-tile__host :deep(.xterm-viewport) { scrollbar-width: none; -ms-overflow-style: none; }
.term-tile__host :deep(.xterm-viewport)::-webkit-scrollbar { width: 0; height: 0; display: none; }
</style>

