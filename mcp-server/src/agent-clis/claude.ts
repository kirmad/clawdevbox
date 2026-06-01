import { join } from 'node:path';
import os from 'node:os';
import { writeMcpJson, probeBinary, cliPluginSync, cliPluginDiscover, buildVaultPluginDirArgs } from './shared.ts';
import { tmuxSessionRuntime, tmuxSessionRegistry } from '../cli-sessions/tmux-session-runtime.ts';
import type {
  AgentCliProvider,
  AgentHandle,
  DiscoveredPlugin,
  ProviderCapabilities,
  ProviderCtx,
  SpawnSessionOpts,
  SyncPluginInventoryOpts,
  SyncReport,
  WritePromptOpts,
} from './types.ts';

function resolveBinary(): { file: string; argsPrefix: string[] } {
  const env = process.env.CLAWDEVBOX_CLAUDE_PATH;
  if (env) return { file: env, argsPrefix: [] };
  if (process.platform === 'win32') return { file: 'cmd.exe', argsPrefix: ['/d', '/s', '/c', 'claude'] };
  return { file: 'claude', argsPrefix: [] };
}

const CLAUDE_PLUGIN_CACHE = join(os.homedir(), '.claude', 'plugins', 'cache');

// Empirically derived from files/queue-done-spike/. Claude Code 2.1.138's
// REPL accepts a single `pty.write(prompt + '\r')` (no 250ms gap required)
// and has no observable native queue feature — `\x11` has no effect, and
// `claude --help` shows no queue/enqueue flag. The conductor must buffer
// follow-up prompts locally and drain them as a coalesced delivery on
// next idle.
//
// promptReadyRegex notes:
//   Claude's input bar layout is `═══...═══❯\u00a0   Model: Opus 4.7 | ...`
//   on a SINGLE line — i.e. the prompt glyph is followed by a non-breaking
//   space (NBSP, U+00A0) and then the status bar. The previous regex
//   `/❯[^\S\n]*$/m` required the line to END in whitespace after `❯`
//   which never matched (status bar text breaks the trailing-whitespace
//   condition). New regex matches `❯` followed by NBSP or regular space
//   ANYWHERE — that's specific enough since claude only emits `❯` as the
//   input bar cursor. Discovered via debug-claude-glyph probe.
const claudeCapabilities: ProviderCapabilities = {
  queueMode: 'none',
  promptSubmitStrategy: 'bulk-cr',
  promptReadyRegex: /❯[ \u00a0]/,
  busyIndicators: [/Working/i, /thinking/i],
};

export const claudeProvider: AgentCliProvider = {
  id: 'claude',
  displayName: 'Anthropic Claude Code',
  description: 'The Anthropic Claude Code CLI (`claude`). Supports headless prompts and resumable sessions.',
  source: 'builtin',
  capabilities: claudeCapabilities,
  supportsResume: true,

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
    if (opts.agent) {
      argv.push('--agent', opts.agent);
    }
    if (opts.model) {
      argv.push('--model', opts.model);
    }
    argv.push(...buildVaultPluginDirArgs(opts.pluginDirs));
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('claude: headless mode requires opts.prompt');
      argv.push('-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    // Tmux-backed spawn (T16) — see copilot.ts for full rationale. xterm.js
    // viewers attach via `tmux attach` so capability-reply bytes go to tmux,
    // not into claude's input box. Spawn factory comes from ctx (test mocking).
    const instanceKey = opts.recipeInstanceId ?? opts.init.session_id;
    const spawn = ctx.spawnTmuxSession ?? ((o) => tmuxSessionRuntime().spawn(o));
    const session = await spawn({
      name: instanceKey,
      cwd: opts.workspaceInfo.path,
      env,
      cols: opts.ptyCols ?? 120,
      rows: opts.ptyRows ?? 30,
      command: file,
      args: argv,
    });

    if (opts.recipeInstanceId) {
      tmuxSessionRegistry.register(opts.recipeInstanceId, session);
    }

    const handle: AgentHandle = {
      pid: await session.pid(),
      sessionId: opts.init.session_id,
      session,
      exited: session.exited.then((e) => ({
        exitCode: e.exitCode ?? 0,
        signal: undefined,
      })),
    };

    // Initial prompt delivery: deferred to T18 (dispatcher first-dispatch with
    // snapshot-poll readiness). The deliverInitialPromptWhenReady helper is no
    // longer needed because tmux attach absorbs xterm.js capability replies.

    return handle;
  },

  async writePrompt(handle: AgentHandle, { text, strategy }: WritePromptOpts): Promise<void> {
    if (strategy === 'queue') {
      throw new Error('claude: queue strategy not supported (queueMode is "none"); caller must downgrade to local buffering');
    }
    const session = handle.session;
    if (!session) {
      throw new Error('claude.writePrompt: handle.session is missing — claude must be tmux-migrated');
    }
    // ESC dismisses overlays + clears the input box. Send alone with a 200ms
    // gap so terminals don't interpret `ESC <byte>` as `Alt+<byte>`.
    await session.sendKey('Escape');
    await new Promise((r) => setTimeout(r, 200));
    await session.sendText(text);
    await session.sendKey('Enter');
  },

  async syncPluginInventory(ctx: ProviderCtx, opts: SyncPluginInventoryOpts): Promise<SyncReport> {
    const { file, argsPrefix } = resolveBinary();
    return cliPluginSync(ctx, opts, {
      binary: file,
      argsPrefix,
      pluginCacheDir: CLAUDE_PLUGIN_CACHE,
    });
  },

  async discoverInstalledPlugins(ctx: ProviderCtx): Promise<DiscoveredPlugin[]> {
    const { file, argsPrefix } = resolveBinary();
    return cliPluginDiscover(ctx, {
      binary: file,
      argsPrefix,
      pluginCacheDir: CLAUDE_PLUGIN_CACHE,
    });
  },
};
