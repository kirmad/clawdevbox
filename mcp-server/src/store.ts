/**
 * store.ts
 *
 * Per-process state for threads, messages, and approvals; file-backed
 * state for inbox items.
 *
 * Row shapes follow spec §5 "Data model" so the tool surface (§6.1) is
 * stable; durability is the only thing that differs from a future
 * SQLite-backed kernel.
 *
 * **Inbox**: when `inbox.bind(globalDir)` is called (from `buildServer`),
 * the store reads `<globalDir>/inbox.json` on every operation and writes
 * it back atomically on every mutation. This keeps multiple processes
 * (the HTTP service + a stdio-MCP agent client) consistent without an
 * external DB. When unbound (test harnesses, ad-hoc use), it falls back
 * to an in-memory map — same API.
 *
 * **Threads / approvals** remain process-local; they don't outlive a
 * server restart yet. Persistence lands with the SQLite kernel.
 *
 * Ids use a coarse `<prefix>_<base36-random>` pattern so they're
 * human-recognizable in test logs without pulling in nanoid.
 *
 * Mutating Inbox methods (upsert/setState/snooze/archive) emit `inbox`
 * change events on the global bus so the SSE endpoint can push refresh
 * hints to connected browsers in real time.
 */

import { emitChange } from './event-bus.ts';
import {
  loadInboxFromDisk,
  saveInboxToDisk,
  readInboxItemById,
  upsertInboxItem,
} from './inbox-persistence.ts';

// ============================================================================
// Id minting
// ============================================================================

function rand36(): string {
  return Math.random().toString(36).slice(2, 10);
}
export function mintId(prefix: 'inb' | 'thr' | 'msg' | 'apr' | 'run' | 'oneoff' | 'rep'): string {
  return `${prefix}_${rand36()}`;
}

/** Mint an InboxReply id (`rep_<random>`). */
export function mintInboxReplyId(): string {
  return mintId('rep');
}

// ============================================================================
// Inbox
// ============================================================================

export type InboxState = 'new' | 'open' | 'snoozed' | 'archived' | 'done';
export type AgentTone = 'info' | 'warn' | 'err' | 'ok';
export type InboxBodyFormat = 'markdown' | 'text';

export interface InboxItemAttachment {
  /** Artifact id (folder name under `<workspace>/artifacts/`). */
  artifact_id: string;
  /** Optional workspace hint — disambiguates if two workspaces have the same artifact id. */
  workspace_id?: string;
  /** Display override for the attachment chip in the SPA. */
  title?: string;
  /** Renderer-type hint for filtering / icons. */
  type?: string;
}

export interface InboxItemRef {
  /** Opaque id of the recipe instance, thread, or other linked object. */
  id: string;
  /** Optional workspace hint for cross-workspace disambiguation. */
  workspace_id?: string;
}

// ----------------------------------------------------------------------------
// Question + reply chain
// ----------------------------------------------------------------------------
//
// An inbox item can carry a `question` payload describing a user-facing
// question with clickable options. When the user answers via
// `POST /api/inbox/<id>/reply`, the server compiles a prompt and dispatches
// it back to the agent's CLI session via `spawnDispatchOrResume`.
//
// The answer is also persisted on the item as a `replies[]` entry so the
// chain (and the user's selection) is visible across reloads. Agents can
// post follow-up `agent`-authored replies via `inbox.reply` to keep the
// conversation going (multi-turn back-and-forth).

export type InboxQuestionMode = 'single' | 'multi' | 'text';

export interface InboxQuestionOption {
  /** Stable id (e.g. "yes" / "opt-1") — what the API expects in `option_ids`. */
  id: string;
  /** Display label shown on the button. */
  label: string;
  /**
   * Text sent to the agent when this option is selected. Defaults to `label`.
   * The full set of selected option `value`s is joined into the dispatched
   * prompt (or substituted into `prompt_template`).
   */
  value?: string;
}

