/**
 * tools/workspace.ts
 *
 * Workspace MCP surface — the 4-tool set that lets an agent create, list,
 * inspect, and resolve "current" workspaces. A workspace is a directory with
 * a `.conductor/` tree; the registry at `<workspaces_root>/index.json` is the
 * source of truth for which workspaces exist.
 *
 *   - workspace.create   — mint a new id, scaffold dirs, register
 *   - workspace.list     — read the registry
 *   - workspace.get      — full info + counts (plugins/recipes/skills/triggers)
 *   - workspace.current  — match CONDUCTOR_PROJECT_DIR against the registry
 *
 * The Conductor MCP server is booted with a fixed `Workspace` from
 * `loadWorkspaceFromEnv` (read-only context derived from CONDUCTOR_PROJECT_DIR).
 * These tools operate on the registry/filesystem directly, NOT on `ws`.
 */

import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { structuredError } from '../scope.ts';
import {
  countWorkspaceContents,
  createWorkspace,
  findWorkspaceByPath,
  getWorkspace,
  listWorkspaces,
  resolveWorkspacesRoot,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
} from '../workspaces-store.ts';
import type { Workspace } from '../workspace.ts';

export function registerWorkspaceTools(server: McpServer, ws: Workspace): void {
  // -- workspace.create -----------------------------------------------------
  server.registerTool(
    'workspace.create',
    {
      description:
        'Create a new Conductor workspace directory under <workspaces_root>/<id>/ (default <workspaces_root> = $CONDUCTOR_WORKSPACES_ROOT || ~/.conductor/workspaces). Scaffolds the .conductor/ tree (recipes/, skills/, plugins/, triggers.json, workspace.json, recipe-instances/) and registers in the workspace index. Optional: copy parent workspace plugins (`inherit_plugins`) or clone an existing workspace\'s .conductor tree (`copy_from`). Mutually exclusive.',
      inputSchema: {
        name: z.string().min(1).optional().describe('Human-readable name (optional).'),
        parent_workspace_id: z
          .string()
          .min(1)
          .optional()
          .describe('Parent workspace id, for recipe-run lineage.'),
        base_path: z
          .string()
          .min(1)
          .optional()
          .describe('Override the workspaces root for this call (parent dir; workspace goes at <base_path>/<id>).'),
        inherit_plugins: z
          .boolean()
          .optional()
          .describe('When true, copy the calling workspace\'s plugins/ tree (minus node_modules and _legacy-mcp-server) into the new workspace.'),
        copy_from: z
          .string()
          .min(1)
          .optional()
          .describe('Source workspace id to clone the .conductor/ tree from (except recipe-instances/ and workspace.json). Mutually exclusive with inherit_plugins.'),
      },
    },
    async (args) => {
      if (args.inherit_plugins && args.copy_from) {
        return structuredError(
          'INVALID_ARGS',
          'workspace.create: inherit_plugins and copy_from are mutually exclusive.',
        );
      }
      try {
        const result = createWorkspace({
          name: args.name,
          parent_workspace_id: args.parent_workspace_id,
          base_path: args.base_path,
          inherit_plugins: args.inherit_plugins,
          copy_from: args.copy_from,
          callerProjectDir: ws.projectDir,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Created workspace ${result.info.id} at ${result.info.path}.`,
            },
          ],
          structuredContent: {
            id: result.info.id,
            path: result.info.path,
            name: result.info.name,
            created_at: result.info.created_at,
            parent_workspace_id: result.info.parent_workspace_id,
            workspaces_root: result.workspacesRoot,
            inherited_plugins: result.inheritedPlugins ?? [],
            copied_from_subtrees: result.copiedFromSubtrees ?? [],
          },
        };
      } catch (err) {
        if (err instanceof WorkspaceConflictError) {
          return structuredError(err.code, err.message);
        }
        if (err instanceof WorkspaceNotFoundError) {
          return structuredError(err.code, err.message);
        }
        const msg = err instanceof Error ? err.message : String(err);
        return structuredError('WORKSPACE_CREATE_FAILED', msg);
      }
    },
  );

  // -- workspace.list -------------------------------------------------------
  server.registerTool(
    'workspace.list',
    {
      description:
        'List all known Conductor workspaces from <workspaces_root>/index.json. Returns id, path, name, created_at, parent_workspace_id for each.',
      inputSchema: {},
    },
    async () => {
      const root = resolveWorkspacesRoot();
      const workspaces = listWorkspaces(root);
      return {
        content: [{ type: 'text', text: `Found ${workspaces.length} workspace(s).` }],
        structuredContent: {
          workspaces,
          count: workspaces.length,
          workspaces_root: root,
        },
      };
    },
  );

  // -- workspace.get --------------------------------------------------------
  server.registerTool(
    'workspace.get',
    {
      description:
        'Read full info for a workspace by id — registry entry plus counts of plugins, recipes, skills, and registered triggers under its .conductor/ tree.',
      inputSchema: {
        id: z.string().min(1).describe('Workspace id (ws_<base36-ts>_<4hex>).'),
      },
    },
    async (args) => {
      const root = resolveWorkspacesRoot();
      const info = getWorkspace(root, args.id);
      if (!info) {
        return structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${args.id} not found in registry.`,
          { id: args.id },
        );
      }
      const dirExists = existsSync(info.path);
      const counts = dirExists
        ? countWorkspaceContents(info.path)
        : { plugins: 0, recipes: 0, skills: 0, registered_triggers: 0 };
      return {
        content: [
          {
            type: 'text',
            text: `Workspace ${info.id} at ${info.path}${dirExists ? '' : ' (MISSING ON DISK)'}.`,
          },
        ],
        structuredContent: {
          id: info.id,
          path: info.path,
          name: info.name,
          created_at: info.created_at,
          parent_workspace_id: info.parent_workspace_id,
          dir_exists: dirExists,
          counts,
        },
      };
    },
  );

  // -- workspace.current ----------------------------------------------------
  server.registerTool(
    'workspace.current',
    {
      description:
        'Resolve the workspace matching the current CONDUCTOR_PROJECT_DIR against the registry. Returns the WorkspaceInfo, or { found: false } if the current project_dir is not a registered workspace.',
      inputSchema: {},
    },
    async () => {
      const root = resolveWorkspacesRoot();
      const info = findWorkspaceByPath(root, ws.projectDir);
      if (!info) {
        return {
          content: [
            {
              type: 'text',
              text: `No registered workspace matches CONDUCTOR_PROJECT_DIR=${ws.projectDir}.`,
            },
          ],
          structuredContent: {
            found: false,
            project_dir: ws.projectDir,
            workspaces_root: root,
          },
        };
      }
      return {
        content: [{ type: 'text', text: `Current workspace: ${info.id} at ${info.path}.` }],
        structuredContent: {
          found: true,
          id: info.id,
          path: info.path,
          name: info.name,
          created_at: info.created_at,
          parent_workspace_id: info.parent_workspace_id,
          workspaces_root: root,
        },
      };
    },
  );
}
