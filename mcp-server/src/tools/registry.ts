/**
 * tools/registry.ts
 *
 * Central tool registry. All tool families (built-in and hosted/plugin) register
 * their tools here via defineTool(). The meta-tools layer reads from this registry
 * to expose list_tools, learn_tool, and run_tool.
 */

import type { z } from 'zod';

export interface ToolExample {
  /** Human-readable description of what this example demonstrates */
  description: string;
  /** The JSON arguments to pass */
  args: Record<string, unknown>;
}

export interface ToolEntry {
  /** Namespaced tool id, e.g. "inbox.list", "ado.get_pr" */
  name: string;
  /** One-line description shown in list_tools */
  description: string;
  /** Zod schema for the tool's input parameters */
  parameters: z.ZodTypeAny;
  /** The execute function — receives parsed args + extra context from MCP */
  handler: (args: any, extra?: any) => Promise<unknown>;
  /** Optional structured examples for learn_tool */
  examples?: ToolExample[];
  /** Plugin id (for hosted tools) or 'builtin' */
  source: string;
  /** Absolute path to the tool's source file (for resolving sibling .md) */
  sourceFile?: string;
}

const toolRegistry = new Map<string, ToolEntry>();

/**
 * Register a tool in the global registry. If a tool with the same name already
 * exists, it is silently overwritten (allows per-session re-registration of
 * builtins without clearing the registry).
 */
export function defineTool(entry: ToolEntry): void {
  toolRegistry.set(entry.name, entry);
}

/**
 * Register an existing tool under an additional name (a deprecation alias).
 * Reuses the same handler / parameters / examples, but prepends a deprecation
 * note to the description so `list_tools` / `learn_tool` surface the rename.
 *
 * @param newAliasName - the name to register the alias under (typically the OLD name, kept for back-compat)
 * @param target       - the canonical tool entry the alias delegates to
 * @param canonicalName - the new canonical name to point users at
 */
export function aliasTool(
  newAliasName: string,
  target: ToolEntry,
  canonicalName: string,
): void {
  toolRegistry.set(newAliasName, {
    ...target,
    name: newAliasName,
    description: `⚠️ DEPRECATED — use \`${canonicalName}\` instead. ${target.description}`,
  });
}

/** Get the full registry (read-only view). */
export function getRegistry(): ReadonlyMap<string, ToolEntry> {
  return toolRegistry;
}

/** Clear all entries. Used by tests and per-session server creation. */
export function clearRegistry(): void {
  toolRegistry.clear();
}
