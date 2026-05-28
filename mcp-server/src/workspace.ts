/**
 * workspace.ts
 *
 * Resolves filesystem paths for the three scopes Clawdevbox recognizes
 * (project / plugin:<id> / global, spec §10.4) and maintains an in-memory
 * registry of installed plugins discovered under
 * `<global_dir>/plugins/*\/.claude-plugin/plugin.json`.
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
 * CLAWDEVBOX_PROJECT_DIR defaults to cwd when unset.
 * CLAWDEVBOX_GLOBAL_DIR is optional (defaults to `~/.clawdevbox`) — useful when
 * tests want to redirect "global" away from the real user home.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { listAgentAuthoredTemplates, toRegisteredType } from './template-store.ts';
import { BUILTIN_RENDERER_TYPES } from './renderer-registry.ts';
import type { AgentCliProvider, AgentCliProviderError } from './agent-clis/types.ts';
import { registerBuiltinProviders } from './agent-clis/index.ts';
import { loadPluginProviders } from './agent-clis/load-plugin.ts';
import { loadPluginFromDir, LoadPluginError } from './manifest/load-plugin.ts';
import type { ResolvedCapabilities, LoadError } from './manifest/load-plugin.ts';
import type { PluginManifest as ClaudePluginManifest, AgencyJson } from './manifest/types.ts';

// Re-export the canonical manifest type so existing consumers can keep
// importing `PluginManifest` from this module.
export type PluginManifest = ClaudePluginManifest;
export type { ResolvedCapabilities } from './manifest/load-plugin.ts';

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

/**
 * `provides.agent_clis[]` entry — declares a plugin-provided AgentCliProvider
 * (spec §4). Loader at `agent-clis/load-plugin.ts` dynamic-imports `module`
 * relative to the plugin directory and validates the exported provider shape.
 */
export interface PluginAgentCliEntry {
  id: string;
  module: string;
  display_name?: string;
  description?: string;
}

// `PluginManifest` is now re-exported from `manifest/types.ts` at the top of
// this file. The legacy yaml-shaped interface (with `id` / `provides`) was
// removed in Phase 2 of the marketplace+plugin schema migration.

export interface PluginEntry {
  /** Mirror of `manifest.name` so existing callers can use `entry.id`. */
  id: string;
  dir: string;
  manifest: PluginManifest;
  /** Resolved capabilities (skills, agents, commands, MCP, recipes, tools, …). */
  capabilities: ResolvedCapabilities;
  /** Per-plugin agency.json sidecar, if present and valid. */
  agencyJson?: AgencyJson;
  /** Per-capability load errors that didn't block the plugin from loading. */
  loadErrors: LoadError[];
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
  /**
   * Plugin-provided renderer registry. Keyed by renderer `type` (matches the
   * `artifact.type` field). Built from each plugin's resolved
   * `capabilities.renderers`; first-loaded wins on id collisions (sorted by
   * plugin id). Built-in renderer types cannot be shadowed — those load
   * attempts land in `rendererErrors` with `BUILTIN_COLLISION`.
   */
  pluginRenderers: Map<string, { type: string; pluginId: string; absoluteFile: string }>;
  /** Renderer-registry load errors (collisions). */
  rendererErrors: Array<{
    plugin_id: string;
    type: string;
    error: string;
    code: 'BUILTIN_COLLISION' | 'PLUGIN_COLLISION';
  }>;
}

