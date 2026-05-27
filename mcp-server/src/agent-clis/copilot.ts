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

function resolveBinary(): string {
  const isWin = process.platform === 'win32';
  return process.env.CLAWDEVBOX_COPILOT_PATH ?? (isWin ? 'copilot.exe' : 'copilot');
}

// Copilot stores installed plugins at `~/.copilot/installed-plugins/<marketplace>/<name>/`.
// (Older Copilot versions used `~/.copilot/plugins`; the current layout is
// `installed-plugins`.) `agency copilot ...` shares this exact cache since
// agency wraps copilot — the agency provider sets the same pluginCacheDir.
const COPILOT_PLUGIN_CACHE = join(os.homedir(), '.copilot', 'installed-plugins');

const SLEEP_BEFORE_COMMIT_MS = 250;
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Empirically derived from files/queue-done-spike/QUEUE-FINDINGS.md:
//   * `pty.write(text)` then ~250ms then `pty.write('\r')` reliably submits.
//   * Same sequence with `\x11` (ASCII DC1 = Ctrl+Q) stages the prompt in
//     Copilot's native queue instead, FIFO across multiple stacked prompts.
//   * Visible busy/queue strings on the TUI: `Working`, `Queued (N)`, `[pending]`.
//   * Prompt-ready glyph: `❯` (U+276F) on a stable tail.
const copilotCapabilities: ProviderCapabilities = {
  queueMode: 'ctrl-q',
  promptSubmitStrategy: 'split-cr-250ms',
  promptReadyRegex: /❯[^\S\n]*$/m,
  busyIndicators: [/Working/i, /Queued \(\d+\)/i, /\[pending\]/i],
};

export const copilotProvider: AgentCliProvider = {
  id: 'copilot',
  displayName: 'GitHub Copilot CLI',
  description: 'The official GitHub Copilot CLI (`copilot`). Supports headless prompts and resumable sessions.',
  source: 'builtin',
  capabilities: copilotCapabilities,

  async detect(_ctx: ProviderCtx) {
    return probeBinary(resolveBinary(), ['--version']);
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const bin = resolveBinary();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);
    const mcpPath = join(opts.workspaceInfo.path, '.mcp.json');

    const sessionFlag = opts.init.kind === 'new'
      ? `--name=${opts.init.session_id}`
      : `--resume=${opts.init.session_id}`;

    const argv: string[] = [sessionFlag, '--additional-mcp-config', `@${mcpPath}`];
    if (opts.agent) {
      argv.push('--agent', opts.agent);
    }
    argv.push(...buildVaultPluginDirArgs(opts.pluginDirs));
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('copilot: headless mode requires opts.prompt');
      argv.push('--allow-all-tools', '-p', opts.prompt);
    }

    const env = { ...process.env, ...opts.ambientEnv } as Record<string, string>;
    const pty = ctx.spawnPty(bin, argv, {
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

    // Interactive + prompt: copilot's TUI takes a moment to draw its first
    // ❯ glyph (splash screen, plugin probe, agent slot). Writing bytes
    // before that point dumps them into a non-existent input box. Wait for
    // a stable prompt-ready tail, then submit via the byte-correct
    // writePrompt path. Fire-and-forget — the caller already has the
    // handle; delivery errors are surfaced via the logger.
    if (opts.mode === 'interactive' && opts.prompt) {
      deliverInitialPromptWhenReady(pty, {
        text: opts.prompt,
        promptReadyRegex: copilotCapabilities.promptReadyRegex,
        writePrompt: (o) => copilotProvider.writePrompt!(handle, o),
      }).catch((err) => {
        ctx.logger?.warn?.({ err: err?.message ?? String(err), sessionId: handle.sessionId }, 'copilot: initial prompt delivery failed');
      });
    }

    return handle;
  },

  // Empirically validated against Copilot CLI 1.0.55-3 (see
  // files/queue-done-spike/QUEUE-FINDINGS.md). A single bulk
  // `pty.write(text + '\r')` only edits the input box; the text and the
  // commit byte (`\r` or `\x11`) must arrive in separate writes.
  async writePrompt(handle: AgentHandle, { text, strategy }: WritePromptOpts): Promise<void> {
    handle.pty.write(text);
    await sleep(SLEEP_BEFORE_COMMIT_MS);
    handle.pty.write(strategy === 'queue' ? '\x11' : '\r');
  },

  async syncPluginInventory(ctx: ProviderCtx, opts: SyncPluginInventoryOpts): Promise<SyncReport> {
    return cliPluginSync(ctx, opts, {
      binary: resolveBinary(),
      pluginCacheDir: COPILOT_PLUGIN_CACHE,
    });
  },

  async discoverInstalledPlugins(ctx: ProviderCtx): Promise<DiscoveredPlugin[]> {
    return cliPluginDiscover(ctx, {
      binary: resolveBinary(),
      pluginCacheDir: COPILOT_PLUGIN_CACHE,
    });
  },
};
