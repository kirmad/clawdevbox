/**
 * main-agent.ts
 *
 * The persistent workspace agent. One per `clawdevbox start` process,
 * registered with the pty-registry under the fixed instance id "main" so
 * the home page can attach via `/terminal/main/ws` like any other pty.
 *
 * Boot sequence:
 *   1. Write `<workspace>/.mcp.json` + `<workspace>/agency.toml` so the
 *      spawned `agency copilot` sees the clawdevbox MCP server.
 *   2. Spawn `agency copilot` (interactive — no `-p`) inside a hidden
 *      ConPTY (no console window flash on Windows).
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
import * as pty from 'node-pty';
import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';
import { hasSession, killPty, listSessions, registerPty } from './pty-registry.ts';
import type { Workspace } from './workspace.ts';

export const MAIN_AGENT_INSTANCE_ID = 'main';

export interface MainAgentStatus {
  instance_id: string;
  running: boolean;
  exited: boolean;
  agent_cli: 'copilot';
  view_url_path: string;
}

interface MainAgentOptions {
  workspace: Workspace;
  /** HTTP host the spawned agent should call back to (informational). */
  host?: string;
  /** HTTP port the spawned agent should call back to (informational). */
  port?: number;
}

let agentPid: number | null = null;

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

function writeMcpAndAgencyConfig(ws: Workspace): void {
  // `.mcp.json` for any MCP client that respects the workspace config.
  const mcpConfigPath = resolvePath(ws.projectDir, '.mcp.json');
  const mcpConfig = {
    mcpServers: {
      clawdevbox: {
        type: 'local',
        command: 'npx',
        args: ['-y', 'clawdevbox', 'mcp'],
        env: {
          CLAWDEVBOX_PROJECT_DIR: ws.projectDir,
          CLAWDEVBOX_GLOBAL_DIR: ws.globalDir,
        },
        tools: ['*'],
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');

  // `agency.toml` — agency's `copilot --resume` flow merges this into the
  // copilot mcp-config bundle (workspace `.mcp.json` is dropped on resume).
  // We mirror the same server entry so the resumed copilot tool inventory
  // includes clawdevbox tools.
  const agencyTomlPath = resolvePath(ws.projectDir, 'agency.toml');
  const tomlEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const agencyToml =
    `[mcps.servers.clawdevbox]\n` +
    `type = "stdio"\n` +
    `command = "${tomlEscape('npx')}"\n` +
    `args = ["-y", "clawdevbox", "mcp"]\n` +
    `tools = ["*"]\n` +
    `\n` +
    `[mcps.servers.clawdevbox.env]\n` +
    `CLAWDEVBOX_PROJECT_DIR = "${tomlEscape(ws.projectDir)}"\n` +
    `CLAWDEVBOX_GLOBAL_DIR = "${tomlEscape(ws.globalDir)}"\n`;
  writeFileSync(agencyTomlPath, agencyToml, 'utf8');
}

export function getMainAgentStatus(): MainAgentStatus {
  const session = listSessions().find((s) => s.instanceId === MAIN_AGENT_INSTANCE_ID);
  return {
    instance_id: MAIN_AGENT_INSTANCE_ID,
    running: session ? !session.exited : false,
    exited: session ? session.exited : false,
    agent_cli: 'copilot',
    view_url_path: `/terminal/${MAIN_AGENT_INSTANCE_ID}`,
  };
}

/**
 * Start the main agent. No-op if one is already running.
 *
 * Returns the status (existing or freshly spawned). Spawn failures (e.g.
 * `agency` not on PATH) are logged and surface in the returned `running`
 * flag — they do not throw so the HTTP server stays up.
 */
export function startMainAgent(opts: MainAgentOptions): MainAgentStatus {
  if (hasSession(MAIN_AGENT_INSTANCE_ID)) {
    const status = getMainAgentStatus();
    if (status.running) return status;
    // Exited session still in the registry's retention window — let it
    // fall out naturally and spawn a new one.
  }

  try {
    writeMcpAndAgencyConfig(opts.workspace);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'main-agent: failed to write workspace .mcp.json / agency.toml',
    );
  }
  seedDevBuddySkill(opts.workspace);

  const isWin = process.platform === 'win32';
  const agencyBin = process.env.CLAWDEVBOX_AGENCY_PATH ?? (isWin ? 'agency.exe' : 'agency');

  // Interactive — no `-p`. The user types in the browser xterm, the agent
  // streams output back, just like a local terminal.
  const ptyArgs = ['copilot'];

  const cols = 120;
  const rows = 30;

  try {
    const proc = pty.spawn(agencyBin, ptyArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.workspace.projectDir,
      env: {
        ...process.env,
        CLAWDEVBOX_PROJECT_DIR: opts.workspace.projectDir,
        CLAWDEVBOX_GLOBAL_DIR: opts.workspace.globalDir,
      } as Record<string, string>,
    });
    agentPid = proc.pid ?? null;

    registerPty({
      instanceId: MAIN_AGENT_INSTANCE_ID,
      workspaceId: 'project',
      cols,
      rows,
      ipty: proc,
    });

    proc.onExit(({ exitCode, signal }) => {
      logger.info({ exitCode, signal, pid: agentPid }, 'main-agent: exited');
      agentPid = null;
      emitChange('agent');
    });

    emitChange('agent');
    logger.info(
      { agentCli: 'copilot', pid: agentPid, projectDir: opts.workspace.projectDir },
      'main-agent: started',
    );
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        agencyBin,
        hint: 'install agency-cli or set CLAWDEVBOX_AGENCY_PATH',
      },
      'main-agent: spawn failed; home page will show an empty terminal',
    );
  }

  return getMainAgentStatus();
}

/** Kill the running main agent (if any) and respawn. */
export function restartMainAgent(opts: MainAgentOptions): MainAgentStatus {
  if (hasSession(MAIN_AGENT_INSTANCE_ID)) {
    killPty(MAIN_AGENT_INSTANCE_ID);
  }
  return startMainAgent(opts);
}
