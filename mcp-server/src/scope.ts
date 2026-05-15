/**
 * scope.ts
 *
 * Shared helpers for resolving the `scope` parameter on recipe/skill/trigger
 * tools. Encodes the precedence rule from spec §10.4:
 *
 *   project shadows plugin shadows global
 *
 * and the write-rejection rule: write tools accept only 'project' or 'global';
 * 'plugin:<id>' returns the structured PLUGIN_SCOPE_READONLY error.
 *
 * The actual file-IO lives in the per-family tool modules; this module
 * supplies the lookup ordering, the error shape, and the small predicates
 * everything else builds on.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve as pathResolve, sep } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type Scope,
  type WritableScope,
  type Workspace,
  isWritableScope,
  pluginIdOfScope,
} from './workspace.ts';

// ============================================================================
// Structured-error helpers
// ============================================================================

export interface ClawdevboxErrorPayload {
  code: string;
  message: string;
  [k: string]: unknown;
}

export function structuredError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { code, message, ...extra },
  };
}

export function pluginScopeReadonly(scope: string): CallToolResult {
  return structuredError(
    'PLUGIN_SCOPE_READONLY',
    "Plugin scope is read-only. Copy to 'project' scope to customize.",
    { scope },
  );
}

export function notFound(kind: string, id: string): CallToolResult {
  return structuredError(
    'NOT_FOUND',
    `${kind} not found: ${id}`,
    { kind, id },
  );
}

export function validationError(errors: Array<{ path: string; code: string; message: string }>): CallToolResult {
  const text = errors.map((e) => `${e.path}: ${e.message}`).join('\n');
  return {
    isError: true,
    content: [{ type: 'text', text: `Validation failed:\n${text}` }],
    structuredContent: { code: 'VALIDATION_FAILED', message: 'Validation failed', errors },
  };
}

// ============================================================================
// Scope guards
// ============================================================================

/** Reject `plugin:<id>` writes and return the structured error if so. */
export function ensureWritableScope(scope: string): CallToolResult | null {
  if (isWritableScope(scope)) return null;
  if (scope.startsWith('plugin:')) return pluginScopeReadonly(scope);
  return structuredError(
    'INVALID_SCOPE',
    `Unknown scope: ${scope}. Expected 'project' or 'global'.`,
    { scope },
  );
}

// ============================================================================
// Read-side helpers — return raw file contents from a scope, or null on miss.
// ============================================================================

export type ReadKind = 'recipe' | 'skill';

export interface ResolvedRead {
  scope: Scope;
  path: string;
  source: string;
}

export type ScopeLookup = (ws: Workspace, scope: WritableScope, id: string) => string;

/**
 * Try a single scope. Returns null if the file is absent.
 * For 'plugin:<id>', we resolve through the plugin manifest's `provides` list,
 * not by guessing filenames — plugins can shadow the file path.
 */
export function readFromScope(
  ws: Workspace,
  scope: Exclude<Scope, 'all'>,
  kind: ReadKind,
  id: string,
  pathForWritable: ScopeLookup,
): ResolvedRead | null {
  if (isWritableScope(scope)) {
    const primary = pathForWritable(ws, scope, id);
    const candidates = [primary, ...alternateScopePaths(primary, kind)];
    for (const p of candidates) {
      if (existsSync(p)) {
        return { scope, path: p, source: readFileSync(p, 'utf8') };
      }
    }
    return null;
  }

  const pluginId = pluginIdOfScope(scope);
  if (!pluginId) return null;
  const plugin = ws.plugins.get(pluginId);
  if (!plugin || plugin.status === 'error') return null;

  const list =
    kind === 'recipe'
      ? plugin.manifest.provides?.recipes
      : plugin.manifest.provides?.skills;
  if (!list) return null;
  const hit = list.find((e) => e.id === id);
  if (!hit) return null;
  const abs = pluginFileResolve(plugin.dir, hit.file);
  if (!abs || !existsSync(abs)) return null;
  return { scope: `plugin:${pluginId}`, path: abs, source: readFileSync(abs, 'utf8') };
}

function pluginFileResolve(dir: string, relFile: string): string | null {
  const abs = pathResolve(dir, relFile);
  if (!abs.startsWith(dir + sep) && abs !== dir) return null;
  return abs;
}

