<script setup lang="ts">
/**
 * InboxDetailPanel — renders the full details of one inbox item. Used
 * in two places:
 *   - master-detail right pane (desktop ≥1024px)
 *   - mobile detail view (<1024px)
 *   - popped-out tab in the main tab strip
 *
 * Both renderings share state via the Pinia store — same body cache,
 * same lifecycle store, no duplication.
 *
 * Header controls:
 *   ✓  Mark done
 *   ⏰ Snooze ▾ (preset durations + custom)
 *   📦 Archive
 *   ↺  Reopen (only when state is done/archived/snoozed)
 *   ↗  Pop out into its own tab (hidden when ALREADY in a tab).
 *   ⤢  Toggle fullscreen for this pane.
 *   ←  Back (mobile only).
 */
import { computed, ref, watch } from 'vue';
import { renderInboxBody } from '../markdown';
import { useUiStore } from '../stores/ui';
import { useFullscreen } from '../composables/useFullscreen';
import type { InboxAttachment, InboxItem, InboxQuestion, InboxReply } from '../api';

const props = defineProps<{
  itemId: string;
  /** Pane id for fullscreen coordination. */
  paneKey: string;
  /** Hide the pop-out button (we're ALREADY in a popped-out tab). */
  hidePopOut?: boolean;
  /** Show back arrow (mobile). */
  showBack?: boolean;
}>();

const emit = defineEmits<{ (e: 'back'): void }>();

const store = useUiStore();
const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(props.paneKey);

const item = computed<InboxItem | undefined>(() =>
  store.inbox.find((it) => it.id === props.itemId),
);

const bodyEntry = computed(() => store.inboxBodies[props.itemId]);
const bodyHtml = computed(() => {
  if (!item.value || !bodyEntry.value?.body) return '';
  return renderInboxBody(bodyEntry.value.body, item.value.description_format ?? 'markdown');
});

const attachments = computed<InboxAttachment[]>(() =>
  (item.value?.attachments ?? []) as InboxAttachment[],
);

const stateSeverity = computed(() => {
  switch (item.value?.state) {
    case 'done': return 'success';
    case 'open':
    case 'in_progress': return 'info';
    case 'new': return 'warn';
    case 'archived':
    case 'cancelled': return 'secondary';
    default: return 'secondary';
  }
});

const canReopen = computed(() => {
  const s = item.value?.state;
  return s === 'done' || s === 'archived' || s === 'snoozed';
});

const isActionable = computed(() => {
  // Show Done/Archive controls only when the item is still "live".
  const s = item.value?.state;
  return s === 'new' || s === 'open';
});

const pendingAction = ref<null | 'done' | 'archive' | 'snooze' | 'reopen'>(null);

async function withPending<T>(kind: 'done' | 'archive' | 'snooze' | 'reopen', fn: () => Promise<T>): Promise<T | void> {
  if (pendingAction.value) return;
  pendingAction.value = kind;
  try {
    return await fn();
  } finally {
    pendingAction.value = null;
  }
}

async function onDone(): Promise<void> {
  if (!item.value) return;
  await withPending('done', () => store.markInboxDone(item.value!.id));
}
async function onArchive(): Promise<void> {
  if (!item.value) return;
  await withPending('archive', () => store.archiveInbox(item.value!.id));
}
async function onReopen(): Promise<void> {
  if (!item.value) return;
  await withPending('reopen', () => store.reopenInbox(item.value!.id));
}

const snoozeMenu = ref();
const snoozePresets = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
  { label: 'Tomorrow 9am', tomorrow9am: true },
  { label: 'Next Monday 9am', nextMonday9am: true },
];
const snoozeItems = computed(() =>
  snoozePresets.map((p) => ({
    label: p.label,
    icon: 'pi pi-clock',
    command: () => {
      const until = computeSnoozeUntil(p);
      if (!item.value) return;
      void withPending('snooze', () => store.snoozeInbox(item.value!.id, until));
    },
  })),
);

