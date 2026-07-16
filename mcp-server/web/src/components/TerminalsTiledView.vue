<script setup lang="ts">
/**
 * TerminalsTiledView — workspace-scoped, INTERACTIVE tiled view.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  [project (main)] [ws_abc] [ws_def] [ad-hoc / tmux]        │ ← ws picker
 *   ├──────────────────────┬─────────────────────────────────────┤
 *   │                      │                                     │
 *   │   main agent xterm   │      ws_abc agent xterm             │
 *   │                      │                                     │
 *   ├──────────────────────┴─────────────────────────────────────┤
 *
 * Only the active workspace's tiles render; clicking a workspace tab
 * swaps the grid. Within the grid:
 *   - Tiles are interactive (focus on click → keystrokes go to that
 *     session's pty).
 *   - Tile order is user-rearrangeable: drag a tile's header onto
 *     another tile's header to swap positions. Order persists per
 *     workspace in localStorage.
 *   - Column widths are user-resizable: a draggable gutter sits
 *     between adjacent columns; mousedown + drag adjusts the two
 *     adjacent `fr` ratios. Persists per (workspace, colCount).
 *
 * The dynamic colCount (cmux-style: 1/2/3-4/5-6/7-9 → 1×1, 1×2, 2×2,
 * 3×2, 3×3) is the DEFAULT layout for a given session count; the
 * resize gutters then let the user fine-tune relative widths.
 */
import { computed, nextTick, ref, watch } from 'vue';
import TerminalTile from './TerminalTile.vue';
import type { Session } from '../api';

const props = defineProps<{
  sessions: Session[];
}>();
const emit = defineEmits<{
  (e: 'focus-session', instanceId: string): void;
}>();

interface Group {
  workspaceId: string;
  label: string;
  sessions: Session[];
}

// ──── Persistence: workspace selection, tile order, col ratios ──────
// Declared BEFORE `groups` because `groups` reads tileOrder synchronously
// during its initial computation — referencing a `ref` before it's
// initialised is a temporal-dead-zone error that crashes the whole
// component, not a lazy-evaluation bug Vue can hide.
const SELECTED_WS_KEY = 'clawdevbox.terminals.tiled.selectedWs';
const TILE_ORDER_KEY = 'clawdevbox.terminals.tiled.tileOrder';
const COL_RATIOS_KEY = 'clawdevbox.terminals.tiled.colRatios';

