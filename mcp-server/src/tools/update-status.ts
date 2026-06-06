/**
 * tools/update-status.ts
 *
 * MCP tool: update_status — agents call this to tell the user what they're
 * doing. Three text fields render as three lines in the tab:
 *
 *   task_title    — line 1 (bold)   — sticky overall goal of this terminal
 *   subtask_title — line 2 (muted)  — current sub-goal (optional)
 *   status        — line 3 (dim)    — brief one-line state
 *
 * Tri-state semantics per field:
 *   - undefined  → leave column unchanged (sticky — agent can update one
 *                  field without re-sending the others)
 *   - ""         → CLEAR the column (e.g. when a subtask finishes)
 *   - non-empty  → SET the new value
 *
 * Plus two boolean control flags:
 *   - needs_user_input=true → "waiting" badge + resolves pending dispatch
 *   - task_complete=true    → exactly-once per dispatched prompt;
 *                             resolves pending dispatch
 *
 * Correlation: routes by `cli_session_id` (unique per spawn).
 *   1. Explicit `session_id` arg (delivered to agent via initial-prompt
 *      prefix — see recipe-runner.buildSessionIdPromptPrefix)
 *   2. X-Clawdevbox-Session-Id HTTP header (per-spawn .mcp.json)
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
import { setPtyStatusFields } from '../pty-registry.ts';
import { emitChange } from '../event-bus.ts';
import { getDatabase } from '../db/index.ts';
import type { Workspace } from '../workspace.ts';

const FIELD_CAP = 4096;

export interface UpdateStatusArgs {
  task_title?: string;
  subtask_title?: string;
  status?: string;
  /** Legacy v9 synonym for `status`. Kept so older agents don't break. */
  status_text?: string;
  needs_user_input?: boolean;
  task_complete?: boolean;
  /**
   * Explicit cli_session_id. The initial prompt prefix always includes the
   * session id; agents should pass it back here for rock-solid correlation.
   * Falls back to X-Clawdevbox-Session-Id header / CLAWDEVBOX_SESSION_ID env.
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
  /** True iff a status field actually landed somewhere (DB or in-memory). */
  applied: boolean;
}

/**
 * Pure-function normalizer for the three text fields. Cap each one at
 * FIELD_CAP. Returns the args wrapped in the tri-state shape consumed
 * by the store + pty-registry helpers.
 */
function normalizeFields(a: UpdateStatusArgs): {
  taskTitle?: string;
  subtaskTitle?: string;
  status?: string;
} {
  const out: { taskTitle?: string; subtaskTitle?: string; status?: string } = {};
  if (a.task_title !== undefined) out.taskTitle = a.task_title.slice(0, FIELD_CAP);
  if (a.subtask_title !== undefined) out.subtaskTitle = a.subtask_title.slice(0, FIELD_CAP);
  // `status` and the legacy `status_text` are synonyms. Prefer `status`
  // when both are provided (newer name wins).
  if (a.status !== undefined) out.status = a.status.slice(0, FIELD_CAP);
  else if (a.status_text !== undefined) out.status = a.status_text.slice(0, FIELD_CAP);
  return out;
}

export async function handleUpdateStatus(
  ctx: UpdateStatusCtx,
  args: UpdateStatusArgs,
): Promise<UpdateStatusResult> {
  const fields = normalizeFields(args);
  const needs_user_input = !!args.needs_user_input;
  const task_complete = !!args.task_complete;
  const now = Date.now();

  let applied = false;
  if (ctx.cliSessionId) {
    // /spawn'd sessions have agent_sessions rows — DB path.
    try {
      const dbHit = updateStatusBySessionId(ctx.db, ctx.cliSessionId, {
        taskTitle: fields.taskTitle,
        subtaskTitle: fields.subtaskTitle,
        status: fields.status,
        needsUserInput: needs_user_input,
        ts: now,
      });
      if (dbHit) applied = true;
    } catch {
      // Row may not exist; fall through to in-memory path.
    }
    // Main Agent has no DB row; pty-registry mirrors the fields in-memory.
    // Both paths can succeed (idempotent).
    try {
      const memHit = setPtyStatusFields(ctx.cliSessionId, fields);
      if (memHit) applied = true;
    } catch { /* nothing */ }
    if (applied) emitChange('sessions');
  }
  // Pending-dispatch resolution stays keyed by recipe_instance_id.
  // Semantically correct: a recipe instance completes when any step
  // calls done with task_complete (multi-step recipes can have N agent
  // sessions per one recipe instance).
  if (ctx.recipeInstanceId && (task_complete || needs_user_input)) {
    const pending = getPending(ctx.recipeInstanceId);
    if (pending) {
      // Pass a single concatenated text for the legacy resolvePending
      // signature so anyone observing the resolved payload still gets
      // a useful summary.
      const summary = [fields.taskTitle, fields.subtaskTitle, fields.status]
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
        .join(' • ');
      resolvePending(ctx.recipeInstanceId, pending.dispatchId, {
        status_text: summary,
        needs_user_input,
        task_complete,
        doneAt: now,
      });
    }
  }
  return { ok: true, applied };
}