export interface InboxQuestionDispatch {
  /**
   * Session id (canonical GUID or alias) to dispatch the answer to. Resolved
   * server-side via the standard session-alias chain.
   *
   * If the live pty exists → dispatch.
   * If archived + resumable → resume.
   * Otherwise → spawn (provider + workspace must be set, or defaults available).
   */
  session_id?: string;
  /** Provider hint for fresh-spawn fallback (e.g. "copilot", "claude"). */
  provider?: string;
  workspace_id?: string;
  workspace_path?: string;
  /**
   * Prompt template — substitutions:
   *   {answer}      → compiled answer text (option labels joined OR freeform)
   *   {option_ids}  → joined list of selected option ids
   *   {freeform}    → raw freeform text (empty when none)
   * When unset, the dispatched prompt is just `{answer}`.
   */
  prompt_template?: string;
}

export interface InboxQuestion {
  /**
   * Stable id for this question within its parent inbox item. Used to
   * correlate per-question answers in batched replies. Required when an
   * item has multiple questions; for the legacy single-question case it
   * defaults to "q1" on read-time migration. May contain letters, digits,
   * dot, underscore, hyphen, colon.
   */
  id: string;
  /** Question prompt shown above the option buttons. */
  prompt: string;
  /**
   * 'single' (radio), 'multi' (checkbox), or 'text' (freeform only).
   * Default: 'single' when options are present, else 'text'.
   */
  mode?: InboxQuestionMode;
  options?: InboxQuestionOption[];
  /** Include a freeform text box alongside the options. */
  allow_freeform?: boolean;
  /** Placeholder hint for the freeform input. */
  placeholder?: string;
  /** Optional per-question header above the prompt (e.g. "Database choice"). */
  title?: string;
  /**
   * If true (default for single-question items), the parent item's
   * `questions[]` collection is closed (no further user replies accepted)
   * after the user submits their batch answer. With multiple questions
   * the recommended pattern is to close the whole block at once, so this
   * flag is read off `questions[0]` as the closing policy.
   */
  close_on_answer?: boolean;
  /** Set automatically when the question is closed. */
  closed?: boolean;
  /**
   * Routing for the answer. When unset, the reply is stored but no
   * dispatch fires. For multi-question items, the FIRST question with a
   * `dispatch` configured wins — all answers are compiled into a single
   * batched prompt and dispatched once.
   */
  dispatch?: InboxQuestionDispatch;
}

export type InboxReplyAuthor = 'user' | 'agent';

export interface InboxReplyDispatch {
  mode: 'spawn' | 'dispatch' | 'resume' | 'noop' | 'failed';
  /** Resulting recipe-instance id (for spawn/dispatch/resume). */
  instance_id?: string;
  /** Resolved session GUID. */
  session_id?: string;
  /** Dispatch-error code on failure. */
  code?: string;
  /** Human-readable failure message. */
  error?: string;
}

export interface InboxReply {
  /** `rep_<random>` minted by the server. */
  id: string;
  author: InboxReplyAuthor;
  /** Rendered text (option labels joined, or freeform, or both). */
  text: string;
  /**
   * Selected option ids (when author === 'user' and options were chosen).
   * Legacy field for single-question items. New multi-question items
   * carry the per-question selections in `answers[]` below.
   */
  option_ids?: string[];
  /** Raw freeform text contributed by the user. Legacy single-question field. */
  freeform?: string;
  /**
   * Per-question answers for multi-question items. Each entry targets a
   * question by its `question_id` and carries the user's selection +
   * freeform input for that specific question. When present, the
   * top-level `option_ids` / `freeform` fields are derived (concatenated
   * across answers) and the bubble text is the human-readable summary.
   */
  answers?: InboxReplyAnswer[];
  /**
   * Optional follow-up questions on an AGENT-authored reply. When an
   * agent replies with `questions: [...]`, the SPA renders the new
   * questions below the reply bubble and the user can answer them via
   * the same `POST /api/inbox/<id>/reply` endpoint — those answers
   * close THESE questions (not the original item-level ones). This is
   * how multi-turn batched Q&A works.
   */
  questions?: InboxQuestion[];
  /**
   * Artifact attachments on this reply (e.g. an agent follow-up that links
   * a new diff or report). Same shape + enrichment as item-level
   * `attachments` — the SPA renders them as clickable chips beneath the
   * reply bubble.
   */
  attachments?: InboxItemAttachment[];
  created_at: number;
  /** Populated when this reply triggered a dispatch (author === 'user'). */
  dispatch?: InboxReplyDispatch;
}

