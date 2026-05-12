/**
 * @conductor/sdk — type-only SDK for Conductor plugin authors.
 *
 * The shape every hostable tool (spec §10.3) receives as its second argument
 * when Conductor's MCP server invokes it. The first argument is the parsed +
 * validated zod schema described by the tool file's `parameters` export.
 *
 * Hostable-tool file shape:
 *
 *   import { z } from 'zod';
 *   import type { ToolContext } from '@conductor/sdk';
 *
 *   export const id = 'ado.get_pr';
 *   export const description = 'Get PR metadata for a single PR id.';
 *   export const parameters = z.object({
 *     org: z.string().optional(),
 *     repo: z.string(),
 *     pr_id: z.number().int().positive(),
 *   });
 *
 *   export default async function execute(
 *     args: z.infer<typeof parameters>,
 *     ctx: ToolContext,
 *   ) {
 *     // ...
 *     return { pullRequest: {...} };
 *   }
 *
 * What Conductor does at discovery: dynamic-import the file, validate the
 * exported shape (id / description / parameters / default), build an MCP
 * tool registration with `parameters`'s JSON Schema, and at call-time route
 * the request through `execute(args, ctx)`. The return value becomes the
 * tool's `structuredContent`. Thrown errors become MCP tool errors with
 * `{ code, message }`.
 */

// ============================================================================
// ToolContext — the runtime context passed to every hostable tool's execute()
// ============================================================================

/**
 * Logger surface. All output goes to the Conductor MCP server's stderr; never
 * stdout (stdout carries the JSON-RPC protocol frame for stdio MCP transports).
 *
 * `info` / `warn` / `error` are the only levels — keep tool logging simple.
 */
export interface ToolLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Workspace paths the tool is allowed to read/write under. `project_dir` is
 * the workspace root (`CONDUCTOR_PROJECT_DIR`); `plugin_dir` is the plugin's
 * own root under `.conductor/plugins/<id>/`; `plugin_data_dir` is a stable
 * per-plugin scratch directory at `<project_dir>/.conductor/data/<plugin_id>/`
 * — Conductor creates it lazily on first access.
 */
export interface ToolWorkspace {
  project_dir: string;
  plugin_dir: string;
  plugin_data_dir: string;
}

/**
 * The context object Conductor's MCP server passes as the second argument to
 * every hostable tool's `execute(args, ctx)`. All fields are read-only from
 * the tool's perspective — mutating them does not affect Conductor.
 *
 * - `env` is a snapshot of `process.env` at server start (plus any plugin-
 *   scoped overrides the `mcp/ado.json`-style config has injected). Tools
 *   should treat it as read-only.
 * - `workspace` exposes the three directories the tool may touch.
 * - `fetch` is a reference to the global `fetch` (already available in
 *   Node 20+); provided so unit tests can swap it for a fake.
 * - `logger` writes to stderr — never to stdout.
 * - `signal` is an `AbortSignal` that fires when the calling agent cancels.
 *   Tools doing network calls or spawning subprocesses MUST pass it through
 *   so cancel-cascade works (spec §13).
 */
export interface ToolContext {
  /** Read-only snapshot of process.env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolved paths the tool may read/write under. */
  readonly workspace: ToolWorkspace;
  /** Node's global fetch — captured here for testability. */
  readonly fetch: typeof globalThis.fetch;
  /** Logger that writes to the Conductor server's stderr. */
  readonly logger: ToolLogger;
  /** AbortSignal that fires on caller cancellation. Pass through to fetch / spawn. */
  readonly signal: AbortSignal;
}
