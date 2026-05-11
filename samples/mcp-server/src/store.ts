/**
 * store.ts
 *
 * In-memory state for inbox items, threads, messages, and approvals.
 *
 * This is a stub — the real Conductor sidecar persists this in better-sqlite3
 * (see spec §5 "Data model"). We mirror the same row shapes so the tool
 * surface (§6.1) is identical; only durability differs. The store is module-
 * scoped: a single Process = a single in-memory DB. Each call to a tool
 * resolves through these maps.
 *
 * All ids generated here use a coarse `<prefix>_<base36-random>` pattern so
 * the output is human-recognizable in test logs without pulling in nanoid.
 */

// ============================================================================
// Id minting
// ============================================================================

function rand36(): string {
  return Math.random().toString(36).slice(2, 10);
}
export function mintId(prefix: 'inb' | 'thr' | 'msg' | 'apr' | 'run'): string {
  return `${prefix}_${rand36()}`;
}

// ============================================================================
// Inbox
// ============================================================================

export type InboxState = 'new' | 'open' | 'snoozed' | 'archived' | 'done';
export type AgentTone = 'info' | 'warn' | 'err' | 'ok';

export interface InboxItem {
  id: string;
  kind: string;                  // 'pr_review' | 'workitem' | 'incident' | 'epic' | string
  source: string;                // 'ado' | 'icm' | 'manual' | ...
  title?: string;
  agent_message?: string;
  agent_tone?: AgentTone;
  state: InboxState;
  snoozed_until?: number;        // unix ms
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface InboxPatch {
  kind?: string;
  source?: string;
  title?: string;
  agent_message?: string;
  agent_tone?: AgentTone;
  [k: string]: unknown;
}

export class InboxStore {
  private items = new Map<string, InboxItem>();

  upsert(id: string, kind: string, source: string, patch: InboxPatch = {}): InboxItem {
    const now = Date.now();
    const existing = this.items.get(id);
    if (existing) {
      const merged: InboxItem = { ...existing, ...patch, kind, source, updated_at: now };
      this.items.set(id, merged);
      return merged;
    }
    const created: InboxItem = {
      id,
      kind,
      source,
      state: 'new',
      created_at: now,
      updated_at: now,
      ...patch,
    };
    this.items.set(id, created);
    return created;
  }

  read(id: string): InboxItem | undefined {
    return this.items.get(id);
  }

  list(filter: { kind?: string; state?: InboxState; limit?: number; cursor?: string } = {}): InboxItem[] {
    const arr = [...this.items.values()]
      .filter((it) => !filter.kind || it.kind === filter.kind)
      .filter((it) => !filter.state || it.state === filter.state)
      .sort((a, b) => b.updated_at - a.updated_at);
    const startIdx = filter.cursor ? Math.max(0, arr.findIndex((x) => x.id === filter.cursor) + 1) : 0;
    const limit = filter.limit ?? 100;
    return arr.slice(startIdx, startIdx + limit);
  }

  setState(id: string, state: InboxState): InboxItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.state = state;
    item.updated_at = Date.now();
    return item;
  }

  snooze(id: string, until: number): InboxItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    item.state = 'snoozed';
    item.snoozed_until = until;
    item.updated_at = Date.now();
    return item;
  }

  archive(id: string): InboxItem | undefined {
    return this.setState(id, 'archived');
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
// Module-level singletons
// ============================================================================

export const inbox = new InboxStore();
export const threads = new ThreadStore();
export const approvals = new ApprovalStore();
