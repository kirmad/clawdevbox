/**
 * tools/artifact.ts
 *
 * Artifact MCP surface — the agent-facing tools for creating, listing,
 * inspecting, and removing renderable bundles attached to a workspace.
 *
 *   - artifact.add        — write folder + manifest + files
 *   - artifact.list       — list artifacts in a workspace, filter by recipe/step
 *   - artifact.get        — return manifest + file names + view_url
 *   - artifact.delete     — remove the folder
 *
 * Artifacts are workspace-scoped on disk. Manifests can OPTIONALLY carry
 * `recipe_instance_id` / `step_id` references so the UI can group "what
 * this recipe run produced" without making the artifact's lifetime depend
 * on recipe state.
 *
 * Renderer dispatch (extensible plugin model):
 *   1. <workspace>/.conductor/renderers/<type>.mjs   (agent-authored)
 *   2. <plugin_dir>/renderers/<type>.mjs             (plugin-shipped)
 *   3. <conductor-mcp-server>/src/renderers/<type>.mjs (built-in)
 * First match wins. See renderer.* tools for inspecting / authoring.
 */

import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type ArtifactManifest,
  artifactDir,
  deleteArtifact,
  listArtifactFiles,
  listArtifacts,
  readArtifact,
  validateArtifactFilename,
  validateArtifactId,
  writeArtifact,
} from '../artifact-store.ts';
import { structuredError } from '../scope.ts';
import { getTerminalServer } from '../terminal-server.ts';
import type { Workspace } from '../workspace.ts';
import {
  findWorkspaceByPath,
  getWorkspace,
  listWorkspaces,
  resolveWorkspacesRoot,
} from '../workspaces-store.ts';

// ============================================================================
// Workspace resolution
// ============================================================================

function resolveTargetWorkspace(
  ws: Workspace,
  argsWorkspaceId: string | undefined,
):
  | { ok: true; workspaceId: string; workspacePath: string }
  | { ok: false; error: ReturnType<typeof structuredError> } {
  const root = resolveWorkspacesRoot();
  const explicitId = argsWorkspaceId ?? process.env.CONDUCTOR_WORKSPACE_ID;
  if (explicitId) {
    const info = getWorkspace(root, explicitId);
    if (!info) {
      return {
        ok: false,
        error: structuredError(
          'WORKSPACE_NOT_FOUND',
          `Workspace ${explicitId} not found in registry.`,
          { workspace_id: explicitId },
        ),
      };
    }
    return { ok: true, workspaceId: info.id, workspacePath: info.path };
  }
  const matched = findWorkspaceByPath(root, ws.projectDir);
  if (matched) {
    return { ok: true, workspaceId: matched.id, workspacePath: matched.path };
  }
  return {
    ok: false,
    error: structuredError(
      'NO_TARGET_WORKSPACE',
      'No workspace_id provided, CONDUCTOR_WORKSPACE_ID env not set, and CONDUCTOR_PROJECT_DIR is not a registered workspace.',
    ),
  };
}

function buildViewUrl(artifactId: string): string | null {
  const handle = getTerminalServer();
  if (!handle) return null;
  return `${new URL(handle.url('x')).origin}/artifact/${encodeURIComponent(artifactId)}`;
}

// ============================================================================
// Registration
// ============================================================================

