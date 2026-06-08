<script setup lang="ts">
/**
 * InboxListRail — compact card list. Each card shows title + preview +
 * icon cluster (attachments / recipe / trigger / body) + state tag +
 * label chips. Clicking a card emits `select` with the item id; the
 * parent decides whether to load it into a master-detail right pane
 * (desktop) or push a detail view (mobile).
 */
import { computed } from 'vue';
import { useUiStore } from '../stores/ui';
import type { InboxItem } from '../api';

const props = defineProps<{
  selectedId: string | null;
}>();

const emit = defineEmits<{ (e: 'select', id: string): void }>();

const store = useUiStore();
const items = computed(() => store.inbox);
// `props` is consumed in the template (selectedId), the binding is
// kept so TS-aware linters don't drop the import.
void props;

function stateSeverity(state: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (state) {
    case 'done': return 'success';
    case 'in_progress':
    case 'open': return 'info';
    case 'new': return 'warn';
    case 'archived':
    case 'cancelled': return 'secondary';
    default: return 'secondary';
  }
}

function attachmentCount(it: InboxItem): number {
  return Array.isArray(it.attachments) ? it.attachments.length : 0;
}

function previewLine(it: InboxItem): string {
  return it.preview?.trim() || it.agent_message?.trim() || '';
}

function formatTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString();
}
</script>

<template>
  <div class="list-rail">
    <Message v-if="store.inboxError" severity="error" :closable="false">
      Failed to load: {{ store.inboxError }}
    </Message>

    <div v-if="items.length === 0 && !store.inboxLoading" class="empty">
      No items. Anything pushed via <code>inbox.upsert</code> lands here.
    </div>

    <button
      v-for="it in items"
      :key="it.id"
      type="button"
      class="card"
      :class="{ active: selectedId === it.id, unread: it.unread === true }"
      :aria-pressed="selectedId === it.id"
      @click="emit('select', it.id)"
    >
      <div class="card-row title-row">
        <span
          v-if="it.unread === true"
          class="unread-dot"
          aria-label="Unread"
          title="Unread"
        />
        <span class="title-text">{{ it.title || it.id }}</span>
        <span class="time">{{ formatTime(it.updated_at) }}</span>
      </div>
      <div v-if="previewLine(it)" class="card-preview">{{ previewLine(it) }}</div>
      <div class="card-row chips-row">
        <Tag :severity="stateSeverity(it.state)" :value="it.state" />
        <Tag
          v-for="label in (it.labels ?? []).slice(0, 3)"
          :key="label"
          class="label-chip"
          severity="secondary"
          :value="label"
        />
        <span v-if="(it.labels?.length ?? 0) > 3" class="label-more">+{{ (it.labels!.length - 3) }}</span>
        <span class="card-icons">
          <i
            v-if="attachmentCount(it) > 0"
            class="pi pi-paperclip icon-chip"
            :title="`${attachmentCount(it)} attachment(s)`"
          >
            <span class="icon-count">{{ attachmentCount(it) }}</span>
          </i>
          <i v-if="it.recipe_instance?.id" class="pi pi-cog icon-chip" :title="`Recipe ${it.recipe_instance.id}`" />
          <i v-if="it.trigger_id" class="pi pi-bolt icon-chip" :title="`Trigger ${it.trigger_id}`" />
          <i
            v-if="(it.description_size ?? 0) > 0"
            class="pi pi-file icon-chip"
            :title="`Body: ${it.description_size} bytes`"
          />
        </span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.list-rail {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.empty { color: var(--p-text-color-secondary); padding: 8px; }

.card {
  text-align: left;
  background: #1c1f27;
  border: 1px solid transparent;
  border-left: 3px solid transparent;
  color: var(--p-text-color);
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font: inherit;
}
.card:hover { background: #20232c; }
.card.active {
  background: #232733;
  border-left-color: var(--p-primary-color, #88c0d0);
}
.card.unread .title-text {
  font-weight: 700;
}
.card:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: 1px; }

.card-row { display: flex; align-items: center; gap: 6px; }
.title-row { justify-content: space-between; }
.unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--p-primary-color, #88c0d0);
  flex-shrink: 0;
  display: inline-block;
}
.title-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 13.5px;
}
.time { color: var(--p-text-color-secondary); font-size: 11px; flex-shrink: 0; }
.card-preview {
  color: var(--p-text-color-secondary);
  font-size: 12px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chips-row { flex-wrap: wrap; }
.label-chip { font-size: 10.5px; }
.label-more { color: var(--p-text-color-secondary); font-size: 11px; }
.card-icons { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; color: var(--p-text-color-secondary); font-size: 12px; }
.icon-chip {
  position: relative; display: inline-flex; align-items: center; gap: 2px;
  padding: 1px 3px; border-radius: 3px; background: rgba(255,255,255,0.05);
}
.icon-count { font-size: 10px; line-height: 1; font-weight: 600; }
</style>
