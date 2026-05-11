/**
 * tools/renderer.ts
 *
 * Renderer MCP surface — agents can inspect and author artifact renderers.
 *
 *   - renderer.list     — every renderer the resolver can see (workspace,
 *                         plugin, builtin) with the active winner flagged
 *   - renderer.read     — return the .mjs source code for a type
 *   - renderer.write    — write an agent-authored renderer into
 *                         `<workspace>/.conductor/renderers/<type>.mjs`
 *                         (shadows plugin / builtin of the same type)
 *   - renderer.delete   — remove a workspace-level renderer
 *
 * Plugin renderers and built-in renderers are READ-ONLY through this surface
 * (edit them via the plugin's own source / built-in repo). The agent can
 * shadow them by writing a workspace renderer of the same name.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listAllRendererSources,
  resolveRendererFile,
  workspaceRenderersDir,
} from '../renderer-registry.ts';
import { writeFileAtomic } from '../fs-util.ts';
import { structuredError } from '../scope.ts';
import type { Workspace } from '../workspace.ts';

const TYPE_REGEX = /^[a-z0-9][a-z0-9._-]*$/i;

export function registerRendererTools(server: McpServer, ws: Workspace): void {
  // -- renderer.list --------------------------------------------------------
  server.registerTool(
    'renderer.list',
    {
      description:
        "List every renderer the resolver can see, in precedence order. For each type, the entry with `active: true` is the one served by `/__renderer/<type>.mjs` and used by `artifact.add`. Shadowed entries are included with `active: false` so you can see what you'd be replacing if you wrote a workspace renderer of the same name. Sources are `workspace` | `plugin` | `builtin`.",
      inputSchema: {},
    },
    async () => {
      const rows = listAllRendererSources(ws);
      return {
        content: [
          {
            type: 'text' as const,
            text: `${rows.filter((r) => r.active).length} active renderer(s), ${rows.length} total entries.`,
          },
        ],
        structuredContent: { renderers: rows },
      };
    },
  );

  // -- renderer.read --------------------------------------------------------
  server.registerTool(
    'renderer.read',
    {
      description:
        'Return the source code of the active renderer for the given type (resolved through workspace → plugin → builtin). Use this to study a renderer before writing a shadow.',
      inputSchema: {
        type: z.string().min(1).describe('Renderer type. Same value used for artifact.add type.'),
      },
    },
    async (args) => {
      if (!TYPE_REGEX.test(args.type)) {
        return structuredError('INVALID_TYPE', `Invalid type "${args.type}". Must match ${TYPE_REGEX.source}.`);
      }
      const entry = resolveRendererFile(args.type, ws);
      if (!entry) {
        return structuredError(
          'RENDERER_NOT_FOUND',
          `No renderer found for type "${args.type}" in workspace, plugins, or built-ins.`,
          { type: args.type },
        );
      }
      let source: string;
      try {
        source = readFileSync(entry.filePath, 'utf8');
      } catch (err) {
        return structuredError(
          'RENDERER_READ_FAILED',
          err instanceof Error ? err.message : String(err),
          { type: args.type, file: entry.filePath },
        );
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Renderer "${args.type}" from ${entry.source} (${entry.sourceId})`,
          },
        ],
        structuredContent: {
          type: args.type,
          source: entry.source,
          source_id: entry.sourceId,
          file_path: entry.filePath,
          code: source,
        },
      };
    },
  );

  // -- renderer.write -------------------------------------------------------
  server.registerTool(
    'renderer.write',
    {
      description:
        "Write or overwrite a workspace-level renderer at `<workspace>/.conductor/renderers/<type>.mjs`. The file MUST be a valid ES module with `export default { render(rootElement, ctx) }`. ctx exposes: { manifest, artifactId, fetchFile(name): Promise<string>, fetchFileJson(name): Promise<any>, listFiles(): Promise<string[]> }. A workspace renderer shadows any plugin / builtin renderer of the same type.",
      inputSchema: {
        type: z.string().min(1),
        code: z.string().min(1).describe('Full .mjs source code.'),
      },
    },
    async (args) => {
      if (!TYPE_REGEX.test(args.type)) {
        return structuredError('INVALID_TYPE', `Invalid type "${args.type}". Must match ${TYPE_REGEX.source}.`);
      }
      const dir = workspaceRenderersDir(ws.projectDir);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${args.type}.mjs`);
      try {
        writeFileAtomic(filePath, args.code);
      } catch (err) {
        return structuredError(
          'RENDERER_WRITE_FAILED',
          err instanceof Error ? err.message : String(err),
          { type: args.type, file: filePath },
        );
      }
      return {
        content: [{ type: 'text' as const, text: `Wrote workspace renderer "${args.type}" → ${filePath}` }],
        structuredContent: {
          type: args.type,
          source: 'workspace' as const,
          file_path: filePath,
        },
      };
    },
  );

  // -- renderer.delete ------------------------------------------------------
  server.registerTool(
    'renderer.delete',
    {
      description:
        "Remove a workspace-level renderer. Falls back to the next source in the chain on next resolve. No-op on plugin / builtin renderers (those aren't writable through this surface).",
      inputSchema: { type: z.string().min(1) },
    },
    async (args) => {
      if (!TYPE_REGEX.test(args.type)) {
        return structuredError('INVALID_TYPE', `Invalid type "${args.type}". Must match ${TYPE_REGEX.source}.`);
      }
      const filePath = join(workspaceRenderersDir(ws.projectDir), `${args.type}.mjs`);
      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: `No workspace renderer for "${args.type}" — nothing to delete.` }],
          structuredContent: { type: args.type, deleted: false },
        };
      }
      try {
        unlinkSync(filePath);
      } catch (err) {
        return structuredError(
          'RENDERER_DELETE_FAILED',
          err instanceof Error ? err.message : String(err),
          { type: args.type, file: filePath },
        );
      }
      return {
        content: [{ type: 'text' as const, text: `Deleted workspace renderer "${args.type}".` }],
        structuredContent: { type: args.type, deleted: true, file_path: filePath },
      };
    },
  );
}
