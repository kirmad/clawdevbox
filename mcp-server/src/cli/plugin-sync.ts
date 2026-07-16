/**
 * cli/plugin-sync.ts
 *
 * `clawdevbox plugin sync [--direction=both|push|pull] [--dry-run]
 *                        [--respect-config]`
 *
 * Manual bidirectional plugin sync (spec §7). Defaults to running both
 * directions regardless of `cfg.clientSync.mode` so users can always sync
 * on demand; pass `--respect-config` to honor the configured mode.
 */

import { logger } from '../logger.ts';
import { resolveConfig } from '../config.ts';
import { loadWorkspaceFromEnv } from '../workspace.ts';
import { buildProviderCtx } from '../agent-clis/shared.ts';
import { loadClientDiscoveredPlugins } from '../agent-clis/lifecycle.ts';
import type { SyncReport } from '../agent-clis/types.ts';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketplaceRecord } from '../agent-clis/types.ts';

type Direction = 'both' | 'push' | 'pull';

interface ParsedArgs {
  direction: Direction;
  dryRun: boolean;
  respectConfig: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    direction: 'both',
    dryRun: false,
    respectConfig: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h' || a === 'help') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--respect-config') out.respectConfig = true;
    else if (a.startsWith('--direction=')) {
      const v = a.slice('--direction='.length);
      if (v === 'both' || v === 'push' || v === 'pull') out.direction = v;
      else throw new Error(`--direction must be 'both', 'push', or 'pull' (got '${v}')`);
    } else if (a === '--direction') {
      const v = argv[++i];
      if (v === 'both' || v === 'push' || v === 'pull') out.direction = v;
      else throw new Error(`--direction must be 'both', 'push', or 'pull' (got '${v}')`);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(`clawdevbox plugin sync — bidirectional plugin sync with the configured CLI.

Usage:
  clawdevbox plugin sync [--direction=both|push|pull] [--dry-run] [--respect-config]

  --direction=both       Default. Push clawdevbox -> CLI AND pull CLI -> clawdevbox.
  --direction=push       Direction A only (clawdevbox -> CLI).
  --direction=pull       Direction B only (CLI -> clawdevbox).
  --dry-run              Report what would change without making changes.
  --respect-config       Honor cfg.client_sync.mode (default: ignore it).
`);
}

function readAllMarketplaces(globalDir: string): MarketplaceRecord[] {
  const dir = join(globalDir, 'marketplaces');
  if (!existsSync(dir)) return [];
  const out: MarketplaceRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as MarketplaceRecord;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.source === 'string') {
        out.push(parsed);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function renderSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  lines.push(`  method: ${report.method}`);
  if (report.marketplacesAdded.length) {
    lines.push(`  marketplaces added (${report.marketplacesAdded.length}):`);
    for (const m of report.marketplacesAdded) lines.push(`    + ${m}`);
  }
  if (report.marketplacesPresent.length) {
    lines.push(`  marketplaces already present (${report.marketplacesPresent.length}):`);
    for (const m of report.marketplacesPresent) lines.push(`    = ${m}`);
  }
  if (report.pluginsInstalled.length) {
    lines.push(`  plugins installed (${report.pluginsInstalled.length}):`);
    for (const p of report.pluginsInstalled) lines.push(`    + ${p}`);
  }
  if (report.pluginsPresent.length) {
    lines.push(`  plugins already present (${report.pluginsPresent.length}):`);
    for (const p of report.pluginsPresent) lines.push(`    = ${p}`);
  }
  if (report.pluginsUninstalled.length) {
    lines.push(`  plugins uninstalled (${report.pluginsUninstalled.length}):`);
    for (const p of report.pluginsUninstalled) lines.push(`    - ${p}`);
  }
  if (report.failed.length) {
    lines.push(`  failures (${report.failed.length}):`);
    for (const f of report.failed) lines.push(`    ! ${f.kind} ${f.id}: ${f.error}`);
  }
  return lines.join('\n');
}

export interface RunPluginSyncResult {
  exitCode: number;
  syncReport?: SyncReport;
  discovered?: { discovered: number; registered: number };
}