/** One per-question answer within a batched reply on a multi-question item. */
export interface InboxReplyAnswer {
  question_id: string;
  /** Selected option ids for this question (empty for text-only). */
  option_ids?: string[];
  /** Freeform text for this question (empty when only options were used). */
  freeform?: string;
  /** Rendered summary for this question's answer (e.g. "PostgreSQL — needs persistence"). */
  text?: string;
}

export interface InboxItem {
  id: string;
  kind: string;                  // 'pr_review' | 'workitem' | 'incident' | 'epic' | string
  source: string;                // 'ado' | 'incidents' | 'manual' | ...
  title?: string;
  /** Short tldr shown on the card (max 500 chars enforced at the tool boundary). */
  preview?: string;
  /**
   * Body format. The full body lives in a sidecar file at
   * `<globalDir>/inbox-bodies/<safe-id>.<ext>` — see inbox-persistence.ts.
   * inbox.json only stores the format + size; the SPA fetches the body
   * lazily via `GET /api/inbox/:id` when the user expands the card.
   */
  description_format?: InboxBodyFormat;
  /** Byte length of the description body. 0 / missing means no body. */
  description_size?: number;
  /** Artifact references — clickable "Open" chips in the SPA detail view. */
  attachments?: InboxItemAttachment[];
  /** Link to a recipe instance (clicking jumps to the Recipes tab). */
  recipe_instance?: InboxItemRef | null;
  /** Link to a registered trigger by id (e.g. `ado.new-pr-watcher#auth-svc`). */
  trigger_id?: string | null;
  /** Free-form labels/tags shown as chips on the card. Max 10, each max 40 chars. */
  labels?: string[];
  /**
   * Optional clickable-question payload(s). Items can carry one or more
   * questions; the SPA renders all of them in one form with a single
   * submit button (batch UX). `POST /api/inbox/<id>/reply` validates the
   * batch against each question and dispatches the compiled batched
   * answer to the FIRST question whose `dispatch.session_id` is set.
   * Legacy items with a singular `question` field are auto-migrated to
   * `questions: [{id: 'q1', ...question}]` on read.
   */
  questions?: InboxQuestion[];
  /**
   * Item-level dispatch routing for the always-on freeform reply box.
   * When set, the SPA renders a "Send a message to the agent" textarea
   * even on items with no questions; the user's typed message is wrapped
   * with item context and dispatched to `dispatch.session_id`. Default
   * prompt template: `User replied to inbox "<title>" (id=<id>): {answer}`.
   * Overridable via `dispatch.prompt_template`. If a question-level
   * dispatch is configured, it takes precedence for question answers;
   * the item-level dispatch is the fallback / freeform target.
   */
  dispatch?: InboxQuestionDispatch;
  /**
   * True when there is unseen agent activity on this item the user
   * hasn't acknowledged yet. Set to `true` on creation and on every
   * agent-side mutation (agent reply, new questions, body change, etc).
   * Cleared (`false`) when the user opens the item in the SPA or
   * explicitly marks it read via `inbox.mark_read` /
   * `POST /api/inbox/<id>/mark-read`. Defaults to `true` for items that
   * have never been read.
   */
  unread?: boolean;
  /**
   * Legacy single-question field. Always undefined after read-time
   * migration. Typed as `unknown` so callers can't accidentally consume
   * the pre-migration shape — go through `questions[]`.
   */
  question?: unknown;
  /**
   * Append-only reply chain (user answers + optional agent follow-ups). The
   * SPA renders these as chat-style bubbles below the question.
   */
  replies?: InboxReply[];
  /** Legacy "agent banner" — kept for backwards compat. Prefer `preview`. */
  agent_message?: string;
  agent_tone?: AgentTone;
  state: InboxState;
  snoozed_until?: number;        // unix ms
  /** Link to a specific recipe step (DB FK). Optional. */
  recipe_step_id?: string | null;
  /** Link to the agent session that produced this item (DB FK). Optional. */
  agent_session_id?: string | null;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface InboxPatch {
  kind?: string;
  source?: string;
  title?: string;
  preview?: string;
  description_format?: InboxBodyFormat;
  description_size?: number;
  attachments?: InboxItemAttachment[];
  recipe_instance?: InboxItemRef | null;
  trigger_id?: string | null;
  labels?: string[];
  /**
   * Legacy single-question field. Always undefined after read-time
   * migration (`migrateLegacyQuestion` in inbox-persistence.ts lifts
   * any persisted single question into `questions[0]`). New tools/writes
   * should use `questions` exclusively. Typed as `unknown` so callers
   * never accidentally consume the pre-migration shape — go through
   * `questions[]`.
   */
  question?: unknown;
  questions?: InboxQuestion[];
  dispatch?: InboxQuestionDispatch | null;
  /** Toggle unread flag (true on agent activity, false on mark-read). */
  unread?: boolean;
  replies?: InboxReply[];
  agent_message?: string;
  agent_tone?: AgentTone;
  [k: string]: unknown;
}

export interface UpsertResult {
  item: InboxItem;
  /** True if the item was newly created; false if an existing row was updated. */
  created: boolean;
}

export class InboxStore {
  private memory = new Map<string, InboxItem>();
  private globalDir?: string;

