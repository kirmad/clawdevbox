<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useUiStore } from '../stores/ui';

interface TerminalMessage {
  type?: string;
  content?: string;
  chunk?: string;
  archived?: boolean;
  exited?: boolean;
}

const props = defineProps<{
  sessionIds: string[];
  sessionLabels?: string[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const store = useUiStore();

const termHost = ref<HTMLDivElement | null>(null);
const activeSessionId = ref<string | null>(props.sessionIds[0] ?? null);
/**
 * When the user clicks Resume on a genuinely-dead session, the server spawns
 * (or reuses) a live instance under a NEW id that shares the same CLI
 * conversation. We attach to that id WITHOUT touching props.sessionIds — the
 * parent stays dumb (it just passes the linked recipe-instance ids). This
 * keeps all resume state in one place and means repeated resumes can never
 * accumulate tabs. Cleared whenever the user switches tabs or the linked
 * sessions change.
 */
const overrideSessionId = ref<string | null>(null);
/** The id we actually attach to: the resume override if set, else the tab. */
const effectiveSessionId = computed<string | null>(
  () => overrideSessionId.value ?? activeSessionId.value,
);
const sessionEnded = ref(false);
const resuming = ref(false);
const resumeError = ref<string | null>(null);
/**
 * One-shot guard: auto-resume fires AT MOST once per conversation. If the
 * resumed session also dies on arrival we fall back to the manual Resume
 * button instead of auto-resuming forever (each resume mints a fresh id, so
 * a per-id guard would still loop — the runaway-spawn bug of 2026-07-11).
 * Reset only when the parent hands us a genuinely new conversation or the
 * user switches tabs — NOT on the override change our own resume triggers.
 */
const hasAutoResumed = ref(false);
/**
 * True from the moment we start attaching until the first byte of terminal
 * content (snapshot or data) arrives — or until the session is declared
 * ended. Drives the "Connecting…" overlay so the user sees a loading state
 * instead of a blank black rectangle while the WS connects and tmux repaints
 * (the tmux-attach redraw alone can take a few seconds).
 */
const loading = ref(false);

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeObs: ResizeObserver | null = null;
let onWindowResize: (() => void) | null = null;
let refitTimer: ReturnType<typeof setTimeout> | null = null;
let attachGen = 0;

// When the linked sessions change (e.g. a new dispatch), point at the new one
// and drop any resume override — it belonged to the previous conversation.
watch(() => props.sessionIds, (newIds, oldIds) => {
  const newSession = newIds.find(id => !oldIds?.includes(id));
  if (newSession) {
    overrideSessionId.value = null;
    hasAutoResumed.value = false;   // new conversation — allow one auto-resume
    activeSessionId.value = newSession;
  }
}, { deep: true });

const tabs = computed(() =>
  props.sessionIds.map((id, index) => ({
    id,
    label: props.sessionLabels?.[index] || id,
  })),
);
const showTabs = computed(() => tabs.value.length > 1);

watch(
  () => props.sessionIds.slice(),
  (sessionIds) => {
    if (sessionIds.length === 0) {
      activeSessionId.value = null;
      return;
    }
    if (!activeSessionId.value || !sessionIds.includes(activeSessionId.value)) {
      activeSessionId.value = sessionIds[0];
    }
  },
  { immediate: true },
);

function selectSession(sessionId: string): void {
  if (sessionId === activeSessionId.value) return;
  overrideSessionId.value = null;   // different conversation — drop resume override
  hasAutoResumed.value = false;     // ...and allow one auto-resume for it
  activeSessionId.value = sessionId;
}

async function copyAttachCmd(): Promise<void> {
  if (!effectiveSessionId.value) return;
  const cmd = `tmux attach -t cdb_${effectiveSessionId.value}`;
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    window.prompt('Copy this command:', cmd);
  }
}

function refit(): void {
  if (!term || !fit || !termHost.value) return;
  const host = termHost.value;
  if (host.clientWidth === 0 || host.clientHeight === 0) return;
  try { fit.fit(); } catch { /* layout not stable yet */ }
}

function scheduleRefit(): void {
  if (refitTimer) clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    refitTimer = null;
    refit();
  }, 100);
}

