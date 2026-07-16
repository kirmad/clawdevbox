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
  findArtifact,
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
import { getShareServer } from '../share-server.ts';
import { getShareTunnelStatus } from '../share-tunnel.ts';
import { getTunnelStatus } from '../tunnel.ts';
import type { Workspace } from '../workspace.ts';
import {
  getWorkspace,
  listWorkspaces,
  resolveWorkspacesRoot,
} from '../workspaces-store.ts';
import { getDatabase } from '../db/index.ts';
import {
  getDoc as storeGetDoc,
  putDoc as storePutDoc,
} from '../json-doc-store.ts';
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

/**
 * Build a tunneled view URL for the artifact using the MAIN devtunnel (the
 * one fronting cfg.http.port). Distinct from `buildShareUrl`, which uses the
 * separate share tunnel:
 *
 *   - `view_url`        — http://localhost:<port>/artifact/<id>  (loopback)
 *   - `tunnel_view_url` — https://<main-tunnel>/artifact/<id>    (devtunnel)
 *   - `share_url`       — https://<share-tunnel>/artifact/<id>   (tenant-scoped)
 *
 * `tunnel_view_url` is useful when the user wants to open the artifact from
 * another device they own (phone, tablet) where they're already signed in
 * to the same devtunnel. For sharing with colleagues, use `share_url` —
 * the main tunnel typically requires the user's own devtunnel access token
 * plus the /mcp bearer.
 *
 * Returns null when the main devtunnel isn't configured / running / bound.
 */
function buildTunnelViewUrl(artifactId: string): string | null {
  const tunnel = getTunnelStatus();
  if (tunnel.kind !== 'devtunnel' || !tunnel.running || !tunnel.url) return null;
  try {
    return `${new URL(tunnel.url).origin}/artifact/${encodeURIComponent(artifactId)}`;
  } catch {
    return null;
  }
}

/**
 * Build a `share_url` for the given artifact.
 *
 * Returns the PUBLIC URL when the share tunnel is up (so the agent can paste
 * a link colleagues outside the loopback can hit), falling back to the LOCAL
 * share-port URL when the tunnel hasn't bound yet but the share server is
 * running, falling back to `null` when share is disabled entirely.
 *
 * Tunnel URL > local share URL > null is the right preference order because:
 *   - tunnel URL is the only one a colleague on a different machine can use
 *   - local share URL is at least different from view_url, so callers can
 *     tell the share server is alive even before the tunnel publishes
 *   - null is honest about the share endpoint being disabled
 */
function buildShareUrl(artifactId: string): string | null {
  const shareHandle = getShareServer();
  if (!shareHandle) return null;
  const tunnel = getShareTunnelStatus();
  if (tunnel.kind === 'devtunnel' && tunnel.running && tunnel.url) {
    try {
      return `${new URL(tunnel.url).origin}/artifact/${encodeURIComponent(artifactId)}`;
    } catch {
      /* fall through to local */
    }
  }
  return shareHandle.url(artifactId);
}

// ============================================================================
// Registration
// ============================================================================

