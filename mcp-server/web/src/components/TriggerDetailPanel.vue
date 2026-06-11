<script setup lang="ts">
/**
 * TriggerDetailPanel — full details for a single registered trigger.
 *
 * Sections:
 *   - header: id + enabled tag + back / fullscreen / Run-now
 *   - type + plugin source + description
 *   - schedule: human cron label, raw cron, next fire (relative + absolute),
 *     last fire (status badge + relative), last error if any
 *   - callback recipe / thread binding
 *   - params (key/value table)
 *   - script: runtime + on-disk path + source (collapsible)
 *
 * Run-now wraps the `trigger.fire` MCP tool — enqueues a real fire row
 * that the dispatcher picks up identically to a cron tick.
 */
import { computed, ref, watch, onMounted } from 'vue';
import { useFullscreen } from '../composables/useFullscreen';
import { useUiStore } from '../stores/ui';
import {
  fetchTriggerScript,
  fetchTriggerRuns,
  fireTrigger,
  type TriggerScript,
  type TriggerRunsResponse,
  type TriggerFireRow,
  type RegisteredTrigger,
} from '../api';
import CodeBlock from './CodeBlock.vue';

const props = defineProps<{
  triggerId: string;
  paneKey: string;
  showBack?: boolean;
}>();

const emit = defineEmits<{ (e: 'back'): void }>();

const store = useUiStore();
const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(props.paneKey);

const trigger = computed<RegisteredTrigger | undefined>(() =>
  store.triggers.find((t) => t.id === props.triggerId),
);

const enabledSeverity = computed(() => (trigger.value?.enabled ? 'success' : 'secondary'));

// ── Fire (Run now) state ──────────────────────────────────────────────────
const fireBusy = ref(false);
const fireToast = ref<{ kind: 'success' | 'error'; text: string } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

async function runNow(): Promise<void> {
  if (!trigger.value || fireBusy.value) return;
  fireBusy.value = true;
  fireToast.value = null;
  try {
    const result = await fireTrigger(trigger.value.id);
    const fireId = result.structuredContent?.fire_id ?? '(no fire_id)';
    fireToast.value = { kind: 'success', text: `Queued — fire ${fireId}` };
  } catch (err) {
    fireToast.value = { kind: 'error', text: (err as Error).message };
  } finally {
    fireBusy.value = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { fireToast.value = null; }, 6000);
  }
}

// ── Script preview ────────────────────────────────────────────────────────
const script = ref<TriggerScript | null>(null);
const scriptLoading = ref(false);
const scriptError = ref<string | null>(null);
const scriptExpanded = ref(true);

async function loadScript(): Promise<void> {
  if (!trigger.value) return;
  scriptLoading.value = true;
  scriptError.value = null;
  try {
    script.value = await fetchTriggerScript(trigger.value.id);
  } catch (err) {
    scriptError.value = (err as Error).message;
    script.value = null;
  } finally {
    scriptLoading.value = false;
  }
}

// ── Last-run output (stdout + stderr from the most recent fire) ──────────
const runs = ref<TriggerRunsResponse | null>(null);
const runsLoading = ref(false);
const runsError = ref<string | null>(null);
const runsExpanded = ref(true);
const showAllRuns = ref(false);

async function loadRuns(): Promise<void> {
  if (!trigger.value) return;
  runsLoading.value = true;
  runsError.value = null;
  try {
    runs.value = await fetchTriggerRuns(trigger.value.id, 10);
  } catch (err) {
    runsError.value = (err as Error).message;
    runs.value = null;
  } finally {
    runsLoading.value = false;
  }
}

function fireSeverity(s: string): 'success' | 'danger' | 'info' | 'secondary' | 'warn' {
  switch (s) {
    case 'success': return 'success';
    case 'failed':
    case 'dead': return 'danger';
    case 'running': return 'info';
    case 'retrying': return 'warn';
    case 'skipped': return 'secondary';
    default: return 'info';
  }
}

