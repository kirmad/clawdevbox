/**
 * context-resolver.ts
 *
 * Resolves the calling agent's workspace context for MCP tool handlers.
 *
 * Why this exists
 * ---------------
 * The clawdevbox MCP server is long-lived and shared across multiple agent
 * sessions in HTTP mode (`clawdevbox start`'s Streamable HTTP transport).
 * The server's own `process.env.CLAWDEVBOX_WORKSPACE_ID` is fixed at server
 * startup and CANNOT be used to identify the calling agent in HTTP mode —
 * this is a fundamental property of the transport, not a bug.
 *
 * Each spawned agent's `.mcp.json` injects per-spawn HTTP headers that carry
 * the workspace context. Tool handlers receive the MCP SDK's RequestHandlerExtra
 * argument, which exposes `extra.requestInfo.headers`. This module reads them.
 *
 * Resolution chain (in order)
 * ---------------------------
 *   1. Explicit argument:        e.g. `paths.get({ workspace_id: "ws_..." })`
 *   2. HTTP header:              X-Clawdevbox-Workspace-Id
 *                                (read via extra.requestInfo.headers)
 *   3. Env var:                  process.env.CLAWDEVBOX_WORKSPACE_ID
 *                                (correct in stdio mode — server is agent's child)
 *   4. Project-dir match:        find workspace whose `path` equals
 *                                X-Clawdevbox-Project-Dir header OR
 *                                process.env.CLAWDEVBOX_PROJECT_DIR
 *   5. Structured error:         NO_TARGET_WORKSPACE
 *
 * Tools that today read process.env directly MUST migrate to this resolver
 * to work correctly with multiple concurrent HTTP agent sessions. The env-var
 * fallback (step 3) keeps stdio-mode behaviour unchanged.
 */

import { resolve as pathResolve } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { structuredError } from './scope.ts';
import {
  findWorkspaceByPath,
  getWorkspace,
  resolveWorkspacesRoot,
  type WorkspaceInfo,
} from './workspaces-store.ts';

// ============================================================================
// Header constants (the contract between writeMcpJson and tool handlers)
// ============================================================================

export const HEADER_WORKSPACE_ID = 'x-clawdevbox-workspace-id';
export const HEADER_RECIPE_INSTANCE_ID = 'x-clawdevbox-recipe-instance-id';
export const HEADER_PROJECT_DIR = 'x-clawdevbox-project-dir';
export const HEADER_SESSION_ID = 'x-clawdevbox-session-id';

// ============================================================================
// Types
// ============================================================================

/**
 * A subset of the MCP SDK's RequestHandlerExtra that this resolver needs.
 * We don't import the SDK's type directly to keep this module independent
 * and testable without spinning up a real transport.
 */
export interface ResolveExtra {
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined>;
  };
}

export type ResolutionSource = 'arg' | 'header' | 'env' | 'cwd';

export interface WorkspaceContext {
  workspaceId: string;
  workspacePath: string;
  workspaceInfo: WorkspaceInfo;
  recipeInstanceId: string | null;
  projectDir: string | null;
  /** Which resolution step succeeded — useful for diagnostics. */
  source: ResolutionSource;
}

// ============================================================================
// Header helpers
// ============================================================================

/**
 * HTTP headers are case-insensitive but Node normalizes them to lowercase
 * when they arrive on a request. This helper handles both casings + arrays.
 */
function readHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    }
  }
  return null;
}

// ============================================================================
// Workspace resolution
// ============================================================================

export interface ResolveOptions {
  /** Explicit override (highest precedence). */
  argsWorkspaceId?: string;
  /** Explicit override (highest precedence) for the project_dir hint. */
  argsProjectDir?: string;
}

/**
 * Resolve the calling agent's workspace context using the standard chain.
 *
 * Returns either a `WorkspaceContext` with all the fields filled in, or a
 * structured error result suitable for direct return from an MCP tool handler.
 */