const updateStatusParams = z.object({
  task_title: z
    .string()
    .max(FIELD_CAP)
    .optional()
    .describe(
      'OVERALL GOAL of this terminal. Sticky — set this ONCE per major goal change. Line 1 of the tab (bold). Example: "Refactor authentication module".',
    ),
  subtask_title: z
    .string()
    .max(FIELD_CAP)
    .optional()
    .describe(
      'CURRENT SUB-GOAL the agent is working on. Optional. Line 2 of the tab (medium muted). Pass "" to clear when the subtask is done. Example: "Migrating User model to TypeScript".',
    ),
  status: z
    .string()
    .max(FIELD_CAP)
    .optional()
    .describe(
      'BRIEF ONE-LINE STATE. Line 3 of the tab (small dim). Pass "" to clear. Example: "Reading src/auth/user.ts" or "Running tests (37/120)".',
    ),
  status_text: z
    .string()
    .max(FIELD_CAP)
    .optional()
    .describe(
      'Legacy v9 synonym for `status`. Prefer the three split fields above. Kept for backward compatibility.',
    ),
  needs_user_input: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'True if you cannot proceed without user clarification. Surfaces a "waiting" badge AND marks the dispatched prompt done (you are blocked).',
    ),
  task_complete: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'True exactly once when you finish the current dispatched prompt. REQUIRED — the orchestrator blocks the next dispatch until you call this.',
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      'Your cli session id (the GUID clawdevbox put in the initial prompt prefix `[clawdevbox] Your session id is X`). Pass this for rock-solid correlation in shared workspaces / for subagents. Falls back to X-Clawdevbox-Session-Id header.',
    ),
});

export function registerUpdateStatusEntries(_ws: Workspace): void {
  defineTool({
    name: 'update_status',
    description: `Tell clawdevbox what this terminal is doing. The three text fields render as three lines in the user's Terminals tab so they see at a glance what every agent is working on.

  • task_title    (line 1, bold)  — OVERALL GOAL. Set once per major goal.
  • subtask_title (line 2, muted) — current sub-goal. Pass "" to clear.
  • status        (line 3, dim)   — brief one-line state. Pass "" to clear.

Tri-state per field:
  • omit            → leave unchanged (sticky)
  • ""              → CLEAR the line
  • non-empty       → SET to the new value

Control flags (separate from the text fields):
  • task_complete=true    — REQUIRED, exactly once per dispatched prompt.
  • needs_user_input=true — if you can't proceed without clarification.

Correlation: pass session_id (from the [clawdevbox] prefix in your initial
prompt) for the most reliable per-tab routing — especially when you're a
subagent or are in a workspace shared with sibling spawns.

EXAMPLES (typical agent flow):

  // At the start of work:
  update_status({
    task_title: "Refactor authentication module",
    status: "Reading existing code",
    session_id: "<your-id>"
  })

  // When you pick up a subtask:
  update_status({
    subtask_title: "Migrating User model to TypeScript",
    status: "Updating src/models/user.ts",
    session_id: "<your-id>"
  })

  // Brief status update mid-subtask:
  update_status({ status: "Running tests (37/120)", session_id: "<your-id>" })

  // Subtask done:
  update_status({ subtask_title: "", status: "All tests pass", session_id: "<your-id>" })

  // Done with the dispatched prompt:
  update_status({
    status: "Done — opened PR #4547615",
    task_complete: true,
    session_id: "<your-id>"
  })`,
    parameters: updateStatusParams,
    handler: async (args, extra) => {
      const a = args as UpdateStatusArgs;
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
        description: 'Set the overall goal at the start',
        args: {
          task_title: 'Refactor authentication module',
          status: 'Reading existing code',
          session_id: '<sid>',
        },
      },
      {
        description: 'Update subtask + status as you progress',
        args: {
          subtask_title: 'Migrating User model to TypeScript',
          status: 'Updating src/models/user.ts',
          session_id: '<sid>',
        },
      },
      {
        description: 'Clear subtask when done with it',
        args: {
          subtask_title: '',
          status: 'All tests pass',
          session_id: '<sid>',
        },
      },
      {
        description: 'Mark dispatched prompt complete',
        args: {
          status: 'Done — opened PR #4547615',
          task_complete: true,
          session_id: '<sid>',
        },
      },
      {
        description: 'Block on user clarification',
        args: {
          status: 'Need to know whether to delete or archive old recipes',
          needs_user_input: true,
          session_id: '<sid>',
        },
      },
    ],
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
