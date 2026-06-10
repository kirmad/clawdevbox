<script setup lang="ts">
/**
 * TerminalsPanel — multi-session terminal view.
 *
 * Left column: vertical tab list (active sessions on top, archived
 * below in a collapsible time-paginated section).
 * Right column: xterm.js attached to the selected session's WS.
 *
 * Reuses the xterm.js setup pattern from AgentPanel.vue.
 * Subscribes to the 'sessions' topic via realtime.ts for live updates.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import type { Session } from '../api';
import { fetchAgentClis, type AgentCliInfo } from '../api';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import ResizeHandle from './ResizeHandle.vue';
import SessionSidePanel from './SessionSidePanel.vue';

const store = useUiStore();
const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObs: ResizeObserver | null = null;
let onWindowResize: (() => void) | null = null;
// Monotonic token to detect concurrent attach() calls. If another attach()
// bumps this between awaits, the older call bails out instead of clobbering
// module-level refs. A previous race here registered TWO term.onData handlers
// on the same Terminal, producing the "every keystroke shows up twice" bug.
let attachGen = 0;

const selectedId = computed(() => store.terminals.selectedInstanceId);
const activeSessions = computed(() => store.terminals.items.filter((s) => s.live));
const selectedSession = computed<Session | null>(
  () => store.terminals.items.find((s) => s.instance_id === selectedId.value) ?? null,
);
const recentArchived = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return store.terminals.items.filter((s) => !s.live && (s.ended_at ?? s.started_at) >= cutoff);
});
const olderArchived = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return store.terminals.items.filter((s) => !s.live && (s.ended_at ?? s.started_at) < cutoff);
});

// ---------------------------------------------------------------------------
// Resizable layout — tab-list width + side-panel width are user-draggable,
// persisted to localStorage, and trigger xterm refit via the existing
// ResizeObserver on .xterm-host.
// ---------------------------------------------------------------------------
const LS_TAB_WIDTH = 'clawdevbox.terminals.tabListWidth';
const LS_SIDE_WIDTH = 'clawdevbox.terminals.sidePanelWidth';
const LS_SIDE_COLLAPSED = 'clawdevbox.terminals.sideCollapsed';

function loadWidth(key: string, def: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    if (Number.isFinite(v) && v >= min && v <= max) return v;
  } catch { /* ignore */ }
  return def;
}
function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
  } catch { /* ignore */ }
  return def;
}
const tabListWidth = ref<number>(loadWidth(LS_TAB_WIDTH, 280, 180, 600));
const sidePanelWidth = ref<number>(loadWidth(LS_SIDE_WIDTH, 360, 240, 900));
// Start COLLAPSED by default — the side panel covers ≈360px of horizontal
// space and the terminal needs every column it can get for clean rendering
// of wide TUI output (copilot's box drawing, multi-column lists, etc.).
// User's toggle is persisted to localStorage so subsequent sessions remember
// their preference.
const sideCollapsed = ref<boolean>(loadBool(LS_SIDE_COLLAPSED, true));
watch(tabListWidth, (v) => { try { localStorage.setItem(LS_TAB_WIDTH, String(v)); } catch { /* ignore */ } });
watch(sidePanelWidth, (v) => { try { localStorage.setItem(LS_SIDE_WIDTH, String(v)); } catch { /* ignore */ } });
watch(sideCollapsed, (v) => {
  try { localStorage.setItem(LS_SIDE_COLLAPSED, v ? '1' : '0'); } catch { /* ignore */ }
  // Resize the xterm + underlying pty when the side panel toggles. Debounced
  // (200ms) so a flurry of mid-animation layout ticks coalesces into ONE
  // resize message — that's what avoids the tmux re-flow garble we saw
  // when ResizeObserver fired ~20 times per drag.
  scheduleRefit();
});


function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function iconFor(kind: Session['kind']): string {
  if (kind === 'main') return 'pi pi-microchip';
  if (kind === 'recipe') return 'pi pi-book';
  if (kind === 'foreign') return 'pi pi-globe';
  return 'pi pi-bolt';
}

/**
 * Compute a CSS class for the row's kind-icon that conveys live agent state.
 * The base icon stays the same (preserves at-a-glance "what kind of session")
 * while color + animation reflect the agent's current activity:
 *   - idle      → dim green, no animation
 *   - thinking  → yellow, pulse
 *   - tool_use  → orange, spin
 *   - waiting   → bright yellow, bounce + halo (operator action needed)
 *   - error     → red, no animation
 *   - exited    → grey, no animation
 *   - foreign   → grey, no animation
 *   - other     → blue (running/unknown/etc.)
 */
