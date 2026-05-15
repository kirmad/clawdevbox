/**
 * cli/marketplace.ts
 *
 * `clawdevbox marketplace {add,list,update,remove}` — manages the local
 * registry of marketplace catalogs under `<globalDir>/marketplaces/`.
 *
 *   add <source>     Clone a git URL or junction a local path into
 *                    `<globalDir>/marketplaces/<id>/`, parse the catalog
 *                    via `loadMarketplace`, then write a sidecar
 *                    `<globalDir>/marketplaces/<id>.json` install record
 *                    (kind, source, ref, addedAt, plugin count).
 *   list             Print every catalog known to clawdevbox.
 *   update [<id>]    For git-installed catalogs: `git fetch` + reset to
 *                    the recorded ref (or `origin/HEAD`). Local junctions
 *                    are live and no-op. Omit `<id>` to update all.
 *   remove <id>      Delete the catalog folder + sidecar. Installed
 *                    plugins (separate install records under `plugins/`)
 *                    are unaffected.
 *
 * All marketplace state lives strictly under `<globalDir>/marketplaces/`.
 * The existing `<globalDir>/plugins/` layout is untouched.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveConfig } from '../config.ts';
import { loadMarketplace, LoadMarketplaceError } from '../manifest/load-marketplace.ts';

interface MarketplaceRecord {
  id: string;
  kind: 'git' | 'local';
  /** Original source string (git URL or absolute path). */
  source: string;
  /** Git ref pinned at `add` time (HEAD by default). null for local. */
  ref: string | null;
  /** Display name from the resolved metadata. */
  name: string;
  description?: string;
  version?: string;
  pluginCount: number;
  addedAt: number;
  /** When kind='local', the absolute target of the junction. */
  localPath?: string;
}

function marketplacesDir(globalDir: string): string {
  return join(globalDir, 'marketplaces');
}

function marketplaceDirOf(globalDir: string, id: string): string {
  return join(marketplacesDir(globalDir), id);
}

function recordPath(globalDir: string, id: string): string {
  return join(marketplacesDir(globalDir), `${id}.json`);
}

function readRecord(globalDir: string, id: string): MarketplaceRecord | null {
  const p = recordPath(globalDir, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as MarketplaceRecord;
  } catch {
    return null;
  }
}

