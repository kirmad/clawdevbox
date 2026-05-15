/**
 * cli/mcp.ts
 *
 * `clawdevbox mcp` — run the MCP server over stdio.
 *
 * Resolves config (flags > env > .clawdevbox/config.json > defaults),
 * boots the terminal viewer on its own port so spawned recipes can hand out
 * a view_url, then connects an stdio transport. Logs to stderr — stdout is
 * reserved for MCP protocol frames.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { applyConfigToEnv, ConfigError, resolveConfig } from '../config.ts';
import { openDatabase } from '../db/index.ts';
import { logger } from '../logger.ts';
import { buildServer } from '../server.ts';
import { startTerminalServer } from '../terminal-server.ts';
import { loadWorkspaceFromEnv, WorkspaceConfigError } from '../workspace.ts';
import type { Flags } from './index.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export async function runMcp(flags: Flags): Promise<void> {
  let cfg;
  try {
    cfg = resolveConfig({
      projectDir: str(flags, 'project'),
      globalDir: str(flags, 'global'),
      workspacesRoot: str(flags, 'workspaces-root'),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ err: err.message }, 'config error');
      process.exit(2);
    }
    throw err;
  }
  applyConfigToEnv(cfg);

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

  // Open the kernel DB so DB-backed stores (triggers, recipe-instances,
  // inbox) have a working singleton. Runs migrations on first open.
  try {
    const opened = openDatabase(cfg.globalDir);
    logger.info(
      { path: opened.path, schema_version: opened.schemaVersion },
      'db opened',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'db open failed',
    );
    process.exit(2);
  }

  const { server, hostedRegistry } = await buildServer(ws);

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
