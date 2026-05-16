/**
 * tools/plugin.ts
 *
 * plugin.list / read / install / update / uninstall / enable / disable.
 *
 * Plugins live under `<globalDir>/plugins/<id>/`. Entries are either real
 * directories (built-in copies, git clones — `.git` kept so updates can
 * fetch/reset) or junctions/symlinks pointing at user-provided absolute
 * folders (local installs are never copied — `loaded from there` so updates
 * are picked up live).
 *
 * Install records live in a sibling sidecar file
 * `<globalDir>/plugins/<id>.install.json` — we never write into a
 * user-owned local folder.
 *
 * install / update use real `git clone` / `git fetch+reset`, copy via
 * `cpSync` for built-ins, and `symlinkSync` (POSIX) /
 * `symlinkSync(... , 'junction')` (Windows) for local sources. We invoke
 * `git` via `child_process.spawnSync` (no extra dep). On Windows this hits
 * the user's installed `git.exe`; if git isn't on PATH the install fails
 * with a clear stderr forward.
 *
 * enable/disable persist their flag in `<global>/state.json` so the
 * in-memory plugin registry can reflect the toggle on reload.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { notFound, structuredError, validationError } from '../scope.ts';
import { validatePluginManifestJson, validateAgencyJson } from '../validators.ts';
import { filterByEngines } from '../manifest/load-marketplace.ts';
import { readGlobalConfig } from '../config.ts';
import type { AgencyJson } from '../manifest/types.ts';
import {
  globalPluginsDir,
  pluginDir,
  pluginInstallRecordPath,
  reloadPluginRegistry,
  stateJsonPath,
  type PluginEntry,
  type Workspace,
} from '../workspace.ts';

/** Fire-and-forget bidirectional client plugin sync after a mutation. */
async function fireClientSync(
  ws: Workspace,
  event: 'plugin-install' | 'plugin-uninstall',
): Promise<void> {
  try {
    const { maybeRunClientSync } = await import('../agent-clis/lifecycle.ts');
    const { resolveConfig } = await import('../config.ts');
    const cfg = resolveConfig({ projectDir: ws.projectDir, globalDir: ws.globalDir });
    await maybeRunClientSync(ws, cfg, event);
  } catch {
    // Lifecycle errors never abort the calling operation.
  }
}

interface StateFile {
  plugins?: Record<string, { enabled?: boolean }>;
}

/** Sidecar install-record. Persisted next to (not inside) the plugin dir. */
export interface InstallRecord {
  /** How this plugin was installed. */
  kind: 'git' | 'local' | 'builtin' | 'manual';
  /** Original source string passed to `plugin.install` / init. */
  from: string;
  /** Branch / tag / sha for git sources; null otherwise. */
  ref: string | null;
  /**
   * For `kind: 'local'`, the absolute user-provided folder the junction
   * points at. Captured separately from `from` so we can detect drift.
   */
  source_path?: string;
  installed_at: number;
}

export function readInstallRecord(ws: Workspace, id: string): InstallRecord | null {
  const p = pluginInstallRecordPath(ws, id);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<InstallRecord>;
    if (typeof parsed.kind !== 'string') return null;
    return parsed as InstallRecord;
  } catch {
    return null;
  }
}

export function writeInstallRecord(ws: Workspace, id: string, record: InstallRecord): void {
  const p = pluginInstallRecordPath(ws, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + '\n', 'utf8');
}

export function removeInstallRecord(ws: Workspace, id: string): void {
  const p = pluginInstallRecordPath(ws, id);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

function readStateFile(ws: Workspace): StateFile {
  const p = stateJsonPath(ws);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StateFile;
  } catch {
    return {};
  }
}

