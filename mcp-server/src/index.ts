#!/usr/bin/env node
/**
 * @conductor/mcp-server — entry point.
 *
 * Conductor's central MCP server. Spins up over stdio so a side-terminal
 * CLI (`claude --mcp-config ...`) and external agents can hit the same
 * verb surface the renderer's WebSocket facade exposes. Spec §6 covers
 * the tool surface; §10 covers plugin / scope semantics.
 *
 * Shipped surface:
 *   - stdio MCP transport
 *   - File-backed recipe / skill / trigger / plugin / workspace /
 *     artifact / renderer registries
 *   - Plugin manifest discovery + hostable-tool registration at boot
 *   - Hidden node-pty agent runs + the terminal-viewer HTTP/WS server
 *     (xterm.js in the browser, ConPTY on Windows)
 *   - HTTP routes for the artifact viewer + renderer-module loader
 *   - In-process inbox / thread / message / approval state
 *
 * Env vars:
 *   CONDUCTOR_PROJECT_DIR     required — workspace root
 *   CONDUCTOR_GLOBAL_DIR      optional, defaults to ~/.conductor
 *   CONDUCTOR_WORKSPACES_ROOT optional, defaults to ~/.conductor/workspaces
 *   CONDUCTOR_TERMINAL_PORT   optional, ephemeral if unset
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.ts';
import { loadWorkspaceFromEnv, WorkspaceConfigError } from './workspace.ts';
import { registerRecipeTools } from './tools/recipe.ts';
import { registerSkillTools } from './tools/skill.ts';
import { registerTriggerTools } from './tools/trigger.ts';
import { registerPluginTools } from './tools/plugin.ts';
import { registerWorkspaceTools } from './tools/workspace.ts';
import { registerInboxTools } from './tools/inbox.ts';
import { registerThreadTools } from './tools/thread.ts';
import { registerApprovalTools } from './tools/approval.ts';
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
      logger.error({ err: err.message }, 'workspace config error');
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
      capabilities: { tools: {} },
      instructions:
        "Conductor's central MCP surface. Tool families: recipe.* (file-backed; recipe.run/.done/.instance_info manage spawned agent sessions), skill.* (file-backed), trigger.* (file-backed), plugin.* (file-backed + git), workspace.* (file-backed registry of .conductor/ workspaces), inbox.* / thread.* / approval.* (in-process state for this build; SQLite-backed in the next phase), artifact.* (folder-per-id under <workspace>/artifacts/), renderer.* (workspace → plugin → builtin chain).",
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
  registerArtifactTools(server, ws);
  registerRendererTools(server, ws);

  // Hostable tools (spec §10.3): dynamic-import every plugin's `provides.tools[]`
  // and register each as an in-process MCP tool. Discovery errors don't crash
  // the server — they're logged and surface via `plugin.list`.
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
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'terminal-server failed to start; recipes will run without a view_url',
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  server.server.onclose = () => process.exit(0);

  logger.info(
    {
      transport: 'stdio',
      projectDir: ws.projectDir,
      plugins: ws.plugins.size,
      hostedTools: hostedRegistry.tools.length,
      hostedErrors: hostedRegistry.errors.length,
      terminalPort,
    },
    'ready',
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  logger.fatal({ err: msg }, 'fatal');
  process.exit(1);
});