function fireDuration(r: TriggerFireRow): string {
  if (r.duration_ms != null) {
    return r.duration_ms < 1000 ? `${r.duration_ms}ms` : `${(r.duration_ms / 1000).toFixed(1)}s`;
  }
  if (r.started_at && r.finished_at) {
    const ms = r.finished_at - r.started_at;
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  return '';
}

onMounted(loadScript);
onMounted(loadRuns);
watch(() => props.triggerId, () => { loadScript(); loadRuns(); });
// When a fire is queued via Run-now, refresh runs after a short delay so
// the dispatcher has time to pick it up and finish.
watch(fireToast, (v) => {
  if (v && v.kind === 'success') {
    setTimeout(loadRuns, 3000);
    setTimeout(loadRuns, 8000);
  }
});

function relativeTime(ts?: number | null): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff < 0 ? `in ${Math.round(abs / 1000)}s` : `${Math.round(abs / 1000)}s ago`;
  if (abs < 3_600_000) return diff < 0 ? `in ${Math.round(abs / 60_000)}m` : `${Math.round(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return diff < 0 ? `in ${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function absoluteTime(ts?: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function lastRunBadge(): { label: string; severity: 'success' | 'danger' | 'info' | 'secondary' } {
  const t = trigger.value;
  if (!t || !t.last_run_at) return { label: 'never run', severity: 'secondary' };
  const when = relativeTime(t.last_run_at);
  if (t.last_run_status === 'success') return { label: `ok · ${when}`, severity: 'success' };
  if (t.last_run_status === 'failure') return { label: `failed · ${when}`, severity: 'danger' };
  return { label: when, severity: 'info' };
}

function cronDisplay(): { label: string; raw: string } {
  const t = trigger.value;
  if (!t) return { label: '', raw: '' };
  if (t.resolved_cron === false || t.resolved_cron === '') {
    return { label: 'cron disabled (webhook / manual only)', raw: '' };
  }
  const raw = typeof t.resolved_cron === 'string' ? t.resolved_cron : '';
  const label = t.cron_label || (raw || 'inherited');
  return { label, raw };
}

function paramRows() {
  const t = trigger.value;
  if (!t || !t.params) return [];
  return Object.entries(t.params).map(([k, v]) => ({
    k,
    v: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}
</script>

<template>
  <section v-if="trigger" class="trigger-detail" :class="{ 'fs-pane': isFullscreen }">
    <header class="detail-head">
      <div class="title-row">
        <Button
          v-if="showBack"
          icon="pi pi-arrow-left"
          text rounded size="small"
          aria-label="Back to triggers list"
          class="head-btn"
          @click="emit('back')"
        />
        <div class="head-text">
          <h1 class="detail-title">{{ trigger.id }}</h1>
          <div class="detail-meta">
            <Tag :severity="enabledSeverity" :value="trigger.enabled ? 'enabled' : 'disabled'" />
            <Tag :value="trigger.type" severity="info" />
            <span v-if="trigger.source_plugin_id" class="meta-line">
              via plugin:{{ trigger.source_plugin_id }}
            </span>
          </div>
        </div>
      </div>
      <div class="head-actions">
        <Button
          icon="pi pi-play"
          label="Run now"
          size="small"
          severity="success"
          :outlined="true"
          :loading="fireBusy"
          :disabled="fireBusy"
          aria-label="Force run this trigger"
          title="Enqueue a manual fire — dispatcher picks it up like a cron tick"
          class="head-btn-run"
          @click="runNow"
        />
        <Button
          :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          text rounded size="small"
          :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
          :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
          class="head-btn"
          @click="toggleFullscreen"
        />
      </div>
    </header>

    <div v-if="fireToast" class="fire-toast" :class="`fire-toast-${fireToast.kind}`">
      <i :class="fireToast.kind === 'success' ? 'pi pi-check-circle' : 'pi pi-times-circle'" />
      <span>{{ fireToast.text }}</span>
    </div>

    <div class="detail-scroll">
      <section v-if="trigger.type_description" class="block">
        <div class="block-head"><i class="pi pi-info-circle" /> What it does</div>
        <div class="description">{{ trigger.type_description }}</div>
      </section>

      <section class="block">
        <div class="block-head"><i class="pi pi-clock" /> Schedule</div>
        <dl class="kv">
          <dt>cron</dt>
          <dd>
            {{ cronDisplay().label }}
            <code v-if="cronDisplay().raw" class="raw-cron">{{ cronDisplay().raw }}</code>
          </dd>
          <dt v-if="trigger.next_run_at">next fire</dt>
          <dd v-if="trigger.next_run_at">
            <span class="prominent">{{ relativeTime(trigger.next_run_at) }}</span>
            <span class="muted">· {{ absoluteTime(trigger.next_run_at) }}</span>
          </dd>
          <dt>last run</dt>
          <dd>
            <Tag :severity="lastRunBadge().severity" :value="lastRunBadge().label" />
          </dd>
          <dt v-if="trigger.last_run_error">last error</dt>
          <dd v-if="trigger.last_run_error" class="error">{{ trigger.last_run_error }}</dd>
        </dl>
      </section>

      <section
        v-if="trigger.subscriber_thread_id"
        class="block"
      >
        <div class="block-head"><i class="pi pi-link" /> When it fires</div>
        <div class="muted">
          Subscriber thread: <code>{{ trigger.subscriber_thread_id }}</code>
        </div>
      </section>

      <section v-if="paramRows().length > 0" class="block">
        <div class="block-head"><i class="pi pi-cog" /> Parameters</div>
        <dl class="kv params">
          <template v-for="row in paramRows()" :key="row.k">
            <dt>{{ row.k }}</dt>
            <dd><code>{{ row.v }}</code></dd>
          </template>
        </dl>
      </section>

      <section class="block">
        <div class="block-head">
          <i class="pi pi-code" /> Script
          <button
            type="button"
            class="script-toggle"
            :aria-expanded="scriptExpanded"
            @click="scriptExpanded = !scriptExpanded"
          >
            <i :class="scriptExpanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
            {{ scriptExpanded ? 'hide' : 'show' }}
          </button>
          <button
            type="button"
            class="script-toggle"
            title="Reload from disk"
            @click="loadScript"
          >
            <i class="pi pi-refresh" /> reload
          </button>
        </div>
        <div v-if="scriptExpanded">
          <div v-if="scriptLoading" class="muted">Loading…</div>
          <div v-else-if="scriptError" class="error">Failed to load: {{ scriptError }}</div>
          <template v-else-if="script">
            <dl class="kv">
              <dt>runtime</dt>
              <dd><code>{{ script.runtime }}</code></dd>
              <dt v-if="script.path_rel">path</dt>
              <dd v-if="script.path_rel" :title="script.path || ''">
                <code>{{ script.path_rel }}</code>
              </dd>
            </dl>
            <div v-if="script.error" class="error">
              {{ script.error.code }}: {{ script.error.message }}
            </div>
            <CodeBlock
              v-if="script.source"
              :source="script.source"
              :runtime="script.runtime"
              :max-height="500"
            />
            <div v-else-if="!script.error" class="muted">(script is empty)</div>
          </template>
        </div>
      </section>

      <section class="block">
        <div class="block-head">
          <i class="pi pi-history" /> Last run
          <button
            type="button"
            class="script-toggle"
            :aria-expanded="runsExpanded"
            @click="runsExpanded = !runsExpanded"
          >
            <i :class="runsExpanded ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
            {{ runsExpanded ? 'hide' : 'show' }}
          </button>
          <button
            type="button"
            class="script-toggle"
            title="Reload from disk"
            @click="loadRuns"
          >
            <i class="pi pi-refresh" /> reload
          </button>
        </div>
        <div v-if="runsExpanded">
          <div v-if="runsLoading" class="muted">Loading…</div>
          <div v-else-if="runsError" class="error">Failed to load: {{ runsError }}</div>
          <div v-else-if="!runs || runs.items.length === 0" class="muted">No runs yet.</div>
          <template v-else>
            <div class="run-head">
              <Tag :severity="fireSeverity(runs.items[0].status)" :value="runs.items[0].status" />
              <code class="run-fire-id" :title="runs.items[0].fire_id">{{ runs.items[0].fire_id }}</code>
              <span class="muted">{{ runs.items[0].source }}</span>
              <span v-if="fireDuration(runs.items[0])" class="muted">· {{ fireDuration(runs.items[0]) }}</span>
              <span v-if="runs.items[0].exit_code != null" class="muted">· exit={{ runs.items[0].exit_code }}</span>
              <span v-if="runs.items[0].started_at" class="muted">
                · {{ relativeTime(runs.items[0].started_at) }}
              </span>
            </div>

            <div v-if="runs.items[0].error" class="run-error">
              <div class="run-error-label">dispatcher error</div>
              <pre class="run-error-body">{{ runs.items[0].error }}</pre>
            </div>

            <template v-if="runs.latest">
              <div
                v-if="runs.latest.fire_id !== runs.items[0].fire_id"
                class="muted run-stale-note"
              >
                <i class="pi pi-info-circle" />
                Most recent fire is <strong>{{ runs.items[0].status }}</strong> — output below is from the last completed run
                <code class="run-fire-id-inline">{{ runs.latest.fire_id }}</code>
              </div>
              <div v-if="runs.latest.stdout" class="run-stream">
                <div class="run-stream-label">
                  <i class="pi pi-angle-right" /> stdout
                  <span v-if="runs.latest.stdout_parsed" class="muted">(parsed as JSON)</span>
                </div>
                <CodeBlock
                  :source="runs.latest.stdout"
                  :language="runs.latest.stdout_parsed ? 'json' : undefined"
                  :max-height="320"
                />
              </div>
              <div v-if="runs.latest.stderr" class="run-stream">
                <div class="run-stream-label run-stream-label-err">
                  <i class="pi pi-exclamation-triangle" /> stderr
                </div>
                <CodeBlock
                  :source="runs.latest.stderr"
                  :max-height="320"
                />
              </div>
              <div
                v-if="!runs.latest.stdout && !runs.latest.stderr && !runs.items[0].error"
                class="muted"
              >
                (no output captured for this fire)
              </div>
            </template>
            <div
              v-else-if="!runs.items[0].error"
              class="muted"
            >
              <i class="pi pi-info-circle" />
              No completed runs yet — output appears once a fire finishes.
            </div>

            <div v-if="runs.items.length > 1" class="run-history">
              <button
                type="button"
                class="script-toggle"
                @click="showAllRuns = !showAllRuns"
              >
                <i :class="showAllRuns ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
                {{ showAllRuns ? 'hide' : 'show' }} previous {{ runs.items.length - 1 }} run{{ runs.items.length === 2 ? '' : 's' }}
              </button>
              <ul v-if="showAllRuns" class="run-list">
                <li v-for="r in runs.items.slice(1)" :key="r.fire_id" class="run-list-item">
                  <Tag :severity="fireSeverity(r.status)" :value="r.status" />
                  <code class="run-fire-id" :title="r.fire_id">{{ r.fire_id }}</code>
                  <span class="muted">{{ r.source }}</span>
                  <span v-if="fireDuration(r)" class="muted">· {{ fireDuration(r) }}</span>
                  <span v-if="r.exit_code != null" class="muted">· exit={{ r.exit_code }}</span>
                  <span v-if="r.scheduled_at" class="muted">· {{ relativeTime(r.scheduled_at) }}</span>
                  <span v-if="r.error" class="run-error-tag" :title="r.error">error</span>
                </li>
              </ul>
            </div>
          </template>
        </div>
      </section>

      <section class="block meta-block">
        <div class="block-head"><i class="pi pi-tag" /> Metadata</div>
        <dl class="kv">
          <dt>registered</dt>
          <dd>{{ relativeTime(trigger.registered_at) }} <span class="muted">· {{ absoluteTime(trigger.registered_at) }}</span></dd>
        </dl>
      </section>
    </div>
  </section>

  <section v-else class="trigger-empty">
    <i class="pi pi-bolt empty-icon" />
    <div class="empty-text">Trigger not found.</div>
  </section>
</template>

<style scoped>
.trigger-detail {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--p-content-background, #15171d);
}
.detail-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  flex-shrink: 0;
}
.title-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.head-text { flex: 1; min-width: 0; }
.head-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.head-btn { width: 30px; height: 30px; padding: 0; flex-shrink: 0; }
.head-btn-run { flex-shrink: 0; }

@media (min-width: 640px) {
  .detail-head { flex-direction: row; align-items: flex-start; padding: 12px 16px; gap: 12px; }
  .title-row { flex: 1; min-width: 0; }
}

.detail-title {
  font-size: 15px;
  margin: 0;
  font-family: ui-monospace, Consolas, Menlo, monospace;
  color: var(--p-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  word-break: break-all;
}
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.meta-line { color: var(--p-text-color-secondary); font-size: 11.5px; }

.fire-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
}
.fire-toast-success { background: rgba(74, 222, 128, 0.10); color: #4ade80; }
.fire-toast-error   { background: rgba(248, 113, 113, 0.10); color: #f87171; }

.detail-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 12px 16px 32px;
  display: flex; flex-direction: column; gap: 14px;
}

.block { display: flex; flex-direction: column; gap: 6px; }
.block-head {
  color: var(--p-text-color-secondary);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex; align-items: center; gap: 6px;
}
.description { color: var(--p-text-color); font-size: 13px; line-height: 1.5; white-space: pre-wrap; }

.kv {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 4px 8px;
  margin: 0; font-size: 12.5px;
}
.kv dt { color: var(--p-text-color-secondary); }
.kv dd { margin: 0; word-break: break-word; }
.kv code { background: #14161b; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
.raw-cron { margin-left: 8px; opacity: 0.7; font-size: 11px; }
.muted { color: var(--p-text-color-secondary); font-size: 11.5px; margin-left: 4px; }
.error { color: #f87171; font-size: 12px; }
.prominent { color: var(--p-text-color); font-weight: 500; }
.params dt { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11.5px; }

.script-toggle {
  background: transparent;
  border: none;
  color: var(--p-text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
  text-transform: none;
  letter-spacing: 0;
  padding: 2px 4px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 8px;
}
.script-toggle:hover { color: var(--p-text-color); }
.script-toggle i { font-size: 9px; }

/* ---- Last run section ---- */
.run-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
}
.run-fire-id {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  font-size: 11px;
  background: #14161b;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--p-text-color-secondary);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-stream {
  margin-top: 10px;
}
.run-stream-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--p-text-color-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.run-stream-label-err { color: #f87171; }
.run-stream-label i { font-size: 10px; }

.run-error {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(248, 113, 113, 0.08);
  border-left: 3px solid #f87171;
  border-radius: 0 4px 4px 0;
  font-size: 12px;
}
.run-error-label {
  color: #f87171;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.run-error-body {
  margin: 0;
  font-family: ui-monospace, Consolas, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--p-text-color);
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

.run-history { margin-top: 12px; }
.run-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.run-list-item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 3px;
  background: #14161b;
  font-size: 11.5px;
}
.run-error-tag {
  color: #f87171;
  font-size: 10.5px;
  margin-left: auto;
  text-decoration: underline dotted;
  cursor: help;
}
.run-stale-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 8px;
  padding: 6px 10px;
  background: rgba(255, 200, 100, 0.06);
  border-left: 2px solid #e6b06b;
  border-radius: 0 3px 3px 0;
  font-size: 11.5px;
}
.run-stale-note i { font-size: 11px; color: #e6b06b; }
.run-fire-id-inline {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  font-size: 11px;
  background: #14161b;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 2px;
}

.trigger-empty {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; color: var(--p-text-color-secondary);
}
.empty-icon { font-size: 28px; opacity: 0.4; }
.empty-text { font-size: 13px; }
</style>