function iconStateClass(state: Session['state']): string {
  return `icon-state-${state}`;
}

/** Human-readable label for the title tooltip. */
function stateLabel(state: Session['state']): string {
  switch (state) {
    case 'idle': return 'Idle — ready for input';
    case 'thinking': return 'Thinking…';
    case 'tool_use': return 'Using a tool…';
    case 'waiting': return 'Waiting on you';
    case 'error': return 'Error';
    case 'busy': return 'Busy';
    case 'starting': return 'Starting…';
    case 'running': return 'Running';
    case 'exited': return 'Exited';
    case 'archived': return 'Archived';
    case 'needs_user_input': return 'Needs your input';
    case 'foreign': return 'Foreign tmux session';
    case 'unknown':
    default: return 'Unknown';
  }
}

function stateClass(state: Session['state']): string {
  return `state-dot state-${state}`;
}

/**
 * Top-line label for a tab. Prefers the agent-self-set task_title; falls
 * back to the spawn label ("Spawn xxx_yyy"). Always a non-empty string.
 */
function tabLine1(s: Session): string {
  return s.task_title || s.label || 'Untitled session';
}

/**
 * Second line: the current sub-goal if set. Empty string when not set
 * (template uses v-if to hide the row entirely).
 */
function tabLine2(s: Session): string {
  return s.subtask_title || '';
}

/**
 * Third line: brief status + provider + age. Agent-self-set status falls
 * back to the derived state label (e.g. "Thinking…") when not set.
 */
function tabLine3(s: Session): string {
  const status = s.status_text || stateLabel(s.state);
  const provider = s.provider_id ?? (s.kind === 'foreign' ? '(foreign tmux)' : '—');
  return `${status} · ${provider}`;
}

/**
 * Try to load a GPU-accelerated renderer. Preference: WebGL -> Canvas -> DOM
 * (default xterm fallback). xterm.js's WebGL addon handles tmux's aggressive
 * redraws far better than the DOM renderer (which mounts/unmounts thousands
 * of nodes per frame). On WebGL context-loss (driver crash, tab suspend),
 * we dispose the addon and xterm transparently falls back to DOM.
 */
function loadAcceleratedRenderer(t: Terminal): 'webgl' | 'canvas' | 'dom' {
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => { try { addon.dispose(); } catch { /* */ } });
    t.loadAddon(addon);
    return 'webgl';
  } catch { /* WebGL2 unavailable */ }
  try {
    const addon = new CanvasAddon();
    t.loadAddon(addon);
    return 'canvas';
  } catch { /* fall through to DOM */ }
  return 'dom';
}

/**
 * Refit xterm to its host's current pixel size. fit.fit() updates
 * term.cols/term.rows; if those change, the `term.onResize` listener
 * registered in attach() automatically sends a {type:'resize'} WS message
 * which reaches ipty.resize() on the backend. Skip when host is hidden so
 * we don't shrink the live pty to xterm's 80x24 default.
 */
let refitTimer: ReturnType<typeof setTimeout> | null = null;

function refit(): void {
  if (!term || !fit || !termHost.value) return;
  const host = termHost.value;
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  try { fit.fit(); } catch { /* layout not stable yet */ }
}

function scheduleRefit(): void {
  if (refitTimer) clearTimeout(refitTimer);
  refitTimer = setTimeout(() => { refitTimer = null; refit(); }, 150);
}

async function teardown(): Promise<void> {
  if (refitTimer) { clearTimeout(refitTimer); refitTimer = null; }
  if (resizeObs) { try { resizeObs.disconnect(); } catch {} resizeObs = null; }
  if (onWindowResize) { window.removeEventListener('resize', onWindowResize); onWindowResize = null; }
  if (ws) {
    try { ws.onmessage = null; ws.onopen = null; ws.onclose = null; ws.onerror = null; } catch {}
    try { ws.close(); } catch {}
    ws = null;
  }
  if (term) { try { term.dispose(); } catch {} term = null; }
  fit = null;
}

