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
import InboxComposePanel from './InboxComposePanel.vue';
import InboxDetailPanel from './InboxDetailPanel.vue';
import InboxListRail from './InboxListRail.vue';
import { useMobileHistory } from '../composables/useMobileHistory';
import { useUiStore } from '../stores/ui';

const DESKTOP_MIN_PX = 1024;
const LS_RAIL_COLLAPSED = 'clawdevbox.inbox.railCollapsed';

const store = useUiStore();
const isDesktop = ref(false);
const railCollapsed = ref<boolean>(((): boolean => {
  try { return localStorage.getItem(LS_RAIL_COLLAPSED) === '1'; } catch { return false; }
})());

function recompute(): void {
  isDesktop.value = window.matchMedia(`(min-width: ${DESKTOP_MIN_PX}px)`).matches;
}

function toggleRail(): void {
  railCollapsed.value = !railCollapsed.value;
  try { localStorage.setItem(LS_RAIL_COLLAPSED, railCollapsed.value ? '1' : '0'); } catch { /* */ }
}

const mobileNav = useMobileHistory({
  key: 'inbox-detail',
  onClose: () => { store.selectInboxItem(null); },
});

function onSelect(id: string): void {
  composing.value = false;
  store.selectInboxItem(id);
  if (!isDesktop.value) mobileNav.open();
}

function onBack(): void {
  mobileNav.close();
}

const composing = ref(false);

function onCompose(): void {
  composing.value = true;
  store.selectInboxItem(null);
}

function onComposeSent(itemId: string): void {
  composing.value = false;
  if (itemId) store.selectInboxItem(itemId);
}

function onComposeCancel(): void {
  composing.value = false;
}

const selectedId = computed(() => store.selectedInboxId);

/**
 * The list as the user sees it in the rail — respects the "unread only"
 * filter from the store. Used both for auto-select (pick the first
 * VISIBLE item) and for auto-deselect (drop the selection if the
 * currently-selected item is hidden by the filter, e.g. because the
 * user just marked it read while "unread only" is active — without
 * this, the detail pane would keep showing the now-read item even
 * though the rail correctly hides it).
 */
const filteredInbox = computed(() => {
  if (!store.inboxShowUnreadOnly) return store.inbox;
  // Keep the currently-selected item visible while being viewed (auto-mark-read
  // shouldn't yank it away). Toggling the filter ON deselects read items below.
  const sel = store.selectedInboxId;
  return store.inbox.filter((it) => it.unread === true || it.id === sel);
});

onMounted(() => {
  recompute();
  window.addEventListener('resize', recompute);
  // Keep the master-detail selection in sync with the FILTERED list.
  // Three cases:
  //   1. Selected item no longer visible (filtered out / archived /
  //      removed) → drop selection so the detail pane shows the
  //      "Select an item to view its details." empty state.
  //   2. No selection AND there's a visible item → auto-select the
  //      first one on desktop.
  //   3. Nothing visible → leave selection cleared.
  watch(
    [() => filteredInbox.value, () => isDesktop.value],
    () => {
      const list = filteredInbox.value;
      if (store.selectedInboxId) {
        const stillVisible = list.some((it) => it.id === store.selectedInboxId);
        if (!stillVisible) {
          store.selectInboxItem(null);
          return;
        }
      }
      if (
        isDesktop.value &&
        !store.selectedInboxId &&
        list.length > 0
      ) {
        store.selectInboxItem(list[0].id);
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
  <section class="panel" :class="{ 'is-desktop': isDesktop, 'rail-collapsed': railCollapsed, 'mobile-detail-open': !isDesktop && mobileNav.isOpen.value && selectedId }">
    <!-- Desktop: list + detail side by side -->
    <template v-if="isDesktop">
      <aside v-show="!railCollapsed" class="rail-col">
        <header class="rail-head">
          <h1>Inbox</h1>
          <Badge v-if="store.inbox.length > 0" :value="store.inbox.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
          <button class="rail-toggle" title="Collapse list" @click="toggleRail">
            <i class="pi pi-angle-left" />
          </button>
        </header>
        <InboxListRail :selected-id="selectedId" @select="onSelect" @compose="onCompose" />
      </aside>
      <div class="detail-col">
        <div v-if="railCollapsed" class="rail-expand-strip">
          <button class="rail-expand-btn" title="Show inbox list" @click="toggleRail">
            <i class="pi pi-angle-right" />
            <span class="rail-expand-label">Inbox</span>
            <Badge v-if="store.inbox.length > 0" :value="store.inbox.length" severity="secondary" class="rail-expand-badge" />
          </button>
        </div>
        <InboxComposePanel
          v-if="composing"
          @sent="onComposeSent"
          @cancel="onComposeCancel"
        />
        <InboxDetailPanel
          v-else-if="selectedId"
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
        <InboxListRail :selected-id="selectedId" @select="onSelect" @compose="onCompose" />
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
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
}
.panel.is-desktop {
  grid-template-columns: clamp(260px, 30vw, 340px) minmax(0, 1fr);
}
.panel.is-desktop.rail-collapsed {
  grid-template-columns: minmax(0, 1fr);
}

.rail-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  border-right: 1px solid var(--p-content-border-color, #2a2e38);
  background: #16181e;
}
.detail-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.rail-only, .detail-only {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
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

.rail-toggle {
  margin-left: auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  background: transparent; border: none; border-radius: 4px;
  color: var(--p-text-color-secondary); cursor: pointer;
}
.rail-toggle:hover { background: rgba(255,255,255,0.06); color: var(--p-text-color); }
.rail-toggle i { font-size: 12px; }

.rail-expand-strip {
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
}
.rail-expand-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px;
  background: transparent; border: none;
  color: var(--p-text-color-secondary); cursor: pointer;
  font: inherit; font-size: 12px;
}
.rail-expand-btn:hover { background: rgba(255,255,255,0.04); color: var(--p-text-color); }
.rail-expand-btn i { font-size: 12px; }
.rail-expand-label { font-weight: 600; }
.rail-expand-badge { font-size: 10px; }
</style>
