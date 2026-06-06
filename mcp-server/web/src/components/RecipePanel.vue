<script setup lang="ts">
/**
 * RecipePanel — renders the recipe step list with live status. Pulls
 * from GET /api/recipe-instances/:id which surfaces both the on-disk
 * `RecipeInstance.steps[]` and the live status. Re-fetches on the SSE
 * 'recipes' topic via the parent's prop watcher.
 *
 * Shows: per-step status emoji + title + (optional) progress message.
 */
import { computed, ref, watch } from 'vue';
import {
  fetchRecipeInstance,
  type RecipeInstanceView,
  type RecipeStepView,
} from '../api';

const props = defineProps<{
  instanceId: string;
  /** Bump this to force re-fetch (e.g. from a parent SSE listener). */
  refreshNonce?: number;
}>();

const instance = ref<RecipeInstanceView | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    instance.value = await fetchRecipeInstance(props.instanceId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.instanceId, props.refreshNonce ?? 0] as const,
  () => load(),
  { immediate: true },
);

const steps = computed<RecipeStepView[]>(() => instance.value?.steps ?? []);

function emojiFor(status: string): string {
  switch (status) {
    case 'success':  return '✓';
    case 'failure':  return '✗';
    case 'running':  return '⟳';
    case 'pending':  return '○';
    case 'skipped':  return '–';
    default:         return '?';
  }
}
function statusClass(status: string): string {
  return `step-${status}`;
}
</script>

<template>
  <div class="recipe-panel">
    <div v-if="error" class="empty err">Error: {{ error }}</div>
    <template v-else-if="instance">
      <div class="recipe-header">
        <span class="recipe-id">{{ instance.recipe_id }}</span>
        <span class="muted">·</span>
        <span :class="['recipe-status', `recipe-status--${instance.status}`]">{{ instance.status }}</span>
      </div>
      <div v-if="instance.message" class="recipe-msg muted">{{ instance.message }}</div>

      <ol v-if="steps.length > 0" class="steps">
        <li v-for="(s, i) in steps" :key="s.id" :class="['step', statusClass(s.status)]">
          <span class="step-num">{{ i + 1 }}</span>
          <span class="step-emoji">{{ emojiFor(s.status) }}</span>
          <div class="step-body">
            <div class="step-title">{{ s.title }}</div>
            <div v-if="s.message" class="step-msg muted">{{ s.message }}</div>
          </div>
        </li>
      </ol>
      <div v-else class="empty muted">No steps defined for this recipe.</div>
    </template>
    <div v-else-if="loading" class="empty muted">Loading…</div>
    <div v-else class="empty muted">No recipe info.</div>
  </div>
</template>

<style scoped>
.recipe-panel { display: flex; flex-direction: column; padding: 8px 10px; overflow-y: auto; height: 100%; gap: 8px; }
.recipe-header { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.recipe-id { font-weight: 600; color: #d8dee9; }
.recipe-status { padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; font-size: 10px; font-weight: 600; }
.recipe-status--running { background: #1a3050; color: #79b8ff; }
.recipe-status--success { background: #16341a; color: #6cce6c; }
.recipe-status--failure { background: #3a1818; color: #e06c75; }
.recipe-status--cancelled { background: #2a2a2a; color: #a0a0a0; }
.recipe-msg { font-size: 11px; padding-bottom: 4px; border-bottom: 1px solid #23262d; }

.steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.step { display: grid; grid-template-columns: 22px 18px 1fr; align-items: start; gap: 6px; padding: 6px; border-left: 3px solid #2a2f37; border-radius: 3px; background: #1a1d24; }
.step-num { color: #5a5f68; font-size: 11px; line-height: 1.6; text-align: right; }
.step-emoji { font-size: 13px; line-height: 1.6; text-align: center; }
.step-body { min-width: 0; }
.step-title { font-size: 12px; font-weight: 500; color: #d8dee9; word-break: break-word; }
.step-msg { font-size: 10px; margin-top: 2px; word-break: break-word; }

.step.step-success { border-left-color: #4caf50; }
.step.step-success .step-emoji { color: #4caf50; }
.step.step-failure { border-left-color: #e06c75; }
.step.step-failure .step-emoji { color: #e06c75; }
.step.step-running { border-left-color: #79b8ff; }
.step.step-running .step-emoji { color: #79b8ff; animation: spin 1.4s linear infinite; display: inline-block; }
.step.step-pending { border-left-color: #3a3f4a; opacity: 0.7; }
.step.step-skipped { border-left-color: #555b66; opacity: 0.5; }

@keyframes spin {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.empty { font-size: 11px; padding: 6px; }
.empty.err { color: #e06c75; }
.muted { color: #7c8290; }
</style>
