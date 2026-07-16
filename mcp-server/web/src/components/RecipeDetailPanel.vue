<script setup lang="ts">
/**
 * RecipeDetailPanel — full details for a single recipe instance.
 *
 * Sections:
 *   - sticky header: title (recipe_id) + back/fullscreen + status tag
 *   - subtab strip — shows when at least one artifact or inbox item has
 *     been opened inline; "Steps" is the default first tab
 *   - awaiting-user callout (only when steps.* has status='awaiting_user')
 *   - prompt
 *   - related inbox items — chips for inbox items whose recipe_instance.id
 *     matches; clicking opens the item inline as a subtab
 *   - stepper (vertical) — per-step status icon + title + duration +
 *     message + optional artifact / child-run jump (Open artifact opens
 *     INLINE as a subtab instead of stealing focus to a top-level tab)
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
import type { InboxItem, RecipeInstance, RecipeStep, ValidationRound } from '../api';
import InboxDetailPanel from './InboxDetailPanel.vue';
import InboxTerminalPanel from './InboxTerminalPanel.vue';

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
    case 'validating': return 'pi pi-spin pi-spinner';
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

// -- Validation gate UI ------------------------------------------------------
// Track which gated step's per-round validation history is expanded.
const expandedValidation = ref<Set<string>>(new Set());
function toggleValidation(stepId: string): void {
  const next = new Set(expandedValidation.value);
  if (next.has(stepId)) next.delete(stepId);
  else next.add(stepId);
  expandedValidation.value = next;
}
/** Icon for a single round's outcome. */
function verdictIcon(r: { verdict?: string; error?: string }): string {
  switch (r.verdict) {
    case 'PASS': return 'pi pi-check-circle';
    case 'FAIL': return 'pi pi-times-circle';
    case 'BLOCKED': return 'pi pi-pause-circle';
    default: return r.error ? 'pi pi-exclamation-triangle' : 'pi pi-spin pi-spinner';
  }
}
function roundClass(r: { verdict?: string; error?: string }): string {
  const kind = r.verdict ? r.verdict.toLowerCase() : r.error ? 'error' : 'pending';
  return `sv-round vr-${kind}`;
}
function roundLabel(r: { verdict?: string; error?: string }): string {
  if (r.verdict) return r.verdict;
  return r.error ? 'infra error' : 'running…';
}
/** Header icon/label for the gate summary line. */
function svHeadIcon(s: RecipeStep): string {
  if (s.status === 'validating') return 'pi pi-spin pi-spinner';
  const v = s.validation?.latest?.verdict;
  if (v === 'PASS') return 'pi pi-verified';
  if (v === 'FAIL') return 'pi pi-times-circle';
  if (v === 'BLOCKED') return 'pi pi-pause-circle';
  return 'pi pi-shield';
}
function svHeadLabel(s: RecipeStep): string {
  if (s.status === 'validating') return 'Validating claim…';
  const v = s.validation?.latest?.verdict;
  if (v === 'PASS') return 'Verified by independent check';
  if (v === 'FAIL') return 'Validation failed — reverted to active';
  if (v === 'BLOCKED') return 'Blocked by verifier';
  return 'Validation-gated';
}
function svHeadClass(s: RecipeStep): string {
  if (s.status === 'validating') return 'sv-progress';
  const v = s.validation?.latest?.verdict;
  if (v === 'PASS') return 'sv-pass';
  if (v === 'FAIL') return 'sv-fail';
  if (v === 'BLOCKED') return 'sv-blocked';
  return 'sv-gated';
}
/**
 * Group a gated step's rounds by attempt (ascending). Used only for the
 * multi-gate view, where each attempt runs one round per gate; single-gate
 * steps keep the flat round list.
 */