async function teardown(): Promise<void> {
  if (refitTimer) {
    clearTimeout(refitTimer);
    refitTimer = null;
  }
  if (resizeObs) {
    try { resizeObs.disconnect(); } catch { /* ignore */ }
    resizeObs = null;
  }
  if (onWindowResize) {
    window.removeEventListener('resize', onWindowResize);
    onWindowResize = null;
  }
  if (ws) {
    try {
      ws.onmessage = null;
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
    } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  if (term) {
    try { term.dispose(); } catch { /* ignore */ }
    term = null;
  }
  fit = null;
}

async function waitForStableGrid(localTerm: Terminal, localFit: FitAddon, myGen: number): Promise<{ cols: number; rows: number } | null> {
  let initCols = 0;
  let initRows = 0;
  let prevCols = 0;
  let prevRows = 0;

  for (let i = 0; i < 16; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (attachGen !== myGen) return null;

    const host = termHost.value;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) continue;

    try { localFit.fit(); } catch { continue; }

    const { cols, rows } = localTerm;
    if (cols < 20 || rows < 5 || cols === 80) {
      prevCols = cols;
      prevRows = rows;
      continue;
    }
    if (cols === prevCols && rows === prevRows) {
      initCols = cols;
      initRows = rows;
      break;
    }

    prevCols = cols;
    prevRows = rows;
    initCols = cols;
    initRows = rows;
  }

  if (initCols === 0 || initRows === 0) {
    return { cols: 80, rows: 24 };
  }
  return { cols: initCols, rows: initRows };
}

function writeTerminalText(localTerm: Terminal, data: string): void {
  let message: TerminalMessage | null = null;
  try {
    message = JSON.parse(data) as TerminalMessage;
  } catch {
    localTerm.write(data);
    return;
  }

  if (message.type === 'snapshot' && typeof message.content === 'string') {
    loading.value = false;
    localTerm.write(message.content);
    return;
  }
  if (message.type === 'data' && typeof message.chunk === 'string') {
    loading.value = false;
    localTerm.write(message.chunk);
    return;
  }
  if (message.type === 'exit') {
    loading.value = false;
    sessionEnded.value = true;
    localTerm.write('\r\n\x1b[2m── session ended ──\x1b[0m\r\n');
    // Auto-resume ONCE per conversation. Reaching `exit` means the server
    // found no live embodiment (it transparently attaches to a live sibling
    // otherwise — see terminal-server's resolveLiveInstanceForInstance), so
    // the conversation is genuinely dead. Resume it for the user instead of
    // making them click. `doResume` sets `resuming` synchronously so the UI
    // shows "Resuming…" rather than flashing the "Session ended" banner. The
    // one-shot `hasAutoResumed` guard prevents the runaway loop that bit us
    // on 2026-07-11: if the resumed session ALSO dies on arrival we fall
    // back to the manual Resume button (see template) instead of looping.
    if (!hasAutoResumed.value && !resuming.value) {
      hasAutoResumed.value = true;
      void doResume();
    }
    return;
  }

  // Unknown message types — don't dump raw JSON
}

/**
 * Resume the conversation we're currently viewing. The server is
 * idempotent: if a live embodiment already exists it returns that instance
 * (no new spawn); otherwise it spawns one. Either way we attach to the
 * returned id via `overrideSessionId` — no parent state, no tab churn.
 */
async function doResume(): Promise<void> {
  const target = effectiveSessionId.value;
  if (!target) return;
  resuming.value = true;
  resumeError.value = null;
  try {
    const newId = await store.resumeTerminal(target);
    sessionEnded.value = false;
    if (overrideSessionId.value === newId) {
      // Same id we're already pointed at (idempotent reuse) — force a
      // re-attach since the effectiveSessionId watcher won't fire.
      void attach();
    } else {
      overrideSessionId.value = newId;   // watcher triggers the re-attach
    }
  } catch (err) {
    resumeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    resuming.value = false;
  }
}

