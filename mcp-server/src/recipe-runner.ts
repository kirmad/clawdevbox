/**
 * recipe-runner.ts
 *
 * The pure spawn-an-agent-CLI-for-a-recipe core (spec §7.1, §10.3).
 * Extracted from `tools/recipe.ts` so it can be invoked both from the
 * `recipe.run` MCP tool AND from the trigger dispatcher's recipe binding.
 *
 * Responsibilities:
 *   1. Mint a recipe-instance id (+ CLI session id if not supplied).
 *   2. Write `.mcp.json` into the workspace so the spawned CLI sees clawdevbox.
 *   3. Write the legacy recipe-instance JSON file + DB mirror.
 *   4. pty.spawn the agent CLI with ambient env vars.
 *   5. Stream the pty's output to a log file + the pty registry (for browser viewers).
 *   6. Patch the row with the pid once we have one back from pty.spawn.
 *
 * The result is the "spawned" snapshot — the agent is still running. The
 * agent itself (or the pty.onExit hook) is responsible for marking
 * recipe.done.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { registerPty } from './pty-registry.ts';
import { getTerminalServer } from './terminal-server.ts';
import {
  mintRecipeInstanceId,
  readRecipeInstance,
  recipeInstancesDir,
  writeRecipeInstance,
  type RecipeInstance,
} from './recipe-instances-store.ts';
import { getDatabase } from './db/index.ts';
import { buildProviderCtx } from './agent-clis/shared.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';

export interface RunRecipeOptions {
  /** Resolved recipe id (after scope-chain lookup). */
  recipeId: string;
  /** Raw YAML snapshot to record on the instance row. */
  recipeSnapshot: string;
  /** True when the recipe was supplied inline (no saved file). */
  isAdhoc?: boolean;
  /** First user message handed to the spawned agent. */
  prompt: string;
  /** Optional structured params recorded on the instance. */
  params?: Record<string, unknown>;
  /** Workspace to run in (already resolved/created by the caller). */
  workspaceInfo: { id: string; path: string };
  /** Inbox item to associate this run with (optional). */
  attachToInboxItemId?: string;
  /** Which CLI to spawn. Default 'copilot'. */
  agentCli?: string;
  /**
   * Optional agent persona to launch the CLI with (passed as `--agent
   * <name>` to copilot/claude/agency). Resolved from the recipe YAML's
   * `agent:` field; can be overridden by the caller of `recipe.run`.
   */
  agent?: string;
  /** Explicit CLI session id. Auto-minted from the instance id when absent. */
  sessionId?: string;
  /** Resume a prior recipe instance (CLI session id of the predecessor). */
  resumeOf?: string;
  /** Lineage — parent recipe instance id, if this is a nested run. */
  parentRecipeInstanceId?: string;
  /** Lineage — trigger that fired this run (dispatcher path). */
  triggerId?: string;
  /** Lineage — fire row that produced this run (dispatcher path). */
  fireId?: string;
  /** Workspaces-root used by spawned MCP children (for the .mcp.json env). */
  workspacesRoot: string;
  /** MCP URL to advertise to the spawned MCP child (from process.env). */
  mcpUrl?: string;
  /** Pre-existing MCP secret to reuse. Auto-minted if absent. */
  mcpSecret?: string;
  /** Workspace whose `agentCliProviders` registry resolves `agentCli`. */
  ws: Workspace;
  /** Resolved runtime config (passed into `ProviderCtx`). */
  cfg: ResolvedConfig;
}

export interface RunRecipeResult {
  recipe_instance_id: string;
  recipe_id: string;
  adhoc: boolean;
  workspace_id: string;
  workspace_path: string;
  attach_to_inbox_item_id: string | null;
  pid: number | null;
  agent_cli: string;
  session_id: string;
  resume_of: string | null;
  status: 'spawned';
  log_path: string;
  view_url: string | null;
  /** Set when pty.spawn threw. The instance is already marked `failure`. */
  spawn_error?: { code: string; message: string };
}

// (stdio-MCP-spawn-per-recipe mechanism has been retired in favor of
// per-spawn HTTP MCP headers — see writeMcpJson in agent-clis/shared.ts
// and context-resolver.ts.)


