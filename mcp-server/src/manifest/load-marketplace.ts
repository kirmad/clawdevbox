/**
 * manifest/load-marketplace.ts
 *
 * Marketplace consumer (spec §4). Reads a marketplace catalog from one of
 * the supported layouts and returns a normalized `ResolvedMarketplace`:
 *
 *   1. `<root>/.claude-plugin/marketplace.json`   → source='claude'
 *   2. `<root>/.github/plugin/marketplace.json`   → source='github-copilot'
 *   3. `<root>/.claude-plugin/plugin.json`        → source='single-plugin'
 *
 * If `<root>/marketplace-config.json` exists it is deep-merged over the
 * catalog's top-level metadata: first `shared.{name, metadata, owner}`,
 * then the `clawdevbox` slot (if any). A malformed
 * `marketplace-config.json` is logged but does not block the load — we
 * fall through to the marketplace.json metadata.
 *
 * Per-plugin `agency.json` sidecars are loaded best-effort when the
 * resolved source maps to a directory under `<root>` (relative path or
 * object-form `{ source: 'path', path: './…' }`). The agency.json's
 * `engines` filter is applied later by `filterByEngines` (see below);
 * its `category` is folded into the resolved entry's `category` only
 * when the marketplace entry didn't already set one.
 *
 * No git/network access. The caller is responsible for cloning a remote
 * marketplace into a local directory before invoking `loadMarketplace`.
 */

import { promises as fsp } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  validateMarketplaceJson,
  validateMarketplaceConfig,
  validateAgencyJson,
  validatePluginManifestJson,
  type ValidationError,
} from '../validators.ts';
import type {
  MarketplaceJson,
  MarketplaceConfig,
  MarketplacePluginEntry,
  MarketplaceSourceObject,
  MarketplaceOwner,
  AgencyJson,
  PluginAuthor,
  PluginStatus,
  PluginManifest,
} from './types.ts';

// ============================================================================
// Public types
// ============================================================================

export type MarketplaceSource = 'claude' | 'github-copilot' | 'single-plugin';

export interface ResolvedMarketplacePluginEntry {
  name: string;
  source: string | MarketplaceSourceObject;
  description?: string;
  version?: string;
  author?: PluginAuthor;
  keywords?: string[];
  category?: string;
  strict?: boolean;
  tags?: string[];
  status?: PluginStatus;
  agencyJson?: AgencyJson;
}

export interface ResolvedMarketplaceMetadata {
  name: string;
  description?: string;
  version?: string;
  owner?: MarketplaceOwner;
}

export interface ResolvedMarketplace {
  marketplaceId: string;
  metadata: ResolvedMarketplaceMetadata;
  plugins: ResolvedMarketplacePluginEntry[];
  source: MarketplaceSource;
  rootDir: string;
  /** Best-effort load notes (malformed sidecars, etc.). Never blocks load. */
  warnings: string[];
}

export type LoadMarketplaceErrorCode =
  | 'NOT_A_MARKETPLACE'
  | 'INVALID_MARKETPLACE_JSON'
  | 'INVALID_SINGLE_PLUGIN_MANIFEST';

export class LoadMarketplaceError extends Error {
  readonly code: LoadMarketplaceErrorCode;
  readonly validationErrors?: ValidationError[];
  readonly path?: string;
  constructor(
    code: LoadMarketplaceErrorCode,
    message: string,
    opts?: { validationErrors?: ValidationError[]; path?: string },
  ) {
    super(message);
    this.name = 'LoadMarketplaceError';
    this.code = code;
    this.validationErrors = opts?.validationErrors;
    this.path = opts?.path;
  }
}

// ============================================================================
// Entry point
// ============================================================================

