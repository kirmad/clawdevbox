/**
 * main-agent.ts
 *
 * The persistent workspace agent. One per `clawdevbox start` process,
 * registered with the pty-registry under the fixed instance id "main" so
 * the home page can attach via `/terminal/main/ws` like any other pty.
 *
 * Boot sequence:
 *   1. Resolve the configured provider (`cfg.defaultAgentCli ?? 'copilot'`)
 *      from `ws.agentCliProviders`.
 *   2. Delegate `spawnSession({ mode: 'interactive', role: 'main-agent' })`
 *      — the provider owns binary resolution, argv, and `.mcp.json` write.
 *   3. Register the IPty with pty-registry. Late attachers see the
 *      scrollback snapshot + live stream.
 *
 * Lifecycle:
 *   - One per process. `startMainAgent` is idempotent — calling twice on
 *     a running agent returns the existing status.
 *   - On exit, the pty-registry retains scrollback for 10s so a viewer
 *     reconnecting after a crash still sees the last lines.
 *   - `restartMainAgent` kills the running pty (if any) and re-spawns.
 */

import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evictPty, hasSession, killPty, listSessions, registerPty } from './pty-registry.ts';
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';
import { buildProviderCtx } from './agent-clis/shared.ts';
import { loadOrCreateMainAgentSessionId, resetMainAgentSessionId } from './main-agent-session-id.ts';

export const MAIN_AGENT_INSTANCE_ID = 'main';

export interface MainAgentStatus {
  instance_id: string;
  running: boolean;
  exited: boolean;
  agent_cli: string;
  view_url_path: string;
  /**
   * When `running === false`, a human-readable explanation of *why* — set on
   * every transition out of "running":
   *
   *   - provider not registered  → `"provider 'X' is not registered (available: …)"`
   *   - binary detect failed     → `"binary not available: <detect.reason>"`
   *   - spawnSession threw       → `"provider 'X' spawnSession failed: <msg>"`
   *   - pty exited post-spawn    → `"process exited (exitCode=N, signal=…)"`
   *
   * Banner / UI consumers should prefer this over their own guess-the-cause
   * heuristics. Unset (`undefined`) when `running === true` OR when no spawn
   * attempt has been made yet in this process.
   */
  not_running_reason?: string;
}

interface MainAgentOptions {
  workspace: Workspace;
  cfg: ResolvedConfig;
  /** HTTP host the spawned agent should call back to (informational). */
  host?: string;
  /** HTTP port the spawned agent should call back to (informational). */
  port?: number;
}

let agentPid: number | null = null;
let agentCliId: string = 'copilot';
/**
 * Last known reason `running` is false. Cleared the moment we register a
 * pty + the spawn promise has resolved. Re-set from the `handle.exited`
 * continuation when the pty dies later.
 */
let notRunningReason: string | null = null;

function mintMainAgentSessionId(projectDir: string): { id: string; isNew: boolean } {
  // Claude Code's --session-id flag REQUIRES a valid UUID (verified against
  // claude 2.1.x: 'Invalid session ID. Must be a valid UUID.'). Copilot CLI's
  // --name accepts arbitrary strings, so a UUID works for both providers.
  // The fact that this session represents the main agent is recorded via
  // MAIN_AGENT_INSTANCE_ID in pty-registry, not in the session id itself.
  //
  // The id is STICKY across `clawdevbox start` invocations and Restart
  // button clicks — persisted in `<projectDir>/.clawdevbox/main-agent-session-id`
  // — so the underlying agent CLI resumes its previous conversation.
  // The "New Session" button calls resetMainAgentSessionId(...) before
  // starting, which deletes the persisted file and forces a fresh UUID.
  return loadOrCreateMainAgentSessionId(projectDir);
}

export function getMainAgentStatus(): MainAgentStatus {
  // Check pty-registry first (legacy non-tmux providers), then tmuxSessionRegistry.
  const session = listSessions().find((s) => s.instanceId === MAIN_AGENT_INSTANCE_ID);
  const tmuxSession = tmuxSessionRegistry.get(MAIN_AGENT_INSTANCE_ID);
  const running = session ? !session.exited : !!tmuxSession;
  const exited = session ? session.exited : false;
  return {
    instance_id: MAIN_AGENT_INSTANCE_ID,
    running,
    exited,
    agent_cli: agentCliId,
    view_url_path: `/terminal/${MAIN_AGENT_INSTANCE_ID}`,
    not_running_reason: running ? undefined : (notRunningReason ?? undefined),
  };
}

/**
 * Start the main agent. No-op if one is already running.
 *
 * Returns the status (existing or freshly spawned). Spawn failures (CLI
 * binary missing, provider not registered, etc.) are logged and surface in
 * the returned `running` flag — they do not throw so the HTTP server stays up.
 */
