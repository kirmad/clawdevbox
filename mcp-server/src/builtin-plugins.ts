/**
 * builtin-plugins.ts
 *
 * Registry of plugins that ship in this repo's `samples/plugins/`
 * directory. `clawdevbox init` reads this list to populate its
 * multi-select, and `installBuiltinPlugin()` does the actual copy into
 * `<globalDir>/plugins/<id>/` (atomic — temp dir then rename).
 *
 * Adding a new built-in: drop a plugin directory under
 * `samples/plugins/<id>/` with the standard layout (plugin.yaml +
 * tools/ + recipes/ + skills/ + triggers/) and add an entry below.
 *
 * The historical built-ins for IcM / Geneva Metrics / DGrep / CFV have
 * been moved out of this repo into the standalone `clawdevbox-plugins`
 * collection (https://github.com/ic3-microsoft/clawdevbox-plugins).
 * Install them via `clawdevbox init --plugin <git-url-or-folder>` or via
 * the `plugin.install` MCP tool.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuiltinPluginDef {
  id: string;
  name: string;
  /** One-line summary shown in the init multi-select. */
  description: string;
  /** Env vars the user will need to set before this plugin's tools work. */
  required_env: string[];
}

export const BUILTIN_PLUGINS: BuiltinPluginDef[] = [
  {
    id: 'ado',
    name: 'Azure DevOps',
    description: 'PR review, comments, iterations + cold/hot/pulse triggers.',
    required_env: ['ADO_ORG', 'ADO_BEARER_TOKEN'],
  },
];

/**
 * Resolve the on-disk source path for a built-in plugin. Candidates in
 * order of preference:
 *
 *   1. <module-dir>/plugins/<id>           — published-package layout
 *      (dist/plugins is populated by scripts/build.mjs).
 *   2. <module-dir>/../samples/plugins/<id> — dev (tsx) from src/
 *      or dist/, looking sideways to the samples/ tree.
 *   3. <module-dir>/../../samples/plugins/<id> — when this module lives
 *      one directory deeper than expected (e.g. src/cli/).
 */
export function resolveBuiltinPluginSource(id: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'plugins', id),
    resolve(here, '..', 'plugins', id),
    resolve(here, '..', 'samples', 'plugins', id),
    resolve(here, '..', '..', 'samples', 'plugins', id),
    resolve(here, '..', '..', '..', 'samples', 'plugins', id),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Copy a built-in plugin into the global plugin store. Returns the
 * destination directory. Idempotent: if the destination already exists,
 * the call leaves it alone and returns the existing path (the user gets
 * to keep any local edits they've made).
 *
 * The copy goes via a sibling temp dir + `renameSync` so a partially
 * written plugin is never visible to discovery.
 *
 * Also (idempotently) installs a `node_modules` junction at
 * `<globalDir>/node_modules` pointing at clawdevbox's own node_modules
 * so plugin tools can resolve runtime deps like `zod`.
 */
export function installBuiltinPlugin(globalDir: string, id: string): {
  destination: string;
  source: string;
  copied: boolean;
} {
  const source = resolveBuiltinPluginSource(id);
  if (!source) {
    throw new Error(`built-in plugin '${id}' not found in samples/plugins/`);
  }
  const pluginsRoot = join(globalDir, 'plugins');
  mkdirSync(pluginsRoot, { recursive: true });
  const destination = join(pluginsRoot, id);
  let copied = false;
  if (!existsSync(destination)) {
    const tmp = mkdtempSync(join(pluginsRoot, '.tmp-builtin-'));
    let succeeded = false;
    try {
      cpSync(source, tmp, {
        recursive: true,
        // Skip nested node_modules and any legacy mcp-server scratch dirs.
        filter: (src) => !/[/\\]node_modules([/\\]|$)/.test(src) && !/[/\\]_legacy/.test(src),
      });
      // Write a sidecar install record so plugin.update / plugin.read see
      // a uniform origin. Built-ins are not updatable via git.
      const record = {
        kind: 'builtin' as const,
        from: source,
        ref: null,
        installed_at: Date.now(),
      };
      writeFileSync(
        join(pluginsRoot, `${id}.install.json`),
        JSON.stringify(record, null, 2) + '\n',
        'utf8',
      );
      renameSync(tmp, destination);
      succeeded = true;
      copied = true;
    } finally {
      if (!succeeded && existsSync(tmp)) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  ensureGlobalNodeModulesLink(globalDir);
  return { destination, source, copied };
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
