# Meta-Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all 68 individually-registered MCP tools with 3 meta-tools (`list_tools`, `learn_tool`, `run_tool`) using a central registry pattern.

**Architecture:** A `toolRegistry` Map collects all tool entries (built-in + hosted). Each existing tool family file exports a registration function that calls `defineTool()`. At startup, after all entries are collected, `meta-tools.ts` reads the registry and registers 3 MCP tools with baked-in enum schemas. Sibling `.md` files provide detailed usage docs per tool.

**Tech Stack:** TypeScript, zod, `@modelcontextprotocol/sdk`, Node.js `node:test`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/tools/registry.ts` | NEW — `ToolEntry` type, `toolRegistry` Map, `defineTool()`, `getRegistry()` |
| `src/tools/meta-tools.ts` | NEW — `registerMetaTools()`: list_tools, learn_tool, run_tool |
| `src/tools/inbox.ts` | REFACTOR — export `registerInboxEntries(ws)` using `defineTool()` |
| `src/tools/recipe.ts` | REFACTOR — export `registerRecipeEntries(ws)` using `defineTool()` |
| `src/tools/skill.ts` | REFACTOR — export `registerSkillEntries(ws)` using `defineTool()` |
| `src/tools/trigger.ts` | REFACTOR — export `registerTriggerEntries(ws)` using `defineTool()` |
| `src/tools/plugin.ts` | REFACTOR — export `registerPluginEntries(ws)` using `defineTool()` |
| `src/tools/workspace.ts` | REFACTOR — export `registerWorkspaceEntries(ws)` using `defineTool()` |
| `src/tools/thread.ts` | REFACTOR — export `registerThreadEntries()` using `defineTool()` |
| `src/tools/approval.ts` | REFACTOR — export `registerApprovalEntries()` using `defineTool()` |
| `src/tools/artifact.ts` | REFACTOR — export `registerArtifactEntries(ws)` using `defineTool()` |
| `src/tools/renderer.ts` | REFACTOR — export `registerRendererEntries(ws)` using `defineTool()` |
| `src/tools/notify.ts` | REFACTOR — export `registerNotifyEntries(ws)` using `defineTool()` |
| `src/tools/ui.ts` | REFACTOR — export `registerUiEntries(ws)` using `defineTool()` |
| `src/tools/feedback.ts` | REFACTOR — export `registerFeedbackEntries(ws)` using `defineTool()` |
| `src/tools/paths.ts` | REFACTOR — export `registerPathsEntries(ws)` using `defineTool()` |
| `src/tools/hosted.ts` | REFACTOR — `discoverTools()` calls `defineTool()` per hosted tool |
| `src/server.ts` | REFACTOR — call entry registration functions + `registerMetaTools()` |
| `tests/meta-tools.test.mjs` | NEW — tests for list_tools, learn_tool, run_tool |

---

### Task 1: Create the Tool Registry

**Files:**
- Create: `mcp-server/src/tools/registry.ts`
- Test: `mcp-server/tests/meta-tools.test.mjs` (initial test)

- [ ] **Step 1: Write the failing test for defineTool and getRegistry**

```js
// tests/meta-tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

test('registry: defineTool stores entries and getRegistry returns them', async () => {
  // Dynamic import to get fresh module state via tsx
  const { defineTool, getRegistry, clearRegistry } = await import('../src/tools/registry.ts');
  clearRegistry(); // ensure clean state for test

  const { z } = await import('zod');
  defineTool({
    name: 'test.hello',
    description: 'A test tool',
    parameters: z.object({ name: z.string() }),
    handler: async (args) => ({ greeting: `Hello ${args.name}` }),
    source: 'builtin',
  });

  const reg = getRegistry();
  assert.equal(reg.size, 1);
  assert.ok(reg.has('test.hello'));
  const entry = reg.get('test.hello');
  assert.equal(entry.name, 'test.hello');
  assert.equal(entry.description, 'A test tool');
  assert.equal(entry.source, 'builtin');
  clearRegistry();
});

