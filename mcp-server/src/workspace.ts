/**
 * workspace.ts
 *
 * Resolves filesystem paths for the three scopes Clawdevbox recognizes
 * (project / plugin:<id> / global, spec §10.4) and maintains an in-memory
 * registry of installed plugins discovered under
 * `<global_dir>/plugins/*\/plugin.yaml`.
 *
 * Plugins are *globally* installed under `<globalDir>/plugins/<id>/`. An
 * entry is either a real directory (built-in copy / git clone) or a
 * symlink/junction back to the user-provided absolute folder for local
 * installs. `statSync()` follows the link, so the rest of discovery works
 * uniformly.
 *
 * No process state, no caches beyond the plugin registry — every file read
 * goes straight to disk. The registry is rebuilt on demand
 * (`reloadPluginRegistry()`) by the plugin.* tools after install/uninstall.
 *
 * CLAWDEVBOX_PROJECT_DIR is mandatory; the server refuses to start without it.
 * CLAWDEVBOX_GLOBAL_DIR is optional (defaults to `~/.clawdevbox`) — useful when
 * tests want to redirect "global" away from the real user home.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { validatePluginManifest } from './validators.ts';
import { listAgentAuthoredTemplates, toRegisteredType } from './template-store.ts';
import type { AgentCliProvider, AgentCliProviderError } from './agent-clis/types.ts';

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
 * which is held by the clawdevbox sidecar in `.clawdevbox/triggers.json`.
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
   * Clawdevbox mints `/callback/recipes/<recipe_id>/run` (or `.../run/<inbox_item_id>`)
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
  /** Script runtime — drives the spawn command. Plugin-shipped types omit this and default to 'tsx' for backward compatibility. Required on agent-authored templates. */
  runtime?: 'node' | 'tsx' | 'python' | 'bash';
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
     * which appends a row to `.clawdevbox/triggers.json` `registered[]`.
     */
    trigger_types?: PluginTriggerType[];
    /** Hostable tools (spec §10.3) — single-file scripts hosted in-process. */
    tools?: PluginProvideEntry[];
    mcp_servers?: PluginProvideEntry[];
  };
  requires?: {
    clawdevbox_version?: string;
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
  scope: `plugin:${string}` | 'global' | 'project';
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
  /** Agent-CLI provider registry. Built-ins land here first, then plugin-provided overlays. */
  agentCliProviders: Map<string, AgentCliProvider>;
  /** Provider load errors (collisions, malformed plugin modules). */
  agentCliProviderErrors: AgentCliProviderError[];
}

/** Read CLAWDEVBOX_PROJECT_DIR (required) + CLAWDEVBOX_GLOBAL_DIR (optional). */
export function loadWorkspaceFromEnv(env: NodeJS.ProcessEnv = process.env): Workspace {
  const projectDir = env.CLAWDEVBOX_PROJECT_DIR;
  if (!projectDir || projectDir.trim() === '') {
    throw new WorkspaceConfigError(
      'CLAWDEVBOX_PROJECT_DIR env var is required (path to the workspace root).',
    );
  }
  if (!existsSync(projectDir)) {
    throw new WorkspaceConfigError(
      `CLAWDEVBOX_PROJECT_DIR does not exist: ${projectDir}`,
    );
  }
  const globalDir = env.CLAWDEVBOX_GLOBAL_DIR ?? join(homedir(), '.clawdevbox');
  const ws: Workspace = {
    projectDir: resolve(projectDir),
    globalDir: resolve(globalDir),
    plugins: new Map(),
    triggerTypes: new Map(),
    triggerTypeErrors: [],
    agentCliProviders: new Map(),
    agentCliProviderErrors: [],
  };
  reloadTypeRegistries(ws);
  warnIfLegacyProjectPlugins(ws);
  return ws;
}

/**
 * One-shot warning at server boot if the legacy `<projectDir>/.clawdevbox/plugins/`
 * tree still has plugins inside. Under the new global-store model those are
 * silently ignored; users need to reinstall into the global store to get them
 * back. Errors here are swallowed (logging is best-effort).
 */
