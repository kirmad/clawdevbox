/**
 * llm/mcp-tools-bridge.ts
 *
 * Bridges clawdevbox MCP tools into LlmToolDefinition format so they can be
 * used with executeWithTools(). Converts Zod schemas to JSON Schema and wires
 * handlers to the real MCP tool handlers.
 *
 * Usage:
 *   import { getMcpToolsForLlm } from './mcp-tools-bridge.ts';
 *   const tools = getMcpToolsForLlm(['search_memory', 'inbox.list']);
 *   const result = await executeWithTools({ messages, tools });
 */

import { getRegistry, type ToolEntry } from '../tools/registry.ts';
import type { LlmToolDefinition } from './types.ts';

/**
 * Convert a Zod schema to a JSON Schema object suitable for OpenAI function calling.
 */
function zodToJsonSchema(zodSchema: any): Record<string, unknown> {
  // Zod v4 uses .toJSONSchema(), Zod v3 uses zodToJsonSchema from a separate package.
  // Try the built-in method first.
  if (typeof zodSchema?.toJSONSchema === 'function') {
    return zodSchema.toJSONSchema();
  }
  // Fallback: if it's already a plain object (some hosted tools use raw JSON schema)
  if (zodSchema && typeof zodSchema === 'object' && !('_def' in zodSchema)) {
    return zodSchema;
  }
  // Last resort: empty object schema
  return { type: 'object', properties: {} };
}

/**
 * Get specific MCP tools as LlmToolDefinitions with real handlers.
 *
 * @param toolNames - Array of tool names to include. If empty/undefined, includes ALL tools.
 * @param filter - Optional regex to filter tools by name/description.
 */
export function getMcpToolsForLlm(
  toolNames?: string[],
  filter?: RegExp,
): LlmToolDefinition[] {
  const registry = getRegistry();
  const result: LlmToolDefinition[] = [];

  for (const [name, entry] of registry) {
    // Filter by name list
    if (toolNames?.length && !toolNames.includes(name)) continue;
    // Filter by regex
    if (filter && !filter.test(name) && !filter.test(entry.description)) continue;
    // Skip meta-tools (they're for MCP protocol, not direct LLM use)
    if (name === 'list_tools' || name === 'learn_tool' || name === 'run_tool') continue;

    result.push(mcpToolToLlmTool(entry));
  }

  return result;
}

/**
 * Convert a single MCP ToolEntry to an LlmToolDefinition with handler.
 */
export function mcpToolToLlmTool(entry: ToolEntry): LlmToolDefinition {
  const jsonSchema = zodToJsonSchema(entry.parameters);

  return {
    type: 'function',
    function: {
      name: entry.name,
      description: entry.description,
      parameters: jsonSchema,
    },
    _handler: async (args: Record<string, unknown>) => {
      const result = await entry.handler(args);
      // MCP tool results can be objects — serialize for the LLM
      if (typeof result === 'string') return result;
      return JSON.stringify(result, null, 2);
    },
  };
}

/**
 * Get a single MCP tool by name, ready for LLM use.
 * Throws if the tool doesn't exist.
 */
export function getMcpTool(name: string): LlmToolDefinition {
  const registry = getRegistry();
  const entry = registry.get(name);
  if (!entry) {
    throw new Error(
      `MCP tool "${name}" not found. Available: ${[...registry.keys()].join(', ')}`,
    );
  }
  return mcpToolToLlmTool(entry);
}
