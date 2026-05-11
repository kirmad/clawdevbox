#!/usr/bin/env node
/**
 * @conductor/mcp-ado — entry point.
 *
 * Spins up an MCP server over stdio that exposes Azure DevOps tools to the
 * agent (claude / copilot / codex / etc.). The transport choice is stdio so
 * the server is invoked the same way as Continue / Cursor / Claude Code's
 * other MCP integrations:
 *
 *   {
 *     "command": "npx",
 *     "args": ["-y", "@conductor/mcp-ado"],
 *     "env": { "ADO_ORG": "...", "ADO_BEARER_TOKEN": "..." }
 *   }
 *
 * For local-dev (this sample), the plugin's mcp/ado.json points at this file
 * directly via `tsx`, so the same recipe wiring works without an npm publish.
 *
 * Env vars consumed (lazily — only when a tool call is made):
 *   ADO_ORG, ADO_PROJECT — defaults for tool args
 *   ADO_BEARER_TOKEN     — AAD access token (preferred)
 *   ADO_PAT              — basic-auth fallback
 *
 * The server itself does not validate env vars at startup. Recipes that load
 * but never call an ADO tool should not fail — the actionable error happens
 * at the first call, where it surfaces as a normal tool error result.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.ts';

async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: '@conductor/mcp-ado',
      version: '1.0.0',
    },
    {
      capabilities: {
        // We register tools below; advertising the capability lets clients
        // know they can call tools/list and tools/call without a roundtrip.
        tools: {},
      },
      instructions:
        'Azure DevOps tools (ado.*). Pass `org` and `project` per-call to override the server-level ADO_ORG / ADO_PROJECT env defaults.',
    },
  );

  registerTools(server);

  // stdio: stdin is the inbound JSON-RPC channel, stdout is the response.
  // Anything we ourselves want to log MUST go to stderr — writing to stdout
  // would corrupt the protocol frame and break the client.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: when the host disconnects (parent closes our stdio),
  // the transport emits a close event we listen for via server.onclose.
  server.server.onclose = () => {
    process.exit(0);
  };

  // Print a tiny startup hint on stderr — visible when run interactively,
  // ignored by the protocol on stdin/stdout.
  process.stderr.write('[mcp-ado] ready (stdio transport)\n');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[mcp-ado] fatal: ${msg}\n`);
  process.exit(1);
});
