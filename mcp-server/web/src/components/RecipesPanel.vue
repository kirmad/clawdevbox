<script setup lang="ts">
/**
 * RecipesPanel — responsive master-detail shell for recipe runs.
 *
 * Desktop ≥1024px: list rail + detail right pane (auto-select first
 * running, else first overall).
 * Mobile <1024px: list view; tap a card to push detail (with OS Back).
 *
 * The list rail is intentionally compact — recipe_id (mono), status
 * pill, progress fraction, optional "awaiting" badge, relative time.
 */
import { computed, onMounted, ref, watch } from 'vue';
import RecipeDetailPanel from './RecipeDetailPanel.vue';
import { useMobileHistory } from '../composables/useMobileHistory';
import { useUiStore } from '../stores/ui';
import type { RecipeInstance } from '../api';

const DESKTOP_MIN_PX = 1024;
const LS_RAIL_COLLAPSED = 'clawdevbox.recipes.railCollapsed';
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
  key: 'recipe-detail',
  onClose: () => { store.selectRecipe(null); },
});

const items = computed(() => store.recipes);
const selectedId = computed(() => store.selectedRecipeId);

// Filter state
type RecipeFilter = 'all' | 'running' | 'waiting' | 'completed';
const LS_RECIPE_FILTER = 'clawdevbox.recipes.filter';
const activeFilter = ref<RecipeFilter>(((): RecipeFilter => {
  try {
    const v = localStorage.getItem(LS_RECIPE_FILTER);
    if (v === 'running' || v === 'waiting' || v === 'completed') return v;
  } catch { /* */ }
  return 'all';
})());

function setFilter(f: RecipeFilter): void {
  activeFilter.value = f;
  try { localStorage.setItem(LS_RECIPE_FILTER, f); } catch { /* */ }
}

const filteredItems = computed(() => {
  const all = items.value;
  switch (activeFilter.value) {
    case 'running':
      return all.filter((r) => r.status === 'running' && !(r.progress && r.progress.awaiting_user_count > 0));
    case 'waiting':
      return all.filter((r) => r.progress && r.progress.awaiting_user_count > 0);
    case 'completed':
      return all.filter((r) => r.status === 'success' || r.status === 'failure' || r.status === 'cancelled');
    default:
      return all;
  }
});

function onSelect(id: string): void {
  store.selectRecipe(id);
  if (!isDesktop.value) mobileNav.open();
}
function onBack(): void { mobileNav.close(); }

function statusSeverity(status: string): 'success' | 'info' | 'warn' | 'danger' | 'secondary' {
  switch (status) {
    case 'success': return 'success';
    case 'failure': return 'danger';
    case 'cancelled': return 'secondary';
    case 'running':
    default: return 'info';
  }
}

function relativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff < 0 ? `in ${Math.round(abs / 1000)}s` : `${Math.round(abs / 1000)}s ago`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function shortPrompt(p?: string): string {
  if (!p) return '';
  return p.length > 90 ? p.slice(0, 87) + '…' : p;
}

function recipeLabel(r: RecipeInstance): string {
  // The name field is mandatory on new runs — always specific to what
  // the run does (e.g. "Add OAuth2 to user-service"). For legacy runs
  // without a name, show recipe_id as last resort.
  const name = (r.recipe_name ?? '').trim();
  if (name.length > 0) return name;
  // Legacy fallback: template id
  const id = (r.recipe_id ?? '').replace(/^__adhoc_/, '');
  return id || r.id;
}

function showSecondaryId(r: RecipeInstance): boolean {
  // Show template id as subtitle when we have a specific name
  const name = (r.recipe_name ?? '').trim();
  if (!name) return false;
  // Don't show if the template id is just the adhoc prefix
  const id = r.recipe_id ?? '';
  return !id.startsWith('__adhoc_');
}

function pickInitial(list: RecipeInstance[]): string | null {
  if (list.length === 0) return null;
  const running = list.find((r) => r.status === 'running');
  return (running ?? list[0]).id;
}

onMounted(() => {
  recompute();
  window.addEventListener('resize', recompute);
  watch(
    [() => items.value.length, () => isDesktop.value],
    () => {
      if (isDesktop.value && !store.selectedRecipeId && items.value.length > 0) {
        store.selectRecipe(pickInitial(items.value));
      }
    },
    { immediate: true },
  );
});
</script>

