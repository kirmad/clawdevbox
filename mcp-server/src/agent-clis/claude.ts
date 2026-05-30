import { join } from 'node:path';
import os from 'node:os';
import { writeMcpJson, probeBinary, cliPluginSync, cliPluginDiscover, buildVaultPluginDirArgs, deliverInitialPromptWhenReady } from './shared.ts';
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
const claudeCapabilities: ProviderCapabilities = {
  queueMode: 'none',
  promptSubmitStrategy: 'bulk-cr',
  promptReadyRegex: /❯[^\S\n]*$/m,
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
    argv.push(...buildVaultPluginDirArgs(opts.pluginDirs));
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('claude: headless mode requires opts.prompt');
      argv.push('-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(file, argv, {
      cwd: opts.workspaceInfo.path, env,
      cols: opts.ptyCols ?? 120, rows: opts.ptyRows ?? 30,
    });

    const handle: AgentHandle = {
      pid: pty.pid ?? null,
      sessionId: opts.init.session_id,
      pty,
      exited: new Promise((resolveExit) => pty.onExit(({ exitCode, signal }) =>
        resolveExit({ exitCode, signal: signal != null ? String(signal) : undefined }))),
    };

    // Interactive + prompt: claude's REPL also draws a splash before the
    // first ❯ glyph. Same wait-for-ready pattern as copilot. Fire-and-
    // forget; delivery errors surface via the logger.
    if (opts.mode === 'interactive' && opts.prompt) {
      deliverInitialPromptWhenReady(pty, {
        text: opts.prompt,
        promptReadyRegex: claudeCapabilities.promptReadyRegex,
        writePrompt: (o) => claudeProvider.writePrompt!(handle, o),
      }).catch((err) => {
        ctx.logger?.warn?.({ err: err?.message ?? String(err), sessionId: handle.sessionId }, 'claude: initial prompt delivery failed');
      });
    }

    return handle;
  },

  async writePrompt(handle: AgentHandle, { text, strategy }: WritePromptOpts): Promise<void> {
    if (strategy === 'queue') {
      throw new Error('claude: queue strategy not supported (queueMode is "none"); caller must downgrade to local buffering');
    }
    // Send ESC alone with a 200ms gap so it's processed as a standalone
    // keystroke (otherwise terminals interpret `ESC <byte>` as `Alt+<byte>`).
    // ESC both dismisses any overlay/modal from a prior slash-command AND
    // clears the input box, so it replaces the prior `\x15` (Ctrl+U).
    handle.pty.write('\x1b');
    await new Promise((r) => setTimeout(r, 200));
    handle.pty.write(text + '\r');
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
