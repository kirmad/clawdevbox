/**
 * session-helpers.ts
 *
 * Single source of truth for spawn/dispatch/list/kill/read of sessions.
 * Used by both `cron-api.ts` HTTP routes and `tools/session.ts` MCP tools
 * so the two protocols can't drift.
 *
 * Helper responsibilities:
 *   spawnDispatchOrResume — smart router. Live? dispatch. Archived+resumable?
 *     resume. Else spawn. Foreign tmux? FOREIGN_NOT_WRITABLE.
 *   dispatchOnly          — pure dispatch to an existing instance_id.
 *   listSessions          — enumerate all live + archived (+ foreign tmux).
 *   killSession           — tries pty, tmux-registry, foreign tmux in order.
 *   readScrollback        — backend-aware: pty (cursor) or tmux (snapshot).
 *
 * All helpers take a `SessionHelperCtx` (db + dispatcher + ws + cfg).
 */

import type { Database } from 'better-sqlite3';
import type { Dispatcher } from './dispatcher.ts';
import type { Workspace } from './workspace.ts';
import type { ResolvedConfig } from './config.ts';
import { join } from 'node:path';
import { withKeyedLock } from './async-mutex.ts';
import { stripTuiNoise } from './agent-clis/shared.ts';
import { logger } from './logger.ts';

export interface SessionHelperCtx {
  db: Database;
  dispatcher: Dispatcher;
  ws: Workspace;
  cfg: ResolvedConfig;
}

export type SendMode = 'spawn' | 'dispatch' | 'resume';

export interface SendArgs {
  prompt: string;
  session_id?: string | null;
  provider?: string | null;
  agent?: string | null;
  model?: string | null;
  workspace_id?: string | null;
  workspace_path?: string | null;
  /** Caller's project dir (from X-Clawdevbox-Project-Dir or env). Fallback for workspace_path. */
  default_workspace_path?: string | null;
  /** Optional fire_id for trigger-context spawns (preserves HTTP /spawn?fire_id behavior). */
  fire_id?: string | null;
}

export type SendResult =
  | { ok: true; mode: SendMode; instance_id: string; session_id: string;
      session_alias?: string | null; state?: 'dispatched'; resumed_from?: string;
      workspace_id?: string; workspace_path?: string }
  | { ok: false; code: SendErrorCode; message: string; details?: Record<string, unknown> };

export type SendErrorCode =
  | 'PROVIDER_REQUIRED'
  | 'WORKSPACE_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'RESUME_FAILED'
  | 'FOREIGN_NOT_WRITABLE'
  | 'NOT_FOUND_FIRE';

/**
 * Smart routing for session.send + HTTP /spawn. Resolves session_id alias
 * to a canonical GUID, checks live state, then routes to:
 *   - dispatch  (live pty exists for this GUID)
 *   - resume    (archived agent_sessions row + provider.supportsResume)
 *   - spawn     (fresh session)
 *
 * Per-GUID async mutex ensures concurrent same-alias calls serialize.
 */