function roundsByAttempt(s: RecipeStep): { attempt: number; rounds: ValidationRound[] }[] {
  const groups = new Map<number, ValidationRound[]>();
  for (const r of s.validation?.rounds ?? []) {
    const attempt = r.attempt ?? 0;
    const list = groups.get(attempt);
    if (list) list.push(r);
    else groups.set(attempt, [r]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([attempt, rounds]) => ({ attempt, rounds }));
}

// Track which step's "Agent instructions" panel is expanded. Persisted only
// for the lifetime of this component instance; collapsed by default to keep
// the stepper scannable.
const expandedAi = ref<Set<string>>(new Set());
function toggleAiInstructions(stepId: string): void {
  const next = new Set(expandedAi.value);
  if (next.has(stepId)) next.delete(stepId);
  else next.add(stepId);
  expandedAi.value = next;
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

/**
 * Open the artifact INLINE as a subtab inside this recipe panel.
 * Mirrors the inbox-attachment-as-subtab UX so users don't lose the
 * stepper / awaiting-user banner / metadata they were just looking at.
 * Re-clicking the same Open artifact button is idempotent — it just
 * re-activates the existing subtab.
 */
function openArtifact(id: string, title?: string): void {
  store.openRecipeArtifactInline(props.recipeId, id, title);
}

/** Open a recipe-linked inbox item INLINE as a subtab. */
function openInboxInline(item: InboxItem): void {
  store.openRecipeInboxInline(props.recipeId, item.id, item.title ?? item.id);
}

// ---------------------------------------------------------------------------
// Per-recipe subtab state
// ---------------------------------------------------------------------------

const subtabState = computed(() =>
  store.recipeSubtabs[props.recipeId] ?? { tabs: [], active: null as string | null },
);
const activeSubtab = computed<string | null>(() => subtabState.value.active);
const subtabs = computed(() => subtabState.value.tabs);

function selectStepsSubtab(): void {
  store.setActiveRecipeSubtab(props.recipeId, null);
}
function selectSubtab(id: string): void {
  store.setActiveRecipeSubtab(props.recipeId, id);
}
function closeSubtab(id: string, ev?: Event): void {
  ev?.stopPropagation();
  store.closeRecipeSubtab(props.recipeId, id);
}

// ---------------------------------------------------------------------------
// Related inbox items — inbox rows whose recipe_instance.id matches this
// recipe. Lets the user jump straight to the conversation that triggered
// (or was emitted by) this run without leaving the recipe context.
// ---------------------------------------------------------------------------
const relatedInbox = computed<InboxItem[]>(() =>
  store.inbox
    .filter((it) => it.recipe_instance?.id === props.recipeId)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0)),
);

