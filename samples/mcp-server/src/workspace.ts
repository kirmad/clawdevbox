/**
 * workspace.ts
 *
 * Resolves filesystem paths for the three scopes Conductor recognizes
 * (project / plugin:<id> / global, spec §10.4) and maintains an in-memory
 * registry of installed plugins discovered under
 * `<project_dir>/.conductor/plugins/*\/plugin.yaml`.
 *
 * No process state, no caches beyond the plugin registry — every file read
 * goes straight to disk. The registry is rebuilt on demand
 * (`reloadPluginRegistry()`) by the plugin.* tools after install/uninstall.
 *
 * CONDUCTOR_PROJECT_DIR is mandatory; the server refuses to start without it.
 * CONDUCTOR_GLOBAL_DIR is optional (defaults to `~/.conductor`) — useful when
 * tests want to redirect "global" away from the real user home.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { validatePluginManifest } from './validators.ts';

// ============================================================================
// Types
// ============================================================================

export type Scope = 'project' | 'global' | `plugin:${string}` | 'all';
export type WritableScope = 'project' | 'global';

export interface PluginProvideEntry {
  id: string;
  file: string;
  cron?: string;
}

/**
 * Trigger type parameter declaration (spec §10.2). Defines one input the
 * `trigger.register` MCP tool will accept when registering an instance of
 * this trigger type.
 */
export interface TriggerTypeParameter {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
  default?: unknown;
}

/**
 * A trigger TYPE declared by a plugin (spec §8.2). The capability — script
 * file, parameter schema, default cron, callback binding. Distinct from a
 * REGISTERED trigger (a concrete instance bound to specific param values),
 * which is held by the conductor sidecar in `.conductor/triggers.json`.
 */
export interface PluginTriggerType {
  /** Globally-unique type id, e.g. `ado.new-pr-watcher`. */
  id: string;
  /** Path to the trigger script, relative to the plugin root. */
  file: string;
  /** One-line human description shown in `trigger.list_types`. */
  description?: string;
  /**
   * Recipe id the callback should run (mutually exclusive with `binds_callback_to`).
   * Conductor mints `/callback/recipes/<recipe_id>/run` (or `.../run/<inbox_item_id>`)
   * when an instance of this type is registered.
   */
  binds_callback_to_recipe?: string;
  /**
   * Callback action name when not binding to a recipe. The only MVP value is
   * `thread_resume` (for hot triggers whose registration carries a
   * `subscriber_thread_id`). Mutually exclusive with `binds_callback_to_recipe`.
   */
  binds_callback_to?: 'thread_resume';
  /** Default cron expression. Registrations inherit this when their `cron` is null/absent. */
  default_cron?: string;
  /** Whether the trigger accepts webhook fires (default true). */
  accepts_webhook?: boolean;
  /**
   * Optional parameter name that uniquely identifies a registered instance.
   * Registered-trigger id becomes `<type_id>#<param[identity_param]>`. When
   * absent, all params are hashed to mint the id.
   */
  identity_param?: string;
  /** Parameter schema — these become the initial `state` on first fire. */
  parameters?: TriggerTypeParameter[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  homepage?: string;
  provides?: {
    skills?: PluginProvideEntry[];
    recipes?: PluginProvideEntry[];
    /**
     * Trigger TYPES — capabilities, not instances (spec §8.1 / §10.2). To
     * activate a type, the agent calls `trigger.register({ type_id, params })`
     * which appends a row to `.conductor/triggers.json` `registered[]`.
     */
    trigger_types?: PluginTriggerType[];
    /** Hostable tools (spec §10.3) — single-file scripts hosted in-process. */
    tools?: PluginProvideEntry[];
    mcp_servers?: PluginProvideEntry[];
  };
  requires?: {
    conductor_version?: string;
    env?: string[];
  };
}

export interface PluginEntry {
  id: string;
  dir: string;
  manifest: PluginManifest;
  status: 'enabled' | 'disabled' | 'error';
  error?: string;
}

/**
 * A trigger type as seen by the global registry (spec §10.4). Carries the
 * plugin's PluginTriggerType plus the plugin scope it came from — enough for
 * `trigger.list_types` and `trigger.register` to operate without re-walking
 * the plugin map.
 */
export interface RegisteredTriggerType extends PluginTriggerType {
  source_plugin_id: string;
  scope: `plugin:${string}`;
  /** Absolute path to the script file under the plugin directory. */
  file_abs: string;
}

// ============================================================================
// Errors
// ============================================================================

export class WorkspaceConfigError extends Error {
  readonly code = 'WORKSPACE_CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceConfigError';
  }
}

