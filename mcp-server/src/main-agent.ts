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
  return {
    instance_id: MAIN_AGENT_INSTANCE_ID,
    running: session ? !session.exited : false,
    exited: session ? session.exited : false,
    agent_cli: agentCliId,
    view_url_path: `/terminal/${MAIN_AGENT_INSTANCE_ID}`,
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
    logger.warn(
      {
        providerId,
        available: [...opts.workspace.agentCliProviders.keys()],
      },
      'main-agent: configured provider is not registered; home page agent tab will be empty',
    );
    return getMainAgentStatus();
  }

  const host = opts.host ?? opts.cfg.http.host;
  const port = opts.port ?? opts.cfg.http.port;
  const providerCtx = buildProviderCtx(opts.workspace, opts.cfg);

  try {
    const handle = await provider.spawnSession(providerCtx, {
      mode: 'interactive',
      init: { kind: 'new', session_id: mintMainAgentSessionId() },
      role: 'main-agent',
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
    });
    agentPid = handle.pid ?? null;

    registerPty({
      instanceId: MAIN_AGENT_INSTANCE_ID,
      workspaceId: 'project',
      cols: 120,
      rows: 30,
      ipty: handle.pty,
    });

    handle.exited.then(({ exitCode, signal }) => {
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
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        providerId,
        hint: `provider '${providerId}' failed to spawn — check its binary is installed and on PATH`,
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