export async function startMainAgent(opts: MainAgentOptions): Promise<MainAgentStatus> {
  if (hasSession(MAIN_AGENT_INSTANCE_ID)) {
    const status = getMainAgentStatus();
    if (status.running) return status;
    // Exited session still in the registry's retention window — let it
    // fall out naturally and spawn a new one.
  }

  const providerId = opts.cfg.defaultAgentCli ?? 'copilot';
  agentCliId = providerId;
  const provider = opts.workspace.agentCliProviders.get(providerId);
  if (!provider) {
    const available = [...opts.workspace.agentCliProviders.keys()];
    const availableHint = available.length === 0 ? '(none)' : available.join(', ');
    notRunningReason =
      `provider '${providerId}' is not registered ` +
      `(available: ${availableHint}). ` +
      `Run \`clawdevbox config set default_agent_cli <id>\` or install the providing plugin.`;
    logger.warn(
      {
        providerId,
        available,
      },
      'main-agent: configured provider is not registered; home page agent tab will be empty',
    );
    return getMainAgentStatus();
  }

  const host = opts.host ?? opts.cfg.http.host;
  const port = opts.port ?? opts.cfg.http.port;
  const providerCtx = buildProviderCtx(opts.workspace, opts.cfg);

  // Probe the binary up-front (if the provider exposes `detect`). ConPty /
  // node-pty on Windows can silently swallow a missing binary by returning
  // a pty that exits immediately with code 1 — and the user-visible banner
  // then has to guess at the cause. Detect runs cheaply (~ms) and gives us
  // a precise "binary not on PATH" diagnosis before we touch the pty.
  if (provider.detect) {
    try {
      let detect = await provider.detect(providerCtx);
      if (!detect.available && process.platform === 'win32' && providerId === 'copilot') {
        // Auto-install GitHub Copilot CLI on Windows
        logger.info('main-agent: copilot CLI not found — attempting auto-install via npm...');
        process.stderr.write('Copilot CLI not found — installing @anthropic-ai/claude-code@latest...\n');
        const { spawnSync } = await import('node:child_process');
        // Copilot CLI is installed via the Copilot extension for VS Code,
        // or standalone via `npm install -g @anthropic-ai/claude-code`.
        // Try winget first (GitHub Copilot CLI), then npm fallback.
        const wingetResult = spawnSync('winget', ['install', 'GitHub.CopilotCLI', '--accept-source-agreements', '--accept-package-agreements'], {
          stdio: 'inherit',
          timeout: 120_000,
          windowsHide: true,
        });
        if (wingetResult.status === 0) {
          // Add winget links to PATH in-process
          const wingetLinks = join(
            process.env.LOCALAPPDATA ?? '',
            'Microsoft', 'WinGet', 'Links',
          );
          if (existsSync(wingetLinks) && !process.env.PATH?.includes(wingetLinks)) {
            process.env.PATH = `${wingetLinks};${process.env.PATH}`;
          }
          detect = await provider.detect(providerCtx);
          if (detect.available) {
            logger.info('main-agent: copilot CLI auto-installed successfully');
            process.stderr.write('Copilot CLI installed. Run `copilot auth login` if first time.\n');
          }
        }
      }
      if (!detect.available) {
        notRunningReason =
          `provider '${providerId}' binary not available` +
          (detect.binary ? ` (binary='${detect.binary}')` : '') +
          (detect.reason ? `: ${detect.reason}` : '') +
          '. Install the CLI or set the relevant env var, then run `clawdevbox restart`.';
        logger.warn(
          { providerId, detect },
          'main-agent: provider.detect reports binary unavailable; skipping spawn',
        );
        return getMainAgentStatus();
      }
    } catch (err) {
      // Detect itself threw — don't block spawn on that, just log. The
      // spawn attempt below will surface a more specific reason if it
      // also fails.
      logger.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'main-agent: provider.detect threw; proceeding to spawn anyway',
      );
    }
  }

  try {
    const { id: sessionId, isNew } = mintMainAgentSessionId(opts.workspace.projectDir);
    const handle = await provider.spawnSession(providerCtx, {
      mode: 'interactive',
      // First launch of this sticky id → 'new'. Subsequent launches
      // (file already existed on disk) → 'resume' so providers like
      // Claude pass --resume <uuid> and pick up the prior conversation.
      // Copilot's `--session-id <uuid>` is symmetric (create-if-missing,
      // resume otherwise) so the kind doesn't change its behaviour, but
      // we keep the semantically correct value for accurate logging /
      // future agent-cli providers.
      init: { kind: isNew ? 'new' : 'resume', session_id: sessionId },
      role: 'main-agent',
      agent: 'dev-buddy:dev-buddy',
      workspaceInfo: { id: 'project', path: opts.workspace.projectDir },
      ambientEnv: {
        CLAWDEVBOX_PROJECT_DIR: opts.workspace.projectDir,
        CLAWDEVBOX_GLOBAL_DIR: opts.workspace.globalDir,
      },
      mcp: {
        url: `http://${host}:${port}/mcp`,
        secret: opts.cfg.http.token ?? '',
        // The main agent doesn't have a specific registered workspace; the
        // resolver falls through (header workspace_id is unset) to project_dir
        // matching against the registered workspaces. If no workspace is
        // registered for this projectDir yet, tools that need a workspace
        // surface NO_TARGET_WORKSPACE and prompt the user to `workspace.create`.
        projectDir: opts.workspace.projectDir,
        // Include sessionId so writeMcpJson injects the X-Clawdevbox-Session-Id
        // header on every MCP request. The HTTP server's idle-transport sweep
        // uses this header to bind mcp-session-id → agent-session-id, and
        // skip-reaps transports whose agent session is still alive in the
        // pty-registry. Without this, the main agent's transport would get
        // idle-swept after CLAWDEVBOX_MCP_IDLE_MS (default 10m) of no LLM
        // tool calls — and the next user message would 404.
        sessionId,
      },
      ptyCols: 120,
      ptyRows: 30,
      pluginDirs: [
        ...opts.cfg.vaults.map(v => v.path),
        // Include all registered plugin dirs so --agent <plugin>:<agent> resolves
        ...(() => {
          const pluginsRoot = join(opts.workspace.globalDir, 'plugins');
          try {
            return existsSync(pluginsRoot)
              ? readdirSync(pluginsRoot).map(d => join(pluginsRoot, d)).filter(d => statSync(d).isDirectory())
              : [];
          } catch { return []; }
        })(),
        // Bundled plugins shipped with the npm package (plugins/ next to dist/)
        ...(() => {
          const bundledRoot = join(import.meta.dirname, '..', 'plugins');
          try {
            return existsSync(bundledRoot)
              ? readdirSync(bundledRoot).map(d => join(bundledRoot, d)).filter(d => statSync(d).isDirectory())
              : [];
          } catch { return []; }
        })(),
      ],
    });
    agentPid = handle.pid ?? null;

    // Tmux-backed providers (copilot, claude, agency) expose handle.session
    // instead of handle.pty. Register with tmuxSessionRegistry so the
    // terminal WebSocket handler can find and attach to it.
    if (handle.session) {
      tmuxSessionRegistry.register(MAIN_AGENT_INSTANCE_ID, handle.session);
    }

    // Only register with pty-registry if there's a raw IPty (non-tmux providers).
    // Tmux-backed sessions go through tmuxSessionRegistry exclusively for I/O.
    if (handle.pty) {
      registerPty({
        instanceId: MAIN_AGENT_INSTANCE_ID,
        workspaceId: 'project',
        cols: 120,
        rows: 30,
        ipty: handle.pty,
        provider,
        agentHandle: handle,
        meta: { agentCli: providerId, sessionId: handle.sessionId },
      });
    }

    // Spawn succeeded — clear any stale reason from earlier attempts.
    notRunningReason = null;

    handle.exited.then(({ exitCode, signal }) => {
      notRunningReason =
        `provider '${providerId}' process exited` +
        (exitCode != null ? ` (exitCode=${exitCode})` : '') +
        (signal ? ` (signal=${signal})` : '') +
        '. Open the Agent tab to see the terminal scrollback for the last lines before exit.';
      logger.info({ exitCode, signal, pid: agentPid }, 'main-agent: exited');
      agentPid = null;
      emitChange('agent');
    }).catch(() => { /* exited promise never rejects */ });

    emitChange('agent');
    logger.info(
      { agentCli: providerId, pid: agentPid, projectDir: opts.workspace.projectDir },
      'main-agent: started',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notRunningReason = `provider '${providerId}' spawnSession failed: ${msg}`;
    logger.warn(
      {
        err: msg,
        providerId,
      },
      'main-agent: spawn failed; home page will show an empty terminal',
    );
  }

  return getMainAgentStatus();
}

