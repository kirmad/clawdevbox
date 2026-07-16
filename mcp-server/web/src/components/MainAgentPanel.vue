<script setup lang="ts">
/**
 * MainAgentPanel — dedicated, always-on view for the dev-buddy main agent.
 *
 * Lives in its own top-level tab so the user can always reach the main
 * agent regardless of how many other terminals are open. Unlike the
 * Terminals tab (which only lists currently-live sessions), this panel
 * stays mounted across the main agent's lifecycle:
 *
 *   running   →  xterm.js attached to /terminal/main/ws (same backend
 *                contract as TerminalsPanel)
 *   exited    →  inline "agent exited (exitCode=N)" + Restart button
 *   not_started → inline reason from server (provider missing, binary
 *                not on PATH, etc.) + Restart button
 *
 * On status transitions (the 'agent' event-bus topic), we tear down or
 * (re-)attach automatically — no user action required for the happy path
 * after a clawdevbox `restartMainAgent` finishes.
 *
 * The same WebGL/Canvas/DOM renderer + race-safe attach pattern from
 * TerminalsPanel is reused so the rendering perf characteristics match
 * exactly (Copilot's tmux pane writes a LOT of bytes; the DOM renderer
 * stalls visibly without GPU acceleration).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { restartMainAgent } from '../api';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';

const MAIN_INSTANCE_ID = 'main';
const TAB_VALUE = 'main-agent';

const store = useUiStore();
const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObs: ResizeObserver | null = null;
let onWindowResize: (() => void) | null = null;
let attachGen = 0;

const restarting = ref(false);
const restartError = ref<string | null>(null);

const status = computed(() => store.agent);
const running = computed(() => status.value.running === true);
/**
 * Whether THIS panel is the active SPA tab. Used as the gate for
 * attach() — only when the user is genuinely looking at the Main Agent
 * tab AND the agent is running do we attach xterm. This sidesteps the
 * "PrimeVue eager-mounts hidden panels at 0×0 and briefly flickers
 * non-zero dims during setup" race that would otherwise corrupt the
 * live tmux pane.
 */
const isVisible = computed(() => store.activeTab === TAB_VALUE);
const shouldAttach = computed(() => isVisible.value && running.value);

const headerLabel = computed(() => {
  if (running.value) return 'Main agent running';
  if (status.value.exited) {
    const code = status.value.exitCode;
    return `Main agent exited${typeof code === 'number' ? ` (exitCode=${code})` : ''}`;
  }
  return 'Main agent not running';
});

const headerSeverity = computed<'success' | 'warn' | 'danger'>(() => {
  if (running.value) return 'success';
  if (status.value.exited && (status.value.exitCode ?? 0) !== 0) return 'danger';
  return 'warn';
});

const offlineReason = computed(
  () =>
    status.value.not_running_reason ??
    (status.value.exited
      ? `The main agent process exited${
          typeof status.value.exitCode === 'number'
            ? ` with code ${status.value.exitCode}`
            : ''
        }.`
      : 'The main agent is not currently running.'),
);

// ---------------------------------------------------------------------------
// xterm renderer (shared pattern with TerminalsPanel)
// ---------------------------------------------------------------------------
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
 * Connect xterm to /terminal/main/ws. Race-safe: each call captures
 * `attachGen` into a local `myGen`; after every await we check
 * `attachGen !== myGen` and bail. Resources stay in LOCAL vars
 * (localTerm/localFit/localWs) and only commit to module-level refs at
 * the very end — same pattern as TerminalsPanel.attach to avoid the
 * "every keystroke shows up twice" bug.
 */
