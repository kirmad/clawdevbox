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

import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './fs-util.ts';
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

function serverEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  return resolvePath(dirname(here), 'index.ts');
}

/**
 * Resolve the spawn command for the recipe-run's child MCP server.
 *
 *   - Tests (CLAWDEVBOX_SPAWN_TSX=1)        → `npx -y tsx <src/index.ts>`
 *   - CLAWDEVBOX_SPAWN_CMD                  → `<that>` (used by integration tests)
 *   - default                               → `npx -y clawdevbox mcp`
 */
function resolveSpawnedMcpCommand(): { command: string; args: string[] } {
  if (process.env.CLAWDEVBOX_SPAWN_TSX === '1') {
    return { command: 'npx', args: ['-y', 'tsx', serverEntryPath()] };
  }
  if (process.env.CLAWDEVBOX_SPAWN_CMD) {
    return { command: process.env.CLAWDEVBOX_SPAWN_CMD, args: ['mcp'] };
  }
  return { command: 'npx', args: ['-y', 'clawdevbox', 'mcp'] };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

export async function runRecipe(opts: RunRecipeOptions): Promise<RunRecipeResult> {
  const agentCli: string = opts.agentCli ?? 'copilot';
  const instanceId = mintRecipeInstanceId();
  const sessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.length > 0
      ? opts.sessionId
      : `cdb_${instanceId.slice(3)}`;
  const isResume = !!opts.resumeOf;
  const mcpSecret = opts.mcpSecret ?? randomBytes(16).toString('hex');

  // 1. Write .mcp.json so the spawned CLI sees clawdevbox.
  const { command: spawnCmd, args: spawnArgs } = resolveSpawnedMcpCommand();
  const mcpConfigPath = resolvePath(opts.workspaceInfo.path, '.mcp.json');
  const mcpConfig = {
    mcpServers: {
      clawdevbox: {
        type: 'local',
        command: spawnCmd,
        args: spawnArgs,
        env: pruneUndefined({
          CLAWDEVBOX_PROJECT_DIR: opts.workspaceInfo.path,
          CLAWDEVBOX_RECIPE_INSTANCE_ID: instanceId,
          CLAWDEVBOX_WORKSPACE_ID: opts.workspaceInfo.id,
          CLAWDEVBOX_WORKSPACES_ROOT: opts.workspacesRoot,
          CLAWDEVBOX_MCP_URL: opts.mcpUrl ?? process.env.CLAWDEVBOX_MCP_URL,
          CLAWDEVBOX_MCP_SECRET: mcpSecret,
          ADO_ORG: process.env.ADO_ORG,
          ADO_PROJECT: process.env.ADO_PROJECT,
          ADO_BEARER_TOKEN: process.env.ADO_BEARER_TOKEN,
        }),
        tools: ['*'],
      },
    },
  };
  writeFileAtomic(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');

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
      workspaceInfo: opts.workspaceInfo,
      ambientEnv: spawnEnv,
      mcp: { url: opts.mcpUrl ?? '', secret: mcpSecret },
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