test('registry: defineTool rejects duplicate names', async () => {
  const { defineTool, clearRegistry } = await import('../src/tools/registry.ts');
  clearRegistry();

  const { z } = await import('zod');
  const entry = {
    name: 'test.dup',
    description: 'First',
    parameters: z.object({}),
    handler: async () => ({}),
    source: 'builtin',
  };
  defineTool(entry);
  assert.throws(() => defineTool(entry), /already registered/);
  clearRegistry();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-server && node --import tsx --test tests/meta-tools.test.mjs`
Expected: FAIL — module `../src/tools/registry.ts` does not exist

- [ ] **Step 3: Implement registry.ts**

```ts
// src/tools/registry.ts
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
  /** The execute function */
  handler: (args: unknown, extra?: { signal?: AbortSignal }) => Promise<unknown>;
  /** Optional structured examples for learn_tool */
  examples?: ToolExample[];
  /** Plugin id (for hosted tools) or 'builtin' */
  source: string;
  /** Absolute path to the tool's source file (for resolving sibling .md) */
  sourceFile?: string;
}

const toolRegistry = new Map<string, ToolEntry>();

/**
 * Register a tool in the global registry. Throws if a tool with the same name
 * is already registered.
 */
export function defineTool(entry: ToolEntry): void {
  if (toolRegistry.has(entry.name)) {
    throw new Error(`Tool "${entry.name}" is already registered`);
  }
  toolRegistry.set(entry.name, entry);
}

/** Get the full registry (read-only view). */
export function getRegistry(): ReadonlyMap<string, ToolEntry> {
  return toolRegistry;
}

/** Clear all entries. Used by tests only. */
export function clearRegistry(): void {
  toolRegistry.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mcp-server && node --import tsx --test tests/meta-tools.test.mjs`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
cd mcp-server && git add src/tools/registry.ts tests/meta-tools.test.mjs
git commit -m "feat(meta-tools): add central tool registry

Introduces ToolEntry interface, defineTool(), getRegistry(), and
clearRegistry() for collecting all tools into a single Map.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Create the Meta-Tools Layer (list_tools, learn_tool, run_tool)

**Files:**
- Create: `mcp-server/src/tools/meta-tools.ts`
- Modify: `mcp-server/tests/meta-tools.test.mjs`

- [ ] **Step 1: Write failing tests for the three meta-tools**

Append to `tests/meta-tools.test.mjs`:

```js
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper: build a minimal McpServer and register meta-tools against a seeded registry.
async function setupMetaTools() {
  const { defineTool, clearRegistry } = await import('../src/tools/registry.ts');
  const { registerMetaTools } = await import('../src/tools/meta-tools.ts');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');

  clearRegistry();

  // Seed two tools
  defineTool({
    name: 'mock.greet',
    description: 'Greets a user',
    parameters: z.object({ name: z.string() }),
    handler: async (args) => ({ text: `Hello ${args.name}` }),
    examples: [{ description: 'Greet Alice', args: { name: 'Alice' } }],
    source: 'builtin',
  });
  defineTool({
    name: 'mock.add',
    description: 'Adds two numbers',
    parameters: z.object({ a: z.number(), b: z.number() }),
    handler: async (args) => ({ result: args.a + args.b }),
    source: 'builtin',
  });

  const server = new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  registerMetaTools(server);
  return { server, clearRegistry };
}

test('list_tools returns all registered tools', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  // Use the SDK's internal tool handler map to call tools directly
  const tools = server._registeredTools;
  assert.ok(tools.has('list_tools'));
  const result = await tools.get('list_tools').handler({}, {});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.tools.length, 2);
  assert.deepEqual(parsed.tools.map(t => t.name).sort(), ['mock.add', 'mock.greet']);
  clearRegistry();
});

