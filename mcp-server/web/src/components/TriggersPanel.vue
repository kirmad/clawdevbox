<script setup lang="ts">
/**
 * TriggersPanel — responsive master-detail shell for registered triggers.
 * Same pattern as RecipesPanel / InboxPanel.
 */
import { computed, onMounted, ref, watch } from 'vue';
import TriggerDetailPanel from './TriggerDetailPanel.vue';
import { useMobileHistory } from '../composables/useMobileHistory';
import { useUiStore } from '../stores/ui';
import type { RegisteredTrigger } from '../api';

const DESKTOP_MIN_PX = 1024;
const store = useUiStore();
const isDesktop = ref(false);

function recompute(): void {
  isDesktop.value = window.matchMedia(`(min-width: ${DESKTOP_MIN_PX}px)`).matches;
}

const mobileNav = useMobileHistory({
  key: 'trigger-detail',
  onClose: () => { store.selectTrigger(null); },
});

const items = computed(() => store.triggers);
const selectedId = computed(() => store.selectedTriggerId);

function onSelect(id: string): void {
  store.selectTrigger(id);
  if (!isDesktop.value) mobileNav.open();
}
function onBack(): void { mobileNav.close(); }

function shortCron(t: RegisteredTrigger): string {
  if (t.resolved_cron === false || t.resolved_cron === '') return 'manual / webhook';
  return t.cron_label || (typeof t.resolved_cron === 'string' ? t.resolved_cron : 'inherited');
}

function relativeNext(t: RegisteredTrigger): string {
  if (!t.enabled) return 'disabled';
  if (!t.next_run_at) return '';
  const diff = t.next_run_at - Date.now();
  if (diff < 0) return 'overdue';
  if (diff < 60_000) return `in ${Math.round(diff / 1000)}s`;
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return new Date(t.next_run_at).toLocaleString();
}

function relativeLast(t: RegisteredTrigger): string {
  if (!t.last_run_at) return 'never run';
  const diff = Date.now() - t.last_run_at;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(t.last_run_at).toLocaleDateString();
}

onMounted(() => {
  recompute();
  window.addEventListener('resize', recompute);
  watch(
    [() => items.value.length, () => isDesktop.value],
    () => {
      if (isDesktop.value && !store.selectedTriggerId && items.value.length > 0) {
        store.selectTrigger(items.value[0].id);
      }
    },
    { immediate: true },
  );
});
</script>

<template>
  <section class="panel" :class="{ 'is-desktop': isDesktop }">
    <template v-if="isDesktop">
      <aside class="rail-col">
        <header class="rail-head">
          <h1>Triggers</h1>
          <Badge v-if="items.length > 0" :value="items.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
        </header>
        <div class="list-rail">
          <Message v-if="store.triggersError" severity="error" :closable="false">
            Failed to load: {{ store.triggersError }}
          </Message>
          <div v-if="items.length === 0 && !store.triggersLoading" class="empty">
            No registered triggers. Use the <code>trigger.register</code> MCP tool to add one.
          </div>
          <button
            v-for="t in items"
            :key="t.id"
            type="button"
            class="card"
            :class="{ active: selectedId === t.id, disabled: !t.enabled }"
            @click="onSelect(t.id)"
          >
            <div class="card-row title-row">
              <span class="title-text">{{ t.id }}</span>
              <Tag v-if="!t.enabled" value="off" severity="secondary" />
            </div>
            <div class="card-row">
              <Tag :value="t.type" severity="info" />
              <span class="cron">{{ shortCron(t) }}</span>
            </div>
            <div class="card-row when-row">
              <span class="when-block"><i class="pi pi-arrow-up-right" /> next {{ relativeNext(t) || '—' }}</span>
              <span class="when-block"><i class="pi pi-history" /> last {{ relativeLast(t) }}</span>
            </div>
          </button>
        </div>
      </aside>
      <div class="detail-col">
        <TriggerDetailPanel
          v-if="selectedId"
          :key="selectedId"
          :trigger-id="selectedId"
          pane-key="trigger-master"
        />
        <div v-else class="detail-empty">
          <i class="pi pi-bolt empty-icon" />
          <div class="empty-text">Select a trigger to view its schedule.</div>
        </div>
      </div>
    </template>

    <template v-else>
      <div v-show="!mobileNav.isOpen.value || !selectedId" class="rail-only">
        <header class="rail-head">
          <h1>Triggers</h1>
          <Badge v-if="items.length > 0" :value="items.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
        </header>
        <div class="list-rail">
          <Message v-if="store.triggersError" severity="error" :closable="false">
            Failed to load: {{ store.triggersError }}
          </Message>
          <div v-if="items.length === 0 && !store.triggersLoading" class="empty">
            No registered triggers.
          </div>
          <button
            v-for="t in items"
            :key="t.id"
            type="button"
            class="card"
            :class="{ active: selectedId === t.id, disabled: !t.enabled }"
            @click="onSelect(t.id)"
          >
            <div class="card-row title-row">
              <span class="title-text">{{ t.id }}</span>
              <Tag v-if="!t.enabled" value="off" severity="secondary" />
            </div>
            <div class="card-row">
              <Tag :value="t.type" severity="info" />
              <span class="cron">{{ shortCron(t) }}</span>
            </div>
            <div class="card-row when-row">
              <span class="when-block"><i class="pi pi-arrow-up-right" /> next {{ relativeNext(t) || '—' }}</span>
              <span class="when-block"><i class="pi pi-history" /> last {{ relativeLast(t) }}</span>
            </div>
          </button>
        </div>
      </div>
      <div v-show="mobileNav.isOpen.value && selectedId" class="detail-only">
        <TriggerDetailPanel
          v-if="selectedId"
          :key="selectedId"
          :trigger-id="selectedId"
          pane-key="trigger-master"
          :show-back="true"
          @back="onBack"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.panel {
  height: 100%; min-height: 0;
  display: grid; grid-template-columns: 1fr;
  overflow: hidden;
}
.panel.is-desktop { grid-template-columns: clamp(280px, 32vw, 360px) 1fr; }
.rail-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--p-content-border-color, #2a2e38); background: #16181e; }
.detail-col { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.rail-only, .detail-only { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.rail-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 6px; flex-shrink: 0; }
.rail-head h1 { font-size: 14px; margin: 0; }

.list-rail { height: 100%; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--p-text-color-secondary); padding: 8px; }
.empty code { background: #20232c; padding: 1px 4px; border-radius: 3px; }

.card {
  text-align: left; background: #1c1f27; border: 1px solid transparent;
  border-left: 3px solid transparent; color: var(--p-text-color);
  padding: 10px 12px; border-radius: 6px; cursor: pointer;
  display: flex; flex-direction: column; gap: 4px; font: inherit;
}
.card:hover { background: #20232c; }
.card.active { background: #232733; border-left-color: var(--p-primary-color, #88c0d0); }
.card.disabled { opacity: 0.65; }
.card:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: 1px; }

.card-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.title-row { justify-content: space-between; }
.title-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  font-family: ui-monospace, Consolas, Menlo, monospace; font-weight: 500; font-size: 11.5px; word-break: break-all;
}
.cron { color: var(--p-text-color-secondary); font-size: 11.5px; }
.when-row { color: var(--p-text-color-secondary); font-size: 11px; gap: 10px; }
.when-block { display: inline-flex; align-items: center; gap: 4px; }

.detail-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--p-text-color-secondary); }
.empty-icon { font-size: 32px; opacity: 0.4; }
.empty-text { font-size: 13px; }
</style>
