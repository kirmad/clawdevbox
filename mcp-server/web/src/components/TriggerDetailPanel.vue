<script setup lang="ts">
/**
 * TriggerDetailPanel — full details for a single registered trigger.
 *
 * Sections:
 *   - header: id + enabled tag + back / fullscreen
 *   - type + plugin source + description
 *   - schedule: human cron label, raw cron, next fire (relative + absolute),
 *     last fire (status badge + relative), last error if any
 *   - callback recipe / thread binding
 *   - params (key/value table)
 *
 * Read-only for now. Enable/Disable/Fire/Unregister will land alongside
 * the matching HTTP mutation endpoints.
 */
import { computed } from 'vue';
import { useFullscreen } from '../composables/useFullscreen';
import { useUiStore } from '../stores/ui';
import type { RegisteredTrigger } from '../api';

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
          :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          text rounded size="small"
          :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
          :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
          class="head-btn"
          @click="toggleFullscreen"
        />
      </div>
    </header>

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
.head-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.head-btn { width: 30px; height: 30px; padding: 0; flex-shrink: 0; }

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

.trigger-empty {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; color: var(--p-text-color-secondary);
}
.empty-icon { font-size: 28px; opacity: 0.4; }
.empty-text { font-size: 13px; }
</style>