function writeRecord(globalDir: string, record: MarketplaceRecord): void {
  mkdirSync(marketplacesDir(globalDir), { recursive: true });
  writeFileSync(recordPath(globalDir, record.id), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

function isGitSource(raw: string): boolean {
  if (raw.startsWith('git+')) return true;
  if (raw.startsWith('git@')) return true;
  if (/^https?:\/\//.test(raw)) return true;
  if (/^ssh:\/\//.test(raw)) return true;
  return false;
}

function resolvedGlobalDir(): string {
  return resolveConfig().globalDir;
}

function printUsage(): void {
  process.stdout.write(`clawdevbox marketplace — manage plugin catalogs.

Usage:
  clawdevbox marketplace add <source>
      Add a marketplace from a git URL or absolute local folder. Reads
      .claude-plugin/marketplace.json (or .github/plugin/marketplace.json)
      and persists an install record at
      <globalDir>/marketplaces/<id>.json.

  clawdevbox marketplace list
      List installed marketplaces with plugin counts.

  clawdevbox marketplace update [<id>]
      Git-installed catalogs: git fetch + reset to the recorded ref.
      Local junctions: no-op (the source folder is the live truth).
      Omit <id> to update all.

  clawdevbox marketplace remove <id>
      Delete the marketplace catalog + sidecar record. Installed plugins
      that came from this marketplace remain installed.
`);
}

export async function runMarketplace(argv: string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case 'add':
      return runAdd(argv.slice(1));
    case 'list':
      return runList();
    case 'update':
      return runUpdate(argv.slice(1));
    case 'remove':
    case 'rm':
      return runRemove(argv.slice(1));
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      return sub === undefined ? 2 : 0;
    default:
      process.stderr.write(`unknown marketplace subcommand: ${sub}\n\n`);
      printUsage();
      return 2;
  }
}

// ============================================================================
// add
// ============================================================================

async function runAdd(args: string[]): Promise<number> {
  const source = args[0];
  if (!source) {
    process.stderr.write('marketplace add: <source> is required\n');
    return 2;
  }
  const globalDir = resolvedGlobalDir();
  mkdirSync(marketplacesDir(globalDir), { recursive: true });

  if (isGitSource(source)) {
    return addGit(globalDir, source);
  }
  return addLocal(globalDir, source);
}

async function addGit(globalDir: string, source: string): Promise<number> {
  const gitUrl = source.startsWith('git+') ? source.slice('git+'.length) : source;
  const tmp = mkdtempSync(join(marketplacesDir(globalDir), '.tmp-add-'));
  const cloneResult = spawnSync('git', ['clone', gitUrl, tmp], { stdio: 'pipe', encoding: 'utf8' });
  if (cloneResult.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    const reason = (cloneResult.stderr ?? '').trim() || (cloneResult.stdout ?? '').trim() || `exit ${cloneResult.status}`;
    process.stderr.write(`git clone failed for ${source}: ${reason}\n`);
    return 1;
  }
  // Resolve the recorded ref (current HEAD SHA, full).
  const headSha = (() => {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, stdio: 'pipe', encoding: 'utf8' });
    if (r.status === 0) return (r.stdout ?? '').trim();
    return null;
  })();

  let resolved;
  try {
    resolved = await loadMarketplace(tmp);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    const code = err instanceof LoadMarketplaceError ? err.code : 'LOAD_FAILED';
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`marketplace add: ${code}: ${msg}\n`);
    return 1;
  }

  const id = resolved.marketplaceId;
  const dest = marketplaceDirOf(globalDir, id);
  if (existsSync(dest)) {
    rmSync(tmp, { recursive: true, force: true });
    process.stderr.write(`marketplace '${id}' is already installed at ${dest}. Use 'remove' first.\n`);
    return 1;
  }
  renameSync(tmp, dest);

  const record: MarketplaceRecord = {
    id,
    kind: 'git',
    source,
    ref: headSha,
    name: resolved.metadata.name,
    description: resolved.metadata.description,
    version: resolved.metadata.version,
    pluginCount: resolved.plugins.length,
    addedAt: Date.now(),
  };
  writeRecord(globalDir, record);
  process.stdout.write(
    `added marketplace '${record.name}' (id=${id}) from ${source}. ${resolved.plugins.length} plugins available.\n`,
  );
  if (resolved.warnings.length) {
    for (const w of resolved.warnings) process.stdout.write(`  warning: ${w}\n`);
  }
  return 0;
}

async function addLocal(globalDir: string, source: string): Promise<number> {
  if (!isAbsolute(source)) {
    process.stderr.write(`marketplace add: local source must be an absolute path (got ${source})\n`);
    return 2;
  }
  const abs = resolve(source);
  if (!existsSync(abs)) {
    process.stderr.write(`marketplace add: source does not exist: ${abs}\n`);
    return 1;
  }
  if (!statSync(abs).isDirectory()) {
    process.stderr.write(`marketplace add: source is not a directory: ${abs}\n`);
    return 1;
  }
  let resolved;
  try {
    resolved = await loadMarketplace(abs);
  } catch (err) {
    const code = err instanceof LoadMarketplaceError ? err.code : 'LOAD_FAILED';
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`marketplace add: ${code}: ${msg}\n`);
    return 1;
  }
  const id = resolved.marketplaceId;
  const dest = marketplaceDirOf(globalDir, id);
  if (existsSync(dest)) {
    process.stderr.write(`marketplace '${id}' is already installed at ${dest}. Use 'remove' first.\n`);
    return 1;
  }
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(abs, dest, linkType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`marketplace add: failed to create junction ${dest} → ${abs}: ${msg}\n`);
    return 1;
  }
  const record: MarketplaceRecord = {
    id,
    kind: 'local',
    source: abs,
    ref: null,
    name: resolved.metadata.name,
    description: resolved.metadata.description,
    version: resolved.metadata.version,
    pluginCount: resolved.plugins.length,
    addedAt: Date.now(),
    localPath: abs,
  };
  writeRecord(globalDir, record);
  process.stdout.write(
    `added marketplace '${record.name}' (id=${id}) from ${abs}. ${resolved.plugins.length} plugins available.\n`,
  );
  if (resolved.warnings.length) {
    for (const w of resolved.warnings) process.stdout.write(`  warning: ${w}\n`);
  }
  return 0;
}

// ============================================================================
// list
// ============================================================================

