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
 *   1. <workspace>/.clawdevbox/renderers/<type>.mjs   (agent-authored)
 *   2. <plugin_dir>/renderers/<type>.mjs             (plugin-shipped)
 *   3. <clawdevbox-mcp-server>/src/renderers/<type>.mjs (built-in)
 * First match wins. See renderer.* tools for inspecting / authoring.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
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
import {
  resolveWorkspaceContext,
  resolveRecipeInstanceId,
  type ResolveExtra,
} from '../context-resolver.ts';
import { structuredError } from '../scope.ts';
import { getTerminalServer } from '../terminal-server.ts';
import type { Workspace } from '../workspace.ts';
import {
  getWorkspace,
  listWorkspaces,
  resolveWorkspacesRoot,
} from '../workspaces-store.ts';
import { getDatabase } from '../db/index.ts';
import { emitChange } from '../event-bus.ts';
import { logger } from '../logger.ts';

// ============================================================================
// Workspace resolution
// ============================================================================

/**
 * Bridges the artifact tools to the shared context resolver. Tools accept an
 * optional `workspace_id` argument and the SDK's `extra` (request metadata),
 * and we resolve through the standard chain:
 *
 *   args.workspace_id → header X-Clawdevbox-Workspace-Id → env CLAWDEVBOX_WORKSPACE_ID → project_dir match
 *
 * The header path is the dominant case for agents connected over the long-lived
 * HTTP MCP transport (`clawdevbox start`). The env path is the dominant case
 * for stdio-mode (`clawdevbox mcp` spawned as the agent's child).
 */
function resolveTargetWorkspace(
  _ws: Workspace,
  argsWorkspaceId: string | undefined,
  extra: ResolveExtra | undefined,
):
  | { ok: true; workspaceId: string; workspacePath: string }
  | { ok: false; error: ReturnType<typeof structuredError> } {
  const r = resolveWorkspaceContext(extra, { argsWorkspaceId });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, workspaceId: r.ctx.workspaceId, workspacePath: r.ctx.workspacePath };
}

function buildViewUrl(artifactId: string): string | null {
  const handle = getTerminalServer();
  if (!handle) return null;
  const baseUrl = handle.url('x');
  if (!baseUrl) return null;
  try {
    return `${new URL(baseUrl).origin}/artifact/${encodeURIComponent(artifactId)}`;
  } catch {
    return null;
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerArtifactEntries(ws: Workspace): void {
  // -- artifact.add ---------------------------------------------------------
  defineTool({
    name: 'artifact.add',
    description:
      "Register an artifact at `<workspace>/artifacts/<id>/` by writing its manifest.json. Canonical flow: an agent skill writes content files into that folder, then calls artifact.add to make it discoverable. Optionally pass `files` to write them inline at the same time. The renderer is picked from `type` (workspace → plugin → built-in chain). Built-in types: `markdown` (content.md), `pr-review` (review.json + walkthrough.json + diffs/*.diff), `walkthrough` (walkthrough.json). Optional `recipe_instance_id` / `step_id` link the artifact to a recipe run for UI grouping. Returns a `view_url`.",
    parameters: z.object({
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
          'Target workspace id. Falls back to CLAWDEVBOX_WORKSPACE_ID env, then CLAWDEVBOX_PROJECT_DIR resolution.',
        ),
      recipe_instance_id: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Optional UI link to a recipe instance. Falls back to CLAWDEVBOX_RECIPE_INSTANCE_ID env if not provided.',
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
    }),
    handler: async (args, extra) => {
      try {
        validateArtifactId(args.id);
      } catch (err) {
        return structuredError(
          'INVALID_ARTIFACT_ID',
          err instanceof Error ? err.message : String(err),
          { id: args.id },
        );
      }

      const target = resolveTargetWorkspace(ws, args.workspace_id, extra);
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
          args.recipe_instance_id ?? resolveRecipeInstanceId(extra),
        step_id: args.step_id ?? null,
        created_at: existing?.manifest.created_at ?? Date.now(),
        meta: args.meta ?? undefined,
      };

      writeArtifact({
        workspacePath: target.workspacePath,
        manifest,
        files: inlineFiles,
      });

      // Mirror to the DB `artifacts` table so attach lookups (e.g.
      // recipe.steps.update_status with attach_artifact_ids) succeed.
      // Without this, the disk write succeeds but downstream tools that
      // look up the artifact by id in the DB fail with ARTIFACT_NOT_FOUND
      // — a long-standing bug that forced agents into retry loops.
      //
      // We do NOT pre-populate recipe_step_id even when args.step_id is
      // provided: that column is a FK to `recipe_steps.id` (the random
      // rs_xxx PK), while args.step_id is the agent-facing step name
      // (e.g. "list-files"). Trying to insert the agent-facing name into
      // a FK column violates the constraint. The wiring to a specific
      // step is established when the agent calls
      // recipe.steps.update_status with attach_artifact_ids — that path
      // looks up the rs_xxx PK and UPDATEs the artifact row.
      const onDiskDir = artifactDir(target.workspacePath, args.id);
      try {
        const db = getDatabase();
        const existsInDb = db.prepare('SELECT id FROM artifacts WHERE id = ?').get(args.id);
        if (existsInDb) {
          db.prepare(
            `UPDATE artifacts SET type = ?, title = ?, recipe_instance_id = ?, dir_path = ?, updated_at = ? WHERE id = ?`,
          ).run(
            args.type,
            args.title,
            manifest.recipe_instance_id ?? null,
            onDiskDir,
            Date.now(),
            args.id,
          );
          emitChange('artifacts');
        } else {
          const now = Date.now();
          db.prepare(
            `INSERT INTO artifacts (
               id, workspace_id, recipe_instance_id,
               type, title, dir_path, metadata_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            args.id,
            target.workspaceId,
            manifest.recipe_instance_id ?? null,
            args.type,
            args.title,
            onDiskDir,
            JSON.stringify(args.meta ?? {}),
            now,
            now,
          );
          emitChange('artifacts');
        }
      } catch (err) {
        logger.warn(
          { err: String(err), artifactId: args.id },
          'artifact.add: DB mirror failed — disk write succeeded but attach_artifact_ids lookups will miss',
        );
      }

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
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- artifact.list --------------------------------------------------------
  defineTool({
    name: 'artifact.list',
    description:
      "List artifacts. By default lists every artifact in every registered workspace; pass workspace_id to narrow, or filter by recipe_instance_id / step_id. Each entry includes the manifest and a view_url.",
    parameters: z.object({
      workspace_id: z.string().min(1).optional(),
      recipe_instance_id: z.string().min(1).optional(),
      step_id: z.string().min(1).optional(),
    }),
    handler: async (args) => {
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
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- artifact.get ---------------------------------------------------------
  defineTool({
    name: 'artifact.get',
    description:
      'Return the manifest, the list of content files in the folder, and a view_url for a single artifact by id. Searches every registered workspace.',
    parameters: z.object({
      id: z.string().min(1),
      workspace_id: z.string().min(1).optional(),
    }),
    handler: async (args) => {
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
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- artifact.delete ------------------------------------------------------
  defineTool({
    name: 'artifact.delete',
    description:
      "Remove an artifact folder entirely. Returns deleted=false if the artifact doesn't exist.",
    parameters: z.object({
      id: z.string().min(1),
      workspace_id: z.string().min(1).optional(),
    }),
    handler: async (args) => {
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
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