export async function runPluginSync(argv: string[]): Promise<RunPluginSyncResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`plugin sync: ${err instanceof Error ? err.message : String(err)}\n\n`);
    printUsage();
    return { exitCode: 2 };
  }
  if (parsed.help) {
    printUsage();
    return { exitCode: 0 };
  }

  const cfg = resolveConfig();

  if (parsed.respectConfig && cfg.clientSync.mode === 'off') {
    process.stdout.write('client_sync.mode is off — skipping (use without --respect-config to force).\n');
    return { exitCode: 0 };
  }

  const env = { ...process.env, CLAWDEVBOX_PROJECT_DIR: cfg.projectDir, CLAWDEVBOX_GLOBAL_DIR: cfg.globalDir };
  const ws = await loadWorkspaceFromEnv(env);

  const providerId = cfg.defaultAgentCli ?? 'copilot';
  const provider = ws.agentCliProviders.get(providerId);
  if (!provider) {
    process.stderr.write(
      `plugin sync: no agent-CLI provider '${providerId}' registered. Set default_agent_cli or install a plugin that provides it.\n`,
    );
    return { exitCode: 1 };
  }

  process.stdout.write(`plugin sync via '${provider.id}' (${provider.displayName})\n`);
  if (parsed.dryRun) process.stdout.write('  (dry run — no changes will be made)\n');

  const result: RunPluginSyncResult = { exitCode: 0 };
  const ctx = buildProviderCtx(ws, cfg);

  // ---- pull (Direction B) ------------------------------------------------
  if (parsed.direction === 'both' || parsed.direction === 'pull') {
    if (!provider.discoverInstalledPlugins) {
      process.stdout.write(`  pull: provider '${provider.id}' does not support discoverInstalledPlugins; skipped.\n`);
    } else if (parsed.dryRun) {
      try {
        const discovered = await provider.discoverInstalledPlugins(ctx);
        const optedIn = new Set(
          cfg.clientSync.discoveredPlugins.filter((d) => d.provider === provider.id).map((d) => d.name),
        );
        const optedInList = discovered.filter((d) => optedIn.has(d.name));
        process.stdout.write(`  pull (dry-run): discovered ${discovered.length} plugin(s), ${optedInList.length} opted in.\n`);
        for (const d of discovered) {
          const mark = optedIn.has(d.name) ? '+' : ' ';
          process.stdout.write(`    ${mark} ${d.name}@${d.marketplaceId ?? '<direct>'} ${d.absoluteDir}\n`);
        }
        result.discovered = { discovered: discovered.length, registered: optedInList.length };
      } catch (err) {
        process.stderr.write(`  pull: discoverInstalledPlugins failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } else {
      try {
        const r = await loadClientDiscoveredPlugins(ws, cfg, provider);
        process.stdout.write(`  pull: discovered ${r.discovered}, registered ${r.registered}.\n`);
        result.discovered = r;
      } catch (err) {
        process.stderr.write(`  pull: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  // ---- push (Direction A) ------------------------------------------------
  if (parsed.direction === 'both' || parsed.direction === 'push') {
    if (parsed.respectConfig && cfg.clientSync.mode === 'discover-only') {
      process.stdout.write('  push: skipped (client_sync.mode=discover-only and --respect-config set).\n');
    } else if (!provider.syncPluginInventory) {
      process.stdout.write(`  push: provider '${provider.id}' does not support syncPluginInventory; skipped.\n`);
    } else {
      const plugins = [...ws.plugins.values()].filter((p) => !p.id.startsWith('client:'));
      const marketplaces = readAllMarketplaces(cfg.globalDir);
      try {
        const report = await provider.syncPluginInventory(ctx, {
          plugins,
          marketplaces,
          dryRun: parsed.dryRun,
          bidirectionalUninstall: cfg.clientSync.bidirectionalUninstall,
        });
        result.syncReport = report;
        process.stdout.write(`  push: ${parsed.dryRun ? '(dry-run) ' : ''}sync report:\n`);
        process.stdout.write(renderSyncReport(report) + '\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  push: syncPluginInventory failed: ${msg}\n`);
        logger.warn({ err: msg }, 'syncPluginInventory failed');
      }
    }
  }

  return result;
}
