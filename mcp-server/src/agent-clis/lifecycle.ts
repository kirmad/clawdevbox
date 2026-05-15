/**
 * agent-clis/lifecycle.ts
 *
 * Bidirectional plugin sync lifecycle helper (spec §6).
 *
 * `maybeRunClientSync` is invoked at kernel boot and after plugin /
 * marketplace mutations. It honors `cfg.clientSync.mode`:
 *
 *   - 'off'           : no-op.
 *   - 'manual'        : no-op (only the `clawdevbox plugin sync` subcommand runs).
 *   - 'discover-only' : pull side (CLI -> clawdevbox) only.
 *   - 'auto'          : both directions.
 *
 * Failures degrade to WARN logs — they never abort the calling clawdevbox
 * operation. Direction A (push) calls the configured provider's
 * `syncPluginInventory`. Direction B (pull) calls `discoverInstalledPlugins`
 * and registers opted-in plugins into `ws.plugins` under the synthetic id
 * `client:<provider>:<name>`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.ts';
import { loadPluginFromDir, LoadPluginError } from '../manifest/load-plugin.ts';
import { buildProviderCtx } from './shared.ts';
import type { ResolvedConfig } from '../config.ts';
import type { Workspace } from '../workspace.ts';
import type { AgentCliProvider, MarketplaceRecord, SyncReport } from './types.ts';

export type LifecycleEvent =
  | 'boot'
  | 'plugin-install'
  | 'plugin-uninstall'
  | 'marketplace-add'
  | 'marketplace-remove'
  | 'config-change';

export interface LifecycleResult {
  ran: boolean;
  syncReport?: SyncReport;
  discoveredCount?: number;
  registeredCount?: number;
  reason?: string;
}

function readAllMarketplaces(cfg: ResolvedConfig): MarketplaceRecord[] {
  const dir = join(cfg.globalDir, 'marketplaces');
  if (!existsSync(dir)) return [];
  const out: MarketplaceRecord[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
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

function resolveConfiguredProvider(
  ws: Workspace,
  cfg: ResolvedConfig,
): AgentCliProvider | null {
  const id = cfg.defaultAgentCli ?? 'copilot';
  return ws.agentCliProviders.get(id) ?? null;
}

/**
 * Direction B: load each opted-in client-installed plugin into ws.plugins
 * with id `client:<provider>:<name>`. Only registers entries whose manifest
 * carries a non-empty `clawdevbox` extension block (other plugins add nothing
 * to clawdevbox and stay purely client-side).
 *
 * Returns the number of plugins newly registered. Errors are logged and the
 * helper continues with the next entry.
 */
