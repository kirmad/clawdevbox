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