async function attach(): Promise<void> {
  if (!termHost.value || !effectiveSessionId.value) {
    await teardown();
    return;
  }

  const myGen = ++attachGen;
  const sessionId = effectiveSessionId.value;
  await teardown();
  if (attachGen !== myGen || !termHost.value) return;

  // Show the loading overlay until the first content byte (or exit) lands.
  loading.value = true;

  const localTerm = new Terminal({
    cursorBlink: true,
    fontFamily: 'Consolas, "Liberation Mono", Cascadia Code, ui-monospace, Menlo, monospace',
    fontSize: 12,
    scrollback: 2000,
    theme: {
      background: '#0f1115',
      foreground: '#d8dee9',
    },
  });
  const localFit = new FitAddon();
  localTerm.loadAddon(localFit);

  localTerm.open(termHost.value);
  await nextTick();
  if (attachGen !== myGen) {
    localTerm.dispose();
    return;
  }

  const initialGrid = await waitForStableGrid(localTerm, localFit, myGen);
  if (!initialGrid || attachGen !== myGen) {
    localTerm.dispose();
    return;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const localWs = new WebSocket(
    `${proto}//${window.location.host}/terminal/${encodeURIComponent(sessionId)}/ws?cols=${initialGrid.cols}&rows=${initialGrid.rows}`,
  );
  localWs.binaryType = 'arraybuffer';

  localTerm.onResize(({ cols, rows }) => {
    if (localWs.readyState === WebSocket.OPEN) {
      try { localWs.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* ignore */ }
    }
  });

  const decoder = new TextDecoder();
  localWs.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    if (attachGen !== myGen) return;
    if (typeof event.data === 'string') {
      writeTerminalText(localTerm, event.data);
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      loading.value = false;
      localTerm.write(decoder.decode(new Uint8Array(event.data), { stream: true }));
    }
  };
  // Clear the loading overlay if the socket dies before any content lands —
  // otherwise it would spin forever on a failed attach.
  localWs.onclose = () => { if (attachGen === myGen) loading.value = false; };
  localWs.onerror = () => { if (attachGen === myGen) loading.value = false; };

  if (attachGen !== myGen) {
    try { localWs.close(); } catch { /* ignore */ }
    try { localTerm.dispose(); } catch { /* ignore */ }
    return;
  }

  // Forward user keystrokes to the backend pty. Single onData handler per
  // Terminal (registered after the final race guard above so a superseded
  // attach never double-registers — the "every keystroke shows up twice"
  // bug TerminalsPanel documents). The tmux WS handler writes m.data
  // straight into the tmux-attach pty.
  localTerm.onData((d) => {
    if (localWs.readyState === WebSocket.OPEN) {
      try { localWs.send(JSON.stringify({ type: 'input', data: d })); } catch { /* ignore */ }
    }
  });

  term = localTerm;
  fit = localFit;
  ws = localWs;

  const localResizeObs = new ResizeObserver(() => scheduleRefit());
  if (termHost.value) localResizeObs.observe(termHost.value);
  resizeObs = localResizeObs;

  const localOnWindowResize = (): void => scheduleRefit();
  window.addEventListener('resize', localOnWindowResize);
  onWindowResize = localOnWindowResize;

  scheduleRefit();
}

onMounted(() => {
  if (effectiveSessionId.value) {
    void attach();
  }
});

// Re-attach whenever the effective target changes — covers tab switches,
// linked-session changes, and resume overrides in one place.
watch(effectiveSessionId, (sessionId, previousSessionId) => {
  if (sessionId === previousSessionId) return;
  // Reset per-session banner state whenever we switch targets.
  sessionEnded.value = false;
  resumeError.value = null;
  if (!sessionId) {
    loading.value = false;
    void teardown();
    return;
  }
  void attach();
});

onBeforeUnmount(() => {
  attachGen += 1;
  void teardown();
});
</script>

<template>
  <section class="inbox-terminal-panel">
    <header class="panel-header">
      <div v-if="showTabs" class="tab-strip" role="tablist" aria-label="Session terminals">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="tab-button"
          :class="{ 'tab-button--active': tab.id === activeSessionId }"
          role="tab"
          :aria-selected="tab.id === activeSessionId"
          :title="tab.label"
          @click="selectSession(tab.id)"
        >
          {{ tab.label }}
        </button>
      </div>
      <div v-else class="panel-title">Terminal</div>

      <button
        v-if="effectiveSessionId"
        type="button"
        class="attach-button"
        title="Copy tmux attach command"
        @click="copyAttachCmd"
      >⎘</button>
      <button
        type="button"
        class="close-button"
        aria-label="Close terminal panel"
        title="Close terminal panel"
        @click="emit('close')"
      >
        <i class="pi pi-times" />
      </button>
    </header>

    <div class="panel-body">
      <div v-if="effectiveSessionId" ref="termHost" class="terminal-host" />
      <!-- Loading overlay: sits on top of the (still-mounting) xterm so the
           user sees a terminal-styled "Connecting…" state instead of a blank
           black rectangle while the WS connects + tmux repaints. Removed the
           instant the first content byte arrives (see writeTerminalText). -->
      <div v-if="loading && !sessionEnded && !resumeError && !resuming" class="term-loading" aria-live="polite">
        <span class="term-loading__prompt">❯</span>
        <span class="term-loading__text">Connecting to terminal</span>
        <span class="term-loading__dots"><i /><i /><i /></span>
      </div>
      <div v-if="resuming" class="session-ended-banner banner--resuming">
        <i class="pi pi-spin pi-spinner" />
        <span>Resuming session…</span>
      </div>
      <div v-else-if="resumeError" class="session-ended-banner banner--error">
        <i class="pi pi-exclamation-triangle" />
        <span class="banner-msg" :title="resumeError">Resume failed: {{ resumeError }}</span>
        <button type="button" class="banner-btn" @click="doResume">Retry</button>
      </div>
      <div v-else-if="sessionEnded" class="session-ended-banner">
        <span>Session ended</span>
        <button
          type="button"
          class="banner-btn"
          title="Resume the underlying CLI session so you can continue the conversation"
          @click="doResume"
        >
          <i class="pi pi-play" />
          Resume
        </button>
      </div>
      <div v-if="!effectiveSessionId" class="empty-state">No terminal session selected.</div>
    </div>
  </section>