function computeSnoozeUntil(p: typeof snoozePresets[number]): number {
  const now = new Date();
  if (p.ms) return Date.now() + p.ms;
  if (p.tomorrow9am) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (p.nextMonday9am) {
    const d = new Date(now);
    const daysUntilMonday = ((1 - d.getDay() + 7) % 7) || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() + 60 * 60 * 1000;
}

function toggleSnoozeMenu(ev: Event): void {
  snoozeMenu.value?.toggle(ev);
}

function openAttachment(att: InboxAttachment): void {
  // Open inline as a subtab inside this inbox detail panel rather than
  // as a top-level SPA tab. This keeps the user in context — they can
  // see the artifact alongside the inbox conversation and the close ×
  // returns them to the item content without losing their place.
  store.openInboxAttachmentInline(att, props.itemId);
}

// ---------------------------------------------------------------------------
// Per-inbox artifact subtabs (rendered as Tabs at the top of the panel)
// ---------------------------------------------------------------------------

const subtabState = computed(() =>
  store.inboxArtifactSubtabs[props.itemId] ?? { tabs: [], active: null as string | null },
);
const activeSubtab = computed<string | null>(() => subtabState.value.active);
const artifactSubtabs = computed(() => subtabState.value.tabs);

function selectContentSubtab(): void {
  store.setActiveInboxSubtab(props.itemId, null);
}
function selectArtifactSubtab(artifactId: string): void {
  store.setActiveInboxSubtab(props.itemId, artifactId);
}
function closeArtifactSubtab(artifactId: string, ev?: Event): void {
  ev?.stopPropagation();
  store.closeInboxArtifactSubtab(props.itemId, artifactId);
}

// ---------------------------------------------------------------------------
// Question + reply chain (multi-question batch UX)
// ---------------------------------------------------------------------------

const replies = computed<InboxReply[]>(() => item.value?.replies ?? []);

/**
 * Find the active question batch — what the user should answer next.
 * Walks replies newest-first looking for an agent-authored reply with
 * unanswered `questions: [...]`. Falls back to item-level `questions[]`.
 * Mirrors the server's `findActiveQuestionBatch` in cli/start.ts.
 */
interface ActiveBatch {
  source: 'item' | 'reply';
  reply_id?: string;
  questions: InboxQuestion[];
}
const activeBatch = computed<ActiveBatch | null>(() => {
  const it = item.value;
  if (!it) return null;
  const rs = replies.value;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (r.author === 'agent' && Array.isArray(r.questions) && r.questions.length > 0) {
      if (r.questions.some((q) => q.closed !== true)) {
        return { source: 'reply', reply_id: r.id, questions: r.questions };
      }
    }
  }
  const itemQs = Array.isArray(it.questions) ? it.questions : [];
  if (itemQs.length > 0 && itemQs.some((q) => q.closed !== true)) {
    return { source: 'item', questions: itemQs };
  }
  // All closed? Surface the most recent batch (closed) for display.
  if (itemQs.length > 0) return { source: 'item', questions: itemQs };
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if (r.author === 'agent' && Array.isArray(r.questions) && r.questions.length > 0) {
      return { source: 'reply', reply_id: r.id, questions: r.questions };
    }
  }
  return null;
});

const activeQuestions = computed<InboxQuestion[]>(() => activeBatch.value?.questions ?? []);
const allClosed = computed(() =>
  activeQuestions.value.length > 0 && activeQuestions.value.every((q) => q.closed === true),
);

function modeFor(q: InboxQuestion): 'single' | 'multi' | 'text' {
  if (q.mode) return q.mode;
  return q.options && q.options.length > 0 ? 'single' : 'text';
}
function allowFreeformFor(q: InboxQuestion): boolean {
  return q.allow_freeform === true || modeFor(q) === 'text';
}

// Per-question selection state, keyed by question_id.
// Reset whenever the item or active batch changes.
const perQuestionOptionIds = ref<Record<string, string[]>>({});
const perQuestionText = ref<Record<string, string>>({});
const submitting = ref(false);
const submitError = ref<string | null>(null);

function resetForm() {
  perQuestionOptionIds.value = {};
  perQuestionText.value = {};
  submitError.value = null;
  currentQuestionIdx.value = 0;
}

// Wizard navigation: show one question at a time.
const currentQuestionIdx = ref(0);
const currentQuestion = computed<InboxQuestion | null>(
  () => activeQuestions.value[currentQuestionIdx.value] ?? null,
);
const totalQuestions = computed(() => activeQuestions.value.length);
const isLastQuestion = computed(
  () => currentQuestionIdx.value >= totalQuestions.value - 1,
);
const isFirstQuestion = computed(() => currentQuestionIdx.value <= 0);
const currentQuestionIsAnswered = computed(() =>
  currentQuestion.value ? questionAnswered(currentQuestion.value) : false,
);
const wizardProgressPct = computed(() => {
  if (totalQuestions.value === 0) return 0;
  // After the last answer, fill all the way.
  return Math.round(((currentQuestionIdx.value + 1) / totalQuestions.value) * 100);
});
function goNextQuestion(): void {
  if (isLastQuestion.value) return;
  currentQuestionIdx.value = Math.min(
    currentQuestionIdx.value + 1,
    totalQuestions.value - 1,
  );
}
function goPrevQuestion(): void {
  if (isFirstQuestion.value) return;
  currentQuestionIdx.value = Math.max(currentQuestionIdx.value - 1, 0);
}
function jumpToQuestion(idx: number): void {
  if (idx < 0 || idx >= totalQuestions.value) return;
  currentQuestionIdx.value = idx;
}

watch(() => props.itemId, resetForm);
watch(
  () => activeBatch.value?.reply_id ?? activeBatch.value?.source ?? null,
  resetForm,
);

// Auto-mark item read when the detail panel opens for an unread item.
// Idempotent — only fires when unread, and the store helper short-circuits
// if already read. Triggers on initial mount + on every props.itemId change
// (user clicks a different inbox item).
watch(
  () => props.itemId,
  (id) => {
    if (!id) return;
    // Item may not be loaded yet when itemId changes — re-check on next
    // tick by reading the latest item.value.
    queueMicrotask(() => {
      const cur = store.inbox.find((it) => it.id === id);
      if (cur?.unread === true) {
        void store.markInboxItemRead(id);
      }
    });
  },
  { immediate: true },
);

function toggleOption(qid: string, optId: string): void {
  if (allClosed.value) return;
  const q = activeQuestions.value.find((x) => x.id === qid);
  if (!q) return;
  const mode = modeFor(q);
  const current = perQuestionOptionIds.value[qid] ?? [];
  if (mode === 'single') {
    perQuestionOptionIds.value = { ...perQuestionOptionIds.value, [qid]: [optId] };
  } else if (mode === 'multi') {
    const set = new Set(current);
    if (set.has(optId)) set.delete(optId);
    else set.add(optId);
    perQuestionOptionIds.value = { ...perQuestionOptionIds.value, [qid]: [...set] };
  }
}

