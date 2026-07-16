/**
 * plugin-daemons.ts — sync plugin-declared daemons to the daemons table.
 *
 * Each enabled plugin's `capabilities.daemons[]` becomes a row in the
 * `daemons` table. This is the bridge from "plugin manifest says X
 * should always be running" to "supervisor sees X in desired-state
 * and keeps it alive".
 *
 * Reconcile semantics:
 *   - For every (plugin-id, daemon-id) pair declared by an ENABLED
 *     plugin: upsert via `upsertDaemon` with enabled=true.
 *   - For every (plugin-id, daemon-id) pair declared by a DISABLED
 *     plugin (status='disabled' OR status='error'): upsert with
 *     enabled=false. The supervisor stops live runs of disabled
 *     daemons on its next tick.
 *   - For every daemon row in the DB with the `plugin:<id>` source
 *     tag whose plugin no longer declares it (or whose plugin was
 *     uninstalled entirely): delete the row. The supervisor's row
 *     watcher tears down the live run.
 *
 * Daemon ids must be stable across plugin reloads — they're the
 * upsert key, so renaming a daemon id = creating a new daemon (the
 * old one will be deleted on reconcile).
 *
 * Daemons NOT sourced by a plugin (e.g. ad-hoc registrations via
 * `daemon.register` MCP tool) are untouched.
 */

import type { Database } from 'better-sqlite3';
import { join } from 'node:path';
import type { Workspace } from './workspace.ts';
import type { ResolvedDaemon } from './manifest/load-plugin.ts';
import { upsertDaemon, deleteDaemon, listDaemons, getDaemon } from './db/daemons-store.ts';
import type { DaemonRuntime } from './db/daemons-store.ts';
import { ensureWorkspace } from './db/workspaces-store.ts';
import { logger } from './logger.ts';

/**
 * Tag used to mark daemons that came from a plugin manifest. We store
 * it in the daemon's `env` so the reconcile pass can identify
 * plugin-owned rows on the next reload (vs. ad-hoc registrations).
 *
 * Format: `<CLAWDEVBOX_DAEMON_SOURCE_KEY>=plugin:<plugin-id>:<daemon-id>`
 */
export const DAEMON_SOURCE_ENV_KEY = '__CLAWDEVBOX_DAEMON_SOURCE';

function buildSourceTag(pluginId: string, daemonId: string): string {
  return `plugin:${pluginId}:${daemonId}`;
}

function parseSourceTag(env: Record<string, string>): { pluginId: string; daemonId: string } | null {
  const tag = env[DAEMON_SOURCE_ENV_KEY];
  if (!tag) return null;
  const m = tag.match(/^plugin:([^:]+):(.+)$/);
  if (!m) return null;
  return { pluginId: m[1]!, daemonId: m[2]! };
}

/**
 * Reconcile plugin-declared daemons against the `daemons` table.
 * Idempotent — safe to call on every plugin reload.
 *
 * `workspaceId` is the FK target for the upserted rows. If undefined,
 * we use the workspace whose `path` matches `ws.projectDir`, creating
 * it lazily via `ensureWorkspace` if it doesn't exist yet.
 *
 * Returns a summary so callers can log a single line, plus the list
 * of daemon ids whose spec actually changed (so the caller can ask
 * the supervisor to force-restart them — without that, the live
 * process keeps running the OLD command until it exits on its own).
 */
export interface ReconcileResult {
  upserted: number;
  disabled: number;
  deleted: number;
  /** Daemon ids whose command / env / cwd / restart_policy changed since
   *  the last reconcile, OR which are newly enabled. The caller (e.g.
   *  plugin.install in tools/plugin.ts) should `supervisor.restart()`
   *  each of these so the live process picks up the new spec. */
  changed: string[];
}

