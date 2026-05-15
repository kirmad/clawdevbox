<script setup lang="ts">
/**
 * RecipeDetailPanel — full details for a single recipe instance.
 *
 * Sections:
 *   - sticky header: title (recipe_id) + back/fullscreen + status tag
 *   - awaiting-user callout (only when steps.* has status='awaiting_user')
 *   - prompt
 *   - stepper (vertical) — per-step status icon + title + duration +
 *     message + optional artifact / child-run jump
 *   - children section (when other instances ref this one as parent)
 *   - metadata (workspace, agent CLI, pid, message)
 *
 * Read-only. Mutation buttons (Cancel, View terminal) are deferred
 * until the matching HTTP endpoints land — showing fake controls is
 * worse than no controls.
 */
import { computed, ref } from 'vue';
import { useFullscreen } from '../composables/useFullscreen';
import { useUiStore } from '../stores/ui';
import type { RecipeInstance, RecipeStep } from '../api';

const props = defineProps<{
  recipeId: string;
  paneKey: string;
  showBack?: boolean;
}>();

const emit = defineEmits<{ (e: 'back'): void }>();

const store = useUiStore();
const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(props.paneKey);

const recipe = computed<RecipeInstance | undefined>(() =>
  store.recipes.find((r) => r.id === props.recipeId),
);

const awaitingSteps = computed<RecipeStep[]>(() =>
  (recipe.value?.steps ?? []).filter((s) => s.status === 'awaiting_user'),
);

const statusSeverity = computed(() => {
  switch (recipe.value?.status) {
    case 'success': return 'success';
    case 'failure': return 'danger';
    case 'cancelled': return 'secondary';
    case 'running':
    default: return 'info';
  }
});

function stepIcon(s: RecipeStep): string {
  switch (s.status) {
    case 'done': return 'pi pi-check-circle';
    case 'running': return 'pi pi-spin pi-spinner';
    case 'failed': return 'pi pi-times-circle';
    case 'awaiting_user': return 'pi pi-user';
    case 'skipped': return 'pi pi-step-forward';
    case 'pending':
    default: return 'pi pi-circle';
  }
}

function stepClass(s: RecipeStep): string {
  return `step-row step-${s.status}`;
}