function writeStateFile(ws: Workspace, file: StateFile): void {
  const p = stateJsonPath(ws);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

function summarizeCapabilities(p: PluginEntry): string {
  const counts: Record<string, number> = {
    skills: p.capabilities.skills.length,
    recipes: p.capabilities.recipes.length,
    trigger_types: p.capabilities.triggerTypes.length,
    tools: p.capabilities.tools.length,
    agents: p.capabilities.agents.length,
    commands: p.capabilities.commands.length,
    mcp_servers: Object.keys(p.capabilities.mcpServers).length,
  };
  const parts: string[] = [];
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) parts.push(`${v} ${k}`);
  }
  return parts.join(', ') || 'no capabilities';
}

/**
 * Create a junction (Windows) / symlink (POSIX) at `linkPath` pointing to
 * `target`. Idempotent: if `linkPath` already exists, returns false.
 */
export function createPluginLink(target: string, linkPath: string): { created: boolean } {
  if (existsSync(linkPath)) return { created: false };
  mkdirSync(dirname(linkPath), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(target, linkPath, linkType);
  return { created: true };
}

/**
 * Best-effort: ensure `<source>/node_modules` exists so a junctioned local
 * plugin's hostable tools resolve `import 'zod'` via Node's realpath-based
 * walk-up. We never overwrite an existing entry. Failures (denied
 * permissions, EPERM) are swallowed — the user can vendor their own
 * deps, and declarative plugins (no hostable tools) don't need this.
 */
function ensureLocalSourceNodeModulesLink(sourcePath: string, hostNodeModules: string): {
  linked: boolean;
  reason?: string;
} {
  const linkPath = join(sourcePath, 'node_modules');
  if (existsSync(linkPath)) return { linked: false, reason: 'already exists' };
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(hostNodeModules, linkPath, linkType);
    return { linked: true };
  } catch (err) {
    return { linked: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Detect whether a path is a symlink (POSIX) or junction (Windows). Used
 * to choose between unlinking the entry vs recursive directory removal.
 */
// (unused helper removed — uninstall calls lstatSync directly inline.)

/** Locate the host `node_modules` from the running clawdevbox install. */
function locateHostNodeModules(): string | null {
  // Walk up from current module looking for a node_modules dir.
  let cur = resolve(thisDir);
  for (let i = 0; i < 8; i++) {
    const candidate = join(cur, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// Derive this module's directory under ESM — same trick `builtin-marketplace.ts`
// uses. Used by `locateHostNodeModules()` to find clawdevbox's installed deps.
import { fileURLToPath } from 'node:url';
const thisDir = dirname(fileURLToPath(import.meta.url));

export function registerPluginTools(server: McpServer, ws: Workspace): void {
  // -- plugin.list ----------------------------------------------------------
  server.registerTool(
    'plugin.list',
    {
      description:
        'List installed plugins under `<global_dir>/plugins/*`. Returns id, name, version, description, status, and a one-line provides summary (spec §10.3).',
      inputSchema: {},
    },
    async () => {
      const plugins = [...ws.plugins.values()].map((p) => ({
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        status: p.status,
        provides_summary: summarizeCapabilities(p),
        error: p.error,
      }));
      return {
        content: [{ type: 'text', text: `Found ${plugins.length} plugin(s).` }],
        structuredContent: { plugins, count: plugins.length },
      };
    },
  );

  // -- plugin.read ----------------------------------------------------------
  server.registerTool(
    'plugin.read',
    {
      description:
        "Read a plugin's full manifest plus provides listing + install origin (sidecar `<id>.install.json` if present).",
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const plugin = ws.plugins.get(args.id);
      if (!plugin) return notFound('plugin', args.id);
      const origin = readInstallRecord(ws, args.id);
      return {
        content: [{ type: 'text', text: `plugin ${plugin.id} v${plugin.manifest.version} [${plugin.status}]` }],
        structuredContent: {
          id: plugin.id,
          dir: plugin.dir,
          status: plugin.status,
          error: plugin.error,
          manifest: plugin.manifest,
          origin,
        },
      };
    },
  );

  // -- plugin.install -------------------------------------------------------
  server.registerTool(
    'plugin.install',
    {
      description:
        "Install a plugin (spec §10.6). Sources: `git+https://`, `git+ssh://` (cloned with full history into `<global_dir>/plugins/<id>/`, `.git` retained so `plugin.update` can fetch/reset), or an absolute local folder (junctioned at `<global_dir>/plugins/<id>` so edits in the user's folder are picked up live — never copied). `ref` is an optional branch/tag/sha for git sources.",
      inputSchema: {
        from: z.string().min(1),
        ref: z.string().optional(),
      },
    },
    async (args) => {
      const pluginsRoot = globalPluginsDir(ws);
      mkdirSync(pluginsRoot, { recursive: true });

      if (args.from.startsWith('git+')) {
        return installFromGit(ws, args.from, args.ref ?? null);
      }
      if (isAbsolute(args.from) && existsSync(args.from)) {
        const stat = statSync(args.from);
        if (!stat.isDirectory()) {
          return structuredError('INVALID_SOURCE', `from must be a directory (got file): ${args.from}`);
        }
        return installFromLocalFolder(ws, args.from);
      }
      return structuredError(
        'UNSUPPORTED_FROM',
        `from must be 'git+https://...', 'git+ssh://...', or an absolute existing directory. Got: ${args.from}`,
      );
    },
  );

  // -- plugin.update --------------------------------------------------------
  server.registerTool(
    'plugin.update',
    {
      description:
        'Refresh a git-installed plugin (`git fetch` + `git reset --hard origin/<ref or HEAD>`). For local-folder plugins (junctioned) the user edits the folder directly — there is nothing to pull. Built-in / manual installs error with a clear message.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const plugin = ws.plugins.get(args.id);
      if (!plugin) return notFound('plugin', args.id);
      const record = readInstallRecord(ws, args.id);
      if (!record) {
        return structuredError(
          'NOT_GIT_INSTALLED',
          `Plugin '${args.id}' has no install record — cannot auto-update. Reinstall via plugin.install or update manually.`,
        );
      }
      if (record.kind === 'local') {
        return structuredError(
          'LOCAL_SOURCE_NO_UPDATE',
          `Plugin '${args.id}' is a local-folder install (junctioned to ${record.source_path ?? record.from}). Edits in that folder are already live; there's nothing to pull.`,
        );
      }
      if (record.kind !== 'git') {
        return structuredError(
          'NOT_GIT_INSTALLED',
          `Plugin '${args.id}' was installed as '${record.kind}' (not git) — cannot auto-update. Reinstall to refresh.`,
        );
      }
      // Fetch + hard-reset. We don't trust the user's branch state — they
      // may have left detached HEAD from a previous pinned ref.
      const fetch = spawnSync('git', ['fetch', '--prune', 'origin'], {
        cwd: plugin.dir,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (fetch.status !== 0) {
        return structuredError(
          'GIT_FETCH_FAILED',
          `git fetch failed (exit ${fetch.status}): ${fetch.stderr ?? fetch.stdout ?? ''}`,
        );
      }
      const target = record.ref && record.ref.length > 0 ? record.ref : 'HEAD';
      // Resolve the symbolic upstream when ref is HEAD; otherwise reset
      // straight to the recorded ref (could be a tag, sha, or branch).
      let resetTarget: string;
      if (target === 'HEAD') {
        const head = spawnSync(
          'git',
          ['symbolic-ref', 'refs/remotes/origin/HEAD'],
          { cwd: plugin.dir, stdio: 'pipe', encoding: 'utf8' },
        );
        resetTarget =
          head.status === 0 && head.stdout
            ? head.stdout.trim().replace(/^refs\/remotes\//, '')
            : 'origin/HEAD';
      } else {
        // For branch refs prefer origin/<branch>; tags/SHAs are passed
        // through as-is.
        const showRef = spawnSync(
          'git',
          ['show-ref', '--verify', `refs/remotes/origin/${target}`],
          { cwd: plugin.dir, stdio: 'pipe', encoding: 'utf8' },
        );
        resetTarget = showRef.status === 0 ? `origin/${target}` : target;
      }
      const reset = spawnSync('git', ['reset', '--hard', resetTarget], {
        cwd: plugin.dir,
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (reset.status !== 0) {
        return structuredError(
          'GIT_RESET_FAILED',
          `git reset --hard ${resetTarget} failed (exit ${reset.status}): ${reset.stderr ?? reset.stdout ?? ''}`,
        );
      }
      // Re-validate the manifest after the reset.
      const manifestPath = join(plugin.dir, '.claude-plugin', 'plugin.json');
      if (!existsSync(manifestPath)) {
        return structuredError('MANIFEST_MISSING', `.claude-plugin/plugin.json not found at ${manifestPath} after update`);
      }
      await reloadPluginRegistry(ws);
      return {
        content: [{ type: 'text', text: `Updated plugin ${args.id} (reset to ${resetTarget}).` }],
        structuredContent: { id: args.id, reset_to: resetTarget, output: reset.stdout?.trim() ?? '' },
      };
    },
  );

  // -- plugin.uninstall -----------------------------------------------------
  server.registerTool(
    'plugin.uninstall',
    {
      description:
        "Remove a plugin from `<global_dir>/plugins/<id>/` (unlinks junctions for local installs, rm -rf for real directories) and delete its sidecar install record. Project-scope copies (recipes/skills/triggers in `<projectDir>/.clawdevbox/`) survive (spec §10.5).",
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      // Accept by id even if the plugin failed to load — the install record
      // / on-disk entry may still need cleanup.
      const targetDir = pluginDir(ws, args.id);
      const hadRegistryEntry = ws.plugins.has(args.id);
      const hadOnDiskEntry = existsSync(targetDir);
      const hadSidecar = existsSync(pluginInstallRecordPath(ws, args.id));
      if (!hadRegistryEntry && !hadOnDiskEntry && !hadSidecar) {
        return notFound('plugin', args.id);
      }
      if (hadOnDiskEntry) {
        // Distinguish junction/symlink from real dir to avoid deleting the
        // user's local-folder source tree.
        let entryKind: 'link' | 'dir' = 'dir';
        try {
          const st = lstatSync(targetDir);
          if (st.isSymbolicLink()) entryKind = 'link';
        } catch {
          // fall through as 'dir' — rmSync will surface real errors
        }
        try {
          if (entryKind === 'link') {
            // unlinkSync removes the link without following it (works for
            // POSIX symlinks AND Windows junctions per Node docs).
            unlinkSync(targetDir);
          } else {
            rmSync(targetDir, { recursive: true, force: true });
          }
        } catch (err) {
          return structuredError(
            'UNINSTALL_FAILED',
            `Failed to remove ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      removeInstallRecord(ws, args.id);
      await reloadPluginRegistry(ws);
      await fireClientSync(ws, 'plugin-uninstall');
      return {
        content: [{ type: 'text', text: `Uninstalled plugin ${args.id}.` }],
        structuredContent: { id: args.id, dir: targetDir },
      };
    },
  );

  // -- plugin.enable / plugin.disable ---------------------------------------
  for (const action of ['enable', 'disable'] as const) {
    server.registerTool(
      `plugin.${action}`,
      {
        description: `${action[0].toUpperCase() + action.slice(1)} a plugin globally (flag in <global_dir>/state.json; provides un/re-register on reload). Affects every project on this account.`,
        inputSchema: { id: z.string().min(1) },
      },
      async (args) => {
        const plugin = ws.plugins.get(args.id);
        if (!plugin) return notFound('plugin', args.id);
        const state = readStateFile(ws);
        state.plugins ??= {};
        state.plugins[args.id] = { enabled: action === 'enable' };
        writeStateFile(ws, state);
        await reloadPluginRegistry(ws);
        return {
          content: [
            { type: 'text', text: `${action === 'enable' ? 'Enabled' : 'Disabled'} plugin ${args.id}.` },
          ],
          structuredContent: { id: args.id, enabled: action === 'enable' },
        };
      },
    );
  }
}

// ============================================================================
// install helpers
// ============================================================================

/**
 * Read a plugin's sibling `agency.json` (Microsoft per-plugin sidecar) if
 * it's present and shape-valid. Returns `undefined` for missing or
 * malformed sidecars — the install path still proceeds and `filterByEngines`
 * treats `undefined` as "no filter".
 */
function tryReadAgencyJsonSync(pluginDir: string): AgencyJson | undefined {
  const p = join(pluginDir, 'agency.json');
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    const errs = validateAgencyJson(parsed);
    if (errs.length > 0) return undefined;
    return parsed as AgencyJson;
  } catch {
    return undefined;
  }
}

/** Resolve the engine id (configured agent-CLI provider or null). */
function configuredAgentCli(ws: Workspace): string | null {
  try {
    const cfg = readGlobalConfig(ws.globalDir);
    return cfg?.default_agent_cli ?? null;
  } catch {
    return null;
  }
}

/**
 * Clone a git repo into a sibling temp dir, validate the manifest, atomic
 * rename to `<global_dir>/plugins/<id>/`. Full clones (no `--depth 1`) so
 * `plugin.update` can fetch+reset across branches/tags/SHAs reliably.
 */
async function installFromGit(ws: Workspace, from: string, ref: string | null): Promise<CallToolResult> {
  const pluginsRoot = globalPluginsDir(ws);
  const tmp = mkdtempSync(join(pluginsRoot, '.tmp-install-'));
  let succeeded = false;
  try {
    const gitUrl = from.slice('git+'.length);
    const cloneArgs = ['clone'];
    if (ref) cloneArgs.push('--branch', ref);
    cloneArgs.push(gitUrl, tmp);
    const result = spawnSync('git', cloneArgs, { stdio: 'pipe', encoding: 'utf8' });
    if (result.status !== 0) {
      return structuredError(
        'GIT_CLONE_FAILED',
        `git clone failed (exit ${result.status}): ${result.stderr ?? result.stdout ?? ''}`,
      );
    }
    // Validate manifest at the temp root
    const manifestPath = join(tmp, '.claude-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) {
      return structuredError(
        'MANIFEST_MISSING',
        '.claude-plugin/plugin.json not found at the source root. (For multi-plugin git repos, use `clawdevbox init --plugin <git-url>` which can pick a subdir.)',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return structuredError('MANIFEST_PARSE_ERROR', msg);
    }
    const validationErrs = validatePluginManifestJson(parsed);
    if (validationErrs.length > 0) return validationError(validationErrs);

    const manifest = parsed as { name: string };
    // Engines filter (spec §4.4): respect agency.json's `engines` list.
    const agency = tryReadAgencyJsonSync(tmp);
    const filter = filterByEngines(agency, configuredAgentCli(ws));
    if (!filter.include) {
      return structuredError('ENGINE_MISMATCH', filter.reason ?? 'plugin not compatible with current engine', {
        id: manifest.name,
      });
    }
    const destDir = pluginDir(ws, manifest.name);
    if (existsSync(destDir)) {
      return structuredError(
        'PLUGIN_ALREADY_INSTALLED',
        `Plugin '${manifest.name}' is already installed at ${destDir}. Uninstall first to reinstall.`,
        { id: manifest.name },
      );
    }
    // Atomic publish
    renameSync(tmp, destDir);
    succeeded = true;

    const record: InstallRecord = {
      kind: 'git',
      from,
      ref,
      installed_at: Date.now(),
    };
    writeInstallRecord(ws, manifest.name, record);

    await reloadPluginRegistry(ws);
    await fireClientSync(ws, 'plugin-install');
    return {
      content: [{ type: 'text', text: `Installed plugin ${manifest.name} from ${from}.` }],
      structuredContent: { id: manifest.name, dir: destDir, origin: record },
    };
  } finally {
    if (!succeeded && existsSync(tmp)) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Register a local folder as a plugin: validate the manifest at the user's
 * path, then junction `<global_dir>/plugins/<id>` → user's folder. The
 * user's folder is never modified beyond a best-effort `node_modules`
 * junction for hostable-tool deps.
 */
async function installFromLocalFolder(ws: Workspace, sourcePath: string): Promise<CallToolResult> {
  const absoluteSource = resolve(sourcePath);
  const manifestPath = join(absoluteSource, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) {
    return structuredError(
      'MANIFEST_MISSING',
      `.claude-plugin/plugin.json not found in ${absoluteSource}. Provide a path to a folder containing a single plugin.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return structuredError('MANIFEST_PARSE_ERROR', msg);
  }
  const validationErrs = validatePluginManifestJson(parsed);
  if (validationErrs.length > 0) return validationError(validationErrs);

  const manifest = parsed as { name: string; clawdevbox?: { tools?: unknown[] } };
  // Engines filter (spec §4.4): respect agency.json's `engines` list.
  const agency = tryReadAgencyJsonSync(absoluteSource);
  const filter = filterByEngines(agency, configuredAgentCli(ws));
  if (!filter.include) {
    return structuredError('ENGINE_MISMATCH', filter.reason ?? 'plugin not compatible with current engine', {
      id: manifest.name,
    });
  }
  const destDir = pluginDir(ws, manifest.name);
  if (existsSync(destDir)) {
    return structuredError(
      'PLUGIN_ALREADY_INSTALLED',
      `Plugin '${manifest.name}' is already installed at ${destDir}. Uninstall first to reinstall.`,
      { id: manifest.name },
    );
  }
  try {
    createPluginLink(absoluteSource, destDir);
  } catch (err) {
    return structuredError(
      'LINK_FAILED',
      `Failed to create junction at ${destDir} → ${absoluteSource}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const record: InstallRecord = {
    kind: 'local',
    from: sourcePath,
    ref: null,
    source_path: absoluteSource,
    installed_at: Date.now(),
  };
  writeInstallRecord(ws, manifest.name, record);

  // Best-effort: junction node_modules in the user's folder so any plugin
  // code (hostable tools, agent_cli providers, renderers) can resolve
  // `import 'zod'` and the rest of the host deps via Node's realpath
  // walk-up. Skipped for purely declarative plugins (skills/recipes/
  // triggers/agents only, no JS modules).
  let nodeModulesHint: string | null = null;
  const cb = manifest.clawdevbox as
    | { tools?: unknown; agent_clis?: unknown; renderers?: unknown }
    | undefined;
  const hasExecutableCode =
    (Array.isArray(cb?.tools) && cb!.tools!.length > 0) ||
    (Array.isArray(cb?.agent_clis) && cb!.agent_clis!.length > 0) ||
    (Array.isArray(cb?.renderers) && cb!.renderers!.length > 0);
  if (hasExecutableCode) {
    const host = locateHostNodeModules();
    if (host) {
      const r = ensureLocalSourceNodeModulesLink(absoluteSource, host);
      if (!r.linked && r.reason !== 'already exists') {
        nodeModulesHint =
          `Heads-up: could not junction ${join(absoluteSource, 'node_modules')} → ${host} ` +
          `(${r.reason}). Plugin code's \`import 'clawdevbox'\` may fail until node_modules is reachable from the source folder.`;
      }
    }
  }

  await reloadPluginRegistry(ws);
  await fireClientSync(ws, 'plugin-install');
  const messages = [`Installed plugin ${manifest.name} as a local-folder link → ${absoluteSource}.`];
  if (nodeModulesHint) messages.push(nodeModulesHint);
  return {
    content: [{ type: 'text', text: messages.join('\n') }],
    structuredContent: { id: manifest.name, dir: destDir, source_path: absoluteSource, origin: record },
  };
}
