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
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { renderInboxBody } from '../markdown';
import { useUiStore } from '../stores/ui';
import { useFullscreen } from '../composables/useFullscreen';
import type { InboxAttachment, InboxItem, InboxQuestion, InboxReply } from '../api';
import InboxTerminalPanel from './InboxTerminalPanel.vue';

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

const replies = computed<InboxReply[]>(() => item.value?.replies ?? []);

const terminalPanelOpen = ref(false);
// Extra session IDs discovered from reply dispatches (not in item.agent_session_id)
const dispatchedSessionIds = ref<string[]>([]);

// Reset dispatched sessions when item changes
watch(() => props.itemId, () => {
  dispatchedSessionIds.value = [];
});

const linkedSessionIds = computed<string[]>(() => {
  const it = item.value;
  if (!it) return [];
  const ids: string[] = [];
  const terminals = (store.terminals?.items ?? []) as any[];

  // 1. Direct agent_session_id on the item — only include if it looks like a
  //    valid terminal instance_id (i.e. it matches a session we know about).
  //    Historically the field held the agent_sessions.id primary key (as_…),
  //    which the /terminal/<id>/ws endpoint does NOT accept — attaching to
  //    that produced "session has exited and its log was not captured".
  const rawAgentSessionId = (it as any).agent_session_id;
  if (rawAgentSessionId && terminals.some((s: any) => s.instance_id === rawAgentSessionId)) {
    ids.push(rawAgentSessionId);
  }

  // 2. Recipe instance — the instance id IS the terminal instance_id (both
  //    are `ri_…`), so add it directly. Previously we tried to match against
  //    `s.recipe_id` which is the recipe TEMPLATE id (e.g. "review-code"),
  //    so this branch never actually populated any ids.
  if (it.recipe_instance?.id && !ids.includes(it.recipe_instance.id)) {
    ids.push(it.recipe_instance.id);
  }

  // 3. Item-level dispatch session_id → resolve to terminal instance_id
  const itemRaw = it as any;
  const dispatchSessionId = itemRaw.dispatch?.session_id;
  if (dispatchSessionId) {
    for (const s of terminals) {
      if (s.cli_session_id === dispatchSessionId && !ids.includes(s.instance_id)) {
        ids.push(s.instance_id);
      }
    }
  }

  // 4. Question-level dispatch session_ids
  const itemQs = Array.isArray(it.questions) ? it.questions : [];
  for (const q of itemQs) {
    const qSid = q.dispatch?.session_id;
    if (qSid) {
      for (const s of terminals) {
        if (s.cli_session_id === qSid && !ids.includes(s.instance_id)) {
          ids.push(s.instance_id);
        }
      }
    }
  }

  // 5. Reply dispatch instance_ids (from completed dispatches)
  for (const r of replies.value) {
    const did = r.dispatch?.instance_id;
    if (did && !ids.includes(did)) ids.push(did);
  }

  // 6. Locally tracked dispatched sessions (from this UI session)
  for (const did of dispatchedSessionIds.value) {
    if (!ids.includes(did)) ids.push(did);
  }

  return ids;
});

const linkedSessionLabels = computed<string[]>(() =>
  linkedSessionIds.value.map((id) => {
    const s = (store.terminals?.items ?? []).find((t: any) => t.instance_id === id);
    return (s as any)?.label || (s as any)?.task_title || id.slice(0, 12);
  }),
);

const hasLinkedTerminal = computed(() => linkedSessionIds.value.length > 0);

const terminalStatus = ref<'live' | 'idle' | 'none'>('none');

// Use watch instead of computed to ensure reactivity triggers properly
watch(
  [linkedSessionIds, () => store.terminals?.items],
  () => {
    if (!hasLinkedTerminal.value) { terminalStatus.value = 'none'; return; }
    const terminals = (store.terminals?.items ?? []) as any[];
    if (terminals.length === 0) { terminalStatus.value = 'idle'; return; }
    const ids = linkedSessionIds.value;
    const active = terminals.some(
      (s: any) => ids.includes(s.instance_id) && s.live &&
        (s.state === 'thinking' || s.state === 'tool_use'),
    );
    terminalStatus.value = active ? 'live' : 'idle';
  },
  { immediate: true, deep: true },
);

