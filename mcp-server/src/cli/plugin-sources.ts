/**
 * cli/plugin-sources.ts
 *
 * Helpers for `clawdevbox init --plugin <src>`. A `<src>` is either an
 * absolute local folder path or a git URL (https/ssh, with or without
 * `git+` prefix). We clone/copy each source into a scan directory,
 * discover the plugins it contains (single plugin at the root or a
 * collection under subdirs), and let init install whichever the user
 * picks.
 *
 *   resolvePluginSource()  — clone (full, keeping `.git`) or use the
 *                            user's folder in place; the caller cleans
 *                            up temp clones via `cleanup()` once it has
 *                            either committed or rejected the install.
 *   discoverPluginsInDir() — scan a resolved directory for valid
 *                            `.claude-plugin/plugin.json` manifests (root OR subdirs).
 *   installPluginFromDir() — install a single discovered plugin into the
 *                            global plugin store. For a single-plugin git
 *                            clone, the entire temp clone is *moved* in
 *                            (preserving `.git` for `plugin.update`). For
 *                            a collection's subdir, the subdir is copied
 *                            (no `.git`, marked non-updatable). For a
 *                            local folder, a junction is created — never
 *                            a copy.
 *
 * Failures are surfaced as exceptions; init.ts catches and presents
 * them to the user. The git path shells out to the user's `git`
 * binary (no extra dependency).
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { validatePluginManifestJson } from '../validators.ts';
import { loadMarketplace, LoadMarketplaceError } from '../manifest/load-marketplace.ts';
import type { MarketplaceSourceObject } from '../manifest/types.ts';

export interface DiscoveredPlugin {
  /** Manifest id (`[a-z][a-z0-9-]*`). */
  id: string;
  /** Manifest name (human label). */
  name: string;
  /** Manifest version. */
  version: string;
  /** Manifest description (one line). */
  description: string;
  /** Required env vars declared under `requires.env`, if any. */
  required_env: string[];
  /** Absolute path to the plugin directory (containing .claude-plugin/plugin.json). */
  dir: string;
}

export interface ResolvedSource {
  /** Display label for `init` summary lines (`<original> → <local-dir>`). */
  origin: string;
  /** Absolute path to the local directory we should scan. */
  dir: string;
  /** Whether the source was a git clone (cleanup deletes the clone). */
  isGitClone: boolean;
  /**
   * Whether the source was the user's own absolute folder (no clone, no
   * copy — install will junction the user's folder into the global store).
   */
  isLocalFolder: boolean;
  /** Cleanup function — best-effort removal of any temp directory. */
  cleanup(): void;
}

/**
 * Decide whether a raw `--plugin` argument should be treated as a git
 * URL. Conservative: anything with a recognized git/url scheme. Local
 * absolute paths are left for the path branch.
 */