/**
 * Connect xterm to the selected session's pty via WebSocket.
 *
 * RACE-SAFE: attach() may be invoked twice in quick succession (onMounted's
 * `await attach()` plus a `watch(selectedId)` firing once
 * store.refreshTerminals resolves). Each call captures `attachGen` at
 * entry into `myGen`; after every await we check `attachGen !== myGen`
 * and bail. All resources stay in LOCAL vars (localTerm/localFit/localWs)
 * and only get committed to module-level refs at the very end. Before
 * this, two concurrent attaches would both call `term.onData(...)` on
 * the survivor's Terminal, doubling every keystroke.
 *
 * RESIZE: localTerm.onResize fires when fit.fit() changes the grid, and
 * sends the {type:'resize'} WS message. ResizeObserver/window-resize only
 * TRIGGER fit; if fit produces identical dims xterm doesn't fire onResize
 * and no message is sent (natural dedupe). This is the pattern xterm.js
 * docs recommend for tmux/node-pty backends.
 */
async function attach(): Promise<void> {
  if (!termHost.value || !selectedId.value) return;
  const myGen = ++attachGen;
  const targetId = selectedId.value;
  await teardown();
  if (attachGen !== myGen) return;

  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  const localTerm = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, "Liberation Mono", Cascadia Code, ui-monospace, Menlo, monospace',
    fontSize: isMobile ? 12 : 13,
    scrollback: 2000,
    theme: { background: '#15171d', foreground: '#d8dee9' },
  });
  const localFit = new FitAddon();
  localTerm.loadAddon(localFit);
  if (!termHost.value) { localTerm.dispose(); return; }
  localTerm.open(termHost.value);
  const renderer = loadAcceleratedRenderer(localTerm);
  // eslint-disable-next-line no-console
  console.log('[terminals-panel] renderer:', renderer);

  await nextTick();
  if (attachGen !== myGen) { localTerm.dispose(); return; }

  // rAF-poll until fit produces a real (non-default 80x24) measurement.
  let initCols = 120;
  let initRows = 30;
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (attachGen !== myGen) { localTerm.dispose(); return; }
    const host = termHost.value;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) continue;
    try { localFit.fit(); } catch { continue; }
    if (localTerm.cols >= 20 && localTerm.rows >= 5 && localTerm.cols != 80) {
      initCols = localTerm.cols;
      initRows = localTerm.rows;
      break;
    }
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const id = encodeURIComponent(targetId);
  const localWs = new WebSocket(
    `${proto}//${location.host}/terminal/${id}/ws?cols=${initCols}&rows=${initRows}`,
  );

  // term.onResize -> backend pty.resize. Fires whenever fit changes the
  // grid; xterm dedupes identical sizes natively so a no-op fit doesn't
  // produce a spurious message.
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

  // user keystroke -> backend pty. Single onData handler per Terminal.
  localTerm.onData((d) => {
    if (localWs.readyState === 1) {
      try { localWs.send(JSON.stringify({ type: 'input', data: d })); } catch { /* */ }
    }
  });

  // Final race check before committing to module-level refs. If a newer
  // attach() bumped attachGen during the rAF poll, tear down what we built
  // and let the newer call own the state.
  if (attachGen !== myGen) {
    try { localWs.close(); } catch {}
    try { localTerm.dispose(); } catch {}
    return;
  }

  // Commit. Module-level refs now point at the just-built Terminal/Fit/WS.
  term = localTerm;
  fit = localFit;
  ws = localWs;

  // Live resize: ResizeObserver + window-resize both feed scheduleRefit().
  // Debounced fit -> if dims changed, term.onResize sends the WS message.
  const localResizeObs = new ResizeObserver(() => scheduleRefit());
  if (termHost.value) localResizeObs.observe(termHost.value);
  resizeObs = localResizeObs;
  const localOnWindowResize = (): void => scheduleRefit();
  window.addEventListener('resize', localOnWindowResize);
  onWindowResize = localOnWindowResize;
}

function select(s: Session): void {
  store.selectTerminal(s.instance_id);
}

async function kill(s: Session): Promise<void> {
  if (s.kind === 'foreign') {
    const ok = window.confirm(`Kill foreign tmux session "${s.instance_id}"?\nThis is one of your own tmux sessions, not a clawdevbox spawn.`);
    if (!ok) return;
  } else {
    const ok = window.confirm(`Kill session "${s.label}" (${s.instance_id})?`);
    if (!ok) return;
  }
  try {
    await store.killTerminal(s.instance_id);
  } catch (err) {
    console.error('kill failed:', err);
  }
}

