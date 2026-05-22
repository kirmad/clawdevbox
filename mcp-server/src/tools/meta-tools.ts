/**
 * tools/meta-tools.ts
 *
 * Registers the 3 meta-tools (list_tools, learn_tool, run_tool) on the MCP server.
 * Reads from the central toolRegistry to enumerate available tools and dispatch calls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getRegistry, type ToolEntry } from './registry.ts';

/**
 * Resolve the sibling .md documentation file for a tool.
 * Convention: same base name as the source file, with .md extension.
 * For built-in tools without a sourceFile, look for `<toolName>.md` in the tools dir.
 */
function resolveDocumentation(entry: ToolEntry, toolsDir: string): string | null {
  if (entry.sourceFile) {
    const dir = dirname(entry.sourceFile);
    const base = basename(entry.sourceFile).replace(/\.(ts|mjs|js)$/, '.md');
    const mdPath = join(dir, base);
    if (existsSync(mdPath)) return readFileSync(mdPath, 'utf-8');
  }
  // Fallback: look for <tool-name>.md in the built-in tools directory
  const fallbackPath = join(toolsDir, `${entry.name}.md`);
  if (existsSync(fallbackPath)) return readFileSync(fallbackPath, 'utf-8');
  return null;
}

/**
 * Register the 3 meta-tools on the given McpServer. Must be called AFTER all
 * tool families have registered their entries via defineTool().
 */
export function registerMetaTools(server: McpServer, toolsDir?: string): void {
  const thisFile = fileURLToPath(import.meta.url);
  const resolvedToolsDir = toolsDir ?? dirname(thisFile);

  // --- list_tools -----------------------------------------------------------
  server.registerTool(
    'list_tools',
    {
      description:
        'List all available tools with their names and one-line descriptions. Use this to discover what tools are available before calling learn_tool or run_tool.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Substring filter on tool name or description (case-insensitive).'),
      },
    },
    async (args: { filter?: string }) => {
      const registry = getRegistry();
      let tools = Array.from(registry.values()).map((t) => ({
        name: t.name,
        description: t.description,
      }));
      if (args.filter) {
        const q = args.filter.toLowerCase();
        tools = tools.filter(
          (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
        );
      }
      tools.sort((a, b) => a.name.localeCompare(b.name));
      const payload = { tools, count: tools.length };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // --- learn_tool -----------------------------------------------------------
  server.registerTool(
    'learn_tool',
    {
      description:
        'Get detailed usage information for one or more tools: JSON parameter schema, examples, and documentation. ALWAYS call this before using a tool for the first time.',
      inputSchema: {
        tools: z
          .array(z.string().min(1))
          .min(1)
          .describe('Array of tool names to learn about.'),
      },
    },
    async (args: { tools: string[] }) => {
      const registry = getRegistry();
      const results = args.tools.map((name) => {
        const entry = registry.get(name);
        if (!entry) {
          return { name, error: `Tool "${name}" not found. Use list_tools to see available tools.` };
        }
        let parametersSchema: unknown = null;
        try {
          parametersSchema = (entry.parameters as any).toJSONSchema?.()
            ?? { note: 'Schema not available in JSON Schema format.' };
        } catch {
          parametersSchema = { note: 'Schema conversion failed. Pass args as a JSON object.' };
        }
        const documentation = resolveDocumentation(entry, resolvedToolsDir);
        return {
          name: entry.name,
          description: entry.description,
          parameters_schema: parametersSchema,
          examples: entry.examples ?? [],
          documentation,
        };
      });
      const payload = { tools: results };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // --- run_tool -------------------------------------------------------------
  server.registerTool(
    'run_tool',
    {
      description:
        "Execute a tool by name with a JSON arguments object. You MUST call learn_tool first to understand a tool's parameters before calling run_tool.",
      inputSchema: {
        tool: z
          .string()
          .min(1)
          .describe('The tool name to execute (e.g. "inbox.list", "ado.get_pr").'),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "JSON object of arguments matching the tool's parameter schema. Omit or pass {} for no-argument tools.",
          ),
      },
    },
    async (
      args: { tool: string; args?: Record<string, unknown> },
      extra: Record<string, unknown>,
    ): Promise<CallToolResult> => {
      const registry = getRegistry();
      const entry = registry.get(args.tool);
      if (!entry) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Tool "${args.tool}" not found. Use list_tools to see available tools.`,
            },
          ],
        };
      }
      // Validate args against the tool's zod schema
      const parseResult = entry.parameters.safeParse(args.args ?? {});
      if (!parseResult.success) {
        const issues = (parseResult.error.issues as Array<{ path: (string | number | symbol)[]; message: string }>)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        return {
          isError: true,
          content: [{ type: 'text', text: `Validation error for "${args.tool}": ${issues}` }],
        };
      }
      try {
        const result = await entry.handler(parseResult.data, extra);
        // If handler returns a CallToolResult-shaped object, pass it through
        if (result && typeof result === 'object' && 'content' in (result as object)) {
          return result as CallToolResult;
        }
        // Otherwise wrap as structured content
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(result && typeof result === 'object'
            ? { structuredContent: result as Record<string, unknown> }
            : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error running "${args.tool}": ${message}` }],
        };
      }
    },
  );
}
