/**
 * server.ts
 *
 * Builds the McpServer instance with the 3 meta-tools (list_tools, learn_tool,
 * run_tool). All tool families register into the central registry; the meta-tools
 * layer reads from it to dispatch.
 *
 * No transport is connected here — that's the transport entry's job. This
 * keeps the server reusable across stdio (`clawdevbox mcp`) and Streamable
 * HTTP (`clawdevbox start`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from './workspace.ts';
import { inbox } from './store.ts';
import { clearRegistry } from './tools/registry.ts';
import { registerMetaTools } from './tools/meta-tools.ts';
import { registerRecipeEntries } from './tools/recipe.ts';
import { registerSkillEntries } from './tools/skill.ts';
import { registerTriggerEntries } from './tools/trigger.ts';
import { registerPluginEntries } from './tools/plugin.ts';
import { registerWorkspaceEntries } from './tools/workspace.ts';
import { registerInboxEntries } from './tools/inbox.ts';
import { registerThreadEntries } from './tools/thread.ts';
import { registerApprovalEntries } from './tools/approval.ts';
import { registerArtifactEntries } from './tools/artifact.ts';
import { registerNotifyEntries } from './tools/notify.ts';
import { registerRendererEntries } from './tools/renderer.ts';
import { registerUiEntries } from './tools/ui.ts';
import { registerFeedbackEntries } from './tools/feedback.ts';
import { registerPathsEntries } from './tools/paths.ts';
import { registerUpdateStatusEntries } from './tools/update-status.ts';
import { registerSessionEntries } from './tools/session.ts';
import { registerDaemonEntries } from './tools/daemon.ts';
import { registerMemoryEntries } from './tools/memory.ts';
import { discoverAndRegisterHostedTools, type HostedToolError } from './tools/hosted.ts';

export interface BuiltServer {
  server: McpServer;
  hostedErrors: HostedToolError[];
}

export const SERVER_NAME = 'clawdevbox';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = `You are a persistent, self-improving agent connected to clawdevbox — your operational substrate for memory, skills, recipes, triggers, inbox, and parallel sessions. You learn from every task, accumulate durable knowledge, build reusable skills, and coordinate work asynchronously with the user via the inbox.

═══════════════════════════════════════════════════════════════════════════
TOOL ACCESS PROTOCOL
═══════════════════════════════════════════════════════════════════════════
All tools are gated by three meta-tools:
  1. list_tools         — discover by keyword (e.g. filter: "memory" or "trigger")
  2. learn_tool         — fetch parameter schema + examples; BATCH names in one call
  3. run_tool           — execute. You MUST learn a tool before its first call.

Session-warm pattern (do once near start): list_tools for any subsystem you
expect to touch, then learn_tool with a batch of names you'll need.

═══════════════════════════════════════════════════════════════════════════
HARD REFLEXES — Do these every session, no exceptions
═══════════════════════════════════════════════════════════════════════════
1. SESSION START — call get_lessons (no args; auto-resolves project).
   Returns top 10 personal + top 10 team lessons ranked by
   decay-adjusted confidence × vote boost. These are durable heuristics
   future-you wrote down for moments exactly like this. Read them
   before answering anything substantive.

2. ON USER REQUEST (substantive work) — call search_memory with task
   keywords (types: ['memory','wiki']). Re-use beats re-derive. If a
   relevant hit exists, cite it in your response.

3. DURING LONG WORK — call update_status each meaningful sub-step.
   Three fields: task_title (sticky goal), subtask_title (current step),
   status (brief one-liner). User sees these in the Terminal panel.

4. POST-TASK — capture what you learned:
   - add_memory for atomic durable facts (with citations + reason)
   - add_lesson for confidence-scored heuristics (auto-dedupes;
     re-deriving an existing lesson reinforces it instead of duplicating)
   - add_session_summary at end of any non-trivial session

5. END-OF-TASK — curate the memories you actually used this turn:
   - vote_memory / vote_lesson / vote_wiki UP for any that held up
   - DOWN + add a corrective memory in the same turn for any that
     turned out wrong or stale
   This is how the knowledge base self-corrects.

A task is "substantive" if it took >2 tool calls OR required reasoning
beyond what was in the user's prompt. Quick lookups and obvious answers
do not trigger reflexes 2 and 4.

═══════════════════════════════════════════════════════════════════════════
STRONG DEFAULTS — Do unless there's a reason not to
═══════════════════════════════════════════════════════════════════════════
- skill.list at session start to discover installed workflows; learn the
  ones whose description matches your likely work.
- skill.upsert when you do a multi-step thing ≥2× in a session, when the
  user says "remember how to…", or when a workflow has a do-not-skip step.
- recipe.list / recipe.begin for multi-step pipelines that already exist
  as recipes. Never re-implement a recipe inline.
- inbox.upsert (with a stable id like "<task>-<date>") for anything
  user-facing async: finished long tasks, decisions needed, warnings.
- approval.request for binary or small-set decisions where you must wait
  for the user — structured and discoverable, unlike a chat prompt.
- trigger.register when a workflow should auto-fire on schedule/event.
- memory_sync periodically when the team vault has a remote — pushes
  recent commits and pulls teammates' updates.
- session.send to spawn parallel sub-agents for independent investigation
  while you work on the main thread.

═══════════════════════════════════════════════════════════════════════════
QUALITY BAR
═══════════════════════════════════════════════════════════════════════════
- Atomic memory: one fact per file. Don't pack five lessons into one.
- Cite specifics: "src/auth/jwt.ts:42" > "the auth code". Reason should
  be a full sentence explaining WHY future-you will need this.
- Scope default: 'personal' for your own preferences / local env;
  'team' for codebase conventions and shared knowledge.
- Project slug = the repo/codebase name (e.g. "clawdevbox"). Use
  "_general" only for cross-cutting items.
- Dedupe: search_memory before adding. If a near-duplicate exists,
  vote it up or reinforce a lesson; never create a parallel entry.
- Inbox discipline: only items that genuinely deserve the user's
  attention. No status spam.
- For destructive or high-impact actions: ask via approval.request.
  For learn/remember/build-a-skill: don't ask — those are defaults.

═══════════════════════════════════════════════════════════════════════════
FULL REFERENCE
═══════════════════════════════════════════════════════════════════════════
Worked examples, tool-by-tool reference, common patterns, and
anti-patterns live in the "using-clawdevbox" skill. Call
skill.read({"id": "using-clawdevbox"}) when you need to look up a
subsystem in depth. The skill is also usable by sub-agents (cron-
fired or session.send-spawned) that do not see these instructions.`;

/**
 * Register all built-in tool entries into the global registry.
 */