export async function spawnDispatchOrResume(
  ctx: SessionHelperCtx,
  args: SendArgs,
): Promise<SendResult> {
  const { resolveSessionId } = await import('./db/session-aliases-store.ts');
  const { guid: sessionGuid, alias: sessionAlias } = resolveSessionId(ctx.db, args.session_id);

  return withKeyedLock(`session.send:${sessionGuid}`, async () => {
    // 1. LIVE? → dispatch
    const liveInstance = await ctx.dispatcher.findLiveInstanceForSession(sessionGuid);
    if (liveInstance) {
      const dr = await ctx.dispatcher.dispatchToInstance(liveInstance, args.prompt);
      if (dr.status !== 'target_unavailable') {
        return {
          ok: true, mode: 'dispatch',
          instance_id: liveInstance,
          session_id: sessionGuid,
          session_alias: sessionAlias,
          state: 'dispatched',
        };
      }
      // target_unavailable → fall through to spawn/resume (pty died between
      // findLive and dispatch).
    }

    // 2. FOREIGN TMUX? → reject writes
    // If the caller passed an instance-id-like string that matches a live
    // tmux session not in our registry, refuse to send to avoid clobbering
    // a user's shell.
    if (args.session_id) {
      const { tmuxSessionRegistry, tmuxSessionRuntime } =
        await import('./cli-sessions/tmux-session-runtime.ts');
      try {
        const live = await tmuxSessionRuntime().list();
        const asInstance = args.session_id.startsWith('cdb_')
          ? args.session_id.slice(4)
          : args.session_id;
        const isForeign = live.some((s) =>
          (s.name === args.session_id || s.name === `cdb_${args.session_id}`)
          && !tmuxSessionRegistry.get(asInstance)
        );
        if (isForeign) {
          return {
            ok: false,
            code: 'FOREIGN_NOT_WRITABLE',
            message: `session_id '${args.session_id}' is a foreign tmux session — writes are not allowed for safety. Use session.read to observe it.`,
          };
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'session.send: tmux probe failed during foreign-tmux check; falling through to spawn',
        );
      }
    }

    // 3. ARCHIVED + RESUMABLE? → resume
    const resumeRow = lookupResumableArchivedRow(ctx, sessionGuid);
    if (resumeRow) {
      const provider = ctx.ws.agentCliProviders.get(resumeRow.agent_cli);
      if (provider?.supportsResume) {
        try {
          const result = await runResume(ctx, resumeRow, args.prompt, sessionGuid);
          const wsRow = ctx.db.prepare('SELECT id, path FROM workspaces WHERE id = ?')
            .get(resumeRow.workspace_id) as { id: string; path: string } | undefined;
          return {
            ok: true, mode: 'resume',
            instance_id: result.newInstanceId,
            session_id: sessionGuid,
            session_alias: sessionAlias,
            resumed_from: resumeRow.recipe_instance_id ?? resumeRow.id,
            ...(wsRow ? { workspace_id: wsRow.id, workspace_path: wsRow.path } : {}),
          };
        } catch (err) {
          return {
            ok: false,
            code: 'RESUME_FAILED',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      // provider can't resume — fall through to fresh spawn with same GUID.
    }

    // 4. SPAWN
    const provider = args.provider ?? ctx.cfg.defaultAgentCli ?? null;
    if (!provider) {
      return {
        ok: false,
        code: 'PROVIDER_REQUIRED',
        message: 'No `provider` given and `cfg.defaultAgentCli` is not configured.',
      };
    }

    // Workspace resolution precedence:
    //   1. Explicit workspace_id / workspace_path → use as-is.
    //   2. fire_id present → defer to spawnFromCallback's entry.spawnDefaults
    //      so trigger-callback semantics keep their existing workspace.
    //   3. default_workspace_path (legacy callers) → honored.
    //   4. Auto-managed workspace pinned to this session GUID (reused
    //      across resume / re-spawn, fresh on first spawn).
    let workspaceId = args.workspace_id ?? null;
    let workspacePath = args.workspace_path ?? args.default_workspace_path ?? null;
    if (!workspaceId && !workspacePath && !args.fire_id) {
      const ws = await getOrCreateSessionWorkspace(ctx, sessionGuid, sessionAlias);
      workspaceId = ws.id;
      workspacePath = ws.path;
    }

    const result = await ctx.dispatcher.spawnFromCallback(
      args.fire_id ?? null,
      args.prompt,
      {
        agent: args.agent ?? undefined,
        model: args.model ?? undefined,
        workspaceId: workspaceId ?? undefined,
        workspacePath: workspacePath ?? undefined,
        provider,
        sessionId: sessionGuid,
      },
    );
    if (result.status === 'not_found_fire') {
      return { ok: false, code: 'NOT_FOUND_FIRE', message: 'fire not found or not in flight',
               details: { fire_id: args.fire_id } };
    }
    if (result.status === 'spawn_failed') {
      return { ok: false, code: 'SPAWN_FAILED', message: result.message };
    }
    return {
      ok: true, mode: 'spawn',
      instance_id: result.instanceId,
      session_id: result.sessionId,
      session_alias: sessionAlias,
      workspace_id: result.workspaceId,
      workspace_path: result.workspacePath,
    };
  });
}

/**
 * Find or create the workspace pinned to this session GUID.
 *
 * Rule: a session GUID gets ONE workspace for life. The most-recent
 * interactive `agent_sessions` row's `workspace_id` is the binding. When
 * no prior row exists (first spawn), we mint a fresh workspace under
 * `cfg.workspacesRoot` and scaffold the `.clawdevbox/` tree via
 * `ensureWorkspace` (which writes both the DB row and the on-disk index).
 *
 * Concurrency: callers must hold the per-sessionGuid mutex (`session.send:<guid>`).
 * `spawnDispatchOrResume` already does this, so two concurrent first-spawns
 * with the same session_id serialize and only one workspace is minted.
 */
async function getOrCreateSessionWorkspace(
  ctx: SessionHelperCtx,
  sessionGuid: string,
  sessionAlias: string | null,
): Promise<{ id: string; path: string }> {
  const existing = ctx.db.prepare(
    `SELECT w.id AS id, w.path AS path
     FROM agent_sessions s
     JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.cli_session_id = ?
       AND s.interactive = 1
     ORDER BY s.started_at DESC
     LIMIT 1`,
  ).get(sessionGuid) as { id: string; path: string } | undefined;
  if (existing) return existing;

  const { ensureWorkspace, mintWorkspaceId } = await import('./db/workspaces-store.ts');
  const { resolveWorkspacesRoot } = await import('./workspaces-store.ts');
  const root = ctx.cfg.workspacesRoot ?? resolveWorkspacesRoot();
  const id = mintWorkspaceId();
  const path = join(root, id);
  const row = ensureWorkspace(ctx.db, {
    id,
    path,
    name: sessionAlias ?? `session-${sessionGuid.slice(0, 8)}`,
  });
  return { id: row.id, path: row.path };
}

interface ArchivedResumeRow {
  id: string;
  recipe_instance_id: string | null;
  cli_session_id: string;
  workspace_id: string;
  agent_cli: string;
}

function lookupResumableArchivedRow(
  ctx: SessionHelperCtx,
  sessionGuid: string,
): ArchivedResumeRow | null {
  // The agent_sessions table keys live sessions by cli_session_id (the
  // canonical session GUID). When the pty exits, the row stays. Pick the
  // most-recently-started terminal row with this cli_session_id.
  const row = ctx.db.prepare(
    `SELECT id, recipe_instance_id, cli_session_id, workspace_id, agent_cli
     FROM agent_sessions
     WHERE cli_session_id = ?
       AND cli_session_id IS NOT NULL
       AND status != 'running'
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(sessionGuid) as ArchivedResumeRow | undefined;
  return row ?? null;
}

async function runResume(
  ctx: SessionHelperCtx,
  row: ArchivedResumeRow,
  prompt: string,
  sessionGuid: string,
): Promise<{ newInstanceId: string }> {
  const { runRecipe } = await import('./recipe-runner.ts');
  const { resolveWorkspacesRoot } = await import('./workspaces-store.ts');
  const { markResumedInto } = await import('./db/agent-sessions-store.ts');

  // Determine original recipe id (adhoc vs saved).
  let originalRecipeId: string | null = null;
  let isAdhoc = false;
  if (row.recipe_instance_id) {
    const ri = ctx.db.prepare('SELECT recipe_id FROM recipe_instances WHERE id = ?')
      .get(row.recipe_instance_id) as { recipe_id?: string } | undefined;
    originalRecipeId = ri?.recipe_id ?? null;
    isAdhoc = originalRecipeId != null && originalRecipeId.startsWith('__adhoc_');
  }

  // Look up workspace.
  const wsRow = ctx.db.prepare('SELECT id, path FROM workspaces WHERE id = ?')
    .get(row.workspace_id) as { id: string; path: string } | undefined;
  if (!wsRow) throw new Error(`workspace not found: ${row.workspace_id}`);

  const result = await runRecipe({
    recipeId: isAdhoc ? null : originalRecipeId,
    recipeSnapshot: '',
    isAdhoc,
    prompt,
    spawnMode: 'interactive',
    sessionId: row.cli_session_id,
    resumeOf: row.cli_session_id,
    workspaceInfo: { id: wsRow.id, path: wsRow.path },
    agentCli: row.agent_cli,
    workspacesRoot: resolveWorkspacesRoot(),
    ws: ctx.ws,
    cfg: ctx.cfg,
  });
  if (result.spawn_error) {
    throw new Error(`${result.spawn_error.code}: ${result.spawn_error.message}`);
  }

  // Mark the old row as resumed-into the new instance for UI display.
  if (row.recipe_instance_id) {
    try { markResumedInto(ctx.db, row.recipe_instance_id, result.recipe_instance_id); }
    catch (err) { logger.warn({ err }, 'markResumedInto failed (non-fatal)'); }
  }

  // After spawn, FIFO-dispatch the prompt so the resumed copilot picks it up.
  // runRecipe's initial-prompt delivery already handles this when prompt is
  // non-empty, so we don't need a separate dispatch step.

  return { newInstanceId: result.recipe_instance_id };
}

export interface DispatchOnlyArgs {
  instance_id?: string | null;
  session_id?: string | null;
  fire_id?: string | null;
  prompt: string;
}

export type DispatchResult =
  | { ok: true; state: string }
  | { ok: false; code: 'NOT_FOUND_FIRE' | 'NO_DISPATCH_TARGET' | 'TARGET_UNAVAILABLE' | 'NO_TARGET'; message: string };

export async function dispatchOnly(
  ctx: SessionHelperCtx,
  args: DispatchOnlyArgs,
): Promise<DispatchResult> {
  let targetInstance = args.instance_id ?? null;
  if (!targetInstance && args.session_id) {
    const { resolveSessionId } = await import('./db/session-aliases-store.ts');
    const { guid } = resolveSessionId(ctx.db, args.session_id);
    targetInstance = await ctx.dispatcher.findLiveInstanceForSession(guid);
  }
  let r;
  if (targetInstance) {
    r = await ctx.dispatcher.dispatchToInstance(targetInstance, args.prompt);
  } else if (args.fire_id) {
    r = await ctx.dispatcher.dispatchToConductor(args.fire_id, args.prompt);
  } else {
    return { ok: false, code: 'NO_TARGET', message: 'instance_id, session_id, or fire_id required' };
  }
  if (r.status === 'not_found_fire')    return { ok: false, code: 'NOT_FOUND_FIRE', message: 'fire not found or not in flight' };
  if (r.status === 'no_dispatch_target') return { ok: false, code: 'NO_DISPATCH_TARGET', message: 'no dispatch target for this fire' };
  if (r.status === 'target_unavailable') return { ok: false, code: 'TARGET_UNAVAILABLE', message: 'dispatch target pty has exited' };
  return { ok: true, state: r.state };
}

export interface KillResult {
  ok: true;
  killed: boolean;
  kind: 'pty' | 'tmux' | 'foreign-tmux' | 'not_live';
}

export async function killSession(
  ctx: SessionHelperCtx,
  idOrAlias: string,
): Promise<KillResult> {
  // Resolve existing alias/GUID → live instance_id (if any). Otherwise treat
  // idOrAlias as a raw instance_id / tmux session name.
  let instanceId = idOrAlias;
  const { lookupAlias } = await import('./db/session-aliases-store.ts');
  const resolved = lookupAlias(ctx.db, idOrAlias);
  if (resolved) {
    const live = await ctx.dispatcher.findLiveInstanceForSession(resolved.guid);
    if (live) instanceId = live;
  }

  const { hasSession, killPty } = await import('./pty-registry.ts');
  const { tmuxSessionRegistry } = await import('./cli-sessions/tmux-session-runtime.ts');

  // 1) clawdevbox-owned tmux session
  const owned = tmuxSessionRegistry.get(instanceId);
  if (owned) {
    try { await owned.kill(); } catch { /* best effort */ }
    return { ok: true, killed: true, kind: 'tmux' };
  }

  // 2) legacy IPty path
  if (hasSession(instanceId)) {
    const killedOk = killPty(instanceId);
    return { ok: true, killed: killedOk, kind: 'pty' };
  }

  // 3) foreign / leftover tmux
  const { spawnSync } = await import('node:child_process');
  const tmuxBin = process.platform === 'win32' ? 'tmux.exe' : 'tmux';
  const probe = spawnSync(tmuxBin, ['has-session', '-t', instanceId], {
    encoding: 'utf8', timeout: 1500, windowsHide: true,
  });
  if (probe.status === 0) {
    const r = spawnSync(tmuxBin, ['kill-session', '-t', instanceId], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    return { ok: true, killed: r.status === 0, kind: 'foreign-tmux' };
  }

  return { ok: true, killed: false, kind: 'not_live' };
}

export interface ListSessionsOpts {
  status?: 'all' | 'active' | 'archived';
  include_foreign?: boolean;
  since?: number;
  limit?: number;
}

export interface SessionListItem {
  instance_id: string;
  live: boolean;
  state: string;
  queue_depth: number;
  provider_id: string | null;
  recipe_id: string | null;
  cli_session_id: string | null;
  workspace_id: string;
  started_at: number;
  ended_at: number | null;
  kind: 'main' | 'recipe' | 'adhoc' | 'foreign';
  label: string;
  foreign?: true;
  session_alias?: string | null;
}

export interface ListSessionsResult {
  items: SessionListItem[];
  next_since?: number;
}

export async function listSessions(
  ctx: SessionHelperCtx,
  opts: ListSessionsOpts = {},
): Promise<ListSessionsResult> {
  const status = opts.status ?? 'all';
  const includeForeign = opts.include_foreign ?? true;
  const since = opts.since ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const { listSessions: ptyListSessions, getSessionMeta } = await import('./pty-registry.ts');
  const { tmuxSessionRegistry, tmuxSessionRuntime } = await import('./cli-sessions/tmux-session-runtime.ts');
  const { listAllSessions } = await import('./db/agent-sessions-store.ts');
  const db = ctx.db;

  // 1. Legacy pty-registry live entries.
  const ptyLive = ptyListSessions();
  const liveIds = new Set(ptyLive.map((s) => s.instanceId));
  const live: SessionListItem[] = ptyLive.map((s) => {
    const meta = getSessionMeta(s.instanceId);
    // State precedence (same as the tmux path below):
    //   1. exited        → 'exited' (terminal)
    //   2. derivedState  → events.jsonl-derived ('idle' / 'thinking' / 'tool_use' / 'error')
    //   3. fallback      → 'unknown' (pty alive, no signal yet)
    // The Main Agent goes through this path; without (2) it would always
    // show 'unknown' since it has no agent_sessions DB row to fall back on.
    const liveState = s.exited
      ? 'exited'
      : (s.derivedState ?? 'unknown');
    return {
      instance_id: s.instanceId,
      live: true,
      state: liveState,
      queue_depth: 0,
      provider_id: meta?.agentCli ?? null,
      recipe_id: meta?.recipeId ?? null,
      cli_session_id: meta?.sessionId ?? null,
      workspace_id: s.workspaceId,
      started_at: meta?.startedAt ?? 0,
      ended_at: null,
      kind: 'recipe' as const,
      label: '',
    };
  });

  // 2. Tmux-backed entries (the dominant path).
  const tmuxEntries = tmuxSessionRegistry.list();
  if (tmuxEntries.length > 0) {
    const ids = tmuxEntries.map((e) => e.instanceId).filter((id) => !liveIds.has(id));
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT id, cli_session_id, recipe_instance_id, workspace_id, agent_cli,
                started_at, status_text, needs_user_input, derived_state
         FROM agent_sessions
         WHERE recipe_instance_id IN (${placeholders})`,
      ).all(...ids) as Array<{
        id: string; cli_session_id: string | null; recipe_instance_id: string;
        workspace_id: string; agent_cli: string; started_at: number;
        status_text: string | null; needs_user_input: number;
        derived_state: string | null;
      }>;
      const byInstance = new Map(rows.map((r) => [r.recipe_instance_id, r]));
      for (const e of tmuxEntries) {
        if (liveIds.has(e.instanceId)) continue;
        const row = byInstance.get(e.instanceId);
        // State precedence (highest to lowest):
        //   1. agent-self-reported needs_user_input → 'waiting' (block: needs you)
        //   2. events.jsonl-derived state            → 'idle' / 'thinking' / 'tool_use' / 'error'
        //   3. agent-self-reported status_text       → legacy free-text fallback
        //   4. default 'running'                     → live pty, no signal yet
        const liveState = row?.needs_user_input
          ? 'waiting'
          : (row?.derived_state ?? row?.status_text ?? 'running');
        live.push({
          instance_id: e.instanceId,
          live: true,
          state: liveState,
          queue_depth: 0,
          provider_id: row?.agent_cli ?? null,
          recipe_id: null,
          cli_session_id: row?.cli_session_id ?? null,
          workspace_id: row?.workspace_id ?? '',
          started_at: row?.started_at ?? 0,
          ended_at: null,
          kind: 'recipe' as const,
          label: '',
        });
        liveIds.add(e.instanceId);
      }
    }
  }

  // 3. Foreign tmux sessions — only if include_foreign.
  if (includeForeign) {
    try {
      const allTmux = await tmuxSessionRuntime().list();
      for (const s of allTmux) {
        const asInstance = s.name.startsWith('cdb_') ? s.name.slice(4) : s.name;
        if (liveIds.has(asInstance)) continue;
        live.push({
          instance_id: s.name,
          live: true,
          state: 'foreign',
          queue_depth: 0,
          provider_id: null,
          recipe_id: null,
          cli_session_id: null,
          workspace_id: '',
          started_at: 0,
          ended_at: null,
          kind: 'foreign' as const,
          label: '',
          foreign: true,
        });
        liveIds.add(s.name);
      }
    } catch { /* tmux unavailable */ }
  }

  // 4. Archived rows from agent_sessions.
  const archivedAll = listAllSessions(db, { since, limit });
  const archived: SessionListItem[] = archivedAll
    .filter((row) => !liveIds.has(row.recipe_instance_id ?? ''))
    .map((row) => ({
      instance_id: row.recipe_instance_id ?? row.id,
      live: false,
      state: 'archived',
      queue_depth: 0,
      provider_id: row.agent_cli,
      recipe_id: null,
      cli_session_id: row.cli_session_id,
      workspace_id: row.workspace_id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      kind: 'recipe' as const,
      label: '',
    }));

  // Enrich with recipe_id (label/kind) and friendly aliases.
  const archivedInstanceIds = archived.map((a) => a.instance_id).filter(Boolean);
  let recipeMap: Record<string, string> = {};
  if (archivedInstanceIds.length > 0) {
    const ph = archivedInstanceIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, recipe_id FROM recipe_instances WHERE id IN (${ph})`)
      .all(...archivedInstanceIds) as Array<{ id: string; recipe_id: string }>;
    recipeMap = Object.fromEntries(rows.map((r) => [r.id, r.recipe_id]));
  }

  const sessionIds = [...new Set([...live, ...archived]
    .map((item) => item.cli_session_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const aliasBySessionId = new Map<string, string>();
  if (sessionIds.length > 0) {
    const ph = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT alias, session_id FROM session_aliases
       WHERE session_id IN (${ph})
       ORDER BY created_at ASC`,
    ).all(...sessionIds) as Array<{ alias: string; session_id: string }>;
    for (const row of rows) {
      if (!aliasBySessionId.has(row.session_id)) aliasBySessionId.set(row.session_id, row.alias);
    }
  }

  const enrich = (item: SessionListItem) => {
    const isForeign = item.foreign === true;
    const recipeId = item.recipe_id ?? recipeMap[item.instance_id] ?? null;
    const kind: SessionListItem['kind'] =
      isForeign ? 'foreign'
        : item.instance_id === 'main' ? 'main'
        : (recipeId && recipeId.startsWith('__adhoc_')) ? 'adhoc'
        : 'recipe';
    const label =
      kind === 'foreign' ? `tmux: ${item.instance_id}`
        : kind === 'main' ? 'Main Agent'
        : kind === 'adhoc' ? `Spawn ${item.instance_id.slice(-8)}`
        : recipeId ?? item.instance_id;
    const sessionAlias = item.cli_session_id
      ? aliasBySessionId.get(item.cli_session_id) ?? null
      : null;
    return { ...item, recipe_id: recipeId, kind, label, session_alias: sessionAlias };
  };

  const items: SessionListItem[] = [];
  if (status === 'all' || status === 'active') items.push(...live.map(enrich));
  if (status === 'all' || status === 'archived') items.push(...archived.map(enrich));

  const nextSince = archivedAll.length === limit && archivedAll.length > 0
    ? archivedAll[archivedAll.length - 1]!.started_at
    : undefined;

  return { items, ...(nextSince !== undefined ? { next_since: nextSince } : {}) };
}