// ============================================================================
// Workspace
// ============================================================================

export interface Workspace {
  projectDir: string;
  globalDir: string;
  /** Resolved plugin registry. Re-populated by reloadPluginRegistry(). */
  plugins: Map<string, PluginEntry>;
  /**
   * Trigger TYPE registry built from every enabled plugin's
   * `provides.trigger_types[]`. Keyed by `<type_id>` (e.g. `ado.new-pr-watcher`).
   * Type-id collisions across plugins are recorded as load-time errors —
   * the first plugin (sorted by id) wins, and subsequent collisions surface
   * via `triggerTypeErrors`.
   */
  triggerTypes: Map<string, RegisteredTriggerType>;
  /** Type-registry load errors (collisions, missing files). */
  triggerTypeErrors: Array<{ plugin_id: string; type_id: string; error: string }>;
}

/** Read CONDUCTOR_PROJECT_DIR (required) + CONDUCTOR_GLOBAL_DIR (optional). */
export function loadWorkspaceFromEnv(env: NodeJS.ProcessEnv = process.env): Workspace {
  const projectDir = env.CONDUCTOR_PROJECT_DIR;
  if (!projectDir || projectDir.trim() === '') {
    throw new WorkspaceConfigError(
      'CONDUCTOR_PROJECT_DIR env var is required (path to the workspace root).',
    );
  }
  if (!existsSync(projectDir)) {
    throw new WorkspaceConfigError(
      `CONDUCTOR_PROJECT_DIR does not exist: ${projectDir}`,
    );
  }
  const globalDir = env.CONDUCTOR_GLOBAL_DIR ?? join(homedir(), '.conductor');
  const ws: Workspace = {
    projectDir: resolve(projectDir),
    globalDir: resolve(globalDir),
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
  };
  reloadPluginRegistry(ws);
  return ws;
}

// ============================================================================
// Path helpers
// ============================================================================

const RECIPE_EXT = '.yaml';
const SKILL_EXT = '.md';

/** Validate that the file id matches the loader rule `[a-z][a-z0-9-]*`. */
export function validateId(id: string): { ok: boolean; message?: string } {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, message: 'id is required' };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return { ok: false, message: `id ${JSON.stringify(id)} must match [a-z][a-z0-9-]*` };
  }
  return { ok: true };
}

/** Where a recipe lives for a given (writable) scope. */
export function recipePath(ws: Workspace, scope: WritableScope, id: string): string {
  if (scope === 'project') return join(ws.projectDir, '.conductor', 'recipes', `${id}${RECIPE_EXT}`);
  return join(ws.globalDir, 'recipes', `${id}${RECIPE_EXT}`);
}

/** Where a skill lives for a given (writable) scope. */
export function skillPath(ws: Workspace, scope: WritableScope, id: string): string {
  if (scope === 'project') return join(ws.projectDir, '.conductor', 'skills', `${id}${SKILL_EXT}`);
  return join(ws.globalDir, 'skills', `${id}${SKILL_EXT}`);
}

/**
 * Project triggers.json — the single config file holding registered trigger
 * instances (spec §8.3). New shape:
 *   { "registered": [ { id, type, params, cron, enabled, ... }, ... ] }
 */
export function triggersJsonPath(ws: Workspace): string {
  return join(ws.projectDir, '.conductor', 'triggers.json');
}

/** Where a plugin lives on disk. */
export function pluginDir(ws: Workspace, id: string): string {
  return join(ws.projectDir, '.conductor', 'plugins', id);
}

/** Per-plugin file lookup — given a plugin and a `provides[].file`, return absolute path. */
export function pluginFileAbs(ws: Workspace, pluginId: string, relFile: string): string | null {
  const root = pluginDir(ws, pluginId);
  const abs = resolve(root, relFile);
  // Path-escape guard — refuse to follow `..` outside the plugin root.
  if (!abs.startsWith(root + sep) && abs !== root) {
    return null;
  }
  return abs;
}