  /**
   * Switch the store from in-memory mode to file-backed mode. After
   * `bind`, every read/write goes through `<globalDir>/inbox.json` so
   * multiple processes (HTTP service + stdio-MCP) stay consistent.
   * Idempotent.
   */
  bind(globalDir: string): void {
    this.globalDir = globalDir;
  }

  /** Read the current state from disk (bound) or memory (unbound). */
  private load(): Map<string, InboxItem> {
    if (!this.globalDir) return this.memory;
    const items = loadInboxFromDisk(this.globalDir);
    const m = new Map<string, InboxItem>();
    for (const it of items) m.set(it.id, it);
    return m;
  }

  /** Persist a mutated state. */
  private save(items: Map<string, InboxItem>): void {
    if (this.globalDir) {
      saveInboxToDisk(this.globalDir, [...items.values()]);
    } else {
      this.memory = items;
    }
  }

  upsert(id: string, kind: string, source: string, patch: InboxPatch = {}): UpsertResult {
    const now = Date.now();
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    // Normalize nullable patch fields: `dispatch: null` is the explicit-clear
    // signal; we translate it to `undefined` on the stored item so downstream
    // types stay clean (`InboxQuestionDispatch | undefined`).
    const patchNormalized = { ...patch } as Record<string, unknown>;
    if (patchNormalized.dispatch === null) patchNormalized.dispatch = undefined;
    let item: InboxItem;
    let created: boolean;
    if (existing) {
      item = { ...existing, ...patchNormalized, kind, source, updated_at: now } as InboxItem;
      created = false;
    } else {
      item = {
        id,
        kind,
        source,
        state: 'new',
        created_at: now,
        updated_at: now,
        ...patchNormalized,
      } as InboxItem;
      created = true;
    }
    // Auto-promote a legacy `question` field in the patch into `questions[0]`
    // so writes that go through both paths (DB + in-memory) consistently
    // expose the new shape. The DB read path also runs this migration on
    // load, but doing it here means in-memory reads stay correct too.
    item = promoteLegacyQuestion(item);
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, item);
    } else {
      this.memory.set(id, item);
    }
    return { item, created };
  }

  read(id: string): InboxItem | undefined {
    if (this.globalDir) return readInboxItemById(this.globalDir, id) ?? undefined;
    return this.memory.get(id);
  }

  list(filter: { kind?: string; state?: InboxState; label?: string; limit?: number; cursor?: string } = {}): InboxItem[] {
    const labelKey = filter.label?.toLowerCase();
    const arr = [...this.load().values()]
      .filter((it) => !filter.kind || it.kind === filter.kind)
      .filter((it) => !filter.state || it.state === filter.state)
      .filter((it) => {
        if (!labelKey) return true;
        const labels = (it.labels as string[] | undefined) ?? [];
        return labels.some((l) => l.toLowerCase() === labelKey);
      })
      .sort((a, b) => b.updated_at - a.updated_at);
    const startIdx = filter.cursor ? Math.max(0, arr.findIndex((x) => x.id === filter.cursor) + 1) : 0;
    const limit = filter.limit ?? 100;
    return arr.slice(startIdx, startIdx + limit);
  }

  setState(id: string, state: InboxState): InboxItem | undefined {
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    if (!existing) return undefined;
    const updated: InboxItem = { ...existing, state, updated_at: Date.now() };
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, updated);
    } else {
      this.memory.set(id, updated);
    }
    return updated;
  }

  snooze(id: string, until: number): InboxItem | undefined {
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    if (!existing) return undefined;
    const updated: InboxItem = {
      ...existing,
      state: 'snoozed',
      snoozed_until: until,
      updated_at: Date.now(),
    };
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, updated);
    } else {
      this.memory.set(id, updated);
    }
    return updated;
  }

  archive(id: string): InboxItem | undefined {
    // setState already emits + persists.
    return this.setState(id, 'archived');
  }

  /**
   * Append a reply (user answer or agent follow-up) to an item's `replies[]`
   * chain. Returns the updated item and the newly-appended reply.
   *
   * Caller passes an already-built `InboxReply` (this layer doesn't validate
   * against `question.options` — the HTTP / MCP boundary does that).
   *
   * If `closeQuestion` is true, ALL questions on the item are marked
   * `closed: true` (batch-close semantics — a multi-question item closes
   * its whole block once the user submits an answer). Optionally bumps
   * the item state.
   */
  appendReply(
    id: string,
    reply: InboxReply,
    opts: { closeQuestion?: boolean; newState?: InboxState } = {},
  ): { item: InboxItem; reply: InboxReply } | undefined {
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    if (!existing) return undefined;
    const replies = Array.isArray(existing.replies) ? [...existing.replies, reply] : [reply];
    const updated: InboxItem = {
      ...existing,
      replies,
      updated_at: Date.now(),
    };
    if (opts.closeQuestion) {
      // Close every question in the batch.
      if (Array.isArray(existing.questions) && existing.questions.length > 0) {
        updated.questions = existing.questions.map((q) => ({ ...q, closed: true }));
      }
      // Legacy single-question form (kept for write-side back-compat in tests).
      if (existing.question) {
        updated.question = { ...existing.question, closed: true };
      }
    }
    if (opts.newState) {
      updated.state = opts.newState;
    }
    // Agent replies mark the item unread (new content for the user); user
    // replies do NOT (the user just generated the content themselves).
    if (reply.author === 'agent') {
      updated.unread = true;
    }
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, updated);
    } else {
      this.memory.set(id, updated);
    }
    return { item: updated, reply };
  }

  /**
   * Clear the unread flag on an item. Called when the user opens the
   * detail panel (auto) or explicitly hits "Mark as read". Idempotent —
   * marking an already-read item is a no-op.
   */
  markRead(id: string): InboxItem | undefined {
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    if (!existing) return undefined;
    if (existing.unread !== true) return existing; // already read
    const updated: InboxItem = { ...existing, unread: false, updated_at: Date.now() };
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, updated);
    } else {
      this.memory.set(id, updated);
    }
    return updated;
  }

  /**
   * Set the unread flag on an item. Called when the user explicitly
   * marks an item as unread to revisit later. Idempotent.
   */
  markUnread(id: string): InboxItem | undefined {
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    if (!existing) return undefined;
    if (existing.unread === true) return existing; // already unread
    const updated: InboxItem = { ...existing, unread: true, updated_at: Date.now() };
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, updated);
    } else {
      this.memory.set(id, updated);
    }
    return updated;
  }

  /** Patch an existing reply in place (e.g. fill in dispatch outcome). */
  updateReply(
    id: string,
    replyId: string,
    patch: Partial<InboxReply>,
  ): { item: InboxItem; reply: InboxReply } | undefined {
    const existing = this.globalDir
      ? readInboxItemById(this.globalDir, id) ?? undefined
      : this.memory.get(id);
    if (!existing || !Array.isArray(existing.replies)) return undefined;
    const idx = existing.replies.findIndex((r) => r.id === replyId);
    if (idx < 0) return undefined;
    const merged: InboxReply = { ...existing.replies[idx]!, ...patch, id: replyId };
    const replies = [...existing.replies];
    replies[idx] = merged;
    const updated: InboxItem = {
      ...existing,
      replies,
      updated_at: Date.now(),
    };
    if (this.globalDir) {
      upsertInboxItem(this.globalDir, updated);
    } else {
      this.memory.set(id, updated);
    }
    return { item: updated, reply: merged };
  }
}