export function registerArtifactTools(server: McpServer, ws: Workspace): void {
  // -- artifact.add ---------------------------------------------------------
  server.registerTool(
    'artifact.add',
    {
      description:
        "Register an artifact at `<workspace>/artifacts/<id>/` by writing its manifest.json. Canonical flow: an agent skill writes content files into that folder, then calls artifact.add to make it discoverable. Optionally pass `files` to write them inline at the same time. The renderer is picked from `type` (workspace → plugin → built-in chain). Built-in types: `markdown` (content.md), `pr-review` (review.json + walkthrough.json + diffs/*.diff), `walkthrough` (walkthrough.json). Optional `recipe_instance_id` / `step_id` link the artifact to a recipe run for UI grouping. Returns a `view_url`.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe('Folder name == artifact id. /^[a-z0-9][a-z0-9._-]*$/i.'),
        type: z
          .string()
          .min(1)
          .describe('Renderer discriminator. e.g. "markdown" | "pr-review" | "walkthrough".'),
        title: z.string().min(1).describe('Human-readable title.'),
        files: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Optional inline filename → content map. Strings written as utf-8; objects JSON.stringify(2)d. If your skill already wrote files to the folder, omit this. "manifest.json" is reserved.',
          ),
        workspace_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Target workspace id. Falls back to CONDUCTOR_WORKSPACE_ID env, then CONDUCTOR_PROJECT_DIR resolution.',
          ),
        recipe_instance_id: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Optional UI link to a recipe instance. Falls back to CONDUCTOR_RECIPE_INSTANCE_ID env if not provided.',
          ),
        step_id: z
          .string()
          .min(1)
          .optional()
          .describe('Optional UI link to a step inside the recipe instance.'),
        meta: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Free-form metadata for the renderer.'),
      },
    },
    async (args) => {
      try {
        validateArtifactId(args.id);
      } catch (err) {
        return structuredError(
          'INVALID_ARTIFACT_ID',
          err instanceof Error ? err.message : String(err),
          { id: args.id },
        );
      }

      const target = resolveTargetWorkspace(ws, args.workspace_id);
      if (!target.ok) return target.error;

      const inlineFiles = args.files ?? {};
      for (const name of Object.keys(inlineFiles)) {
        try {
          validateArtifactFilename(name);
        } catch (err) {
          return structuredError(
            'INVALID_ARTIFACT_FILENAME',
            err instanceof Error ? err.message : String(err),
            { filename: name },
          );
        }
      }

      const existing = readArtifact(target.workspacePath, args.id);
      if (existing && existing.manifest.type !== args.type) {
        return structuredError(
          'ARTIFACT_TYPE_CONFLICT',
          `Artifact ${args.id} already exists with type ${existing.manifest.type}; cannot replace with type ${args.type}. Delete first or use a different id.`,
          { id: args.id, existing_type: existing.manifest.type, new_type: args.type },
        );
      }

      const manifest: ArtifactManifest = {
        id: args.id,
        type: args.type,
        title: args.title,
        workspace_id: target.workspaceId,
        recipe_instance_id:
          args.recipe_instance_id ?? process.env.CONDUCTOR_RECIPE_INSTANCE_ID ?? null,
        step_id: args.step_id ?? null,
        created_at: existing?.manifest.created_at ?? Date.now(),
        meta: args.meta ?? undefined,
      };

      writeArtifact({
        workspacePath: target.workspacePath,
        manifest,
        files: inlineFiles,
      });

      const viewUrl = buildViewUrl(args.id);
      const onDiskFiles = listArtifactFiles(target.workspacePath, args.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Registered artifact ${args.id} (type=${args.type}, ${onDiskFiles.length} content file(s)). ${
              viewUrl ? `Open: ${viewUrl}` : '(terminal server not running — no view_url)'
            }`,
          },
        ],
        structuredContent: {
          id: args.id,
          type: args.type,
          title: args.title,
          workspace_id: target.workspaceId,
          recipe_instance_id: manifest.recipe_instance_id,
          step_id: manifest.step_id,
          dir: artifactDir(target.workspacePath, args.id),
          files: onDiskFiles,
          view_url: viewUrl,
        },
      };
    },
  );

  // -- artifact.list --------------------------------------------------------
  server.registerTool(
    'artifact.list',
    {
      description:
        "List artifacts. By default lists every artifact in every registered workspace; pass workspace_id to narrow, or filter by recipe_instance_id / step_id. Each entry includes the manifest and a view_url.",
      inputSchema: {
        workspace_id: z.string().min(1).optional(),
        recipe_instance_id: z.string().min(1).optional(),
        step_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const root = resolveWorkspacesRoot();
      const workspaces = args.workspace_id
        ? (() => {
            const w = getWorkspace(root, args.workspace_id);
            return w ? [w] : [];
          })()
        : listWorkspaces(root);

      const items: Array<ArtifactManifest & { dir: string; view_url: string | null }> = [];
      for (const w of workspaces) {
        for (const rec of listArtifacts(w.path)) {
          if (
            args.recipe_instance_id &&
            rec.manifest.recipe_instance_id !== args.recipe_instance_id
          ) {
            continue;
          }
          if (args.step_id && rec.manifest.step_id !== args.step_id) continue;
          items.push({
            ...rec.manifest,
            dir: rec.dir,
            view_url: buildViewUrl(rec.manifest.id),
          });
        }
      }
      return {
        content: [{ type: 'text' as const, text: `${items.length} artifact(s).` }],
        structuredContent: { artifacts: items },
      };
    },
  );

  // -- artifact.get ---------------------------------------------------------
  server.registerTool(
    'artifact.get',
    {
      description:
        'Return the manifest, the list of content files in the folder, and a view_url for a single artifact by id. Searches every registered workspace.',
      inputSchema: {
        id: z.string().min(1),
        workspace_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const root = resolveWorkspacesRoot();
      const workspaces = args.workspace_id
        ? (() => {
            const w = getWorkspace(root, args.workspace_id);
            return w ? [w] : [];
          })()
        : listWorkspaces(root);

      for (const w of workspaces) {
        const rec = readArtifact(w.path, args.id);
        if (!rec) continue;
        return {
          content: [
            {
              type: 'text' as const,
              text: `${args.id} (type=${rec.manifest.type})`,
            },
          ],
          structuredContent: {
            ...rec.manifest,
            dir: rec.dir,
            files: listArtifactFiles(w.path, args.id),
            view_url: buildViewUrl(args.id),
          },
        };
      }
      return structuredError(
        'ARTIFACT_NOT_FOUND',
        `Artifact ${args.id} not found in any registered workspace.`,
        { id: args.id },
      );
    },
  );

  // -- artifact.delete ------------------------------------------------------
  server.registerTool(
    'artifact.delete',
    {
      description:
        "Remove an artifact folder entirely. Returns deleted=false if the artifact doesn't exist.",
      inputSchema: {
        id: z.string().min(1),
        workspace_id: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const root = resolveWorkspacesRoot();
      const workspaces = args.workspace_id
        ? (() => {
            const w = getWorkspace(root, args.workspace_id);
            return w ? [w] : [];
          })()
        : listWorkspaces(root);

      for (const w of workspaces) {
        if (existsSync(artifactDir(w.path, args.id))) {
          const ok = deleteArtifact(w.path, args.id);
          return {
            content: [
              { type: 'text' as const, text: ok ? `Deleted ${args.id}.` : `Failed to delete ${args.id}.` },
            ],
            structuredContent: { id: args.id, deleted: ok, workspace_id: w.id },
          };
        }
      }
      return {
        content: [{ type: 'text' as const, text: `${args.id} not found.` }],
        structuredContent: { id: args.id, deleted: false },
      };
    },
  );
}
