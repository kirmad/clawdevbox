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
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const store = useUiStore();
const termHost = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;

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
  return 'pi pi-bolt';
}

function stateClass(state: Session['state']): string {
  return `state-dot state-${state}`;
}

async function teardown(): Promise<void> {
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
  try { fit.fit(); } catch {}

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const id = encodeURIComponent(selectedId.value);
  ws = new WebSocket(`${proto}//${location.host}/terminal/${id}/ws`);
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
}

function select(s: Session): void {
  store.selectTerminal(s.instance_id);
}

async function resume(s: Session): Promise<void> {
  try {
    await store.resumeTerminal(s.instance_id);
  } catch (err) {
    console.error('resume failed:', err);
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
      <div class="group-header">Active</div>
      <div v-if="activeSessions.length === 0" class="empty">No active terminals.</div>
      <button
        v-for="s in activeSessions"
        :key="s.instance_id"
        class="tab-row"
        :class="{ selected: s.instance_id === selectedId }"
        @click="select(s)"
      >
        <div class="row-1">
          <i :class="iconFor(s.kind)" />
          <span class="label">{{ s.label }}</span>
        </div>
        <div class="row-2">
          <span :class="stateClass(s.state)" />
          <span class="muted">{{ s.provider_id ?? '—' }} · {{ relTime(s.started_at) }}</span>
        </div>
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
            <i :class="iconFor(s.kind)" />
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
            <i :class="iconFor(s.kind)" />
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
  </div>
</template>

<style scoped>
.terminals-panel { display: flex; height: 100%; width: 100%; }
.tab-list { width: 280px; min-width: 280px; max-width: 280px; overflow-y: auto; border-right: 1px solid #23262d; padding: 8px 4px; }
.group-header { font-size: 11px; color: #7c8290; text-transform: uppercase; padding: 8px 10px 4px; cursor: pointer; }
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
.state-starting { background: #a0a0a0; }
.state-exited { background: #d44; }
.state-archived { background: transparent; border: 1px solid #7c8290; }
.state-unknown { background: #7c8290; }
.resume-btn { position: absolute; right: 8px; top: 10px; padding: 2px 8px; font-size: 11px; background: #23262d; color: #d8dee9; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; display: none; }
.archived:hover .resume-btn { display: inline-block; }
.load-more { display: block; margin: 6px auto; padding: 4px 10px; font-size: 11px; background: transparent; color: #7c8290; border: 1px solid #3a3f4a; border-radius: 3px; cursor: pointer; }
.xterm-host { flex: 1; background: #15171d; min-height: 0; }
</style>
