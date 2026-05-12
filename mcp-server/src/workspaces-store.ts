/**
 * workspaces-store.ts
 *
 * Workspace registry for Conductor (spec §10 — workspaces are the unit a
 * recipe runs in). A workspace is a directory with a `.conductor/` tree.
 *
 * Disk layout:
 *
 *   <workspaces_root>/
 *     index.json
 *     <id>/
 *       .conductor/
 *         recipes/
 *         skills/
 *         plugins/
 *         triggers.json     -> { "registered": [] }
 *         workspace.json    -> { id, name, created_at, parent_workspace_id, conductor_workspaces_root }
 *         recipe-instances/
 *
 * `<workspaces_root>` defaults to `~/.conductor/workspaces` and is
 * overridable via the `CONDUCTOR_WORKSPACES_ROOT` env var or by passing an
 * explicit `base_path` to `createWorkspace`.
 *
 * The registry at `<workspaces_root>/index.json` is the source of truth for
 * which workspaces exist. Atomic writes (tempfile + rename) via fs-util.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string | null;
  created_at: number;
  parent_workspace_id: string | null;
}

interface WorkspaceIndexFile {
  workspaces: Record<string, WorkspaceInfo>;
}

// ============================================================================
// Root resolution
// ============================================================================

/** Default <workspaces_root> = $CONDUCTOR_WORKSPACES_ROOT || ~/.conductor/workspaces. */
export function resolveWorkspacesRoot(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  if (override && override.length > 0) return resolve(override);
  const fromEnv = env.CONDUCTOR_WORKSPACES_ROOT;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  return resolve(join(homedir(), '.conductor', 'workspaces'));
}

// ============================================================================
// Id minting
// ============================================================================

/**
 * Mint a workspace id of the form `ws_<base36-ts>_<4hex>`. Time-prefix keeps
 * ids roughly chronological in directory listings; the random suffix avoids
 * collisions when two `workspace.create` calls land in the same millisecond.
 */
export function mintWorkspaceId(now: number = Date.now()): string {
  const ts = now.toString(36);
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `ws_${ts}_${rand}`;
}

// ============================================================================
// Index (registry) read / write
// ============================================================================

export function indexPath(workspacesRoot: string): string {
  return join(workspacesRoot, 'index.json');
}

export function readIndex(workspacesRoot: string): WorkspaceIndexFile {
  const p = indexPath(workspacesRoot);
  if (!existsSync(p)) return { workspaces: {} };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkspaceIndexFile>;
    if (parsed.workspaces && typeof parsed.workspaces === 'object') {
      return { workspaces: parsed.workspaces as Record<string, WorkspaceInfo> };
    }
  } catch {
    // Corrupted index — fall through and return empty so the server can recover.
  }
  return { workspaces: {} };
}

export function writeIndex(workspacesRoot: string, file: WorkspaceIndexFile): void {
  mkdirSync(workspacesRoot, { recursive: true });
  writeFileAtomic(indexPath(workspacesRoot), JSON.stringify(file, null, 2) + '\n');
}

export function listWorkspaces(workspacesRoot: string): WorkspaceInfo[] {
  const idx = readIndex(workspacesRoot);
  return Object.values(idx.workspaces).sort((a, b) => a.created_at - b.created_at);
}

export function getWorkspace(workspacesRoot: string, id: string): WorkspaceInfo | null {
  const idx = readIndex(workspacesRoot);
  return idx.workspaces[id] ?? null;
}

/** Look up a workspace by its directory path (used by workspace.current). */
export function findWorkspaceByPath(
  workspacesRoot: string,
  dirPath: string,
): WorkspaceInfo | null {
  const target = resolve(dirPath);
  const idx = readIndex(workspacesRoot);
  for (const ws of Object.values(idx.workspaces)) {
    if (resolve(ws.path) === target) return ws;
  }
  return null;
}

// ============================================================================
// Filesystem scaffolding
// ============================================================================

/**
 * Initialize the `.conductor/` tree inside a workspace directory. Creates
 * recipes/, skills/, plugins/, recipe-instances/ as empty dirs and seeds
 * triggers.json and workspace.json.
 */
