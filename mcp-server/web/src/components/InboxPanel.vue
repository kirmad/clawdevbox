<script setup lang="ts">
/**
 * InboxPanel — responsive master-detail shell.
 *
 * Desktop (≥1024px): list rail on the left + detail pane on the right.
 *   List selection updates the detail pane. Auto-selects first item on
 *   load.
 *
 * Tablet (<1024px) / Mobile: single-pane navigation. List view by
 *   default; tapping a card pushes the detail view (with a back arrow).
 *   The OS / browser Back button also closes the detail view via the
 *   `useMobileHistory` composable.
 *
 * Popped-out inbox tabs (rendered by App.vue) reuse `InboxDetailPanel`
 * directly — same component, same store, same body cache.
 */
import { computed, onMounted, ref, watch } from 'vue';
import InboxDetailPanel from './InboxDetailPanel.vue';
import InboxListRail from './InboxListRail.vue';
import { useMobileHistory } from '../composables/useMobileHistory';
import { useUiStore } from '../stores/ui';

const DESKTOP_MIN_PX = 1024;

const store = useUiStore();
const isDesktop = ref(false);

function recompute(): void {
  isDesktop.value = window.matchMedia(`(min-width: ${DESKTOP_MIN_PX}px)`).matches;
}

const mobileNav = useMobileHistory({
  key: 'inbox-detail',
  onClose: () => { store.selectInboxItem(null); },
});

function onSelect(id: string): void {
  store.selectInboxItem(id);
  if (!isDesktop.value) mobileNav.open();
}

function onBack(): void {
  mobileNav.close();
}

const selectedId = computed(() => store.selectedInboxId);

onMounted(() => {
  recompute();
  window.addEventListener('resize', recompute);
  // On desktop, auto-select the first item once the list arrives.
  watch(
    [() => store.inbox.length, () => isDesktop.value],
    () => {
      if (
        isDesktop.value &&
        !store.selectedInboxId &&
        store.inbox.length > 0
      ) {
        store.selectInboxItem(store.inbox[0].id);
      }
    },
    { immediate: true },
  );
  // Consume "return from artifact tab" signal: re-open the mobile
  // detail view for the requested item, then clear the flag. Desktop
  // doesn't need this — the master-detail right pane is always visible.
  watch(
    () => store.pendingMobileDetailRestore,
    (id) => {
      if (!id) return;
      if (!isDesktop.value) mobileNav.open();
      store.pendingMobileDetailRestore = null;
    },
    { immediate: true },
  );
});
</script>

<template>
  <section class="panel" :class="{ 'is-desktop': isDesktop, 'mobile-detail-open': !isDesktop && mobileNav.isOpen.value && selectedId }">
    <!-- Desktop: list + detail side by side -->
    <template v-if="isDesktop">
      <aside class="rail-col">
        <header class="rail-head">
          <h1>Inbox</h1>
          <Badge v-if="store.inbox.length > 0" :value="store.inbox.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
        </header>
        <InboxListRail :selected-id="selectedId" @select="onSelect" />
      </aside>
      <div class="detail-col">
        <InboxDetailPanel
          v-if="selectedId"
          :key="selectedId"
          :item-id="selectedId"
          pane-key="inbox-master"
        />
        <div v-else class="detail-empty">
          <i class="pi pi-inbox empty-icon" />
          <div class="empty-text">Select an item to view its details.</div>
        </div>
      </div>
    </template>

    <!-- Mobile/tablet: list OR detail -->
    <template v-else>
      <div v-show="!mobileNav.isOpen.value || !selectedId" class="rail-only">
        <header class="rail-head">
          <h1>Inbox</h1>
          <Badge v-if="store.inbox.length > 0" :value="store.inbox.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
        </header>
        <InboxListRail :selected-id="selectedId" @select="onSelect" />
      </div>
      <div v-show="mobileNav.isOpen.value && selectedId" class="detail-only">
        <InboxDetailPanel
          v-if="selectedId"
          :key="selectedId"
          :item-id="selectedId"
          pane-key="inbox-master"
          :show-back="true"
          @back="onBack"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  overflow: hidden;
}
.panel.is-desktop {
  grid-template-columns: clamp(260px, 30vw, 340px) 1fr;
}

.rail-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--p-content-border-color, #2a2e38);
  background: #16181e;
}
.detail-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.rail-only, .detail-only {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.rail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 6px;
  flex-shrink: 0;
}
.rail-head h1 { font-size: 14px; margin: 0; color: var(--p-text-color); }

.detail-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--p-text-color-secondary);
  gap: 8px;
}
.empty-icon { font-size: 32px; opacity: 0.4; }
.empty-text { font-size: 13px; }
</style>
