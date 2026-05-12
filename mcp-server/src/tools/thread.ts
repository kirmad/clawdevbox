/**
 * tools/thread.ts
 *
 * thread.spawn / append_message / read / set_state / cancel / wake — backed
 * by the in-process ThreadStore. `thread.spawn` does NOT spawn the CLI
 * process (per spec §6.1: that's the scheduler's job); it just inserts the row.
 *
 * `thread.wake` records the wake intent and flips state to 'running'. The
 * agent process is re-spawned by whichever component owns the CLI lifecycle
 * (Conductor desktop app's shell-command IPC, or a future scheduler tool).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { logger } from '../logger.ts';
import { notFound, structuredError } from '../scope.ts';
import { inbox, threads, type ThreadState } from '../store.ts';

const threadStateField = z.enum([
  'running',
  'suspended',
  'awaiting_user',
  'done',
  'cancelled',
  'error',
]);

const attributionField = z.enum(['agent', 'user', 'system', 'trigger']).optional();

export function registerThreadTools(server: McpServer): void {
  // -- thread.spawn ---------------------------------------------------------
  server.registerTool(
    'thread.spawn',
    {
      description:
        'Create a thread row (spec §6.1). Does NOT spawn the CLI process — the real scheduler does. Returns the thread id so callers can append_message / read it back.',
      inputSchema: {
        inbox_item_id: z.string().min(1),
        prompt: z.string().min(1),
        recipe_id: z.string().min(1).optional(),
        parent_thread_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const item = inbox.read(args.inbox_item_id);
      if (!item) return notFound('inbox_item', args.inbox_item_id);
      const t = threads.spawn({
        inbox_item_id: args.inbox_item_id,
        prompt: args.prompt,
        recipe_id: args.recipe_id,
        parent_thread_id: args.parent_thread_id,
      });
      return {
        content: [{ type: 'text', text: `Spawned thread ${t.id} (recipe=${t.recipe_id ?? 'none'}).` }],
        structuredContent: { thread: t },
      };
    },
  );

  // -- thread.append_message ------------------------------------------------
  server.registerTool(
    'thread.append_message',
    {
      description:
        'Append a message to a thread. The side-terminal agent calls this after every meaningful step so the user sees its progress (spec §12).',
      inputSchema: {
        thread_id: z.string().min(1),
        type: z.string().min(1).describe("Message type — e.g., 'agent_text', 'tool_call', 'tool_result', 'view_emitted'."),
        payload: z.unknown(),
        attribution: attributionField,
      },
    },
    async (args) => {
      const m = threads.appendMessage(args.thread_id, args.type, args.payload, args.attribution);
      if (!m) return notFound('thread', args.thread_id);
      return {
        content: [{ type: 'text', text: `Appended message ${m.id} to ${args.thread_id} (type=${args.type}).` }],
        structuredContent: { message: m },
      };
    },
  );

  // -- thread.read ----------------------------------------------------------
  server.registerTool(
    'thread.read',
    {
      description: 'Read a thread row + its messages (optionally since a message id; optionally capped).',
      inputSchema: {
        thread_id: z.string().min(1),
        since_message_id: z.string().min(1).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async (args) => {
      const out = threads.read(args.thread_id, args.since_message_id, args.limit);
      if (!out) return notFound('thread', args.thread_id);
      return {
        content: [
          {
            type: 'text',
            text: `thread ${out.thread.id} [${out.thread.state}]; ${out.messages.length} message(s)`,
          },
        ],
        structuredContent: out,
      };
    },
  );

  // -- thread.set_state -----------------------------------------------------
  server.registerTool(
    'thread.set_state',
    {
      description: 'Transition a thread to a new state.',
      inputSchema: {
        thread_id: z.string().min(1),
        state: threadStateField,
        reason: z.string().optional(),
      },
    },
    async (args) => {
      const t = threads.setState(args.thread_id, args.state as ThreadState);
      if (!t) return notFound('thread', args.thread_id);
      if (args.reason) {
        threads.appendMessage(args.thread_id, 'state_change', { state: args.state, reason: args.reason }, 'system');
      }
      return {
        content: [{ type: 'text', text: `Set thread ${t.id} → ${t.state}.` }],
        structuredContent: { thread: t },
      };
    },
  );

  // -- thread.cancel --------------------------------------------------------
  server.registerTool(
    'thread.cancel',
    {
      description: 'Cancel a thread (and optionally its descendants). The cascade is the only kill switch (mission-memory: no wallclock budgets).',
      inputSchema: {
        thread_id: z.string().min(1),
        recursive: z.boolean().optional(),
        reason: z.string().optional(),
      },
    },
    async (args) => {
      // Make sure thread exists first
      const t = threads.read(args.thread_id);
      if (!t) return notFound('thread', args.thread_id);
      const result = threads.cancel(args.thread_id, args.recursive ?? true, args.reason);
      return {
        content: [{ type: 'text', text: `Cancelled ${result.cancelled.length} thread(s).` }],
        structuredContent: result,
      };
    },
  );

  // -- thread.wake ----------------------------------------------------------
  server.registerTool(
    'thread.wake',
    {
      description:
        'Wake a suspended thread: record a `wake_requested` message and flip the thread state to `running`. The host (Conductor desktop app or external scheduler) is responsible for re-spawning the underlying CLI process — this tool only updates the kernel state and emits the intent so any subscriber can act.',
      inputSchema: { thread_id: z.string().min(1) },
    },
    async (args) => {
      const t = threads.read(args.thread_id);
      if (!t) return notFound('thread', args.thread_id);
      logger.info({ threadId: args.thread_id }, 'thread.wake requested');
      threads.appendMessage(args.thread_id, 'wake_requested', { ts: Date.now() }, 'system');
      const updated = threads.setState(args.thread_id, 'running');
      if (!updated) {
        return structuredError('UNKNOWN_THREAD_STATE', `Thread ${args.thread_id} disappeared between read and set_state.`);
      }
      return {
        content: [{ type: 'text', text: `Woke thread ${args.thread_id}.` }],
        structuredContent: { thread: updated },
      };
    },
  );
}
