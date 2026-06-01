/**
 * tools/update-status.ts
 *
 * MCP tool: update_status — agents call this to:
 *   1. Report progress (status_text only) — purely informational.
 *   2. Signal completion (task_complete=true) — resolves the pending dispatch
 *      so the dispatcher can deliver the next prompt.
 *   3. Signal a user-input block (needs_user_input=true) — also resolves the
 *      pending dispatch and surfaces a "needs you" badge in the UI.
 *
 * This replaces sentinel-marker-in-stdout done detection. Each turn now has
 * exactly one authoritative completion signal: the agent calling this tool.
 */

import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { defineTool } from './registry.ts';
import { resolveRecipeInstanceId } from '../context-resolver.ts';
import { getPending, resolvePending } from '../pending-dispatch-registry.ts';
import { updateStatus } from '../db/agent-sessions-store.ts';
import { emitChange } from '../event-bus.ts';
import { getDatabase } from '../db/index.ts';
import type { Workspace } from '../workspace.ts';

const STATUS_TEXT_CAP = 4096;

export interface UpdateStatusArgs {
  status_text: string;
  needs_user_input: boolean;
  task_complete: boolean;
}

export interface UpdateStatusCtx {
  db: Database;
  instanceId: string | null;
}

export async function handleUpdateStatus(
  ctx: UpdateStatusCtx,
  args: UpdateStatusArgs,
): Promise<{ ok: true }> {
  const status_text = (args.status_text ?? '').slice(0, STATUS_TEXT_CAP);
  const needs_user_input = !!args.needs_user_input;
  const task_complete = !!args.task_complete;
  const now = Date.now();

  if (ctx.instanceId) {
    try {
      updateStatus(ctx.db, ctx.instanceId, {
        text: status_text || null,
        needs_user_input,
        ts: now,
      });
      emitChange('sessions');
    } catch {
      // Row may not exist (e.g., orphan agent / unit-test path); ignore.
    }
    if (task_complete || needs_user_input) {
      const pending = getPending(ctx.instanceId);
      if (pending) {
        resolvePending(ctx.instanceId, pending.dispatchId, {
          status_text,
          needs_user_input,
          task_complete,
          doneAt: now,
        });
      }
    }
  }
  return { ok: true };
}

const updateStatusParams = z.object({
  status_text: z
    .string()
    .max(STATUS_TEXT_CAP)
    .describe(
      'Short human-readable status, e.g. "Searching for foo", "Running tests", "Done — wrote 3 files".',
    ),
  needs_user_input: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'True if you cannot proceed without user clarification. The UI surfaces this as a "needs you" badge AND marks the dispatched prompt as done (since the agent is blocked waiting for the user).',
    ),
  task_complete: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'True exactly once when you finish responding to the current dispatched prompt. REQUIRED — the orchestrator blocks the next dispatch until you call this.',
    ),
});

export function registerUpdateStatusEntries(ws: Workspace): void {
  defineTool({
    name: 'update_status',
    description: `Report your current status to clawdevbox.

Call this:
  • Periodically during long operations — keeps the orchestrator and user informed of progress.
  • Exactly once with task_complete=true when you finish responding to the current dispatched prompt. REQUIRED — the orchestrator blocks the next dispatch until you do this.
  • With needs_user_input=true if you cannot proceed without clarification from the user (also marks the dispatched prompt as done since you are blocked).`,
    parameters: updateStatusParams,
    handler: async (args, extra) => {
      const instanceId = resolveRecipeInstanceId(extra);
      const result = await handleUpdateStatus(
        { db: getDatabase(), instanceId },
        args as UpdateStatusArgs,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
    examples: [
      {
        description: 'Progress update mid-task',
        args: { status_text: 'Searching codebase for usages of foo()' },
      },
      {
        description: 'Mark dispatched prompt complete',
        args: { status_text: 'Done — updated 3 files', task_complete: true },
      },
      {
        description: 'Block on user clarification',
        args: {
          status_text: 'Need to know whether to delete or archive old recipes',
          needs_user_input: true,
        },
      },
    ],
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
