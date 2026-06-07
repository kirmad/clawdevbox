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
  // Tell the store where this click originated so the artifact tab can
  // render a "← back" button. paneKey is `inbox-detail:<id>` when
  // rendered inside a popped-out tab; `inbox-master` for master-detail.
  const fromTab = props.paneKey.startsWith('inbox-detail:');
  store.openInboxAttachment(att, {
    kind: fromTab ? 'inbox-tab' : 'inbox-list',
    inboxId: props.itemId,
  });
}

// ---------------------------------------------------------------------------
// Question + reply chain
// ---------------------------------------------------------------------------

const question = computed<InboxQuestion | undefined>(() => item.value?.question);
const replies = computed<InboxReply[]>(() => item.value?.replies ?? []);

const questionMode = computed<'single' | 'multi' | 'text'>(() => {
  const q = question.value;
  if (!q) return 'single';
  if (q.mode) return q.mode;
  return q.options && q.options.length > 0 ? 'single' : 'text';
});
const allowFreeform = computed(() =>
  !!question.value && (question.value.allow_freeform === true || questionMode.value === 'text'),
);
const questionClosed = computed(() => question.value?.closed === true);

// Selection state — reset whenever the active item changes.
const selectedOptionIds = ref<string[]>([]);
const freeformText = ref('');
const submitting = ref(false);
const submitError = ref<string | null>(null);

watch(
  () => props.itemId,
  () => {
    selectedOptionIds.value = [];
    freeformText.value = '';
    submitError.value = null;
  },
);

function toggleOption(optId: string): void {
  if (questionClosed.value) return;
  if (questionMode.value === 'single') {
    selectedOptionIds.value = [optId];
  } else if (questionMode.value === 'multi') {
    const set = new Set(selectedOptionIds.value);
    if (set.has(optId)) set.delete(optId);
    else set.add(optId);
    selectedOptionIds.value = [...set];
  }
}

const canSubmit = computed(() => {
  if (!question.value || questionClosed.value || submitting.value) return false;
  const mode = questionMode.value;
  const hasText = freeformText.value.trim().length > 0;
  const hasSelection = selectedOptionIds.value.length > 0;
  if (mode === 'text') return hasText;
  if (mode === 'single') return hasSelection || (allowFreeform.value && hasText);
  if (mode === 'multi') return hasSelection || (allowFreeform.value && hasText);
  return false;
});

