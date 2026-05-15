/**
 * tools/hosted.ts
 *
 * Hostable tool host (spec §10.3). Responsible for:
 *
 *   1. Discovering every `provides.tools[]` entry across enabled plugins.
 *   2. Dynamic-importing each tool file (`file://...` ESM import).
 *   3. Validating the module's exported shape — `id`, `description`,
 *      `parameters` (zod), default `execute(args, ctx)`.
 *   4. Registering each as an MCP tool on the Clawdevbox server, with the
 *      tool's zod schema doubling as the inputSchema (the MCP SDK accepts
 *      a zod schema directly and converts to JSON Schema for tools/list).
 *   5. At call-time, building a `ToolContext` and routing the request through
 *      the tool's `execute(args, ctx)`. Throws become structured tool errors.
 *
 * The Clawdevbox MCP server runs under `tsx` in dev/sample setups, so dynamic
 * imports of `.ts` files resolve directly. Production builds compile the
 * tool files to `.js` first; the same import path works.
 *
 * Cancellation: every call gets a fresh AbortController whose `.abort()` is
 * wired to the MCP request's AbortSignal (via `extra.signal` on the tool
 * callback). Tools that respect `ctx.signal` cancel cleanly when the agent
 * cancels its request.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve as pathResolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../logger.ts';
import { z } from 'zod';
import type { Workspace } from '../workspace.ts';

// ============================================================================
// Public types — also re-exported for the smoke tests.
// ============================================================================

/**
 * Mirrors `@clawdevbox/sdk`'s ToolContext. Defined here too because the
 * server is the producer; `@clawdevbox/sdk` is the consumer-facing types-only
 * package plugin authors import. Keeping the two in sync is a manual
 * discipline (the shape is small and stable).
 */
export interface ToolLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ToolWorkspace {
  project_dir: string;
  plugin_dir: string;
  plugin_data_dir: string;
}

export interface ToolContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly workspace: ToolWorkspace;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: ToolLogger;
  readonly signal: AbortSignal;
}

