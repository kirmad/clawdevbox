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
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from './logger.ts';
import type { ResolvedConfig } from './config.ts';

/**
 * Resolve the absolute path to the bundled built-in marketplace dir.
 * Returns null if the dir cannot be found in any candidate location.
 *
 * Candidates in order of preference:
 *   1. <module-dir>/marketplace                   — bundled inside dist/ (npm install layout)
 *   2. <module-dir>/../marketplace                — published-package legacy (dist/marketplace alongside dist/cli.js)
 *   3. <module-dir>/../../marketplace             — one level deeper (running from inside a nested dist)
 *   4. <module-dir>/../..                          — running from source repo root (src/ → repo)
 *   5. <module-dir>/../../..                       — running from source repo, extra deep (src/cli/ → repo)
 *
 * The resolver checks for a `.claude-plugin/marketplace.json` at each
 * candidate before accepting it.
 */
export function resolveBuiltinMarketplaceSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'marketplace'),               // bundled inside dist/ (npm package layout)
    resolve(here, '..', 'marketplace'),          // published-package (dist/marketplace alongside dist/cli.js — legacy)
    resolve(here, '..', '..', 'marketplace'),    // one level deeper (running from inside a nested dist)
    resolve(here, '..', '..'),                   // running from source repo root (src/ → repo)
    resolve(here, '..', '..', '..'),             // running from source repo, extra deep (src/cli/ → repo)
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
  if (!existsSync(linkPath)) {
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
  // Also ensure a `clawdevbox` self-link inside the host's node_modules
  // so plugin modules (junction-installed) that `import 'clawdevbox/agent-clis'`
  // can resolve. In production (`npm install -g clawdevbox`) npm already
  // places the package at <global>/node_modules/clawdevbox — this is a
  // no-op there. In dev mode (running from the source tree) the package
  // is at <repo>/mcp-server with nothing at node_modules/clawdevbox; we
  // synthesize the link.
  ensureClawdevboxSelfLink(target);
}

/**
 * Ensure `<hostNodeModules>/clawdevbox/` exists as a *minimal stub package*
 * that re-exports the actual host package files. This lets plugin code do
 * `import 'clawdevbox/agent-clis'` and resolve correctly via Node's standard
 * `node_modules` walk.
 *
 * IMPORTANT: do NOT create this as a symlink/junction back to the package
 * root. A self-link causes infinite recursion (the host's own node_modules
 * contains the stub, and the stub points back at the host…), which breaks
 * any CLI that tree-copies plugins (Copilot, agency copilot) — the copy
 * follows the junction infinitely until the filesystem max-path is hit,
 * leaving multi-GB worth of bogus nested directories.
 *
 * Instead, write a tiny stub package that uses Node's `exports` field
 * to redirect each subpath to the real file via an absolute path string.
 * That keeps the stub small (just a package.json), doesn't introduce any
 * symlinks, and Node still resolves `clawdevbox/agent-clis` to
 * `<pkgRoot>/dist/agent-clis.mjs` (or whatever `package.json#exports`
 * dictates).
 *
 * Idempotent: keeps the existing stub if the contents are already valid.
 */
export function ensureClawdevboxSelfLink(hostNodeModules: string): void {
  const pkgRoot = locateClawdevboxPackageRoot();
  if (!pkgRoot) return;
  const stubDir = join(hostNodeModules, 'clawdevbox');

  // If something is already there, validate it's a directory (not a stale
  // junction from a previous version of this code). Replace any reparse
  // point with a fresh stub.
  if (existsSync(stubDir)) {
    let isReparse = false;
    try {
      isReparse = lstatSync(stubDir).isSymbolicLink();
    } catch {
      return;
    }
    if (isReparse) {
      try {
        rmSync(stubDir, { recursive: true, force: true });
      } catch {
        return;
      }
    }
  }

  try {
    writeStubPackage(stubDir, pkgRoot);
  } catch {
    /* best-effort */
  }
}

