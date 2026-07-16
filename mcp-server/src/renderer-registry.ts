/**
 * renderer-registry.ts
 *
 * Discovers `.mjs` artifact renderer modules and resolves a `type` to its
 * source file. Extensibility chain (first match wins):
 *
 *   1. <workspace>/.clawdevbox/renderers/<type>.mjs   — agent-authored
 *   2. ws.pluginRenderers (built from each plugin's resolved capabilities)
 *      → <plugin_dir>/renderers/<type>.mjs            — plugin-shipped
 *   3. <clawdevbox-mcp-server>/src/renderers/<type>.mjs — built-in
 *
 * Plugin renderers are resolved at workspace boot (see `workspace.ts`).
 * Collisions with built-in types and cross-plugin collisions are recorded
 * on `ws.rendererErrors` and the offending entry is dropped.
 *
 * Used by:
 *   - terminal-server.ts  → serves `/__renderer/<type>.mjs` to the browser
 *   - tools/renderer.ts   → renderer.list / read / write MCP surface
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workspace } from './workspace.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = resolvePath(HERE, 'renderers');

export type RendererSource = 'workspace' | 'plugin' | 'builtin';

export interface RendererEntry {
  /** Renderer type (filename without `.mjs`). */
  type: string;
  /** Where this renderer was discovered. */
  source: RendererSource;
  /** Source-specific id: workspace_id, plugin id, or 'builtin'. */
  sourceId: string;
  /** Absolute path to the `.mjs` file on disk. */
  filePath: string;
}

// ============================================================================
// Path helpers
// ============================================================================

export function workspaceRenderersDir(workspacePath: string): string {
  return join(workspacePath, '.clawdevbox', 'renderers');
}

export function builtinRenderersDir(): string {
  return BUILTIN_DIR;
}

// ============================================================================
// Built-in type discovery (one-shot at module load)
// ============================================================================

/** Frozen set of renderer types shipped with this server build. */
export const BUILTIN_RENDERER_TYPES: ReadonlySet<string> = new Set(listMjsTypesIn(BUILTIN_DIR));

// ============================================================================
// Resolution (single type → file path)
// ============================================================================

/**
 * Walk the precedence chain and return the first file that exists. Returns
 * null if no source has this renderer.
 */
export function resolveRendererFile(type: string, ws: Workspace): RendererEntry | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(type)) return null;

  const wsCandidate = join(workspaceRenderersDir(ws.projectDir), `${type}.mjs`);
  if (existsSync(wsCandidate)) {
    return { type, source: 'workspace', sourceId: ws.projectDir, filePath: wsCandidate };
  }

  const pluginEntry = ws.pluginRenderers.get(type);
  if (pluginEntry && existsSync(pluginEntry.absoluteFile)) {
    return {
      type,
      source: 'plugin',
      sourceId: pluginEntry.pluginId,
      filePath: pluginEntry.absoluteFile,
    };
  }

  const builtinCandidate = join(BUILTIN_DIR, `${type}.mjs`);
  if (existsSync(builtinCandidate)) {
    return { type, source: 'builtin', sourceId: 'builtin', filePath: builtinCandidate };
  }

  return null;
}

// ============================================================================
// Discovery (list everything)
// ============================================================================

export function listMjsTypesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    if (name.startsWith('_')) continue;  // shared libraries, not renderer types
    out.push(name.slice(0, -4));
  }
  return out.sort();
}

/**
 * Enumerate every renderer the resolver can see, in precedence order.
 * Each type appears at most once — the first source in the chain wins.
 */
export function listAvailableRenderers(ws: Workspace): RendererEntry[] {
  const seen = new Set<string>();
  const out: RendererEntry[] = [];

  for (const type of listMjsTypesIn(workspaceRenderersDir(ws.projectDir))) {
    if (seen.has(type)) continue;
    seen.add(type);
    out.push({
      type,
      source: 'workspace',
      sourceId: ws.projectDir,
      filePath: join(workspaceRenderersDir(ws.projectDir), `${type}.mjs`),
    });
  }

  for (const entry of ws.pluginRenderers.values()) {
    if (seen.has(entry.type)) continue;
    seen.add(entry.type);
    out.push({
      type: entry.type,
      source: 'plugin',
      sourceId: entry.pluginId,
      filePath: entry.absoluteFile,
    });
  }

  for (const type of listMjsTypesIn(BUILTIN_DIR)) {
    if (seen.has(type)) continue;
    seen.add(type);
    out.push({
      type,
      source: 'builtin',
      sourceId: 'builtin',
      filePath: join(BUILTIN_DIR, `${type}.mjs`),
    });
  }

  return out;
}

/**
 * Like listAvailableRenderers but also surfaces SHADOWED entries — i.e.
 * a workspace renderer that overrides a built-in is reported, AND the
 * built-in is reported with a `shadowed_by` annotation. Useful for the
 * renderer.list MCP tool when the agent wants to know "what would I be
 * replacing if I wrote my own".
 */
export function listAllRendererSources(ws: Workspace): Array<RendererEntry & { active: boolean }> {
  const workspaceFiles = listMjsTypesIn(workspaceRenderersDir(ws.projectDir));
  const pluginByType = new Map<string, RendererEntry[]>();
  for (const entry of ws.pluginRenderers.values()) {
    const list = pluginByType.get(entry.type) ?? [];
    list.push({
      type: entry.type,
      source: 'plugin',
      sourceId: entry.pluginId,
      filePath: entry.absoluteFile,
    });
    pluginByType.set(entry.type, list);
  }
  const builtins = listMjsTypesIn(BUILTIN_DIR);

  const out: Array<RendererEntry & { active: boolean }> = [];
  const allTypes = new Set<string>([
    ...workspaceFiles,
    ...pluginByType.keys(),
    ...builtins,
  ]);

  for (const type of [...allTypes].sort()) {
    let active = true;
    if (workspaceFiles.includes(type)) {
      out.push({
        type,
        source: 'workspace',
        sourceId: ws.projectDir,
        filePath: join(workspaceRenderersDir(ws.projectDir), `${type}.mjs`),
        active,
      });
      active = false;
    }
    for (const e of pluginByType.get(type) ?? []) {
      out.push({ ...e, active });
      active = false;
    }
    if (builtins.includes(type)) {
      out.push({
        type,
        source: 'builtin',
        sourceId: 'builtin',
        filePath: join(BUILTIN_DIR, `${type}.mjs`),
        active,
      });
      active = false;
    }
  }

  return out;
}