/** A successfully discovered + validated hostable tool. */
export interface HostedTool {
  /** Tool id (the MCP tool name); namespaced like 'ado.get_pr'. */
  id: string;
  /** Plugin id this tool belongs to. */
  plugin_id: string;
  /** Absolute path to the tool's source file. */
  file: string;
  /** Imported module's `description` export. */
  description: string;
  /** Imported module's `parameters` export — a zod schema. */
  parameters: z.ZodTypeAny;
  /** Imported module's default export — the execute function. */
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

/** A tool whose discovery or import failed. Surfaced via plugin.list. */
export interface HostedToolError {
  plugin_id: string;
  tool_id: string;
  file: string;
  error: string;
}

export interface HostedToolRegistry {
  tools: HostedTool[];
  errors: HostedToolError[];
}

// ============================================================================
// Discovery — walk ws.plugins, dynamic-import each provides.tools[] entry.
// ============================================================================

const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Walk every enabled plugin, dynamic-import each `provides.tools[]` entry,
 * and return a registry of valid tools + the errors for invalid ones.
 *
 * Errors do NOT throw — they go into `registry.errors` so the rest of the
 * server can boot. The renderer's plugin panel surfaces them via plugin.list.
 */
export async function discoverTools(ws: Workspace): Promise<HostedToolRegistry> {
  const tools: HostedTool[] = [];
  const errors: HostedToolError[] = [];
  const seenIds = new Set<string>();

  for (const plugin of ws.plugins.values()) {
    if (plugin.status !== 'enabled') continue;
    const list = plugin.manifest.provides?.tools ?? [];
    for (const entry of list) {
      const recordError = (msg: string) => {
        errors.push({
          plugin_id: plugin.id,
          tool_id: entry.id,
          file: entry.file,
          error: msg,
        });
      };

      // Manifest validator already enforces these, but defense-in-depth at
      // import time guards against hand-edited manifests.
      if (typeof entry.id !== 'string' || !TOOL_ID_PATTERN.test(entry.id)) {
        recordError(`tool id ${JSON.stringify(entry.id)} must match ${TOOL_ID_PATTERN}`);
        continue;
      }
      if (seenIds.has(entry.id)) {
        recordError(`tool id ${entry.id} already registered by another plugin`);
        continue;
      }

      const abs = resolveToolFile(plugin.dir, entry.file);
      if (!abs) {
        recordError(`tool file path escapes plugin directory: ${entry.file}`);
        continue;
      }
      if (!existsSync(abs)) {
        recordError(`tool file not found: ${abs}`);
        continue;
      }

      let mod: Record<string, unknown>;
      try {
        // ESM dynamic import — file:// URL avoids OS path quirks on Windows.
        mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordError(`import failed: ${msg}`);
        continue;
      }

      const shapeCheck = validateToolModule(mod, entry.id);
      if (!shapeCheck.ok) {
        recordError(shapeCheck.error);
        continue;
      }

      tools.push({
        id: entry.id,
        plugin_id: plugin.id,
        file: abs,
        description: shapeCheck.description,
        parameters: shapeCheck.parameters,
        execute: shapeCheck.execute,
      });
      seenIds.add(entry.id);
    }
  }

  return { tools, errors };
}

function resolveToolFile(pluginDir: string, relFile: string): string | null {
  const abs = pathResolve(pluginDir, relFile);
  if (!abs.startsWith(pluginDir + sep) && abs !== pluginDir) return null;
  return abs;
}

interface ToolModuleShape {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

function validateToolModule(
  mod: Record<string, unknown>,
  expectedId: string,
): { ok: true } & ToolModuleShape | { ok: false; error: string } {
  if (typeof mod.id !== 'string' || mod.id.length === 0) {
    return { ok: false, error: 'module is missing a string `id` export' };
  }
  if (mod.id !== expectedId) {
    return {
      ok: false,
      error: `module id (${mod.id}) does not match manifest id (${expectedId})`,
    };
  }
  if (typeof mod.description !== 'string' || mod.description.length === 0) {
    return { ok: false, error: 'module is missing a string `description` export' };
  }
  if (!isZodSchema(mod.parameters)) {
    return { ok: false, error: 'module is missing a zod `parameters` export' };
  }
  if (typeof mod.default !== 'function') {
    return { ok: false, error: 'module is missing a default-exported `execute` function' };
  }
  return {
    ok: true,
    description: mod.description,
    parameters: mod.parameters,
    execute: mod.default as (args: unknown, ctx: ToolContext) => Promise<unknown>,
  };
}

/** Cheap structural check for "is this a zod schema?" — works for v3 and v4. */
function isZodSchema(x: unknown): x is z.ZodTypeAny {
  if (x === null || typeof x !== 'object') return false;
  const candidate = x as Record<string, unknown>;
  // v3: `_def` + `parse` + `safeParse`. v4: `_zod` symbol. Either way these are present.
  const hasParse = typeof candidate.parse === 'function' || typeof candidate.safeParse === 'function';
  const hasDef = '_def' in candidate || '_zod' in candidate;
  return hasParse && hasDef;
}

// ============================================================================
// Registration — wire each discovered tool into the MCP server.
// ============================================================================

/**
 * Register every discovered tool as an MCP tool on `server`. Errors from
 * discovery are logged to stderr and surfaced via plugin.list elsewhere.
 *
 * The `ws` argument is needed at call-time to build per-plugin workspace
 * paths (project_dir / plugin_dir / plugin_data_dir).
 */
export function registerHostedTools(
  server: McpServer,
  registry: HostedToolRegistry,
  ws: Workspace,
): void {
  for (const err of registry.errors) {
    logger.warn(
      { pluginId: err.plugin_id, toolId: err.tool_id, file: err.file, err: err.error },
      'hosted-tool discovery error',
    );
  }
  for (const tool of registry.tools) {
    registerOneHostedTool(server, tool, ws);
  }
}

function registerOneHostedTool(server: McpServer, tool: HostedTool, ws: Workspace): void {
  server.registerTool(
    tool.id,
    {
      description: tool.description,
      // The MCP SDK accepts a zod object schema directly here; it'll convert
      // to JSON Schema internally for `tools/list`. For non-object schemas
      // (rare for tools), we leave it as-is — the SDK handles it.
      inputSchema: tool.parameters as z.ZodTypeAny,
    },
    async (args: unknown, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
      const ctx = buildToolContext({
        pluginId: tool.plugin_id,
        ws,
        signal: extra.signal ?? new AbortController().signal,
      });
      try {
        const out = await tool.execute(args, ctx);
        return formatSuccess(tool.id, out);
      } catch (err) {
        return formatError(tool.id, err);
      }
    },
  );
}

// ============================================================================
// ToolContext factory
// ============================================================================

interface BuildToolContextArgs {
  pluginId: string;
  ws: Workspace;
  signal: AbortSignal;
}

export function buildToolContext(args: BuildToolContextArgs): ToolContext {
  // Use the registry entry's dir (resolves junctioned local plugins
  // correctly) and fall back to the canonical global path for tests
  // that build contexts without going through discovery.
  const registryEntry = args.ws.plugins.get(args.pluginId);
  const pluginDirPath =
    registryEntry?.dir ?? join(args.ws.globalDir, 'plugins', args.pluginId);
  // Per-plugin scratch data stays per-project: each workspace gets its
  // own data file even though the plugin code is shared globally.
  const pluginDataDir = join(args.ws.projectDir, '.clawdevbox', 'data', args.pluginId);
  // Lazy create — many tools never write under here, but if they do the dir exists.
  try {
    mkdirSync(pluginDataDir, { recursive: true });
  } catch {
    // Ignore — tool itself will surface a clear error if it tries to write.
  }

  return {
    env: { ...process.env } as Readonly<Record<string, string | undefined>>,
    workspace: {
      project_dir: args.ws.projectDir,
      plugin_dir: pluginDirPath,
      plugin_data_dir: pluginDataDir,
    },
    fetch: globalThis.fetch,
    logger: makeStderrLogger(args.pluginId),
    signal: args.signal,
  };
}

function makeStderrLogger(pluginId: string): ToolLogger {
  const child = logger.child({ pluginId });
  return {
    info: (m, meta) => child.info(meta ?? {}, m),
    warn: (m, meta) => child.warn(meta ?? {}, m),
    error: (m, meta) => child.error(meta ?? {}, m),
  };
}

// ============================================================================
// Result formatting
// ============================================================================

function formatSuccess(toolId: string, value: unknown): CallToolResult {
  if (value !== null && typeof value === 'object') {
    return {
      content: [{ type: 'text', text: oneLineSummary(toolId, value as Record<string, unknown>) }],
      structuredContent: value as Record<string, unknown>,
    };
  }
  // Non-object return — wrap as text.
  return {
    content: [{ type: 'text', text: String(value ?? '') }],
  };
}

function oneLineSummary(toolId: string, value: Record<string, unknown>): string {
  // Try to pluck a useful field for the human-readable text. Falls back to
  // a generic "<tool> ok" so the result is never empty.
  const keys = ['summary', 'text', 'title', 'count'];
  for (const k of keys) {
    const v = value[k];
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return `${toolId}: ${k}=${v}`;
  }
  return `${toolId}: ok`;
}

function formatError(toolId: string, err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  // If the thrown Error carries a `code`, surface it as the structured code.
  const code =
    err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string'
      ? (err as Error & { code: string }).code
      : 'TOOL_ERROR';
  return {
    isError: true,
    content: [{ type: 'text', text: `${toolId}: ${message}` }],
    structuredContent: { code, message, tool: toolId },
  };
}