export function isGitSource(raw: string): boolean {
  if (raw.startsWith('git+')) return true;
  if (raw.startsWith('git@')) return true;
  if (/^https?:\/\//.test(raw)) return true;
  if (/^ssh:\/\//.test(raw)) return true;
  return false;
}

/**
 * Clone / use a `--plugin` source. Two paths:
 *
 * Git: full `git clone` (no `--depth 1`) into a temp dir. We **keep**
 *      `.git/` so a single-plugin install can simply `renameSync` the
 *      temp clone into `<globalDir>/plugins/<id>/` and `plugin.update`
 *      can later fetch+reset. Collection installs (subdir picked) lose
 *      `.git` during the copy and are marked non-updatable.
 *
 * Local: must be an existing absolute directory. Returned as-is — no
 *        copy, no cleanup. The user's folder is the source of truth;
 *        install creates a junction into the global store.
 */
export function resolvePluginSource(raw: string): ResolvedSource {
  if (isGitSource(raw)) {
    const gitUrl = raw.startsWith('git+') ? raw.slice('git+'.length) : raw;
    const tmpDir = mkdtempSync(join(tmpdir(), 'clawdevbox-plugin-src-'));
    const cloneArgs = ['clone', gitUrl, tmpDir];
    const result = spawnSync('git', cloneArgs, { stdio: 'pipe', encoding: 'utf8' });
    if (result.status !== 0) {
      rmSync(tmpDir, { recursive: true, force: true });
      const stderr = (result.stderr ?? '').trim();
      const stdout = (result.stdout ?? '').trim();
      const reason = stderr || stdout || `exit ${result.status}`;
      throw new Error(`git clone failed for ${raw}: ${reason}`);
    }
    return {
      origin: raw,
      dir: tmpDir,
      isGitClone: true,
      isLocalFolder: false,
      cleanup() {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      },
    };
  }

  if (!isAbsolute(raw)) {
    throw new Error(
      `--plugin source must be an absolute folder path or a git URL (got: ${raw})`,
    );
  }
  const resolved = resolve(raw);
  if (!existsSync(resolved)) {
    throw new Error(`--plugin source does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`--plugin source is not a directory: ${resolved}`);
  }
  return {
    origin: raw,
    dir: resolved,
    isGitClone: false,
    isLocalFolder: true,
    cleanup() {
      /* nothing to clean for local sources */
    },
  };
}

/**
 * Discover plugins under `dir`, marketplace-aware (spec §4.1).
 *
 * Resolution order:
 *   1. `loadMarketplace(dir)` — handles `.claude-plugin/marketplace.json`,
 *      `.github/plugin/marketplace.json`, and `.claude-plugin/plugin.json`
 *      (single-plugin). For multi-plugin catalogs, each entry whose source
 *      resolves to a local directory under `dir` is included.
 *   2. Fallback recursive scan for `<subdir>/.claude-plugin/plugin.json`
 *      when no catalog is present (legacy layout).
 *
 * Returns every plugin we can validate. Sub-directories with a plugin
 * manifest that fails validation are surfaced as part of `errors` (init
 * prints these so the user knows what was skipped); they do NOT count as
 * discovered.
 */
export function discoverPluginsInDir(dir: string): {
  plugins: DiscoveredPlugin[];
  errors: Array<{ dir: string; message: string }>;
  isSinglePluginAtRoot: boolean;
} {
  const plugins: DiscoveredPlugin[] = [];
  const errors: Array<{ dir: string; message: string }> = [];

  // --- 1. Try the marketplace consumer first ---------------------------------
  // loadMarketplace is async; init() is already async so the caller can await
  // a Promise — but the existing signature is sync. Use a tiny synchronous
  // shim: catalogs and agency.json are JSON files; do the same work inline.
  const claudeCatalog = join(dir, '.claude-plugin', 'marketplace.json');
  const ghcCatalog = join(dir, '.github', 'plugin', 'marketplace.json');
  const singlePlugin = join(dir, '.claude-plugin', 'plugin.json');

  if (existsSync(claudeCatalog) || existsSync(ghcCatalog)) {
    const catalogPath = existsSync(claudeCatalog) ? claudeCatalog : ghcCatalog;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(catalogPath, 'utf8'));
    } catch (err) {
      errors.push({
        dir: catalogPath,
        message: `failed to parse marketplace catalog: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { plugins, errors, isSinglePluginAtRoot: false };
    }
    const entries = (parsed as { plugins?: unknown[] }).plugins ?? [];
    if (!Array.isArray(entries)) {
      errors.push({ dir: catalogPath, message: 'marketplace catalog `plugins` is not an array' });
      return { plugins, errors, isSinglePluginAtRoot: false };
    }
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as {
        name?: unknown;
        source?: unknown;
        description?: unknown;
        version?: unknown;
      };
      if (typeof e.name !== 'string') continue;
      const localDir = resolveCatalogEntryDir(e.source, dir);
      if (!localDir || !existsSync(localDir)) {
        // Remote source — init can't install without cloning each entry,
        // so we surface them as errors (skipped) for visibility.
        errors.push({
          dir,
          message: `marketplace entry '${e.name}' has a non-local source; remote-source installs are not yet supported by --plugin (skipped)`,
        });
        continue;
      }
      // Read the underlying plugin manifest to fill required_env etc.
      const manifestPath = join(localDir, '.claude-plugin', 'plugin.json');
      if (existsSync(manifestPath)) {
        const result = readManifest(localDir);
        if (result.ok) {
          plugins.push(result.plugin);
        } else {
          errors.push({ dir: localDir, message: result.message });
        }
      } else {
        // Catalog entry but no .claude-plugin/plugin.json — fall back to the
        // catalog's own metadata.
        plugins.push({
          id: e.name,
          name: e.name,
          version: typeof e.version === 'string' ? e.version : '0.0.0',
          description: typeof e.description === 'string' ? e.description : '',
          required_env: [],
          dir: localDir,
        });
      }
    }
    return { plugins, errors, isSinglePluginAtRoot: false };
  }

  // --- 2. Single-plugin layout (no catalog, plugin.json at root) -------------
  if (existsSync(singlePlugin)) {
    const result = readManifest(dir);
    if (result.ok) plugins.push(result.plugin);
    else errors.push({ dir, message: result.message });
    return { plugins, errors, isSinglePluginAtRoot: true };
  }

  // --- 3. Legacy fallback: recursive scan for subdir plugin manifests --------
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIR.has(entry.name)) continue;
    if (entry.name.startsWith('_legacy')) continue;
    const subDir = join(dir, entry.name);
    if (!existsSync(join(subDir, '.claude-plugin', 'plugin.json'))) continue;
    const result = readManifest(subDir);
    if (result.ok) plugins.push(result.plugin);
    else errors.push({ dir: subDir, message: result.message });
  }
  return { plugins, errors, isSinglePluginAtRoot: false };
}

