// mcp-server/src/cli-sessions/tmux-session-runtime.ts
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { tmuxRunAsync, type TmuxClientOpts } from './tmux-client.ts';
import { createTmuxSession, adoptTmuxSession } from './tmux-session.ts';
import type { CliSession, CliSessionRuntime, CliSessionSpawnOpts } from './types.ts';

// ============================================================================
// Runtime factory (unchanged from T6)
// ============================================================================

export function createTmuxSessionRuntime(client: TmuxClientOpts): CliSessionRuntime {
  return {
    async spawn(opts: CliSessionSpawnOpts): Promise<CliSession> {
      return createTmuxSession(client, opts);
    },
    async attach(name: string): Promise<CliSession | null> {
      return adoptTmuxSession(client, name);
    },
    async list(): Promise<Array<{ name: string; alive: boolean }>> {
      const r = await tmuxRunAsync(client, ['list-sessions', '-F', '#{session_name}']);
      // psmux returns exitCode 0 with empty stdout if no server; real tmux returns 1
      if (r.exitCode !== 0) return [];
      const out: Array<{ name: string; alive: boolean }> = [];
      for (const line of r.stdout.split('\n')) {
        const n = line.trim();
        const sessionName = n.split(/[:(\s]/)[0];
        // Return ALL sessions (cdb_* + foreign). Callers filter as needed:
        // reconcile adopts only cdb_* below; /api/sessions surfaces foreign
        // sessions in the UI with a dimmer style.
        if (sessionName) out.push({ name: sessionName, alive: true });
      }
      return out;
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
   */
  register(instanceId: string, session: CliSession): void {
    this.map.set(instanceId, session);
    session.exited.then(() => {
      if (this.map.get(instanceId) === session) this.map.delete(instanceId);
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
