import { spawn } from 'node:child_process';
import { dirname, resolve, relative, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import * as pty from 'node-pty';
import { writeFileAtomic } from '../fs-util.ts';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import { logger } from '../logger.ts';
import type {
  DetectResult,
  DiscoveredPlugin,
  MarketplaceRecord,
  PluginCliBinding,
  ProviderCtx,
  PtySpawnOpts,
  SyncPluginInventoryOpts,
  SyncReport,
} from './types.ts';

/** Spawn the binary with `args` and capture exit. Used by provider.detect(). */
export async function probeBinary(
  bin: string,
  args: string[] = ['--version'],
  timeoutMs = 5000,
): Promise<DetectResult> {
  return new Promise((resolveDetect) => {
    let stdout = '';
    let stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, shell: false });
    } catch (err) {
      resolveDetect({ available: false, reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolveDetect({ available: false, binary: bin, reason: `probe timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    proc.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveDetect({ available: false, binary: bin, reason: err.message });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const version = (stdout || stderr).trim().split('\n')[0] || undefined;
        resolveDetect({ available: true, binary: bin, version });
      } else {
        resolveDetect({ available: false, binary: bin, reason: `exit ${code}: ${(stderr || stdout).trim().split('\n')[0]}` });
      }
    });
  });
}

/**
 * Write `.mcp.json` so the spawned CLI sees the clawdevbox MCP server.
 *
 * The .mcp.json is written into the agent's working directory (`wsPath`),
 * which is the cwd the CLI is spawned with (claude/copilot resolve their
 * MCP config relative to their cwd). This is intentionally NOT
 * `ctx.writeWorkspaceFile`, which resolves against the SERVER's projectDir
 * and would be wrong for any spawn whose workspace differs from the server.
 *
 * Per-spawn headers (workspace_id, recipe_instance_id, project_dir,
 * session_id) are injected so the long-lived HTTP MCP server can identify
 * the calling agent on every request via `extra.requestInfo.headers`. The
 * header values are baked into THIS agent's .mcp.json; a different agent
 * spawn writes its own .mcp.json with different headers. See
 * context-resolver.ts for the read side.
 */
export function writeMcpJson(
  _ctx: ProviderCtx,
  wsPath: string,
  mcp: {
    url: string;
    secret: string;
    workspaceId?: string;
    recipeInstanceId?: string;
    projectDir?: string;
    sessionId?: string;
  },
): void {
  // Use `type: "http"` (not `"streamable-http"`). Copilot CLI's MCP config
  // schema rejects `streamable-http` with `Invalid literal value`, and Claude
  // Code happily accepts `http` (verified against copilot 1.0.49 and claude
  // 2.1.x). The shape is otherwise identical to MCP spec §6.2.
  //
  // When `mcp.secret` is empty/whitespace the server is running without
  // bearer auth (opt-in via empty `http.token`). Emitting
  // `Authorization: Bearer ` would be confusing and breaks some clients
  // that validate the header value (e.g. Copilot CLI's MCP HTTP client
  // gives up after the first 401/SSE-disconnect cycle), so we omit it
  // entirely. We also `.trim()` to reject whitespace-only secrets like
  // " " which would otherwise pass a naive truthy check.
  //
  // The per-spawn X-Clawdevbox-* headers still identify the calling
  // agent — they're routing metadata, not auth.
  const headers: Record<string, string> = {};
  if (mcp.secret && mcp.secret.trim().length > 0) {
    headers.Authorization = `Bearer ${mcp.secret}`;
  }
  if (mcp.workspaceId) headers['X-Clawdevbox-Workspace-Id'] = mcp.workspaceId;
  if (mcp.recipeInstanceId) headers['X-Clawdevbox-Recipe-Instance-Id'] = mcp.recipeInstanceId;
  if (mcp.projectDir) headers['X-Clawdevbox-Project-Dir'] = mcp.projectDir;
  if (mcp.sessionId) headers['X-Clawdevbox-Session-Id'] = mcp.sessionId;

  const config = {
    mcpServers: {
      clawdevbox: {
        type: 'http',
        url: mcp.url,
        headers,
        tools: ['*'],
      },
    },
  };

  // Resolve target path. Validate it doesn't try to escape via `..` etc.
  const target = resolve(wsPath, '.mcp.json');
  if (!target.startsWith(resolve(wsPath))) {
    throw new Error(`writeMcpJson: refusing to write outside wsPath '${wsPath}'`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Build --plugin-dir argv entries for vault directories.
 * Skips paths that don't exist on disk (guard against stale config).
 */
export function buildVaultPluginDirArgs(dirs?: string[]): string[] {
  if (!dirs || dirs.length === 0) return [];
  const args: string[] = [];
  for (const dir of dirs) {
    if (existsSync(dir)) {
      args.push('--plugin-dir', dir);
    }
  }
  return args;
}

/** Build the ProviderCtx the kernel hands to a provider for one call. */
export function buildProviderCtx(ws: Workspace, cfg: ResolvedConfig): ProviderCtx {
  return {
    ws,
    cfg,
    logger,
    spawnPty(file: string, args: string[], opts: PtySpawnOpts) {
      return pty.spawn(file, args, {
        name: opts.name ?? 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    },
    writeWorkspaceFile(rel: string, contents: string) {
      const abs = resolve(ws.projectDir, rel);
      const rel2 = relative(ws.projectDir, abs);
      if (rel2.startsWith('..') || resolve(ws.projectDir, rel2) !== abs) {
        throw new Error(`writeWorkspaceFile: path '${rel}' escapes the workspace`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileAtomic(abs, contents);
    },
  };
}

/** Pretty-print an Error for use in `DetectResult.reason`. */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Bidirectional plugin sync helpers (spec §4)
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PLUGIN_LINE_RE = /^\s*[•·◆*-]\s+([a-z0-9._-]+)@([a-z0-9._-]+)\s+\(v([^)]+)\)/i;
const MARKETPLACE_LINE_RE = /^\s*[•·◆*-]\s+([a-z0-9._-]+)\b/i;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function parsePluginListOutput(
  stdout: string,
): Array<{ name: string; marketplace: string; version: string }> {
  const out: Array<{ name: string; marketplace: string; version: string }> = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const m = PLUGIN_LINE_RE.exec(rawLine);
    if (m) out.push({ name: m[1]!, marketplace: m[2]!, version: m[3]! });
  }
  return out;
}

export function parseMarketplaceListOutput(stdout: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip headers / footers ('Registered marketplaces:', 'Included with ...')
    if (/^[A-Z][A-Za-z ]+:\s*$/.test(line)) continue;
    const m = MARKETPLACE_LINE_RE.exec(rawLine);
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!);
      out.push(m[1]!);
    }
  }
  return out;
}

interface RunCliResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function runCli(
  binding: PluginCliBinding,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunCliResult> {
  const fullArgs = [
    ...(binding.argsPrefix ?? []),
    ...(binding.subcommandPrefix ?? []),
    ...args,
  ];
  return new Promise((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let proc;
    try {
      proc = spawn(binding.binary, fullArgs, {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
    } catch (err) {
      resolveRun({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: -1 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs ?? 30_000);
    proc.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    proc.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr: stderr + (err.message ?? ''), code: -1 });
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolveRun({
          stdout,
          stderr: stderr + `\n[runCli] timed out after ${opts.timeoutMs ?? 30_000}ms`,
          code: -1,
        });
        return;
      }
      // A process killed by signal (e.g. SIGTERM from outside) reports
      // code: null. Treat that as failure too.
      if (code === null) {
        resolveRun({
          stdout,
          stderr: stderr + `\n[runCli] terminated by signal ${signal ?? '?'}`,
          code: -1,
        });
        return;
      }
      resolveRun({ stdout, stderr, code });
    });
  });
}

/**
 * Decide what source string to pass to `<binary> plugin install` for a given
 * clawdevbox-installed plugin. Prefers `<name>@<marketplace>` form using a
 * marketplace that *clawdevbox itself manages* (so we never pick an unrelated
 * pre-existing CLI marketplace like `awesome-copilot`). Falls back to the
 * plugin's `homepage` / `repository` git URL or the bare plugin name.
 */
function resolveInstallSource(
  plugin: {
    id: string;
    manifest: { name: string; homepage?: unknown; repository?: unknown };
  },
  clawdevboxMarketplaceIds: string[],
  cliKnownMarketplaceIds: Set<string>,
): { source: string; isMarketplaceRef: boolean; marketplaceId: string | null } {
  // Prefer the first clawdevbox-managed marketplace that the CLI also knows
  // about. This guards against picking a marketplace that wasn't pushed via
  // clawdevbox (e.g. `awesome-copilot`) and ensures `<name>@<marketplace>`
  // resolves to a source the CLI can actually find.
  for (const mid of clawdevboxMarketplaceIds) {
    if (cliKnownMarketplaceIds.has(mid)) {
      return { source: `${plugin.manifest.name}@${mid}`, isMarketplaceRef: true, marketplaceId: mid };
    }
  }
  const repo = (plugin.manifest as { repository?: { url?: string } | string }).repository;
  if (typeof repo === 'string' && repo) return { source: repo, isMarketplaceRef: false, marketplaceId: null };
  if (repo && typeof repo === 'object' && typeof repo.url === 'string' && repo.url) {
    return { source: repo.url, isMarketplaceRef: false, marketplaceId: null };
  }
  const home = (plugin.manifest as { homepage?: string }).homepage;
  if (typeof home === 'string' && home) return { source: home, isMarketplaceRef: false, marketplaceId: null };
  return { source: plugin.manifest.name, isMarketplaceRef: false, marketplaceId: null };
}

export async function cliPluginSync(
  _ctx: ProviderCtx,
  opts: SyncPluginInventoryOpts,
  binding: PluginCliBinding,
): Promise<SyncReport> {
  const report: SyncReport = {
    marketplacesAdded: [],
    marketplacesPresent: [],
    pluginsInstalled: [],
    pluginsPresent: [],
    pluginsUninstalled: [],
    failed: [],
    method: 'cli-command',
  };

  // -- marketplace step ----------------------------------------------------
  const mpList = await runCli(binding, ['plugin', 'marketplace', 'list']);
  const knownMarketplaces = new Set<string>();
  if (mpList.code === 0) {
    for (const id of parseMarketplaceListOutput(mpList.stdout)) knownMarketplaces.add(id);
  } else {
    logger.warn(
      { binary: binding.binary, code: mpList.code, stderr: mpList.stderr.slice(0, 200) },
      'cliPluginSync: marketplace list failed; assuming empty',
    );
  }

  for (const m of opts.marketplaces) {
    if (knownMarketplaces.has(m.id)) {
      report.marketplacesPresent.push(m.id);
      continue;
    }
    if (opts.dryRun) {
      report.marketplacesAdded.push(m.id);
      knownMarketplaces.add(m.id);
      continue;
    }
    const res = await runCli(binding, ['plugin', 'marketplace', 'add', m.source]);
    if (res.code === 0) {
      report.marketplacesAdded.push(m.id);
      knownMarketplaces.add(m.id);
    } else {
      report.failed.push({
        kind: 'marketplace',
        id: m.id,
        error: (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 500),
      });
    }
  }

  // -- plugin install step -------------------------------------------------
  const pList = await runCli(binding, ['plugin', 'list']);
  const installed = new Set<string>();
  let installedRows: Array<{ name: string; marketplace: string }> = [];
  if (pList.code === 0) {
    installedRows = parsePluginListOutput(pList.stdout).map((r) => ({
      name: r.name,
      marketplace: r.marketplace,
    }));
    for (const r of installedRows) installed.add(`${r.name}@${r.marketplace}`);
  } else {
    logger.warn(
      { binary: binding.binary, code: pList.code, stderr: pList.stderr.slice(0, 200) },
      'cliPluginSync: plugin list failed; assuming empty',
    );
  }

  const clawdevboxNames = new Set<string>();
  // List of marketplace ids clawdevbox is responsible for, in declaration
  // order. resolveInstallSource prefers these over the CLI's full marketplace
  // list so we don't accidentally pick an unrelated pre-existing one.
  const clawdevboxMarketplaceIds = opts.marketplaces.map((m) => m.id);
  for (const p of opts.plugins) {
    clawdevboxNames.add(p.manifest.name);
    const { source, isMarketplaceRef, marketplaceId } = resolveInstallSource(
      p,
      clawdevboxMarketplaceIds,
      knownMarketplaces,
    );
    const key = isMarketplaceRef && marketplaceId
      ? `${p.manifest.name}@${marketplaceId}`
      : p.manifest.name;
    const installedKey = isMarketplaceRef && marketplaceId
      ? `${p.manifest.name}@${marketplaceId}`
      : Array.from(installed).find((s) => s.startsWith(`${p.manifest.name}@`)) ?? '';
    if (installed.has(installedKey)) {
      report.pluginsPresent.push(key);
      continue;
    }
    if (opts.dryRun) {
      report.pluginsInstalled.push(source);
      continue;
    }
    const res = await runCli(binding, ['plugin', 'install', source], { timeoutMs: 300_000 });
    if (res.code === 0) {
      report.pluginsInstalled.push(source);
    } else {
      report.failed.push({
        kind: 'plugin',
        id: source,
        error: (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 500),
      });
    }
  }

  // -- bidirectional uninstall step ---------------------------------------
  const bidiUninstall = opts.bidirectionalUninstall !== false;
  if (bidiUninstall) {
    const clawdevboxMarketplaceSet = new Set(clawdevboxMarketplaceIds);
    for (const row of installedRows) {
      // Only auto-uninstall plugins that came from a marketplace clawdevbox
      // MANAGES (not just one the CLI happens to know about) AND whose name
      // no longer appears in clawdevbox. This prevents removing plugins the
      // user installed via the CLI's own pre-existing marketplaces.
      if (!clawdevboxMarketplaceSet.has(row.marketplace)) continue;
      if (clawdevboxNames.has(row.name)) continue;
      const id = `${row.name}@${row.marketplace}`;
      if (opts.dryRun) {
        report.pluginsUninstalled.push(id);
        continue;
      }
      const res = await runCli(binding, ['plugin', 'uninstall', id], { timeoutMs: 120_000 });
      if (res.code === 0) {
        report.pluginsUninstalled.push(id);
      } else {
        report.failed.push({
          kind: 'plugin',
          id,
          error: (res.stderr || res.stdout || `exit ${res.code}`).trim().slice(0, 500),
        });
      }
    }
  }

  return report;
}

export async function cliPluginDiscover(
  _ctx: ProviderCtx,
  binding: PluginCliBinding,
): Promise<DiscoveredPlugin[]> {
  const pList = await runCli(binding, ['plugin', 'list']);
  if (pList.code !== 0) {
    logger.warn(
      { binary: binding.binary, code: pList.code, stderr: pList.stderr.slice(0, 200) },
      'cliPluginDiscover: plugin list failed',
    );
    return [];
  }
  const rows = parsePluginListOutput(pList.stdout);
  const out: DiscoveredPlugin[] = [];
  for (const row of rows) {
    // Canonical layout for both Claude (`~/.claude/plugins/cache/<mp>/<name>/`)
    // and Copilot (`~/.copilot/installed-plugins/<mp>/<name>/`) is
    // `<pluginCacheDir>/<marketplace>/<name>/`. The other two are
    // legacy / fallback shapes some older CLI versions used.
    const candidates = [
      join(binding.pluginCacheDir, row.marketplace, row.name),
      join(binding.pluginCacheDir, `${row.name}-${row.marketplace}`),
      join(binding.pluginCacheDir, row.name),
    ];
    const dir = candidates.find((p) => existsSync(p));
    if (!dir) {
      logger.warn(
        { name: row.name, marketplace: row.marketplace, tried: candidates },
        'cliPluginDiscover: could not locate plugin on disk',
      );
      continue;
    }
    out.push({
      name: row.name,
      absoluteDir: dir,
      source: 'cli-marketplace',
      marketplaceId: row.marketplace,
    });
  }
  return out;
}

// Re-export so tests + callers can import marketplace record type from here.
export type { MarketplaceRecord };
