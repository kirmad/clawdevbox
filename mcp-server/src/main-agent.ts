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
import { hasSession, killPty, listSessions, registerPty } from './pty-registry.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';
import { buildProviderCtx } from './agent-clis/shared.ts';
import { randomUUID } from 'node:crypto';

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

function mintMainAgentSessionId(): string {
  // Claude Code's --session-id flag REQUIRES a valid UUID (verified against
  // claude 2.1.x: 'Invalid session ID. Must be a valid UUID.'). Copilot CLI's
  // --name accepts arbitrary strings, so a UUID works for both providers.
  // The fact that this session represents the main agent is recorded via
  // MAIN_AGENT_INSTANCE_ID in pty-registry, not in the session id itself.
  return randomUUID();
}

export function getMainAgentStatus(): MainAgentStatus {
  const session = listSessions().find((s) => s.instanceId === MAIN_AGENT_INSTANCE_ID);
  const running = session ? !session.exited : false;
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
      const detect = await provider.detect(providerCtx);
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
    const handle = await provider.spawnSession(providerCtx, {
      mode: 'interactive',
      init: { kind: 'new', session_id: mintMainAgentSessionId() },
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
      },
      ptyCols: 120,
      ptyRows: 30,
      pluginDirs: opts.cfg.vaults.map(v => v.path),
    });
    agentPid = handle.pid ?? null;

    registerPty({
      instanceId: MAIN_AGENT_INSTANCE_ID,
      workspaceId: 'project',
      cols: 120,
      rows: 30,
      ipty: handle.pty!,
      provider,
      agentHandle: handle,
      meta: { agentCli: providerId },
    });

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

/** Kill the running main agent (if any) and respawn. */
export async function restartMainAgent(opts: MainAgentOptions): Promise<MainAgentStatus> {
  if (hasSession(MAIN_AGENT_INSTANCE_ID)) {
    killPty(MAIN_AGENT_INSTANCE_ID);
  }
  return startMainAgent(opts);
}
