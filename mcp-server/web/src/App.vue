<script setup lang="ts">
/**
 * Top-level SPA shell. cmux-inspired layout:
 *
 *   ┌──────────────┬──────────────────────────────────────────────┐
 *   │  side-nav    │  panel-host                                  │
 *   │  (vertical)  │  (active TabPanel content fills remainder)   │
 *   │              │                                              │
 *   │  brand       │                                              │
 *   │  ─────────── │                                              │
 *   │  ▾ Main      │                                              │
 *   │  ▸ Inbox  31 │                                              │
 *   │  ▸ Recipes 9 │                                              │
 *   │  ▸ Triggers  │                                              │
 *   │  ▸ Terminals │                                              │
 *   │              │                                              │
 *   │  Pinned ─────│                                              │
 *   │  ✉ thread-12 │                                              │
 *   │              │                                              │
 *   │  ─ footer ─  │                                              │
 *   │  🌐 ● ⓘ      │                                              │
 *   └──────────────┴──────────────────────────────────────────────┘
 *
 * Why vertical (not the previous horizontal tab bar)?
 *   - Most users have wide monitors but limited vertical real estate;
 *     a 220-px side rail "trades" horizontal space for full-height
 *     content (xterm benefits more from rows than columns).
 *   - Stacked items leave room for richer per-row metadata (count
 *     badges, status dots, status text) without horizontal crowding.
 *   - Pinned inbox / artifact tabs sit in a dedicated "Pinned" group
 *     so they're discoverable but don't shove the primary tabs off
 *     the right edge once a few items are open.
 *
 * Eager-mount pattern PRESERVED via `v-show`: hidden panels stay in
 * the DOM so MainAgentPanel / TerminalsPanel keep their xterm
 * websocket connections alive when the user switches away.
 *
 * The off-canvas Drawer (triggered by the ⓘ button) still hosts the
 * full Sidebar component (project info, MCP URL, push settings) — it's
 * reference data, not something to occupy main UI space.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useUiStore } from './stores/ui';
import { setupRealtime } from './realtime';
import OnboardBanner from './components/OnboardBanner.vue';
import Sidebar from './components/Sidebar.vue';
import InboxPanel from './components/InboxPanel.vue';
import InboxDetailPanel from './components/InboxDetailPanel.vue';
import InboxComposePanel from './components/InboxComposePanel.vue';
import RecipesPanel from './components/RecipesPanel.vue';
import TriggersPanel from './components/TriggersPanel.vue';
import DaemonsPanel from './components/DaemonsPanel.vue';
import TerminalsPanel from './components/TerminalsPanel.vue';
import MainAgentPanel from './components/MainAgentPanel.vue';
import ArtifactsTabPanel from './components/ArtifactsTabPanel.vue';
import LibraryPanel from './components/LibraryPanel.vue';

const store = useUiStore();
const route = useRoute();
const drawerOpen = ref(false);

let stopRealtime: (() => void) | null = null;
let agentTimer: number | null = null;
let tunnelTimer: number | null = null;

onMounted(async () => {
  await Promise.all([
    store.refreshInbox(),
    store.refreshRecipes(),
    store.refreshTriggers(),
    store.refreshApprovals(),
    store.refreshAgent(),
    store.refreshTunnel(),
    store.refreshPush(),
  ]);
  stopRealtime = setupRealtime();
  agentTimer = window.setInterval(() => store.refreshAgent(), 30_000);
  tunnelTimer = window.setInterval(() => store.refreshTunnel(), 30_000);
});

onBeforeUnmount(() => {
  stopRealtime?.();
  if (agentTimer) clearInterval(agentTimer);
  if (tunnelTimer) clearInterval(tunnelTimer);
  window.removeEventListener('keydown', onGlobalKeydown);
});

// Global keyboard shortcut: Ctrl+Shift+Q → compose-to-agent dialog
function onGlobalKeydown(ev: KeyboardEvent): void {
  if (ev.ctrlKey && ev.shiftKey && ev.key === 'Q') {
    ev.preventDefault();
    store.toggleComposeDialog();
  }
}
window.addEventListener('keydown', onGlobalKeydown);

function onComposeDialogSent(itemId: string): void {
  store.toggleComposeDialog(false);
  if (itemId) {
    store.selectInboxItem(itemId);
    store.setActiveTab('inbox');
  }
}
function onComposeDialogCancel(): void {
  store.toggleComposeDialog(false);
}

watch(
  () => ({ name: route.name as string | null | undefined, params: route.params }),
  (val) => {
    store.syncFromRoute({ name: val.name, params: val.params });
  },
  { immediate: true, deep: true },
);

const activeTab = computed(() => store.activeTab);
function select(tab: string): void { store.setActiveTab(tab); }

const tunnelPillState = computed(() => {
  const t = store.tunnel;
  if (t.kind === 'none') return 'off';
  if (t.error) return 'error';
  if (t.url) return 'live';
  return 'pending';
});

const mainAgentDotState = computed<'ok' | 'warn' | 'danger'>(() => {
  if (store.agent.running) return 'ok';
  if (store.agent.exited && (store.agent.exitCode ?? 0) !== 0) return 'danger';
  return 'warn';
});
const mainAgentDotTitle = computed(() =>
  store.agent.running
    ? 'Main agent: running'
    : store.agent.exited
      ? `Main agent: exited${typeof store.agent.exitCode === 'number' ? ` (code ${store.agent.exitCode})` : ''}`
      : 'Main agent: not running',
);

// Collapse sidebar on narrow viewports. Persisted to localStorage so
// power users keep their preference; CSS handles the visual collapse
// while clicks still navigate.
const SIDEBAR_COLLAPSED_KEY = 'clawdevbox.sidebar.collapsed';
const sidebarCollapsed = ref(((): boolean => {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
})());
function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed.value ? '1' : '0'); } catch { /* */ }
  // xterm panels listen for window 'resize' — refit to the new width.
  window.dispatchEvent(new Event('resize'));
}
</script>