// ============================================================================
// Threads + messages
// ============================================================================

export type ThreadState = 'running' | 'suspended' | 'awaiting_user' | 'done' | 'cancelled' | 'error';

export interface Thread {
  id: string;
  inbox_item_id: string;
  recipe_id?: string;
  parent_thread_id?: string;
  prompt: string;
  state: ThreadState;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  type: string;                  // 'agent_text' | 'tool_call' | 'tool_result' | 'view_emitted' | 'step_close' | etc.
  payload: unknown;
  attribution?: string;          // 'agent' | 'user' | 'system' | 'trigger'
  created_at: number;
}

export class ThreadStore {
  private threads = new Map<string, Thread>();
  private messages = new Map<string, Message[]>(); // thread_id -> messages[]
  private childIndex = new Map<string, string[]>(); // parent_thread_id -> [child_thread_id, ...]

  spawn(args: {
    inbox_item_id: string;
    prompt: string;
    recipe_id?: string;
    parent_thread_id?: string;
  }): Thread {
    const id = mintId('thr');
    const now = Date.now();
    const t: Thread = {
      id,
      inbox_item_id: args.inbox_item_id,
      recipe_id: args.recipe_id,
      parent_thread_id: args.parent_thread_id,
      prompt: args.prompt,
      state: 'running',
      created_at: now,
      updated_at: now,
    };
    this.threads.set(id, t);
    this.messages.set(id, []);
    if (args.parent_thread_id) {
      const arr = this.childIndex.get(args.parent_thread_id) ?? [];
      arr.push(id);
      this.childIndex.set(args.parent_thread_id, arr);
    }
    return t;
  }