async function runList(): Promise<number> {
  const globalDir = resolvedGlobalDir();
  const dir = marketplacesDir(globalDir);
  if (!existsSync(dir)) {
    process.stdout.write('no marketplaces installed.\n');
    return 0;
  }
  const records: MarketplaceRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as MarketplaceRecord;
      records.push(r);
    } catch {
      /* skip malformed */
    }
  }
  if (records.length === 0) {
    process.stdout.write('no marketplaces installed.\n');
    return 0;
  }
  // Format as a small fixed-width table.
  const idCol = Math.max(2, ...records.map((r) => r.id.length));
  const nameCol = Math.max(4, ...records.map((r) => r.name.length));
  const header = `${pad('id', idCol)}  ${pad('name', nameCol)}  plugins  kind     source`;
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length) + '\n');
  for (const r of records) {
    process.stdout.write(
      `${pad(r.id, idCol)}  ${pad(r.name, nameCol)}  ${pad(String(r.pluginCount), 7)}  ${pad(r.kind, 7)}  ${r.source}\n`,
    );
  }
  return 0;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

// ============================================================================
// update
// ============================================================================

async function runUpdate(args: string[]): Promise<number> {
  const globalDir = resolvedGlobalDir();
  const dir = marketplacesDir(globalDir);
  if (!existsSync(dir)) {
    process.stdout.write('no marketplaces installed.\n');
    return 0;
  }
  const ids: string[] = [];
  if (args[0]) {
    ids.push(args[0]);
  } else {
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith('.json')) ids.push(entry.slice(0, -'.json'.length));
    }
  }
  let failures = 0;
  for (const id of ids) {
    const r = readRecord(globalDir, id);
    if (!r) {
      process.stderr.write(`marketplace '${id}' is not installed.\n`);
      failures++;
      continue;
    }
    if (r.kind === 'local') {
      process.stdout.write(`marketplace '${id}': local marketplaces are live; no update needed.\n`);
      continue;
    }
    const dest = marketplaceDirOf(globalDir, id);
    const fetchResult = spawnSync('git', ['fetch', '--all'], { cwd: dest, stdio: 'pipe', encoding: 'utf8' });
    if (fetchResult.status !== 0) {
      const reason = (fetchResult.stderr ?? '').trim() || `exit ${fetchResult.status}`;
      process.stderr.write(`marketplace '${id}': git fetch failed: ${reason}\n`);
      failures++;
      continue;
    }
    const target = r.ref ?? 'origin/HEAD';
    const resetResult = spawnSync('git', ['reset', '--hard', target], { cwd: dest, stdio: 'pipe', encoding: 'utf8' });
    if (resetResult.status !== 0) {
      const reason = (resetResult.stderr ?? '').trim() || `exit ${resetResult.status}`;
      process.stderr.write(`marketplace '${id}': git reset --hard ${target} failed: ${reason}\n`);
      failures++;
      continue;
    }
    // Refresh the sidecar with the new plugin count.
    try {
      const resolved = await loadMarketplace(dest);
      writeRecord(globalDir, {
        ...r,
        name: resolved.metadata.name,
        description: resolved.metadata.description,
        version: resolved.metadata.version,
        pluginCount: resolved.plugins.length,
      });
      process.stdout.write(
        `marketplace '${id}': updated. ${resolved.plugins.length} plugins available.\n`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`marketplace '${id}': updated git tree but reload failed: ${msg}\n`);
      failures++;
    }
  }
  return failures === 0 ? 0 : 1;
}

// ============================================================================
// remove
// ============================================================================

async function runRemove(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    process.stderr.write('marketplace remove: <id> is required\n');
    return 2;
  }
  const globalDir = resolvedGlobalDir();
  const dest = marketplaceDirOf(globalDir, id);
  const sidecar = recordPath(globalDir, id);
  if (!existsSync(dest) && !existsSync(sidecar)) {
    process.stderr.write(`marketplace '${id}' is not installed.\n`);
    return 1;
  }
  if (existsSync(dest)) {
    try {
      // Junction → unlink (don't recurse into the user's folder!).
      const stat = lstatSync(dest);
      if (stat.isSymbolicLink()) {
        unlinkSync(dest);
      } else {
        rmSync(dest, { recursive: true, force: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`marketplace remove: failed to remove ${dest}: ${msg}\n`);
      return 1;
    }
  }
  if (existsSync(sidecar)) {
    try {
      unlinkSync(sidecar);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`marketplace remove: failed to remove ${sidecar}: ${msg}\n`);
      return 1;
    }
  }
  process.stdout.write(
    `removed marketplace '${id}'. Installed plugins are unaffected.\n`,
  );
  return 0;
}