async function attach(): Promise<void> {
  if (!termHost.value || !running.value) return;
  // STRICT visibility gate: PrimeVue eager-mounts hidden TabPanels at 0×0.
  // Attaching here would force xterm to its 80×24 default, send a
  // resize message to the backend tmux pane, and SHRINK the live pty —
  // which is the documented regression class behind the "empty terminal
  // with stale snapshot" symptom users see when their Main Agent tab
  // mounts while another tab is active. Defer until we actually have
  // real pixels; the visibility observer below will retry.
  const host = termHost.value;
  if (host.clientWidth === 0 || host.clientHeight === 0) return;

  const myGen = ++attachGen;
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
  loadAcceleratedRenderer(localTerm);

  await nextTick();
  if (attachGen !== myGen) { localTerm.dispose(); return; }

  // rAF-poll for stable dimensions. Look for STABILITY (same cols×rows
  // across 2 consecutive frames) rather than bailing on first acceptable
  // value — early frames may see a partially-laid-out host that's still
  // shrinking as PrimeVue's tab strip / CSS-in-JS / fonts settle.
  // Without stability, we'd commit the first measurement and the
  // observer registered later wouldn't catch the shift (host has by
  // then reached its final size, no further resize event fires).
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
    initCols = c; initRows = r; // fall-through default in case loop never stabilises
  }
  if (initCols === 0) { initCols = 120; initRows = 30; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const localWs = new WebSocket(
    `${proto}//${location.host}/terminal/${MAIN_INSTANCE_ID}/ws?cols=${initCols}&rows=${initRows}`,
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

  localTerm.onData((d) => {
    if (localWs.readyState === 1) {
      try { localWs.send(JSON.stringify({ type: 'input', data: d })); } catch { /* */ }
    }
  });

  if (attachGen !== myGen) {
    try { localWs.close(); } catch {}
    try { localTerm.dispose(); } catch {}
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

/**
 * Strict pre-attach guard. Returns false when the panel isn't visible
 * (PrimeVue eager-mount; user is on a different tab) OR when the host
 * still hasn't measured up. The watch on `shouldAttach` below
 * orchestrates retries.
 */
function canAttachNow(): boolean {
  if (!termHost.value) return false;
  if (!shouldAttach.value) return false;
  const host = termHost.value;
  if (host.clientWidth === 0 || host.clientHeight === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Restart action
// ---------------------------------------------------------------------------
/**
 * "Restart" preserves the sticky main-agent session id so the agent
 * resumes its prior conversation. "New Session" passes
 * `{ newSession: true }` so the server resets the persisted id and
 * starts a clean thread — destructive, confirm first.
 */
async function onRestartClicked(opts: { newSession?: boolean } = {}): Promise<void> {
  if (opts.newSession) {
    const ok = window.confirm(
      'Start a brand-new main-agent session?\n\n' +
      'This forgets the persisted session id, so the agent loses all prior conversation context. ' +
      'Use plain Restart instead if you just want to bounce a stuck process.',
    );
    if (!ok) return;
  }
  restartError.value = null;
  restarting.value = true;
  try {
    const next = await restartMainAgent({ newSession: !!opts.newSession });
    // Update the store immediately (don't wait for the 'agent' event-bus
    // round-trip — feels snappier).
    store.$patch({ agent: next });
  } catch (err) {
    restartError.value = err instanceof Error ? err.message : String(err);
  } finally {
    restarting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  // Refresh the agent status so `running` (and therefore `shouldAttach`)
  // reflects reality before the watch fires. The watch is registered
  // with { immediate: true } below — it's the SINGLE source of attach
  // triggers, so we don't race a second attach against it here.
  await store.refreshAgent();
});

/**
 * Single source of truth for attach lifecycle: watches the boolean
 * `shouldAttach = isVisible && running`. Transition true → attach.
 * Transition false (either tab switched away OR agent died) → teardown.
 *
 * `immediate: true` handles the case where shouldAttach is ALREADY true
 * at mount (running came back true from the bootstrap refresh, panel
 * is the active tab) — we still want to attach. Without it we used to
 * have a separate onMounted attach which RACED this watch on store
 * mutations that happen during nextTick + rAF, producing two
 * overlapping attach()es that left the host with no xterm.
 *
 * On true, we await nextTick so PrimeVue's display-block transition
 * settles before measuring the host. canAttachNow() re-checks
 * dimensions inside the handler too as a defense-in-depth against
 * the well-known PrimeVue "hidden panel flickers visible briefly
 * during setup" race.
 */
watch(shouldAttach, async (now) => {
  if (now) {
    await nextTick();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    if (canAttachNow()) {
      await attach();
    }
  } else {
    await teardown();
  }
}, { immediate: true });

onBeforeUnmount(async () => {
  await teardown();
});
</script>
<template>
  <section class="main-agent-panel">
    <header class="ma-header">
      <span class="ma-dot" :data-severity="headerSeverity" />
      <span class="ma-label">{{ headerLabel }}</span>
      <!-- Restart: preserves the sticky session id so the agent resumes
           the same conversation. New Session: destroys the persisted id
           so the agent starts a fresh thread. -->
      <Button
        v-if="!running"
        icon="pi pi-refresh"
        :label="restarting ? 'Restarting…' : 'Restart'"
        size="small"
        severity="info"
        :loading="restarting"
        :disabled="restarting"
        title="Respawn the agent CLI and resume the persisted conversation"
        @click="onRestartClicked()"
      />
      <Button
        v-else
        icon="pi pi-refresh"
        label="Restart"
        size="small"
        severity="secondary"
        text
        :loading="restarting"
        :disabled="restarting"
        title="Respawn the agent CLI and resume the persisted conversation (use when the process is stuck)"
        @click="onRestartClicked()"
      />
      <Button
        icon="pi pi-plus"
        label="New Session"
        size="small"
        severity="secondary"
        text
        :disabled="restarting"
        title="Forget the persisted session id and start a clean conversation (destroys prior context)"
        @click="onRestartClicked({ newSession: true })"
      />
    </header>

    <!-- Terminal host is ALWAYS rendered (even when not running) so the
         attach/teardown can use a stable ref. We just hide it when the
         agent isn't running. -->
    <div
      ref="termHost"
      class="ma-term-host"
      :class="{ 'ma-term-host--hidden': !running }"
    />

    <div v-if="!running" class="ma-offline">
      <i class="pi pi-info-circle ma-offline-icon" />
      <div class="ma-offline-text">
        <div class="ma-offline-title">Main agent not connected</div>
        <pre class="ma-offline-reason">{{ offlineReason }}</pre>
        <div v-if="restartError" class="ma-offline-error">
          <i class="pi pi-exclamation-triangle" /> Restart failed: {{ restartError }}
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.main-agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.ma-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  background: #181a20;
  flex-shrink: 0;
}

.ma-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.ma-dot[data-severity="success"] { background: #4ade80; box-shadow: 0 0 6px rgba(74, 222, 128, 0.7); }
.ma-dot[data-severity="warn"]    { background: #fbbf24; }
.ma-dot[data-severity="danger"]  { background: #f87171; }

.ma-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--p-text-color);
  flex: 1;
}

/* Terminal host: takes all remaining space when visible. */
.ma-term-host {
  flex: 1;
  min-height: 0;
  background: #15171d;
  position: relative;
  overflow: hidden;
  padding: 4px;
  box-sizing: border-box;
}

/* Hide xterm's own viewport scrollbar — same treatment as TerminalsPanel.
 * The keyboard/mouse-wheel scrollback still works; this just removes the
 * always-visible vertical bar that overlaps the rightmost column. */
.ma-term-host :deep(.xterm-viewport) { scrollbar-width: none; -ms-overflow-style: none; }
.ma-term-host :deep(.xterm-viewport)::-webkit-scrollbar { width: 0; height: 0; display: none; }

/* Hide rather than v-if so the ref stays stable across attach/teardown. */
.ma-term-host--hidden {
  display: none;
}

/* Offline placeholder (shown instead of the term host when not running). */
.ma-offline {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 32px 24px;
  color: var(--p-text-color-secondary);
  background: #15171d;
}
.ma-offline-icon {
  font-size: 24px;
  color: #fbbf24;
  flex-shrink: 0;
  margin-top: 2px;
}
.ma-offline-text {
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ma-offline-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--p-text-color);
}
.ma-offline-reason {
  font-family: Consolas, "Liberation Mono", Cascadia Code, ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--p-text-color);
}
.ma-offline-error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #f87171;
}
</style>
