/**
 * workspaces-store.ts
 *
 * Workspace registry for Clawdevbox (spec §10 — workspaces are the unit a
 * recipe runs in). A workspace is a directory with a `.clawdevbox/` tree.
 *
 * Disk layout:
 *
 *   <workspaces_root>/
 *     index.json
 *     <id>/
 *       .clawdevbox/
 *         recipes/
 *         skills/
 *         plugins/
 *         triggers.json     -> { "registered": [] }
 *         workspace.json    -> { id, name, created_at, parent_workspace_id, clawdevbox_workspaces_root }
 *         recipe-instances/
 *
 * `<workspaces_root>` defaults to `~/.clawdevbox/workspaces` and is
 * overridable via the `CLAWDEVBOX_WORKSPACES_ROOT` env var or by passing an
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

/** Default <workspaces_root> = $CLAWDEVBOX_WORKSPACES_ROOT || ~/.clawdevbox/workspaces. */
export function resolveWorkspacesRoot(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  if (override && override.length > 0) return resolve(override);
  const fromEnv = env.CLAWDEVBOX_WORKSPACES_ROOT;
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  return resolve(join(homedir(), '.clawdevbox', 'workspaces'));
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
 * Initialize the `.clawdevbox/` tree inside a workspace directory. Creates
 * recipes/, skills/, plugins/, recipe-instances/ as empty dirs and seeds
 * triggers.json and workspace.json.
 */
export function initClawdevboxTree(args: {
  workspacePath: string;
  info: WorkspaceInfo;
  workspacesRoot: string;
}): void {
  const clawdevboxDir = join(args.workspacePath, '.clawdevbox');
  // Plugins moved to the global store (<global_dir>/plugins/) — workspaces
  // no longer scaffold a per-project plugins/ dir.
  for (const sub of ['recipes', 'skills', 'recipe-instances']) {
    mkdirSync(join(clawdevboxDir, sub), { recursive: true });
  }

  const triggersPath = join(clawdevboxDir, 'triggers.json');
  if (!existsSync(triggersPath)) {
    writeFileAtomic(triggersPath, JSON.stringify({ registered: [] }, null, 2) + '\n');
  }

  const workspaceJsonPath = join(clawdevboxDir, 'workspace.json');
  const workspaceMeta = {
    id: args.info.id,
    name: args.info.name,
    created_at: args.info.created_at,
    parent_workspace_id: args.info.parent_workspace_id,
    clawdevbox_workspaces_root: args.workspacesRoot,
  };
  writeFileAtomic(workspaceJsonPath, JSON.stringify(workspaceMeta, null, 2) + '\n');
}

/**
 * @deprecated Plugins are now globally installed under `<global_dir>/plugins/`
 * and visible to every workspace automatically. This function is kept as a
 * no-op for any external caller still importing it; it always returns
 * `{ copied: [] }`.
 */
export function inheritPluginsFrom(_args: {
  sourcePluginsDir: string;
  destPluginsDir: string;
}): { copied: string[] } {
  return { copied: [] };
}

/**
 * Clone a source workspace's `.clawdevbox/` tree into the new workspace, but
 * SKIP recipe-instances/ and workspace.json (those are regenerated for the
 * new workspace). triggers.json is copied as-is so the user gets the same
 * trigger registrations.
 */
export function copyClawdevboxTreeFrom(args: {
  sourceClawdevboxDir: string;
  destClawdevboxDir: string;
}): { copied_subtrees: string[] } {
  const copied: string[] = [];
  if (!existsSync(args.sourceClawdevboxDir)) return { copied_subtrees: copied };

  let entries: string[];
  try {
    entries = readdirSync(args.sourceClawdevboxDir);
  } catch {
    return { copied_subtrees: copied };
  }

  const skipSubtrees = new Set(['recipe-instances', 'workspace.json']);
  mkdirSync(args.destClawdevboxDir, { recursive: true });

  for (const entry of entries) {
    if (skipSubtrees.has(entry)) continue;
    const src = join(args.sourceClawdevboxDir, entry);
    const dst = join(args.destClawdevboxDir, entry);
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
    const result = copyClawdevboxTreeFrom({
      sourceClawdevboxDir: join(sourceInfo.path, '.clawdevbox'),
      destClawdevboxDir: join(workspacePath, '.clawdevbox'),
    });
    copiedFromSubtrees = result.copied_subtrees;
  }

  // Always (re)create the canonical scaffolding — fills in any subdirs that
  // copy_from didn't populate, regenerates workspace.json + triggers.json if absent.
  initClawdevboxTree({
    workspacePath,
    info,
    workspacesRoot,
  });

  if (args.inherit_plugins && args.callerProjectDir) {
    // No-op since plugins moved to the global store at <global_dir>/plugins/
    // and are visible to every workspace automatically. We still set
    // `inheritedPlugins` to [] so older clients reading the structured
    // response don't crash on `undefined`.
    inheritedPlugins = [];
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

/** Best-effort counts of `.clawdevbox/` contents — used by workspace.get. */
export function countWorkspaceContents(workspacePath: string): WorkspaceCounts {
  const clawdevboxDir = join(workspacePath, '.clawdevbox');
  const safeListFilesByExt = (subdir: string, ext: string): number => {
    const p = join(clawdevboxDir, subdir);
    if (!existsSync(p)) return 0;
    try {
      return readdirSync(p).filter((e) => e.toLowerCase().endsWith(ext)).length;
    } catch {
      return 0;
    }
  };

  let registeredTriggers = 0;
  const triggersPath = join(clawdevboxDir, 'triggers.json');
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
    // Plugins are global now (see <global_dir>/plugins/); this field is
    // always 0 and kept for response-shape stability with older clients.
    plugins: 0,
    recipes: safeListFilesByExt('recipes', '.yaml') + safeListFilesByExt('recipes', '.yml'),
    skills: safeListFilesByExt('skills', '.md'),
    registered_triggers: registeredTriggers,
  };
}
