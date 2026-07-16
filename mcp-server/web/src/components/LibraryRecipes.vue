<script setup lang="ts">
/**
 * LibraryRecipes — browse recipe TEMPLATES. Master list on the left; the
 * detail pane shows the dependency-flow visualization (RecipeFlow), the
 * ordered step list, and the raw source.
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  fetchLibraryRecipes,
  fetchLibraryRecipe,
  type LibraryRecipeSummary,
  type LibraryRecipeDetail,
} from '../api';
import RecipeFlow from './RecipeFlow.vue';
import CodeBlock from './CodeBlock.vue';
import { scopeLabel, scopeSeverity } from './useLibraryScope';

const items = ref<LibraryRecipeSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

const detail = ref<LibraryRecipeDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const showSource = ref(false);

const highlightStep = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchLibraryRecipes();
    items.value = res.items;
    error.value = null;
    if (!selectedId.value && items.value.length > 0) select(items.value[0].id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function select(id: string): void {
  selectedId.value = id;
  showSource.value = false;
  highlightStep.value = null;
}

watch(selectedId, async (id) => {
  if (!id) { detail.value = null; return; }
  detailLoading.value = true;
  detailError.value = null;
  try {
    detail.value = await fetchLibraryRecipe(id);
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
});

const orderedSteps = computed(() => detail.value?.steps ?? []);

/** Plain-English description of what a validation gate mode checks. */
function gateExplain(mode: string): string {
  switch (mode) {
    case 'evidence':
      return 'Before this step can complete, an independent verifier must confirm — from real evidence (files, git, tests, ADO, etc.) — that the claimed outcome is actually true.';
    case 'artifacts':
      return 'An independent verifier inspects the artifacts this step produced and checks them against the goal before the step can complete.';
    default:
      return 'An independent verifier must confirm this step\'s outcome before it can complete.';
  }
}

