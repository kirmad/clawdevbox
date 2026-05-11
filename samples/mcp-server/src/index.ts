#!/usr/bin/env node
/**
 * @conductor/mcp-server — entry point.
 *
 * Conductor's central MCP server. Spins up over stdio so the side-terminal
 * CLI (`claude --mcp-config ...`) and external agents can hit the same
 * verb surface the renderer's WS facade exposes. Spec §6 covers the
 * surface; §10 covers plugin / scope semantics.
 *
 * The real Conductor sidecar adds:
 *   - Streamable-HTTP transport on port 5201 with per-launch bearer auth
 *   - better-sqlite3 backing for inbox/threads/messages/approvals
 *   - In-process cron daemon that fires webhooks for triggers
 *   - File-watcher with 500ms debounce on .conductor/recipes/, .conductor/skills/, .conductor/plugins/*\/plugin.yaml
 *
 * This stub ships:
 *   - stdio transport (the same one the ADO MCP server uses)
 *   - In-memory inbox/thread/approval state (process-local)
 *   - Real file IO for recipe/skill/trigger/plugin
 *   - Plugin manifest discovery at boot
 *
 * Env vars:
 *   CONDUCTOR_PROJECT_DIR — required, the workspace root
 *   CONDUCTOR_GLOBAL_DIR  — optional, defaults to ~/.conductor
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadWorkspaceFromEnv, WorkspaceConfigError } from './workspace.ts';
import { registerRecipeTools } from './tools/recipe.ts';
import { registerSkillTools } from './tools/skill.ts';
import { registerTriggerTools } from './tools/trigger.ts';
import { registerPluginTools } from './tools/plugin.ts';
import { registerWorkspaceTools } from './tools/workspace.ts';
import { registerInboxTools } from './tools/inbox.ts';
import { registerThreadTools } from './tools/thread.ts';
import { registerApprovalTools } from './tools/approval.ts';
import { registerStubTools } from './tools/stubs.ts';
import { discoverTools, registerHostedTools } from './tools/hosted.ts';
import { registerArtifactTools } from './tools/artifact.ts';
import { registerRendererTools } from './tools/renderer.ts';
import { startTerminalServer } from './terminal-server.ts';

async function main(): Promise<void> {
  let ws;
  try {
    ws = loadWorkspaceFromEnv();
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      process.stderr.write(`[mcp-conductor] ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const server = new McpServer(
    {
      name: '@conductor/mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "Conductor's central MCP surface. Tool families: recipe.* (file-backed; recipe.run/.done/.instance_info manage spawned agent sessions), skill.* (file-backed), trigger.* (file-backed), plugin.* (file-backed + git), workspace.* (file-backed registry of .conductor/ workspaces), inbox.*/thread.*/approval.* (in-memory in this stub), and artifact.*/view.*/search.*/signal.* (NOT_IMPLEMENTED_IN_STUB).",
    },
  );

  registerRecipeTools(server, ws);
  registerSkillTools(server, ws);
  registerTriggerTools(server, ws);
  registerPluginTools(server, ws);
  registerWorkspaceTools(server, ws);
  registerInboxTools(server);
  registerThreadTools(server);
  registerApprovalTools(server);
  registerStubTools(server);
  registerArtifactTools(server, ws);
  registerRendererTools(server, ws);

  // Hostable tools (spec §10.3): dynamic-import every plugin's `provides.tools[]`
  // and register each as an in-process MCP tool. Discovery errors don't crash
  // the server — they log to stderr and surface via plugin.list.
  const hostedRegistry = await discoverTools(ws);
  registerHostedTools(server, hostedRegistry, ws);

  // Terminal viewer (HTTP + WS) for live attaching to hidden recipe ptys.
  // Boots before stdio is wired so `recipe.run` can include the view_url in
  // its first response. Failure to bind is non-fatal — recipes still run,
  // just without a live-view URL.
  let terminalPort = 0;
  try {
    const handle = await startTerminalServer({ workspace: ws });
    terminalPort = handle.port();
  } catch (err) {
    process.stderr.write(
      `[mcp-conductor] terminal-server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  server.server.onclose = () => {
    process.exit(0);
  };

  const pluginCount = ws.plugins.size;
  const hostedCount = hostedRegistry.tools.length;
  const hostedErrCount = hostedRegistry.errors.length;
  process.stderr.write(
    `[mcp-conductor] ready (stdio); project_dir=${ws.projectDir}; plugins=${pluginCount}; hosted_tools=${hostedCount}${hostedErrCount > 0 ? `; tool_errors=${hostedErrCount}` : ''}; terminal_port=${terminalPort}\n`,
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[mcp-conductor] fatal: ${msg}\n`);
  process.exit(1);
});