export function initConductorTree(args: {
  workspacePath: string;
  info: WorkspaceInfo;
  workspacesRoot: string;
}): void {
  const conductorDir = join(args.workspacePath, '.conductor');
  for (const sub of ['recipes', 'skills', 'plugins', 'recipe-instances']) {
    mkdirSync(join(conductorDir, sub), { recursive: true });
  }

  const triggersPath = join(conductorDir, 'triggers.json');
  if (!existsSync(triggersPath)) {
    writeFileAtomic(triggersPath, JSON.stringify({ registered: [] }, null, 2) + '\n');
  }

  const workspaceJsonPath = join(conductorDir, 'workspace.json');
  const workspaceMeta = {
    id: args.info.id,
    name: args.info.name,
    created_at: args.info.created_at,
    parent_workspace_id: args.info.parent_workspace_id,
    conductor_workspaces_root: args.workspacesRoot,
  };
  writeFileAtomic(workspaceJsonPath, JSON.stringify(workspaceMeta, null, 2) + '\n');
}

/**
 * Copy a calling workspace's plugins/ tree into the new workspace, skipping
 * node_modules and the legacy mcp-server dir. Used when `inherit_plugins: true`
 * is passed to `workspace.create`.
 */
export function inheritPluginsFrom(args: {
  sourcePluginsDir: string;
  destPluginsDir: string;
}): { copied: string[] } {
  const copied: string[] = [];
  if (!existsSync(args.sourcePluginsDir)) return { copied };
  let entries: string[];
  try {
    entries = readdirSync(args.sourcePluginsDir);
  } catch {
    return { copied };
  }
  mkdirSync(args.destPluginsDir, { recursive: true });
  for (const entry of entries) {
    const src = join(args.sourcePluginsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const dst = join(args.destPluginsDir, entry);
    cpSync(src, dst, {
      recursive: true,
      filter: (s) =>
        !s.includes(`${'node_modules'}`) &&
        !s.includes('_legacy-mcp-server'),
    });
    copied.push(entry);
  }
  return { copied };
}

/**
 * Clone a source workspace's `.conductor/` tree into the new workspace, but
 * SKIP recipe-instances/ and workspace.json (those are regenerated for the
 * new workspace). triggers.json is copied as-is so the user gets the same
 * trigger registrations.
 */
export function copyConductorTreeFrom(args: {
  sourceConductorDir: string;
  destConductorDir: string;
}): { copied_subtrees: string[] } {
  const copied: string[] = [];
  if (!existsSync(args.sourceConductorDir)) return { copied_subtrees: copied };

  let entries: string[];
  try {
    entries = readdirSync(args.sourceConductorDir);
  } catch {
    return { copied_subtrees: copied };
  }

  const skipSubtrees = new Set(['recipe-instances', 'workspace.json']);
  mkdirSync(args.destConductorDir, { recursive: true });

  for (const entry of entries) {
    if (skipSubtrees.has(entry)) continue;
    const src = join(args.sourceConductorDir, entry);
    const dst = join(args.destConductorDir, entry);
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      cpSync(src, dst, {
        recursive: true,
        filter: (s) =>
          !s.includes(`${'node_modules'}`) &&
          !s.includes('_legacy-mcp-server'),
      });
    } else {
      cpSync(src, dst);
    }
    copied.push(entry);
  }
  return { copied_subtrees: copied };
}

// ============================================================================
// Create
// ============================================================================

export interface CreateWorkspaceArgs {
  name?: string;
  parent_workspace_id?: string;
  base_path?: string;
  inherit_plugins?: boolean;
  copy_from?: string;
  /** The calling workspace's project_dir, used to source plugins when inherit_plugins=true. */
  callerProjectDir?: string;
  /** Override the workspaces root resolution (used by tests). */
  workspacesRootOverride?: string;
}

export interface CreatedWorkspace {
  info: WorkspaceInfo;
  workspacesRoot: string;
  inheritedPlugins?: string[];
  copiedFromSubtrees?: string[];
}

export class WorkspaceConflictError extends Error {
  readonly code = 'WORKSPACE_PATH_EXISTS';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceConflictError';
  }
}

export class WorkspaceNotFoundError extends Error {
  readonly code = 'WORKSPACE_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNotFoundError';
  }
}