async function resume(s: Session): Promise<void> {
  try {
    await store.resumeTerminal(s.instance_id);
  } catch (err) {
    console.error('resume failed:', err);
  }
}

// --- Spawn dialog -----------------------------------------------------------
// + button next to "Active" opens this dialog. The user supplies a prompt
// (required) and optional alias / provider. The server auto-creates a
// workspace pinned to the resulting session_id.

const spawnOpen = ref(false);
const spawnPrompt = ref('');
const spawnAlias = ref('');
const spawnProvider = ref<string>('');
const spawnBusy = ref(false);
const spawnError = ref<string | null>(null);
const spawnProviders = ref<AgentCliInfo[]>([]);
const spawnConfigured = ref<string | null>(null);

async function openSpawn(): Promise<void> {
  spawnPrompt.value = '';
  spawnAlias.value = '';
  spawnError.value = null;
  spawnProvider.value = '';
  spawnOpen.value = true;
  try {
    const r = await fetchAgentClis();
    spawnProviders.value = r.providers.filter((p) => p.detect.available);
    spawnConfigured.value = r.configured ?? null;
    // Pre-select: server-configured default if available; else the only
    // available provider; else the first available provider. The server
    // rejects spawns with no provider and no `cfg.defaultAgentCli`, so
    // it's friendlier to pick a sensible default the user can override.
    if (r.configured && spawnProviders.value.some((p) => p.id === r.configured)) {
      spawnProvider.value = r.configured;
    } else if (spawnProviders.value.length >= 1) {
      spawnProvider.value = spawnProviders.value[0]!.id;
    }
  } catch (err) {
    // Non-fatal: user can still spawn with the server-default provider.
    console.warn('fetchAgentClis failed', err);
  }
}

async function submitSpawn(): Promise<void> {
  const prompt = spawnPrompt.value.trim();
  if (!prompt) return;
  spawnBusy.value = true;
  spawnError.value = null;
  try {
    await store.spawnTerminal({
      prompt,
      session_id: spawnAlias.value.trim() || undefined,
      provider: spawnProvider.value || undefined,
    });
    spawnOpen.value = false;
  } catch (err) {
    spawnError.value = err instanceof Error ? err.message : String(err);
  } finally {
    spawnBusy.value = false;
  }
}

onMounted(async () => {
  await store.refreshTerminals({ status: 'all' });
  await attach();
});

onBeforeUnmount(async () => {
  await teardown();
});

watch(selectedId, () => { attach(); });
</script>

