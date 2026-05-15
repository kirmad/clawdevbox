import { writeMcpJson, probeBinary } from './shared.ts';
import type { AgentCliProvider, AgentHandle, ProviderCtx, SpawnSessionOpts } from './types.ts';

function resolveBinary(): { file: string; argsPrefix: string[] } {
  const env = process.env.CLAWDEVBOX_CLAUDE_PATH;
  if (env) return { file: env, argsPrefix: [] };
  if (process.platform === 'win32') return { file: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', 'claude'] };
  return { file: 'claude', argsPrefix: [] };
}

export const claudeProvider: AgentCliProvider = {
  id: 'claude',
  displayName: 'Anthropic Claude Code',
  description: 'The Anthropic Claude Code CLI (`claude`). Supports headless prompts and resumable sessions.',
  source: 'builtin',

  async detect(_ctx: ProviderCtx) {
    const { file, argsPrefix } = resolveBinary();
    return probeBinary(file, [...argsPrefix, '--version']);
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const { file, argsPrefix } = resolveBinary();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);

    const sessionArgs = opts.init.kind === 'new'
      ? ['--session-id', opts.init.session_id]
      : ['--resume', opts.init.session_id];

    const argv: string[] = [...argsPrefix, ...sessionArgs];
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('claude: headless mode requires opts.prompt');
      argv.push('-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(file, argv, {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });

    return {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) => pty.onExit(({ exitCode, signal }) =>
        resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };
  },
};