export function reconcilePluginDaemons(db: Database, ws: Workspace): ReconcileResult {
  const result: ReconcileResult = { upserted: 0, disabled: 0, deleted: 0, changed: [] };

  // 1. Resolve the FK workspace once.
  const workspace = ensureWorkspace(db, {
    path: ws.projectDir,
    name: 'clawdevbox',
  });

  // 2. Collect the desired daemon set from every plugin (enabled+disabled).
  //    Errored plugins still surface their daemons here, just as disabled —
  //    so we can flip them back to enabled when the user fixes the manifest.
  type Desired = { pluginId: string; entry: ResolvedDaemon; pluginEnabled: boolean };
  const desired: Desired[] = [];
  for (const [pluginId, plugin] of ws.plugins) {
    const daemons = plugin.capabilities.daemons ?? [];
    for (const entry of daemons) {
      desired.push({
        pluginId,
        entry,
        pluginEnabled: plugin.status === 'enabled',
      });
    }
  }

  const desiredByDaemonId = new Map<string, Desired>();
  for (const d of desired) desiredByDaemonId.set(d.entry.id, d);

  // 3. List existing rows; categorize which are plugin-sourced.
  const existing = listDaemons(db);
  const existingPluginOwned = new Map<string, { rowId: string; source: { pluginId: string; daemonId: string } }>();
  for (const row of existing) {
    let env: Record<string, string> = {};
    try { env = JSON.parse(row.env_json); } catch { /* skip */ }
    const tag = parseSourceTag(env);
    if (!tag) continue;
    existingPluginOwned.set(tag.daemonId, { rowId: row.id, source: tag });
  }

  // 4. Upsert each desired daemon. Track which ones actually changed so
  //    the caller can ask the supervisor to force-restart them.
  for (const { pluginId, entry, pluginEnabled } of desired) {
    const command = buildCommand(entry);
    const env: Record<string, string> = {
      ...entry.env,
      [DAEMON_SOURCE_ENV_KEY]: buildSourceTag(pluginId, entry.id),
    };
    const cwd = plugin_cwd(ws, pluginId);

    // Capture the prior row (if any) so we can detect spec-drift.
    const prior = getDaemon(db, entry.id);
    const priorChanged = prior !== null && hasSpecChanged(prior, {
      command, cwd, env, enabled: pluginEnabled,
    });
    const isNew = prior === null;

    try {
      upsertDaemon(db, {
        id: entry.id,
        name: entry.name,
        workspace_id: workspace.id,
        runtime: 'direct',  // runtime is resolved INTO the command itself
        command,
        cwd,
        env,
        enabled: pluginEnabled,
        restart_policy: entry.restart_policy,
      });
      if (pluginEnabled) {
        result.upserted += 1;
      } else {
        result.disabled += 1;
      }
      // Restart the live process iff anything materially changed (or new).
      if (isNew || priorChanged) {
        result.changed.push(entry.id);
      }
    } catch (err) {
      logger.warn(
        { pluginId, daemonId: entry.id, err: err instanceof Error ? err.message : String(err) },
        'plugin-daemons: upsert failed',
      );
    }
  }

  // 5. Delete rows whose source plugin no longer declares them (or whose
  //    source plugin was uninstalled).
  for (const [daemonId, info] of existingPluginOwned) {
    if (desiredByDaemonId.has(daemonId)) continue;
    try {
      deleteDaemon(db, info.rowId);
      result.deleted += 1;
    } catch (err) {
      logger.warn(
        { rowId: info.rowId, err: err instanceof Error ? err.message : String(err) },
        'plugin-daemons: delete failed',
      );
    }
  }

  return result;
}

/**
 * Compare the supervisor-visible fields of a prior daemon row against
 * the new desired spec. Returns true if any field that would affect
 * the live process has changed (command, env, cwd, enabled).
 *
 * `restart_policy` changes don't trigger a restart — they apply to
 * future exit handling, not the live run.
 */
function hasSpecChanged(
  prior: { command_json: string; env_json: string; cwd: string | null; enabled: number },
  next: { command: string[]; env: Record<string, string>; cwd: string; enabled: boolean },
): boolean {
  if (!!prior.enabled !== next.enabled) return true;
  if ((prior.cwd ?? '') !== next.cwd) return true;
  // Command + env compare via JSON canonical form — same key/value content.
  if (prior.command_json !== JSON.stringify(next.command)) return true;
  if (prior.env_json !== JSON.stringify(next.env)) return true;
  return false;
}

/**
 * Map a `ResolvedDaemon.runtime` to the actual argv that the supervisor
 * will spawn. We resolve the runtime into the command rather than
 * delegating to the supervisor's `runtime` enum because the supervisor's
 * `runtime: 'node'` etc. expects different shape conventions; the safe
 * universal path is `runtime: 'direct'` + explicit interpreter prefix.
 */
function buildCommand(entry: ResolvedDaemon): string[] {
  const script = entry.absoluteFile;
  switch (entry.runtime) {
    case 'node':
    case 'direct':
      // Node script — invoke via the same node binary running clawdevbox.
      return [process.execPath, script];
    case 'tsx':
      // .ts script — `npx tsx <script>` is the most portable invocation.
      // Avoid hard-coding a tsx binary path; the user's environment is
      // expected to have npm/npx.
      return [process.execPath, '--import', 'tsx', script];
    case 'python':
      return [process.platform === 'win32' ? 'python.exe' : 'python', script];
    case 'bash':
      return ['bash', script];
    case 'pwsh':
      return ['pwsh', '-File', script];
    default:
      return [process.execPath, script];
  }
}

/**
 * Resolve the CWD for a plugin's daemon: the plugin's installed root
 * (so relative file references inside the daemon script resolve
 * predictably).
 */
function plugin_cwd(ws: Workspace, pluginId: string): string {
  const plugin = ws.plugins.get(pluginId);
  return plugin?.dir ?? ws.projectDir;
}