function onFlowSelect(id: string): void {
  highlightStep.value = id;
  const el = document.getElementById(`recipe-step-${id}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

onMounted(load);
</script>

<template>
  <div class="lib-md">
    <aside class="lib-rail">
      <header class="lib-rail__head">
        <span>Recipes</span>
        <Badge v-if="items.length" :value="items.length" severity="secondary" />
      </header>
      <div class="lib-rail__list">
        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <div v-else-if="loading && !items.length" class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</div>
        <div v-else-if="!items.length" class="lib-muted">No recipe templates found.</div>
        <button
          v-for="it in items"
          :key="it.id"
          type="button"
          class="lib-card"
          :class="{ active: selectedId === it.id }"
          @click="select(it.id)"
        >
          <div class="lib-card__title">{{ it.name }}</div>
          <div class="lib-card__meta">
            <Tag :value="scopeLabel(it.scope)" :severity="scopeSeverity(it.scope)" />
            <span class="lib-muted">{{ it.step_count }} step{{ it.step_count === 1 ? '' : 's' }}</span>
          </div>
          <div v-if="it.description" class="lib-card__desc">{{ it.description }}</div>
        </button>
      </div>
    </aside>

    <section class="lib-detail">
      <div v-if="detailLoading" class="lib-pad"><span class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</span></div>
      <div v-else-if="detailError" class="lib-pad"><Message severity="error" :closable="false">{{ detailError }}</Message></div>
      <div v-else-if="!detail" class="lib-empty"><i class="pi pi-sitemap" /><span>Select a recipe to view its flow.</span></div>
      <div v-else class="lib-detail__scroll">
        <header class="lib-detail__head">
          <div>
            <h2>{{ detail.name }}</h2>
            <code class="lib-detail__id">{{ detail.id }}</code>
          </div>
          <Tag :value="scopeLabel(detail.scope)" :severity="scopeSeverity(detail.scope)" />
        </header>
        <p v-if="detail.description" class="lib-detail__desc">{{ detail.description }}</p>

        <section class="lib-block">
          <h3><i class="pi pi-sitemap" /> Flow</h3>
          <RecipeFlow :steps="detail.steps" @select="onFlowSelect" />
        </section>

        <section class="lib-block">
          <h3><i class="pi pi-list" /> Steps ({{ orderedSteps.length }})</h3>
          <ol class="step-list">
            <li
              v-for="s in orderedSteps"
              :id="`recipe-step-${s.id}`"
              :key="s.id"
              class="step-item"
              :class="{ hot: highlightStep === s.id }"
            >
              <div class="step-item__head">
                <code class="step-item__id">{{ s.id }}</code>
                <span
                  v-if="s.validation?.gates?.length"
                  class="step-item__gate"
                  :title="s.validation.gates.length > 1 ? `${s.validation.gates.length} validation gates` : `Validation-gated (${s.validation.gates[0].mode})`"
                >
                  <i class="pi pi-shield" />
                  <template v-if="s.validation.gates.length > 1">×{{ s.validation.gates.length }}</template>
                  <template v-else>{{ s.validation.gates[0].mode }}</template>
                </span>
                <i v-if="s.has_ai_instructions" class="pi pi-sparkles step-item__ai" title="Has AI instructions" />
                <span v-if="s.depends.length" class="step-item__deps">
                  <i class="pi pi-arrow-left" /> {{ s.depends.join(', ') }}
                </span>
              </div>
              <div class="step-item__goal">{{ s.goal }}</div>
              <div v-if="s.validation?.gates?.length" class="step-item__validation">
                <div
                  v-for="(gate, gi) in s.validation.gates"
                  :key="gi"
                  class="step-item__validation-row"
                >
                  <i class="pi pi-shield" />
                  <div class="step-item__validation-body">
                    <span class="step-item__validation-mode">
                      {{ gate.mode }}
                      <span class="step-item__validation-name">{{ gate.name }}</span>
                    </span>
                    <span class="step-item__validation-explain">{{ gateExplain(gate.mode) }}</span>
                    <span v-if="gate.criteria" class="step-item__validation-criteria">
                      <b>Criteria:</b> {{ gate.criteria }}
                    </span>
                  </div>
                </div>
              </div>
            </li>
          </ol>
        </section>

        <section class="lib-block">
          <button type="button" class="lib-toggle" @click="showSource = !showSource">
            <i :class="showSource ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
            {{ showSource ? 'Hide' : 'Show' }} source
          </button>
          <CodeBlock v-if="showSource" :source="detail.source" runtime="yaml" :max-height="480" />
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.step-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.step-item { background: #1c1f27; border: 1px solid #2a2e38; border-radius: 6px; padding: 8px 10px; transition: box-shadow 0.2s, border-color 0.2s; }
.step-item.hot { border-color: var(--p-primary-color, #88c0d0); box-shadow: 0 0 0 2px var(--p-primary-color, #88c0d0)44; }
.step-item__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.step-item__id { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 12px; font-weight: 600; color: var(--p-primary-color, #88c0d0); }
.step-item__ai { color: #d0a24c; font-size: 11px; }
.step-item__gate {
  display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.03em; color: #c4b5fd;
  background: rgba(167, 139, 250, 0.16); border-radius: 9px; padding: 1px 7px;
}
.step-item__gate i { font-size: 10px; }
.step-item__deps { font-size: 11px; color: var(--p-text-color-secondary); display: inline-flex; align-items: center; gap: 4px; }
.step-item__goal { font-size: 12.5px; color: var(--p-text-color); margin-top: 3px; line-height: 1.45; }
.step-item__validation {
  display: flex; flex-direction: column; gap: 8px; margin-top: 7px; padding: 7px 9px;
  background: rgba(167, 139, 250, 0.07); border-left: 3px solid #a78bfa; border-radius: 0 5px 5px 0;
}
.step-item__validation-row { display: flex; gap: 8px; }
.step-item__validation-row + .step-item__validation-row {
  border-top: 1px solid rgba(167, 139, 250, 0.18); padding-top: 8px;
}
.step-item__validation-row > i { color: #a78bfa; font-size: 13px; margin-top: 1px; }
.step-item__validation-body { display: flex; flex-direction: column; gap: 3px; }
.step-item__validation-mode {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #c4b5fd;
  display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
}
.step-item__validation-name {
  font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11px; font-weight: 600;
  text-transform: none; letter-spacing: normal; color: var(--p-text-color-secondary);
}
.step-item__validation-explain { font-size: 12px; color: var(--p-text-color-secondary); line-height: 1.45; }
.step-item__validation-criteria { font-size: 12px; color: var(--p-text-color); line-height: 1.45; }
.step-item__validation-criteria b { color: var(--p-text-color-secondary); }
</style>
