<script setup lang="ts">
/**
 * SessionSidePanel — collapsible right-side panel for the selected
 * terminal session. Shows two tabs (when applicable):
 *
 *   - "Recipe"     — RecipePanel (step list with status)
 *   - "Artifacts"  — ArtifactsPanel (list → iframe drilldown)
 *
 * Visibility rules:
 *   - Recipe tab shown when the session has a non-empty `recipe_id`
 *     AND it is NOT an internal "__adhoc_*" recipe.
 *   - Artifacts tab shown for any non-Main, non-foreign session
 *     (the list itself may be empty — handled by ArtifactsPanel).
 *   - When NEITHER tab applies, the panel renders nothing (the parent
 *     can detect via the `has-content` event and skip the layout slot).
 *
 * State persisted in localStorage:
 *   clawdevbox.terminals.sidePanelCollapsed
 *   clawdevbox.terminals.sidePanelActiveTab
 *   clawdevbox.terminals.sidePanelWidth          (handled by parent)
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import type { Session } from '../api';
import RecipePanel from './RecipePanel.vue';
import ArtifactsPanel from './ArtifactsPanel.vue';

const props = defineProps<{
  session: Session | null;
}>();

const emit = defineEmits<{
  (e: 'update:collapsed', value: boolean): void;
}>();

type Tab = 'recipe' | 'artifacts';

const LS_COLLAPSED = 'clawdevbox.terminals.sidePanelCollapsed';
const LS_ACTIVE = 'clawdevbox.terminals.sidePanelActiveTab';

const collapsed = ref<boolean>(loadCollapsed());
const activeTab = ref<Tab>(loadActiveTab());
const artifactsNonce = ref(0);
const recipeNonce = ref(0);

/**
 * Default: COLLAPSED. The side panel covers ≈360px of horizontal space and
 * the terminal needs every column it can get for clean rendering of wide
 * TUI output. Once the user explicitly toggles, the choice is persisted to
 * `clawdevbox.terminals.sidePanelCollapsed` (stored as '1' for collapsed,
 * '0' for expanded) and respected on subsequent loads. An absent key
 * (first-time visitor) returns true.
 *
 * NOTE: TerminalsPanel.vue also tracks its own `sideCollapsed` ref (stored
 * under `clawdevbox.terminals.sideCollapsed`) — both must default the same
 * way for the initial render to be consistent (otherwise the parent
 * reserves 28px of flex-basis while this component renders the expanded
 * layout inside it, producing a broken sliver). The two refs stay in sync
 * after first toggle via the @update:collapsed event.
 */
function loadCollapsed(): boolean {
  try {
    const v = localStorage.getItem(LS_COLLAPSED);
    if (v === '0') return false; // user explicitly expanded
    return true; // '1' or null (first visit) → collapsed
  } catch { return true; }
}
function loadActiveTab(): Tab {
  try {
    const v = localStorage.getItem(LS_ACTIVE);
    if (v === 'recipe' || v === 'artifacts') return v;
  } catch { /* ignore */ }
  return 'artifacts';
}

watch(collapsed, (v) => {
  try { localStorage.setItem(LS_COLLAPSED, v ? '1' : '0'); } catch { /* ignore */ }
  emit('update:collapsed', v);
});
watch(activeTab, (v) => {
  try { localStorage.setItem(LS_ACTIVE, v); } catch { /* ignore */ }
});

const hasRecipe = computed<boolean>(() => {
  const s = props.session;
  if (!s) return false;
  if (!s.recipe_id) return false;
  // Historically `__adhoc_*` meant "no recipe at all" (an interactive
  // agent session with no workflow attached). Since the recipe.begin
  // tool lands inline-source recipes under `__adhoc_<instanceId>` —
  // those DO have materialized step rows — we show the Recipe tab for
  // them too. The panel itself shows "no steps" if there's nothing
  // to render; that's preferable to hiding the tab on a recipe that
  // actually has steps. The kind === 'adhoc' check below was a
  // category error: an adhoc-tagged session can legitimately be a
  // recipe execution if the agent called recipe.begin.
  return true;
});
const hasArtifacts = computed<boolean>(() => {
  // We show the artifacts tab for any non-main, non-foreign session.
  // The list itself may be empty — that's fine; the panel renders an
  // "empty" state.
  const s = props.session;
  if (!s) return false;
  if (s.kind === 'main' || s.kind === 'foreign') return false;
  return true;
});
const anyTabAvailable = computed<boolean>(() => hasRecipe.value || hasArtifacts.value);

// If the active tab becomes unavailable (e.g. user switched session),
// pick the first available one.
watch(
  [hasRecipe, hasArtifacts, activeTab],
  ([r, a, t]) => {
    if (t === 'recipe' && !r && a) activeTab.value = 'artifacts';
    if (t === 'artifacts' && !a && r) activeTab.value = 'recipe';
  },
);

