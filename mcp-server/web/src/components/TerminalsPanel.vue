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
import '@xterm/xterm/css/xterm.css';

const store = useUiStore();
const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObs: ResizeObserver | null = null;
let onWindowResize: (() => void) | null = null;

const selectedId = computed(() => store.terminals.selectedInstanceId);
const activeSessions = computed(() => store.terminals.items.filter((s) => s.live));
const recentArchived = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return store.terminals.items.filter((s) => !s.live && (s.ended_at ?? s.started_at) >= cutoff);
});
const olderArchived = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return store.terminals.items.filter((s) => !s.live && (s.ended_at ?? s.started_at) < cutoff);
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
 * Refit the xterm to its container and inform the server-side pty of
 * the new cols/rows. Wrapped in requestAnimationFrame so layout has a
 * chance to settle before measurement (FitAddon reads computed CSS
 * dimensions; reading too early returns stale 0×0). No-ops if any
 * piece isn't ready yet.
 *
 * IMPORTANT: skip when the host has zero dimensions. PrimeVue eagerly
 * mounts every TabPanel (even inactive ones), so this component runs
 * `attach()` while `.xterm-host` is still hidden (clientWidth/Height === 0).
 * In that state `fit.fit()` no-ops but `term.cols` / `term.rows` still
 * hold xterm's 80×24 defaults — sending those over the WS would resize
 * (shrink!) the live pty. ResizeObserver re-fires this function when
 * the host becomes visible, at which point fit can actually measure.
 */
function refit(): void {
  if (!term || !fit) return;
  requestAnimationFrame(() => {
    const host = termHost.value;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fit!.fit();
      if (ws && ws.readyState === WebSocket.OPEN && term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch { /* host not measurable yet — next observer tick will retry */ }
  });
}

async function teardown(): Promise<void> {
  if (resizeObs) { try { resizeObs.disconnect(); } catch {} resizeObs = null; }
  if (onWindowResize) { window.removeEventListener('resize', onWindowResize); onWindowResize = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  if (term) { try { term.dispose(); } catch {} term = null; }
  fit = null;
}

async function attach(): Promise<void> {
  if (!termHost.value || !selectedId.value) return;
  await teardown();
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Cascadia Code, ui-monospace, Menlo, monospace',
    fontSize: isMobile ? 12 : 13,
    scrollback: 2000,
    theme: { background: '#15171d', foreground: '#d8dee9' },
    allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termHost.value);
  await nextTick();
  refit();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const id = encodeURIComponent(selectedId.value);
  ws = new WebSocket(`${proto}//${location.host}/terminal/${id}/ws`);
  ws.onopen = () => {
    // Immediately fit with current layout, then again after 100 ms so that
    // any async CSS reflows (flex layout settling, scrollbar appearing) have
    // completed.  The second call also covers the common race where xterm
    // opens before the host element has reached its final rendered width.
    refit();
    setTimeout(() => refit(), 100);
  };
  ws.onmessage = (ev) => {
    let msg: { type?: string; content?: string; chunk?: string };
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot' && msg.content && term) term.write(msg.content);
    if (msg.type === 'data' && msg.chunk && term) term.write(msg.chunk);
  };
  if (term) {
    term.onData((d) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
    });
  }

  // Auto-refit on container size changes (window resize, sidebar drawer
  // toggle, tab switches) AND on window resize as a fallback for any
  // change the ResizeObserver misses.
  if (termHost.value && typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => refit());
    resizeObs.observe(termHost.value);
  }
  onWindowResize = () => refit();
  window.addEventListener('resize', onWindowResize);
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
    <aside class="tab-list">
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
        :class="{ selected: s.instance_id === selectedId, foreign: s.kind === 'foreign' }"
        @click="select(s)"
      >
        <div class="row-1">
          <i :class="[iconFor(s.kind), iconStateClass(s.state)]" :title="stateLabel(s.state)" />
          <span class="label">{{ s.label }}</span>
        </div>
        <div class="row-2">
          <span :class="stateClass(s.state)" />
          <span class="muted">{{ s.provider_id ?? (s.kind === 'foreign' ? '(foreign tmux)' : '—') }} · {{ relTime(s.started_at) }}</span>
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
          :class="{ selected: s.instance_id === selectedId }"
          @click="select(s)"
        >
          <div class="row-1">
            <i :class="[iconFor(s.kind), iconStateClass(s.state)]" :title="stateLabel(s.state)" />
            <span class="label">{{ s.label }}</span>
          </div>
          <div class="row-2">
            <span :class="stateClass(s.state)" />
            <span class="muted">{{ s.provider_id ?? '—' }} · {{ relTime(s.ended_at ?? s.started_at) }}</span>
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
          :class="{ selected: s.instance_id === selectedId }"
          @click="select(s)"
        >
          <div class="row-1">
            <i :class="[iconFor(s.kind), iconStateClass(s.state)]" :title="stateLabel(s.state)" />
            <span class="label">{{ s.label }}</span>
          </div>
          <div class="row-2">
            <span :class="stateClass(s.state)" />
            <span class="muted">{{ s.provider_id ?? '—' }} · {{ relTime(s.ended_at ?? s.started_at) }}</span>
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
    <main class="xterm-host" ref="termHost" />

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
.tab-list { width: 280px; min-width: 280px; max-width: 280px; overflow-y: auto; border-right: 1px solid #23262d; padding: 8px 4px; }
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
.tab-row .row-1 { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.tab-row .row-2 { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: 11px; }
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
.resume-btn { position: absolute; right: 8px; top: 10px; padding: 2px 8px; font-size: 11px; background: #23262d; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; display: none; }
.archived:hover .resume-btn { display: inline-block; }
.kill-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 2px 7px; font-size: 11px; background: #2c1a1a; color: #e06c75; border: 1px solid #5a2222; border-radius: 3px; cursor: pointer; display: none; line-height: 1.4; }
.kill-btn--foreign { background: #2a2020; color: #c06060; border-color: #4a1818; }
.tab-row:hover .kill-btn { display: inline-block; }
.tab-row.foreign { opacity: 0.75; border-left-style: dashed; }
.load-more { display: block; margin: 6px auto; padding: 4px 10px; font-size: 11px; background: transparent; color: #7c8290; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; }

/* xterm-host fills the remaining width and full panel height. The two
 * min-* zeros are required for flex children that contain content
 * larger than the parent (xterm's canvas) — without them the host
 * grows to the canvas's natural size and the flex 1 doesn't take effect.
 * `position: relative` is needed because xterm.js positions its
 * scrollbar absolutely inside the host. */
.xterm-host { flex: 1 1 auto; min-width: 0; min-height: 0; background: #15171d; position: relative; padding: 4px; box-sizing: border-box; overflow: hidden; }
.xterm-host :deep(.xterm) { width: 100%; height: 100%; }
.xterm-host :deep(.xterm-viewport) { width: 100% !important; }
.xterm-host :deep(.xterm-screen) { width: 100% !important; }

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