<template>
  <div class="terminals-panel">
    <aside class="tab-list" :style="{ flexBasis: tabListWidth + 'px' }">
      <div class="group-header active-header">
        <span>Active</span>
        <button
          class="spawn-btn"
          title="Start a new session"
          aria-label="Start a new session"
          @click="openSpawn"
        >
          <i class="pi pi-plus" />
        </button>
      </div>
      <div v-if="activeSessions.length === 0" class="empty">No active terminals.</div>
      <button
        v-for="s in activeSessions"
        :key="s.instance_id"
        class="tab-row"
        :data-instance-id="s.instance_id"
        :class="{ selected: s.instance_id === selectedId, foreign: s.kind === 'foreign' }"
        @click="select(s)"
      >
        <div class="row-1">
          <i :class="[iconFor(s.kind), iconStateClass(s.state)]" :title="stateLabel(s.state)" />
          <span class="tab-task" :title="tabLine1(s)">{{ tabLine1(s) }}</span>
        </div>
        <div v-if="tabLine2(s)" class="row-subtask" :title="tabLine2(s)">{{ tabLine2(s) }}</div>
        <div class="row-status">
          <span :class="stateClass(s.state)" />
          <span class="muted">{{ tabLine3(s) }} · {{ relTime(s.started_at) }}</span>
        </div>
        <button
          v-if="s.instance_id !== 'main'"
          class="kill-btn"
          :class="{ 'kill-btn--foreign': s.kind === 'foreign' }"
          title="Kill session"
          @click.stop="kill(s)"
        >✕</button>
      </button>

      <details class="group" :open="store.terminals.archiveExpanded || recentArchived.length > 0">
        <summary class="group-header">Recent (24h)</summary>
        <button
          v-for="s in recentArchived"
          :key="s.instance_id"
          class="tab-row archived"
          :data-instance-id="s.instance_id"
          :class="{ selected: s.instance_id === selectedId }"
          @click="select(s)"
        >
          <div class="row-1">
            <i :class="[iconFor(s.kind), iconStateClass(s.state)]" :title="stateLabel(s.state)" />
            <span class="tab-task" :title="tabLine1(s)">{{ tabLine1(s) }}</span>
            <span v-if="s.end_reason === 'idle_reaped'" class="end-chip" title="Auto-reaped after 15 min idle with no viewer">reaped</span>
          </div>
          <div v-if="tabLine2(s)" class="row-subtask" :title="tabLine2(s)">{{ tabLine2(s) }}</div>
          <div class="row-status">
            <span :class="stateClass(s.state)" />
            <span class="muted">{{ tabLine3(s) }} · {{ relTime(s.ended_at ?? s.started_at) }}</span>
          </div>
          <button class="resume-btn" @click.stop="resume(s)">Resume</button>
        </button>
      </details>

      <details class="group">
        <summary class="group-header">Older</summary>
        <button
          v-for="s in olderArchived"
          :key="s.instance_id"
          class="tab-row archived"
          :data-instance-id="s.instance_id"
          :class="{ selected: s.instance_id === selectedId }"
          @click="select(s)"
        >
          <div class="row-1">
            <i :class="[iconFor(s.kind), iconStateClass(s.state)]" :title="stateLabel(s.state)" />
            <span class="tab-task" :title="tabLine1(s)">{{ tabLine1(s) }}</span>
            <span v-if="s.end_reason === 'idle_reaped'" class="end-chip" title="Auto-reaped after 15 min idle with no viewer">reaped</span>
          </div>
          <div v-if="tabLine2(s)" class="row-subtask" :title="tabLine2(s)">{{ tabLine2(s) }}</div>
          <div class="row-status">
            <span :class="stateClass(s.state)" />
            <span class="muted">{{ tabLine3(s) }} · {{ relTime(s.ended_at ?? s.started_at) }}</span>
          </div>
          <button class="resume-btn" @click.stop="resume(s)">Resume</button>
        </button>
        <button
          v-if="store.terminals.archiveCursor"
          class="load-more"
          @click="store.loadMoreArchive()"
        >Show more</button>
      </details>
    </aside>
    <ResizeHandle
      :width="tabListWidth"
      :min="180"
      :max="600"
      side="right"
      @update:width="(w) => (tabListWidth = w)"
    />
    <main class="xterm-host" ref="termHost" />
    <ResizeHandle
      v-if="selectedSession && !sideCollapsed"
      :width="sidePanelWidth"
      :min="240"
      :max="900"
      side="left"
      @update:width="(w) => (sidePanelWidth = w)"
    />
    <div
      v-if="selectedSession"
      class="side-pane-host"
      :style="sideCollapsed ? { flexBasis: '28px' } : { flexBasis: sidePanelWidth + 'px' }"
    >
      <SessionSidePanel
        :session="selectedSession"
        @update:collapsed="(v) => (sideCollapsed = v)"
      />
    </div>

    <Dialog
      :visible="spawnOpen"
      @update:visible="spawnOpen = $event"
      modal
      header="New session"
      :style="{ width: 'min(440px, 92vw)' }"
      :closable="!spawnBusy"
      :draggable="false"
    >
      <div class="spawn-form">
        <label class="field">
          <span class="field-label">First prompt <span class="req">*</span></span>
          <Textarea
            v-model="spawnPrompt"
            placeholder="What should the new agent work on?"
            rows="4"
            autoResize
            autofocus
            :disabled="spawnBusy"
            class="w-full"
          />
        </label>

        <label class="field">
          <span class="field-label">Alias <span class="hint">(optional)</span></span>
          <InputText
            v-model="spawnAlias"
            placeholder="e.g. refactor-auth, pr-4547615"
            :disabled="spawnBusy"
            class="w-full"
          />
          <span class="muted small">Friendly name for the session — lets you send follow-up prompts via session.send later.</span>
        </label>

        <label class="field" v-if="spawnProviders.length > 0">
          <span class="field-label">Provider</span>
          <Select
            v-model="spawnProvider"
            :options="spawnProviders"
            optionLabel="display_name"
            optionValue="id"
            :disabled="spawnBusy || spawnProviders.length < 2"
            class="w-full"
          />
          <span class="muted small" v-if="spawnConfigured">
            Server default: {{ spawnConfigured }}
          </span>
        </label>

        <div v-if="spawnError" class="spawn-error">
          <i class="pi pi-exclamation-triangle" /> {{ spawnError }}
        </div>
      </div>
      <template #footer>
        <Button
          label="Cancel"
          severity="secondary"
          size="small"
          :disabled="spawnBusy"
          @click="spawnOpen = false"
        />
        <Button
          :label="spawnBusy ? 'Spawning…' : 'Spawn'"
          icon="pi pi-play"
          size="small"
          severity="primary"
          :disabled="spawnBusy || !spawnPrompt.trim()"
          @click="submitSpawn"
        />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.terminals-panel { display: flex; height: 100%; width: 100%; min-height: 0; min-width: 0; }