/**
 * Resolve a marketplace entry's `source` field to a local directory under
 * the marketplace root, or `null` for remote sources.
 */
function resolveCatalogEntryDir(source: unknown, marketplaceRoot: string): string | null {
  if (typeof source === 'string') {
    if (isRemoteSource(source)) return null;
    if (isAbsolute(source)) return resolve(source);
    return resolve(marketplaceRoot, source);
  }
  if (source && typeof source === 'object') {
    const s = source as MarketplaceSourceObject;
    if (s.source === 'path' && typeof s.path === 'string') {
      return isAbsolute(s.path) ? resolve(s.path) : resolve(marketplaceRoot, s.path);
    }
  }
  return null;
}

function isRemoteSource(s: string): boolean {
  if (s.startsWith('git+')) return true;
  if (s.startsWith('git@')) return true;
  if (/^https?:\/\//.test(s)) return true;
  if (/^ssh:\/\//.test(s)) return true;
  return false;
}

// Suppress unused-import warnings — these are kept for forward use (Phase 5
// wiring of remote-source installs and richer marketplace metadata in init).
void loadMarketplace;
void LoadMarketplaceError;

const SKIP_DIR = new Set(['.git', '.github', 'node_modules', '.vscode', '.idea']);

function readManifest(
  dir: string,
):
  | { ok: true; plugin: DiscoveredPlugin }
  | { ok: false; message: string } {
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, message: `failed to parse .claude-plugin/plugin.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  const errors = validatePluginManifestJson(parsed);
  if (errors.length > 0) {
    const summary = errors
      .slice(0, 3)
      .map((e) => `${e.path}: ${e.message}`)
      .join('; ');
    return { ok: false, message: `invalid manifest: ${summary}` };
  }
  const m = parsed as Record<string, unknown>;
  const requiresRaw = m.requires as { env?: unknown } | undefined;
  const required_env: string[] = Array.isArray(requiresRaw?.env)
    ? (requiresRaw!.env as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return {
    ok: true,
    plugin: {
      id: m.name as string,
      name: (m.name as string),
      version: (m.version as string) ?? '0.0.0',
      description: (m.description as string) ?? '',
      required_env,
      dir,
    },
  };
}

/** Sidecar install-record schema. Mirrors `tools/plugin.ts::InstallRecord`. */
interface InstallRecord {
  kind: 'git' | 'local' | 'builtin' | 'manual';
  from: string;
  ref: string | null;
  source_path?: string;
  installed_at: number;
}

/**
 * Install a single discovered plugin into the global plugin store.
 *
 * Behavior by source mode:
 *
 * - **Local folder** (`source.isLocalFolder`): create a junction
 *   (Windows) / symlink (POSIX) at `<globalDir>/plugins/<id>` →
 *   `plugin.dir`. The user's folder is never modified. The sidecar
 *   install record records `kind: "local"`.
 *
 * - **Single-plugin git clone** (`source.isGitClone` &&
 *   `isSinglePluginAtRoot`): the temp clone IS the plugin (the `plugin.dir`
 *   equals the clone root). The whole clone (with `.git`) is `renameSync`'d
 *   into `<globalDir>/plugins/<id>`. The sidecar records `kind: "git"`.
 *
 * - **Collection git clone subdir picked**: a sub-folder of the clone
 *   is `cpSync`'d (filtering `node_modules`, `_legacy*`, `.git`) into a
 *   temp dir under the global plugins root, then atomically renamed.
 *   The sidecar records `kind: "manual"` so `plugin.update` errors with
 *   "reinstall to refresh" — there is no recoverable git history bound to
 *   a single plugin in a collection clone.
 *
 * Idempotent: if `<globalDir>/plugins/<id>` already exists, the call
 * leaves it alone and reports `copied: false`.
 */
export function installPluginFromDir(args: {
  globalDir: string;
  plugin: DiscoveredPlugin;
  origin: string;
  /** Pass the resolved source so install knows whether to junction / move / copy. */
  source: ResolvedSource;
  /** Optional git ref recorded alongside the origin (single-plugin git only). */
  ref?: string | null;
}): { destination: string; copied: boolean; kind: InstallRecord['kind'] } {
  const pluginsRoot = join(args.globalDir, 'plugins');
  mkdirSync(pluginsRoot, { recursive: true });
  const destination = join(pluginsRoot, args.plugin.id);
  if (existsSync(destination)) {
    return { destination, copied: false, kind: detectExistingKind(pluginsRoot, args.plugin.id) };
  }

  let kind: InstallRecord['kind'];
  const record: InstallRecord = {
    kind: 'manual',
    from: args.origin,
    ref: args.ref ?? null,
    installed_at: Date.now(),
  };

  if (args.source.isLocalFolder) {
    const target = args.plugin.dir;
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(target, destination, linkType);
    kind = 'local';
    record.kind = 'local';
    record.source_path = target;
    record.from = target;
  } else if (
    args.source.isGitClone &&
    isSinglePluginRoot(args.source.dir, args.plugin.dir)
  ) {
    // Move the entire clone (including `.git`) into place. Atomic via
    // renameSync on the same volume; cross-volume moves are unlikely
    // because both temp dir and global dir typically share the user's
    // home volume.
    renameSync(args.source.dir, destination);
    kind = 'git';
    record.kind = 'git';
  } else {
    // Collection subdir or non-git source where the picked plugin dir
    // is not the whole clone: copy without `.git`, atomic rename.
    const tmp = mkdtempSync(join(pluginsRoot, '.tmp-install-'));
    try {
      cpSync(args.plugin.dir, tmp, {
        recursive: true,
        filter: (src) =>
          !src.split(sep).includes('node_modules') &&
          !/[/\\]_legacy/.test(src) &&
          !src.endsWith(`${sep}.git`) &&
          !src.includes(`${sep}.git${sep}`),
      });
      renameSync(tmp, destination);
    } catch (err) {
      if (existsSync(tmp)) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
    kind = 'manual';
    record.kind = 'manual';
  }

  writeFileSync(
    join(pluginsRoot, `${args.plugin.id}.install.json`),
    JSON.stringify(record, null, 2) + '\n',
    'utf8',
  );
  return { destination, copied: true, kind };
}

/**
 * Determine if the discovered plugin lives at the root of its source —
 * meaning the entire (temp) clone IS the plugin and can be moved
 * wholesale into the global store while preserving `.git`.
 */
function isSinglePluginRoot(sourceDir: string, pluginDir: string): boolean {
  return resolve(sourceDir) === resolve(pluginDir);
}

/**
 * Best-effort kind detection for the idempotent path. Reads an existing
 * sidecar record if present; defaults to "manual" so callers don't crash.
 */
function detectExistingKind(pluginsRoot: string, id: string): InstallRecord['kind'] {
  const sidecar = join(pluginsRoot, `${id}.install.json`);
  if (!existsSync(sidecar)) return 'manual';
  try {
    const parsed = JSON.parse(readFileSync(sidecar, 'utf8')) as Partial<InstallRecord>;
    if (
      parsed.kind === 'git' ||
      parsed.kind === 'local' ||
      parsed.kind === 'builtin' ||
      parsed.kind === 'manual'
    ) {
      return parsed.kind;
    }
  } catch {
    /* fall through */
  }
  return 'manual';
}
