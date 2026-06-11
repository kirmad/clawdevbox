// mcp-server/src/cli-sessions/tmux-session-runtime.ts
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { tmuxRun, tmuxRunAsync, type TmuxClientOpts } from './tmux-client.ts';
import { createTmuxSession, adoptTmuxSession } from './tmux-session.ts';
import type { CliSession, CliSessionRuntime, CliSessionSpawnOpts } from './types.ts';
import { emitChange } from '../event-bus.ts';

// ============================================================================
// Runtime factory (unchanged from T6)
// ============================================================================

// Per-runtime cached `list()` result. Spawning `tmux list-sessions` costs
// ~100ms on Windows psmux (subprocess fork is slow), and the SPA polls
// /api/sessions every 2s, so without a cache every poll forks a child.
// 1 second TTL keeps the response fresh enough for UI updates while
// coalescing back-to-back probes from the SPA + terminal-server +
// dispatcher into a single subprocess.
const LIST_CACHE_TTL_MS = 1000;
interface ListCacheEntry {
  ts: number;
  value: Array<{ name: string; alive: boolean }>;
  inflight: Promise<Array<{ name: string; alive: boolean }>> | null;
}
const listCaches = new WeakMap<TmuxClientOpts, ListCacheEntry>();

export function createTmuxSessionRuntime(client: TmuxClientOpts): CliSessionRuntime {
  return {
    async spawn(opts: CliSessionSpawnOpts): Promise<CliSession> {
      return createTmuxSession(client, opts);
    },
    async attach(name: string): Promise<CliSession | null> {
      return adoptTmuxSession(client, name);
    },
    async list(): Promise<Array<{ name: string; alive: boolean }>> {
      const now = Date.now();
      let cache = listCaches.get(client);
      if (cache) {
        if (cache.inflight) return cache.inflight;
        if (now - cache.ts < LIST_CACHE_TTL_MS) return cache.value;
      } else {
        cache = { ts: 0, value: [], inflight: null };
        listCaches.set(client, cache);
      }
      cache.inflight = (async () => {
        try {
          const r = await tmuxRunAsync(client, ['list-sessions', '-F', '#{session_name}']);
          if (r.exitCode !== 0) return [];
          const out: Array<{ name: string; alive: boolean }> = [];
          for (const line of r.stdout.split('\n')) {
            const n = line.trim();
            const sessionName = n.split(/[:(\s]/)[0];
            if (sessionName) out.push({ name: sessionName, alive: true });
          }
          return out;
        } finally {
          // Reset inflight before storing so concurrent callers see
          // the new cache.value on the next call instead of a stale promise.
          cache!.inflight = null;
        }
      })();
      const value = await cache.inflight;
      cache.value = value;
      cache.ts = Date.now();
      return value;
    },
  };
}

// ============================================================================
// Process-global registry: instanceId -> CliSession
// ============================================================================

class TmuxSessionRegistry {
  private map = new Map<string, CliSession>();

  /**
   * Production registration: registers and hooks auto-unregister on the
   * session's exit promise. Use from provider spawnSession paths.
   *
   * Emits 'sessions' on both register and exit so the SPA's realtime
   * channel refreshes the Terminals tab without manual reload.
   */
  register(instanceId: string, session: CliSession): void {
    this.map.set(instanceId, session);
    emitChange('sessions');
    session.exited.then(() => {
      if (this.map.get(instanceId) === session) {
        this.map.delete(instanceId);
        emitChange('sessions');
      }
    });
  }

  get(instanceId: string): CliSession | null {
    return this.map.get(instanceId) ?? null;
  }

  unregister(instanceId: string): void {
    this.map.delete(instanceId);
  }

  list(): Array<{ instanceId: string; sessionName: string }> {
    return [...this.map.entries()].map(([instanceId, s]) => ({ instanceId, sessionName: s.name }));
  }

  // ----- Test hatches: preserved API from T10 stub ----------------------------
  /** TEST/runtime hatch: register without exit hook. Prefer `register()` in prod. */
  __register(instanceId: string, session: CliSession): void {
    this.map.set(instanceId, session);
  }

  __unregister(instanceId: string): void {
    this.map.delete(instanceId);
  }

  __resetForTests(): void {
    this.map.clear();
  }
}

export const tmuxSessionRegistry = new TmuxSessionRegistry();

// ============================================================================
// Process-global singleton runtime
// ============================================================================

let _runtime: CliSessionRuntime | null = null;

export function initTmuxSessionRuntime(client: TmuxClientOpts): void {
  _runtime = createTmuxSessionRuntime(client);
}

export function tmuxSessionRuntime(): CliSessionRuntime {
  if (!_runtime) {
    throw new Error(
      'tmuxSessionRuntime not initialized — call initTmuxSessionRuntime() at startup',
    );
  }
  return _runtime;
}

/** TEST hatch: reset singleton between tests. */
export function _resetTmuxSessionRuntimeForTests(): void {
  _runtime = null;
}

// ============================================================================
// Startup reconciliation
// ============================================================================

/**
 * On startup: query tmux for all cdb_* sessions, match against the DB's
 * running agent_sessions rows. Adopt matches (re-create CliSession handles
 * for the existing tmux sessions), mark orphans as crashed.
 *
 * Returns count of adopted + orphaned for logging.
 */
export async function reconcileOnStartup(
  db: Database,
): Promise<{ adopted: number; orphaned: number }> {
  const runtime = tmuxSessionRuntime();
  const live = await runtime.list();
  // tmux session names are `cdb_<recipe_instance_id>` — strip prefix to get
  // the recipe_instance_id (which is what tmuxSessionRegistry keys on and
  // dispatcher.dispatchToInstance looks up).
  const liveInstanceIds = new Set<string>();
  for (const item of live) {
    if (item.name.startsWith('cdb_')) {
      liveInstanceIds.add(item.name.replace(/^cdb_/, ''));
    }
  }

  type Row = { id: string; recipe_instance_id: string | null };
  const rows = db.prepare(
    `SELECT id, recipe_instance_id FROM agent_sessions WHERE status = 'running'`,
  ).all() as Row[];

  let adopted = 0;
  let orphaned = 0;
  const now = Date.now();
  for (const row of rows) {
    const instanceId = row.recipe_instance_id;
    if (instanceId && liveInstanceIds.has(instanceId)) {
      const session = await runtime.attach(instanceId);
      if (session) {
        tmuxSessionRegistry.register(instanceId, session);
        adopted++;
      } else {
        db.prepare(`UPDATE agent_sessions SET status = 'failure', ended_at = ? WHERE id = ?`).run(now, row.id);
        orphaned++;
      }
    } else {
      db.prepare(`UPDATE agent_sessions SET status = 'failure', ended_at = ? WHERE id = ?`).run(now, row.id);
      orphaned++;
    }
  }
  return { adopted, orphaned };
}

// ============================================================================
// Orphan tmux re-adoption on startup
// ============================================================================

/**
 * On Windows, when clawdevbox dies (clean restart, OOM, hard kill,
 * `taskkill /F`), its child tmux servers don't die — they become orphans,
 * and the agency/copilot/claude processes inside keep running. We want
 * to KEEP those sessions alive across restarts so the user's in-flight
 * agent work continues uninterrupted; the reconcileOnStartup pass below
 * will rebind them to the new clawdevbox process.
 *
 * What this sweep does on a fresh boot:
 *   - Walks every `cdb_*` tmux session
 *   - Re-tags it with the CURRENT process's PID via
 *     `tmux set-environment CDB_CREATOR_PID`, so future sweeps from a
 *     subsequent restart can still distinguish "owned by another live
 *     clawdevbox instance" vs "orphan from a dead one"
 *   - Returns the session names so the caller can pass them through to
 *     reconcileOnStartup
 *
 * What it does NOT do anymore: kill orphan sessions. Killing them
 * defeats the whole point of tmux persistence (the user's work
 * disappears on every restart). True abandonment (no viewer, no agent
 * activity) is handled by the idle-reaper, not by the boot sweep.
 *
 * Sessions belonging to *another* running clawdevbox instance — i.e.
 * whose CDB_CREATOR_PID is currently alive AND not this process — are
 * left untouched (we don't re-tag them; the other instance still owns
 * them).
 *
 * Returns counts + per-session diagnostics so the caller can log a
 * summary line.
 */
export interface SweepResult {
  retagged: number;
  kept: number;
  details: Array<{
    name: string;
    creatorPid: number | null;
    action: 'retagged' | 'kept' | 'failed';
  }>;
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — it just checks process existence and
    // throws ESRCH/EPERM otherwise. Works on Windows + Unix.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function sweepStaleTmuxSessions(client: TmuxClientOpts): Promise<SweepResult> {
  const list = await tmuxRunAsync(client, ['list-sessions', '-F', '#{session_name}']);
  const result: SweepResult = { retagged: 0, kept: 0, details: [] };
  if (list.exitCode !== 0) return result;

  const sessionNames = list.stdout
    .split('\n')
    .map((l) => l.trim().split(/[:(\s]/)[0])
    .filter((n) => n && n.startsWith('cdb_'));

  const myPid = process.pid;
  for (const name of sessionNames) {
    const env = tmuxRun(client, ['show-environment', '-t', name, 'CDB_CREATOR_PID']);
    let creatorPid: number | null = null;
    if (env.exitCode === 0) {
      const m = env.stdout.trim().match(/^CDB_CREATOR_PID=(\d+)/m);
      if (m) creatorPid = Number(m[1]);
    }

    // Owned by ANOTHER live clawdevbox instance — leave it alone.
    if (creatorPid != null && creatorPid !== myPid && isPidAlive(creatorPid)) {
      result.kept++;
      result.details.push({ name, creatorPid, action: 'kept' });
      continue;
    }

    // Either no tag, tag points to a dead PID, or tag is already ours
    // (idempotent re-tag on multiple sweeps within one boot). Adopt by
    // re-tagging with our PID. The reconcileOnStartup pass that runs
    // immediately after this sweep will rebind the session to its DB row.
    const retag = tmuxRun(client, [
      'set-environment', '-t', name, 'CDB_CREATOR_PID', String(myPid),
    ]);
    if (retag.exitCode === 0) {
      result.retagged++;
      result.details.push({ name, creatorPid, action: 'retagged' });
    } else {
      result.details.push({ name, creatorPid, action: 'failed' });
    }
  }
  return result;
}

// ============================================================================
// Bundled tmux.conf locator
// ============================================================================

/**
 * Resolve the bundled `assets/cdb.tmux.conf` path. Returns null if not
 * found — callers should pass null configPath to tmux client opts and
 * fall back to tmux defaults.
 *
 * Searches both dev-mode (src/cli-sessions → ../../assets) and dist-mode
 * (dist/cli-sessions → ../assets) layouts.
 */
export function bundledTmuxConfPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../assets/cdb.tmux.conf'),       // dev: src/cli-sessions/...
    resolve(here, '../assets/cdb.tmux.conf'),          // dist: dist/cli-sessions/...
    resolve(process.cwd(), 'mcp-server/assets/cdb.tmux.conf'),
    resolve(process.cwd(), 'assets/cdb.tmux.conf'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
