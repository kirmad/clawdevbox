// mcp-server/src/cli-sessions/tmux-session-runtime.ts
import { tmuxRunAsync, type TmuxClientOpts } from './tmux-client.ts';
import { createTmuxSession, adoptTmuxSession } from './tmux-session.ts';
import type { CliSession, CliSessionRuntime, CliSessionSpawnOpts } from './types.ts';


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
        // Session name is the first token (before any colon or space)
        const sessionName = n.split(/[:(\s]/)[0];
        if (sessionName.startsWith('cdb_')) out.push({ name: sessionName, alive: true });
      }
      return out;
    },
  };
}

/**
 * Singleton tmux session lookup for dispatcher consumption.
 *
 * In T13 this is populated by `initTmuxSessionRuntime()` at boot and
 * `provider.spawnSession` populates entries. For T10 (this commit) we
 * ship a stub-only `get()` so the dispatcher compiles + can be wired
 * incrementally; production callers will see `null` until T13 lands.
 *
 * Test code that needs to inject a session uses `__register`.
 */
const liveSessions = new Map<string, CliSession>();

export const tmuxSessionRegistry = {
  get(instanceId: string): CliSession | null {
    return liveSessions.get(instanceId) ?? null;
  },
  /** TEST/runtime hatch: register a live tmux session for an instance id. */
  __register(instanceId: string, session: CliSession): void {
    liveSessions.set(instanceId, session);
  },
  /** TEST/runtime hatch: remove a session from the registry. */
  __unregister(instanceId: string): void {
    liveSessions.delete(instanceId);
  },
  /** TEST hatch: reset the registry between tests. */
  __resetForTests(): void {
    liveSessions.clear();
  },
};