  read(id: string, sinceMessageId?: string, limit?: number): { thread: Thread; messages: Message[] } | undefined {
    const t = this.threads.get(id);
    if (!t) return undefined;
    let msgs = this.messages.get(id) ?? [];
    if (sinceMessageId) {
      const idx = msgs.findIndex((m) => m.id === sinceMessageId);
      if (idx >= 0) msgs = msgs.slice(idx + 1);
    }
    if (limit !== undefined) msgs = msgs.slice(0, limit);
    return { thread: t, messages: msgs };
  }

  appendMessage(threadId: string, type: string, payload: unknown, attribution?: string): Message | undefined {
    const t = this.threads.get(threadId);
    if (!t) return undefined;
    const msg: Message = {
      id: mintId('msg'),
      thread_id: threadId,
      type,
      payload,
      attribution,
      created_at: Date.now(),
    };
    const arr = this.messages.get(threadId) ?? [];
    arr.push(msg);
    this.messages.set(threadId, arr);
    t.updated_at = msg.created_at;
    return msg;
  }

  setState(id: string, state: ThreadState): Thread | undefined {
    const t = this.threads.get(id);
    if (!t) return undefined;
    t.state = state;
    t.updated_at = Date.now();
    return t;
  }

  cancel(id: string, recursive: boolean, reason?: string): { cancelled: string[] } {
    const cancelled: string[] = [];
    const visit = (tid: string) => {
      const t = this.threads.get(tid);
      if (!t) return;
      if (t.state === 'done' || t.state === 'cancelled') return;
      t.state = 'cancelled';
      t.updated_at = Date.now();
      cancelled.push(tid);
      this.appendMessage(tid, 'cancel', { reason: reason ?? 'cancelled' }, 'system');
      if (recursive) {
        const kids = this.childIndex.get(tid) ?? [];
        kids.forEach(visit);
      }
    };
    visit(id);
    return { cancelled };
  }
}