// Periodic refresh of terminal status when panel is open or chip is showing
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
watch(hasLinkedTerminal, (has) => {
  if (has && !statusPollTimer) {
    statusPollTimer = setInterval(() => {
      store.refreshTerminals?.();
    }, 5000);
  } else if (!has && statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}, { immediate: true });
onBeforeUnmount(() => { if (statusPollTimer) clearInterval(statusPollTimer); });

function toggleTerminalPanel() {
  terminalPanelOpen.value = !terminalPanelOpen.value;
}

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

function shareArtifactUrl(att: InboxAttachment): string | null {
  if (!att.view_url) return null;
  // Will be populated by the async copy function
  return att.view_url; // non-null signals the button should show
}

async function copyShareUrl(att: InboxAttachment): Promise<void> {
  if (!att.view_url) return;
  let url = `${window.location.origin}${att.view_url}`;
  try {
    const shareTunnel = await fetch('/api/share-tunnel/status').then(r => r.json());
    if (shareTunnel.url) {
      url = `${shareTunnel.url}${att.view_url}`;
    } else if (store.tunnel.url) {
      const port = store.tunnel.port || 5201;
      const base = store.tunnel.url.replace(/-\d+\./, `-${port}.`);
      url = `${base}${att.view_url}`;
    }
  } catch { /* use local URL */ }
  try {
    await navigator.clipboard.writeText(url);
  } catch { /* fallback */ }
}

// ---------------------------------------------------------------------------
// Question + reply chain (multi-question batch UX)
// ---------------------------------------------------------------------------

// Auto-scroll chat to bottom when new messages arrive
const chatScroll = ref<HTMLElement | null>(null);
function scrollToBottom() {
  nextTick(() => {
    if (chatScroll.value) {
      chatScroll.value.scrollTop = chatScroll.value.scrollHeight;
    }
  });
}
watch(() => replies.value.length, scrollToBottom);
watch(() => props.itemId, scrollToBottom);
watch(() => bodyEntry.value?.body, scrollToBottom);
onMounted(scrollToBottom);

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

watch(() => props.itemId, () => {
  if (item.value?.recipe_instance?.id) {
    void store.refreshTerminals?.();
  }
}, { immediate: true });

watch(hasLinkedTerminal, (hasLinked) => {
  if (!hasLinked) {
    terminalPanelOpen.value = false;
  }
}, { immediate: true });

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

const showFreeformReply = computed(() => {
  // Always show compose bar — it's the primary interaction surface in chat mode.
  // hasAnyDispatch determines if the reply gets dispatched to a live agent
  // vs just stored as an inbox reply.
  void hasAnyDispatch.value;
  return !!item.value;
});

const canSendFreeform = computed(() =>
  !freeformSubmitting.value && freeformReplyText.value.trim().length > 0,
);

async function onSubmitFreeform(): Promise<void> {
  if (!canSendFreeform.value || !item.value) return;
  freeformSubmitting.value = true;
  freeformError.value = null;
  try {
    const result = await store.submitInboxReply(item.value.id, {
      text: freeformReplyText.value.trim(),
    });
    freeformReplyText.value = '';
    // If the reply was dispatched to an agent, capture the session
    const lastReply = result.item?.replies?.slice(-1)[0];
    const did = lastReply?.dispatch?.instance_id;
    if (did && !dispatchedSessionIds.value.includes(did)) {
      dispatchedSessionIds.value = [...dispatchedSessionIds.value, did];
      store.refreshTerminals?.();
    }
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
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Find the user's selected option_ids for a closed question. */
function answeredOptionIds(questionId: string): string[] {
  // Search replies (newest first) for an answer matching this question
  for (let i = replies.value.length - 1; i >= 0; i--) {
    const r = replies.value[i];
    if (r.author !== 'user') continue;
    if (r.answers) {
      const a = r.answers.find((a) => a.question_id === questionId);
      if (a?.option_ids) return a.option_ids;
    }
    // Legacy single-question items: option_ids on the reply itself
    if (r.option_ids && activeQuestions.value.length === 1) return r.option_ids;
  }
  return [];
}

/** Find the user's freeform text answer for a closed question. */
function answeredText(questionId: string): string {
  for (let i = replies.value.length - 1; i >= 0; i--) {
    const r = replies.value[i];
    if (r.author !== 'user') continue;
    if (r.answers) {
      const a = r.answers.find((a) => a.question_id === questionId);
      if (a?.text) return a.text;
    }
    if (r.text && activeQuestions.value.length === 1) return r.text;
  }
  return '';
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

function onMarkUnread(): void {
  if (!item.value) return;
  void store.markInboxItemUnread(item.value.id);
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

        <Button
          v-if="hasLinkedTerminal"
          icon="pi pi-microchip-ai"
          :severity="terminalStatus === 'live' ? 'success' : 'secondary'"
          size="small"
          rounded
          :class="{ 'chip-live': terminalStatus === 'live', 'chip-idle': terminalStatus !== 'live' }"
          :title="terminalPanelOpen ? 'Close terminal panel' : `Terminal (${linkedSessionIds.length})`"
          class="action-btn terminal-chip"
          @click="toggleTerminalPanel"
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
          v-if="item.unread !== true"
          icon="pi pi-eye-slash"
          text
          rounded
          size="small"
          aria-label="Mark as unread"
          title="Mark as unread"
          class="head-btn"
          @click="onMarkUnread"
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
    <div v-if="activeSubtab !== null" class="artifact-subpane">
      <iframe
        v-if="artifactSubtabs.find((t) => t.id === activeSubtab)"
        :src="artifactSubtabs.find((t) => t.id === activeSubtab)!.url"
        :title="artifactSubtabs.find((t) => t.id === activeSubtab)!.title || activeSubtab"
        sandbox="allow-scripts allow-same-origin allow-forms"
        class="artifact-iframe"
        loading="lazy"
      />
    </div>

    <div v-else class="inbox-body-container">
      <div class="inbox-chat-side" :style="terminalPanelOpen ? { width: '60%' } : {}">
        <div class="detail-scroll" ref="chatScroll">
          <!-- Chat-style: chronological (oldest → newest), compose pinned at bottom -->

          <!-- Messages area (scrollable) -->
          <div class="chat-messages">
            <!-- Original message (first/oldest) -->
            <div v-if="(item.description_size ?? 0) > 0 || bodyEntry?.body || item.preview" class="chat-msg" :class="item.source === 'agent' ? 'msg-agent' : 'msg-user'">
              <div class="msg-header">
                <i v-if="item.source === 'agent'" class="pi pi-sparkles msg-icon" />
                <i v-else class="pi pi-user msg-icon" />
                <span class="msg-author">{{ item.source === 'agent' ? 'Agent' : 'You' }}</span>
                <span class="msg-time">{{ formatReplyTime(item.created_at ?? 0) }}</span>
              </div>
              <div v-if="bodyEntry?.loading" class="msg-body muted">Loading…</div>
              <div v-else-if="bodyEntry?.error && !item.preview" class="msg-body error">Failed to load</div>
              <div v-else-if="bodyHtml" class="msg-body markdown-body" v-html="bodyHtml" />
              <div v-else-if="item.preview" class="msg-body markdown-body" v-html="renderInboxBody(item.preview, 'markdown')" />
              <!-- Item-level attachments when no replies -->
              <div v-if="replies.length === 0 && attachments.length > 0" class="msg-attachments">
                <Button
                  v-for="att in attachments"
                  :key="att.artifact_id"
                  class="reply-att-btn"
                  size="small"
                  severity="secondary"
                  :outlined="true"
                  :disabled="!att.view_url"
                  :title="att.view_url ? `Open ${att.artifact_id}` : `Artifact ${att.artifact_id} not found`"
                  @click="openAttachment(att)"
                >
                  <i class="pi pi-paperclip" />
                  <span class="att-title">{{ att.title || att.artifact_id }}</span>
                  <span v-if="att.type" class="att-type">{{ att.type }}</span>
                </Button>
              </div>
            </div>

            <!-- Item-level attachments after original (when replies exist) -->
            <div v-if="replies.length > 0 && attachments.length > 0" class="msg-attachments standalone-att">
              <Button
                v-for="att in attachments"
                :key="att.artifact_id"
                class="reply-att-btn"
                size="small"
                severity="secondary"
                :outlined="true"
                :disabled="!att.view_url"
                @click="openAttachment(att)"
              >
                <i class="pi pi-paperclip" />
                <span class="att-title">{{ att.title || att.artifact_id }}</span>
                <span v-if="att.type" class="att-type">{{ att.type }}</span>
              </Button>
            </div>

            <!-- Reply chain (chronological — oldest → newest) -->
            <template v-for="r in replies" :key="r.id">
              <div class="chat-msg" :class="{ 'msg-user': r.author === 'user', 'msg-agent': r.author === 'agent' }">
                <div class="msg-header">
                  <i :class="r.author === 'agent' ? 'pi pi-sparkles' : 'pi pi-user'" class="msg-icon" />
                  <span class="msg-author">{{ r.author === 'user' ? 'You' : 'Agent' }}</span>
                  <span class="msg-time">{{ formatReplyTime(r.created_at) }}</span>
                </div>
                <div class="msg-body markdown-body" v-html="renderInboxBody(r.text, 'markdown')" />
                <div v-if="(r.attachments?.length ?? 0) > 0" class="msg-attachments">
                  <div v-for="att in (r.attachments ?? [])" :key="att.artifact_id" class="att-row">
                    <Button
                      class="reply-att-btn"
                      size="small"
                      severity="secondary"
                      :outlined="true"
                      :disabled="!att.view_url"
                      @click="openReplyAttachment(att)"
                    >
                      <i class="pi pi-paperclip" />
                      <span class="att-title">{{ att.title || att.artifact_id }}</span>
                    </Button>
                    <button v-if="shareArtifactUrl(att)" class="share-btn" title="Copy share link" @click="copyShareUrl(att)">
                      <i class="pi pi-share-alt" />
                    </button>
                  </div>
                </div>
              </div>
              <!-- Inline question card: shown right after the agent reply that has questions -->
              <template v-if="r.author === 'agent' && r.questions && r.questions.length > 0">
                <!-- Closed questions: read-only display with selections -->
                <div v-if="r.questions.every(q => q.closed)" class="question-section question-readonly">
                  <div class="qz-header">
                    <div class="qz-progress-row">
                      <div class="qz-step-label">
                        <i class="pi pi-check-circle" style="color: #4ade80;" />
                        <span class="qz-step-counter">
                          {{ r.questions.length === 1 ? '1 question answered' : `All ${r.questions.length} questions answered` }}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div class="qz-readonly-body">
                    <div v-for="(q, qi) in r.questions" :key="q.id" class="qz-readonly-item">
                      <div class="qz-readonly-prompt">
                        <span class="qz-readonly-num">Q{{ qi + 1 }}</span>
                        <span v-html="renderPrompt(q.prompt)" />
                      </div>
                      <div v-if="q.options && q.options.length > 0" class="qz-readonly-options">
                        <div
                          v-for="opt in q.options"
                          :key="opt.id"
                          class="qz-readonly-opt"
                          :class="{ selected: answeredOptionIds(q.id).includes(opt.id) }"
                        >
                          <i :class="answeredOptionIds(q.id).includes(opt.id) ? 'pi pi-check-circle' : 'pi pi-circle'" class="qz-readonly-check" />
                          <span>{{ opt.label }}</span>
                        </div>
                      </div>
                      <div v-if="answeredText(q.id)" class="qz-readonly-text">
                        <i class="pi pi-comment" /> {{ answeredText(q.id) }}
                      </div>
                    </div>
                  </div>
                </div>
                <!-- Open questions: show the wizard inline -->
                <div v-else-if="activeBatch?.source === 'reply' && activeBatch?.reply_id === r.id" class="question-section">
                  <!-- Reuse the same wizard UI but positioned inline -->
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
                    </div>
                    <ProgressBar :value="wizardProgressPct" class="qz-progress" :showValue="false" />
                  </div>
                  <div v-if="currentQuestion" class="qz-body">
                    <div v-if="currentQuestion.title" class="qz-cat">{{ currentQuestion.title }}</div>
                    <div class="qz-prompt" v-html="renderPrompt(currentQuestion.prompt)" />
                    <div v-if="currentQuestion.options && currentQuestion.options.length > 0" class="qz-options">
                      <button
                        v-for="opt in currentQuestion.options"
                        :key="opt.id"
                        type="button"
                        class="qz-option-row"
                        :class="{
                          'qz-option-selected': isOptionSelected(currentQuestion.id, opt.id),
                          'qz-option-recommended': opt.isRecommended,
                        }"
                        @click="toggleOption(currentQuestion.id, opt.id)"
                      >
                        <span
                          class="qz-option-indicator"
                          :class="{
                            'qz-indicator-radio': modeFor(currentQuestion) === 'single',
                            'qz-indicator-checkbox': modeFor(currentQuestion) === 'multi',
                          }"
                        >
                          <i
                            v-if="isOptionSelected(currentQuestion.id, opt.id)"
                            :class="modeFor(currentQuestion) === 'single' ? 'pi pi-circle-fill' : 'pi pi-check'"
                          />
                        </span>
                        <span class="qz-option-content">
                          <span class="qz-option-label-row">
                            <span class="qz-option-label">{{ opt.label }}</span>
                            <span v-if="opt.isRecommended" class="qz-recommended-badge">Recommended</span>
                          </span>
                          <span v-if="opt.rationale" class="qz-option-rationale">{{ opt.rationale }}</span>
                        </span>
                      </button>
                    </div>
                    <div v-if="allowFreeformFor(currentQuestion)" class="qz-freeform-wrap">
                      <label class="qz-freeform-label muted small">
                        {{ (currentQuestion.options?.length ?? 0) > 0 ? 'Or type a custom answer:' : 'Your answer:' }}
                      </label>
                      <Textarea
                        :modelValue="perQuestionText[currentQuestion.id] ?? ''"
                        @update:modelValue="setText(currentQuestion.id, $event)"
                        class="qz-freeform-input"
                        :placeholder="currentQuestion.placeholder || 'Type your answer…'"
                        :rows="3"
                        autoResize
                      />
                    </div>
                  </div>
                  <div class="qz-footer">
                    <div v-if="submitError" class="question-error">
                      <i class="pi pi-exclamation-triangle" /> {{ submitError }}
                    </div>
                    <div class="qz-nav">
                      <Button
                        v-if="!isFirstQuestion"
                        icon="pi pi-arrow-left"
                        label="Back"
                        text size="small"
                        @click="goPrevQuestion"
                      />
                      <span class="qz-spacer" />
                      <Button
                        v-if="!isLastQuestion"
                        icon="pi pi-arrow-right"
                        iconPos="right"
                        label="Next"
                        text size="small"
                        :disabled="!currentQuestionIsAnswered"
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
              </template>
            </template>
          </div>

          <!-- Active question batch — only for item-level questions or open reply questions.
               Closed reply-level questions are shown inline after the agent reply above. -->
          <div v-if="activeQuestions.length > 0 && allClosed && activeBatch?.source === 'item'" class="question-section question-readonly">
            <div class="qz-header">
              <div class="qz-progress-row">
                <div class="qz-step-label">
                  <i class="pi pi-check-circle" style="color: #4ade80;" />
                  <span class="qz-step-counter">
                    {{ activeQuestions.length === 1 ? '1 question answered' : `All ${activeQuestions.length} questions answered` }}
                  </span>
                </div>
              </div>
            </div>
            <div class="qz-readonly-body">
              <div v-for="(q, qi) in activeQuestions" :key="q.id" class="qz-readonly-item">
                <div class="qz-readonly-prompt">
                  <span class="qz-readonly-num">Q{{ qi + 1 }}</span>
                  <span v-html="renderPrompt(q.prompt)" />
                </div>
                <div v-if="q.options && q.options.length > 0" class="qz-readonly-options">
                  <div
                    v-for="opt in q.options"
                    :key="opt.id"
                    class="qz-readonly-opt"
                    :class="{ selected: answeredOptionIds(q.id).includes(opt.id) }"
                  >
                    <i :class="answeredOptionIds(q.id).includes(opt.id) ? 'pi pi-check-circle' : 'pi pi-circle'" class="qz-readonly-check" />
                    <span>{{ opt.label }}</span>
                  </div>
                </div>
                <div v-if="answeredText(q.id)" class="qz-readonly-text">
                  <i class="pi pi-comment" /> {{ answeredText(q.id) }}
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="activeQuestions.length > 0 && activeBatch?.source === 'item'" class="question-section">
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
                      :class="{
                        'qz-option-selected': isOptionSelected(currentQuestion.id, opt.id),
                        'qz-option-recommended': opt.isRecommended,
                      }"
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
                      <span class="qz-option-content">
                        <span class="qz-option-label-row">
                          <span class="qz-option-label">{{ opt.label }}</span>
                          <span v-if="opt.isRecommended" class="qz-recommended-badge">Recommended</span>
                        </span>
                        <span v-if="opt.rationale" class="qz-option-rationale">{{ opt.rationale }}</span>
                      </span>
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

          <!-- Freeform reply box (standalone — only when no replies yet) -->
          <!-- (legacy placement — now compose is pinned below) -->

          <div v-if="item.recipe_instance?.id || item.trigger_id" class="detail-section linked-section">
            <div class="link-row">
              <Button
                v-if="item.recipe_instance?.id"
                class="link-chip"
                size="small"
                severity="info"
                :outlined="true"
                @click="jumpToRecipe"
              >
                <i class="pi pi-list-check" />
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
                <i class="pi pi-clock" />
                Trigger <code>{{ item.trigger_id }}</code>
              </Button>
            </div>
          </div>
        </div>

        <!-- Compose area — pinned at bottom of the panel -->
        <div v-if="showFreeformReply" class="chat-compose">
          <div class="compose-inner">
            <Textarea
              v-model="freeformReplyText"
              class="compose-input"
              placeholder="Message…"
              :rows="1"
              autoResize
              :disabled="freeformSubmitting"
              @keydown.ctrl.enter="onSubmitFreeform"
              @keydown.meta.enter="onSubmitFreeform"
            />
            <Button
              icon="pi pi-send"
              severity="info"
              size="small"
              rounded
              :loading="freeformSubmitting"
              :disabled="!freeformReplyText.trim()"
              class="compose-send"
              aria-label="Send"
              @click="onSubmitFreeform"
            />
          </div>
          <div v-if="freeformError" class="compose-error">
            <i class="pi pi-exclamation-triangle" /> {{ freeformError }}
          </div>
        </div>
      </div>
      <InboxTerminalPanel
        v-if="terminalPanelOpen && linkedSessionIds.length > 0"
        :sessionIds="linkedSessionIds"
        :sessionLabels="linkedSessionLabels"
        style="width: 40%"
        @close="terminalPanelOpen = false"
      />
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

.inbox-body-container {
  flex: 1;
  min-height: 0;
  display: flex;
}
.inbox-chat-side {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  transition: width 0.2s;
}
/* Terminal status chip — clear distinction between live and idle */
.terminal-chip {
  transition: all 0.3s;
}
.chip-live {
  animation: chip-pulse 1.5s ease-in-out infinite;
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.5), 0 0 20px rgba(74, 222, 128, 0.2) !important;
  border: 1px solid rgba(74, 222, 128, 0.6) !important;
}
.chip-idle {
  opacity: 0.4;
  filter: grayscale(1);
}
.chip-idle:hover {
  opacity: 0.7;
  filter: grayscale(0.5);
}
@keyframes chip-pulse {
  0%, 100% { box-shadow: 0 0 6px rgba(74, 222, 128, 0.3), 0 0 12px rgba(74, 222, 128, 0.1); }
  50% { box-shadow: 0 0 14px rgba(74, 222, 128, 0.6), 0 0 28px rgba(74, 222, 128, 0.3); }
}

.detail-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

/* Chat messages area — fills available space, scrolls */
.chat-messages {
  flex: 1;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Individual message — full-width, left accent border */
.chat-msg {
  padding: 10px 14px;
  border-left: 3px solid transparent;
  border-radius: 2px;
}
.chat-msg.msg-agent {
  border-left-color: #a78bfa;
}
.chat-msg.msg-user {
  border-left-color: #4a8ae8;
}
.chat-msg:hover {
  background: rgba(255, 255, 255, 0.02);
}

.msg-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.msg-icon {
  font-size: 12px;
  opacity: 0.6;
}
.msg-agent .msg-icon { color: #a78bfa; }
.msg-user .msg-icon { color: #4a8ae8; }
.msg-author {
  font-size: 12px;
  font-weight: 600;
  color: var(--p-text-color-secondary);
}
.msg-agent .msg-author { color: #a78bfa; }
.msg-time {
  font-size: 11px;
  color: var(--p-text-color-secondary);
  opacity: 0.6;
  margin-left: auto;
}
.msg-body {
  font-size: 14px;
  line-height: 1.6;
  color: var(--p-text-color);
}
.msg-attachments {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.standalone-att {
  padding: 4px 14px 4px 20px;
}

/* Compose area — pinned at bottom */
.chat-compose {
  flex-shrink: 0;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--p-content-border-color, #2a2e38);
  background: var(--p-content-background, #15171d);
}
.compose-inner {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.compose-input {
  flex: 1;
  min-width: 0;
  font-size: 13px !important;
  background: rgba(255, 255, 255, 0.04) !important;
  border: 1px solid var(--p-content-border-color, #2a2e38) !important;
  border-radius: 8px !important;
  padding: 8px 12px !important;
  max-height: 120px;
  resize: none;
}
.compose-input:focus {
  border-color: #4a8ae8 !important;
  outline: none;
}
.compose-send {
  flex-shrink: 0;
  width: 34px !important;
  height: 34px !important;
}
.compose-error {
  color: #f59e9e;
  font-size: 12px;
  margin-top: 4px;
}

.linked-section {
  padding: 8px 14px;
  border-top: 1px solid var(--p-content-border-color, #2a2e38);
}

/* Read-only answered questions */
.question-readonly {
  opacity: 0.85;
}
.question-readonly .qz-header {
  background: rgba(74, 222, 128, 0.06);
}
.qz-readonly-body {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.qz-readonly-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.qz-readonly-prompt {
  font-size: 13px;
  font-weight: 500;
  color: #b0b8c4;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.qz-readonly-num {
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
  min-width: 22px;
}
.qz-readonly-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 30px;
}
.qz-readonly-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  padding: 4px 8px;
  border-radius: 4px;
  color: #6b7280;
}
.qz-readonly-opt.selected {
  color: #e2e4e9;
  background: rgba(74, 222, 128, 0.08);
}
.qz-readonly-check {
  font-size: 14px;
}
.qz-readonly-opt.selected .qz-readonly-check {
  color: #4ade80;
}
.qz-readonly-text {
  font-size: 13px;
  color: #c8ccd4;
  padding-left: 30px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.qz-readonly-text i {
  font-size: 11px;
  color: #6b7280;
}

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

.original-msg-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
}
.original-msg-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--p-text-color-secondary);
}
.original-msg-time { font-size: 11px; }

.detail-section { display: flex; flex-direction: column; gap: 8px; }
.detail-section-head {
  color: var(--p-text-color-secondary);
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: flex; align-items: center; gap: 6px;
}
.attachment-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); gap: 8px; }
.att-row { display: flex; align-items: center; gap: 4px; }
.att-row .attachment-btn, .att-row .reply-att-btn { flex: 1; min-width: 0; }
.share-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; flex-shrink: 0;
  background: transparent; border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 6px; color: var(--p-text-color-secondary); cursor: pointer;
}
.share-btn:hover { background: rgba(74,138,232,0.1); color: #4a8ae8; border-color: rgba(74,138,232,0.3); }
.share-btn i { font-size: 12px; }
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

/* Markdown styling — light, modern, minimal */
.markdown-body { min-width: 0; overflow-wrap: anywhere; word-break: break-word; font-size: 13.5px; line-height: 1.7; color: #c8ccd4; }
.markdown-body :deep(*) { max-width: 100%; }
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3) {
  color: #e2e4e9; font-weight: 600; margin-top: 1.4em; margin-bottom: 0.4em; border: none; padding: 0;
}
.markdown-body :deep(h1) { font-size: 1.3em; }
.markdown-body :deep(h2) { font-size: 1.15em; }
.markdown-body :deep(h3) { font-size: 1em; color: #b0b8c4; }
.markdown-body :deep(p) { margin: 0.5em 0; }
.markdown-body :deep(a) { color: #6cb4f7; text-decoration: none; }
.markdown-body :deep(a:hover) { text-decoration: underline; }
.markdown-body :deep(code) { background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; color: #d4bfff; }
.markdown-body :deep(pre) {
  background: rgba(0,0,0,0.25); padding: 12px 14px; border-radius: 6px;
  max-width: 100%; overflow-x: auto; margin: 0.6em 0;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
.markdown-body :deep(pre code) { background: transparent; padding: 0; color: #c8ccd4; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.markdown-body :deep(blockquote) { border-left: 2px solid rgba(255,255,255,0.1); padding-left: 14px; color: #8b919c; margin: 0.6em 0; font-style: italic; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 1.4em; margin: 0.5em 0; }
.markdown-body :deep(li) { margin: 0.2em 0; }
.markdown-body :deep(li::marker) { color: #5a6070; }
.markdown-body :deep(table) { border-collapse: collapse; margin: 0.8em 0; display: block; max-width: 100%; overflow-x: auto; }
.markdown-body :deep(th) { border-bottom: 1px solid rgba(255,255,255,0.1); padding: 6px 10px; font-weight: 600; color: #b0b8c4; font-size: 0.9em; text-align: left; }
.markdown-body :deep(td) { border-bottom: 1px solid rgba(255,255,255,0.05); padding: 6px 10px; }
.markdown-body :deep(img) { max-width: 100%; height: auto; border-radius: 6px; }
.markdown-body :deep(hr) { border: none; border-top: 1px solid rgba(255,255,255,0.06); margin: 1.2em 0; }
.markdown-body :deep(strong) { color: #e2e4e9; font-weight: 600; }
.markdown-body :deep(.inbox-body-pre) {
  background: rgba(0,0,0,0.25); padding: 12px 14px; border-radius: 6px;
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
  border-left: 3px solid #a78bfa;
  border-radius: 6px;
  background: rgba(74, 138, 232, 0.04);
  overflow: hidden;
  flex-shrink: 0;
  max-width: 640px;
  margin: 4px 14px;
}

.qz-header {
  padding: 8px 14px;
  background: rgba(74, 138, 232, 0.06);
  border-bottom: 1px solid var(--p-content-border-color, #2a2e38);
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  padding: 12px 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  font-size: 14px;
  font-weight: 600;
  color: var(--p-text-color);
  line-height: 1.3;
  white-space: pre-wrap;
}
.qz-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 2px;
}

.qz-options {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.qz-option-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 6px;
  color: var(--p-text-color);
  font-family: inherit;
  font-size: 13px;
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
  width: 16px;
  height: 16px;
  margin-top: 2px;
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
.qz-option-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.qz-option-label-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qz-option-label {
  line-height: 1.4;
  word-break: break-word;
}
.qz-recommended-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(74, 200, 130, 0.15);
  color: #4ac882;
  border: 1px solid rgba(74, 200, 130, 0.3);
}
.qz-option-rationale {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--p-text-color-secondary, #8a8f9a);
  word-break: break-word;
}
.qz-option-recommended {
  border-color: rgba(74, 200, 130, 0.35);
}
.qz-option-recommended:hover:not(:disabled) {
  border-color: rgba(74, 200, 130, 0.6);
  background: rgba(74, 200, 130, 0.06);
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
  font-size: 13px;
  min-height: 48px;
}

.qz-footer {
  padding: 8px 14px 10px;
  background: rgba(74, 138, 232, 0.06);
  border-top: 1px solid var(--p-content-border-color, #2a2e38);
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  gap: 6px;
  padding: 10px 14px;
  margin-top: 8px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  flex-shrink: 0;
}
.freeform-reply.freeform-inline {
  margin-top: 0;
  border-color: rgba(74, 138, 232, 0.3);
  background: rgba(74, 138, 232, 0.04);
}
.freeform-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--p-text-color);
}
.freeform-label i {
  color: var(--p-text-color-secondary);
  font-size: 13px;
}
.freeform-text {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  min-height: 48px;
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
  background: rgba(139, 92, 246, 0.06);
  border: 1px solid rgba(139, 92, 246, 0.25);
  border-left: 3px solid rgba(139, 92, 246, 0.6);
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
.reply-author.is-agent { color: #a78bfa; }
.reply-agent-icon { font-size: 12px; color: #a78bfa; }
.reply-time { opacity: 0.7; }
.reply-badge { font-size: 10px; margin-left: auto; }
.reply-text {
  color: var(--p-text-color);
  word-wrap: break-word;
}
.reply-user .reply-text { white-space: pre-wrap; }
.reply-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.reply-att-btn { font-size: 11px; }
</style>