/**
 * Kill the running main agent (if any) and respawn.
 *
 * @param opts.newSession  when true, drops the sticky session-id file
 *                         FIRST so the respawn mints a fresh UUID and
 *                         starts a clean conversation. When omitted /
 *                         false the persisted id is preserved and the
 *                         agent resumes its prior context (the default
 *                         "Restart" behaviour). Wired to the SPA's
 *                         "New Session" button.
 */
export async function restartMainAgent(opts: MainAgentOptions & { newSession?: boolean }): Promise<MainAgentStatus> {
  if (opts.newSession) {
    resetMainAgentSessionId(opts.workspace.projectDir);
  }
  // Kill existing tmux session (tmux-backed providers)
  const tmuxSession = tmuxSessionRegistry.get(MAIN_AGENT_INSTANCE_ID);
  if (tmuxSession) {
    try { await tmuxSession.kill(); } catch { /* may already be dead */ }
  }
  if (hasSession(MAIN_AGENT_INSTANCE_ID)) {
    killPty(MAIN_AGENT_INSTANCE_ID);
  }
  // killPty leaves the exited row in the registry for up to
  // EXIT_RETAIN_MS (~10s) so late viewers can pull scrollback. We're
  // about to re-register at the SAME instanceId, so evict now to avoid
  // the "pty session already registered for instance main" error that
  // startMainAgent → registerPty would otherwise throw.
  evictPty(MAIN_AGENT_INSTANCE_ID);
  return startMainAgent(opts);
}
