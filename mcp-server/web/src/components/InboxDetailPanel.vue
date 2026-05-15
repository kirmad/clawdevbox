<script setup lang="ts">
/**
 * InboxDetailPanel — renders the full details of one inbox item. Used
 * in two places:
 *   - master-detail right pane (desktop ≥1024px)
 *   - mobile detail view (<1024px)
 *   - popped-out tab in the main tab strip
 *
 * Both renderings share state via the Pinia store — same body cache,
 * same lifecycle store, no duplication.
 *
 * Header controls:
 *   ✓  Mark done
 *   ⏰ Snooze ▾ (preset durations + custom)
 *   📦 Archive
 *   ↺  Reopen (only when state is done/archived/snoozed)
 *   ↗  Pop out into its own tab (hidden when ALREADY in a tab).
 *   ⤢  Toggle fullscreen for this pane.
 *   ←  Back (mobile only).
 */
import { computed, ref } from 'vue';
import { renderInboxBody } from '../markdown';
import { useUiStore } from '../stores/ui';
import { useFullscreen } from '../composables/useFullscreen';
import type { InboxAttachment, InboxItem } from '../api';

const props = defineProps<{
  itemId: string;
  /** Pane id for fullscreen coordination. */
  paneKey: string;
  /** Hide the pop-out button (we're ALREADY in a popped-out tab). */
  hidePopOut?: boolean;
  /** Show back arrow (mobile). */
  showBack?: boolean;
}>();

const emit = defineEmits<{ (e: 'back'): void }>();

const store = useUiStore();
const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(props.paneKey);

const item = computed<InboxItem | undefined>(() =>
  store.inbox.find((it) => it.id === props.itemId),
);

const bodyEntry = computed(() => store.inboxBodies[props.itemId]);
const bodyHtml = computed(() => {
  if (!item.value || !bodyEntry.value?.body) return '';
  return renderInboxBody(bodyEntry.value.body, item.value.description_format ?? 'markdown');
});

const attachments = computed<InboxAttachment[]>(() =>
  (item.value?.attachments ?? []) as InboxAttachment[],
);

const stateSeverity = computed(() => {
  switch (item.value?.state) {
    case 'done': return 'success';
    case 'open':
    case 'in_progress': return 'info';
    case 'new': return 'warn';
    case 'archived':
    case 'cancelled': return 'secondary';
    default: return 'secondary';
  }
});

const canReopen = computed(() => {
  const s = item.value?.state;
  return s === 'done' || s === 'archived' || s === 'snoozed';
});

const isActionable = computed(() => {
  // Show Done/Archive controls only when the item is still "live".
  const s = item.value?.state;
  return s === 'new' || s === 'open';
});

const pendingAction = ref<null | 'done' | 'archive' | 'snooze' | 'reopen'>(null);

async function withPending<T>(kind: 'done' | 'archive' | 'snooze' | 'reopen', fn: () => Promise<T>): Promise<T | void> {
  if (pendingAction.value) return;
  pendingAction.value = kind;
  try {
    return await fn();
  } finally {
    pendingAction.value = null;
  }
}

async function onDone(): Promise<void> {
  if (!item.value) return;
  await withPending('done', () => store.markInboxDone(item.value!.id));
}
async function onArchive(): Promise<void> {
  if (!item.value) return;
  await withPending('archive', () => store.archiveInbox(item.value!.id));
}
async function onReopen(): Promise<void> {
  if (!item.value) return;
  await withPending('reopen', () => store.reopenInbox(item.value!.id));
}

const snoozeMenu = ref();
const snoozePresets = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: 'Tomorrow 9am', tomorrow9am: true },
  { label: 'Next Monday 9am', nextMonday9am: true },
];
const snoozeItems = computed(() =>
  snoozePresets.map((p) => ({
    label: p.label,
    icon: 'pi pi-clock',
    command: () => {
      const until = computeSnoozeUntil(p);
      if (!item.value) return;
      void withPending('snooze', () => store.snoozeInbox(item.value!.id, until));
    },
  })),
);

