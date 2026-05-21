# Meta-Tools: Unified Tool Abstraction Layer

**Date:** 2026-05-21  
**Status:** Draft  

## Problem

The MCP server currently registers ~30+ individual tools. Each tool occupies
prompt tokens in the agent's tool list. Most sessions use only a handful of
tools, but agents pay the full token cost for all of them. Additionally, agents
have no structured way to learn tool usage patterns before calling them.

## Solution

Replace all individually-registered MCP tools with **3 meta-tools**:

| Tool | Purpose |
|------|---------|
| `list_tools` | Discover available tools (names + one-line descriptions) |
| `learn_tool` | Get detailed usage info: JSON schema, examples, sibling `.md` docs |
| `run_tool` | Execute a tool by name with a JSON arguments object |

## Architecture

### Tool Registry (Central)

A global `toolRegistry` Map serves as the single source of truth for all tools
(built-in families AND hosted/plugin tools).

```
tools/registry.ts
├── ToolEntry interface
├── toolRegistry: Map<string, ToolEntry>
├── defineTool(entry: ToolEntry): void
└── getRegistry(): ReadonlyMap<string, ToolEntry>
```

### ToolEntry Interface

```ts
interface ToolEntry {
  /** Namespaced tool id, e.g. "inbox.list", "ado.get_pr" */
  name: string;

  /** One-line description shown in list_tools and baked into schemas */
  description: string;

  /** Zod schema for the tool's input parameters */
  parameters: z.ZodTypeAny;

  /** The execute function — receives parsed args + ToolContext */
  handler: (args: unknown, ctx: ToolContext) => Promise<unknown>;

  /** Optional structured examples for learn_tool */
  examples?: ToolExample[];

  /** Plugin id (for hosted tools) or 'builtin' */
  source: string;
}

interface ToolExample {
  /** Human-readable description of what this example demonstrates */
  description: string;
  /** The JSON arguments to pass */
  args: Record<string, unknown>;
}
```

### Sibling `.md` Convention

Any tool source file may have a sibling markdown file with the same base name:

```
plugins/ado/tools/get_pr.ts      ← tool implementation
plugins/ado/tools/get_pr.md      ← usage docs (optional)
```

For built-in tools:
```
mcp-server/src/tools/inbox.list.md
mcp-server/src/tools/recipe.run.md
```

The `.md` file contains:
- Detailed usage instructions
- Complex examples with commentary
- Edge cases and error handling guidance
- Workflow recommendations (when to use this tool vs others)

`learn_tool` reads and returns this content alongside the structured data.

### Registration Flow

```
Startup
  ├── Import each tool family file (side-effect: calls defineTool())
  │     tools/inbox.ts → defineTool({ name: 'inbox.list', ... })
  │     tools/recipe.ts → defineTool({ name: 'recipe.run', ... })
  │     ...
  ├── Async: discoverTools(ws) → for each hosted tool, defineTool(...)
  └── registerMetaTools(server)
        ├── Reads toolRegistry to build enum of tool names
        ├── Registers list_tools
        ├── Registers learn_tool  
        └── Registers run_tool
```

### Meta-Tool Schemas

#### `list_tools`

```ts
// Input
z.object({
  filter: z.string().optional()  // substring match on name/description
})

// Output
{ tools: [{ name: string, description: string }] }
```

#### `learn_tool`

```ts
// Input
z.object({
  tools: z.array(z.enum([...toolNames]))  // 1+ tool names
})

// Output (per tool)
{
  tools: [{
    name: string,
    description: string,
    parameters_schema: JSONSchema,  // converted from zod
    examples: ToolExample[],        // from ToolEntry.examples
    documentation: string | null,   // from sibling .md file
  }]
}
```

#### `run_tool`

```ts
// Input
z.object({
  tool: z.enum([...toolNames]),
  args: z.record(z.unknown())  // freeform JSON, validated at dispatch
})

// Output
// Whatever the underlying tool returns (CallToolResult)
```

### Enum Baking

At server startup (after all `defineTool()` calls complete + hosted tools are
discovered), the meta-tools layer reads all keys from `toolRegistry` and
constructs `z.enum([...names])` schemas. This means:

- Agents see all available tool names in the `run_tool` and `learn_tool`
  JSON schemas (autocomplete-friendly)
- Invalid tool names are rejected at the schema level
- New tools added via plugin install require a server restart (or session
  re-initialization) to appear in the enum

### SERVER_INSTRUCTIONS Update

