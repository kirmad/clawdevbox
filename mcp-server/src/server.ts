/**
 * server.ts
 *
 * Builds the McpServer instance, registers every tool family, and returns
 * the wired-up server plus the hosted-tool registry so callers (stdio + http
 * transports) can report counts in their boot log.
 *
 * No transport is connected here — that's the transport entry's job. This
 * keeps the server reusable across stdio (`clawdevbox mcp`) and Streamable
 * HTTP (`clawdevbox start`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Workspace } from './workspace.ts';
import { inbox } from './store.ts';
import { registerRecipeTools } from './tools/recipe.ts';
import { registerSkillTools } from './tools/skill.ts';
import { registerTriggerTools } from './tools/trigger.ts';
import { registerPluginTools } from './tools/plugin.ts';
import { registerWorkspaceTools } from './tools/workspace.ts';
import { registerInboxTools } from './tools/inbox.ts';
import { registerThreadTools } from './tools/thread.ts';
import { registerApprovalTools } from './tools/approval.ts';
import { registerArtifactTools } from './tools/artifact.ts';
import { registerNotifyTools } from './tools/notify.ts';
import { registerRendererTools } from './tools/renderer.ts';
import { registerUiTools } from './tools/ui.ts';
import { discoverTools, registerHostedTools, type HostedToolRegistry } from './tools/hosted.ts';
import { registerFeedbackTools } from './tools/feedback.ts';
import { registerPathsTools } from './tools/paths.ts';

export interface BuiltServer {
  server: McpServer;
  hostedRegistry: HostedToolRegistry;
}

export const SERVER_NAME = 'clawdevbox';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS =
  "Clawdevbox's central MCP surface. Tool families: recipe.* (file-backed; recipe.run/.done/.instance_info manage spawned agent sessions), skill.* (file-backed), trigger.* (file-backed), plugin.* (file-backed + git), workspace.* (file-backed registry of .clawdevbox/ workspaces), inbox.* / thread.* / approval.* (in-process state for this build; SQLite-backed in the next phase), artifact.* (folder-per-id under <workspace>/artifacts/), renderer.* (workspace → plugin → builtin chain).";

export async function buildServer(ws: Workspace): Promise<BuiltServer> {
  // Bind the inbox to <globalDir>/inbox.json so items survive restarts and
  // stay consistent across the HTTP service and any stdio-MCP clients.
  inbox.bind(ws.globalDir);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  registerRecipeTools(server, ws);
  registerSkillTools(server, ws);
  registerFeedbackTools(server, ws);
  registerTriggerTools(server, ws);
  registerPluginTools(server, ws);
  registerWorkspaceTools(server, ws);
  registerInboxTools(server, ws);
  registerThreadTools(server);
  registerApprovalTools(server);
  registerArtifactTools(server, ws);
  registerRendererTools(server, ws);
  registerNotifyTools(server, ws);
  registerUiTools(server, ws);
  registerPathsTools(server, ws);

  const hostedRegistry = await discoverTools(ws);
  registerHostedTools(server, hostedRegistry, ws);

  return { server, hostedRegistry };
}
