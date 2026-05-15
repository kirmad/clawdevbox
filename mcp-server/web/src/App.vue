<script setup lang="ts">
/**
 * Top-level SPA shell. Owns the three primary tabs (Inbox / Recipes /
 * Main Agent), plus a closable tab per opened artifact.
 *
 * Layout (consistent across viewports):
 *   - Top: slim header with brand, compact tunnel/live status, and an
 *     "ⓘ" button that toggles a Drawer with the full Sidebar contents.
 *   - Below: onboarding banner (when relevant) + tabs filling the rest
 *     of the viewport.
 *
 * The sidebar is intentionally off-canvas everywhere: status is reference
 * info, not something you stare at while working. The compact pills in
 * the header keep the most important state (tunnel up? live? agent?)
 * one glance away.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useUiStore } from './stores/ui';
import { setupRealtime } from './realtime';
import OnboardBanner from './components/OnboardBanner.vue';
import Sidebar from './components/Sidebar.vue';
import InboxPanel from './components/InboxPanel.vue';
import InboxDetailPanel from './components/InboxDetailPanel.vue';
import RecipesPanel from './components/RecipesPanel.vue';
import TriggersPanel from './components/TriggersPanel.vue';
import AgentPanel from './components/AgentPanel.vue';
import ArtifactPanel from './components/ArtifactPanel.vue';

const store = useUiStore();
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
});

const activeTab = computed({
  get: () => store.activeTab,
  set: (v: string) => store.setActiveTab(v),
});

const tunnelPillState = computed(() => {
  const t = store.tunnel;
  if (t.kind === 'none') return 'off';
  if (t.error) return 'error';
  if (t.url) return 'live';
  return 'pending';
});

const agentBadgeSeverity = computed(() =>
  store.agent.running ? 'success' : store.agent.exited ? 'danger' : 'secondary',
);
</script>

<template>
  <div class="app-shell">
    <header class="app-topbar">
      <span class="brand-sm">clawdevbox</span>
      <span class="topbar-status">
        <span class="pill" :data-state="tunnelPillState" :title="`tunnel: ${tunnelPillState}`">
          <i class="pi pi-globe" />
          {{ tunnelPillState === 'pending' ? '…' : tunnelPillState }}
        </span>
        <Badge
          :value="store.agent.running ? 'agent' : (store.agent.exited ? 'agent: exit' : 'agent: ?')"
          :severity="agentBadgeSeverity"
          :title="`main agent: ${store.agent.running ? 'running' : (store.agent.exited ? 'exited' : 'unknown')}`"
        />
        <span class="live-dot" :data-state="store.liveState" :title="`live: ${store.liveState}`" />
      </span>
      <Button icon="pi pi-info-circle" text rounded aria-label="Details" @click="drawerOpen = true" />
    </header>

    <OnboardBanner />

    <main class="app-main">
      <Tabs v-model:value="activeTab" scrollable>
        <TabList>
          <Tab value="inbox">
            <i class="pi pi-inbox" /> Inbox
            <Badge v-if="store.inbox.length > 0" :value="store.inbox.length" severity="secondary" />
          </Tab>
          <Tab value="recipes">
            <i class="pi pi-history" /> Recipes
            <Badge v-if="store.runningRecipes.length > 0" :value="store.runningRecipes.length" severity="info" />
          </Tab>
          <Tab value="triggers">
            <i class="pi pi-bolt" /> Triggers
            <Badge v-if="store.triggers.length > 0" :value="store.triggers.length" severity="secondary" />
          </Tab>
          <Tab value="agent">
            <i class="pi pi-play" /> Main Agent
          </Tab>
          <Tab v-for="tab in store.inboxTabs" :key="tab.id" :value="`inbox-detail:${tab.id}`">
            <i class="pi pi-envelope" /> {{ tab.title || tab.id }}
            <Button
              icon="pi pi-times"
              text
              rounded
              size="small"
              severity="secondary"
              class="close-btn"
              aria-label="Close inbox tab"
              @click.stop="store.closeInboxTab(tab.id)"
            />
          </Tab>
          <Tab v-for="tab in store.artifactTabs" :key="tab.id" :value="`artifact:${tab.id}`">
            <i class="pi pi-file" /> {{ tab.title || tab.id }}
            <Button
              icon="pi pi-times"
              text
              rounded
              size="small"
              severity="secondary"
              class="close-btn"
              aria-label="Close artifact tab"
              @click.stop="store.closeArtifact(tab.id)"
            />
          </Tab>
        </TabList>

        <TabPanels>
          <TabPanel value="inbox"><InboxPanel /></TabPanel>
          <TabPanel value="recipes"><RecipesPanel /></TabPanel>
          <TabPanel value="triggers"><TriggersPanel /></TabPanel>
          <TabPanel value="agent"><AgentPanel /></TabPanel>
          <TabPanel v-for="tab in store.inboxTabs" :key="tab.id" :value="`inbox-detail:${tab.id}`">
            <InboxDetailPanel
              :item-id="tab.id"
              :pane-key="`inbox-detail:${tab.id}`"
              :hide-pop-out="true"
            />
          </TabPanel>
          <TabPanel v-for="tab in store.artifactTabs" :key="tab.id" :value="`artifact:${tab.id}`">
            <ArtifactPanel :id="tab.id" :url="tab.url" :title="tab.title" :return-to="tab.returnTo" />
          </TabPanel>
        </TabPanels>
      </Tabs>
    </main>

    <!-- Off-canvas details drawer (same UI desktop + mobile). -->
    <Drawer v-model:visible="drawerOpen" position="right" header="Details" :style="{ width: 'min(360px, 92vw)' }">
      <Sidebar />
    </Drawer>

    <Toast position="bottom-right" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.close-btn { width: 20px; height: 20px; margin-left: 6px; padding: 0; }

.app-shell {
  grid-template-columns: 1fr;
  grid-template-rows: auto auto 1fr;
  grid-template-areas:
    "topbar"
    "onboard"
    "main";
}
.app-topbar {
  grid-area: topbar;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  padding-top: max(6px, env(safe-area-inset-top));
  background: #14161b;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  min-height: 40px;
}
.brand-sm {
  color: var(--p-primary-color, #88c0d0);
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.04em;
}
.topbar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  margin-right: 4px;
}
.topbar-status .pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.topbar-status .pill i { font-size: 11px; }
</style>