.tab-list {
  flex: 0 0 auto;       /* width controlled via inline flex-basis */
  overflow-y: auto;
  overflow-x: hidden;
  border-right: 1px solid #23262d;
  padding: 8px 4px;
  min-width: 0;
}
.side-pane-host {
  flex: 0 0 auto;       /* width controlled via inline flex-basis */
  display: flex;
  min-width: 0;
  min-height: 0;
  background: #15171d;
}
.side-pane-host > * { flex: 1 1 auto; min-width: 0; min-height: 0; }
.group-header { font-size: 11px; color: #7c8290; text-transform: uppercase; padding: 8px 10px 4px; cursor: pointer; }
.active-header { display: flex; align-items: center; justify-content: space-between; cursor: default; }
.spawn-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  background: #1c2029; color: #d8dee9;
  border: 1px solid #3a3f4a; border-radius: 4px;
  cursor: pointer; line-height: 1;
}
.spawn-btn:hover { background: #2a3140; border-color: #4a8be8; color: #e8eef8; }
.spawn-btn:focus-visible { outline: 2px solid #4a8be8; outline-offset: 1px; }
.spawn-btn i { font-size: 11px; }
.group { margin-top: 8px; }
.empty { font-size: 12px; color: #7c8290; padding: 8px 10px; }
.tab-row { display: block; width: 100%; text-align: left; background: transparent; border: none; padding: 10px; border-left: 3px solid transparent; cursor: pointer; color: #d8dee9; position: relative; }
.tab-row:hover { background: #1a1d24; }
.tab-row.selected { background: #1c2029; border-left-color: #4a8be8; }
.tab-row .row-1 {
  display: flex; align-items: center; gap: 6px;
  font-weight: 600; min-width: 0; font-size: 13px;
}
.tab-row .row-1 .tab-task {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0; flex: 1 1 auto;
}
/* Line 2: subtask. Medium weight, slightly muted, smaller than title. */
.tab-row .row-subtask {
  margin-top: 1px; padding-left: 22px;        /* indent under icon */
  font-size: 12px; font-weight: 500;
  color: #b8c0cd;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Line 3: status + provider + age. Smallest + dimmest. */
.tab-row .row-status {
  display: flex; align-items: center; gap: 6px;
  margin-top: 2px; padding-left: 22px;        /* indent under icon */
  font-size: 11px;
}
.tab-row .row-status .state-dot { margin-left: -22px; margin-right: 14px; }
.muted { color: #7c8290; }
.state-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.state-idle { background: #4caf50; }
.state-busy { background: #4a8be8; }
.state-running { background: #4caf50; }
.state-starting { background: #a0a0a0; }
.state-needs_user_input { background: #ff9800; }
.state-exited { background: #d44; }
.state-archived { background: transparent; border: 1px solid #7c8290; }
.state-unknown { background: #7c8290; }
.state-foreign { background: #555b66; }
.state-thinking { background: #d4b94a; }
.state-tool_use { background: #e57b3a; }
.state-waiting { background: #f5c542; box-shadow: 0 0 4px #f5c542; }
.state-error { background: #d44; }

/* Live state on the kind icon. Base color + animation per state.
 * The icon transitions in 200ms when state changes to avoid jarring
 * pulses when a tool finishes and the agent goes straight back to
 * thinking. */
.row-1 i { transition: color 200ms ease; color: #7c8290; }
.row-1 i.icon-state-idle { color: #4caf50; }
.row-1 i.icon-state-thinking { color: #d4b94a; animation: icon-pulse 1.4s ease-in-out infinite; }
.row-1 i.icon-state-tool_use { color: #e57b3a; animation: icon-spin 1.6s linear infinite; }
.row-1 i.icon-state-waiting { color: #f5c542; animation: icon-bounce 1s ease-in-out infinite; filter: drop-shadow(0 0 3px #f5c542); }
.row-1 i.icon-state-error { color: #e06c75; }
.row-1 i.icon-state-exited { color: #5a2222; }
.row-1 i.icon-state-needs_user_input { color: #ff9800; animation: icon-bounce 1s ease-in-out infinite; }
.row-1 i.icon-state-busy { color: #4a8be8; animation: icon-pulse 1.4s ease-in-out infinite; }
.row-1 i.icon-state-running { color: #4a8be8; }
.row-1 i.icon-state-starting { color: #a0a0a0; animation: icon-pulse 1.4s ease-in-out infinite; }
.row-1 i.icon-state-foreign { color: #555b66; }
.row-1 i.icon-state-archived { color: #4a4f58; }
.row-1 i.icon-state-unknown { color: #7c8290; }

@keyframes icon-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}
@keyframes icon-spin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes icon-bounce {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2px); }
}

/* Honor reduced-motion preference — drop animations entirely. */
@media (prefers-reduced-motion: reduce) {
  .row-1 i { animation: none !important; }
}

/* End-reason chip on archived rows (e.g. 'reaped' for idle-reaped sessions). */
.end-chip {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 3px;
  background: #2a2218;
  color: #d4a857;
  border: 1px solid #5a4622;
  margin-left: 4px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.resume-btn { position: absolute; right: 8px; top: 10px; padding: 2px 8px; font-size: 11px; background: #23262d; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; display: none; }
.archived:hover .resume-btn { display: inline-block; }
.kill-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 2px 7px; font-size: 11px; background: #2c1a1a; color: #e06c75; border: 1px solid #5a2222; border-radius: 3px; cursor: pointer; display: none; line-height: 1.4; }
.kill-btn--foreign { background: #2a2020; color: #c06060; border-color: #4a1818; }
.tab-row:hover .kill-btn { display: inline-block; }
.tab-row.foreign { opacity: 0.75; border-left-style: dashed; }
.load-more { display: block; margin: 6px auto; padding: 4px 10px; font-size: 11px; background: transparent; color: #7c8290; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; }

/* xterm-host fills the remaining width and full panel height. The two
 * min-* zeros are required for flex children that contain content larger
 * than the parent (xterm's canvas) — without them the host grows to the
 * canvas's natural size and the flex 1 doesn't take effect.
 * `position: relative` is needed because xterm.js positions its scrollbar
 * absolutely inside the host.
 *
 * We deliberately DO NOT force `width:100%` / `height:100%` on the xterm
 * internals (.xterm, .xterm-viewport, .xterm-screen). xterm.js — and the
 * WebGL/Canvas renderers especially — size their layers to exactly
 * `cols × cellWidth` / `rows × cellHeight` px. Overriding with !important
 * decouples the glyph layer from the cursor/background-color layer, which
 * is what produced the "GE pill drifting into Pull-requests" overlay on
 * copilot's TUI status bar. The IPty is born at the host's exact dims
 * (via the WS `?cols=&rows=` query) so xterm's natural size already
 * fills the host.
 */
.xterm-host { flex: 1 1 auto; min-width: 0; min-height: 0; background: #15171d; position: relative; padding: 4px; box-sizing: border-box; overflow: hidden; }
/* Hide xterm's viewport scrollbar — mouse-wheel still scrolls. The scrollbar
 * is a vestigial column of grey pixels that looks like the panel edge has a
 * stray sliver next to the side-panel chevrons. */
.xterm-host :deep(.xterm-viewport) { scrollbar-width: none; -ms-overflow-style: none; }
.xterm-host :deep(.xterm-viewport)::-webkit-scrollbar { width: 0; height: 0; display: none; }

/* Spawn dialog */
.spawn-form { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--p-text-color); }
.field .hint { color: var(--p-text-color-secondary); font-weight: 400; margin-left: 4px; }
.field .req { color: #e06c75; font-weight: 700; }
.field .small { font-size: 11px; }
.spawn-form .w-full { width: 100%; }
.spawn-error {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; font-size: 12px;
  color: #e06c75; background: #2a1818; border: 1px solid #5a2222;
  border-radius: 4px;
}
.spawn-error i { font-size: 12px; }
</style>
