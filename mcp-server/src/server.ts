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
import { discoverAndRegisterHostedTools, type HostedToolError } from './tools/hosted.ts';

export interface BuiltServer {
  server: McpServer;
  hostedErrors: HostedToolError[];
}

export const SERVER_NAME = 'clawdevbox';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = `Clawdevbox MCP surface. All functionality is accessed through three meta-tools: list_tools, learn_tool, run_tool.

IMPORTANT: Before using any tool for the first time in a session, you MUST call learn_tool with that tool's name to understand its parameters, usage patterns, and constraints. Only then should you call run_tool.

Workflow:
1. list_tools — discover what's available (optionally filter by keyword)
2. learn_tool — understand how to use specific tools (batch multiple names)
3. run_tool — execute with correct parameters`;

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