function computeSnoozeUntil(p: typeof snoozePresets[number]): number {
  const now = new Date();
  if (p.ms) return Date.now() + p.ms;
  if (p.tomorrow9am) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (p.nextMonday9am) {
    const d = new Date(now);
    const daysUntilMonday = ((1 - d.getDay() + 7) % 7) || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() + 60 * 60 * 1000;
}

function toggleSnoozeMenu(ev: Event): void {
  snoozeMenu.value?.toggle(ev);
}

function openAttachment(att: InboxAttachment): void {
  // Tell the store where this click originated so the artifact tab can
  // render a "← back" button. paneKey is `inbox-detail:<id>` when
  // rendered inside a popped-out tab; `inbox-master` for master-detail.
  const fromTab = props.paneKey.startsWith('inbox-detail:');
  store.openInboxAttachment(att, {
    kind: fromTab ? 'inbox-tab' : 'inbox-list',
    inboxId: props.itemId,
  });
}

function popOut(): void {
  if (!item.value) return;
  store.popOutInbox(item.value.id, item.value.title);
}

function jumpToRecipe(): void { store.setActiveTab('recipes'); }
function jumpToTrigger(): void { store.setActiveTab('triggers'); }

function formatTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}
function formatSnoozeUntil(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
</script>

<template>
  <section v-if="item" class="detail-panel" :class="{ 'fs-pane': isFullscreen }">
    <header class="detail-head">
      <!-- Row 1 (desktop) / Row 1 of 2 (mobile): back + title + meta -->
      <div class="title-row">
        <Button
          v-if="showBack"
          icon="pi pi-arrow-left"
          text
          rounded
          size="small"
          aria-label="Back to inbox list"
          class="head-btn"
          @click="emit('back')"
        />
        <div class="head-text">
          <h1 class="detail-title" :title="item.title || item.id">{{ item.title || item.id }}</h1>
          <div class="detail-meta">
            <Tag :severity="stateSeverity" :value="item.state" />
            <Tag
              v-for="label in (item.labels ?? [])"
              :key="label"
              class="label-chip"
              severity="secondary"
              :value="label"
            />
            <span v-if="item.state === 'snoozed' && item.snoozed_until" class="snooze-line">
              <i class="pi pi-clock" /> until {{ formatSnoozeUntil(item.snoozed_until) }}
            </span>
            <span class="meta-line">
              {{ item.source || 'manual' }} · {{ item.kind || 'unknown' }} · {{ formatTime(item.updated_at) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Row 2 (mobile) / right side of row 1 (desktop): action buttons -->
      <div class="head-actions">
        <Button
          v-if="isActionable"
          icon="pi pi-check"
          severity="success"
          size="small"
          rounded
          :loading="pendingAction === 'done'"
          aria-label="Mark as done"
          title="Mark as done"
          class="action-btn"
          @click="onDone"
        />
        <Button
          v-if="isActionable"
          icon="pi pi-clock"
          severity="secondary"
          size="small"
          rounded
          :loading="pendingAction === 'snooze'"
          aria-label="Snooze"
          aria-haspopup="true"
          title="Snooze for…"
          class="action-btn"
          @click="toggleSnoozeMenu"
        />
        <Menu ref="snoozeMenu" :model="snoozeItems" popup />
        <Button
          v-if="item.state !== 'archived'"
          icon="pi pi-inbox"
          severity="secondary"
          size="small"
          rounded
          :loading="pendingAction === 'archive'"
          aria-label="Archive"
          title="Archive"
          class="action-btn"
          @click="onArchive"
        />
        <Button
          v-if="canReopen"
          icon="pi pi-refresh"
          severity="info"
          size="small"
          rounded
          :loading="pendingAction === 'reopen'"
          aria-label="Reopen"
          title="Reopen"
          class="action-btn"
          @click="onReopen"
        />

        <span class="action-divider" />

        <Button
          v-if="!hidePopOut"
          icon="pi pi-external-link"
          text
          rounded
          size="small"
          aria-label="Open as separate tab"
          title="Open as separate tab"
          class="head-btn"
          @click="popOut"
        />
        <Button
          :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          text
          rounded
          size="small"
          :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
          :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
          class="head-btn"
          @click="toggleFullscreen"
        />
      </div>
    </header>

    <div class="detail-scroll">
      <div v-if="item.preview" class="detail-preview">{{ item.preview }}</div>

      <div v-if="(item.description_size ?? 0) > 0" class="detail-body-section">
        <div v-if="bodyEntry?.loading" class="muted">Loading body…</div>
        <div v-else-if="bodyEntry?.error" class="error">
          Failed to load body: {{ bodyEntry.error }}
        </div>
        <div v-else class="markdown-body" v-html="bodyHtml" />
      </div>
      <div v-else class="muted no-body">No body. {{ item.preview ? '' : 'Inbox item is metadata-only.' }}</div>

      <div v-if="attachments.length > 0" class="detail-section">
        <div class="detail-section-head">
          <i class="pi pi-paperclip" /> Attachments ({{ attachments.length }})
        </div>
        <div class="attachment-grid">
          <Button
            v-for="att in attachments"
            :key="att.artifact_id"
            class="attachment-btn"
            size="small"
            severity="secondary"
            :outlined="true"
            :disabled="!att.view_url"
            :title="att.view_url ? `Open ${att.artifact_id}` : `Artifact ${att.artifact_id} not found in any workspace`"
            @click="openAttachment(att)"
          >
            <i class="pi pi-external-link" />
            <span class="att-title">{{ att.title || att.artifact_id }}</span>
            <span v-if="att.type" class="att-type">{{ att.type }}</span>
          </Button>
        </div>
      </div>

      <div v-if="item.recipe_instance?.id || item.trigger_id" class="detail-section">
        <div class="detail-section-head"><i class="pi pi-link" /> Linked</div>
        <div class="link-row">
          <Button
            v-if="item.recipe_instance?.id"
            class="link-chip"
            size="small"
            severity="info"
            :outlined="true"
            @click="jumpToRecipe"
          >
            <i class="pi pi-cog" />
            Recipe <code>{{ item.recipe_instance.id }}</code>
            <span v-if="item.recipe_instance.resolved === false" class="att-type">(missing)</span>
          </Button>
          <Button
            v-if="item.trigger_id"
            class="link-chip"
            size="small"
            severity="info"
            :outlined="true"
            @click="jumpToTrigger"
          >
            <i class="pi pi-bolt" />
            Trigger <code>{{ item.trigger_id }}</code>
          </Button>
        </div>
      </div>
    </div>
  </section>

  <section v-else class="detail-empty">
    <i class="pi pi-inbox empty-icon" />
    <div class="empty-text">Item not found.</div>
  </section>
</template>

<style scoped>
.detail-panel {
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
.title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.head-text { flex: 1; min-width: 0; }
.head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.head-btn, .action-btn { width: 30px; height: 30px; padding: 0; flex-shrink: 0; }
.action-divider { width: 1px; height: 22px; background: var(--p-content-border-color, #2a2e38); margin: 0 2px; }

/* Desktop ≥640px: title row + action buttons share a single horizontal
   row. Title still gets the lion's share thanks to flex: 1 on .head-text. */
@media (min-width: 640px) {
  .detail-head {
    flex-direction: row;
    align-items: flex-start;
    padding: 12px 16px;
    gap: 12px;
  }
  .title-row { flex: 1; min-width: 0; }
  .head-actions { flex-shrink: 0; }
}

.detail-title {
  font-size: 16px;
  margin: 0;
  color: var(--p-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.meta-line { color: var(--p-text-color-secondary); font-size: 11.5px; }
.snooze-line { color: var(--p-text-color-secondary); font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; }
.label-chip { font-size: 11px; }

.detail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-preview { color: var(--p-text-color); font-size: 14px; font-style: italic; line-height: 1.5; }
.detail-body-section { font-size: 14px; line-height: 1.6; }
.muted { color: var(--p-text-color-secondary); font-style: italic; }
.error { color: #f59e9e; }
.no-body { padding: 6px 0; }

.detail-section { display: flex; flex-direction: column; gap: 8px; }
.detail-section-head {
  color: var(--p-text-color-secondary);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: flex; align-items: center; gap: 6px;
}
.attachment-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.attachment-btn { justify-content: flex-start; }
.att-title { font-weight: 500; }
.att-type { color: var(--p-text-color-secondary); font-size: 11px; margin-left: 6px; }
.link-row { display: flex; flex-wrap: wrap; gap: 8px; }
.link-chip code { font-size: 11px; opacity: 0.9; }

.detail-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--p-text-color-secondary);
  gap: 8px;
}
.empty-icon { font-size: 28px; opacity: 0.4; }
.empty-text { font-size: 13px; }

/* Markdown styling — scoped under the detail body. */
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3) {
  color: #fff; border-bottom: 1px solid #3e3e42; padding-bottom: 4px; margin-top: 1.2em;
}
.markdown-body :deep(h1) { font-size: 1.5em; }
.markdown-body :deep(h2) { font-size: 1.25em; }
.markdown-body :deep(h3) { font-size: 1.05em; border-bottom: 0; }
.markdown-body :deep(p) { margin: 0.6em 0; }
.markdown-body :deep(a) { color: #4daafc; }
.markdown-body :deep(code) { background: #0f1115; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
.markdown-body :deep(pre) { background: #0f1115; padding: 10px 12px; border-radius: 4px; overflow-x: auto; }
.markdown-body :deep(pre code) { background: transparent; padding: 0; }
.markdown-body :deep(blockquote) { border-left: 3px solid #3e3e42; padding-left: 12px; color: var(--p-text-color-secondary); margin: 0.6em 0; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 1.4em; margin: 0.6em 0; }
.markdown-body :deep(table) { border-collapse: collapse; margin: 0.6em 0; }
.markdown-body :deep(th), .markdown-body :deep(td) { border: 1px solid #3e3e42; padding: 5px 9px; }
.markdown-body :deep(img) { max-width: 100%; }
.markdown-body :deep(.inbox-body-pre) {
  background: #0f1115; padding: 10px 12px; border-radius: 4px;
  overflow-x: auto; white-space: pre-wrap;
}
</style>