test('learn_tool returns schema and examples', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const tools = server._registeredTools;
  assert.ok(tools.has('learn_tool'));
  const result = await tools.get('learn_tool').handler({ tools: ['mock.greet'] }, {});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.tools.length, 1);
  assert.equal(parsed.tools[0].name, 'mock.greet');
  assert.ok(parsed.tools[0].parameters_schema); // JSON schema
  assert.equal(parsed.tools[0].examples.length, 1);
  assert.equal(parsed.tools[0].examples[0].args.name, 'Alice');
  clearRegistry();
});

test('run_tool dispatches to the correct handler', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const tools = server._registeredTools;
  assert.ok(tools.has('run_tool'));
  const result = await tools.get('run_tool').handler(
    { tool: 'mock.add', args: { a: 3, b: 4 } },
    {},
  );
  // run_tool should return the underlying tool's result
  assert.ok(result.content[0].text.includes('7') || result.structuredContent?.result === 7);
  clearRegistry();
});

test('run_tool returns error for unknown tool', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const tools = server._registeredTools;
  const result = await tools.get('run_tool').handler(
    { tool: 'no.such.tool', args: {} },
    {},
  );
  assert.equal(result.isError, true);
  clearRegistry();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mcp-server && node --import tsx --test tests/meta-tools.test.mjs`
Expected: FAIL — `../src/tools/meta-tools.ts` does not exist

- [ ] **Step 3: Implement meta-tools.ts**

```ts
// src/tools/meta-tools.ts
/**
 * tools/meta-tools.ts
 *
 * Registers the 3 meta-tools (list_tools, learn_tool, run_tool) on the MCP server.
 * Reads from the central toolRegistry to enumerate available tools and dispatch calls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
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
  const resolvedToolsDir = toolsDir ?? join(dirname(new URL(import.meta.url).pathname), '.');

  // --- list_tools -----------------------------------------------------------
  server.registerTool(
    'list_tools',
    {
      description:
        'List all available tools with their names and one-line descriptions. Use this to discover what tools are available before calling learn_tool or run_tool.',
      inputSchema: {
        filter: z.string().optional().describe('Substring filter on tool name or description (case-insensitive).'),
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
        tools: z.array(z.string().min(1)).min(1).describe('Array of tool names to learn about.'),
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
          parametersSchema = zodToJsonSchema(entry.parameters, { name: entry.name });
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
        'Execute a tool by name with a JSON arguments object. You MUST call learn_tool first to understand a tool\'s parameters before calling run_tool.',
      inputSchema: {
        tool: z.string().min(1).describe('The tool name to execute (e.g. "inbox.list", "ado.get_pr").'),
        args: z.record(z.unknown()).optional().describe('JSON object of arguments matching the tool\'s parameter schema. Omit or pass {} for no-argument tools.'),
      },
    },
    async (args: { tool: string; args?: Record<string, unknown> }, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
      const registry = getRegistry();
      const entry = registry.get(args.tool);
      if (!entry) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Tool "${args.tool}" not found. Use list_tools to see available tools.` }],
        };
      }
      // Validate args against the tool's zod schema
      const parseResult = entry.parameters.safeParse(args.args ?? {});
      if (!parseResult.success) {
        const issues = parseResult.error.issues.map(
          (i) => `${i.path.join('.')}: ${i.message}`,
        ).join('; ');
        return {
          isError: true,
          content: [{ type: 'text', text: `Validation error for "${args.tool}": ${issues}` }],
        };
      }
      try {
        const result = await entry.handler(parseResult.data, { signal: extra.signal });
        // If handler returns a CallToolResult-shaped object, pass it through
        if (result && typeof result === 'object' && 'content' in (result as object)) {
          return result as CallToolResult;
        }
        // Otherwise wrap as structured content
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          ...(result && typeof result === 'object' ? { structuredContent: result as Record<string, unknown> } : {}),
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
```

- [ ] **Step 4: Install zod-to-json-schema dependency**

Run: `cd mcp-server && npm install zod-to-json-schema`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mcp-server && node --import tsx --test tests/meta-tools.test.mjs`
Expected: All 6 tests PASS

Note: The test uses `server._registeredTools` which is an internal SDK detail. If the SDK version doesn't expose this, switch to the `Client`-based approach from the existing smoke tests (spawn server, connect via stdio, call `tools/call`). Adjust test approach at execution time if needed.

- [ ] **Step 6: Commit**

```bash
cd mcp-server && git add src/tools/meta-tools.ts tests/meta-tools.test.mjs package.json package-lock.json
git commit -m "feat(meta-tools): implement list_tools, learn_tool, run_tool

Registers 3 meta-tools on the MCP server that dispatch to the central
registry. learn_tool returns JSON schema, examples, and sibling .md docs.
run_tool validates args with zod before dispatching.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Refactor paths.ts as the first migration example

This is the simplest tool family (1 tool) — use it as the reference pattern for all other migrations.

**Files:**
- Modify: `mcp-server/src/tools/paths.ts`

- [ ] **Step 1: Refactor paths.ts to use defineTool**

Replace the entire `registerPathsTools` function:

```ts
// src/tools/paths.ts (full replacement of the export)
import { z } from 'zod';
import { defineTool } from './registry.ts';
import type { Workspace } from '../workspace.ts';
import { resolveConfig } from '../config.ts';
import { loadVaultChain, type VaultInfo } from '../vault-chain.ts';

export interface PathsPayload {
  global_dir: string;
  project_dir: string;
  workspaces_root: string;
  vaults: Array<{
    id: string;
    path: string;
    kind: 'personal' | 'team';
    remote: string | null;
    title?: string;
  }>;
}

export function resolvePathsPayload(dirs: { globalDir: string; projectDir: string }): PathsPayload {
  const cfg = resolveConfig({ projectDir: dirs.projectDir, globalDir: dirs.globalDir });
  const chain = loadVaultChain(cfg.vaults);
  return {
    global_dir: dirs.globalDir,
    project_dir: dirs.projectDir,
    workspaces_root: cfg.workspacesRoot,
    vaults: chain.map((v: VaultInfo) => ({
      id: v.id,
      path: v.path,
      kind: v.kind,
      remote: v.remote,
      ...(v.title ? { title: v.title } : {}),
    })),
  };
}

export function registerPathsEntries(ws: Workspace): void {
  defineTool({
    name: 'paths.get',
    description:
      'Returns resolved installation paths: global dir, project dir, workspaces root, and registered vault chain (ordered leaf→root).',
    parameters: z.object({
      workspace_id: z.string().optional().describe('Workspace ID override (uses caller context if omitted).'),
    }),
    handler: async () => {
      const payload = resolvePathsPayload({
        globalDir: ws.globalDir,
        projectDir: ws.projectDir,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
    examples: [
      { description: 'Get all resolved paths', args: {} },
    ],
    source: 'builtin',
    sourceFile: new URL(import.meta.url).pathname,
  });
}
```

- [ ] **Step 2: Run existing tests to confirm nothing breaks**

Run: `cd mcp-server && node --import tsx --test tests/smoke.test.mjs`
Expected: Tests that call `paths.get` will now fail because server.ts still calls `registerPathsTools` (which no longer exists). This is expected — we fix it in Task 5.

- [ ] **Step 3: Commit (WIP)**

```bash
git add src/tools/paths.ts
git commit -m "refactor(paths): migrate to defineTool registry pattern

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Refactor all remaining tool families

Each file follows the same mechanical pattern as Task 3. The key transformation for every file:

1. Remove `import { McpServer }` and the `server` parameter
2. Add `import { defineTool } from './registry.ts'`
3. Replace `server.registerTool('name', { description, inputSchema }, handler)` with `defineTool({ name, description, parameters: <the inputSchema zod>, handler, source: 'builtin', sourceFile: ... })`
4. Rename the export from `registerXTools` to `registerXEntries`
5. For tools that don't take `ws` (thread.ts, approval.ts): the handler closure captures the required stores directly (they already import from `../store.ts`)

**Files to refactor (in order — each is independent):**
- `src/tools/notify.ts` (1 tool — simple)
- `src/tools/ui.ts` (1 tool — simple)
- `src/tools/feedback.ts` (3 tools)
- `src/tools/approval.ts` (3 tools)
- `src/tools/artifact.ts` (4 tools)
- `src/tools/workspace.ts` (4 tools)
- `src/tools/skill.ts` (4 tools)
- `src/tools/renderer.ts` (4 tools)
- `src/tools/thread.ts` (6 tools)
- `src/tools/inbox.ts` (6 tools)
- `src/tools/plugin.ts` (6 tools)
- `src/tools/recipe.ts` (12 tools)
- `src/tools/trigger.ts` (12 tools)

- [ ] **Step 1: Refactor notify.ts**

Transform pattern (same for all files — showing notify.ts as it's smallest):

```ts
// src/tools/notify.ts — key changes only
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { loadNotificationsConfig } from '../config.ts';
import { sendNotification } from '../notifications.ts';
import type { Workspace } from '../workspace.ts';

export function registerNotifyEntries(ws: Workspace): void {
  defineTool({
    name: 'notify.send',
    description: 'Send a browser push notification to every subscribed device.',
    parameters: z.object({
      title: z.string().min(1).max(120),
      body: z.string().max(400).optional(),
      url: z.string().optional(),
      tag: z.string().max(80).optional(),
    }),
    handler: async (args) => {
      // ... existing handler body unchanged ...
    },
    examples: [
      { description: 'Send a simple notification', args: { title: 'Build passed!' } },
    ],
    source: 'builtin',
    sourceFile: new URL(import.meta.url).pathname,
  });
}
```

- [ ] **Step 2: Refactor ui.ts** (same mechanical pattern)

- [ ] **Step 3: Refactor feedback.ts** (3 defineTool calls)

- [ ] **Step 4: Refactor approval.ts** (3 defineTool calls)

- [ ] **Step 5: Refactor artifact.ts** (4 defineTool calls)

- [ ] **Step 6: Refactor workspace.ts** (4 defineTool calls — NOTE: be careful not to rename the workspace type export)

- [ ] **Step 7: Refactor skill.ts** (4 defineTool calls)

- [ ] **Step 8: Refactor renderer.ts** (4 defineTool calls)

- [ ] **Step 9: Refactor thread.ts** (6 defineTool calls — no `ws` param)

- [ ] **Step 10: Refactor inbox.ts** (6 defineTool calls)

- [ ] **Step 11: Refactor plugin.ts** (6 defineTool calls)

- [ ] **Step 12: Refactor recipe.ts** (12 defineTool calls — largest file)

- [ ] **Step 13: Refactor trigger.ts** (12 defineTool calls)

- [ ] **Step 14: Commit all refactored files**

```bash
git add src/tools/*.ts
git commit -m "refactor(tools): migrate all built-in tool families to registry pattern

All 14 tool family files now export registerXEntries() functions that call
defineTool() instead of server.registerTool(). The MCP server parameter
is removed from their signatures.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Refactor hosted.ts (plugin tools → registry)

**Files:**
- Modify: `mcp-server/src/tools/hosted.ts`

- [ ] **Step 1: Modify discoverTools to use defineTool**

The key change: instead of returning a `HostedToolRegistry`, the function calls `defineTool()` for each discovered tool. The handler wraps the plugin's `execute` with the existing `buildToolContext` and result formatting.

```ts
// src/tools/hosted.ts — key structural change

import { defineTool } from './registry.ts';

// Keep: ToolContext, ToolWorkspace, ToolLogger interfaces (exported for SDK)
// Keep: discoverTools function shape but change its body
// Remove: registerHostedTools, registerOneHostedTool (no longer needed)
// Keep: buildToolContext, formatSuccess, formatError (used by hosted tool handlers)

export async function discoverAndRegisterHostedTools(ws: Workspace): Promise<{
  errors: HostedToolError[];
}> {
  const errors: HostedToolError[] = [];
  const seenIds = new Set<string>();

  for (const plugin of ws.plugins.values()) {
    if (plugin.status !== 'enabled') continue;
    for (const entry of plugin.capabilities.tools) {
      // ... existing validation logic (unchanged) ...

      // Instead of pushing to tools array, register directly:
      defineTool({
        name: tool.id, // e.g. 'ado.get_pr'
        description: tool.description,
        parameters: tool.parameters,
        handler: async (args, extra) => {
          const ctx = buildToolContext({
            pluginId: tool.plugin_id,
            ws,
            signal: extra?.signal ?? new AbortController().signal,
          });
          const out = await tool.execute(args, ctx);
          return formatSuccess(tool.id, out);
        },
        source: tool.plugin_id,
        sourceFile: tool.file,
      });
      seenIds.add(entry.id);
    }
  }

  return { errors };
}
```

- [ ] **Step 2: Run hosted-tools test to verify discovery still works**

Run: `cd mcp-server && node --import tsx --test tests/hosted-tools.test.mjs`
Expected: May need adjustment since the test checks for individually-registered tools — will adapt in Task 7.

- [ ] **Step 3: Commit**

```bash
git add src/tools/hosted.ts
git commit -m "refactor(hosted): plugin tools register via defineTool

discoverAndRegisterHostedTools() now calls defineTool() per hosted tool
instead of returning a HostedToolRegistry for separate registration.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Wire up server.ts

**Files:**
- Modify: `mcp-server/src/server.ts`

- [ ] **Step 1: Rewrite server.ts to use the new pattern**

```ts
// src/server.ts (full rewrite)
/**
 * server.ts — Builds the McpServer with the 3 meta-tools.
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
 * Must be called before registerMetaTools().
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
}

/**
 * Create a fresh McpServer for a session. Clears and re-populates the registry
 * so each session gets a clean tool set.
 */
export function createSessionServer(
  ws: Workspace,
  hostedErrors: HostedToolError[],
): McpServer {
  clearRegistry();
  registerAllBuiltinEntries(ws);
  // Note: hosted tools are already in the registry from buildServer()
  // For per-session servers, we need to re-register them.
  // This is handled by the session factory calling registerAllBuiltinEntries.

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerMetaTools(server);
  return server;
}

export async function buildServer(ws: Workspace): Promise<BuiltServer> {
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
```

- [ ] **Step 2: Run the build to check for type errors**

Run: `cd mcp-server && npx tsc --noEmit`
Expected: Type errors from any callers of `BuiltServer.hostedRegistry` (renamed to `hostedErrors`). Fix those.

- [ ] **Step 3: Fix any import/type errors in other files**

Grep for `hostedRegistry` and update callers:
- `src/cli/start.ts` — update to use `hostedErrors` 
- Any other files referencing `HostedToolRegistry`

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/cli/start.ts
git commit -m "refactor(server): wire meta-tools as the only MCP surface

server.ts now registers only list_tools, learn_tool, run_tool. All tool
families populate the central registry before the meta-tools are mounted.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Update existing tests

**Files:**
- Modify: `mcp-server/tests/smoke.test.mjs`
- Modify: `mcp-server/tests/hosted-tools.test.mjs`

- [ ] **Step 1: Update smoke.test.mjs**

The smoke test currently calls individual tools by name via the MCP protocol. Update it to use `run_tool`:

```js
// Before:
// const result = await client.callTool('inbox.list', { state: 'new' });

// After:
// const result = await client.callTool('run_tool', { tool: 'inbox.list', args: { state: 'new' } });
```

Also update the `tools/list` assertions: instead of expecting 30+ tools, expect exactly 3 (`list_tools`, `learn_tool`, `run_tool`).

- [ ] **Step 2: Update hosted-tools.test.mjs**

Update assertions that check for individually-registered tool names. The test should now verify:
1. `list_tools` shows `ado.get_pr` etc. in its output
2. `learn_tool` returns schema for `ado.get_pr`
3. `run_tool` dispatches to the ADO tool (with mocked fetch)

- [ ] **Step 3: Run the full test suite**

Run: `cd mcp-server && node --import tsx --test tests/smoke.test.mjs tests/hosted-tools.test.mjs tests/meta-tools.test.mjs`
Expected: All PASS

- [ ] **Step 4: Run ALL tests to check for regressions**

Run: `cd mcp-server && npm test`
Expected: All tests pass. Fix any that reference old tool registration patterns.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test: update smoke and hosted-tools tests for meta-tools

Tests now exercise tools via run_tool dispatch instead of calling
individually-registered MCP tools.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Add sibling .md documentation for key tools

**Files:**
- Create: `mcp-server/src/tools/inbox.list.md`
- Create: `mcp-server/src/tools/recipe.run.md`
- Create: `mcp-server/src/tools/paths.get.md`

- [ ] **Step 1: Create inbox.list.md**

```markdown
# inbox.list

List inbox items (metadata only — body content NOT included).

## Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| kind | string | no | Filter by item kind |
| state | "new" \| "open" \| "snoozed" \| "archived" \| "done" | no | Filter by state |
| label | string | no | Case-insensitive label match |
| limit | number | no | Max items (1-500) |
| cursor | string | no | Pagination cursor from previous response |

## Examples

```json
{ "tool": "inbox.list", "args": {} }
```

List only new items:
```json
{ "tool": "inbox.list", "args": { "state": "new" } }
```

Filter by label with pagination:
```json
{ "tool": "inbox.list", "args": { "label": "urgent", "limit": 10 } }
```

## Notes

- To get the full body of an item, use `inbox.read` with the item's `id`.
- Results are ordered by creation date (newest first).
```

- [ ] **Step 2: Create recipe.run.md** (similar detailed docs)

- [ ] **Step 3: Create paths.get.md** (similar detailed docs)

- [ ] **Step 4: Verify learn_tool returns the .md content**

Run a quick manual test or add an assertion in `meta-tools.test.mjs` that seeds a tool with a known `sourceFile` pointing to a temporary `.md` file, then verifies `learn_tool` returns its content.

- [ ] **Step 5: Commit**

```bash
git add src/tools/*.md tests/meta-tools.test.mjs
git commit -m "docs: add sibling .md documentation for key tools

Adds usage docs for inbox.list, recipe.run, paths.get as examples of the
sibling .md convention. learn_tool returns these to agents.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Final integration test & cleanup

**Files:**
- Modify: `mcp-server/package.json` (add meta-tools test to test script)

- [ ] **Step 1: Add meta-tools.test.mjs to the test script in package.json**

Append `tests/meta-tools.test.mjs` to the `"test"` script's file list.

- [ ] **Step 2: Run the full test suite**

Run: `cd mcp-server && npm test`
Expected: All tests pass including the new meta-tools tests.

- [ ] **Step 3: Run the build**

Run: `cd mcp-server && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Manual smoke test — start server, call list_tools**

Run: `cd mcp-server && node --import tsx src/index.ts --global-dir /tmp/test-global --project-dir /tmp/test-project`
Send JSON-RPC `tools/list` → verify only 3 tools appear.
Send `tools/call` with `list_tools` → verify all tool names are listed.

- [ ] **Step 5: Commit & final squash if desired**

```bash
git add .
git commit -m "feat(meta-tools): complete meta-tools implementation

Replaces 68 individually-registered MCP tools with 3 meta-tools:
- list_tools: discover available tools
- learn_tool: get schemas, examples, and .md docs
- run_tool: execute by name with validated args

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Execution Order & Dependencies

```
Task 1 (registry.ts)
  └─→ Task 2 (meta-tools.ts)
        └─→ Task 3 (paths.ts migration example)
              └─→ Task 4 (all other families) ← PARALLELIZABLE per file
                    └─→ Task 5 (hosted.ts)
                          └─→ Task 6 (server.ts wiring)
                                └─→ Task 7 (test updates)
                                      └─→ Task 8 (sibling .md docs)
                                            └─→ Task 9 (integration)
```

Tasks 4's sub-steps (each tool family file) are fully parallelizable — they have no dependencies on each other.
