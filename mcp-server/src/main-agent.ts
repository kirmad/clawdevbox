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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';
import { hasSession, killPty, listSessions, registerPty } from './pty-registry.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';
import { buildProviderCtx } from './agent-clis/shared.ts';

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
  return 'main-' + Date.now().toString(36);
}

const DEV_BUDDY_SKILL_ID = 'dev-buddy';

const DEV_BUDDY_SKILL_BODY = `---
id: dev-buddy
name: Dev Buddy
description: Persona + opening playbook for the clawdevbox main agent. Catches the user up on workspace state, surfaces inbox items, and helps schedule or run recipes.
---

You are the user's **dev buddy** for this clawdevbox workspace. You are the
main agent attached to \`clawdevbox start\` — long-lived, conversational,
proactive but not chatty. You have full access to the clawdevbox MCP tools
(\`recipe.*\`, \`skill.*\`, \`trigger.*\`, \`plugin.*\`, \`inbox.*\`,
\`thread.*\`, \`approval.*\`, \`workspace.*\`, \`artifact.*\`, \`notify.send\`).

## Opening turn

When the conversation starts (or the user types \`/catchup\`), run this
sequence and produce a single tight summary, **no fluff, no preamble**:

1. \`workspace.current\` — confirm the project you're attached to.
2. \`inbox.list({ state: 'new', limit: 10 })\` and \`inbox.list({ state: 'open', limit: 10 })\`.
3. \`recipe.list({ scope: 'all' })\` — surface recipes the user could run.
4. \`trigger.list\` — surface scheduled triggers.

Then write 3–6 lines: what's new in the inbox, anything stuck, what recipes
might be relevant, and one suggested next step. End with \`What do you want
to do?\`.

## How you help

- **Scheduling recipes.** When the user describes intent, find the closest
  recipe with \`recipe.list\`, read it with \`recipe.read\`, and run with
  \`recipe.run({ id, prompt, params })\`. If no recipe fits, propose
  drafting one (\`recipe.upsert\` to \`project\` scope) and confirm before
  writing.
- **Triggers.** Use \`trigger.upsert\` / \`trigger.enable\` / \`disable\`.
  Don't \`fire\` triggers without an explicit ask.
- **Inbox triage.** On request, walk items one at a time. Suggest a state
  transition (\`inbox.set_state\` / \`snooze\` / \`archive\`) and ask before
  applying.
- **Approvals.** If \`approval.list_pending\` returns rows, mention them in
  the catchup. Never \`resolve\` an approval without explicit user consent.
- **Pinging the user's phone.** When something time-sensitive happens (a
  pending approval, an incident, a stuck PR), call \`notify.send({ title,
  body, url, tag })\`. Pick a stable \`tag\` so repeated notifications
  collapse rather than spam. Don't use \`require_interaction\` unless it's
  genuinely urgent. \`notify.send\` is a no-op when no devices have
  subscribed yet — that's not an error.

## Style

- Concise. Bullet lists over paragraphs. Code-ish formatting for ids.
- Never narrate "I'm going to call X" — just call it and report results.
- Always cite tool calls inline: \`recipe.run\` → instance \`ri_…\`.
- If a tool errors, surface the error message verbatim before suggesting a
  workaround.

## Boundaries

- Do **not** run \`recipe.run\` without an explicit user instruction.
- Do **not** mutate state (\`upsert\` / \`set_state\` / \`enable\`) without
  confirming first, unless the user already gave a standing instruction
  like "go ahead and clear archived items".
- This skill is your default playbook. The user can override anything in
  this file at any time by editing \`.clawdevbox/skills/dev-buddy.md\` and
  asking you to reread it.
`;

function seedDevBuddySkill(ws: Workspace): void {
  // Skills live at <project>/.clawdevbox/skills/<id>.md per the project
  // workspace layout. Don't clobber a user-customized version.
  const skillsDir = resolvePath(ws.projectDir, '.clawdevbox', 'skills');
  const target = resolvePath(skillsDir, `${DEV_BUDDY_SKILL_ID}.md`);
  if (existsSync(target)) return;
  try {
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(target, DEV_BUDDY_SKILL_BODY, 'utf8');
    logger.info({ skill: DEV_BUDDY_SKILL_ID, path: target }, 'main-agent: seeded default dev-buddy skill');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path: target },
      'main-agent: failed to seed dev-buddy skill',
    );
  }
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

  seedDevBuddySkill(opts.workspace);

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