export async function loadMarketplace(root: string): Promise<ResolvedMarketplace> {
  const absRoot = resolve(root);
  const warnings: string[] = [];

  const claudePath = join(absRoot, '.claude-plugin', 'marketplace.json');
  const ghcPath = join(absRoot, '.github', 'plugin', 'marketplace.json');
  const singlePluginPath = join(absRoot, '.claude-plugin', 'plugin.json');

  let mp: MarketplaceJson | null = null;
  let source: MarketplaceSource;
  let catalogPath: string;

  if (existsSync(claudePath)) {
    mp = await readAndValidateMarketplaceJson(claudePath);
    source = 'claude';
    catalogPath = claudePath;
  } else if (existsSync(ghcPath)) {
    mp = await readAndValidateMarketplaceJson(ghcPath);
    source = 'github-copilot';
    catalogPath = ghcPath;
  } else if (existsSync(singlePluginPath)) {
    return loadSinglePlugin(absRoot, singlePluginPath, warnings);
  } else {
    throw new LoadMarketplaceError(
      'NOT_A_MARKETPLACE',
      `no marketplace catalog or plugin manifest found under ${absRoot} (looked for .claude-plugin/marketplace.json, .github/plugin/marketplace.json, .claude-plugin/plugin.json)`,
      { path: absRoot },
    );
  }

  // Marker so the catalogPath isn't reported as unused on type-check builds.
  void catalogPath;

  // ---- metadata + marketplace-config.json overlay --------------------------
  let metadata: ResolvedMarketplaceMetadata = {
    name: mp.name,
    description: mp.metadata?.description ?? mp.description,
    version: mp.metadata?.version ?? mp.version,
    owner: mp.owner,
  };

  const configPath = join(absRoot, 'marketplace-config.json');
  if (existsSync(configPath)) {
    try {
      const text = await fsp.readFile(configPath, 'utf8');
      const parsed = JSON.parse(text);
      const errs = validateMarketplaceConfig(parsed);
      if (errs.length > 0) {
        warnings.push(
          `marketplace-config.json invalid; falling back to marketplace.json metadata: ${formatErrors(errs)}`,
        );
      } else {
        const cfg = parsed as MarketplaceConfig;
        // 1. shared.{name, metadata, owner} on top of marketplace.json
        metadata = mergeMetadata(metadata, {
          name: cfg.shared.name,
          description: cfg.shared.metadata?.description,
          version: cfg.shared.metadata?.version,
          owner: cfg.shared.owner,
        });
        // 2. clawdevbox slot on top of (1)
        if (cfg.clawdevbox && typeof cfg.clawdevbox === 'object') {
          const cdb = cfg.clawdevbox as {
            name?: string;
            metadata?: { description?: string; version?: string };
            owner?: MarketplaceOwner;
          };
          metadata = mergeMetadata(metadata, {
            name: cdb.name,
            description: cdb.metadata?.description,
            version: cdb.metadata?.version,
            owner: cdb.owner,
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(
        `marketplace-config.json read/parse failed; falling back to marketplace.json metadata: ${msg}`,
      );
    }
  }

  // ---- per-plugin agency.json ---------------------------------------------
  const plugins: ResolvedMarketplacePluginEntry[] = [];
  for (const entry of mp.plugins) {
    const resolved = await resolvePluginEntry(entry, absRoot, warnings);
    plugins.push(resolved);
  }

  return {
    marketplaceId: metadata.name,
    metadata,
    plugins,
    source,
    rootDir: absRoot,
    warnings,
  };
}

// ============================================================================
// Engines filter (spec §4.4 + §4.5)
// ============================================================================

/**
 * Determine whether a plugin is compatible with the current clawdevbox
 * install. The configured engine id is the agent-CLI provider id
 * (e.g. `'copilot'`, `'claude'`, `'agency'`) or `null` when no provider
 * has been configured yet. `'clawdevbox'` and `'*'` always match.
 *
 * Missing `agency.json` or missing `engines` → no filter (always include).
 * Empty `engines: []` → explicit opt-out for every engine.
 */
export function filterByEngines(
  agencyJson: AgencyJson | undefined,
  configuredAgentCli: string | null,
): { include: boolean; reason?: string } {
  if (!agencyJson || agencyJson.engines === undefined) return { include: true };
  const engines = agencyJson.engines;
  if (engines.length === 0) {
    return { include: false, reason: 'plugin explicitly disabled (engines: [])' };
  }
  if (engines.includes('*')) return { include: true };
  if (engines.includes('clawdevbox')) return { include: true };
  if (configuredAgentCli && engines.includes(configuredAgentCli)) return { include: true };
  const current = configuredAgentCli ?? 'copilot';
  return {
    include: false,
    reason: `plugin targets engines [${engines.join(', ')}], not compatible with current ${current}`,
  };
}

// ============================================================================
// Internals
// ============================================================================

async function readAndValidateMarketplaceJson(path: string): Promise<MarketplaceJson> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadMarketplaceError('INVALID_MARKETPLACE_JSON', `failed to read ${path}: ${msg}`, {
      path,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadMarketplaceError(
      'INVALID_MARKETPLACE_JSON',
      `failed to parse ${path}: ${msg}`,
      { path },
    );
  }
  const errs = validateMarketplaceJson(parsed);
  if (errs.length > 0) {
    throw new LoadMarketplaceError(
      'INVALID_MARKETPLACE_JSON',
      `marketplace.json failed validation: ${formatErrors(errs)}`,
      { validationErrors: errs, path },
    );
  }
  return parsed as MarketplaceJson;
}

async function loadSinglePlugin(
  absRoot: string,
  manifestPath: string,
  warnings: string[],
): Promise<ResolvedMarketplace> {
  let text: string;
  try {
    text = await fsp.readFile(manifestPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadMarketplaceError(
      'INVALID_SINGLE_PLUGIN_MANIFEST',
      `failed to read ${manifestPath}: ${msg}`,
      { path: manifestPath },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LoadMarketplaceError(
      'INVALID_SINGLE_PLUGIN_MANIFEST',
      `failed to parse ${manifestPath}: ${msg}`,
      { path: manifestPath },
    );
  }
  const errs = validatePluginManifestJson(parsed);
  if (errs.length > 0) {
    throw new LoadMarketplaceError(
      'INVALID_SINGLE_PLUGIN_MANIFEST',
      `single-plugin manifest failed validation: ${formatErrors(errs)}`,
      { validationErrors: errs, path: manifestPath },
    );
  }
  const manifest = parsed as PluginManifest;
  const entry: ResolvedMarketplacePluginEntry = {
    name: manifest.name,
    source: './',
    description: manifest.description,
    version: manifest.version,
    author: manifest.author,
    keywords: manifest.keywords,
    status: manifest.status,
  };
  // Single-plugin install: still honor an agency.json sibling if present.
  const agency = await tryReadAgencyJson(absRoot, warnings);
  if (agency) {
    entry.agencyJson = agency;
    if (!entry.category && agency.category) entry.category = agency.category;
  }
  return {
    marketplaceId: manifest.name,
    metadata: {
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      owner: manifest.author
        ? { name: manifest.author.name, email: manifest.author.email }
        : undefined,
    },
    plugins: [entry],
    source: 'single-plugin',
    rootDir: absRoot,
    warnings,
  };
}

async function resolvePluginEntry(
  entry: MarketplacePluginEntry,
  marketplaceRoot: string,
  warnings: string[],
): Promise<ResolvedMarketplacePluginEntry> {
  const out: ResolvedMarketplacePluginEntry = {
    name: entry.name,
    source: entry.source,
    description: entry.description,
    version: entry.version,
    author: entry.author,
    keywords: entry.keywords,
    category: entry.category,
    strict: entry.strict,
    tags: entry.tags,
    status: entry.status,
  };
  const localDir = localPluginDir(entry.source, marketplaceRoot);
  if (localDir && existsSync(localDir)) {
    try {
      const stat = statSync(localDir);
      if (stat.isDirectory()) {
        const agency = await tryReadAgencyJson(localDir, warnings);
        if (agency) {
          out.agencyJson = agency;
          if (!out.category && agency.category) out.category = agency.category;
        }
      }
    } catch {
      /* ignore — agency.json is best-effort */
    }
  }
  return out;
}

/**
 * Resolve an entry's `source` to a local directory under the marketplace
 * root. Returns `null` for git/github sources or anything that looks
 * remote — those are fetched separately at install time.
 */
function localPluginDir(
  source: string | MarketplaceSourceObject,
  marketplaceRoot: string,
): string | null {
  if (typeof source === 'string') {
    if (isRemoteSource(source)) return null;
    return resolveUnderRoot(source, marketplaceRoot);
  }
  if (source && typeof source === 'object') {
    if (source.source === 'path' && typeof source.path === 'string') {
      return resolveUnderRoot(source.path, marketplaceRoot);
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

function resolveUnderRoot(p: string, root: string): string {
  if (isAbsolute(p)) return resolve(p);
  return resolve(root, p);
}

async function tryReadAgencyJson(
  dir: string,
  warnings: string[],
): Promise<AgencyJson | undefined> {
  const path = join(dir, 'agency.json');
  if (!existsSync(path)) return undefined;
  try {
    const text = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    const errs = validateAgencyJson(parsed);
    if (errs.length > 0) {
      warnings.push(`agency.json at ${path} invalid: ${formatErrors(errs)}`);
      return undefined;
    }
    return parsed as AgencyJson;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`agency.json at ${path} read/parse failed: ${msg}`);
    return undefined;
  }
}

function mergeMetadata(
  base: ResolvedMarketplaceMetadata,
  overlay: {
    name?: string;
    description?: string;
    version?: string;
    owner?: MarketplaceOwner;
  },
): ResolvedMarketplaceMetadata {
  return {
    name: overlay.name ?? base.name,
    description: overlay.description ?? base.description,
    version: overlay.version ?? base.version,
    owner: overlay.owner
      ? { name: overlay.owner.name ?? base.owner?.name ?? '', email: overlay.owner.email ?? base.owner?.email }
      : base.owner,
  };
}

function formatErrors(errs: ValidationError[]): string {
  return errs
    .slice(0, 3)
    .map((e) => `${e.path}: ${e.message}`)
    .join('; ');
}
