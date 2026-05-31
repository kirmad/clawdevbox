import { join } from 'node:path';
import os from 'node:os';
import { writeMcpJson, probeBinary, cliPluginSync, cliPluginDiscover, buildVaultPluginDirArgs, deliverInitialPromptWhenReady } from './shared.ts';
import { trustCopilotWorkspace } from '../trust-workspace.ts';
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
  supportsResume: true,

  async detect(_ctx: ProviderCtx) {
    return probeBinary(resolveBinary(), ['--version']);
  },

  async spawnSession(ctx: ProviderCtx, opts: SpawnSessionOpts): Promise<AgentHandle> {
    const bin = resolveBinary();
    writeMcpJson(ctx, opts.workspaceInfo.path, opts.mcp);
    const mcpPath = join(opts.workspaceInfo.path, '.mcp.json');

    // Pre-trust the workspace in copilot's config so we never hit the
    // "Do you trust the files in this folder?" modal on first launch
    // in a new directory. `--yolo` does NOT bypass the trust modal — it
    // only enables tool permissions. Idempotent: only writes if the
    // workspace isn't already trusted (directly or via a parent entry).
    trustCopilotWorkspace(opts.workspaceInfo.path);

    // Use `--session-id <uuid>` for BOTH new and resume. Per `copilot --help`:
    //   --session-id <id>    Resume an existing session or task by ID, or set
    //                        the UUID for a new session
    // The CLI treats it as resume when the UUID exists on disk, otherwise
    // it creates a new session with that UUID. This mirrors how you'd run
    // `copilot` interactively in a fresh terminal — no special "create-mode"
    // flag needed. The opts.init.session_id is already a randomUUID() from
    // the kernel so it's always a valid UUID for both new and resume paths.
    //
    // `--yolo` enables all permissions (--allow-all-tools, --allow-all-paths,
    // --allow-all-urls). Without it, every tool invocation (shell, file
    // writes, network) prompts:
    //   "Do you want to run this command? 1. Yes  2. Yes, don't ask again
    //    3. No, tell Copilot what to do differently"
    // That prompt blocks dispatched LLM prompts (no human at the terminal
    // to type 1). Trigger-fired agents need to run autonomously, so we opt
    // in to yolo for ALL clawdevbox-spawned sessions. Headless invocations
    // (-p) already used --allow-all-tools; --yolo is the superset for
    // interactive too. Verified against copilot 1.0.57-3.
    const argv: string[] = [
      `--session-id=${opts.init.session_id}`,
      '--yolo',
      '--additional-mcp-config', `@${mcpPath}`,
    ];
    if (opts.agent) {
      argv.push('--agent', opts.agent);
    }
    if (opts.model) {
      argv.push('--model', opts.model);
    }
    argv.push(...buildVaultPluginDirArgs(opts.pluginDirs));
    if (opts.mode === 'headless') {
      if (!opts.prompt) throw new Error('copilot: headless mode requires opts.prompt');
      argv.push('-p', opts.prompt);
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
  //
  // For `strategy: 'submit'` we prepend `\x1b` (ESC) and wait long enough
  // for it to be processed as a STANDALONE key. ESC serves two purposes
  // at once:
  //   1. Dismisses any modal/overlay opened by a prior slash-command
  //      (e.g. `/help` opens a help overlay that swallows subsequent
  //      input until ESC closes it — discovered by the dispatch-storm
  //      stress test).
  //   2. In normal input mode, ESC clears any lingering bytes in the
  //      input box, replacing the role formerly played by `\x15` (Ctrl+U).
  //
  // Critically the ESC must be sent ALONE — if we follow it immediately
  // with another byte, terminals interpret `ESC <byte>` as `Alt+<byte>`
  // (a single Meta-prefixed key), so the overlay never dismisses. A
  // 200ms gap is enough for copilot to process the ESC as a single
  // keystroke. The ESC is a no-op on a clean idle prompt, so it's safe
  // to always include.
  //
  // For `strategy: 'queue'` (Ctrl+Q) the input box is committed to
  // Copilot's native queue and a fresh box opens; no clear is needed.
  async writePrompt(handle: AgentHandle, { text, strategy }: WritePromptOpts): Promise<void> {
    if (strategy === 'submit') {
      handle.pty.write('\x1b');
      await sleep(200);
    }
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