/**
 * Given a "primary" file path computed via `recipePath`/`skillPath`, return
 * the alternate extensions we tolerate on disk. Recipes accept `.yaml`,
 * `.yml`, and `.json` (spec §7.4 + Phase 7.6 upsert format arg).
 */
function alternateScopePaths(primary: string, kind: ReadKind): string[] {
  if (kind !== 'recipe') return [];
  const lower = primary.toLowerCase();
  const base = primary.slice(0, primary.lastIndexOf('.'));
  const alts: string[] = [];
  if (lower.endsWith('.yaml')) alts.push(`${base}.yml`, `${base}.json`);
  else if (lower.endsWith('.yml')) alts.push(`${base}.yaml`, `${base}.json`);
  else if (lower.endsWith('.json')) alts.push(`${base}.yaml`, `${base}.yml`);
  return alts;
}

/**
 * Walk scopes in precedence order. For 'all' (default): project → every plugin
 * (sorted by id, first match wins) → global. For an explicit scope: just that
 * one.
 */
export function resolveRead(
  ws: Workspace,
  requestedScope: Scope,
  kind: ReadKind,
  id: string,
  pathForWritable: ScopeLookup,
): ResolvedRead | null {
  if (requestedScope !== 'all') {
    return readFromScope(ws, requestedScope, kind, id, pathForWritable);
  }

  const project = readFromScope(ws, 'project', kind, id, pathForWritable);
  if (project) return project;

  const pluginIds = [...ws.plugins.keys()].sort();
  for (const pid of pluginIds) {
    const hit = readFromScope(ws, `plugin:${pid}`, kind, id, pathForWritable);
    if (hit) return hit;
  }

  const global = readFromScope(ws, 'global', kind, id, pathForWritable);
  if (global) return global;

  return null;
}

// ============================================================================
// List-side helper — enumerate every (scope, id, file) for a kind.
// ============================================================================

export interface ScopeListing {
  scope: Scope;
  id: string;
  path: string;
}

export function listAllInScope(
  ws: Workspace,
  scope: Scope,
  kind: ReadKind,
  pathForWritable: ScopeLookup,
): ScopeListing[] {
  const out: ScopeListing[] = [];
  const wantProject = scope === 'all' || scope === 'project';
  const wantGlobal = scope === 'all' || scope === 'global';
  const wantPlugin = scope === 'all' || scope.startsWith('plugin:');

  const ext = kind === 'recipe' ? '.yaml' : '.md';
  const altExts =
    kind === 'recipe' ? ['.yml', '.json'] : [];

  const scanDir = (dir: string, scopeTag: Scope) => {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const f of entries) {
      const lower = f.toLowerCase();
      const matches = lower.endsWith(ext) || altExts.some((e) => lower.endsWith(e));
      if (!matches) continue;
      const id = f.slice(0, f.lastIndexOf('.'));
      if (!/^[a-z][a-z0-9-]*$/.test(id)) continue;
      out.push({ scope: scopeTag, id, path: join(dir, f) });
    }
  };

  if (wantProject) {
    const dir =
      kind === 'recipe'
        ? join(ws.projectDir, '.clawdevbox', 'recipes')
        : join(ws.projectDir, '.clawdevbox', 'skills');
    scanDir(dir, 'project');
  }

  if (wantPlugin) {
    const pluginIds =
      scope === 'all' || scope === 'project' || scope === 'global'
        ? [...ws.plugins.keys()].sort()
        : (() => {
            const single = pluginIdOfScope(scope);
            return single ? [single] : [];
          })();
    for (const pid of pluginIds) {
      const plugin = ws.plugins.get(pid);
      if (!plugin || plugin.status === 'error') continue;
      const list =
        kind === 'recipe'
          ? plugin.manifest.provides?.recipes
          : plugin.manifest.provides?.skills;
      if (!list) continue;
      for (const entry of list) {
        const abs = pluginFileResolve(plugin.dir, entry.file);
        if (!abs || !existsSync(abs)) continue;
        out.push({ scope: `plugin:${pid}`, id: entry.id, path: abs });
      }
    }
  }

  if (wantGlobal) {
    const dir =
      kind === 'recipe'
        ? join(ws.globalDir, 'recipes')
        : join(ws.globalDir, 'skills');
    scanDir(dir, 'global');
  }

  return out;
}