</template>

<style scoped>
.inbox-terminal-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: #0f1115;
  color: #d8dee9;
  border-left: 1px solid #1b1f27;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  height: 28px;
  padding: 0 6px;
  border-bottom: 1px solid #1b1f27;
  background: #12161d;
  flex: 0 0 auto;
}

.panel-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #d8dee9;
}

.tab-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-strip::-webkit-scrollbar {
  display: none;
}

.tab-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  max-width: 160px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: #98a2b3;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.tab-button:hover {
  background: #1a2029;
  color: #d8dee9;
}

.tab-button--active {
  background: #1f2732;
  border-color: #2c3a4b;
  color: #f5f7fa;
}

.attach-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #6cb4f7;
  cursor: pointer;
  flex: 0 0 auto;
  font-size: 14px;
}
.attach-button:hover {
  background: #1a2a3d;
  color: #fff;
}

.close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #98a2b3;
  cursor: pointer;
  flex: 0 0 auto;
}

.close-button:hover {
  background: #1a2029;
  color: #f5f7fa;
}

.panel-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.terminal-host {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: #0f1115;
  padding: 4px;
  box-sizing: border-box;
  overflow: hidden;
}

/* Loading overlay — covers the terminal-host while attaching. Terminal-styled
   (monospace, dark, blinking prompt) so it reads as "the terminal is booting"
   rather than a generic spinner. */
.term-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #0f1115;
  color: #8b98a9;
  font-family: Consolas, "Liberation Mono", Cascadia Code, ui-monospace, Menlo, monospace;
  font-size: 12.5px;
  z-index: 2;
  user-select: none;
}
.term-loading__prompt {
  color: #4ade80;
  font-weight: 700;
  animation: term-cursor-blink 1s steps(1) infinite;
}
.term-loading__dots {
  display: inline-flex;
  gap: 3px;
}
.term-loading__dots i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #6cb4f7;
  display: inline-block;
  animation: term-dot-pulse 1.2s ease-in-out infinite;
}
.term-loading__dots i:nth-child(2) { animation-delay: 0.2s; }
.term-loading__dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes term-cursor-blink {
  0%, 50% { opacity: 1; }
  50.01%, 100% { opacity: 0; }
}
@keyframes term-dot-pulse {
  0%, 100% { opacity: 0.3; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  color: #6b7280;
  font-size: 12px;
}

.session-ended-banner {
  /* Float over the bottom of the terminal instead of taking its own row —
     otherwise it renders as a second pane beside the xterm (panel-body is a
     flex row). Absolute keeps the terminal at full size; the bar overlays. */
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(15, 17, 21, 0.92);
  backdrop-filter: blur(2px);
  border-top: 1px solid #2a2e38;
  color: #9aa4b2;
  font-size: 11.5px;
  text-align: center;
}
.session-ended-banner.banner--resuming {
  color: #79b8ff;
}
.session-ended-banner.banner--error {
  color: #f87171;
}
.session-ended-banner .banner-msg {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-ended-banner .banner-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  background: #23262d;
  color: #d8dee9;
  border: 1px solid #3a3f4a;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
}
.session-ended-banner .banner-btn:hover {
  background: #2a2e38;
  border-color: #4a8be8;
  color: #79b8ff;
}
.session-ended-banner .banner-btn i {
  font-size: 10px;
}

.terminal-host :deep(.xterm-viewport) {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.terminal-host :deep(.xterm-viewport)::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
</style>