export interface ReadScrollbackArgs {
  instance_id?: string | null;
  session_id?: string | null;
  since?: string | null;
  full?: boolean;
  raw?: boolean;
}

export interface ReadScrollbackToolResult {
  instance_id: string;
  backend: 'pty' | 'tmux';
  supports_incremental: boolean;
  content: string;
  cursor: string;
  truncated_before: boolean;
  exited: boolean;
  exit_code?: number;
}

const DEFAULT_TAIL_CODE_UNITS = 32 * 1024;
const TMUX_CAPTURE_LINES_DEFAULT = 200;
const TMUX_CAPTURE_LINES_FULL = 10_000;

function parseCursor(cursor: string | null | undefined):
  { instanceId: string; spawnTs: number; offset: number } | null {
  if (!cursor) return null;
  const m = /^([^:]+):(\d+):(\d+)$/.exec(cursor);
  if (!m) return null;
  return { instanceId: m[1]!, spawnTs: Number(m[2]!), offset: Number(m[3]!) };
}

function encodeCursor(instanceId: string, spawnTs: number, offset: number): string {
  return `${instanceId}:${spawnTs}:${offset}`;
}

export type ReadScrollbackResult =
  | { ok: true; result: ReadScrollbackToolResult }
  | { ok: false; code: 'INSTANCE_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'INVALID_CURSOR'; message: string };

export async function readScrollbackHelper(
  ctx: SessionHelperCtx,
  args: ReadScrollbackArgs,
): Promise<ReadScrollbackResult> {
  // Resolve instance_id.
  let instanceId = args.instance_id ?? null;
  if (!instanceId && args.session_id) {
    const { lookupAlias } = await import('./db/session-aliases-store.ts');
    const resolved = lookupAlias(ctx.db, args.session_id);
    instanceId = resolved
      ? await ctx.dispatcher.findLiveInstanceForSession(resolved.guid)
      : null;
    if (!instanceId) {
      return { ok: false, code: 'SESSION_NOT_FOUND',
               message: `No live instance for session_id '${args.session_id}'` };
    }
  }
  if (!instanceId) {
    return { ok: false, code: 'INSTANCE_NOT_FOUND', message: 'instance_id or session_id required' };
  }

  // Validate cursor shape if provided. Empty/null cursors are fine.
  let parsedCursor: ReturnType<typeof parseCursor> = null;
  if (args.since) {
    parsedCursor = parseCursor(args.since);
    if (!parsedCursor) {
      return { ok: false, code: 'INVALID_CURSOR',
               message: `cursor '${args.since}' is malformed (expected <instance>:<spawn_ts>:<offset>)` };
    }
  }

  // Try pty backend first.
  const { readScrollback } = await import('./pty-registry.ts');
  const ptyResult = readScrollback(instanceId, {
    since: parsedCursor && parsedCursor.instanceId === instanceId
      ? parsedCursor.offset : 0,
  });
  if (ptyResult) {
    const truncatedBefore =
      (parsedCursor && parsedCursor.instanceId !== instanceId)
      || (parsedCursor && parsedCursor.instanceId === instanceId
        && parsedCursor.spawnTs !== ptyResult.spawnTs)
      || (parsedCursor && parsedCursor.offset < ptyResult.headOffset)
      || false;

    let content = ptyResult.content;
    if (!args.full && content.length > DEFAULT_TAIL_CODE_UNITS) {
      content = content.slice(content.length - DEFAULT_TAIL_CODE_UNITS);
    }
    if (!args.raw) content = stripTuiNoise(content);
    return {
      ok: true,
      result: {
        instance_id: instanceId,
        backend: 'pty',
        supports_incremental: true,
        content,
        cursor: encodeCursor(instanceId, ptyResult.spawnTs, ptyResult.totalOffset),
        truncated_before: !!truncatedBefore,
        exited: ptyResult.exited,
        exit_code: ptyResult.exitCode,
      },
    };
  }

  // Tmux backend. Owned OR foreign — both go through capture-pane.
  const { spawnSync } = await import('node:child_process');
  const tmuxBin = process.platform === 'win32' ? 'tmux.exe' : 'tmux';
  // Owned sessions are stored as cdb_<instance>; foreign sessions use their
  // literal name. Try `cdb_<id>` first, then bare `<id>`.
  const candidates = [`cdb_${instanceId}`, instanceId];
  let tmuxName: string | null = null;
  for (const c of candidates) {
    const probe = spawnSync(tmuxBin, ['has-session', '-t', c], {
      encoding: 'utf8', timeout: 1500, windowsHide: true,
    });
    if (probe.status === 0) { tmuxName = c; break; }
  }
  if (!tmuxName) {
    return { ok: false, code: 'INSTANCE_NOT_FOUND',
             message: `no live pty or tmux session for instance_id '${instanceId}'` };
  }

  const lines = args.full ? TMUX_CAPTURE_LINES_FULL : TMUX_CAPTURE_LINES_DEFAULT;
  const cap = spawnSync(tmuxBin, [
    'capture-pane', '-p', '-t', tmuxName, '-S', `-${lines}`,
    ...(args.raw ? ['-e'] : []),
  ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  let content = cap.stdout ?? '';
  if (!args.raw) content = stripTuiNoise(content);
  // Tmux snapshot cursor is always "fresh start" — offset 0 with current ts.
  return {
    ok: true,
    result: {
      instance_id: instanceId,
      backend: 'tmux',
      supports_incremental: false,
      content,
      cursor: encodeCursor(instanceId, Date.now(), 0),
      truncated_before: false,
      exited: false,
    },
  };
}