export function resolveWorkspaceContext(
  extra: ResolveExtra | undefined,
  options: ResolveOptions = {},
):
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; error: CallToolResult } {
  const headers = extra?.requestInfo?.headers;
  const root = resolveWorkspacesRoot();

  // ----- Step 1: explicit argument override ---------------------------------
  if (options.argsWorkspaceId) {
    const info = getWorkspace(root, options.argsWorkspaceId);
    if (!info) {
      return {
        ok: false,
        error: structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${options.argsWorkspaceId} not found in registry.`,
          { workspace_id: options.argsWorkspaceId, source: 'arg' },
        ),
      };
    }
    return {
      ok: true,
      ctx: buildCtx(info, /* recipeInstance */ resolveRecipeInstanceId(extra), /* projectDir */ extra ? readHeader(headers, HEADER_PROJECT_DIR) : null, 'arg'),
    };
  }

  // ----- Step 2: HTTP header (dominant in HTTP-MCP mode) --------------------
  const headerWsId = readHeader(headers, HEADER_WORKSPACE_ID);
  if (headerWsId) {
    const info = getWorkspace(root, headerWsId);
    if (!info) {
      return {
        ok: false,
        error: structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${headerWsId} from ${HEADER_WORKSPACE_ID} header not found in registry.`,
          { workspace_id: headerWsId, source: 'header' },
        ),
      };
    }
    return {
      ok: true,
      ctx: buildCtx(info, resolveRecipeInstanceId(extra), readHeader(headers, HEADER_PROJECT_DIR), 'header'),
    };
  }

  // ----- Step 3: env var (correct in stdio mode; server is agent's child) ---
  const envWsId = process.env.CLAWDEVBOX_WORKSPACE_ID;
  if (envWsId) {
    const info = getWorkspace(root, envWsId);
    if (!info) {
      return {
        ok: false,
        error: structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${envWsId} from CLAWDEVBOX_WORKSPACE_ID env not found in registry.`,
          { workspace_id: envWsId, source: 'env' },
        ),
      };
    }
    return {
      ok: true,
      ctx: buildCtx(info, resolveRecipeInstanceId(extra), process.env.CLAWDEVBOX_PROJECT_DIR ?? null, 'env'),
    };
  }

  // ----- Step 4: project-dir match (header or env) --------------------------
  const projectDirHint =
    options.argsProjectDir ??
    readHeader(headers, HEADER_PROJECT_DIR) ??
    process.env.CLAWDEVBOX_PROJECT_DIR ??
    null;

  if (projectDirHint) {
    const matched = findWorkspaceByPath(root, projectDirHint);
    if (matched) {
      return {
        ok: true,
        ctx: buildCtx(matched, resolveRecipeInstanceId(extra), projectDirHint, 'cwd'),
      };
    }
  }

  // ----- Step 5: nothing matched -------------------------------------------
  return {
    ok: false,
    error: structuredError(
      'NO_TARGET_WORKSPACE',
      `No workspace_id provided as argument, ${HEADER_WORKSPACE_ID} header not set, ` +
        `CLAWDEVBOX_WORKSPACE_ID env not set, and project_dir (header / env) is not a ` +
        `registered workspace.`,
      {
        tried_arg: options.argsWorkspaceId ?? null,
        tried_header: readHeader(headers, HEADER_WORKSPACE_ID),
        tried_env: process.env.CLAWDEVBOX_WORKSPACE_ID ?? null,
        tried_project_dir: projectDirHint,
      },
    ),
  };
}

/**
 * Resolve only the recipe-instance id (not the workspace). Useful for tools
 * that need the instance id without doing full workspace resolution.
 *
 * Resolution chain mirrors workspace resolution:
 *   1. (none — caller passes via argsRecipeInstanceId on the outer API)
 *   2. HTTP header X-Clawdevbox-Recipe-Instance-Id
 *   3. process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID
 *
 * Returns null if unresolved. The caller decides whether that's an error.
 */
export function resolveRecipeInstanceId(extra: ResolveExtra | undefined): string | null {
  const headerVal = readHeader(extra?.requestInfo?.headers, HEADER_RECIPE_INSTANCE_ID);
  if (headerVal) return headerVal;
  return process.env.CLAWDEVBOX_RECIPE_INSTANCE_ID ?? null;
}

/**
 * Resolve the agent's session id from header or env. Mirrors the recipe
 * instance id chain. Used by step-status tools to attribute changes to a
 * specific agent session.
 *
 * Note: the writers set `CLAWDEVBOX_SESSION_ID` (in cli/start.ts and
 * recipe-runner.ts). The header name is `X-Clawdevbox-Session-Id`.
 */
export function resolveAgentSessionId(extra: ResolveExtra | undefined): string | null {
  const headerVal = readHeader(extra?.requestInfo?.headers, HEADER_SESSION_ID);
  if (headerVal) return headerVal;
  return process.env.CLAWDEVBOX_SESSION_ID ?? null;
}

// ============================================================================
// Internal helpers
// ============================================================================

function buildCtx(
  info: WorkspaceInfo,
  recipeInstanceId: string | null,
  projectDir: string | null,
  source: ResolutionSource,
): WorkspaceContext {
  return {
    workspaceId: info.id,
    workspacePath: info.path,
    workspaceInfo: info,
    recipeInstanceId,
    projectDir: projectDir ? pathResolve(projectDir) : null,
    source,
  };
}