/** The state.json under the global dir — used for plugin enable/disable flags. */
export function stateJsonPath(ws: Workspace): string {
  return join(ws.globalDir, 'state.json');
}

// ============================================================================
// Plugin registry
// ============================================================================

/** Rescan <project_dir>/.conductor/plugins/* and rebuild ws.plugins. */
export function reloadPluginRegistry(ws: Workspace): void {
  ws.plugins.clear();
  ws.triggerTypes.clear();
  ws.triggerTypeErrors.length = 0;
  const pluginsRoot = join(ws.projectDir, '.conductor', 'plugins');
  if (!existsSync(pluginsRoot)) return;

  let entries: string[];
  try {
    entries = readdirSync(pluginsRoot);
  } catch {
    return;
  }

  const stateFlags = readStateFlags(ws);

  for (const entry of entries) {
    const dir = join(pluginsRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const manifestPath = join(dir, 'plugin.yaml');
    if (!existsSync(manifestPath)) continue;

    let manifest: PluginManifest;
    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const parsed = yamlLoad(raw);
      const validation = validatePluginManifest(parsed);
      if (!validation.ok) {
        ws.plugins.set(entry, {
          id: entry,
          dir,
          manifest: { id: entry, name: entry, version: '0.0.0', description: '' },
          status: 'error',
          error: validation.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        });
        continue;
      }
      manifest = parsed as PluginManifest;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ws.plugins.set(entry, {
        id: entry,
        dir,
        manifest: { id: entry, name: entry, version: '0.0.0', description: '' },
        status: 'error',
        error: `failed to parse plugin.yaml: ${msg}`,
      });
      continue;
    }

    const enabled = stateFlags[manifest.id]?.enabled !== false; // default true
    ws.plugins.set(manifest.id, {
      id: manifest.id,
      dir,
      manifest,
      status: enabled ? 'enabled' : 'disabled',
    });
  }

  // Second pass — build the trigger-type registry. We do this after the
  // plugin map is fully populated so collision detection can deterministically
  // pick a winner by plugin-id sort order (matches the recipe shadowing rule).
  const pluginIds = [...ws.plugins.keys()].sort();
  for (const pid of pluginIds) {
    const plugin = ws.plugins.get(pid)!;
    if (plugin.status !== 'enabled') continue;
    const types = plugin.manifest.provides?.trigger_types ?? [];
    for (const t of types) {
      if (typeof t.id !== 'string' || t.id.length === 0) {
        ws.triggerTypeErrors.push({
          plugin_id: pid,
          type_id: String(t.id),
          error: 'trigger_type.id is required',
        });
        continue;
      }
      const existing = ws.triggerTypes.get(t.id);
      if (existing) {
        ws.triggerTypeErrors.push({
          plugin_id: pid,
          type_id: t.id,
          error: `trigger_type id ${t.id} already declared by plugin ${existing.source_plugin_id}; first declaration wins`,
        });
        continue;
      }
      const fileAbs = pluginFileAbs(ws, pid, t.file);
      if (!fileAbs) {
        ws.triggerTypeErrors.push({
          plugin_id: pid,
          type_id: t.id,
          error: `trigger_type.file path escapes plugin directory: ${t.file}`,
        });
        continue;
      }
      ws.triggerTypes.set(t.id, {
        ...t,
        source_plugin_id: pid,
        scope: `plugin:${pid}`,
        file_abs: fileAbs,
      });
    }
  }
}

interface StateFlags {
  [pluginId: string]: { enabled?: boolean };
}

function readStateFlags(ws: Workspace): StateFlags {
  const p = stateJsonPath(ws);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.plugins && typeof parsed.plugins === 'object') {
      return parsed.plugins as StateFlags;
    }
  } catch {
    // ignore — treat as empty
  }
  return {};
}

// ============================================================================
// Scope decoding
// ============================================================================

/** Pull the plugin id out of `plugin:<id>` (or null for other scopes). */
export function pluginIdOfScope(scope: string): string | null {
  if (!scope.startsWith('plugin:')) return null;
  const id = scope.slice('plugin:'.length);
  return id.length > 0 ? id : null;
}

/** Type-narrowing helper. */
export function isWritableScope(scope: string): scope is WritableScope {
  return scope === 'project' || scope === 'global';
}