/** Read CLAWDEVBOX_PROJECT_DIR (defaults to cwd) + CLAWDEVBOX_GLOBAL_DIR (optional). */
export async function loadWorkspaceFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Workspace> {
  let projectDir = (env.CLAWDEVBOX_PROJECT_DIR ?? '').trim();
  if (!projectDir) projectDir = process.cwd();
  if (!existsSync(projectDir)) {
    throw new WorkspaceConfigError(
      `Resolved project dir does not exist: ${projectDir}`,
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
    pluginRenderers: new Map(),
    rendererErrors: [],
  };
  await reloadTypeRegistries(ws);
  warnIfLegacyProjectPlugins(ws);
  return ws;
}

/**
 * One-shot warning at server boot if the legacy `<projectDir>/.clawdevbox/plugins/`
 * tree still has plugins inside. Under the new global-store model those are
 * silently ignored; users need to reinstall into the global store to get them
 * back. Errors here are swallowed (logging is best-effort).
 *
 * Skips the warning when `<projectDir>/.clawdevbox/plugins` resolves to the
 * SAME path as the global plugin store — which happens whenever projectDir is
 * an ancestor of globalDir (e.g. running `clawdevbox init` from `~` with the
 * default globalDir at `~/.clawdevbox`). In that case the directory isn't
 * "legacy" at all, it's the live store.
 */
function warnIfLegacyProjectPlugins(ws: Workspace): void {
  const legacy = join(ws.projectDir, '.clawdevbox', 'plugins');
  if (!existsSync(legacy)) return;
  // False-positive guard: if `legacy` IS the global plugin store (common when
  // the user's projectDir is an ancestor of globalDir), the directory is the
  // live store, not a leftover. Compare resolved paths case-insensitively on
  // Windows where filesystems are case-insensitive.
  const resolvedLegacy = resolve(legacy);
  const resolvedGlobal = resolve(globalPluginsDir(ws));
  const samePath = process.platform === 'win32'
    ? resolvedLegacy.toLowerCase() === resolvedGlobal.toLowerCase()
    : resolvedLegacy === resolvedGlobal;
  if (samePath) return;
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

/**
 * Where a skill's SKILL.md lives for a given (writable) scope. Skills are
 * directory-shaped per spec §3.7: `<scope>/skills/<id>/SKILL.md`, with
 * supporting files optionally beside it inside the same directory.
 */
export function skillPath(ws: Workspace, scope: WritableScope, id: string): string {
  return join(skillDirPath(ws, scope, id), `SKILL${SKILL_EXT}`);
}

/** Directory that contains a skill's SKILL.md + supporting files. */
export function skillDirPath(ws: Workspace, scope: WritableScope, id: string): string {
  if (scope === 'project') return join(ws.projectDir, '.clawdevbox', 'skills', id);
  return join(ws.globalDir, 'skills', id);
}

/** Legacy flat-file path: `<scope>/skills/<id>.md`. Used only to clean up. */
export function legacySkillFilePath(ws: Workspace, scope: WritableScope, id: string): string {
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
export async function reloadTypeRegistries(ws: Workspace): Promise<void> {
  ws.plugins.clear();
  ws.triggerTypes.clear();
  ws.triggerTypeErrors.length = 0;
  ws.pluginRenderers.clear();
  ws.rendererErrors.length = 0;
  // Clear and reseed the agent-CLI registry on every reload. Built-ins always
  // go first so plugin-provided providers can't shadow built-in ids.
  ws.agentCliProviders = new Map();
  ws.agentCliProviderErrors = [];
  registerBuiltinProviders(ws);
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

      // New loader: read `.claude-plugin/plugin.json` (spec §3). The loader
      // throws typed `LoadPluginError`s for MISSING_MANIFEST /
      // INVALID_MANIFEST_JSON / INVALID_MANIFEST_SHAPE — we trap those and
      // record an error-status plugin entry so the registry stays consistent.
      let loaded;
      try {
        loaded = await loadPluginFromDir(dir);
      } catch (err) {
        if (err instanceof LoadPluginError) {
          if (err.code === 'MISSING_MANIFEST') {
            // No manifest at all — silently skip; could be a stray junction
            // or a legacy plugin directory left behind during migration.
            continue;
          }
          ws.plugins.set(entry, {
            id: entry,
            dir,
            manifest: { name: entry },
            capabilities: emptyCapabilities(),
            loadErrors: [],
            status: 'error',
            error: err.message,
          });
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        ws.plugins.set(entry, {
          id: entry,
          dir,
          manifest: { name: entry },
          capabilities: emptyCapabilities(),
          loadErrors: [],
          status: 'error',
          error: `failed to load plugin: ${msg}`,
        });
        continue;
      }

      const name = loaded.manifest.name;
      // Manifest name must match directory name (same rule as the legacy
      // `id === <dir>` check) so junctioned local plugins can't silently
      // shadow themselves under a different id.
      if (name !== entry) {
        ws.plugins.set(entry, {
          id: entry,
          dir,
          manifest: loaded.manifest,
          capabilities: loaded.capabilities,
          agencyJson: loaded.agencyJson,
          loadErrors: loaded.loadErrors,
          status: 'error',
          error: `manifest.name ("${name}") does not match plugin directory name ("${entry}"). Rename one to match.`,
        });
        continue;
      }

      const enabled = stateFlags[name]?.enabled !== false; // default true
      ws.plugins.set(name, {
        id: name,
        dir,
        manifest: loaded.manifest,
        capabilities: loaded.capabilities,
        agencyJson: loaded.agencyJson,
        loadErrors: loaded.loadErrors,
        status: enabled ? 'enabled' : 'disabled',
      });
    }

  }

  // ---- Load vaults as plugin sources ----------------------------------------
  // Vaults have `.claude-plugin/plugin.json` and are valid plugin dirs. Load
  // them so skill.list/read, recipe.list, trigger types, etc. surface vault
  // content through the standard scope system (scope = `plugin:<vault-id>`).
  try {
    const cfgPath = join(ws.globalDir, 'config.json');
    if (existsSync(cfgPath)) {
      const cfgRaw = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const vaults: Array<{ id: string; path: string }> = Array.isArray(cfgRaw?.vaults) ? cfgRaw.vaults : [];
      for (const vault of vaults) {
        if (!vault.id || !vault.path || !existsSync(vault.path)) continue;
        if (ws.plugins.has(vault.id)) continue; // don't shadow installed plugins
        try {
          const loaded = await loadPluginFromDir(vault.path);
          ws.plugins.set(vault.id, {
            id: vault.id,
            dir: vault.path,
            manifest: loaded.manifest,
            capabilities: loaded.capabilities,
            agencyJson: loaded.agencyJson,
            loadErrors: loaded.loadErrors,
            status: 'enabled',
          });
        } catch {
          // Vault missing manifest or malformed — skip silently.
        }
      }
    }
  } catch {
    // Config read failure — skip vault loading gracefully.
  }

  {
    // Second pass — build the trigger-type registry. We do this after the
    // plugin map is fully populated so collision detection can deterministically
    // pick a winner by plugin-id sort order (matches the recipe shadowing rule).
    const pluginIds = [...ws.plugins.keys()].sort();
    for (const pid of pluginIds) {
      const plugin = ws.plugins.get(pid)!;
      if (plugin.status !== 'enabled') continue;
      const types = plugin.capabilities.triggerTypes;
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

    // Third pass — build the plugin-renderer registry. Same precedence rule:
    // sort by plugin id, first-loaded wins. Built-in collisions are dropped.
    for (const pid of pluginIds) {
      const plugin = ws.plugins.get(pid)!;
      if (plugin.status !== 'enabled') continue;
      for (const r of plugin.capabilities.renderers ?? []) {
        if (BUILTIN_RENDERER_TYPES.has(r.type)) {
          ws.rendererErrors.push({
            plugin_id: pid,
            type: r.type,
            error: `renderer type '${r.type}' collides with a built-in renderer; plugin entry ignored.`,
            code: 'BUILTIN_COLLISION',
          });
          continue;
        }
        const existing = ws.pluginRenderers.get(r.type);
        if (existing) {
          ws.rendererErrors.push({
            plugin_id: pid,
            type: r.type,
            error: `renderer type '${r.type}' already declared by plugin ${existing.pluginId}; first declaration wins`,
            code: 'PLUGIN_COLLISION',
          });
          continue;
        }
        ws.pluginRenderers.set(r.type, {
          type: r.type,
          pluginId: pid,
          absoluteFile: r.absoluteFile,
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

  // ---- Plugin-provided AgentCliProviders (spec §4) ----
  // Runs AFTER `ws.plugins` is populated and AFTER `registerBuiltinProviders`
  // so built-ins always win id collisions with plugin-provided providers.
  await loadPluginProviders(ws);
}

function emptyCapabilities(): ResolvedCapabilities {
  return {
    skills: [],
    agents: [],
    commands: [],
    mcpServers: {},
    recipes: [],
    tools: [],
    triggerTypes: [],
    agentClis: [],
    renderers: [],
  };
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