export function createWorkspace(args: CreateWorkspaceArgs): CreatedWorkspace {
  const workspacesRoot = resolveWorkspacesRoot(process.env, args.workspacesRootOverride);
  const id = mintWorkspaceId();

  // Resolve where the workspace dir lives. `base_path`, if provided, is treated
  // as the parent dir (the workspace dir becomes `<base_path>/<id>`). Otherwise
  // it goes under `<workspaces_root>/<id>`.
  const parentDir = args.base_path ? resolve(args.base_path) : workspacesRoot;
  const workspacePath = join(parentDir, id);

  if (existsSync(workspacePath)) {
    throw new WorkspaceConflictError(
      `Workspace path already exists: ${workspacePath}`,
    );
  }

  if (args.inherit_plugins && args.copy_from) {
    throw new Error('inherit_plugins and copy_from are mutually exclusive.');
  }

  mkdirSync(workspacePath, { recursive: true });

  const info: WorkspaceInfo = {
    id,
    path: resolve(workspacePath),
    name: args.name ?? null,
    created_at: Date.now(),
    parent_workspace_id: args.parent_workspace_id ?? null,
  };

  let inheritedPlugins: string[] | undefined;
  let copiedFromSubtrees: string[] | undefined;

  if (args.copy_from) {
    const sourceInfo = getWorkspace(workspacesRoot, args.copy_from);
    if (!sourceInfo) {
      throw new WorkspaceNotFoundError(
        `copy_from workspace ${JSON.stringify(args.copy_from)} not found in registry.`,
      );
    }
    const result = copyConductorTreeFrom({
      sourceConductorDir: join(sourceInfo.path, '.conductor'),
      destConductorDir: join(workspacePath, '.conductor'),
    });
    copiedFromSubtrees = result.copied_subtrees;
  }

  // Always (re)create the canonical scaffolding — fills in any subdirs that
  // copy_from didn't populate, regenerates workspace.json + triggers.json if absent.
  initConductorTree({
    workspacePath,
    info,
    workspacesRoot,
  });

  if (args.inherit_plugins && args.callerProjectDir) {
    const sourcePluginsDir = join(args.callerProjectDir, '.conductor', 'plugins');
    const destPluginsDir = join(workspacePath, '.conductor', 'plugins');
    const result = inheritPluginsFrom({ sourcePluginsDir, destPluginsDir });
    inheritedPlugins = result.copied;
  }

  // Register in the index.
  const idx = readIndex(workspacesRoot);
  idx.workspaces[id] = info;
  writeIndex(workspacesRoot, idx);

  return { info, workspacesRoot, inheritedPlugins, copiedFromSubtrees };
}

// ============================================================================
// Counts (used by workspace.get)
// ============================================================================

export interface WorkspaceCounts {
  plugins: number;
  recipes: number;
  skills: number;
  registered_triggers: number;
}

/** Best-effort counts of `.conductor/` contents — used by workspace.get. */
export function countWorkspaceContents(workspacePath: string): WorkspaceCounts {
  const conductorDir = join(workspacePath, '.conductor');
  const safeListDirs = (subdir: string): number => {
    const p = join(conductorDir, subdir);
    if (!existsSync(p)) return 0;
    try {
      const entries = readdirSync(p);
      return entries.filter((e) => {
        try {
          return statSync(join(p, e)).isDirectory();
        } catch {
          return false;
        }
      }).length;
    } catch {
      return 0;
    }
  };
  const safeListFilesByExt = (subdir: string, ext: string): number => {
    const p = join(conductorDir, subdir);
    if (!existsSync(p)) return 0;
    try {
      return readdirSync(p).filter((e) => e.toLowerCase().endsWith(ext)).length;
    } catch {
      return 0;
    }
  };

  let registeredTriggers = 0;
  const triggersPath = join(conductorDir, 'triggers.json');
  if (existsSync(triggersPath)) {
    try {
      const parsed = JSON.parse(readFileSync(triggersPath, 'utf8')) as {
        registered?: unknown[];
      };
      if (Array.isArray(parsed.registered)) registeredTriggers = parsed.registered.length;
    } catch {
      registeredTriggers = 0;
    }
  }

  return {
    plugins: safeListDirs('plugins'),
    recipes: safeListFilesByExt('recipes', '.yaml') + safeListFilesByExt('recipes', '.yml'),
    skills: safeListFilesByExt('skills', '.md'),
    registered_triggers: registeredTriggers,
  };
}