<template>
  <section class="panel" :class="{ 'is-desktop': isDesktop, 'rail-collapsed': railCollapsed }">
    <!-- Desktop: list + detail -->
    <template v-if="isDesktop">
      <aside v-show="!railCollapsed" class="rail-col">
        <header class="rail-head">
          <h1>Recipes</h1>
          <Badge v-if="items.length > 0" :value="items.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
          <button class="rail-toggle" title="Collapse list" @click="toggleRail">
            <i class="pi pi-angle-left" />
          </button>
        </header>
        <div class="filter-bar">
          <button class="filter-btn" :class="{ active: activeFilter === 'all' }" @click="setFilter('all')">All</button>
          <button class="filter-btn" :class="{ active: activeFilter === 'running' }" @click="setFilter('running')">In Progress</button>
          <button class="filter-btn" :class="{ active: activeFilter === 'waiting' }" @click="setFilter('waiting')">Waiting</button>
          <button class="filter-btn" :class="{ active: activeFilter === 'completed' }" @click="setFilter('completed')">Completed</button>
        </div>
        <div class="list-rail">
          <Message v-if="store.recipesError" severity="error" :closable="false">
            Failed to load: {{ store.recipesError }}
          </Message>
          <div v-if="filteredItems.length === 0 && !store.recipesLoading" class="empty">
            {{ activeFilter === 'all' ? 'No recipe runs yet.' : 'No recipes match this filter.' }}
          </div>
          <button
            v-for="r in filteredItems"
            :key="r.id"
            type="button"
            class="card"
            :class="{ active: selectedId === r.id }"
            @click="onSelect(r.id)"
          >
            <div class="card-row title-row">
              <span class="title-text">{{ recipeLabel(r) }}</span>
              <span class="time">{{ relativeTime(r.started_at) }}</span>
            </div>
            <div v-if="showSecondaryId(r)" class="card-sub-id">{{ r.recipe_id }}</div>
            <div v-if="shortPrompt(r.prompt)" class="card-preview">{{ shortPrompt(r.prompt) }}</div>
            <div class="card-row chips-row">
              <Tag :severity="statusSeverity(r.status)" :value="r.status" />
              <span v-if="r.progress" class="progress-tag">
                {{ r.progress.completed_steps }}/{{ r.progress.total_steps }}
              </span>
              <span
                v-if="r.progress && r.progress.awaiting_user_count > 0"
                class="awaiting-tag"
              >
                <i class="pi pi-user" /> needs input
              </span>
              <span v-if="r.children && r.children.length > 0" class="child-tag">
                <i class="pi pi-sitemap" /> {{ r.children.length }}
              </span>
            </div>
          </button>
        </div>
      </aside>
      <div class="detail-col">
        <div v-if="railCollapsed" class="rail-expand-strip">
          <button class="rail-expand-btn" title="Show recipes list" @click="toggleRail">
            <i class="pi pi-angle-right" />
            <span class="rail-expand-label">Recipes</span>
            <Badge v-if="items.length > 0" :value="items.length" severity="secondary" class="rail-expand-badge" />
          </button>
        </div>
        <RecipeDetailPanel
          v-if="selectedId"
          :key="selectedId"
          :recipe-id="selectedId"
          pane-key="recipe-master"
        />
        <div v-else class="detail-empty">
          <i class="pi pi-list-check empty-icon" />
          <div class="empty-text">Select a recipe to view its steps.</div>
        </div>
      </div>
    </template>

    <!-- Mobile: list OR detail -->
    <template v-else>
      <div v-show="!mobileNav.isOpen.value || !selectedId" class="rail-only">
        <header class="rail-head">
          <h1>Recipes</h1>
          <Badge v-if="items.length > 0" :value="items.length" severity="secondary" />
          <span class="live-dot" :data-state="store.liveState" />
        </header>
        <div class="list-rail">
          <Message v-if="store.recipesError" severity="error" :closable="false">
            Failed to load: {{ store.recipesError }}
          </Message>
          <div v-if="items.length === 0 && !store.recipesLoading" class="empty">
            No recipe runs yet.
          </div>
          <button
            v-for="r in items"
            :key="r.id"
            type="button"
            class="card"
            :class="{ active: selectedId === r.id }"
            @click="onSelect(r.id)"
          >
            <div class="card-row title-row">
              <span class="title-text">{{ recipeLabel(r) }}</span>
              <span class="time">{{ relativeTime(r.started_at) }}</span>
            </div>
            <div v-if="showSecondaryId(r)" class="card-sub-id">{{ r.recipe_id }}</div>
            <div v-if="shortPrompt(r.prompt)" class="card-preview">{{ shortPrompt(r.prompt) }}</div>
            <div class="card-row chips-row">
              <Tag :severity="statusSeverity(r.status)" :value="r.status" />
              <span v-if="r.progress" class="progress-tag">
                {{ r.progress.completed_steps }}/{{ r.progress.total_steps }}
              </span>
              <span
                v-if="r.progress && r.progress.awaiting_user_count > 0"
                class="awaiting-tag"
              >
                <i class="pi pi-user" /> needs input
              </span>
              <span v-if="r.children && r.children.length > 0" class="child-tag">
                <i class="pi pi-sitemap" /> {{ r.children.length }}
              </span>
            </div>
          </button>
        </div>
      </div>
      <div v-show="mobileNav.isOpen.value && selectedId" class="detail-only">
        <RecipeDetailPanel
          v-if="selectedId"
          :key="selectedId"
          :recipe-id="selectedId"
          pane-key="recipe-master"
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
.panel.is-desktop.rail-collapsed { grid-template-columns: minmax(0, 1fr); }
.rail-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--p-content-border-color, #2a2e38); background: #16181e; }
.detail-col { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.rail-only, .detail-only { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.rail-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 6px; flex-shrink: 0; }
.rail-head h1 { font-size: 14px; margin: 0; }
.rail-toggle { margin-left: auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: transparent; border: none; border-radius: 4px; color: var(--p-text-color-secondary); cursor: pointer; }
.rail-toggle:hover { background: rgba(255,255,255,0.06); color: var(--p-text-color); }
.rail-toggle i { font-size: 12px; }
.rail-expand-strip { flex-shrink: 0; border-bottom: 1px solid var(--p-content-border-color, #2a2e38); }
.rail-expand-btn { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: transparent; border: none; color: var(--p-text-color-secondary); cursor: pointer; font: inherit; font-size: 12px; }
.rail-expand-btn:hover { background: rgba(255,255,255,0.04); color: var(--p-text-color); }
.rail-expand-btn i { font-size: 12px; }
.rail-expand-label { font-weight: 600; }
.rail-expand-badge { font-size: 10px; }

.filter-bar {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
}
.filter-btn {
  font: inherit;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--p-text-color-secondary);
  cursor: pointer;
}
.filter-btn:hover { background: rgba(255,255,255,0.05); color: var(--p-text-color); }
.filter-btn.active { background: rgba(74,138,232,0.15); color: #7ab8f5; border-color: rgba(74,138,232,0.3); }

.list-rail { height: 100%; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.empty { color: var(--p-text-color-secondary); padding: 8px; }

.card {
  text-align: left; background: #1c1f27; border: 1px solid transparent;
  border-left: 3px solid transparent; color: var(--p-text-color);
  padding: 10px 12px; border-radius: 6px; cursor: pointer;
  display: flex; flex-direction: column; gap: 4px; font: inherit;
}
.card:hover { background: #20232c; }
.card.active { background: #232733; border-left-color: var(--p-primary-color, #88c0d0); }
.card:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: 1px; }

.card-row { display: flex; align-items: center; gap: 6px; }
.title-row { justify-content: space-between; }
.title-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 600; font-size: 13px; color: var(--p-text-color);
}
.time { color: var(--p-text-color-secondary); font-size: 11px; flex-shrink: 0; }
/* Small monospace technical id, shown as a subtitle under the human
 * label when both are available. Keeps the auto-minted `__adhoc_*`
 * / template id visible for debugging without dominating the card. */
.card-sub-id {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  font-size: 10.5px; color: var(--p-text-color-secondary);
  margin-top: -2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-preview {
  color: var(--p-text-color-secondary); font-size: 12px; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.chips-row { flex-wrap: wrap; }
.progress-tag, .child-tag {
  font-size: 11px; color: var(--p-text-color-secondary);
  background: rgba(255,255,255,0.05); padding: 1px 6px; border-radius: 4px;
}
.awaiting-tag {
  font-size: 11px; color: #f5c85a; background: rgba(245, 200, 90, 0.10);
  padding: 1px 6px; border-radius: 4px;
  display: inline-flex; align-items: center; gap: 3px;
}

.detail-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--p-text-color-secondary); }
.empty-icon { font-size: 32px; opacity: 0.4; }
.empty-text { font-size: 13px; }
</style>