<template>
  <div class="app-shell">
    <OnboardBanner />

    <main class="app-main" :class="{ 'is-sidebar-collapsed': sidebarCollapsed }">
      <!-- Vertical navigation rail -->
      <aside class="side-nav">
        <header class="side-nav__head">
          <button
            type="button"
            class="side-nav__toggle"
            :title="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
            @click="toggleSidebar"
          >
            <i :class="sidebarCollapsed ? 'pi pi-bars' : 'pi pi-arrow-left'" />
          </button>
          <span v-if="!sidebarCollapsed" class="side-nav__brand">clawdevbox</span>
        </header>

        <nav class="side-nav__items">
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'main-agent' }"
            :title="mainAgentDotTitle"
            @click="select('main-agent')"
          >
            <i class="pi pi-comments nav-item__icon" />
            <span v-if="!sidebarCollapsed" class="nav-item__label">Main Agent</span>
            <span v-if="!sidebarCollapsed" class="ma-tab-dot" :data-state="mainAgentDotState" />
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'inbox' }"
            title="Inbox"
            @click="select('inbox')"
          >
            <span class="nav-item__icon-wrap">
              <i class="pi pi-inbox nav-item__icon" />
              <span v-if="store.unreadInboxCount > 0" class="nav-item__badge" />
            </span>
            <span v-if="!sidebarCollapsed" class="nav-item__label">Inbox</span>
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'recipes' }"
            title="Recipes"
            @click="select('recipes')"
          >
            <span class="nav-item__icon-wrap">
              <i class="pi pi-list-check nav-item__icon" />
              <span v-if="store.waitingRecipesCount > 0" class="nav-item__badge is-warn" />
            </span>
            <span v-if="!sidebarCollapsed" class="nav-item__label">Recipes</span>
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'artifacts' }"
            title="Artifacts"
            @click="select('artifacts')"
          >
            <i class="pi pi-folder-open nav-item__icon" />
            <span v-if="!sidebarCollapsed" class="nav-item__label">Artifacts</span>
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'triggers' }"
            title="Triggers"
            @click="select('triggers')"
          >
            <i class="pi pi-clock nav-item__icon" />
            <span v-if="!sidebarCollapsed" class="nav-item__label">Triggers</span>
            <span v-if="store.triggers.length > 0 && !sidebarCollapsed" class="nav-item__count">{{ store.triggers.length }}</span>
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'daemons' }"
            title="Daemons"
            @click="select('daemons')"
          >
            <i class="pi pi-spin pi-spinner nav-item__icon" />
            <span v-if="!sidebarCollapsed" class="nav-item__label">Daemons</span>
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'library' }"
            title="Library — recipes, skills, triggers &amp; memory"
            @click="select('library')"
          >
            <i class="pi pi-compass nav-item__icon" />
            <span v-if="!sidebarCollapsed" class="nav-item__label">Library</span>
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeTab === 'agent' }"
            title="Terminals"
            @click="select('agent')"
          >
            <i class="pi pi-microchip-ai nav-item__icon" />
            <span v-if="!sidebarCollapsed" class="nav-item__label">Terminals</span>
          </button>

          <!-- Pinned: popped-out inbox + artifact tabs -->
          <div
            v-if="store.inboxTabs.length > 0"
            class="nav-group"
          >
            <header v-if="!sidebarCollapsed" class="nav-group__head">Pinned</header>
            <div
              v-for="tab in store.inboxTabs"
              :key="`inbox-detail:${tab.id}`"
              class="nav-item nav-item--pinned"
              :class="{ 'is-active': activeTab === `inbox-detail:${tab.id}` }"
              role="button"
              tabindex="0"
              :title="tab.title || tab.id"
              @click="select(`inbox-detail:${tab.id}`)"
              @keydown.enter="select(`inbox-detail:${tab.id}`)"
            >
              <i class="pi pi-envelope nav-item__icon" />
              <span v-if="!sidebarCollapsed" class="nav-item__label">{{ tab.title || tab.id }}</span>
              <button
                v-if="!sidebarCollapsed"
                type="button"
                class="nav-item__close"
                aria-label="Close inbox tab"
                @click.stop="store.closeInboxTab(tab.id)"
              >
                <i class="pi pi-times" />
              </button>
            </div>
          </div>
        </nav>

        <footer class="side-nav__foot">
          <span
            class="status-pill"
            :data-state="tunnelPillState"
            :title="`tunnel: ${tunnelPillState}`"
          >
            <i class="pi pi-globe" />
            <span v-if="!sidebarCollapsed">{{ tunnelPillState }}</span>
          </span>
          <span
            class="live-dot"
            :data-state="store.liveState"
            :title="`live: ${store.liveState}`"
          />
          <button
            type="button"
            class="side-nav__info"
            aria-label="Details"
            title="Project / MCP / push details"
            @click="drawerOpen = true"
          >
            <i class="pi pi-info-circle" />
          </button>
        </footer>
      </aside>

      <!-- Active panel content. v-show keeps every panel mounted so
           xterm WS connections etc. don't tear down on tab switch. -->
      <section class="panel-host">
        <MainAgentPanel v-show="activeTab === 'main-agent'" />
        <InboxPanel v-show="activeTab === 'inbox'" />
        <RecipesPanel v-show="activeTab === 'recipes'" />
        <TriggersPanel v-show="activeTab === 'triggers'" />
        <DaemonsPanel v-show="activeTab === 'daemons'" />
        <LibraryPanel v-show="activeTab === 'library'" />
        <TerminalsPanel v-show="activeTab === 'agent'" />
        <ArtifactsTabPanel v-show="activeTab === 'artifacts'" />
        <div
          v-for="tab in store.inboxTabs"
          :key="`inbox-detail-pane:${tab.id}`"
          class="pinned-pane"
          v-show="activeTab === `inbox-detail:${tab.id}`"
        >
          <InboxDetailPanel
            :item-id="tab.id"
            :pane-key="`inbox-detail:${tab.id}`"
            :hide-pop-out="true"
          />
        </div>
      </section>
    </main>

    <Drawer v-model:visible="drawerOpen" position="right" header="Details" :style="{ width: 'min(360px, 92vw)' }">
      <Sidebar />
    </Drawer>

    <!-- Global compose-to-agent dialog (Ctrl+Shift+Q) -->
    <Dialog
      v-model:visible="store.composeDialogOpen"
      modal
      header="New message to agent"
      :style="{ width: 'min(680px, 92vw)', height: 'min(520px, 80vh)' }"
      :content-style="{ padding: 0, display: 'flex', flexDirection: 'column', flex: '1', minHeight: 0 }"
      :closable="true"
      :draggable="false"
      class="compose-dialog"
    >
      <InboxComposePanel
        @sent="onComposeDialogSent"
        @cancel="onComposeDialogCancel"
      />
    </Dialog>

    <Toast position="bottom-right" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "onboard"
    "main";
  height: 100%;
}