function jumpToFirstAwaiting(): void {
  const target = document.getElementById(`step-${props.recipeId}-${awaitingSteps.value[0]?.id}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * Terminal side panel (inbox-style): clicking a step/round/header terminal icon
 * opens an embedded xterm panel BESIDE the steps — it does NOT switch to the
 * Terminals tab. `terminalPanelSessionId` is a recipe_instance_id the
 * /terminal/<id> viewer accepts (same shape the inbox terminal panel takes).
 */
const terminalPanelOpen = ref(false);
const terminalPanelSessionId = ref<string | null>(null);
const terminalPanelLabel = ref<string>('Terminal');

function openTerminalPanel(instanceId: string, label: string): void {
  terminalPanelSessionId.value = instanceId;
  terminalPanelLabel.value = label;
  terminalPanelOpen.value = true;
}

/**
 * True when a terminal with this id exists in the sidebar list. Gating the
 * icons on this avoids dead links for ids we can't attach to (e.g. inline
 * recipes, or lanes that have not spawned a session yet).
 */
function hasTerminal(instanceId: string): boolean {
  return store.terminals.items.some((s) => s.instance_id === instanceId);
}

/**
 * The terminal id for this recipe's main/orchestrator session, or null when
 * none is open-able yet. Spawned recipes own a terminal under their instance
 * id; INLINE recipes run inside the parent agent's session, so resolve the
 * parent by session_id (matching the inbox parent-match idiom).
 */
const mainTerminalId = computed<string | null>(() => {
  const r = recipe.value;
  if (!r) return null;
  if (r.agent_cli === 'inline' && r.session_id) {
    const parent = store.terminals.items.find(
      (s) => s.cli_session_id === r.session_id && s.instance_id !== r.id,
    );
    return parent ? parent.instance_id : null;
  }
  return hasTerminal(r.id) ? r.id : null;
});

/** True once a step has actually started running (it has a start time). */
function stepRan(s: RecipeStep): boolean {
  return s.started_at != null;
}

/**
 * The openable terminal id for a step's driving session, or null. Main-lane
 * steps (terminal.instance_id === recipe.id) share the orchestrator console —
 * resolved via mainTerminalId so inline recipes deep-link the parent console.
 * Other lanes use their own resolved terminal when it's a real sidebar session.
 */
function stepTerminalId(s: RecipeStep): string | null {
  const r = recipe.value;
  if (!s.terminal || !r) return null;
  if (s.terminal.instance_id === r.id) return mainTerminalId.value;
  return hasTerminal(s.terminal.instance_id) ? s.terminal.instance_id : null;
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
          <h1 class="detail-title">{{ recipe.recipe_name?.trim() || recipe.recipe_id }}</h1>
          <div v-if="recipe.recipe_name?.trim()" class="detail-sub-id">{{ recipe.recipe_id }}</div>
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
          v-if="mainTerminalId"
          icon="pi pi-microchip-ai"
          text rounded size="small"
          aria-label="Open the main recipe terminal panel"
          title="Open the orchestrator (main) session terminal in a side panel"
          class="action-btn"
          :class="{ 'term-active': terminalPanelOpen && terminalPanelSessionId === mainTerminalId }"
          @click="openTerminalPanel(mainTerminalId!, 'main')"
        />
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

    <!-- Per-recipe subtab strip — renders only when at least one
         artifact OR inbox item has been opened inline. The "Steps"
         subtab is the default detail content; each other subtab shows
         its corresponding artifact iframe or inline inbox panel. -->
    <div v-if="subtabs.length > 0" class="subtab-strip" role="tablist" aria-label="Recipe views">
      <button
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: activeSubtab === null }"
        :aria-selected="activeSubtab === null"
        @click="selectStepsSubtab"
      >
        <i class="pi pi-list" />
        <span>Steps</span>
      </button>
      <button
        v-for="tab in subtabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: activeSubtab === tab.id }"
        :aria-selected="activeSubtab === tab.id"
        :title="tab.title || tab.id"
        @click="selectSubtab(tab.id)"
      >
        <i :class="tab.kind === 'inbox' ? 'pi pi-envelope' : tab.kind === 'terminal' ? 'pi pi-microchip-ai' : 'pi pi-paperclip'" />
        <span class="subtab-label">{{ tab.title || tab.id }}</span>
        <i
          class="pi pi-times subtab-close"
          role="button"
          tabindex="0"
          :aria-label="`Close ${tab.kind === 'inbox' ? 'inbox' : 'artifact'} subtab`"
          :title="`Close ${tab.title || tab.id}`"
          @click="closeSubtab(tab.id, $event)"
        />
      </button>
    </div>

    <!-- Artifact subtab: render the iframe inline (sandboxed identically
         to the top-level ArtifactPanel for safety). -->
    <template
      v-for="tab in subtabs.filter((t) => t.id === activeSubtab && t.kind === 'artifact')"
      :key="`art-${tab.id}`"
    >
      <div class="artifact-subpane">
        <iframe
          v-if="tab.kind === 'artifact'"
          :src="tab.url"
          :title="tab.title || tab.id"
          sandbox="allow-scripts allow-same-origin allow-forms"
          class="artifact-iframe"
          loading="lazy"
        />
      </div>
    </template>

    <!-- Inbox subtab: render the full <InboxDetailPanel> inline so the
         user can read/reply/open attachments without leaving the recipe.
         Same component used by InboxPanel master-detail — shares the
         body cache and lifecycle store. -->
    <template
      v-for="tab in subtabs.filter((t) => t.id === activeSubtab && t.kind === 'inbox')"
      :key="`inbox-${tab.id}`"
    >
      <div class="inbox-subpane">
        <InboxDetailPanel
          :item-id="tab.id"
          :pane-key="`recipe-${recipe.id}-inbox-${tab.id}`"
        />
      </div>
    </template>

    <!-- Terminal subtab: render the /terminal/<id>?embed=1 page inline.
         The page has its own xterm.js client + WebSocket plumbing so we
         get live attach for free; ?embed=1 hides the duplicate header.
         Same sandbox flags as the artifact iframe. -->
    <template
      v-for="tab in subtabs.filter((t) => t.id === activeSubtab && t.kind === 'terminal')"
      :key="`term-${tab.id}`"
    >
      <div class="terminal-subpane">
        <iframe
          v-if="tab.kind === 'terminal'"
          :src="tab.url"
          :title="tab.title || tab.id"
          sandbox="allow-scripts allow-same-origin allow-forms"
          class="terminal-iframe"
        />
      </div>
    </template>

    <div v-if="activeSubtab === null" class="rd-body-split">
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

      <!-- Related inbox items: chips for every inbox row whose
           recipe_instance.id matches this run. Clicking a chip opens
           the inbox detail INLINE as a subtab. -->
      <section v-if="relatedInbox.length > 0" class="block">
        <div class="block-head">
          <i class="pi pi-envelope" /> Related inbox items
          <span class="related-count">({{ relatedInbox.length }})</span>
        </div>
        <div class="related-inbox-list">
          <button
            v-for="it in relatedInbox"
            :key="it.id"
            type="button"
            class="related-inbox-chip"
            :class="{ unread: it.unread === true }"
            :title="it.preview ?? it.title ?? it.id"
            @click="openInboxInline(it)"
          >
            <span v-if="it.unread === true" class="related-unread-dot" aria-label="Unread" />
            <i class="pi pi-envelope" />
            <span class="related-inbox-title">{{ it.title || it.id }}</span>
            <Tag :value="it.state" severity="secondary" />
          </button>
        </div>
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
                v-if="s.ai_instructions"
                class="step-ai-instructions"
              >
                <button
                  type="button"
                  class="step-ai-toggle"
                  :aria-expanded="expandedAi.has(s.id)"
                  @click="toggleAiInstructions(s.id)"
                >
                  <i
                    class="pi"
                    :class="expandedAi.has(s.id) ? 'pi-chevron-down' : 'pi-chevron-right'"
                  />
                  Agent instructions
                </button>
                <pre
                  v-if="expandedAi.has(s.id)"
                  class="step-ai-body"
                >{{ s.ai_instructions }}</pre>
              </div>
              <div
                v-if="s.status === 'awaiting_user' && s.awaiting_user_prompt"
                class="step-awaiting"
              >
                <i class="pi pi-user" />
                {{ s.awaiting_user_prompt }}
              </div>
              <!-- Validation gate: indicator + validator outputs + rounds -->
              <div v-if="s.validation" class="step-validation" :class="svHeadClass(s)">
                <div class="sv-head">
                  <i :class="svHeadIcon(s)" />
                  <span class="sv-title">{{ svHeadLabel(s) }}</span>
                  <template v-if="s.validation.total_gates > 1">
                    <span class="sv-gatecount" :title="`${s.validation.total_gates} validation gates on this step`">
                      <i class="pi pi-shield" />×{{ s.validation.total_gates }}
                    </span>
                    <span class="sv-passed" :title="`${s.validation.passed_gates} of ${s.validation.total_gates} gates passed`">
                      {{ s.validation.passed_gates }}/{{ s.validation.total_gates }} gates passed
                    </span>
                  </template>
                  <span v-else class="sv-mode" :title="`Gate mode: ${s.validation.mode}`">{{ s.validation.mode }}</span>
                  <span v-if="s.validation.rework_count > 0" class="sv-rework">
                    <i class="pi pi-replay" /> {{ s.validation.rework_count }} rework{{ s.validation.rework_count === 1 ? '' : 's' }}
                  </span>
                </div>
                <div v-if="s.status === 'validating'" class="sv-note">
                  An independent verifier is checking this claim<span v-if="s.validation.verifier_session_id"> (session {{ s.validation.verifier_session_id.slice(0, 8) }})</span>…
                </div>
                <div v-else-if="s.validation.latest" class="sv-latest">{{ s.validation.latest.evidence }}</div>
                <div v-if="s.validation.latest?.gaps" class="sv-gaps"><b>Gaps to fix:</b> {{ s.validation.latest.gaps }}</div>
                <div v-if="s.validation.rounds.length > 0" class="sv-rounds">
                  <button type="button" class="sv-toggle" :aria-expanded="expandedValidation.has(s.id)" @click="toggleValidation(s.id)">
                    <i class="pi" :class="expandedValidation.has(s.id) ? 'pi-chevron-down' : 'pi-chevron-right'" />
                    {{ s.validation.rounds.length }} validation round{{ s.validation.rounds.length === 1 ? '' : 's' }}
                  </button>
                  <div v-if="expandedValidation.has(s.id)" class="sv-round-list">
                    <!-- Multi-gate: group rounds by attempt, one sub-card per gate -->
                    <template v-if="s.validation.total_gates > 1">
                      <div v-for="g in roundsByAttempt(s)" :key="g.attempt" class="sv-attempt-group">
                        <div class="sv-attempt-label">Attempt {{ g.attempt + 1 }}</div>
                        <div v-for="(r, ri) in g.rounds" :key="ri" :class="roundClass(r)">
                          <div class="sv-round-head">
                            <span v-if="r.gate" class="sv-gate-chip">{{ r.gate }}</span>
                            <span v-if="r.mode" class="sv-mode" :title="`Gate mode: ${r.mode}`">{{ r.mode }}</span>
                            <span class="sv-verdict"><i :class="verdictIcon(r)" /> {{ roundLabel(r) }}</span>
                            <span v-if="r.decided_at" class="sv-time">{{ relativeTime(r.decided_at) }}</span>
                            <span v-else-if="r.started_at" class="sv-time">{{ relativeTime(r.started_at) }}</span>
                            <button
                              v-if="r.terminal && hasTerminal(r.terminal.instance_id)"
                              type="button"
                              class="sv-term-btn"
                              title="Open this validator's terminal in a side panel"
                              aria-label="Open validator terminal"
                              @click="openTerminalPanel(r.terminal.instance_id, r.gate || 'validator')"
                            ><i class="pi pi-microchip-ai" /></button>
                          </div>
                          <div v-if="r.evidence" class="sv-round-evidence">{{ r.evidence }}</div>
                          <div v-if="r.gaps" class="sv-round-gaps"><b>Gaps:</b> {{ r.gaps }}</div>
                          <div v-if="r.error" class="sv-round-error"><i class="pi pi-exclamation-triangle" /> {{ r.error }}</div>
                        </div>
                      </div>
                    </template>
                    <!-- Single-gate: flat round list (unchanged) -->
                    <template v-else>
                      <div v-for="(r, ri) in s.validation.rounds" :key="ri" :class="roundClass(r)">
                        <div class="sv-round-head">
                          <span class="sv-round-n">Round {{ r.attempt + 1 }}</span>
                          <span class="sv-verdict"><i :class="verdictIcon(r)" /> {{ roundLabel(r) }}</span>
                          <span v-if="r.decided_at" class="sv-time">{{ relativeTime(r.decided_at) }}</span>
                          <span v-else-if="r.started_at" class="sv-time">{{ relativeTime(r.started_at) }}</span>
                          <button
                            v-if="r.terminal && hasTerminal(r.terminal.instance_id)"
                            type="button"
                            class="sv-term-btn"
                            title="Open this validator's terminal in a side panel"
                            aria-label="Open validator terminal"
                            @click="openTerminalPanel(r.terminal.instance_id, r.gate || 'validator')"
                          ><i class="pi pi-microchip-ai" /></button>
                        </div>
                        <div v-if="r.evidence" class="sv-round-evidence">{{ r.evidence }}</div>
                        <div v-if="r.gaps" class="sv-round-gaps"><b>Gaps:</b> {{ r.gaps }}</div>
                        <div v-if="r.error" class="sv-round-error"><i class="pi pi-exclamation-triangle" /> {{ r.error }}</div>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
              <div v-if="s.child_recipe_instance_id || s.artifact_id || (stepRan(s) && stepTerminalId(s))" class="step-actions">
                <Button
                  v-if="stepRan(s) && stepTerminalId(s)"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  class="step-btn"
                  :title="s.lane ? `Open the '${s.lane}' session terminal in a side panel` : 'Open this step\'s terminal in a side panel'"
                  @click="openTerminalPanel(stepTerminalId(s)!, s.lane || 'main')"
                >
                  <i class="pi pi-microchip-ai" /> Open terminal<span v-if="s.lane" class="step-lane-chip">{{ s.lane }}</span>
                </Button>
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
      <InboxTerminalPanel
        v-if="terminalPanelOpen && terminalPanelSessionId"
        :sessionIds="[terminalPanelSessionId]"
        :sessionLabels="[terminalPanelLabel]"
        class="rd-term-side"
        @close="terminalPanelOpen = false"
      />
    </div>
  </section>

  <section v-else class="recipe-empty">
    <i class="pi pi-list-check empty-icon" />
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
  color: var(--p-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.detail-sub-id {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  font-size: 11px; color: var(--p-text-color-secondary);
  margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.progress-line, .meta-line { color: var(--p-text-color-secondary); font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; }

.rd-body-split { flex: 1; min-height: 0; min-width: 0; display: flex; }
.rd-body-split > .detail-scroll { flex: 1; min-width: 0; }
.rd-term-side {
  width: 42%; min-width: 340px; flex-shrink: 0;
  border-left: 1px solid var(--p-content-border-color, #2a2e38);
}
.action-btn.term-active { color: var(--p-primary-color, #6366f1); background: rgba(99, 102, 241, 0.14); }
.detail-scroll {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 12px 16px 32px;
  display: flex; flex-direction: column; gap: 14px;
}

.awaiting-banner { position: sticky; top: 0; z-index: 2; margin: 0; background: #2d2207; border-bottom: 1px solid #5c4a1a; }
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
.step-running .step-title { font-weight: 600; color: #4daafc; }
.step-duration { color: var(--p-text-color-secondary); font-size: 11px; }
.step-message { color: var(--p-text-color-secondary); font-size: 12px; }

/* ---- Collapsible "Agent instructions" panel beneath each step title ---- */
.step-ai-instructions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.step-ai-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  padding: 2px 0;
  color: var(--p-text-color-secondary);
  font-size: 11.5px;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.step-ai-toggle:hover { color: var(--p-text-color); }
.step-ai-toggle i { font-size: 9px; }
.step-ai-body {
  margin: 4px 0 0 14px;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 2px solid #2a2e38;
  border-radius: 0 4px 4px 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--p-text-color);
  white-space: pre-wrap;
  font-family: ui-sans-serif, system-ui, sans-serif;
  max-height: 320px;
  overflow-y: auto;
}

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
.sv-term-btn {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--p-text-muted-color, #94a3b8);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}
.sv-term-btn:hover { color: var(--p-primary-color, #6366f1); background: rgba(99, 102, 241, 0.12); }
.step-lane-chip {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 0.72em;
  background: rgba(99, 102, 241, 0.15);
  color: var(--p-primary-color, #818cf8);
}

/* -- Validation gate ------------------------------------------------------ */
.step-validation {
  margin-top: 2px;
  border: 1px solid #2a2e38;
  border-left: 3px solid #6b7280;
  border-radius: 0 6px 6px 0;
  background: rgba(255, 255, 255, 0.02);
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.step-validation.sv-progress { border-left-color: #a78bfa; background: rgba(167, 139, 250, 0.07); }
.step-validation.sv-pass { border-left-color: #4ade80; background: rgba(74, 222, 128, 0.06); }
.step-validation.sv-fail { border-left-color: #f87171; background: rgba(248, 113, 113, 0.07); }
.step-validation.sv-blocked { border-left-color: #f5c85a; background: rgba(245, 200, 90, 0.07); }
.sv-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; font-weight: 600; }
.sv-progress .sv-head i:first-child { color: #a78bfa; }
.sv-pass .sv-head i:first-child { color: #4ade80; }
.sv-fail .sv-head i:first-child { color: #f87171; }
.sv-blocked .sv-head i:first-child { color: #f5c85a; }
.sv-gated .sv-head i:first-child { color: var(--p-text-color-secondary); }
.sv-title { color: var(--p-text-color); }
.sv-mode {
  font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 10.5px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 10px;
  background: #2f3542; color: var(--p-text-color-secondary);
}
.sv-gatecount {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 1px 7px; border-radius: 10px;
  background: rgba(167, 139, 250, 0.18); color: #c4b5fd;
}
.sv-gatecount i { font-size: 9px; }
.sv-passed {
  font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 10px;
  background: rgba(167, 139, 250, 0.10); color: #a78bfa;
}
.sv-attempt-group {
  display: flex; flex-direction: column; gap: 6px;
  border-left: 2px solid rgba(167, 139, 250, 0.4); padding-left: 8px;
}
.sv-attempt-label {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #a78bfa;
}
.sv-gate-chip {
  font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 10.5px; font-weight: 700;
  padding: 1px 6px; border-radius: 10px;
  background: rgba(167, 139, 250, 0.18); color: #c4b5fd;
}
.sv-rework {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600;
  color: #f0a35e; margin-left: auto;
}
.sv-rework i { font-size: 10px; }
.sv-note { font-size: 12px; color: var(--p-text-color-secondary); font-style: italic; }
.sv-latest { font-size: 12px; color: var(--p-text-color); line-height: 1.45; white-space: pre-wrap; }
.sv-gaps { font-size: 12px; color: #f0a35e; line-height: 1.45; }
.sv-gaps b { color: #f5b877; }
.sv-toggle {
  display: inline-flex; align-items: center; gap: 5px; background: none; border: none; padding: 0;
  color: var(--p-text-color-secondary); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
}
.sv-toggle:hover { color: var(--p-text-color); }
.sv-toggle i { font-size: 9px; }
.sv-round-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.sv-round {
  border: 1px solid #2a2e38; border-left: 3px solid #6b7280; border-radius: 0 5px 5px 0;
  padding: 6px 9px; background: #1c1f27; display: flex; flex-direction: column; gap: 4px;
}
.sv-round.vr-pass { border-left-color: #4ade80; }
.sv-round.vr-fail { border-left-color: #f87171; }
.sv-round.vr-blocked { border-left-color: #f5c85a; }
.sv-round.vr-error { border-left-color: #f0a35e; }
.sv-round.vr-pending { border-left-color: #a78bfa; }
.sv-round-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sv-round-n { font-size: 11px; font-weight: 700; color: var(--p-text-color-secondary); }
.sv-verdict { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; }
.vr-pass .sv-verdict { color: #4ade80; }
.vr-fail .sv-verdict { color: #f87171; }
.vr-blocked .sv-verdict { color: #f5c85a; }
.vr-error .sv-verdict { color: #f0a35e; }
.vr-pending .sv-verdict { color: #a78bfa; }
.sv-time { font-size: 10.5px; color: var(--p-text-color-secondary); margin-left: auto; }
.sv-round-evidence { font-size: 11.5px; color: var(--p-text-color); line-height: 1.45; white-space: pre-wrap; }
.sv-round-gaps { font-size: 11.5px; color: #f0a35e; line-height: 1.4; }
.sv-round-error { font-size: 11.5px; color: #f0a35e; display: inline-flex; align-items: center; gap: 5px; }

.step-done .step-rail i { color: #4ade80; }
.step-running .step-rail i { color: #4daafc; animation: step-spin 1s linear infinite; }
.step-validating .step-rail i { color: #a78bfa; animation: step-spin 1s linear infinite; }
.step-failed .step-rail i { color: #f87171; }
.step-awaiting_user .step-rail i { color: #f5c85a; }
.step-skipped .step-rail i { color: var(--p-text-color-secondary); opacity: 0.6; }
.step-pending .step-rail i { opacity: 0.5; }

@keyframes step-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

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
/* Header action buttons (Terminal). PrimeVue's icon+label renders
 * compactly but the parent flex sometimes squeezes them; force a
 * sensible min-width so 'Terminal' / 'Terminal (reattach)' never
 * truncate. flex-shrink:0 keeps the title row from stealing pixels
 * on narrow desktops. */
.action-btn {
  min-width: 168px;
  flex-shrink: 0;
  white-space: nowrap;
}
.action-btn :deep(.p-button-label) {
  font-weight: 500;
}
.session-id {
  font-family: ui-monospace, Consolas, Menlo, monospace;
  background: rgba(77, 170, 252, 0.08);
  color: #4daafc;
  padding: 1px 6px; border-radius: 3px;
}

/* ---- Subtab strip (per-recipe) ----------------------------------------- */
.subtab-strip {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 12px 0;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  background: #16181e;
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.subtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--p-text-color-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.subtab:hover { background: #20232c; color: var(--p-text-color); }
.subtab.active {
  background: var(--p-content-background, #15171d);
  border-color: var(--p-content-border-color, #2a2e38);
  color: var(--p-text-color);
  position: relative;
  top: 1px;
}
.subtab-label {
  max-width: 220px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.subtab-close {
  font-size: 10px;
  opacity: 0.6;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
}
.subtab-close:hover { opacity: 1; background: #2a2e38; }
.subtab:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: 1px; }

/* ---- Artifact / inbox / terminal subpanes (rendered when a subtab is active) */
.artifact-subpane, .inbox-subpane, .terminal-subpane {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: var(--p-content-background, #15171d);
}
.artifact-iframe, .terminal-iframe {
  width: 100%;
  height: 100%;
  border: 0;
}
/* Terminal iframe wants a darker background to match the xterm theme
 * inside, otherwise a faint white seam shows between subtab strip and
 * the iframe before its CSS loads. */
.terminal-subpane { background: #1e1e1e; }
/* InboxDetailPanel is already a flex column, so just let it fill. */
.inbox-subpane > * { flex: 1; min-height: 0; min-width: 0; }

/* ---- Related inbox items chip list ------------------------------------ */
.related-count {
  margin-left: 4px;
  color: var(--p-text-color-secondary);
  font-weight: normal;
  font-size: 11.5px;
}
.related-inbox-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.related-inbox-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 6px;
  color: var(--p-text-color);
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
  width: 100%;
}
.related-inbox-chip:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--p-primary-color, #88c0d0);
}
.related-inbox-chip.unread {
  background: rgba(77, 170, 252, 0.06);
  border-color: rgba(77, 170, 252, 0.35);
}
.related-inbox-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.related-unread-dot {
  width: 6px; height: 6px;
  background: #4daafc;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