// SSE-driven refresh: listen on window for the 'sessions'/'recipes'/'artifacts'
// custom events the parent emits (see realtime.ts).
function onTopicSessions(): void { artifactsNonce.value += 1; recipeNonce.value += 1; }
function onTopicRecipes(): void  { recipeNonce.value += 1; }
function onTopicArtifacts(): void { artifactsNonce.value += 1; }
onMounted(() => {
  window.addEventListener('clawdevbox:sse:sessions', onTopicSessions);
  window.addEventListener('clawdevbox:sse:recipes', onTopicRecipes);
  window.addEventListener('clawdevbox:sse:artifacts', onTopicArtifacts);
});
onBeforeUnmount(() => {
  window.removeEventListener('clawdevbox:sse:sessions', onTopicSessions);
  window.removeEventListener('clawdevbox:sse:recipes', onTopicRecipes);
  window.removeEventListener('clawdevbox:sse:artifacts', onTopicArtifacts);
});

function toggle(): void { collapsed.value = !collapsed.value; }
function selectTab(t: Tab): void { activeTab.value = t; collapsed.value = false; }

defineExpose({ hasAnyTab: anyTabAvailable });
</script>

<template>
  <!-- Render nothing if no tab applies to this session. -->
  <template v-if="anyTabAvailable && session">
    <!-- Collapsed bar: 28px wide vertical strip with expand + tab icons -->
    <div v-if="collapsed" class="side-collapsed">
      <button class="bar-btn" :title="'Expand side panel'" @click="toggle">
        <i class="pi pi-angle-double-left" />
      </button>
      <button
        v-if="hasRecipe"
        class="bar-btn"
        :class="{ active: activeTab === 'recipe' }"
        title="Recipe"
        @click="selectTab('recipe')"
      ><i class="pi pi-book" /></button>
      <button
        v-if="hasArtifacts"
        class="bar-btn"
        :class="{ active: activeTab === 'artifacts' }"
        title="Artifacts"
        @click="selectTab('artifacts')"
      ><i class="pi pi-folder" /></button>
    </div>

    <!-- Open panel -->
    <div v-else class="side-panel">
      <div class="tab-bar">
        <button
          v-if="hasRecipe"
          class="tab-btn"
          :class="{ active: activeTab === 'recipe' }"
          @click="activeTab = 'recipe'"
        ><i class="pi pi-book" /> Recipe</button>
        <button
          v-if="hasArtifacts"
          class="tab-btn"
          :class="{ active: activeTab === 'artifacts' }"
          @click="activeTab = 'artifacts'"
        ><i class="pi pi-folder" /> Artifacts</button>
        <span class="spacer" />
        <button class="bar-btn" :title="'Collapse'" @click="toggle">
          <i class="pi pi-angle-double-right" />
        </button>
      </div>
      <div class="panel-body">
        <RecipePanel
          v-if="activeTab === 'recipe' && hasRecipe && session"
          :instance-id="session.instance_id"
          :refresh-nonce="recipeNonce"
        />
        <ArtifactsPanel
          v-else-if="activeTab === 'artifacts' && hasArtifacts && session"
          :instance-id="session.instance_id"
          :refresh-nonce="artifactsNonce"
        />
      </div>
    </div>
  </template>
</template>

<style scoped>
.side-collapsed {
  width: 28px; min-width: 28px;
  display: flex; flex-direction: column; align-items: center;
  padding: 4px 0; gap: 2px;
  border-left: 1px solid #23262d; background: #15171d;
}
.side-panel {
  display: flex; flex-direction: column;
  height: 100%; min-width: 0; min-height: 0;
  border-left: 1px solid #23262d; background: #15171d;
}
.tab-bar {
  display: flex; align-items: center;
  border-bottom: 1px solid #23262d;
  padding: 2px 4px; gap: 2px;
  flex: 0 0 auto;
}
.tab-bar .spacer { flex: 1 1 auto; }
.tab-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 8px; font-size: 11px; font-weight: 500;
  background: transparent; color: #7c8290;
  border: 1px solid transparent; border-bottom: 2px solid transparent;
  border-radius: 3px 3px 0 0;
  cursor: pointer;
}
.tab-btn:hover { color: #d8dee9; background: #1c2029; }
.tab-btn.active { color: #d8dee9; border-bottom-color: #4a8be8; }
.tab-btn i { font-size: 11px; }
.bar-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  background: transparent; color: #7c8290;
  border: 1px solid transparent; border-radius: 3px;
  cursor: pointer;
}
.bar-btn:hover { color: #d8dee9; background: #1c2029; }
.bar-btn.active { color: #79b8ff; }
.bar-btn i { font-size: 11px; }
.panel-body { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; }
.panel-body > * { flex: 1 1 auto; min-width: 0; }
</style>