export async function runRecipe(opts: RunRecipeOptions): Promise<RunRecipeResult> {
  const agentCli: string = opts.agentCli ?? 'copilot';
  const instanceId = mintRecipeInstanceId();
  // Use a UUID for the session id by default. Claude Code's --session-id
  // requires a valid UUID; Copilot accepts arbitrary strings, so UUIDs work
  // for both. A caller can still pass a custom opts.sessionId — but it must
  // be UUID-shaped if agentCli is claude/agency-with-claude.
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.length > 0
      ? opts.sessionId
      : randomUUID();
  const isResume = !!opts.resumeOf;
  const mcpSecret = opts.mcpSecret ?? randomBytes(16).toString('hex');

  // The agent's .mcp.json is written by the provider's writeMcpJson via the
  // SpawnSessionOpts.mcp object (see agent-clis/shared.ts). That write
  // points the agent at the long-lived HTTP MCP server and injects per-spawn
  // headers (X-Clawdevbox-Workspace-Id, X-Clawdevbox-Recipe-Instance-Id, etc.)
  // that the server's tool handlers read via extra.requestInfo.headers (see
  // context-resolver.ts). Workspace context is therefore identified
  // per-request rather than relying on a shared server's process.env, which
  // doesn't reflect the calling agent in multi-agent HTTP scenarios.

  // 2. Write the instance row (file + DB) before spawning.
  const instance: RecipeInstance = {
    id: instanceId,
    recipe_id: opts.recipeId,
    recipe_snapshot: opts.recipeSnapshot,
    workspace_id: opts.workspaceInfo.id,
    workspace_path: opts.workspaceInfo.path,
    prompt: opts.prompt,
    params: opts.params ?? {},
    agent_cli: agentCli,
    pid: null,
    started_at: Date.now(),
    status: 'running',
    completed_at: null,
    result: null,
    message: null,
    session_id: sessionId,
    resume_of: opts.resumeOf ?? null,
    parent_recipe_instance_id: opts.parentRecipeInstanceId ?? null,
  };
  writeRecipeInstance(opts.workspaceInfo.path, instance);

  // Patch the DB row with trigger_id + fire_id (writeRecipeInstance doesn't
  // know about lineage — the dispatcher path needs these to thread back).
  if (opts.triggerId || opts.fireId) {
    try {
      const db = getDatabase();
      db.prepare(
        `UPDATE recipe_instances SET trigger_id = COALESCE(?, trigger_id), fire_id = COALESCE(?, fire_id) WHERE id = ?`,
      ).run(opts.triggerId ?? null, opts.fireId ?? null, instanceId);
    } catch {
      /* DB may not be open in some test contexts; the file write is canonical. */
    }
  }

  // 3. Build the ambient env overrides the provider will merge with process.env.
  const spawnEnv: Record<string, string> = {
    CLAWDEVBOX_PROJECT_DIR: opts.workspaceInfo.path,
    CLAWDEVBOX_RECIPE_INSTANCE_ID: instanceId,
    CLAWDEVBOX_WORKSPACE_ID: opts.workspaceInfo.id,
    CLAWDEVBOX_WORKSPACES_ROOT: opts.workspacesRoot,
    CLAWDEVBOX_MCP_SECRET: mcpSecret,
    CLAWDEVBOX_SESSION_ID: sessionId,
  };

  const instancesDir = recipeInstancesDir(opts.workspaceInfo.path);
  mkdirSync(instancesDir, { recursive: true });
  const logPath = resolvePath(instancesDir, `${instanceId}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });

  // 4. Resolve the provider from the workspace registry and delegate spawn.
  const provider = opts.ws.agentCliProviders.get(agentCli);
  if (!provider) {
    logStream.end();
    const available = [...opts.ws.agentCliProviders.keys()].join(', ');
    const msg = `unknown agent_cli '${agentCli}' (available: ${available})`;
    const failed: RecipeInstance = {
      ...instance,
      status: 'failure',
      completed_at: Date.now(),
      message: `spawn failed: ${msg}`,
    };
    writeRecipeInstance(opts.workspaceInfo.path, failed);
    return {
      recipe_instance_id: instanceId,
      recipe_id: opts.recipeId,
      adhoc: opts.isAdhoc ?? false,
      workspace_id: opts.workspaceInfo.id,
      workspace_path: opts.workspaceInfo.path,
      attach_to_inbox_item_id: opts.attachToInboxItemId ?? null,
      pid: null,
      agent_cli: agentCli,
      session_id: sessionId,
      resume_of: opts.resumeOf ?? null,
      status: 'spawned',
      log_path: logPath,
      view_url: getTerminalServer()?.url(instanceId) ?? null,
      spawn_error: { code: 'UNKNOWN_AGENT_CLI', message: msg },
    };
  }

  const providerCtx = buildProviderCtx(opts.ws, opts.cfg);
  const ptyCols = 120;
  const ptyRows = 30;
  let pid: number | undefined;
  let spawnError: unknown = null;
  try {
    const handle = await provider.spawnSession(providerCtx, {
      mode: 'headless',
      init: isResume
        ? { kind: 'resume', session_id: sessionId }
        : { kind: 'new', session_id: sessionId },
      role: 'recipe-instance',
      prompt: opts.prompt,
      agent: opts.agent,
      workspaceInfo: opts.workspaceInfo,
      ambientEnv: spawnEnv,
      mcp: {
        url: opts.mcpUrl ?? '',
        secret: mcpSecret,
        workspaceId: opts.workspaceInfo.id,
        recipeInstanceId: instanceId,
        projectDir: opts.workspaceInfo.path,
        sessionId,
      },
      recipeInstanceId: instanceId,
      agentSessionId: sessionId,
      triggerId: opts.triggerId,
      fireId: opts.fireId,
      ptyCols,
      ptyRows,
    });
    const ptyProc = handle.pty;
    pid = handle.pid ?? undefined;
    registerPty({
      instanceId,
      workspaceId: opts.workspaceInfo.id,
      cols: ptyCols,
      rows: ptyRows,
      ipty: ptyProc,
    });
    ptyProc.onData((data) => {
      logStream.write(data);
    });
    ptyProc.onExit(({ exitCode, signal }) => {
      logStream.end();
      const current = readRecipeInstance(opts.workspaceInfo.path, instanceId);
      if (current && current.status === 'running') {
        const ok = (signal === undefined || signal === 0) && exitCode === 0;
        writeRecipeInstance(opts.workspaceInfo.path, {
          ...current,
          status: ok ? 'success' : 'failure',
          completed_at: Date.now(),
          message:
            signal !== undefined && signal !== 0
              ? `agent exited via signal ${signal}`
              : `agent exited with code ${exitCode}${ok ? ' (no recipe.done call; treating as success)' : ''}`,
        });
      }
    });
  } catch (err) {
    spawnError = err;
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
  }

  if (spawnError) {
    const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
    const failed: RecipeInstance = {
      ...instance,
      status: 'failure',
      completed_at: Date.now(),
      message: `spawn failed: ${msg}`,
    };
    writeRecipeInstance(opts.workspaceInfo.path, failed);
    return {
      recipe_instance_id: instanceId,
      recipe_id: opts.recipeId,
      adhoc: opts.isAdhoc ?? false,
      workspace_id: opts.workspaceInfo.id,
      workspace_path: opts.workspaceInfo.path,
      attach_to_inbox_item_id: opts.attachToInboxItemId ?? null,
      pid: null,
      agent_cli: agentCli,
      session_id: sessionId,
      resume_of: opts.resumeOf ?? null,
      status: 'spawned',
      log_path: logPath,
      view_url: getTerminalServer()?.url(instanceId) ?? null,
      spawn_error: { code: 'SPAWN_FAILED', message: msg },
    };
  }

  // 5. Patch the instance with the pid we got back. Re-read so we don't
  //    clobber a fast-completing agent (echo-stub) that has already written
  //    status=success in the time between spawn and this line.
  if (typeof pid === 'number') {
    const current = readRecipeInstance(opts.workspaceInfo.path, instanceId);
    if (current) {
      writeRecipeInstance(opts.workspaceInfo.path, { ...current, pid });
    } else {
      writeRecipeInstance(opts.workspaceInfo.path, { ...instance, pid });
    }
  }

  return {
    recipe_instance_id: instanceId,
    recipe_id: opts.recipeId,
    adhoc: opts.isAdhoc ?? false,
    workspace_id: opts.workspaceInfo.id,
    workspace_path: opts.workspaceInfo.path,
    attach_to_inbox_item_id: opts.attachToInboxItemId ?? null,
    pid: pid ?? null,
    agent_cli: agentCli,
    session_id: sessionId,
    resume_of: opts.resumeOf ?? null,
    status: 'spawned',
    log_path: logPath,
    view_url: getTerminalServer()?.url(instanceId) ?? null,
  };
}