```
SERVER_INSTRUCTIONS = `Clawdevbox MCP surface. All functionality is accessed
through three meta-tools: list_tools, learn_tool, run_tool.

IMPORTANT: Before using any tool for the first time in a session, you MUST
call learn_tool with that tool's name to understand its parameters, usage
patterns, and constraints. Only then should you call run_tool.

Workflow:
1. list_tools — discover what's available
2. learn_tool — understand how to use specific tools
3. run_tool — execute with correct parameters`
```

### ToolContext

The existing `ToolContext` interface is preserved unchanged. For built-in
tools, a standard context is constructed (similar to how hosted tools get
theirs today). The `source` field on ToolEntry determines how context is
built:

- `source: 'builtin'` → context with ws paths, no plugin_dir
- `source: '<plugin_id>'` → context with plugin-specific paths (same as today)

## Migration Strategy

### Built-in Tool Families

Each existing `tools/<family>.ts` file is refactored:

**Before:**
```ts
export function registerInboxTools(server: McpServer, ws: Workspace): void {
  server.registerTool('inbox.list', { ... }, handler);
}
```

**After:**
```ts
import { defineTool } from './registry.ts';

export function registerInboxEntries(ws: Workspace): void {
  defineTool({
    name: 'inbox.list',
    description: 'List inbox items...',
    parameters: z.object({ ... }),
    handler: async (args, ctx) => { ... },
    examples: [{ description: 'List new items', args: { state: 'new' } }],
    source: 'builtin',
  });
}
```

The `ws` dependency is captured in a closure within the handler (same as today).

### Hosted/Plugin Tools

`discoverTools()` is modified to call `defineTool()` for each valid hosted
tool instead of returning a `HostedToolRegistry`. The meta-tools layer then
finds them in the shared registry.

### server.ts Changes

```ts
// Before: 15+ registerXTools(server, ws) calls
// After:
import { registerMetaTools } from './tools/meta-tools.ts';
import './tools/inbox.ts';  // side-effect imports
// ...

export async function buildServer(ws: Workspace): Promise<BuiltServer> {
  // 1. Register built-in entries
  registerInboxEntries(ws);
  registerRecipeEntries(ws);
  // ...

  // 2. Discover hosted tools → defineTool() for each
  await discoverHostedTools(ws);

  // 3. Register the 3 meta-tools (reads from toolRegistry)
  const server = new McpServer(...);
  registerMetaTools(server, ws);
  return { server };
}
```

## Error Handling

- `run_tool` with unknown tool name → schema validation error (enum)
- `run_tool` with invalid args → underlying tool's zod validation error,
  forwarded as structured error content
- `learn_tool` for tool with no .md → returns `documentation: null`
- `learn_tool` for tool with no examples → returns `examples: []`

## Files Changed

| File | Change |
|------|--------|
| `tools/registry.ts` | NEW — ToolEntry type, toolRegistry Map, defineTool() |
| `tools/meta-tools.ts` | NEW — list_tools, learn_tool, run_tool registration |
| `tools/inbox.ts` | Refactor: export registerInboxEntries (uses defineTool) |
| `tools/recipe.ts` | Refactor: same pattern |
| `tools/skill.ts` | Refactor: same pattern |
| `tools/trigger.ts` | Refactor: same pattern |
| `tools/plugin.ts` | Refactor: same pattern |
| `tools/workspace.ts` | Refactor: same pattern |
| `tools/thread.ts` | Refactor: same pattern |
| `tools/approval.ts` | Refactor: same pattern |
| `tools/artifact.ts` | Refactor: same pattern |
| `tools/renderer.ts` | Refactor: same pattern |
| `tools/notify.ts` | Refactor: same pattern |
| `tools/ui.ts` | Refactor: same pattern |
| `tools/feedback.ts` | Refactor: same pattern |
| `tools/paths.ts` | Refactor: same pattern |
| `tools/hosted.ts` | Refactor: discoverTools calls defineTool() |
| `server.ts` | Simplified: call registerMetaTools() only |
| Various `*.md` | NEW — sibling docs for tools that benefit from them |

## Open Questions

1. **Session-scoped enum refresh:** If a plugin is installed mid-session, the
   enum won't include new tools until the session server is recreated. Is this
   acceptable? (Current answer: yes, `list_tools` still works dynamically as
   a fallback even if run_tool enum is stale.)

2. **Backwards compatibility:** Should we keep a `--legacy-tools` flag that
   registers tools individually for debugging/migration?