export function registerArtifactEntries(ws: Workspace): void {
  // -- artifact.add ---------------------------------------------------------
  defineTool({
    name: 'artifact.add',
    description:
      "Register an artifact at `<workspace>/artifacts/<id>/` by writing its manifest.json. Canonical flow: an agent skill writes content files into that folder, then calls artifact.add to make it discoverable. Optionally pass `files` to write them inline at the same time. The renderer is picked from `type` (workspace → plugin → built-in chain). Built-in types: `markdown` (content.md), `pr-review` (review.json + walkthrough.json + diffs/*.diff), `walkthrough` (walkthrough.json). Optional `recipe_instance_id` / `step_id` link the artifact to a recipe run for UI grouping. Returns three URLs (any may be null): `view_url` (loopback) is always present when the server is up; `tunnel_view_url` is the main devtunnel URL when configured + running (useful for opening from your other devices that share your devtunnel account); `share_url` is the separate tenant-scoped share-tunnel URL (safe to give to colleagues — no /mcp bearer needed).",
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
      const tunnelViewUrl = buildTunnelViewUrl(args.id);
      const shareUrl = buildShareUrl(args.id);
      const onDiskFiles = listArtifactFiles(target.workspacePath, args.id);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Registered artifact ${args.id} (type=${args.type}, ${onDiskFiles.length} content file(s)). ${
              viewUrl ? `Open: ${viewUrl}` : '(terminal server not running — no view_url)'
            }${tunnelViewUrl ? `  Tunnel: ${tunnelViewUrl}` : ''}${shareUrl ? `  Share: ${shareUrl}` : ''}`,
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
          tunnel_view_url: tunnelViewUrl,
          share_url: shareUrl,
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

      const items: Array<ArtifactManifest & { dir: string; view_url: string | null; tunnel_view_url: string | null; share_url: string | null }> = [];
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
            tunnel_view_url: buildTunnelViewUrl(rec.manifest.id),
            share_url: buildShareUrl(rec.manifest.id),
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
            tunnel_view_url: buildTunnelViewUrl(args.id),
            share_url: buildShareUrl(args.id),
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

  // -- artifact.types -------------------------------------------------------
  defineTool({
    name: 'artifact.types',
    description:
      'List all supported artifact types with their required files, schemas, and recommended skills/recipes for producing them. Call this before creating an artifact to understand what to build.',
    parameters: z.object({}),
    handler: async () => {
      const types = [
        {
          type: 'markdown',
          description: 'Rich markdown document rendered with syntax highlighting and mermaid diagram support.',
          requiredFiles: ['content.md'],
          skill: null,
          recipe: null,
          example: {
            'artifact.add': {
              type: 'markdown',
              title: 'Design Document',
              files: { 'content.md': '# Title\n\nMarkdown content here...' },
            },
          },
        },
        {
          type: 'html',
          description: 'Custom HTML artifact. The entrypoint MUST be named index.html.',
          requiredFiles: ['index.html'],
          skill: null,
          recipe: null,
          example: {
            'artifact.add': {
              type: 'html',
              title: 'Visual Report',
              files: { 'index.html': '<!doctype html><html>...</html>' },
            },
          },
        },
        {
          type: 'walkthrough',
          description: 'Interactive code walkthrough with step-by-step navigation, syntax-highlighted source, and optional mermaid diagrams per step.',
          requiredFiles: ['walkthrough.json', 'files__<safe_path>.txt (one per step file)'],
          skill: null,
          recipe: null,
          schema: {
            'walkthrough.json': {
              id: 'string',
              prId: 'number (optional)',
              summary: 'markdown string',
              architectureDiagram: 'mermaid string (optional)',
              totalSteps: 'number',
              estimatedReadTime: 'number (minutes)',
              steps: [
                {
                  stepNumber: 'number (1-indexed)',
                  title: 'string',
                  description: 'markdown string',
                  filePath: 'string (original path)',
                  startLine: 'number',
                  endLine: 'number',
                  relatedFiles: ['string[]'],
                  diagram: 'mermaid string (optional)',
                },
              ],
            },
            'file naming': 'files__<path with / and \\ replaced by __>.txt',
          },
        },
        {
          type: 'pr-walkthrough',
          description: 'Interactive PR review surface with verdict, confidence dashboard, attention plan, disqualifiers, FAQ, and per-step diffs with Q&A. The 5-minute final-judge review experience.',
          requiredFiles: [
            'walkthrough.json',
            'original__<safe_path>.txt (pre-change source per step)',
            'modified__<safe_path>.txt (post-change source per step)',
            'diff__<safe_path>.patch (unified diff per step)',
          ],
          skill: 'build-pr-walkthrough',
          recipe: 'pr-walkthrough',
          notes: 'Read the build-pr-walkthrough skill for the full walkthrough.json schema including verdict, confidence gauges, whatToLookAt, disqualifiers, and FAQ. The recipe orchestrates the full pipeline including Q&A listener.',
          schema: {
            'walkthrough.json (top-level keys)': {
              id: 'string',
              prId: 'number',
              summary: 'markdown (6 bullets via summarize-pr-changes skill)',
              architectureDiagram: 'mermaid string',
              verdict: '{ recommendation, oneLiner, confidence, reviewedBy, agentNotes }',
              confidence: '{ risk, tests, rollback, publicApi, perf, deploy } — each { grade, headline, claim, anchorStep }',
              whatToLookAt: '[{ stepN, priority, timeBudget, claim }]',
              disqualifiers: '[{ id, severity, text, howToCheck, agentVerified }]',
              faq: '[{ q, a, anchorStep? }]',
              steps: '[{ stepNumber, title, why, focusNewLine, badges, timeBudget, diagram?, kind? }]',
              totalSteps: 'number',
              estimatedReadTime: 'number (minutes)',
            },
            'file naming': '<prefix>__<path with / and \\ replaced by __>.<ext>',
          },
        },
      ];

      const summary = types.map((t) => {
        let line = `• ${t.type} — ${t.description}`;
        if (t.skill) line += ` [skill: ${t.skill}]`;
        if (t.recipe) line += ` [recipe: ${t.recipe}]`;
        return line;
      }).join('\n');

      return {
        content: [{ type: 'text' as const, text: `${types.length} artifact types:\n\n${summary}` }],
        structuredContent: { types },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // ==========================================================================
  // artifact.comment_reply — agent replies to an individual artifact comment
  // ==========================================================================

  const COMMENT_STATE = ['in_progress', 'resolved'] as const;
  const DRAFTS_COLLECTION = 'artifact-comments';

  defineTool({
    name: 'artifact.comment_reply',
    description:
      'Reply to an individual artifact comment by its id (the `[id: c_xxxx]` token in the ' +
      'dispatched markdown bundle). Appends an agent reply to the comment thread and optionally ' +
      'transitions its state. The overlay sidebar updates in real time. Call once per comment ' +
      'you want to address — batch multiple calls for multiple comments.',
    parameters: z.object({
      artifact_id: z
        .string()
        .min(1)
        .describe('The artifact id (same as in the dispatched markdown header).'),
      comment_id: z
        .string()
        .min(1)
        .describe('The comment id from the bundle (e.g. "c_abc12345").'),
      reply: z
        .string()
        .min(1)
        .max(4_000)
        .describe('Your reply text — explain what you did, ask a clarifying question, or acknowledge.'),
      state: z
        .enum(COMMENT_STATE)
        .optional()
        .describe(
          'Optionally update the comment state. "in_progress" = you\'re working on it; ' +
          '"resolved" = addressed. Omit to leave state unchanged.',
        ),
    }),
    handler: async (args) => {
      // 1. Find the artifact to get its workspace path
      const found = findArtifact(args.artifact_id);
      if (!found) {
        return structuredError('ARTIFACT_NOT_FOUND', `No artifact "${args.artifact_id}" found.`, {
          artifact_id: args.artifact_id,
        });
      }

      // 2. Read current comments from the store
      const doc = await storeGetDoc(found.workspacePath, DRAFTS_COLLECTION, args.artifact_id);
      if (!doc) {
        return structuredError(
          'NO_COMMENTS',
          `No comments found for artifact "${args.artifact_id}".`,
          { artifact_id: args.artifact_id },
        );
      }

      let storeDoc: any;
      let drafts: unknown[];
      try {
        storeDoc = JSON.parse(doc.body.toString('utf8'));
        // The overlay persists as { schema_version, artifact_id, updated_at, drafts: [...] }
        drafts = Array.isArray(storeDoc.drafts) ? storeDoc.drafts
               : Array.isArray(storeDoc) ? storeDoc
               : null;
        if (!drafts) throw new Error('no drafts array found');
      } catch {
        return structuredError('INVALID_STORE', 'Comment store is corrupt (expected JSON with drafts array).', {
          artifact_id: args.artifact_id,
        });
      }

      // 3. Find the comment by id
      const comment = drafts.find((d: any) => d?.id === args.comment_id) as any;
      if (!comment) {
        return structuredError('COMMENT_NOT_FOUND', `Comment "${args.comment_id}" not found.`, {
          artifact_id: args.artifact_id,
          comment_id: args.comment_id,
          available_ids: drafts.map((d: any) => d?.id).filter(Boolean),
        });
      }

      // 4. Append reply
      if (!Array.isArray(comment.replies)) comment.replies = [];
      const replyId = `r_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
      comment.replies.push({
        id: replyId,
        author: 'agent',
        text: args.reply,
        created_at: new Date().toISOString(),
      });

      // 5. Update state if requested
      if (args.state) {
        comment.state = args.state;
      }
      comment.updated_at = new Date().toISOString();

      // 6. Persist (maintain the wrapper format if it was used)
      const outputDoc = Array.isArray(storeDoc)
        ? drafts
        : { ...storeDoc, updated_at: new Date().toISOString(), drafts };
      const body = Buffer.from(JSON.stringify(outputDoc, null, 2), 'utf8');
      const result = await storePutDoc(
        found.workspacePath,
        DRAFTS_COLLECTION,
        args.artifact_id,
        body,
        'application/json',
        undefined,
      );
      if ('kind' in result) {
        return structuredError('STORE_WRITE_FAILED', `Failed to persist: ${result.kind}`, {
          artifact_id: args.artifact_id,
        });
      }

      // 7. Emit change so the overlay refreshes
      emitChange('artifacts');

      logger.info(
        `[artifact.comment_reply] replied to ${args.comment_id} on ${args.artifact_id}` +
          (args.state ? ` (state → ${args.state})` : ''),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Reply added to comment ${args.comment_id}${args.state ? ` (state → ${args.state})` : ''}.`,
          },
        ],
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