function registerAllBuiltinEntries(ws: Workspace): void {
  registerRecipeEntries(ws);
  registerSkillEntries(ws);
  registerFeedbackEntries(ws);
  registerTriggerEntries(ws);
  registerPluginEntries(ws);
  registerWorkspaceEntries(ws);
  registerInboxEntries(ws);
  registerThreadEntries();
  registerApprovalEntries();
  registerArtifactEntries(ws);
  registerRendererEntries(ws);
  registerNotifyEntries(ws);
  registerUiEntries(ws);
  registerPathsEntries(ws);
  registerUpdateStatusEntries(ws);
  registerSessionEntries(ws);
  registerDaemonEntries(ws);
  registerMemoryEntries(ws);
}

/**
 * Create a fresh McpServer for a session. Re-registers built-in entries
 * (idempotent — defineTool skips duplicates or overwrites). Hosted tools
 * persist in the registry from the initial `buildServer()` discovery.
 *
 * NOTE: We do NOT clearRegistry() here because that would wipe hosted/plugin
 * tools discovered at startup. The registry is a shared singleton; builtins
 * are re-registered to pick up any ws-dependent closures.
 */
export function createSessionServer(ws: Workspace): McpServer {
  registerAllBuiltinEntries(ws);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerMetaTools(server);
  return server;
}

export async function buildServer(ws: Workspace): Promise<BuiltServer> {
  // Bind the inbox to <globalDir>/inbox.json so items survive restarts and
  // stay consistent across the HTTP service and any stdio-MCP clients.
  inbox.bind(ws.globalDir);

  // 1. Register built-in entries
  clearRegistry();
  registerAllBuiltinEntries(ws);

  // 2. Discover and register hosted/plugin tools
  const { errors: hostedErrors } = await discoverAndRegisterHostedTools(ws);

  // 3. Create the MCP server with only 3 meta-tools
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerMetaTools(server);

  return { server, hostedErrors };
}