// ---------------------------------------------------------------------------
// Always-on freeform reply (works even when no questions are configured,
// as long as the item has a dispatch.session_id somewhere). Coexists with
// the structured question form.
// ---------------------------------------------------------------------------

const freeformReplyText = ref('');
const freeformSubmitting = ref(false);
const freeformError = ref<string | null>(null);

watch(() => props.itemId, () => {
  freeformReplyText.value = '';
  freeformError.value = null;
});

/** True if the item has ANY dispatch config (item-level or question-level). */
const hasAnyDispatch = computed(() => {
  const it = item.value;
  if (!it) return false;
  const itemDispatch = (it as unknown as { dispatch?: { session_id?: string } }).dispatch;
  if (itemDispatch?.session_id) return true;
  const itemQs = Array.isArray(it.questions) ? it.questions : [];
  if (itemQs.some((q) => q.dispatch?.session_id)) return true;
  for (const r of replies.value) {
    if (Array.isArray(r.questions) && r.questions.some((q) => q.dispatch?.session_id)) return true;
  }
  return false;
});

const showFreeformReply = computed(() => hasAnyDispatch.value);

const canSendFreeform = computed(() =>
  !freeformSubmitting.value && freeformReplyText.value.trim().length > 0,
);

async function onSubmitFreeform(): Promise<void> {
  if (!canSendFreeform.value || !item.value) return;
  freeformSubmitting.value = true;
  freeformError.value = null;
  try {
    await store.submitInboxReply(item.value.id, {
      text: freeformReplyText.value.trim(),
    });
    freeformReplyText.value = '';
  } catch (err) {
    freeformError.value = err instanceof Error ? err.message : String(err);
  } finally {
    freeformSubmitting.value = false;
  }
}

function setText(qid: string, value: string): void {
  perQuestionText.value = { ...perQuestionText.value, [qid]: value };
}

function isOptionSelected(qid: string, optId: string): boolean {
  return (perQuestionOptionIds.value[qid] ?? []).includes(optId);
}

function questionAnswered(q: InboxQuestion): boolean {
  const mode = modeFor(q);
  const sel = perQuestionOptionIds.value[q.id] ?? [];
  const text = (perQuestionText.value[q.id] ?? '').trim();
  if (mode === 'text') return text.length > 0;
  if (mode === 'single') return sel.length === 1 || (allowFreeformFor(q) && text.length > 0);
  if (mode === 'multi') return sel.length > 0 || (allowFreeformFor(q) && text.length > 0);
  return false;
}

const canSubmit = computed(() => {
  if (allClosed.value || submitting.value) return false;
  const qs = activeQuestions.value;
  if (qs.length === 0) return false;
  return qs.every(questionAnswered);
});

const unansweredCount = computed(() =>
  activeQuestions.value.filter((q) => q.closed !== true && !questionAnswered(q)).length,
);

// Render a question prompt as inline-only markdown (bold, italic, code,
// links). We strip block-level structure so a prompt can never produce
// h1/h2 or unexpected paragraphs that would break the wizard header layout.
function renderPrompt(text: string): string {
  if (!text) return '';
  const html = renderInboxBody(text, 'markdown');
  // Strip wrapping <p>…</p> from a single paragraph so the prompt stays
  // inline; multi-paragraph prompts keep their breaks.
  return html.replace(/^\s*<p>/, '').replace(/<\/p>\s*$/, '');
}

