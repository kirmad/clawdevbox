/**
 * tools/update-status.ts
 *
 * MCP tool: update_status — agents call this to:
 *   1. Report progress (status_text) — surfaced as the tab title in the UI.
 *   2. Signal completion (task_complete=true) — resolves the pending dispatch
 *      so the dispatcher can deliver the next prompt.
 *   3. Signal a user-input block (needs_user_input=true) — also resolves the
 *      pending dispatch and surfaces a "needs you" badge in the UI.
 *
 * Correlation: the tool routes the update by `cli_session_id` (the agent
 * CLI's unique per-spawn session GUID), NOT by recipe_instance_id —
 * recipe_instance_id is shared by multi-step recipes whose steps all need
 * distinct tab labels.
 *
 * Resolution chain for the session id:
 *   1. Explicit `session_id` tool argument (provided by the agent — clawdevbox
 *      always prefixes the initial prompt with the session id and instructs
 *      the agent to pass it back, so this path always works)
 *   2. X-Clawdevbox-Session-Id HTTP header (set in writeMcpJson per spawn)
 *   3. CLAWDEVBOX_SESSION_ID env var (stdio mode only)
 *
 * Pending-dispatch resolution stays keyed by recipe_instance_id (semantically
 * correct: a recipe instance completes when any step calls done).
 */

import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { defineTool } from './registry.ts';
import { resolveAgentSessionId, resolveRecipeInstanceId } from '../context-resolver.ts';
import { getPending, resolvePending } from '../pending-dispatch-registry.ts';
import { updateStatusBySessionId } from '../db/agent-sessions-store.ts';
import { setPtyStatusText } from '../pty-registry.ts';
import { emitChange } from '../event-bus.ts';
import { getDatabase } from '../db/index.ts';
import type { Workspace } from '../workspace.ts';

const STATUS_TEXT_CAP = 4096;

export interface UpdateStatusArgs {
  status_text: string;
  needs_user_input: boolean;
  task_complete: boolean;
  /**
   * Optional explicit cli_session_id. The initial prompt always includes
   * "[clawdevbox] Your session id is `<sid>`. Pass session_id=<sid> in
   * update_status calls." so the agent has it. Falls back to header / env.
   */
  session_id?: string;
}

export interface UpdateStatusCtx {
  db: Database;
  /** Recipe instance id (for pending-dispatch resolution; may be null). */
  recipeInstanceId: string | null;
  /** CLI session id (for status text correlation; may be null in tests). */
  cliSessionId: string | null;
}

export interface UpdateStatusResult {
  ok: true;
  /** True iff the status text actually landed somewhere (DB or in-memory). */
  applied: boolean;
}

export async function handleUpdateStatus(
  ctx: UpdateStatusCtx,
  args: UpdateStatusArgs,
): Promise<UpdateStatusResult> {
  const status_text = (args.status_text ?? '').slice(0, STATUS_TEXT_CAP);
  const needs_user_input = !!args.needs_user_input;
  const task_complete = !!args.task_complete;
  const now = Date.now();

  let applied = false;
  if (ctx.cliSessionId) {
    // Try the DB path first — /spawn'd sessions have agent_sessions rows.
    try {
      const dbHit = updateStatusBySessionId(ctx.db, ctx.cliSessionId, {
        text: status_text || null,
        needs_user_input,
        ts: now,
      });
      if (dbHit) applied = true;
    } catch {
      // Row may not exist; fall through to in-memory path.
    }
    // Also try the in-memory pty-registry path — the Main Agent has no
    // DB row but is in the registry. Both paths can succeed (idempotent).
    try {
      const memHit = setPtyStatusText(ctx.cliSessionId, status_text || null);
      if (memHit) applied = true;
    } catch { /* nothing */ }
    if (applied) emitChange('sessions');
  }
  // Pending-dispatch resolution stays keyed by recipe_instance_id —
  // semantically correct: a recipe instance completes when any step
  // calls done with task_complete.
  if (ctx.recipeInstanceId && (task_complete || needs_user_input)) {
    const pending = getPending(ctx.recipeInstanceId);
    if (pending) {
      resolvePending(ctx.recipeInstanceId, pending.dispatchId, {
        status_text,
        needs_user_input,
        task_complete,
        doneAt: now,
      });
    }
  }
  return { ok: true, applied };
}

const updateStatusParams = z.object({
  status_text: z
    .string()
    .max(STATUS_TEXT_CAP)
    .describe(
      'Short human-readable status, e.g. "Searching for foo", "Running tests", "Done — wrote 3 files". This becomes the tab title in the clawdevbox Terminals tab.',
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
  session_id: z
    .string()
    .optional()
    .describe(
      'Optional: your cli session id (the GUID clawdevbox told you in the initial prompt prefix `[clawdevbox] Your session id is X`). Use this when the HTTP header may be stale (shared workspace, subagents). When omitted, the server falls back to the X-Clawdevbox-Session-Id request header.',
    ),
});

export function registerUpdateStatusEntries(ws: Workspace): void {
  defineTool({
    name: 'update_status',
    description: `Report your current status to clawdevbox. The status_text becomes your tab's title in the Terminals tab so users at a glance see what you're working on.

Call this:
  • Whenever you start a new sub-task — set status_text to a short description ("Refactoring auth module", "Running tests").
  • Periodically during long operations — keeps the orchestrator and user informed of progress.
  • Exactly once with task_complete=true when you finish responding to the current dispatched prompt. REQUIRED — the orchestrator blocks the next dispatch until you do this.
  • With needs_user_input=true if you cannot proceed without clarification from the user (also marks the dispatched prompt as done since you are blocked).

If you know your session id (clawdevbox prefixes every initial prompt with it), pass session_id explicitly — it makes correlation rock-solid even in shared workspaces or for subagents.`,
    parameters: updateStatusParams,
    handler: async (args, extra) => {
      const a = args as UpdateStatusArgs;
      // Resolution: explicit arg > header > env. Header resolver also
      // covers env fallback for stdio-mode.
      const cliSessionId = (a.session_id && a.session_id.trim().length > 0)
        ? a.session_id.trim()
        : resolveAgentSessionId(extra);
      const recipeInstanceId = resolveRecipeInstanceId(extra);
      const result = await handleUpdateStatus(
        { db: getDatabase(), cliSessionId, recipeInstanceId },
        a,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
    examples: [
      {
        description: 'Progress update — becomes tab title',
        args: { status_text: 'Refactoring authentication module' },
      },
      {
        description: 'Pass session_id explicitly (most reliable)',
        args: {
          status_text: 'Running test suite',
          session_id: 'b9a899cf-901e-4474-8981-a3b08d49b9a9',
        },
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
