<script setup lang="ts">
/**
 * Agent panel — xterm.js attached to `/terminal/main/ws`. This component
 * keeps the same dimensions / reflow semantics the legacy home page used.
 *
 * The terminal is only created lazily on first mount of the tab to avoid
 * paying its bundle cost when the user lands on Inbox.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useUiStore } from '../stores/ui';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const store = useUiStore();
const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;

const status = ref('connecting…');
const agentBadge = computed(() => store.agent.running ? 'live' : (store.agent.exited ? 'exit' : '—'));

function refit(): void {
  if (!term || !fit) return;
  requestAnimationFrame(() => {
    try {
      fit!.fit();
      if (ws && ws.readyState === 1 && term) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch { /* not measurable yet */ }
  });
}

async function attach(): Promise<void> {
  if (term || !termHost.value) return;
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

  await store.refreshAgent();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/terminal/main/ws`);
  ws.onopen = () => { status.value = 'connected'; refit(); };
  ws.onmessage = (ev) => {
    let msg: { type?: string; content?: string; chunk?: string; exited?: boolean; exitCode?: number };
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot' && term) {
      term.clear();
      term.write(msg.content || '');
      if (msg.exited) status.value = `exited (code ${msg.exitCode ?? '?'})`;
    } else if (msg.type === 'data' && term) {
      term.write(msg.chunk || '');
    } else if (msg.type === 'exit') {
      status.value = `exited (code ${msg.exitCode ?? '?'})`;
      void store.refreshAgent();
    }
  };
  ws.onclose = () => { status.value = 'disconnected'; };
  ws.onerror = () => { status.value = 'connection error'; };
  term.onData((d) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
  });

  if (typeof ResizeObserver !== 'undefined' && termHost.value) {
    const ro = new ResizeObserver(() => refit());
    ro.observe(termHost.value);
  }
}

onMounted(() => { void attach(); });
onBeforeUnmount(() => {
  try { ws?.close(); } catch { /* ignore */ }
  try { term?.dispose(); } catch { /* ignore */ }
  ws = null;
  term = null;
  fit = null;
});

watch(() => store.agent, () => { /* no-op: badge is reactive via computed */ }, { deep: true });
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <h1>Main Agent <span class="subtitle">— your dev buddy</span></h1>
      <Badge :value="agentBadge" />
      <span class="status">{{ status }}</span>
    </header>
    <Message severity="info" :closable="false" class="tip">
      Persona &amp; opening playbook live at <code>.clawdevbox/skills/dev-buddy.md</code>. Type
      <code>/catchup</code> on first turn to get the current state of the workspace before deciding what to do.
    </Message>
    <div ref="termHost" class="term-host" />
  </section>
</template>

<style scoped>
.panel { height: 100%; min-height: 0; display: flex; flex-direction: column; padding: 12px; gap: 8px; overflow: hidden; }
.panel-head { display: flex; align-items: baseline; gap: 8px; }
.panel-head h1 { font-size: 16px; margin: 0; }
.subtitle { color: var(--p-text-color-secondary); font-weight: 400; font-size: 12px; }
.status { color: var(--p-text-color-secondary); font-size: 11.5px; }
.tip { font-size: 12px; }
.tip code { background: #20232c; padding: 1px 4px; border-radius: 3px; }
</style>