async function onSubmitReply(): Promise<void> {
  if (!canSubmit.value || !item.value) return;
  submitting.value = true;
  submitError.value = null;
  try {
    const answers = activeQuestions.value.map((q) => ({
      question_id: q.id,
      option_ids: (perQuestionOptionIds.value[q.id] ?? []).length > 0
        ? perQuestionOptionIds.value[q.id]
        : undefined,
      text: (perQuestionText.value[q.id] ?? '').trim() || undefined,
    }));
    await store.submitInboxReply(item.value.id, { answers });
    resetForm();
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

function formatReplyTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dispatchBadge(r: InboxReply): { label: string; severity: 'success' | 'warn' | 'info' | 'secondary' } | null {
  const d = r.dispatch;
  if (!d) return null;
  if (d.mode === 'failed') return { label: `dispatch failed: ${d.code ?? d.error ?? 'error'}`, severity: 'warn' };
  if (d.mode === 'noop') return { label: 'no dispatch', severity: 'secondary' };
  return { label: `→ ${d.mode}`, severity: 'success' };
}

function openReplyAttachment(att: InboxAttachment): void {
  openAttachment(att);
}

function popOut(): void {
  if (!item.value) return;
  store.popOutInbox(item.value.id, item.value.title);
}

function onMarkRead(): void {
  if (!item.value) return;
  void store.markInboxItemRead(item.value.id);
}

function jumpToRecipe(): void { store.setActiveTab('recipes'); }
function jumpToTrigger(): void { store.setActiveTab('triggers'); }

function formatTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}
function formatSnoozeUntil(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
</script>

<template>
  <section v-if="item" class="detail-panel" :class="{ 'fs-pane': isFullscreen }">
    <header class="detail-head">
      <!-- Row 1 (desktop) / Row 1 of 2 (mobile): back + title + meta -->
      <div class="title-row">
        <Button
          v-if="showBack"
          icon="pi pi-arrow-left"
          text
          rounded
          size="small"
          aria-label="Back to inbox list"
          class="head-btn"
          @click="emit('back')"
        />
        <div class="head-text">
          <h1 class="detail-title" :title="item.title || item.id">{{ item.title || item.id }}</h1>
          <div class="detail-meta">
            <Tag :severity="stateSeverity" :value="item.state" />
            <Tag
              v-for="label in (item.labels ?? [])"
              :key="label"
              class="label-chip"
              severity="secondary"
              :value="label"
            />
            <span v-if="item.state === 'snoozed' && item.snoozed_until" class="snooze-line">
              <i class="pi pi-clock" /> until {{ formatSnoozeUntil(item.snoozed_until) }}
            </span>
            <span class="meta-line">
              {{ item.source || 'manual' }} · {{ item.kind || 'unknown' }} · {{ formatTime(item.updated_at) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Row 2 (mobile) / right side of row 1 (desktop): action buttons -->
      <div class="head-actions">
        <Button
          v-if="isActionable"
          icon="pi pi-check"
          severity="success"
          size="small"
          rounded
          :loading="pendingAction === 'done'"
          aria-label="Mark as done"
          title="Mark as done"
          class="action-btn"
          @click="onDone"
        />
        <Button
          v-if="isActionable"
          icon="pi pi-clock"
          severity="secondary"
          size="small"
          rounded
          :loading="pendingAction === 'snooze'"
          aria-label="Snooze"
          aria-haspopup="true"
          title="Snooze for…"
          class="action-btn"
          @click="toggleSnoozeMenu"
        />
        <Menu ref="snoozeMenu" :model="snoozeItems" popup />
        <Button
          v-if="item.state !== 'archived'"
          icon="pi pi-inbox"
          severity="secondary"
          size="small"
          rounded
          :loading="pendingAction === 'archive'"
          aria-label="Archive"
          title="Archive"
          class="action-btn"
          @click="onArchive"
        />
        <Button
          v-if="canReopen"
          icon="pi pi-refresh"
          severity="info"
          size="small"
          rounded
          :loading="pendingAction === 'reopen'"
          aria-label="Reopen"
          title="Reopen"
          class="action-btn"
          @click="onReopen"
        />

        <span class="action-divider" />

        <Button
          v-if="item.unread === true"
          icon="pi pi-eye"
          text
          rounded
          size="small"
          aria-label="Mark as read"
          title="Mark as read"
          class="head-btn"
          @click="onMarkRead"
        />
        <Button
          v-if="!hidePopOut"
          icon="pi pi-external-link"
          text
          rounded
          size="small"
          aria-label="Open as separate tab"
          title="Open as separate tab"
          class="head-btn"
          @click="popOut"
        />
        <Button
          :icon="isFullscreen ? 'pi pi-window-minimize' : 'pi pi-window-maximize'"
          text
          rounded
          size="small"
          :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
          :title="isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'"
          class="head-btn"
          @click="toggleFullscreen"
        />
      </div>
    </header>

    <!-- Per-inbox artifact subtabs: renders ONLY when at least one artifact
         has been opened from this item. The "Item" subtab shows the
         inbox content (description + question form + reply chain + freeform
         reply box); each artifact subtab embeds the artifact iframe inline,
         preserving inbox context. Close × on each artifact tab returns to
         the Item subtab. -->
    <div v-if="artifactSubtabs.length > 0" class="subtab-strip" role="tablist" aria-label="Inbox item views">
      <button
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: activeSubtab === null }"
        :aria-selected="activeSubtab === null"
        @click="selectContentSubtab"
      >
        <i class="pi pi-envelope" />
        <span>Item</span>
      </button>
      <button
        v-for="tab in artifactSubtabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: activeSubtab === tab.id }"
        :aria-selected="activeSubtab === tab.id"
        :title="tab.title || tab.id"
        @click="selectArtifactSubtab(tab.id)"
      >
        <i class="pi pi-paperclip" />
        <span class="subtab-label">{{ tab.title || tab.id }}</span>
        <i
          class="pi pi-times subtab-close"
          role="button"
          tabindex="0"
          aria-label="Close artifact tab"
          :title="`Close ${tab.title || tab.id}`"
          @click="closeArtifactSubtab(tab.id, $event)"
        />
      </button>
    </div>

    <!-- Artifact subtab content: when an artifact subtab is active, render
         the artifact iframe instead of the inbox content. The iframe is
         sandboxed identically to the top-level ArtifactPanel for safety. -->
    <div
      v-if="activeSubtab !== null"
      v-for="tab in artifactSubtabs.filter((t) => t.id === activeSubtab)"
      :key="`art-${tab.id}`"
      class="artifact-subpane"
    >
      <iframe
        :src="tab.url"
        :title="tab.title || tab.id"
        sandbox="allow-scripts allow-same-origin allow-forms"
        class="artifact-iframe"
        loading="lazy"
      />
    </div>

    <div v-else class="detail-scroll">
      <div v-if="item.preview" class="detail-preview">{{ item.preview }}</div>

      <div v-if="(item.description_size ?? 0) > 0" class="detail-body-section">
        <div v-if="bodyEntry?.loading" class="muted">Loading body…</div>
        <div v-else-if="bodyEntry?.error" class="error">
          Failed to load body: {{ bodyEntry.error }}
        </div>
        <div v-else class="markdown-body" v-html="bodyHtml" />
      </div>
      <div v-else-if="activeQuestions.length === 0 && !hasAnyDispatch" class="muted no-body">No body. {{ item.preview ? '' : 'Inbox item is metadata-only.' }}</div>

      <!-- Reply chain (always rendered when replies exist) -->
      <div v-if="replies.length > 0" class="reply-chain">
        <div
          v-for="r in replies"
          :key="r.id"
          class="reply-bubble"
          :class="{ 'reply-user': r.author === 'user', 'reply-agent': r.author === 'agent' }"
        >
          <div class="reply-head">
            <span class="reply-author">{{ r.author === 'user' ? 'You' : 'Agent' }}</span>
            <span class="reply-time">{{ formatReplyTime(r.created_at) }}</span>
            <Tag
              v-if="dispatchBadge(r)"
              :severity="dispatchBadge(r)!.severity"
              :value="dispatchBadge(r)!.label"
              class="reply-badge"
            />
          </div>
          <div class="reply-text">{{ r.text }}</div>
          <div v-if="(r.attachments?.length ?? 0) > 0" class="reply-attachments">
            <Button
              v-for="att in (r.attachments ?? [])"
              :key="att.artifact_id"
              class="reply-att-btn"
              size="small"
              severity="secondary"
              :outlined="true"
              :disabled="!att.view_url"
              :title="att.view_url ? `Open ${att.artifact_id}` : `Artifact ${att.artifact_id} not found`"
              @click="openReplyAttachment(att)"
            >
              <i class="pi pi-paperclip" />
              <span class="att-title">{{ att.title || att.artifact_id }}</span>
            </Button>
          </div>
        </div>
      </div>

      <!-- Active question batch (item-level or latest agent-reply) — wizard UI -->
      <!-- All-closed batches collapse to a single muted "answered" pill;
           we don't show the full wizard chrome when nothing is actionable. -->
      <div v-if="activeQuestions.length > 0 && allClosed" class="qz-closed-summary muted small">
        <i class="pi pi-check-circle" />
        {{ activeQuestions.length === 1
          ? 'Question answered.'
          : `All ${activeQuestions.length} questions answered.` }}
      </div>
      <div v-else-if="activeQuestions.length > 0" class="question-section">
        <!-- Header: progress + step counter + jump dots -->
        <div class="qz-header">
          <div class="qz-progress-row">
            <div class="qz-step-label">
                <span class="qz-step-counter">
                  Question {{ currentQuestionIdx + 1 }}
                  <span class="qz-step-of">of {{ totalQuestions }}</span>
                </span>
                <span v-if="unansweredCount > 0" class="qz-step-remaining muted small">
                  · {{ unansweredCount }} unanswered
                </span>
            </div>
            <div v-if="totalQuestions > 1" class="qz-dots">
                <button
                  v-for="(q, idx) in activeQuestions"
                  :key="q.id"
                  type="button"
                  class="qz-dot"
                  :class="{
                    'qz-dot-current': idx === currentQuestionIdx,
                    'qz-dot-done': questionAnswered(q),
                  }"
                  :title="`Question ${idx + 1}${questionAnswered(q) ? ' (answered)' : ''}`"
                  :aria-label="`Jump to question ${idx + 1}`"
                  @click="jumpToQuestion(idx)"
                />
            </div>
          </div>
          <div class="qz-progress-bar" role="progressbar" :aria-valuenow="wizardProgressPct" aria-valuemin="0" aria-valuemax="100">
            <div class="qz-progress-fill" :style="{ width: wizardProgressPct + '%' }" />
          </div>
        </div>

        <!-- Body: ONE question, options stacked vertically -->
        <div v-if="currentQuestion" class="qz-body">
          <div v-if="currentQuestion.title" class="qz-title">{{ currentQuestion.title }}</div>
          <div class="qz-prompt" v-html="renderPrompt(currentQuestion.prompt)" />

          <div v-if="!allClosed" class="qz-form">
            <div
                v-if="(currentQuestion.options?.length ?? 0) > 0"
                class="qz-options"
                role="group"
                :aria-label="modeFor(currentQuestion) === 'single' ? 'Pick one option' : 'Pick one or more options'"
            >
                <button
                  v-for="opt in (currentQuestion.options ?? [])"
                  :key="opt.id"
                  type="button"
                  class="qz-option-row"
                  :class="{ 'qz-option-selected': isOptionSelected(currentQuestion.id, opt.id) }"
                  :aria-pressed="isOptionSelected(currentQuestion.id, opt.id)"
                  :disabled="submitting"
                  @click="toggleOption(currentQuestion.id, opt.id)"
                >
                  <span
                    class="qz-option-indicator"
                    :class="{
                      'qz-indicator-radio': modeFor(currentQuestion) === 'single',
                      'qz-indicator-checkbox': modeFor(currentQuestion) === 'multi',
                    }"
                    aria-hidden="true"
                  >
                    <i
                      v-if="isOptionSelected(currentQuestion.id, opt.id)"
                      :class="modeFor(currentQuestion) === 'single' ? 'pi pi-circle-fill' : 'pi pi-check'"
                    />
                  </span>
                  <span class="qz-option-label">{{ opt.label }}</span>
                </button>
            </div>

            <div v-if="allowFreeformFor(currentQuestion)" class="qz-freeform-wrap">
                <label class="qz-freeform-label muted small">
                  {{ (currentQuestion.options?.length ?? 0) > 0 ? 'Or type a custom answer:' : 'Your answer:' }}
                </label>
                <Textarea
                  :model-value="perQuestionText[currentQuestion.id] ?? ''"
                  class="qz-freeform-input"
                  :placeholder="currentQuestion.placeholder ?? 'Type your answer…'"
                  :rows="3"
                  autoResize
                  :disabled="submitting"
                  @update:model-value="setText(currentQuestion.id, $event)"
                />
            </div>
          </div>
        </div>

        <!-- Sticky footer: Back / Next or Send -->
        <div v-if="!allClosed" class="qz-footer">
          <div v-if="submitError" class="question-error qz-error">
            <i class="pi pi-exclamation-triangle" /> {{ submitError }}
          </div>
          <div class="qz-footer-row">
            <Button
                icon="pi pi-arrow-left"
                label="Back"
                size="small"
                severity="secondary"
                text
                :disabled="isFirstQuestion || submitting"
                @click="goPrevQuestion"
            />
            <div class="qz-footer-spacer" />
            <Button
                v-if="!isLastQuestion"
                icon="pi pi-arrow-right"
                iconPos="right"
                label="Next"
                size="small"
                severity="secondary"
                :disabled="!currentQuestionIsAnswered || submitting"
                @click="goNextQuestion"
            />
            <Button
                v-else
                icon="pi pi-send"
                label="Send all answers"
                size="small"
                severity="info"
                :loading="submitting"
                :disabled="!canSubmit"
                @click="onSubmitReply"
            />
          </div>
        </div>
      </div>

      <!-- Always-on freeform reply box (when item has any dispatch config) -->
      <div v-if="showFreeformReply" class="freeform-reply">
        <div class="freeform-label">
          <i class="pi pi-comment" />
          {{ activeQuestions.length > 0 ? 'Or send a freeform message:' : 'Send a message to the agent:' }}
        </div>
        <Textarea
          v-model="freeformReplyText"
          class="freeform-text"
          placeholder="Type your message…"
          :rows="4"
          autoResize
          :disabled="freeformSubmitting"
          @keydown.enter.exact.prevent="onSubmitFreeform"
        />
        <div v-if="freeformError" class="question-error">
          <i class="pi pi-exclamation-triangle" /> {{ freeformError }}
        </div>
        <div class="question-actions freeform-actions">
          <span class="muted small">Press Enter or click Send. The agent will receive it as a new prompt.</span>
          <Button
            icon="pi pi-send"
            label="Send"
            size="small"
            severity="info"
            :loading="freeformSubmitting"
            :disabled="!canSendFreeform"
            @click="onSubmitFreeform"
          />
        </div>
      </div>

      <div v-if="attachments.length > 0" class="detail-section">
        <div class="detail-section-head">
          <i class="pi pi-paperclip" /> Attachments ({{ attachments.length }})
        </div>
        <div class="attachment-grid">
          <Button
            v-for="att in attachments"
            :key="att.artifact_id"
            class="attachment-btn"
            size="small"
            severity="secondary"
            :outlined="true"
            :disabled="!att.view_url"
            :title="att.view_url ? `Open ${att.artifact_id}` : `Artifact ${att.artifact_id} not found in any workspace`"
            @click="openAttachment(att)"
          >
            <i class="pi pi-external-link" />
            <span class="att-title">{{ att.title || att.artifact_id }}</span>
            <span v-if="att.type" class="att-type">{{ att.type }}</span>
          </Button>
        </div>
      </div>

      <div v-if="item.recipe_instance?.id || item.trigger_id" class="detail-section">
        <div class="detail-section-head"><i class="pi pi-link" /> Linked</div>
        <div class="link-row">
          <Button
            v-if="item.recipe_instance?.id"
            class="link-chip"
            size="small"
            severity="info"
            :outlined="true"
            @click="jumpToRecipe"
          >
            <i class="pi pi-cog" />
            Recipe <code>{{ item.recipe_instance.id }}</code>
            <span v-if="item.recipe_instance.resolved === false" class="att-type">(missing)</span>
          </Button>
          <Button
            v-if="item.trigger_id"
            class="link-chip"
            size="small"
            severity="info"
            :outlined="true"
            @click="jumpToTrigger"
          >
            <i class="pi pi-bolt" />
            Trigger <code>{{ item.trigger_id }}</code>
          </Button>
        </div>
      </div>
    </div>
  </section>

  <section v-else class="detail-empty">
    <i class="pi pi-inbox empty-icon" />
    <div class="empty-text">Item not found.</div>
  </section>
</template>

<style scoped>
.detail-panel {
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
.title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.head-text { flex: 1; min-width: 0; }
.head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.head-btn, .action-btn { width: 30px; height: 30px; padding: 0; flex-shrink: 0; }
.action-divider { width: 1px; height: 22px; background: var(--p-content-border-color, #2a2e38); margin: 0 2px; }

/* Desktop ≥640px: title row + action buttons share a single horizontal
   row. Title still gets the lion's share thanks to flex: 1 on .head-text. */
@media (min-width: 640px) {
  .detail-head {
    flex-direction: row;
    align-items: flex-start;
    padding: 12px 16px;
    gap: 12px;
  }
  .title-row { flex: 1; min-width: 0; }
  .head-actions { flex-shrink: 0; }
}

.detail-title {
  font-size: 16px;
  margin: 0;
  color: var(--p-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.meta-line { color: var(--p-text-color-secondary); font-size: 11.5px; }
.snooze-line { color: var(--p-text-color-secondary); font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; }
.label-chip { font-size: 11px; }

.detail-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Reorder children so the question wizard + freeform composer appear
 * directly under the preview, BEFORE the long markdown description.
 * The action should be visible without scrolling; the description is
 * reference material that can live below the fold. */
.detail-scroll > .detail-preview     { order: 1; }
.detail-scroll > .question-section   { order: 2; }
.detail-scroll > .qz-closed-summary  { order: 2; }
.detail-scroll > .freeform-reply     { order: 3; }
.detail-scroll > .detail-body-section { order: 4; }
.detail-scroll > .no-body            { order: 4; }
.detail-scroll > .reply-chain        { order: 5; }
.detail-scroll > .detail-section     { order: 6; }

/* ---- Artifact subtab strip (per-inbox) ----------------------------------- */
.subtab-strip {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 6px 8px 0 8px;
  background: #181a21;
  border-bottom: 1px solid #2a2e38;
  overflow-x: auto;
  flex-shrink: 0;
}
.subtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  color: var(--p-text-color-secondary);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  max-width: 240px;
  font: inherit;
}
.subtab:hover { background: #20232c; color: var(--p-text-color); }
.subtab.active {
  background: var(--p-content-background);
  border-color: #2a2e38;
  color: var(--p-text-color);
  position: relative;
  top: 1px;
}
.subtab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
.subtab-close {
  font-size: 10px;
  padding: 2px;
  margin-left: 2px;
  border-radius: 3px;
  opacity: 0.6;
}
.subtab-close:hover { opacity: 1; background: #2a2e38; }
.subtab:focus-visible { outline: 2px solid var(--p-primary-color, #88c0d0); outline-offset: 1px; }

/* ---- Artifact subpane (renders iframe inline when an artifact tab is active) */
.artifact-subpane {
  flex: 1;
  min-height: 0;
  display: flex;
}
.artifact-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--p-content-background);
}

.detail-preview { color: var(--p-text-color); font-size: 14px; font-style: italic; line-height: 1.5; }
.detail-body-section { font-size: 14px; line-height: 1.6; }
.muted { color: var(--p-text-color-secondary); font-style: italic; }
.error { color: #f59e9e; }
.no-body { padding: 6px 0; }

.detail-section { display: flex; flex-direction: column; gap: 8px; }
.detail-section-head {
  color: var(--p-text-color-secondary);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: flex; align-items: center; gap: 6px;
}
.attachment-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.attachment-btn { justify-content: flex-start; }
.att-title { font-weight: 500; }
.att-type { color: var(--p-text-color-secondary); font-size: 11px; margin-left: 6px; }
.link-row { display: flex; flex-wrap: wrap; gap: 8px; }
.link-chip code { font-size: 11px; opacity: 0.9; }

.detail-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--p-text-color-secondary);
  gap: 8px;
}
.empty-icon { font-size: 28px; opacity: 0.4; }
.empty-text { font-size: 13px; }

/* Markdown styling — scoped under the detail body. */
.markdown-body { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.markdown-body :deep(*) { max-width: 100%; }
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3) {
  color: #fff; border-bottom: 1px solid #3e3e42; padding-bottom: 4px; margin-top: 1.2em;
}
.markdown-body :deep(h1) { font-size: 1.5em; }
.markdown-body :deep(h2) { font-size: 1.25em; }
.markdown-body :deep(h3) { font-size: 1.05em; border-bottom: 0; }
.markdown-body :deep(p) { margin: 0.6em 0; }
.markdown-body :deep(a) { color: #4daafc; word-break: break-all; overflow-wrap: anywhere; }
.markdown-body :deep(code) { background: #0f1115; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
.markdown-body :deep(pre) {
  background: #0f1115; padding: 10px 12px; border-radius: 4px;
  max-width: 100%; overflow-x: auto;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
.markdown-body :deep(pre code) { background: transparent; padding: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.markdown-body :deep(code) { word-break: break-word; }
.markdown-body :deep(blockquote) { border-left: 3px solid #3e3e42; padding-left: 12px; color: var(--p-text-color-secondary); margin: 0.6em 0; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 1.2em; margin: 0.5em 0; }
.markdown-body :deep(li) { margin: 0.15em 0; }
.markdown-body :deep(table) { border-collapse: collapse; margin: 0.6em 0; display: block; max-width: 100%; overflow-x: auto; }
.markdown-body :deep(th), .markdown-body :deep(td) { border: 1px solid #3e3e42; padding: 5px 9px; }
.markdown-body :deep(img) { max-width: 100%; height: auto; }
.markdown-body :deep(.inbox-body-pre) {
  background: #0f1115; padding: 10px 12px; border-radius: 4px;
  overflow-x: auto; white-space: pre-wrap;
}

/* ─── Question + reply chain ──────────────────────────────────────────── */
/* ============================================================ */
/* Wizard-style question UI: one question at a time, vertical    */
/* option rows with radio/checkbox affordance, sticky footer.    */
/* ============================================================ */
.question-section {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 10px;
  background: rgba(74, 138, 232, 0.04);
  overflow: hidden;
  /* As a flex item in .detail-scroll (column flex), prevent shrinking
   * below the wizard's own content height — otherwise the section
   * collapses to its border (~2px) and the children overflow. */
  flex-shrink: 0;
}

.qz-header {
  padding: 14px 18px 12px;
  background: rgba(74, 138, 232, 0.06);
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qz-progress-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.qz-step-label {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  flex-wrap: wrap;
}
.qz-step-counter {
  font-size: 13px;
  font-weight: 600;
  color: var(--p-text-color);
}
.qz-step-of {
  font-size: 12px;
  font-weight: 400;
  color: var(--p-text-color-secondary);
  margin-left: 2px;
}
.qz-step-remaining { font-size: 11px; }

.qz-dots {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.qz-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  background: transparent;
  padding: 0;
  cursor: pointer;
  transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
}
.qz-dot:hover { transform: scale(1.2); border-color: #4a8ae8; }
.qz-dot-done {
  background: #4ade80;
  border-color: #4ade80;
}
.qz-dot-current {
  background: #4a8ae8;
  border-color: #4a8ae8;
  transform: scale(1.3);
  box-shadow: 0 0 0 2px rgba(74, 138, 232, 0.25);
}

.qz-progress-bar {
  height: 3px;
  width: 100%;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  overflow: hidden;
}
.qz-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4a8ae8 0%, #4ade80 100%);
  transition: width 240ms ease;
}

.qz-body {
  padding: 18px 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.qz-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--p-text-color-secondary);
  opacity: 0.85;
}
.qz-prompt {
  font-size: 16px;
  font-weight: 600;
  color: var(--p-text-color);
  line-height: 1.4;
  white-space: pre-wrap;
}
.qz-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 4px;
}

.qz-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qz-option-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 8px;
  color: var(--p-text-color);
  font-family: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
}
.qz-option-row:hover:not(:disabled) {
  background: rgba(74, 138, 232, 0.08);
  border-color: rgba(74, 138, 232, 0.45);
}
.qz-option-row:active:not(:disabled) {
  transform: scale(0.995);
}
.qz-option-row:focus-visible {
  outline: 2px solid #4a8ae8;
  outline-offset: 2px;
}
.qz-option-row:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.qz-option-selected {
  background: rgba(74, 138, 232, 0.14) !important;
  border-color: #4a8ae8 !important;
  box-shadow: inset 0 0 0 1px rgba(74, 138, 232, 0.5);
}
.qz-option-indicator {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--p-text-color-secondary);
  background: transparent;
  color: #fff;
}
.qz-indicator-radio { border-radius: 50%; }
.qz-indicator-checkbox { border-radius: 4px; }
.qz-option-selected .qz-option-indicator {
  border-color: #4a8ae8;
  background: #4a8ae8;
}
.qz-option-indicator i {
  font-size: 10px;
  line-height: 1;
}
.qz-indicator-radio i.pi-circle-fill { font-size: 8px; }
.qz-option-label {
  flex: 1;
  line-height: 1.4;
  word-break: break-word;
}

.qz-freeform-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}
.qz-freeform-label {
  font-size: 12px;
  color: var(--p-text-color-secondary);
}
.qz-freeform-input {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  min-height: 80px;
}

.qz-footer {
  padding: 12px 18px 14px;
  background: rgba(74, 138, 232, 0.06);
  border-top: 1px solid var(--p-content-border-color, #2a2e38);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qz-footer-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qz-footer-spacer { flex: 1; }
.qz-footer .p-button { min-width: 90px; }
.qz-error {
  font-size: 12px;
}
.qz-closed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 12px 18px;
}
.qz-closed i { color: #4ade80; }

.qz-closed-summary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px dashed var(--p-content-border-color, #2a2e38);
  border-radius: 8px;
  background: rgba(74, 222, 128, 0.04);
  align-self: flex-start;
  flex-shrink: 0;
}
.qz-closed-summary i {
  color: #4ade80;
  font-size: 14px;
}

/* Legacy classes (kept for question.error usage in freeform-reply) */
.question-error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f59e9e;
  font-size: 12px;
}
.question-error i { font-size: 12px; }

/* ============================================================ */
/* Freeform reply composer (the "Send a message to the agent")   */
/* ============================================================ */
.freeform-reply {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px 14px;
  margin-top: 12px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  flex-shrink: 0;
}
.freeform-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--p-text-color);
}
.freeform-label i {
  color: var(--p-text-color-secondary);
  font-size: 15px;
}
.freeform-text {
  width: 100%;
  font-family: inherit;
  font-size: 14px;
  min-height: 100px;
}
.freeform-reply .question-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.freeform-reply .question-actions .small { font-size: 12px; }
.freeform-reply .question-actions .p-button {
  min-width: 110px;
}

.reply-chain {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.reply-bubble {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.45;
}
.reply-bubble.reply-user {
  background: rgba(74, 138, 232, 0.10);
  border: 1px solid rgba(74, 138, 232, 0.30);
  align-self: stretch;
}
.reply-bubble.reply-agent {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--p-content-border-color, #2a2e38);
  align-self: stretch;
}
.reply-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--p-text-color-secondary);
}
.reply-author { font-weight: 600; color: var(--p-text-color); }
.reply-time { opacity: 0.7; }
.reply-badge { font-size: 10px; margin-left: auto; }
.reply-text {
  color: var(--p-text-color);
  white-space: pre-wrap;
  word-wrap: break-word;
}
.reply-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.reply-att-btn { font-size: 11px; }
</style>