/**
 * Create the stub package tree at `stubDir`:
 *
 *   <stubDir>/
 *     package.json                 — name + exports map pointing at './stub-N.mjs'
 *     stub-<idx>.mjs               — `export * from 'file:///<absolute-path>'`
 *
 * Each subpath in the real package's `exports` map becomes one `stub-N.mjs`
 * re-export file. The package.json `exports` map uses relative `./stub-N.mjs`
 * targets (Node refuses absolute paths in `exports`). Idempotent: if the stub
 * already matches the current pkgRoot's exports, we leave it alone.
 */
function writeStubPackage(stubDir: string, pkgRoot: string): void {
  let realPkg: { name?: string; version?: string; exports?: Record<string, unknown> };
  try {
    realPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  } catch {
    realPkg = {};
  }
  const realExports = (realPkg.exports ?? {}) as Record<string, unknown>;
  const stubExports: Record<string, unknown> = {};
  const reExports: Array<{ rel: string; absSrc: string }> = [];
  let counter = 0;
  for (const [key, value] of Object.entries(realExports)) {
    // For each leaf string target, write a re-export stub file and
    // rewrite the exports entry to point at it.
    stubExports[key] = mapExportTarget(value, () => {
      const rel = `./stub-${++counter}.mjs`;
      return rel;
    }, (rel, abs) => {
      reExports.push({ rel, absSrc: abs });
    }, pkgRoot);
  }
  // Always include a fallback "main" so `import 'clawdevbox'` resolves to
  // something — Node would otherwise fall back to legacy behavior.
  const stub = {
    name: realPkg.name ?? 'clawdevbox',
    version: realPkg.version ?? '0.0.0',
    type: 'module',
    exports: stubExports,
  };
  const pkgJsonText = JSON.stringify(stub, null, 2) + '\n';

  // Idempotency check.
  if (existsSync(stubDir)) {
    try {
      const existing = readFileSync(join(stubDir, 'package.json'), 'utf8');
      if (existing === pkgJsonText) return;
    } catch {
      /* fall through to rewrite */
    }
  }

  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(stubDir, 'package.json'), pkgJsonText, 'utf8');
  for (const { rel, absSrc } of reExports) {
    const out = join(stubDir, rel.slice(2));
    // ESM re-export. `export *` is universally safe; the default export
    // is forwarded conditionally via a dynamic-import wrapper so we don't
    // fail at parse time when the source has no default export.
    const url = JSON.stringify(pathToFileURL(absSrc).href);
    const body =
      `export * from ${url};\n` +
      `const __cdbModule = await import(${url});\n` +
      `export default __cdbModule.default;\n`;
    writeFileSync(out, body, 'utf8');
  }
}

/**
 * Walk one exports-map value (string | array | conditional object), call
 * `assignRel()` to get a relative stub path for each leaf string, record
 * the (rel, absSrc) pair via `recordReExport`, and return the rewritten
 * value with all leaf strings replaced by their relative stubs.
 *
 * Absolute-path strings (already rewritten) and non-relative bare-name
 * targets are passed through unchanged.
 */
function mapExportTarget(
  value: unknown,
  assignRel: () => string,
  recordReExport: (rel: string, absSrc: string) => void,
  pkgRoot: string,
): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith('./')) return value;
    const abs = join(pkgRoot, value.slice(2));
    const rel = assignRel();
    recordReExport(rel, abs);
    return rel;
  }
  if (Array.isArray(value)) {
    return value.map((v) => mapExportTarget(v, assignRel, recordReExport, pkgRoot));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip `types` condition — TypeScript type files don't need a runtime
      // re-export and Node ignores `types` for the runtime resolver anyway.
      if (k === 'types') {
        out[k] = v;
        continue;
      }
      out[k] = mapExportTarget(v, assignRel, recordReExport, pkgRoot);
    }
    return out;
  }
  return value;
}

function locateClawdevboxPackageRoot(): string | null {
  // The package root is the directory containing `package.json` with
  // name === 'clawdevbox'. Walk up from this file.
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(cur, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'clawdevbox') return cur;
      } catch {
        /* ignore parse errors and keep walking */
      }
    }
    const parent = resolve(cur, '..');
    if (parent === cur) break;
    cur = parent;
  }
  return null;
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