function formatDuration(s: RecipeStep): string {
  if (!s.started_at) return '';
  const end = s.completed_at ?? Date.now();
  const ms = end - s.started_at;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 6000) / 10}m`;
  return `${Math.round(ms / 360000) / 10}h`;
}

function relativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff < 0 ? `in ${Math.round(abs / 1000)}s` : `${Math.round(abs / 1000)}s ago`;
  if (abs < 3_600_000) return diff < 0 ? `in ${Math.round(abs / 60_000)}m` : `${Math.round(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return diff < 0 ? `in ${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function openChildRecipe(id: string): void {
  store.selectRecipe(id);
}

function openArtifact(id: string): void {
  store.openArtifact({ id, title: id, url: `/artifact/${encodeURIComponent(id)}` });
}

function jumpToFirstAwaiting(): void {
  const target = document.getElementById(`step-${props.recipeId}-${awaitingSteps.value[0]?.id}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const isResuming = ref(false);
const canResume = computed(() => {
  // Resume needs a session_id. Status doesn't matter — even running
  // instances can be resumed (caller's responsibility to avoid two
  // concurrent agent processes against the same session).
  return !!recipe.value?.session_id;
});

async function onResume(): Promise<void> {
  if (!recipe.value || !canResume.value || isResuming.value) return;
  isResuming.value = true;
  try {
    await store.resumeRecipe(recipe.value.id);
  } finally {
    isResuming.value = false;
  }
}

function openTerminal(): void {
  if (!recipe.value) return;
  // Open the live xterm viewer at /terminal/<instance_id> as a SPA tab
  // (iframe). The terminal server is in the same HTTP process, so the
  // sandbox-allow-same-origin iframe just works.
  const id = recipe.value.id;
  store.openArtifact({
    id: `term-${id}`,
    title: `Terminal · ${recipe.value.recipe_id}`,
    url: `/terminal/${encodeURIComponent(id)}`,
  });
}
</script>

<template>
  <section v-if="recipe" class="recipe-detail" :class="{ 'fs-pane': isFullscreen }">
    <header class="detail-head">
      <div class="title-row">
        <Button
          v-if="showBack"
          icon="pi pi-arrow-left"
          text rounded size="small"
          aria-label="Back to recipes list"
          class="head-btn"
          @click="emit('back')"
        />
        <div class="head-text">
          <h1 class="detail-title">{{ recipe.recipe_id }}</h1>
          <div class="detail-meta">
            <Tag :severity="statusSeverity" :value="recipe.status" />
            <span v-if="recipe.progress" class="progress-line">
              <i class="pi pi-list" />
              {{ recipe.progress.completed_steps }} / {{ recipe.progress.total_steps }} steps
            </span>
            <span class="meta-line">
              {{ recipe.agent_cli || 'agent' }}
              <template v-if="recipe.started_at">· started {{ relativeTime(recipe.started_at) }}</template>
              <template v-if="recipe.completed_at">· finished {{ relativeTime(recipe.completed_at) }}</template>
            </span>
          </div>
        </div>
      </div>
      <div class="head-actions">
        <Button
          icon="pi pi-desktop"
          size="small"
          severity="secondary"
          outlined
          aria-label="View live terminal"
          title="View live terminal (xterm) for this recipe instance"
          class="action-btn"
          @click="openTerminal"
        >
          <i class="pi pi-desktop" /> <span class="action-label">Terminal</span>
        </Button>
        <Button
          v-if="canResume"
          icon="pi pi-replay"
          size="small"
          severity="info"
          :loading="isResuming"
          aria-label="Resume agent session"
          title="Resume this agent CLI session (spawns a new run with --resume <session_id>)"
          class="action-btn"
          @click="onResume"
        >
          <i class="pi pi-replay" /> <span class="action-label">Resume</span>
        </Button>
        <Button
          :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          text rounded size="small"
          :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
          :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
          class="head-btn"
          @click="toggleFullscreen"
        />
      </div>
    </header>

    <div class="detail-scroll">
      <!-- Sticky callout for awaiting-user steps -->
      <Message
        v-if="awaitingSteps.length > 0"
        severity="warn"
        :closable="false"
        class="awaiting-banner"
      >
        <div class="awaiting-text">
          <i class="pi pi-user" />
          <strong>{{ awaitingSteps.length }} step{{ awaitingSteps.length === 1 ? '' : 's' }} awaiting your input.</strong>
          <span v-if="awaitingSteps[0].awaiting_user_prompt">{{ awaitingSteps[0].awaiting_user_prompt }}</span>
        </div>
        <Button label="Jump to step" size="small" text @click="jumpToFirstAwaiting" />
      </Message>

      <section v-if="recipe.prompt" class="block">
        <div class="block-head"><i class="pi pi-comment" /> Prompt</div>
        <pre class="prompt">{{ recipe.prompt }}</pre>
      </section>

      <section v-if="recipe.steps && recipe.steps.length > 0" class="block">
        <div class="block-head"><i class="pi pi-list" /> Steps</div>
        <div class="stepper">
          <div
            v-for="(s, i) in recipe.steps"
            :key="s.id"
            :id="`step-${recipe.id}-${s.id}`"
            :class="stepClass(s)"
          >
            <span class="step-rail">
              <i :class="stepIcon(s)" />
              <span v-if="i < recipe.steps!.length - 1" class="step-line" />
            </span>
            <div class="step-body">
              <div class="step-title-row">
                <span class="step-title">{{ s.title }}</span>
                <span v-if="formatDuration(s)" class="step-duration">{{ formatDuration(s) }}</span>
              </div>
              <div v-if="s.message" class="step-message">{{ s.message }}</div>
              <div
                v-if="s.status === 'awaiting_user' && s.awaiting_user_prompt"
                class="step-awaiting"
              >
                <i class="pi pi-user" />
                {{ s.awaiting_user_prompt }}
              </div>
              <div v-if="s.child_recipe_instance_id || s.artifact_id" class="step-actions">
                <Button
                  v-if="s.child_recipe_instance_id"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  class="step-btn"
                  @click="openChildRecipe(s.child_recipe_instance_id!)"
                >
                  <i class="pi pi-sitemap" /> Open child run
                </Button>
                <Button
                  v-if="s.artifact_id"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  class="step-btn"
                  @click="openArtifact(s.artifact_id!)"
                >
                  <i class="pi pi-external-link" /> Open artifact
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="recipe.children && recipe.children.length > 0" class="block">
        <div class="block-head"><i class="pi pi-sitemap" /> Child runs</div>
        <div class="children">
          <Button
            v-for="c in recipe.children"
            :key="c.id"
            size="small"
            severity="secondary"
            :outlined="true"
            class="child-btn"
            @click="openChildRecipe(c.id)"
          >
            <i :class="c.status === 'running' ? 'pi pi-spin pi-spinner' : 'pi pi-arrow-right'" />
            <span class="child-recipe-id">{{ c.recipe_id }}</span>
            <Tag :value="c.status" :severity="c.status === 'success' ? 'success' : c.status === 'failure' ? 'danger' : 'info'" />
          </Button>
        </div>
      </section>

      <section v-if="recipe.message" class="block">
        <div class="block-head"><i class="pi pi-info-circle" /> Result message</div>
        <pre class="result-msg">{{ recipe.message }}</pre>
      </section>

      <section class="block meta-block">
        <div class="block-head"><i class="pi pi-tag" /> Metadata</div>
        <dl class="kv">
          <dt>instance id</dt><dd><code>{{ recipe.id }}</code></dd>
          <dt v-if="recipe.session_id">session id</dt>
          <dd v-if="recipe.session_id">
            <code class="session-id">{{ recipe.session_id }}</code>
            <span class="muted">· explicit, used as --session-id / --resume for the CLI</span>
          </dd>
          <dt v-if="recipe.resume_of">resume of</dt>
          <dd v-if="recipe.resume_of">
            <Button size="small" text @click="openChildRecipe(recipe.resume_of!)">
              <code>{{ recipe.resume_of }}</code>
            </Button>
          </dd>
          <dt v-if="recipe.workspace_id">workspace</dt>
          <dd v-if="recipe.workspace_id"><code>{{ recipe.workspace_id }}</code></dd>
          <dt v-if="recipe.parent_recipe_instance_id">parent</dt>
          <dd v-if="recipe.parent_recipe_instance_id">
            <Button
              size="small"
              text
              @click="openChildRecipe(recipe.parent_recipe_instance_id!)"
            >
              <code>{{ recipe.parent_recipe_instance_id }}</code>
            </Button>
          </dd>
          <dt v-if="recipe.pid">pid</dt>
          <dd v-if="recipe.pid">{{ recipe.pid }}</dd>
        </dl>
      </section>
    </div>
  </section>

  <section v-else class="recipe-empty">
    <i class="pi pi-history empty-icon" />
    <div class="empty-text">Recipe not found.</div>
  </section>
</template>

<style scoped>
.recipe-detail {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--p-content-background, #15171d);
}
.detail-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  flex-shrink: 0;
}
.title-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.head-text { flex: 1; min-width: 0; }
.head-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.head-btn { width: 30px; height: 30px; padding: 0; flex-shrink: 0; }

@media (min-width: 640px) {
  .detail-head { flex-direction: row; align-items: flex-start; padding: 12px 16px; gap: 12px; }
  .title-row { flex: 1; min-width: 0; }
  .head-actions { flex-shrink: 0; }
}

.detail-title {
  font-size: 16px;
  margin: 0;
  font-family: ui-monospace, Consolas, Menlo, monospace;
  color: var(--p-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.progress-line, .meta-line { color: var(--p-text-color-secondary); font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; }

.detail-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 12px 16px 32px;
  display: flex; flex-direction: column; gap: 14px;
}

.awaiting-banner { position: sticky; top: 0; z-index: 2; margin: 0; }
.awaiting-text { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: 1; }

.block { display: flex; flex-direction: column; gap: 6px; }
.block-head {
  color: var(--p-text-color-secondary);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex; align-items: center; gap: 6px;
}
.prompt, .result-msg {
  margin: 0;
  background: #1a1d24;
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--p-text-color);
}

.stepper { display: flex; flex-direction: column; }
.step-row { display: grid; grid-template-columns: 28px 1fr; gap: 8px; min-height: 56px; }
.step-rail {
  display: flex; flex-direction: column; align-items: center;
  color: var(--p-text-color-secondary);
}
.step-rail i { font-size: 16px; margin-top: 4px; z-index: 1; background: var(--p-content-background, #15171d); padding: 2px 0; }
.step-line { flex: 1; width: 2px; background: #2a2e38; margin: 2px 0; }
.step-body { display: flex; flex-direction: column; gap: 4px; padding-bottom: 12px; }
.step-title-row { display: flex; align-items: baseline; gap: 8px; }
.step-title { font-weight: 500; font-size: 13.5px; }
.step-duration { color: var(--p-text-color-secondary); font-size: 11px; }
.step-message { color: var(--p-text-color-secondary); font-size: 12px; }
.step-awaiting {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(245, 200, 90, 0.08);
  border-left: 3px solid #f5c85a;
  padding: 6px 10px;
  border-radius: 0 4px 4px 0;
  font-size: 12.5px;
  color: var(--p-text-color);
}
.step-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.step-btn { font-size: 11.5px; }

.step-done .step-rail i { color: #4ade80; }
.step-running .step-rail i { color: #4daafc; }
.step-failed .step-rail i { color: #f87171; }
.step-awaiting_user .step-rail i { color: #f5c85a; }
.step-skipped .step-rail i { color: var(--p-text-color-secondary); opacity: 0.6; }
.step-pending .step-rail i { opacity: 0.5; }

.children { display: flex; flex-wrap: wrap; gap: 6px; }
.child-btn { justify-content: flex-start; }
.child-recipe-id { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 12px; margin: 0 6px; }

.meta-block .kv {
  display: grid; grid-template-columns: 100px 1fr; gap: 4px 8px;
  margin: 0; font-size: 12px;
}
.kv dt { color: var(--p-text-color-secondary); }
.kv dd { margin: 0; }
.kv code { background: #14161b; padding: 1px 4px; border-radius: 3px; font-size: 11.5px; }

.recipe-empty {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; color: var(--p-text-color-secondary);
}
.empty-icon { font-size: 28px; opacity: 0.4; }
.empty-text { font-size: 13px; }

.muted { color: var(--p-text-color-secondary); font-size: 11.5px; margin-left: 6px; }
.resume-label, .action-label { margin-left: 4px; }
.session-id {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  background: rgba(77, 170, 252, 0.08);
  color: #4daafc;
  padding: 1px 6px; border-radius: 3px;
}
</style>
