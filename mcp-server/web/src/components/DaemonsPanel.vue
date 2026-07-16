<script setup lang="ts">
/**
 * DaemonsPanel — list of supervised daemons with live health + controls.
 *
 * Daemons are long-lived scripts the clawdevbox supervisor keeps running
 * (e.g. the Teams listener). This panel surfaces each daemon's health,
 * pid, uptime, restart count, and last error, and exposes start / stop /
 * restart / view-logs actions.
 *
 * Self-contained: fetches its own data via `/api/daemons`, refreshes on
 * the `clawdevbox:sse:daemons` window event (dispatched by realtime.ts for
 * the 'daemons' SSE topic) and on a 5s poll fallback. No Pinia state.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  fetchDaemons,
  daemonAction,
  fetchDaemonLogs,
  type DaemonInfo,
  type DaemonAction,
  type DaemonHealth,
} from '../api';

const items = ref<DaemonInfo[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const busy = ref<Record<string, boolean>>({});
const now = ref(Date.now());

// Logs dialog state.
const logsOpen = ref(false);
const logsDaemon = ref<DaemonInfo | null>(null);
const logsText = ref('');
const logsLoading = ref(false);
const logsError = ref<string | null>(null);

let pollTimer: number | null = null;
let clockTimer: number | null = null;

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await fetchDaemons();
    items.value = r.items;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function act(d: DaemonInfo, action: DaemonAction): Promise<void> {
  busy.value = { ...busy.value, [d.id]: true };
  try {
    await daemonAction(d.id, action);
    await load();
  } catch (e) {
    error.value = `${action} ${d.name}: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = { ...busy.value, [d.id]: false };
  }
}

async function openLogs(d: DaemonInfo): Promise<void> {
  logsDaemon.value = d;
  logsOpen.value = true;
  await refreshLogs();
}

async function refreshLogs(): Promise<void> {
  if (!logsDaemon.value) return;
  logsLoading.value = true;
  try {
    const r = await fetchDaemonLogs(logsDaemon.value.id, 65_536);
    logsText.value = r.tail || '(empty log)';
    logsError.value = null;
  } catch (e) {
    logsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    logsLoading.value = false;
  }
}

const runningCount = computed(() => items.value.filter((d) => d.health === 'running' || d.health === 'starting').length);

function healthSeverity(h: DaemonHealth): string {
  switch (h) {
    case 'running': return 'success';
    case 'starting': return 'info';
    case 'crashed': return 'danger';
    case 'stopped': return 'secondary';
    default: return 'warn';
  }
}

function healthLabel(h: DaemonHealth): string {
  switch (h) {
    case 'running': return 'running';
    case 'starting': return 'starting';
    case 'crashed': return 'crash-looping';
    case 'stopped': return 'stopped';
    default: return 'down';
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}

function retryHint(d: DaemonInfo): string {
  if (d.health !== 'crashed' || !d.next_restart_at) return '';
  const diff = d.next_restart_at - now.value;
  if (diff <= 0) return 'retrying…';
  return `retry in ${fmtDuration(diff)}`;
}

function commandLine(d: DaemonInfo): string {
  return d.command.join(' ');
}

function onSseDaemons(): void { void load(); }

onMounted(() => {
  void load();
  window.addEventListener('clawdevbox:sse:daemons', onSseDaemons);
  pollTimer = window.setInterval(() => { void load(); }, 5000);
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  window.removeEventListener('clawdevbox:sse:daemons', onSseDaemons);
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (clockTimer !== null) window.clearInterval(clockTimer);
});
</script>

<template>
  <section class="panel">
    <header class="head">
      <h1>Daemons</h1>
      <Badge v-if="items.length > 0" :value="`${runningCount}/${items.length} up`" severity="secondary" />
      <span class="spacer" />
      <Button
        icon="pi pi-refresh"
        label="Refresh"
        size="small"
        severity="secondary"
        outlined
        :loading="loading"
        @click="load()"
      />
    </header>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <div v-if="items.length === 0 && !loading" class="empty">
      No daemons registered. Long-lived listeners (e.g. the Teams listener)
      appear here once registered via <code>daemon.register</code>.
    </div>

    <ul class="cards">
      <li v-for="d in items" :key="d.id" class="card" :data-health="d.health">
        <div class="card-main">
          <div class="title-row">
            <span class="dot" :data-health="d.health" />
            <span class="name">{{ d.name }}</span>
            <Badge :value="healthLabel(d.health)" :severity="healthSeverity(d.health)" />
            <code class="id">{{ d.id }}</code>
          </div>

          <div class="meta-row">
            <span v-if="d.pid" class="meta"><span class="k">pid</span> {{ d.pid }}</span>
            <span v-if="d.uptime_ms != null" class="meta"><span class="k">uptime</span> {{ fmtDuration(d.uptime_ms) }}</span>
            <span class="meta"><span class="k">restarts</span> {{ d.restart_count }}</span>
            <span v-if="retryHint(d)" class="meta retry">{{ retryHint(d) }}</span>
            <span class="meta runtime"><span class="k">runtime</span> {{ d.runtime }}</span>
          </div>

          <code class="cmd" :title="commandLine(d)">{{ commandLine(d) }}</code>

          <p v-if="d.last_error" class="last-error">
            <i class="pi pi-exclamation-triangle" /> last error: {{ d.last_error }}
          </p>
        </div>

        <div class="actions">
          <Button
            v-if="d.health !== 'running' && d.health !== 'starting'"
            label="Start"
            icon="pi pi-play"
            size="small"
            severity="success"
            :loading="busy[d.id]"
            @click="act(d, 'start')"
          />
          <Button
            v-else
            label="Stop"
            icon="pi pi-stop"
            size="small"
            severity="danger"
            outlined
            :loading="busy[d.id]"
            @click="act(d, 'stop')"
          />
          <Button
            label="Restart"
            icon="pi pi-replay"
            size="small"
            severity="secondary"
            outlined
            :loading="busy[d.id]"
            @click="act(d, 'restart')"
          />
          <Button
            label="Logs"
            icon="pi pi-file"
            size="small"
            severity="secondary"
            text
            @click="openLogs(d)"
          />
        </div>
      </li>
    </ul>

    <Dialog
      v-model:visible="logsOpen"
      modal
      :header="logsDaemon ? `Logs — ${logsDaemon.name}` : 'Logs'"
      :style="{ width: '80vw', maxWidth: '1100px' }"
    >
      <div class="logs-toolbar">
        <Button
          icon="pi pi-refresh"
          label="Refresh"
          size="small"
          severity="secondary"
          outlined
          :loading="logsLoading"
          @click="refreshLogs()"
        />
      </div>
      <p v-if="logsError" class="error-banner">{{ logsError }}</p>
      <pre class="logs"><code>{{ logsText }}</code></pre>
    </Dialog>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; overflow-y: auto; padding: 16px; gap: 12px; }
.head { display: flex; align-items: center; gap: 10px; }
.head h1 { font-size: 16px; margin: 0; color: var(--p-text-color); }
.spacer { flex: 1; }
.error-banner { color: #bf616a; background: rgba(191, 97, 106, 0.12); border: 1px solid rgba(191, 97, 106, 0.4); padding: 8px 10px; border-radius: 6px; font-size: 12.5px; margin: 0; white-space: pre-wrap; }
.empty { color: var(--p-text-color-secondary); font-size: 13px; }
.cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.card { display: flex; gap: 14px; justify-content: space-between; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--p-content-border-color); border-radius: 10px; background: var(--p-content-background); }
.card[data-health="crashed"] { border-color: rgba(191, 97, 106, 0.55); }
.card[data-health="running"] { border-color: rgba(163, 190, 140, 0.45); }
.card-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; }
.title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.name { font-weight: 600; color: var(--p-text-color); font-size: 13.5px; }
.id { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--p-text-color-secondary); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: #6c7689; }
.dot[data-health="running"] { background: #a3be8c; box-shadow: 0 0 6px rgba(163, 190, 140, 0.7); }
.dot[data-health="starting"] { background: #88c0d0; }
.dot[data-health="crashed"] { background: #bf616a; box-shadow: 0 0 6px rgba(191, 97, 106, 0.7); }
.dot[data-health="stopped"] { background: #6c7689; }
.dot[data-health="down"] { background: #ebcb8b; }
.meta-row { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: var(--p-text-color); }
.meta .k { color: #88c0d0; text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; margin-right: 4px; }
.meta.retry { color: #ebcb8b; }
.meta.runtime { color: var(--p-text-color-secondary); }
.cmd { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--p-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.last-error { color: #d08770; font-size: 12px; margin: 2px 0 0; word-break: break-word; }
.actions { display: flex; flex-direction: column; gap: 6px; flex: none; }
.logs-toolbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
.logs { max-height: 60vh; overflow: auto; background: #11141a; border: 1px solid var(--p-content-border-color); border-radius: 8px; padding: 10px; font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
</style>