function warnIfLegacyProjectPlugins(ws: Workspace): void {
  const legacy = join(ws.projectDir, '.clawdevbox', 'plugins');
  if (!existsSync(legacy)) return;
  let entries: string[];
  try {
    entries = readdirSync(legacy).filter((n) => !n.startsWith('.'));
  } catch {
    return;
  }
  if (entries.length === 0) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[clawdevbox] Legacy project-scope plugins detected at ${legacy} (${entries.join(
      ', ',
    )}). These are no longer scanned — plugins now live under ${globalPluginsDir(
      ws,
    )}. Reinstall via 'plugin.install' to migrate.`,
  );
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
  if (scope === 'project') return join(ws.projectDir, '.clawdevbox', 'recipes', `${id}${RECIPE_EXT}`);
  return join(ws.globalDir, 'recipes', `${id}${RECIPE_EXT}`);
}

/** Where a skill lives for a given (writable) scope. */
export function skillPath(ws: Workspace, scope: WritableScope, id: string): string {
  if (scope === 'project') return join(ws.projectDir, '.clawdevbox', 'skills', `${id}${SKILL_EXT}`);
  return join(ws.globalDir, 'skills', `${id}${SKILL_EXT}`);
}

/**
 * Project triggers.json — the single config file holding registered trigger
 * instances (spec §8.3). New shape:
 *   { "registered": [ { id, type, params, cron, enabled, ... }, ... ] }
 */
export function triggersJsonPath(ws: Workspace): string {
  return join(ws.projectDir, '.clawdevbox', 'triggers.json');
}

/** Where project-scope agent-authored trigger TYPES live. */
export function projectTriggerTypesDir(ws: Workspace): string {
  return join(ws.projectDir, '.clawdevbox', 'trigger-types');
}

/** Where global-scope agent-authored trigger TYPES live. */
export function globalTriggerTypesDir(ws: Workspace): string {
  return join(ws.globalDir, 'trigger-types');
}

/** Reserved subdirectory for one-off auto-templates created by trigger.register. */
export function oneoffTemplatesDir(ws: Workspace): string {
  return join(projectTriggerTypesDir(ws), '_oneoff');
}

/** Where a plugin lives on disk. Always under the global plugin store. */
export function pluginDir(ws: Workspace, id: string): string {
  return join(ws.globalDir, 'plugins', id);
}

/** Root of the global plugin store. */
export function globalPluginsDir(ws: Workspace): string {
  return join(ws.globalDir, 'plugins');
}

/**
 * Sidecar install-record path. We deliberately keep this *outside* the
 * plugin directory so junction-installed local plugins don't get extra
 * files written into the user's source folder.
 */
export function pluginInstallRecordPath(ws: Workspace, id: string): string {
  return join(ws.globalDir, 'plugins', `${id}.install.json`);
}

/**
 * Junction path that points at clawdevbox's own `node_modules` so plugin
 * hostable tools can resolve `import 'zod'` (and friends) via Node's
 * walk-up algorithm. Real-dir plugins (built-in copy, git clone) under
 * `<globalDir>/plugins/<id>/tools/foo.ts` walk up and find this.
 *
 * Local-junction plugins additionally get a best-effort junction at the
 * user's folder root so realpath-based resolution finds host deps there.
 */
export function globalNodeModulesLinkPath(ws: Workspace): string {
  return join(ws.globalDir, 'node_modules');
}

/** Per-plugin file lookup — given a plugin's installed dir and a `provides[].file`, return absolute path. */
export function pluginFileAbs(ws: Workspace, pluginId: string, relFile: string): string | null {
  const plugin = ws.plugins.get(pluginId);
  // Prefer the registry entry's resolved dir (handles future relocations);
  // fall back to the canonical global path when called before registry
  // load (defensive — every real caller waits until reloadPluginRegistry).
  const root = plugin?.dir ?? pluginDir(ws, pluginId);
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

/** Rescan <globalDir>/plugins/* and rebuild ws.plugins. */
export function reloadTypeRegistries(ws: Workspace): void {
  ws.plugins.clear();
  ws.triggerTypes.clear();
  ws.triggerTypeErrors.length = 0;
  const pluginsRoot = globalPluginsDir(ws);
  if (existsSync(pluginsRoot)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(pluginsRoot);
    } catch {
      entries = [];
    }

    const stateFlags = readStateFlags(ws);

    for (const entry of entries) {
      // Skip dotfiles / atomic-install temp dirs / sibling sidecar files
      // (`<id>.install.json`) — only directories (real or symlinks resolved
      // to dirs) are plugin candidates.
      if (entry.startsWith('.')) continue;
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

      // Manifest id must match directory name. A junctioned local plugin
      // whose author renames `id:` would otherwise silently double-register
      // or shadow itself; we'd rather surface the mismatch.
      if (manifest.id !== entry) {
        ws.plugins.set(entry, {
          id: entry,
          dir,
          manifest,
          status: 'error',
          error: `manifest.id ("${manifest.id}") does not match plugin directory name ("${entry}"). Rename one to match.`,
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

  // ---- Global agent-authored templates (mid precedence — overrides plugins) ----
  for (const loaded of listAgentAuthoredTemplates(ws, 'global')) {
    const id = loaded.manifest.id;
    const prior = ws.triggerTypes.get(id);
    if (prior) {
      ws.triggerTypeErrors.push({
        plugin_id: prior.source_plugin_id || '<global>',
        type_id: id,
        error: `trigger_type id ${id} from ${prior.scope} is shadowed by a global agent-authored template`,
      });
    }
    ws.triggerTypes.set(id, toRegisteredType(loaded));
  }

  // ---- Project agent-authored templates (highest precedence) ----
  for (const loaded of listAgentAuthoredTemplates(ws, 'project')) {
    const id = loaded.manifest.id;
    const prior = ws.triggerTypes.get(id);
    if (prior) {
      ws.triggerTypeErrors.push({
        plugin_id: prior.source_plugin_id || '<project>',
        type_id: id,
        error: `trigger_type id ${id} from ${prior.scope} is shadowed by a project agent-authored template`,
      });
    }
    ws.triggerTypes.set(id, toRegisteredType(loaded));
  }
}

/** @deprecated — use reloadTypeRegistries. Kept for back-compat with plugin.ts callers. */
export const reloadPluginRegistry = reloadTypeRegistries;

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