export async function loadClientDiscoveredPlugins(
  ws: Workspace,
  cfg: ResolvedConfig,
  provider: AgentCliProvider,
): Promise<{ discovered: number; registered: number }> {
  if (!provider.discoverInstalledPlugins) return { discovered: 0, registered: 0 };
  // Drop any stale client-registered entries before re-scanning so removed
  // opt-ins don't linger after a config change.
  const clientPrefix = `client:${provider.id}:`;
  for (const key of [...ws.plugins.keys()]) {
    if (key.startsWith(clientPrefix)) ws.plugins.delete(key);
  }
  const optedIn = new Set(
    cfg.clientSync.discoveredPlugins
      .filter((d) => d.provider === provider.id)
      .map((d) => d.name),
  );
  let discovered: Awaited<ReturnType<typeof provider.discoverInstalledPlugins>>;
  try {
    discovered = await provider.discoverInstalledPlugins(buildProviderCtx(ws, cfg));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), provider: provider.id },
      'discoverInstalledPlugins failed',
    );
    return { discovered: 0, registered: 0 };
  }
  let registered = 0;
  for (const d of discovered) {
    if (optedIn.size > 0 && !optedIn.has(d.name)) continue;
    let loaded;
    try {
      loaded = await loadPluginFromDir(d.absoluteDir);
    } catch (err) {
      if (!(err instanceof LoadPluginError) || err.code !== 'MISSING_MANIFEST') {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), dir: d.absoluteDir },
          'failed to load client-discovered plugin',
        );
      }
      continue;
    }
    const cdx = loaded.manifest.clawdevbox;
    const hasClawdevboxExt =
      cdx !== undefined &&
      ((cdx.recipes && cdx.recipes.length > 0) ||
        (cdx.tools && cdx.tools.length > 0) ||
        (cdx.trigger_types && cdx.trigger_types.length > 0) ||
        (cdx.agent_clis && cdx.agent_clis.length > 0) ||
        (cdx.renderers && cdx.renderers.length > 0));
    if (!hasClawdevboxExt) continue;
    if (optedIn.size === 0) {
      // Auto-mode discovery with no opt-in list: log only, don't register.
      logger.info(
        { plugin: d.name, provider: provider.id },
        "client plugin with clawdevbox extensions detected; opt in via 'clawdevbox init' or client_sync.discovered_plugins",
      );
      continue;
    }
    const entryId = `${clientPrefix}${d.name}`;
    ws.plugins.set(entryId, {
      id: entryId,
      dir: d.absoluteDir,
      manifest: loaded.manifest,
      capabilities: loaded.capabilities,
      agencyJson: loaded.agencyJson,
      loadErrors: loaded.loadErrors,
      status: 'enabled',
    });
    registered++;
  }
  return { discovered: discovered.length, registered };
}

export async function maybeRunClientSync(
  ws: Workspace,
  cfg: ResolvedConfig,
  event: LifecycleEvent,
): Promise<LifecycleResult> {
  if (cfg.clientSync.mode === 'off' || cfg.clientSync.mode === 'manual') {
    return { ran: false, reason: `clientSync.mode=${cfg.clientSync.mode}` };
  }
  const provider = resolveConfiguredProvider(ws, cfg);
  if (!provider) {
    return { ran: false, reason: 'no configured provider' };
  }

  // Skip when the CLI binary isn't on PATH — avoids spamming WARNs on every
  // plugin.install / plugin.uninstall in test environments without a real CLI.
  if (provider.detect) {
    try {
      const det = await provider.detect(buildProviderCtx(ws, cfg));
      if (!det.available) return { ran: false, reason: `provider ${provider.id} not available` };
    } catch {
      return { ran: false, reason: `provider ${provider.id} detect threw` };
    }
  }

  const result: LifecycleResult = { ran: true };

  // Direction A: push clawdevbox state into the CLI (skipped in discover-only).
  if (cfg.clientSync.mode !== 'discover-only' && provider.syncPluginInventory) {
    const clawdevboxPlugins = [...ws.plugins.values()].filter(
      (p) => !p.id.startsWith('client:'),
    );
    const marketplaces = readAllMarketplaces(cfg);
    try {
      const report = await provider.syncPluginInventory(buildProviderCtx(ws, cfg), {
        plugins: clawdevboxPlugins,
        marketplaces,
        bidirectionalUninstall: cfg.clientSync.bidirectionalUninstall,
      });
      result.syncReport = report;
      logger.info(
        {
          event,
          provider: provider.id,
          marketplacesAdded: report.marketplacesAdded.length,
          pluginsInstalled: report.pluginsInstalled.length,
          pluginsUninstalled: report.pluginsUninstalled.length,
          failed: report.failed.length,
        },
        'client plugin sync done',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), event, provider: provider.id },
        'syncPluginInventory failed',
      );
    }
  }

  // Direction B: pull discovered plugins into ws.plugins.
  try {
    const r = await loadClientDiscoveredPlugins(ws, cfg, provider);
    result.discoveredCount = r.discovered;
    result.registeredCount = r.registered;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), event, provider: provider.id },
      'loadClientDiscoveredPlugins failed',
    );
  }

  return result;
}