.app-main {
  grid-area: main;
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 0;
  overflow: hidden;
}
.app-main.is-sidebar-collapsed {
  grid-template-columns: 44px 1fr;
}

/* ──── Side navigation rail ──────────────────────────────────────── */
.side-nav {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #15171d;
  border-right: 1px solid var(--p-content-border-color, #2a2e38);
  overflow: hidden;
}

.side-nav__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  padding-top: max(8px, env(safe-area-inset-top));
  border-bottom: 1px solid #1f222a;
  flex-shrink: 0;
}
.side-nav__brand {
  font-size: 12px;
  font-weight: 600;
  color: var(--p-primary-color, #88c0d0);
  letter-spacing: 0.06em;
  text-transform: lowercase;
}
.side-nav__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--p-text-color-secondary, #99a3b3);
  cursor: pointer;
  padding: 0;
}
.side-nav__toggle:hover { background: #20232c; color: var(--p-text-color); }
.side-nav__toggle i { font-size: 11px; }

.side-nav__items {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--p-text-color-secondary, #c0c5ce);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  cursor: pointer;
  text-align: left;
  width: 100%;
  position: relative;
  white-space: nowrap;
  overflow: hidden;
}
.nav-item:hover { background: #1c1f27; color: var(--p-text-color); }
.nav-item:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: -1px; }
.nav-item.is-active {
  background: #232733;
  color: var(--p-text-color);
}
.nav-item.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 2px;
  background: var(--p-primary-color, #88c0d0);
}
.nav-item__icon {
  font-size: 13px;
  width: 16px;
  flex-shrink: 0;
  text-align: center;
}
.nav-item__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nav-item__icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: visible;
}
.nav-item__badge {
  position: absolute;
  top: -3px;
  right: -4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #e44;
  border: 1.5px solid #15171d;
  pointer-events: none;
}
.nav-item__badge.is-warn {
  background: #d97706;
}
.nav-item__count {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  background: #2a2e38;
  color: #c0c5ce;
  flex-shrink: 0;
}
.nav-item__count.is-info {
  background: #1d4f7c;
  color: #cce0ff;
}
.nav-item__count.is-warn {
  background: #7c4f1d;
  color: #ffe0cc;
}
.nav-item__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--p-primary-color, #88c0d0);
  flex-shrink: 0;
  margin-left: auto;
}
.nav-item__close {
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--p-text-color-secondary, #99a3b3);
  border-radius: 3px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  flex-shrink: 0;
}
.nav-item__close i { font-size: 10px; }
.nav-item:hover .nav-item__close,
.nav-item.is-active .nav-item__close { opacity: 1; }
.nav-item__close:hover { background: #2a2e38; color: var(--p-text-color); }

.nav-group {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.nav-group__head {
  font-size: 10px;
  font-weight: 600;
  color: var(--p-text-color-secondary, #99a3b3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 6px 10px 4px;
}
.nav-item--pinned {
  font-size: 12px;
  color: var(--p-text-color-secondary, #99a3b3);
}

/* Tiny indicator dot mirroring MainAgentPanel's header dot. */
.ma-tab-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-left: auto;
}
.ma-tab-dot[data-state="ok"]     { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.6); }
.ma-tab-dot[data-state="warn"]   { background: #fbbf24; }
.ma-tab-dot[data-state="danger"] { background: #f87171; box-shadow: 0 0 4px rgba(248, 113, 113, 0.6); }

/* ──── Side-nav footer (tunnel / live / info) ──────────────────── */
.side-nav__foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid #1f222a;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--p-text-color-secondary, #99a3b3);
}
.status-pill i { font-size: 11px; }
.status-pill[data-state="live"]    { color: #4ade80; }
.status-pill[data-state="error"]   { color: #f87171; }
.status-pill[data-state="pending"] { color: #fbbf24; }
.status-pill[data-state="off"]     { color: #6b7280; }
.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6b7280;
}
.live-dot[data-state="live"]    { background: #4ade80; box-shadow: 0 0 4px rgba(74, 222, 128, 0.6); }
.live-dot[data-state="offline"] { background: #6b7280; }
.side-nav__info {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--p-text-color-secondary, #99a3b3);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}
.side-nav__info:hover { background: #20232c; color: var(--p-text-color); }
.side-nav__info i { font-size: 13px; }

/* ──── Panel host (content area) ─────────────────────────────────── */
.panel-host {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.panel-host > * {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
.pinned-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ──── Mobile: collapse sidebar to icon-only, halve nav padding ── */
@media (max-width: 720px) {
  .app-main { grid-template-columns: 44px 1fr; }
  .side-nav__brand { display: none; }
  .nav-item__label,
  .nav-item__count,
  .nav-item__close,
  .nav-group__head,
  .status-pill span { display: none; }
}

/* ──── Compose dialog overrides ──────────────────────────────────── */
.compose-dialog :deep(.p-dialog-content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
