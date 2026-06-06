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

import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { registerPty } from './pty-registry.ts';
import { getTerminalServer } from './terminal-server.ts';
import {
  watchCopilotStatus,
  type StatusWatcher,
} from './agent-clis/copilot-events.ts';
import { updateDerivedState } from './db/agent-sessions-store.ts';
import { emitChange } from './event-bus.ts';
import {
  mintRecipeInstanceId,
  readRecipeInstance,
  recipeInstancesDir,
  writeRecipeInstance,
  type RecipeInstance,
} from './recipe-instances-store.ts';
import { getDatabase } from './db/index.ts';
import { buildProviderCtx } from './agent-clis/shared.ts';
import { parseRecipeSource } from './validators.ts';
import { logger } from './logger.ts';
import type { CliSession } from './cli-sessions/types.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';

export interface RunRecipeOptions {
  /**
   * Resolved recipe id (after scope-chain lookup), OR null for ad-hoc
   * sessions that don't load a recipe. When null, `isAdhoc` must be true.
   */
  recipeId: string | null;
  /**
   * Raw YAML snapshot to record on the instance row. Required when
   * recipeId is non-null; ignored (use empty string) for ad-hoc sessions.
   */
  recipeSnapshot: string;
  /** True when the recipe was supplied inline (no saved file) OR when this is an ad-hoc no-recipe session. */
  isAdhoc?: boolean;
  /** First user message handed to the spawned agent. */
  prompt: string;
  /**
   * 'headless' (default) preserves current behavior — provider spawns with
   * --print/-p, agent exits on completion. 'interactive' keeps the pty
   * alive after the first turn; opts.prompt becomes the seed prompt
   * delivered via deliverInitialPromptWhenReady (already in the provider).
   * Interactive runs register a SessionConductor in pty-registry for
   * downstream dispatch via /dispatch/<fire_id> or in-process callers.
   */
  spawnMode?: 'interactive' | 'headless';
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
  /**
   * Optional model override (passed as `--model <name>` to the agent CLI).
   * Supported by copilot/claude/agency providers; stub providers ignore.
   */
  model?: string;
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

/**
 * Pretty-print a spawn (file, args[]) into a single command line for
 * display in the terminal viewer header. Quotes args that contain
 * whitespace or shell metacharacters; truncates long arrays (prompts
 * can be many KB) so the header stays readable.
 */
function formatCommandLine(file: string, args: string[]): string {
  const quote = (s: string): string => {
    if (s.length === 0) return '""';
    return /[\s"'`$&|;<>(){}\\]/.test(s) ? JSON.stringify(s) : s;
  };
  const MAX_ARG_LEN = 80;
  const truncated = args.map((a) => {
    if (a.length <= MAX_ARG_LEN) return quote(a);
    return quote(a.slice(0, MAX_ARG_LEN) + `…[+${a.length - MAX_ARG_LEN} chars]`);
  });
  return [quote(file), ...truncated].join(' ');
}


export async function runRecipe(opts: RunRecipeOptions): Promise<RunRecipeResult> {
  // Resolve agent_cli with the same fallback chain as the `recipe.run` tool:
  // explicit opts → recipe YAML's `agent_cli` field → cfg.defaultAgentCli →
  // 'copilot'. The dispatcher's recipe-binding path calls runRecipe without
  // setting opts.agentCli, so we re-derive from the recipe snapshot here to
  // honor `agent_cli: e2e-test-runner`-style declarations end-to-end.
  let recipeAgentCli: string | null = null;
  if (opts.recipeId !== null) {
    try {
      const parsed = parseRecipeSource(opts.recipeSnapshot);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const v = (parsed as Record<string, unknown>).agent_cli;
        if (typeof v === 'string' && v.length > 0) recipeAgentCli = v;
      }
    } catch {
      /* malformed snapshots fall through to the default chain */
    }
  }
  const agentCli: string =
    opts.agentCli ?? recipeAgentCli ?? opts.cfg.defaultAgentCli ?? 'copilot';
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
  // The bearer the agent uses to call back into /mcp must match the server's
  // `cfg.http.token` (the only credential the HTTP MCP transport accepts).
  // `opts.mcpSecret` lets callers override for tests; otherwise we use the
  // configured http token (which may be empty when bearer auth is disabled).
  const mcpSecret = opts.mcpSecret ?? opts.cfg.http.token ?? '';

  // The agent's .mcp.json is written by the provider's writeMcpJson via the
  // SpawnSessionOpts.mcp object (see agent-clis/shared.ts). That write
  // points the agent at the long-lived HTTP MCP server and injects per-spawn
  // headers (X-Clawdevbox-Workspace-Id, X-Clawdevbox-Recipe-Instance-Id, etc.)
  // that the server's tool handlers read via extra.requestInfo.headers (see
  // context-resolver.ts). Workspace context is therefore identified
  // per-request rather than relying on a shared server's process.env, which
  // doesn't reflect the calling agent in multi-agent HTTP scenarios.

  // 2. Write the instance row (file + DB) before spawning.
  const isAdhoc = opts.isAdhoc === true || opts.recipeId === null;
  const recipeIdResolved = opts.recipeId ?? `__adhoc_${instanceId}`;
  const recipeSnapshot = opts.recipeId === null ? '' : opts.recipeSnapshot;
  const spawnMode: 'interactive' | 'headless' =
    opts.spawnMode === 'interactive' ? 'interactive' : 'headless';

  const instance: RecipeInstance = {
    id: instanceId,
    recipe_id: recipeIdResolved,
    recipe_snapshot: recipeSnapshot,
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
  writeRecipeInstance(opts.workspaceInfo.path, instance, { interactive: spawnMode === 'interactive' });

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
      recipe_id: recipeIdResolved,
      adhoc: isAdhoc,
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

  const baseProviderCtx = buildProviderCtx(opts.ws, opts.cfg);
  // Wrap spawnPty so we can capture (file, args, cwd) from whichever
  // provider actually launches the pty. Providers are opaque from here —
  // recipe-runner doesn't know if the binary is `copilot`, `claude`, or
  // a plugin like `agency`. The wrapper records the *last* invocation
  // (typical case: providers spawn the agent CLI exactly once) and we
  // surface that to the pty-registry meta so the terminal viewer can
  // display the actual command line + cwd in its header.
  //
  // Held inside a container so TS doesn't narrow the `let` across the
  // intervening `await provider.spawnSession(...)` — the assignment
  // happens inside a callback that isn't part of the synchronous flow.
  const lastSpawnRef: { value: { file: string; args: string[]; cwd: string } | null } = { value: null };
  const providerCtx = {
    ...baseProviderCtx,
    spawnPty: (file: string, args: string[], ptyOpts: { cwd: string; env: Record<string, string>; cols: number; rows: number; name?: string }) => {
      lastSpawnRef.value = { file, args: [...args], cwd: ptyOpts.cwd };
      return baseProviderCtx.spawnPty(file, args, ptyOpts);
    },
  };
  const ptyCols = 120;
  const ptyRows = 30;
  // Resolve the MCP URL the spawned CLI will connect back to. The dispatcher
  // (cron / trigger) path and the recipe.run MCP tool both call runRecipe
  // without setting opts.mcpUrl — falling back to "" writes a malformed
  // .mcp.json that copilot/claude reject with "url: Invalid url" before they
  // can even start. Derive it from cfg.http instead.
  const mcpUrl =
    opts.mcpUrl && opts.mcpUrl !== ''
      ? opts.mcpUrl
      : `http://${opts.cfg.http.host}:${opts.cfg.http.port}/mcp`;
  let pid: number | undefined;
  let spawnError: unknown = null;
  try {
    const handle = await provider.spawnSession(providerCtx, {
      mode: spawnMode,
      init: isResume
        ? { kind: 'resume', session_id: sessionId }
        : { kind: 'new', session_id: sessionId },
      role: 'recipe-instance',
      prompt: opts.prompt,
      agent: opts.agent,
      model: opts.model,
      workspaceInfo: opts.workspaceInfo,
      ambientEnv: spawnEnv,
      mcp: {
        url: mcpUrl,
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
    pid = handle.pid ?? undefined;
    const lastSpawn = lastSpawnRef.value;
    const commandLine = lastSpawn
      ? formatCommandLine(lastSpawn.file, lastSpawn.args)
      : undefined;

    // Tmux-migrated providers return a CliSession (no .pty fd). Legacy providers
    // return a node-pty IPty. Branch on which one the provider populated.
    const ptyProc = handle.pty;
    if (ptyProc) {
      // Legacy IPty path (pre-tmux-migration providers + e2e-test-runner).
      registerPty({
        instanceId,
        workspaceId: opts.workspaceInfo.id,
        cols: ptyCols,
        rows: ptyRows,
        ipty: ptyProc,
        meta: {
          cwd: lastSpawn?.cwd ?? opts.workspaceInfo.path,
          commandLine,
          agentCli,
          sessionId,
          recipeId: recipeIdResolved,
        },
        provider: spawnMode === 'interactive' ? provider : undefined,
        agentHandle: spawnMode === 'interactive' ? handle : undefined,
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
    } else if (handle.session) {
      // Tmux-backed path. Agent lives inside `tmux new-session -s cdb_<id>`.
      // We don't register a pty (T19 will pivot pty-registry to viewer-only
      // IPtys spawned by terminal-server). The agent is already in
      // tmuxSessionRegistry — registered by the provider. The exited promise
      // drives the status writeback.
      try { logStream.end(); } catch { /* ignore */ }

      // Start the events.jsonl-based live status watcher when the provider
      // exposes the copilot-events idle signal. Writes to
      // agent_sessions.derived_state so the Terminals-tab icon reflects the
      // live agent state (thinking/tool_use/idle/error). pty-registry has the
      // mirror of this for the legacy IPty path; this is the tmux equivalent.
      let statusWatcher: StatusWatcher | null = null;
      if (provider.capabilities?.idleSignal === 'copilot-events' && sessionId) {
        try {
          statusWatcher = watchCopilotStatus(sessionId, (cls) => {
            try {
              const changed = updateDerivedState(getDatabase(), instanceId, {
                state: cls.state,
                ts: Date.now(),
              });
              if (changed) emitChange('sessions');
            } catch (err) {
              logger.debug({ err: String(err), instanceId },
                'recipe-runner: updateDerivedState failed');
            }
          });
        } catch (err) {
          logger.warn({ err: String(err), sessionId, instanceId },
            'recipe-runner: watchCopilotStatus failed to start');
        }
      }

      handle.exited.then(({ exitCode, signal }) => {
        if (statusWatcher) {
          try { statusWatcher.stop(); } catch { /* idempotent */ }
          statusWatcher = null;
        }
        const current = readRecipeInstance(opts.workspaceInfo.path, instanceId);
        if (current && current.status === 'running') {
          const ok = (signal === undefined || signal === '0') && exitCode === 0;
          writeRecipeInstance(opts.workspaceInfo.path, {
            ...current,
            status: ok ? 'success' : 'failure',
            completed_at: Date.now(),
            message:
              signal && signal !== '0'
                ? `agent exited via signal ${signal}`
                : `agent exited with code ${exitCode}${ok ? ' (no recipe.done call; treating as success)' : ''}`,
          });
        }
      });
    }
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
      recipe_id: recipeIdResolved,
      adhoc: isAdhoc,
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

  // 6. Initial prompt delivery for tmux-migrated interactive providers.
  //    The provider no longer auto-delivers the seed prompt (the
  //    deliverInitialPromptWhenReady byte-stream helper was removed in T15-T17).
  //    Instead, we fire-and-forget a snapshot-poll readiness wait + dispatch
  //    via the dispatcher's standard pending-dispatch path. This lets the
  //    initial prompt benefit from update_status done-detection just like any
  //    follow-up dispatch.
  //
  //    Skipped when:
  //      - no opts.prompt (interactive shell without a seed)
  //      - spawnMode !== 'interactive' (headless already passed -p to the CLI)
  //      - the provider hasn't been tmux-migrated (handle.session missing —
  //        legacy IPty providers ignore opts.prompt now, but no caller relies
  //        on initial prompt for headless e2e-test-runner)
  if (spawnMode === 'interactive' && opts.prompt) {
    const { tmuxSessionRegistry } = await import('./cli-sessions/tmux-session-runtime.ts');
    const session = tmuxSessionRegistry.get(instanceId);
    if (session) {
      void deliverInitialPromptAfterReady(instanceId, session, opts.prompt, {
        agentCli, sessionId, ws: opts.ws,
      });
    }
  }

  return {
    recipe_instance_id: instanceId,
    recipe_id: recipeIdResolved,
    adhoc: isAdhoc,
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

/**
 * Fire-and-forget: wait for the agent's TUI to draw the prompt-ready glyph
 * (and the model-line indicator for copilot), then dispatch the initial
 * prompt via the standard dispatcher path. Errors are logged but never
 * raised — the caller has already returned to its caller.
 */
async function deliverInitialPromptAfterReady(
  instanceId: string,
  session: CliSession,
  prompt: string,
  ctx: { agentCli: string; sessionId: string; ws: Workspace },
): Promise<void> {
  try {
    const { waitForReady } = await import('./cli-sessions/wait-for-ready.ts');
    await waitForReady(session, {
      // Copilot/Agency: `❯` glyph, status bar `context (N%)`. Claude: `❯`
      // followed by NBSP or space; no context line. We test for both and
      // accept either fully-rendered indicator.
      promptReadyRegex: /❯/,
      fullyRenderedRegex: /context\s*\(\d+%\)|Model:|Conversation/i,
      pollIntervalMs: 500,
      stableMs: 2500,
      timeoutMs: 90_000,
    });
  } catch (err) {
    logger.warn(
      { instanceId, err: err instanceof Error ? err.message : String(err) },
      'recipe-runner: waitForReady failed; dispatching initial prompt anyway',
    );
  }

  // Belt-and-suspenders: if the provider opts into the copilot-events
  // idle signal, also wait for assistant.turn_end / first-idle in the
  // structured event stream before sending. This catches the case where
  // the glyph is on-screen but the readline buffer isn't accepting input
  // yet (Copilot's initial render races vs MCP server connect).
  try {
    const provider = ctx.ws.agentCliProviders?.get(ctx.agentCli);
    if (provider?.capabilities?.idleSignal === 'copilot-events') {
      const { waitForCopilotIdle } = await import('./agent-clis/copilot-events.ts');
      const r = await waitForCopilotIdle(ctx.sessionId, { timeoutMs: 15_000 });
      if (!r.ready) {
        logger.info(
          { instanceId, sessionId: ctx.sessionId, reason: r.reason, lastEvent: r.lastEvent, waitedMs: r.waitedMs },
          'recipe-runner: copilot-events idle wait fell through; sending initial prompt anyway',
        );
      } else {
        logger.debug(
          { instanceId, sessionId: ctx.sessionId, lastEvent: r.lastEvent, waitedMs: r.waitedMs },
          'recipe-runner: copilot-events confirmed idle before initial prompt',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { instanceId, err: err instanceof Error ? err.message : String(err) },
      'recipe-runner: copilot-events wait threw (continuing to send prompt)',
    );
  }

  try {
    // Send Escape + text + Enter via the session API. We don't go through
    // dispatcher.dispatchToInstance here to avoid a circular dep — and the
    // initial prompt doesn't need pending-dispatch queueing (it's the FIRST
    // bytes the agent sees).
    await session.sendKey('Escape');
    await new Promise((r) => setTimeout(r, 200));
    await session.sendText(prompt);
    await new Promise((r) => setTimeout(r, 250));
    await session.sendKey('Enter');
  } catch (err) {
    logger.warn(
      { instanceId, err: err instanceof Error ? err.message : String(err) },
      'recipe-runner: initial prompt dispatch failed',
    );
  }
}