async function onSubmitReply(): Promise<void> {
  if (!canSubmit.value || !item.value) return;
  submitting.value = true;
  submitError.value = null;
  try {
    await store.submitInboxReply(item.value.id, {
      option_ids: selectedOptionIds.value.length > 0 ? selectedOptionIds.value : undefined,
      text: freeformText.value.trim() || undefined,
    });
    // Reset local form on success — chain bubble renders from item.replies.
    selectedOptionIds.value = [];
    freeformText.value = '';
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}

function isOptionSelected(optId: string): boolean {
  return selectedOptionIds.value.includes(optId);
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

    <div class="detail-scroll">
      <div v-if="item.preview" class="detail-preview">{{ item.preview }}</div>

      <div v-if="(item.description_size ?? 0) > 0" class="detail-body-section">
        <div v-if="bodyEntry?.loading" class="muted">Loading body…</div>
        <div v-else-if="bodyEntry?.error" class="error">
          Failed to load body: {{ bodyEntry.error }}
        </div>
        <div v-else class="markdown-body" v-html="bodyHtml" />
      </div>
      <div v-else-if="!question" class="muted no-body">No body. {{ item.preview ? '' : 'Inbox item is metadata-only.' }}</div>

      <!-- Question card + reply chain -->
      <div v-if="question" class="question-section">
        <div class="question-prompt">{{ question.prompt }}</div>

        <!-- Existing replies (chat-style) -->
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

        <!-- Answer form (hidden when closed) -->
        <div v-if="!questionClosed" class="question-form">
          <div
            v-if="(question.options?.length ?? 0) > 0"
            class="question-options"
            :class="{ 'options-single': questionMode === 'single', 'options-multi': questionMode === 'multi' }"
            role="group"
            :aria-label="questionMode === 'single' ? 'Pick one option' : 'Pick one or more options'"
          >
            <Button
              v-for="opt in (question.options ?? [])"
              :key="opt.id"
              class="question-opt-btn"
              size="small"
              :severity="isOptionSelected(opt.id) ? 'info' : 'secondary'"
              :outlined="!isOptionSelected(opt.id)"
              :aria-pressed="isOptionSelected(opt.id)"
              @click="toggleOption(opt.id)"
            >
              <i v-if="isOptionSelected(opt.id)" class="pi pi-check" />
              <span>{{ opt.label }}</span>
            </Button>
          </div>

          <Textarea
            v-if="allowFreeform"
            v-model="freeformText"
            class="question-text"
            :placeholder="question.placeholder ?? 'Add a message…'"
            :rows="2"
            autoResize
            :disabled="submitting"
            @keydown.enter.exact.prevent="onSubmitReply"
          />

          <div v-if="submitError" class="question-error">
            <i class="pi pi-exclamation-triangle" /> {{ submitError }}
          </div>

          <div class="question-actions">
            <span v-if="questionMode === 'single'" class="muted small">
              Pick one option{{ allowFreeform ? ' or type a reply' : '' }}, then Send.
            </span>
            <span v-else-if="questionMode === 'multi'" class="muted small">
              Pick one or more options{{ allowFreeform ? ' (or type a reply)' : '' }}, then Send.
            </span>
            <span v-else class="muted small">Type your reply, then Send.</span>
            <Button
              icon="pi pi-send"
              label="Send"
              size="small"
              severity="info"
              :loading="submitting"
              :disabled="!canSubmit"
              @click="onSubmitReply"
            />
          </div>
        </div>

        <div v-else class="question-closed muted small">
          <i class="pi pi-check-circle" /> Question closed.
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
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
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
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3) {
  color: #fff; border-bottom: 1px solid #3e3e42; padding-bottom: 4px; margin-top: 1.2em;
}
.markdown-body :deep(h1) { font-size: 1.5em; }
.markdown-body :deep(h2) { font-size: 1.25em; }
.markdown-body :deep(h3) { font-size: 1.05em; border-bottom: 0; }
.markdown-body :deep(p) { margin: 0.6em 0; }
.markdown-body :deep(a) { color: #4daafc; }
.markdown-body :deep(code) { background: #0f1115; padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
.markdown-body :deep(pre) { background: #0f1115; padding: 10px 12px; border-radius: 4px; overflow-x: auto; }
.markdown-body :deep(pre code) { background: transparent; padding: 0; }
.markdown-body :deep(blockquote) { border-left: 3px solid #3e3e42; padding-left: 12px; color: var(--p-text-color-secondary); margin: 0.6em 0; }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 1.4em; margin: 0.6em 0; }
.markdown-body :deep(table) { border-collapse: collapse; margin: 0.6em 0; }
.markdown-body :deep(th), .markdown-body :deep(td) { border: 1px solid #3e3e42; padding: 5px 9px; }
.markdown-body :deep(img) { max-width: 100%; }
.markdown-body :deep(.inbox-body-pre) {
  background: #0f1115; padding: 10px 12px; border-radius: 4px;
  overflow-x: auto; white-space: pre-wrap;
}

/* ─── Question + reply chain ──────────────────────────────────────────── */
.question-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  border-radius: 6px;
  background: rgba(74, 138, 232, 0.04);
}
.question-prompt {
  font-size: 14px;
  font-weight: 500;
  color: var(--p-text-color);
  line-height: 1.5;
  white-space: pre-wrap;
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

.question-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}
.question-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.question-opt-btn { font-size: 12px; }
.question-opt-btn i { margin-right: 4px; font-size: 10px; }

.question-text {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
}

.question-error {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f59e9e;
  font-size: 12px;
}
.question-error i { font-size: 12px; }

.question-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.question-actions .small { font-size: 11px; }

.question-closed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.question-closed i { color: #4ade80; }
</style>