// ============================================================================
// Approvals
// ============================================================================

export type ApprovalState = 'pending' | 'resolved' | 'cancelled';

export interface Approval {
  id: string;
  thread_id: string;
  question: string;
  options: Array<{ value: string; label?: string; description?: string; recommended?: boolean }>;
  allow_freetext: boolean;
  default_view?: string;
  state: ApprovalState;
  answer?: unknown;
  created_at: number;
  resolved_at?: number;
}

export class ApprovalStore {
  private approvals = new Map<string, Approval>();

  request(args: {
    thread_id: string;
    question: string;
    options: Approval['options'];
    allow_freetext?: boolean;
    default_view?: string;
  }): Approval {
    const id = mintId('apr');
    const a: Approval = {
      id,
      thread_id: args.thread_id,
      question: args.question,
      options: args.options,
      allow_freetext: args.allow_freetext ?? false,
      default_view: args.default_view,
      state: 'pending',
      created_at: Date.now(),
    };
    this.approvals.set(id, a);
    return a;
  }

  resolve(id: string, answer: unknown): Approval | undefined {
    const a = this.approvals.get(id);
    if (!a) return undefined;
    if (a.state !== 'pending') return a;
    a.state = 'resolved';
    a.answer = answer;
    a.resolved_at = Date.now();
    return a;
  }

  listPending(threadId?: string): Approval[] {
    return [...this.approvals.values()]
      .filter((a) => a.state === 'pending')
      .filter((a) => !threadId || a.thread_id === threadId)
      .sort((a, b) => a.created_at - b.created_at);
  }
}

// ============================================================================
// Migration helpers
// ============================================================================

/**
 * Lift a legacy single `question` field on an InboxItem into `questions[0]`
 * with a synthesized id ("q1"). Called on every write so the in-memory
 * + DB shapes stay consistent with the new multi-question model. The
 * read-side DB / JSON loaders run the same migration via
 * `migrateLegacyQuestion` in inbox-persistence.ts, so even rows written
 * before this migration shipped still surface correctly.
 */
function promoteLegacyQuestion(item: InboxItem): InboxItem {
  if (Array.isArray(item.questions) && item.questions.length > 0) {
    // Already in new shape — strip the legacy slot if it lingered.
    if (item.question !== undefined) {
      const { question, ...rest } = item as InboxItem & { question?: unknown };
      void question;
      return rest as InboxItem;
    }
    return item;
  }
  const legacy = item.question as
    | (Partial<InboxQuestion> & Record<string, unknown>)
    | undefined;
  if (!legacy || typeof legacy !== 'object' || typeof legacy.prompt !== 'string') {
    return item;
  }
  const promoted: InboxQuestion = {
    id: typeof legacy.id === 'string' && legacy.id ? legacy.id : 'q1',
    prompt: legacy.prompt,
    mode: legacy.mode as InboxQuestion['mode'],
    options: legacy.options as InboxQuestion['options'],
    allow_freeform: legacy.allow_freeform as boolean | undefined,
    placeholder: legacy.placeholder as string | undefined,
    title: legacy.title as string | undefined,
    close_on_answer: legacy.close_on_answer as boolean | undefined,
    closed: legacy.closed as boolean | undefined,
    dispatch: legacy.dispatch as InboxQuestion['dispatch'],
  };
  const { question, ...rest } = item as InboxItem & { question?: unknown };
  void question;
  return { ...rest, questions: [promoted] } as InboxItem;
}

// ============================================================================
// Module-level singletons
// ============================================================================

export const inbox = new InboxStore();
export const threads = new ThreadStore();
export const approvals = new ApprovalStore();
