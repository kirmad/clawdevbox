/**
 * builtin-marketplace.ts
 *
 * Bundled marketplace registration. clawdevbox ships its own
 * Claude-Code-style plugin marketplace at the repo root
 * (`.claude-plugin/marketplace.json`). This module:
 *
 *   - Resolves the on-disk path to the bundled marketplace
 *     (`resolveBuiltinMarketplaceSource`), walking a small fallback
 *     chain so it works both in the source repo and in the published
 *     `dist/marketplace/` layout.
 *   - Idempotently registers it into `<globalDir>/marketplaces/clawdevbox/`
 *     via a Windows-junction / POSIX-dir symlink, alongside a
 *     `<globalDir>/marketplaces/clawdevbox.json` sidecar with
 *     `kind: 'builtin'`. The `marketplace update` CLI no-ops for
 *     `builtin` records since the live source IS the truth.
 *
 * Also keeps `ensureGlobalNodeModulesLink` here (used by every plugin
 * install path) so plugin tools can resolve `import 'zod'` and friends
 * via realpath walk-up.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.ts';
import type { ResolvedConfig } from './config.ts';

/**
 * Resolve the absolute path to the bundled built-in marketplace dir.
 * Returns null if the dir cannot be found in any candidate location.
 *
 * Candidates in order of preference:
 *   1. <module-dir>/../marketplace                — published-package (dist/marketplace alongside dist/cli.js)
 *   2. <module-dir>/../../marketplace             — one level deeper (running from inside a nested dist)
 *   3. <module-dir>/../..                          — running from source repo root (src/ → repo)
 *   4. <module-dir>/../../..                       — running from source repo, extra deep (src/cli/ → repo)
 *
 * The resolver checks for a `.claude-plugin/marketplace.json` at each
 * candidate before accepting it.
 */
export function resolveBuiltinMarketplaceSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'marketplace'),
    resolve(here, '..', '..', 'marketplace'),
    resolve(here, '..', '..'),
    resolve(here, '..', '..', '..'),
  ];
  for (const c of candidates) {
    try {
      if (!existsSync(c) || !statSync(c).isDirectory()) continue;
      const catalog = join(c, '.claude-plugin', 'marketplace.json');
      if (existsSync(catalog)) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

interface BuiltinMarketplaceRecord {
  id: string;
  kind: 'builtin';
  source: string;
  ref: null;
  name: string;
  description?: string;
  pluginCount: number;
  addedAt: number;
}

/**
 * Idempotently register the bundled marketplace into
 * `<globalDir>/marketplaces/`. If the sidecar at
 * `<globalDir>/marketplaces/clawdevbox.json` already exists, this is a
 * no-op. Otherwise junction the resolved source dir at
 * `<globalDir>/marketplaces/clawdevbox/` and write the sidecar with
 * `kind: 'builtin'`.
 *
 * Errors are logged at WARN level and do not throw — clawdevbox can
 * still function without the built-in marketplace.
 */
export function ensureBuiltinMarketplaceRegistered(cfg: ResolvedConfig): void {
  const marketplacesDir = join(cfg.globalDir, 'marketplaces');
  const sidecarPath = join(marketplacesDir, 'clawdevbox.json');
  const junctionPath = join(marketplacesDir, 'clawdevbox');

  if (existsSync(sidecarPath) && existsSync(junctionPath)) return;

  const source = resolveBuiltinMarketplaceSource();
  if (!source) {
    logger.warn(
      { searched: 'dist/marketplace + repo-root fallback chain' },
      'builtin-marketplace: source dir not found; built-in plugins unavailable',
    );
    return;
  }

  try {
    mkdirSync(marketplacesDir, { recursive: true });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), dir: marketplacesDir },
      'builtin-marketplace: failed to create marketplaces dir',
    );
    return;
  }

  if (!existsSync(junctionPath)) {
    try {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      symlinkSync(source, junctionPath, linkType);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), from: junctionPath, to: source },
        'builtin-marketplace: junction creation failed',
      );
      return;
    }
  }

  // Best-effort plugin count from the marketplace.json.
  let pluginCount = 0;
  let description: string | undefined;
  try {
    const text = readFileSync(join(source, '.claude-plugin', 'marketplace.json'), 'utf8');
    const parsed = JSON.parse(text) as { plugins?: unknown[]; description?: string };
    if (Array.isArray(parsed.plugins)) pluginCount = parsed.plugins.length;
    if (typeof parsed.description === 'string') description = parsed.description;
  } catch {
    /* best-effort */
  }

  const record: BuiltinMarketplaceRecord = {
    id: 'clawdevbox',
    kind: 'builtin',
    source,
    ref: null,
    name: 'clawdevbox',
    description,
    pluginCount,
    addedAt: Date.now(),
  };
  try {
    writeFileSync(sidecarPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path: sidecarPath },
      'builtin-marketplace: failed to write sidecar record',
    );
  }
}

/**
 * Create a `node_modules` junction at `<globalDir>/` so plugin tool files
 * (which Node resolves by walking up from their own dir) can find `zod`
 * and any other runtime dep that ships with clawdevbox. Idempotent +
 * best-effort: failure logs a warning to stderr but doesn't throw.
 */
export function ensureGlobalNodeModulesLink(globalDir: string): void {
  const target = locateClawdevboxNodeModules();
  if (!target) return;
  mkdirSync(globalDir, { recursive: true });
  const linkPath = join(globalDir, 'node_modules');
  if (existsSync(linkPath)) return;
  try {
    // On Windows, `junction` doesn't require admin rights — unlike a
    // standard `symlink`. cross-platform: fall back to symlink on POSIX.
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(target, linkPath, type);
  } catch {
    // Last resort: try `mklink /J` via cmd, which is more permissive on
    // some Windows setups.
    if (process.platform === 'win32') {
      try {
        spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore' });
      } catch {
        /* give up silently — manual copy still works */
      }
    }
  }
}

function locateClawdevboxNodeModules(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'node_modules'),          // dist/ or src/ → ../node_modules
    resolve(here, '..', '..', 'node_modules'),    // src/cli/ → ../../node_modules
    resolve(here, '..', '..', '..', 'node_modules'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