const selectedWs = ref<string | null>(((): string | null => {
  try { return localStorage.getItem(SELECTED_WS_KEY); } catch { return null; }
})());
const tileOrder = ref<Record<string, string[]>>(((): Record<string, string[]> => {
  try {
    const raw = localStorage.getItem(TILE_ORDER_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
})());
const colRatios = ref<Record<string, Record<number, number[]>>>(((): Record<string, Record<number, number[]>> => {
  try {
    const raw = localStorage.getItem(COL_RATIOS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
})());

function persistTileOrder(): void {
  try { localStorage.setItem(TILE_ORDER_KEY, JSON.stringify(tileOrder.value)); } catch { /* */ }
}
function persistColRatios(): void {
  try { localStorage.setItem(COL_RATIOS_KEY, JSON.stringify(colRatios.value)); } catch { /* */ }
}

/**
 * Workspace grouping + ordering: project (main) → named workspaces
 * alphabetical → ad-hoc / tmux last. Within a group, sessions are
 * initially sorted by started_at descending (newest first) but then
 * permuted by the user's persisted tileOrder if one exists.
 */
const groups = computed<Group[]>(() => {
  const byWs = new Map<string, Session[]>();
  for (const s of props.sessions) {
    const wsId = s.workspace_id || 'unknown';
    if (!byWs.has(wsId)) byWs.set(wsId, []);
    byWs.get(wsId)!.push(s);
  }
  const out: Group[] = [];
  for (const [wsId, list] of byWs.entries()) {
    list.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
    let label: string;
    if (wsId === 'project') label = 'project (main)';
    else if (!wsId || wsId === 'unknown') label = 'ad-hoc / tmux';
    else label = wsId;
    const order = tileOrder.value[wsId] ?? [];
    if (order.length > 0) {
      const indexOf = new Map<string, number>();
      order.forEach((id, i) => indexOf.set(id, i));
      list.sort((a, b) => {
        const ai = indexOf.get(a.instance_id);
        const bi = indexOf.get(b.instance_id);
        if (ai != null && bi != null) return ai - bi;
        if (ai != null) return -1;
        if (bi != null) return 1;
        return 0;
      });
    }
    out.push({ workspaceId: wsId, label, sessions: list });
  }
  out.sort((a, b) => {
    if (a.workspaceId === 'project') return -1;
    if (b.workspaceId === 'project') return 1;
    const aUnknown = !a.workspaceId || a.workspaceId === 'unknown';
    const bUnknown = !b.workspaceId || b.workspaceId === 'unknown';
    if (aUnknown && !bUnknown) return 1;
    if (bUnknown && !aUnknown) return -1;
    return a.workspaceId.localeCompare(b.workspaceId);
  });
  return out;
});

const activeGroup = computed<Group | null>(() => {
  const list = groups.value;
  if (list.length === 0) return null;
  if (selectedWs.value) {
    const match = list.find((g) => g.workspaceId === selectedWs.value);
    if (match) return match;
  }
  return list[0];
});

watch(activeGroup, (g) => {
  if (!g) return;
  selectedWs.value = g.workspaceId;
  try { localStorage.setItem(SELECTED_WS_KEY, g.workspaceId); } catch { /* */ }
}, { flush: 'post' });

function selectWs(id: string): void {
  selectedWs.value = id;
  try { localStorage.setItem(SELECTED_WS_KEY, id); } catch { /* */ }
}

function swapTiles(wsId: string, a: string, b: string): void {
  if (a === b) return;
  const g = groups.value.find((x) => x.workspaceId === wsId);
  if (!g) return;
  const ids = g.sessions.map((s) => s.instance_id);
  const ai = ids.indexOf(a);
  const bi = ids.indexOf(b);
  if (ai < 0 || bi < 0) return;
  [ids[ai], ids[bi]] = [ids[bi], ids[ai]];
  tileOrder.value = { ...tileOrder.value, [wsId]: ids };
  persistTileOrder();
}

function colsFor(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

const activeColCount = computed(() =>
  activeGroup.value ? colsFor(activeGroup.value.sessions.length) : 1,
);
const activeRatios = computed<number[]>(() => {
  const g = activeGroup.value;
  if (!g) return [];
  const stored = colRatios.value[g.workspaceId]?.[activeColCount.value];
  if (stored && stored.length === activeColCount.value) return stored;
  // Default: every column an equal 1fr share.
  return Array(activeColCount.value).fill(1);
});
const gridTemplateColumns = computed(() =>
  activeRatios.value.map((r) => r.toFixed(4) + 'fr').join(' '),
);

/**
 * X coordinate (in %, relative to .tiled-grid's width) of the gutter
 * SITTING BETWEEN columns `idx` and `idx + 1`. Computed from the
 * cumulative sum of ratios so it tracks the actual column boundary
 * even when the user has dragged a column wider.
 */
function gutterLeftPercent(idx: number): number {
  const ratios = activeRatios.value;
  const total = ratios.reduce((a, b) => a + b, 0) || 1;
  let cum = 0;
  for (let i = 0; i <= idx; i++) cum += ratios[i];
  return (cum / total) * 100;
}

function setRatios(wsId: string, count: number, ratios: number[]): void {
  const byWs = { ...(colRatios.value[wsId] ?? {}) };
  byWs[count] = ratios;
  colRatios.value = { ...colRatios.value, [wsId]: byWs };
  persistColRatios();
}

// ──── Column gutter drag (resize) ───────────────────────────────────
const gridEl = ref<HTMLDivElement | null>(null);
let dragGutterIdx = -1;          // which gutter (between cols i and i+1)
let dragGutterStartX = 0;
let dragRatiosAtStart: number[] = [];
let dragGridWidth = 0;
function onGutterMouseDown(e: MouseEvent, idx: number): void {
  if (!gridEl.value || !activeGroup.value) return;
  dragGutterIdx = idx;
  dragGutterStartX = e.clientX;
  dragRatiosAtStart = [...activeRatios.value];
  dragGridWidth = gridEl.value.clientWidth;
  e.preventDefault();
  window.addEventListener('mousemove', onGutterDrag);
  window.addEventListener('mouseup', onGutterUp);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}
function onGutterDrag(e: MouseEvent): void {
  if (dragGutterIdx < 0 || !activeGroup.value || dragGridWidth <= 0) return;
  const totalFr = dragRatiosAtStart.reduce((a, b) => a + b, 0);
  const dxPx = e.clientX - dragGutterStartX;
  const dxFr = (dxPx / dragGridWidth) * totalFr;
  const next = [...dragRatiosAtStart];
  // Move one unit of fr from the right column into the left column
  // (or vice versa). Floor at 0.1 fr per column so the user can't
  // squash a column to invisibility.
  const left = next[dragGutterIdx] + dxFr;
  const right = next[dragGutterIdx + 1] - dxFr;
  if (left < 0.1 || right < 0.1) return;
  next[dragGutterIdx] = left;
  next[dragGutterIdx + 1] = right;
  setRatios(activeGroup.value.workspaceId, activeColCount.value, next);
}
function onGutterUp(): void {
  window.removeEventListener('mousemove', onGutterDrag);
  window.removeEventListener('mouseup', onGutterUp);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  dragGutterIdx = -1;
  // The .term-tile's ResizeObserver will pick up the new width and
  // refit xterm — no explicit dispatch needed. But fire a synthetic
  // resize for belt-and-suspenders parity with manual window resizes.
  nextTick(() => window.dispatchEvent(new Event('resize')));
}

// ──── HTML5 drag and drop: swap tiles by header drag ───────────────
const draggingId = ref<string | null>(null);
const dropTargetId = ref<string | null>(null);
function onTileDragStart(e: DragEvent, instanceId: string): void {
  draggingId.value = instanceId;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', instanceId); } catch { /* */ }
  }
}
function onTileDragOver(e: DragEvent, instanceId: string): void {
  if (!draggingId.value || draggingId.value === instanceId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
}
function onTileDragEnter(instanceId: string): void {
  if (draggingId.value && draggingId.value !== instanceId) {
    dropTargetId.value = instanceId;
  }
}
function onTileDragLeave(instanceId: string): void {
  if (dropTargetId.value === instanceId) dropTargetId.value = null;
}
function onTileDrop(e: DragEvent, instanceId: string): void {
  e.preventDefault();
  if (!draggingId.value || !activeGroup.value) return;
  swapTiles(activeGroup.value.workspaceId, draggingId.value, instanceId);
  draggingId.value = null;
  dropTargetId.value = null;
}
function onTileDragEnd(): void {
  draggingId.value = null;
  dropTargetId.value = null;
}

function tileLabel(s: Session): string {
  const taskTitle = (s.task_title ?? '').trim();
  if (taskTitle) return taskTitle;
  if (s.label) return s.label;
  return s.instance_id;
}
</script>

<template>
  <div class="tiled-view">
    <div v-if="groups.length === 0" class="tiled-empty">
      <i class="pi pi-microchip-ai tiled-empty__icon" />
      <div>No live terminals to tile.</div>
    </div>

    <nav v-else class="ws-picker" role="tablist" aria-label="Workspaces">
      <button
        v-for="g in groups"
        :key="g.workspaceId"
        type="button"
        role="tab"
        class="ws-picker__btn"
        :class="{ 'is-active': activeGroup && g.workspaceId === activeGroup.workspaceId }"
        :aria-selected="!!(activeGroup && g.workspaceId === activeGroup.workspaceId)"
        :title="g.workspaceId === 'project' ? 'Main agent + project-scoped sessions' : g.label"
        @click="selectWs(g.workspaceId)"
      >
        <i class="pi pi-folder ws-picker__icon" />
        <span class="ws-picker__label">{{ g.label }}</span>
        <span class="ws-picker__count">{{ g.sessions.length }}</span>
      </button>
    </nav>

    <div
      v-if="activeGroup"
      ref="gridEl"
      class="tiled-grid"
      :style="{ gridTemplateColumns }"
    >
      <div
        v-for="s in activeGroup.sessions"
        :key="s.instance_id"
        class="tile-slot"
        :class="{ 'is-dragging': draggingId === s.instance_id, 'is-drop-target': dropTargetId === s.instance_id }"
        @dragover="onTileDragOver($event, s.instance_id)"
        @dragenter="onTileDragEnter(s.instance_id)"
        @dragleave="onTileDragLeave(s.instance_id)"
        @drop="onTileDrop($event, s.instance_id)"
      >
        <!-- Tile chrome — this small bar is the HTML5 drag source for
             reorder. The xterm body underneath is left UNdraggable so
             keystrokes / mouse selection inside the terminal work
             normally. Drag this header to another tile to swap them. -->
        <header
          class="tile-slot__head"
          draggable="true"
          @dragstart="onTileDragStart($event, s.instance_id)"
          @dragend="onTileDragEnd"
          :title="tileLabel(s) + ' — drag to reorder'"
        >
          <i class="pi pi-bars tile-slot__grip" />
          <span class="tile-slot__label">{{ tileLabel(s) }}</span>
          <button
            type="button"
            class="tile-slot__btn"
            title="Maximize: open this terminal in the full single-pane view"
            @click.stop="emit('focus-session', s.instance_id)"
            @mousedown.stop
          >
            <i class="pi pi-window-maximize" />
          </button>
        </header>
        <TerminalTile
          :session-id="s.instance_id"
          :label="tileLabel(s)"
          :hide-header="true"
        />
      </div>
      <!-- Column resize gutters — rendered AFTER the tiles and
           position-absolute over the grid, so they DON'T consume grid
           cells. (When they were grid children, the auto-flow placed
           them in cells and staircased every tile into its own row.)
           Each gutter sits centered on a column boundary, computed from
           the cumulative ratio sum and the grid's actual pixel width. -->
      <div
        v-for="i in activeColCount - 1"
        :key="`gutter-${i}`"
        class="col-gutter"
        :style="{ left: gutterLeftPercent(i - 1) + '%' }"
        :title="'Drag to resize columns'"
        @mousedown="onGutterMouseDown($event, i - 1)"
      />
    </div>
  </div>
</template>

<style scoped>
.tiled-view {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #14161b;
  overflow: hidden;
}

.tiled-empty {
  margin: auto;
  color: var(--p-text-color-secondary);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.tiled-empty__icon { font-size: 32px; opacity: 0.4; }

.ws-picker {
  display: flex;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  background: #181b22;
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.ws-picker__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--p-text-color-secondary, #99a3b3);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.ws-picker__btn:hover { background: #1c1f27; color: var(--p-text-color); }
.ws-picker__btn.is-active {
  background: #232733;
  color: var(--p-text-color);
  border-color: var(--p-primary-color, #88c0d0);
}
.ws-picker__icon { font-size: 10px; }
.ws-picker__label {
  font-weight: 500;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ws-picker__count {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: #2a2e38;
  color: #c0c5ce;
}
.ws-picker__btn.is-active .ws-picker__count {
  background: var(--p-primary-color, #88c0d0);
  color: #14161b;
}

.tiled-grid {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  gap: 6px;
  padding: 6px;
  grid-auto-rows: 1fr;
  position: relative;
}
.tile-slot {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #15171d;
  border: 1px solid #1f222a;
  border-radius: 4px;
  overflow: hidden;
  transition: border-color 120ms ease, opacity 120ms ease;
}
.tile-slot:focus-within { border-color: var(--p-primary-color, #88c0d0); }
.tile-slot.is-dragging { opacity: 0.45; }
.tile-slot.is-drop-target {
  border-color: var(--p-primary-color, #88c0d0);
  box-shadow: inset 0 0 0 1px var(--p-primary-color, #88c0d0);
}

/* Tile chrome — small bar at the top that doubles as the HTML5 drag
 * handle for tile reordering. Keeps the xterm body below free of any
 * drag-source attributes so keystrokes / mouse selection work normally. */
.tile-slot__head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--p-text-color-secondary, #c0c5ce);
  padding: 2px 4px 2px 6px;
  border-bottom: 1px solid #1f222a;
  background: #181b22;
  flex-shrink: 0;
  cursor: grab;
  user-select: none;
}
.tile-slot__head:active { cursor: grabbing; }
.tile-slot__grip {
  font-size: 10px;
  opacity: 0.55;
}
.tile-slot__label {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-slot__btn {
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
.tile-slot__btn:hover { background: #2a2e38; color: var(--p-text-color); }
.tile-slot__btn i { font-size: 10px; }

/* Make TerminalTile fill the slot now that the slot owns the header. */
.tile-slot :deep(.term-tile) {
  flex: 1 1 auto;
  border: none;
  border-radius: 0;
  background: #15171d;
}

/* Column resize gutter — absolutely positioned overlay so it does
 * NOT consume a grid cell (which would staircase the tile layout).
 * Centered on the column boundary computed from the cumulative
 * ratio sum. Spans the entire grid height. */
.col-gutter {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 8px;
  /* Centered on the column boundary — translate -50% of own width. */
  transform: translateX(-50%);
  cursor: col-resize;
  z-index: 2;
  background: transparent;
  transition: background 120ms ease;
}
.col-gutter:hover { background: rgba(136, 192, 208, 0.25); }
.col-gutter:active { background: var(--p-primary-color, #88c0d0); }
</style>


