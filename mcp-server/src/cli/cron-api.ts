/**
 * cli/cron-api.ts
 *
 * HTTP routes for the trigger kernel introspection + control surface
 * (spec §9). Mounted by `cli/start.ts` inside the main HTTP server so the
 * SPA, the second-instance start probe, and the MCP bootstrap can all
 * speak to the same endpoints:
 *
 *   GET  /api/cron/status         singleton + scheduler + dispatcher + db
 *   GET  /api/fires               filterable list, default 50, max 500
 *   GET  /api/fires/:fire_id      single fire + on-disk stdout/stderr/callbacks
 *   POST /api/fires/:fire_id/retry  manual requeue of a terminal fire
 *   POST /api/cron/diagnose       force scheduler reschedule
 *   POST /dispatch/:fire_id       per-fire bearer — route prompt to subscriber pty
 *   POST /spawn/:fire_id          per-fire bearer — spawn a fresh agent
 *   GET  /api/sessions/:instance  introspect a live pty/conductor
 *
 * Auth: all `/api/*` routes require `Authorization: Bearer <token>` matched
 * against `cfg.http.token`. `/dispatch/:fire_id` and `/spawn/:fire_id` use a
 * per-fire secret minted by the dispatcher when a script binding runs.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from 'better-sqlite3';
import type { ResolvedConfig } from '../config.ts';
import type { SessionHelperCtx } from '../session-helpers.ts';
import {
  attemptDir,
  getFire,
  listFires,
  markFireForRetry,
  type FireRow,
} from '../db/fires-store.ts';
import type { Dispatcher } from '../dispatcher.ts';
import type { Scheduler } from '../scheduler.ts';
import type { Workspace } from '../workspace.ts';
import type { runRecipe as RunRecipeFn } from '../recipe-runner.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CronApiContext {
  db: Database;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  dbPath: string;
  schemaVersion: number;
  service: { pid: number; port: number; started_at: number; version: string };
  /**
   * Expected bearer token for `/api/*` routes. When null/empty, auth is
   * disabled — the server is treated as loopback-only and any caller may
   * hit these endpoints. The per-fire secret used on `/dispatch/<fire_id>`
   * and `/spawn/<fire_id>` is independent of this token.
   */
  expectedToken: string | null;
  /**
   * Workspace whose `agentCliProviders` registry is consulted by
   * `/api/sessions/<id>/resume` and which is passed through to
   * `runRecipe`. Optional for backward compat with legacy callers /
   * test harnesses that don't exercise the resume endpoint.
   */
  ws?: Workspace;
  cfg?: ResolvedConfig;
  /**
   * Test seam — override the resume endpoint's call into `runRecipe`.
   * Production wiring leaves this unset; tests inject a stub that
   * records the call and returns a deterministic result without
   * spawning a real pty.
   */
  runRecipeFn?: typeof RunRecipeFn;
}

function sessionHelperCtx(ctx: CronApiContext): SessionHelperCtx {
  const ws = ctx.ws ?? (ctx.dispatcher as unknown as { ws?: Workspace }).ws;
  if (!ws) throw new Error('workspace not available in this server context');
  const cfg = ctx.cfg ?? ({
    projectDir: ws.projectDir,
    globalDir: ws.globalDir,
    workspacesRoot: join(ws.globalDir, 'workspaces'),
    http: { port: 0, host: '127.0.0.1', token: null },
    tunnel: { kind: 'none', name: null, allow_anonymous: false, auto_start: false },
    notifications: { enabled: false, vapid: null },
    cron: { max_concurrent: 4, dispatcher_drain_ms: 15_000 },
    configPath: null,
    defaultAgentCli: 'copilot',
    clientSync: { mode: 'off', bidirectionalUninstall: false, discoveredPlugins: [] },
    vaults: [],
  } satisfies ResolvedConfig);
  return { db: ctx.db, dispatcher: ctx.dispatcher, ws, cfg };
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

function reject401(res: ServerResponse, msg: string): void {
  // No `WWW-Authenticate` header — see start.ts:rejectUnauthorized for
  // rationale (Copilot CLI's MCP SDK misinterprets it as OAuth required).
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: msg } }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const MAX = 1024 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c instanceof Buffer ? c : Buffer.from(c);
    total += buf.length;
    if (total > MAX) return null;
    chunks.push(buf);
  }
  if (total === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function readFileTruncated(path: string): { text: string; truncated: boolean } {
  if (!existsSync(path)) return { text: '', truncated: false };
  try {
    const stat = statSync(path);
    if (stat.size <= MAX_OUTPUT_BYTES) {
      return { text: readFileSync(path, 'utf8'), truncated: false };
    }
    const buf = Buffer.alloc(MAX_OUTPUT_BYTES);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, MAX_OUTPUT_BYTES, 0);
    } finally {
      closeSync(fd);
    }
    return { text: buf.toString('utf8'), truncated: true };
  } catch {
    return { text: '', truncated: false };
  }
}

function attemptsAvailable(fireDir: string): number[] {
  if (!existsSync(fireDir)) return [];
  try {
    const out: number[] = [];
    for (const name of readdirSync(fireDir)) {
      const m = name.match(/^attempt-(\d+)$/);
      if (m) out.push(parseInt(m[1]!, 10));
    }
    out.sort((a, b) => a - b);
    return out;
  } catch {
    return [];
  }
}

function workspacePath(db: Database, workspace_id: string): string | null {
  const row = db
    .prepare(`SELECT path FROM workspaces WHERE id = ?`)
    .get(workspace_id) as { path?: string } | undefined;
  return row?.path ?? null;
}

/**
 * Returns true when this handler consumed the request (including auth
 * rejections). Returns false when the URL doesn't match any of our routes
 * so the caller can fall through to other dispatchers.
 */
export async function handleCronApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CronApiContext,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // ----- POST /dispatch -----------------------------------------------------
  // Loopback-only, NO auth. Routes a prompt to either:
  //   • the SessionConductor of the fire's subscriber pty (when ?fire_id=<id>),
  //   • a specific instance_id (when ?instance_id=<id> or body.instance_id),
  //   • or the fire's target (when body.fire_id is set instead of query).
  //
  // Body: { prompt: string, instance_id?: string, fire_id?: string }
  // Query: ?fire_id=<id> or ?instance_id=<id>
  if (path === '/dispatch') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const body = (await readJson<{ prompt?: unknown; instance_id?: unknown; fire_id?: unknown }>(req)) ?? {};
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      sendJson(res, 400, { error: 'prompt required (non-empty string)' });
      return true;
    }
    const fireId = url.searchParams.get('fire_id')
      ?? (typeof body.fire_id === 'string' ? body.fire_id : null);
    const instanceId = url.searchParams.get('instance_id')
      ?? (typeof body.instance_id === 'string' ? body.instance_id : null);

    const { dispatchOnly } = await import('../session-helpers.ts');
    const result = await dispatchOnly(sessionHelperCtx(ctx), {
      prompt: body.prompt,
      instance_id: instanceId,
      session_id: null,
      fire_id: fireId,
    });
    if (!result.ok) {
      const httpStatus =
        result.code === 'NOT_FOUND_FIRE' ? 404 :
        result.code === 'NO_DISPATCH_TARGET' ? 404 :
        result.code === 'TARGET_UNAVAILABLE' ? 404 :
        400;
      sendJson(res, httpStatus, { error: result.message, code: result.code, fire_id: fireId });
      return true;
    }
    sendJson(res, 200, { ok: true, queued_at: Date.now(), state: result.state });
    return true;
  }

  // ----- POST /spawn --------------------------------------------------------
  // Loopback-only, NO auth. Smart routing:
  //
  //   1. Resolve session_id → canonical GUID (mints + saves alias mapping
  //      if input is not already a GUID; lets callers use friendly names
  //      like "my-feature" or "pr-4547615").
  //   2. Resolve workspace from workspace_id or workspace_path (auto-creates
  //      the row if it doesn't exist yet).
  //   3. Delegate to the shared session router: live sessions dispatch,
  //      resumable archived sessions resume, and otherwise a fresh pty spawns.
  //
  // Body: { prompt, session_id?, provider?, workspace_path?, workspace_id?,
  //         agent?, fire_id? }
  // Query: ?fire_id=<id>
  //
  // Response: { ok, mode: 'spawn' | 'dispatch' | 'resume', instance_id,
  //             session_id, session_alias?, resumed_from? }
  if (path === '/spawn') {
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    const body = (await readJson<{
      prompt?: unknown;
      agent?: unknown;
      model?: unknown;
      session_id?: unknown;
      workspace_id?: unknown;
      workspace_path?: unknown;
      provider?: unknown;
      fire_id?: unknown;
    }>(req)) ?? {};
    if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
      sendJson(res, 400, { error: 'prompt required (non-empty string)' });
      return true;
    }
    const fireId = url.searchParams.get('fire_id')
      ?? (typeof body.fire_id === 'string' ? body.fire_id : null);

    const { spawnDispatchOrResume } = await import('../session-helpers.ts');
    const result = await spawnDispatchOrResume(sessionHelperCtx(ctx), {
      prompt: body.prompt,
      session_id: typeof body.session_id === 'string' ? body.session_id : null,
      provider: typeof body.provider === 'string' ? body.provider : null,
      agent: typeof body.agent === 'string' ? body.agent : null,
      model: typeof body.model === 'string' ? body.model : null,
      workspace_id: typeof body.workspace_id === 'string' ? body.workspace_id : null,
      workspace_path: typeof body.workspace_path === 'string' ? body.workspace_path : null,
      default_workspace_path: null,
      fire_id: fireId,
    });
    if (!result.ok) {
      const httpStatus =
        result.code === 'NOT_FOUND_FIRE' ? 404 :
        result.code === 'SPAWN_FAILED' ? 500 :
        result.code === 'RESUME_FAILED' ? 500 :
        result.code === 'PROVIDER_REQUIRED' ? 400 :
        result.code === 'FOREIGN_NOT_WRITABLE' ? 403 :
        500;
      sendJson(res, httpStatus, {
        error: result.message,
        code: result.code,
        ...(result.code === 'NOT_FOUND_FIRE' ? { fire_id: fireId } : {}),
      });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      mode: result.mode,
      instance_id: result.instance_id,
      session_id: result.session_id,
      session_alias: result.session_alias ?? null,
      ...(result.state ? { state: result.state } : {}),
      ...(result.resumed_from ? { resumed_from: result.resumed_from } : {}),
    });
    return true;
  }

  // -- /api/sessions* routes are loopback-only (no bearer required) ---------
  // Matches the convention of /api/recipes, /api/inbox, /api/triggers, etc.
  // The SPA consumes these without a bearer; bearer-gated routes below are
  // for the /api/cron/* + /api/fires* maintenance surface.
  //
  // The list endpoint MUST come BEFORE the singular /api/sessions/<id> route
  // because the singular regex `/^\/api\/sessions\/([^/]+)\/?$/` would
  // otherwise match `/api/sessions` (empty id) and shadow it.
  if (path === '/api/sessions' && method === 'GET') {
    const { listSessions } = await import('../session-helpers.ts');
    const result = await listSessions(sessionHelperCtx(ctx), {
      status: (url.searchParams.get('status') as 'all' | 'active' | 'archived') ?? 'all',
      include_foreign: url.searchParams.get('include_foreign') !== 'false',
      since: Number(url.searchParams.get('since') ?? 0) || 0,
      limit: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200),
    });
    sendJson(res, 200, result);
    return true;
  }

  // ----- POST /api/sessions/<instance_id>/resume ----------------------------
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/resume\/?$/);
    if (m && method === 'POST') {
      const instanceId = decodeURIComponent(m[1]!);
      const { hasSession } = await import('../pty-registry.ts');
      if (hasSession(instanceId)) {
        sendJson(res, 400, { error: 'session is currently live; resume not applicable' });
        return true;
      }
      const db = ctx.db;
      const row = db
        .prepare('SELECT * FROM agent_sessions WHERE recipe_instance_id = ? OR id = ?')
        .get(instanceId, instanceId) as Record<string, unknown> | undefined;
      if (!row) { sendJson(res, 404, { error: 'session not found' }); return true; }

      if (!ctx.ws) {
        sendJson(res, 500, { error: 'workspace not available in this server context' });
        return true;
      }
      const provider = ctx.ws.agentCliProviders.get(String(row.agent_cli));
      if (!provider) {
        sendJson(res, 422, { error: `provider not registered: ${row.agent_cli}` });
        return true;
      }
      if (!provider.supportsResume) {
        sendJson(res, 422, { error: `provider '${row.agent_cli}' does not support --resume` });
        return true;
      }
      if (!row.cli_session_id) {
        sendJson(res, 422, { error: 'session has no cli_session_id; cannot resume' });
        return true;
      }

      // Look up the original recipe_id (if any) for ad-hoc detection.
      let originalRecipeId: string | null = null;
      if (row.recipe_instance_id) {
        const ri = db
          .prepare('SELECT recipe_id FROM recipe_instances WHERE id = ?')
          .get(row.recipe_instance_id) as { recipe_id?: string } | undefined;
        originalRecipeId = ri?.recipe_id ?? null;
      }
      const isAdhoc = originalRecipeId !== null && originalRecipeId.startsWith('__adhoc_');

      const wsRow = db
        .prepare('SELECT id, path FROM workspaces WHERE id = ?')
        .get(row.workspace_id) as { id: string; path: string } | undefined;
      if (!wsRow) {
        sendJson(res, 500, { error: `workspace not found: ${row.workspace_id}` });
        return true;
      }

      try {
        const { runRecipe } = await import('../recipe-runner.ts');
        const { resolveConfig } = await import('../config.ts');
        const { resolveWorkspacesRoot } = await import('../workspaces-store.ts');
        const cfg = resolveConfig({ projectDir: ctx.ws.projectDir, globalDir: ctx.ws.globalDir });
        const runFn = ctx.runRecipeFn ?? runRecipe;
        const result = await runFn({
          recipeId: isAdhoc ? null : originalRecipeId,
          recipeSnapshot: '',
          isAdhoc,
          prompt: '',
          spawnMode: 'interactive',
          resumeOf: String(row.cli_session_id),
          workspaceInfo: { id: wsRow.id, path: wsRow.path },
          agentCli: String(row.agent_cli),
          workspacesRoot: resolveWorkspacesRoot(),
          ws: ctx.ws,
          cfg,
        });
        if (result.spawn_error) {
          sendJson(res, 500, { error: `spawn failed: ${result.spawn_error.code}: ${result.spawn_error.message}` });
          return true;
        }
        const { markResumedInto, inheritResumedTitles } = await import('../db/agent-sessions-store.ts');
        markResumedInto(db, instanceId, result.recipe_instance_id);
        // Carry forward the old session's task_title + subtask_title so the
        // resumed tab visibly inherits the original goal (otherwise it would
        // appear as a bare "Spawn xxx" until the agent re-calls update_status).
        try { inheritResumedTitles(db, instanceId, result.recipe_instance_id); }
        catch { /* non-fatal */ }
        sendJson(res, 200, {
          ok: true,
          new_instance_id: result.recipe_instance_id,
          session_id: result.session_id,
        });
      } catch (err) {
        sendJson(res, 500, { error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      return true;
    }
  }

  // ----- GET /api/sessions/<instance_id> ----------------------------------
  {
    const m = path.match(/^\/api\/sessions\/([^/]+)\/?$/);
    if (m && method === 'GET') {
      const { hasSession, getSessionMeta } = await import('../pty-registry.ts');
      const instanceId = decodeURIComponent(m[1]!);
      if (!hasSession(instanceId)) { sendJson(res, 404, { error: 'session not found' }); return true; }
      const meta = getSessionMeta(instanceId);
      sendJson(res, 200, {
        instance_id: instanceId,
        // state + queue_depth: see comment in /api/sessions handler above.
        // These will read from agent_sessions/pending-dispatch in T19.
        state: 'unknown' as const,
        queue_depth: 0,
        provider_id: meta?.agentCli ?? null,
        agent_session_id: meta?.sessionId ?? null,
      });
      return true;
    }
    // DELETE /api/sessions/<instance_id> — kill the pty tree. Use when a
    // graceful /exit isn't an option (copilot doesn't have a built-in
    // /exit command). Idempotent: 200 whether or not the session existed.
    if (m && method === 'DELETE') {
      const { killSession } = await import('../session-helpers.ts');
      const instanceId = decodeURIComponent(m[1]!);
      const result = await killSession(sessionHelperCtx(ctx), instanceId);
      if (result.kind === 'not_live') {
        sendJson(res, 200, { ok: true, killed: false, reason: 'not_live' });
      } else {
        sendJson(res, 200, { ok: true, killed: result.killed, kind: result.kind });
      }
      return true;
    }
    // GET /api/sessions/<instance_id>/artifacts — list artifacts emitted by
    // this session's recipe instance. Used by the Terminals tab side panel
    // to surface "what files / outputs has this agent produced".
    {
      const ma = path.match(/^\/api\/sessions\/([^/]+)\/artifacts\/?$/);
      if (ma && method === 'GET') {
        const instanceId = decodeURIComponent(ma[1]!);
        // Special-case 'main': it has no DB row, so the SPA shouldn't list
        // artifacts for it.
        if (instanceId === 'main') {
          sendJson(res, 200, { items: [] });
          return true;
        }
        // Look up workspace_path from the agent_sessions row.
        const row = ctx.db.prepare(
          `SELECT w.path AS workspace_path
           FROM agent_sessions s JOIN workspaces w ON w.id = s.workspace_id
           WHERE s.recipe_instance_id = ?
           ORDER BY s.started_at DESC LIMIT 1`,
        ).get(instanceId) as { workspace_path: string } | undefined;
        if (!row) { sendJson(res, 404, { error: 'session not found' }); return true; }
        // Read artifacts from disk (manifest scanner). The artifact.add
        // tool writes manifests to <ws>/artifacts/<id>/manifest.json but
        // does NOT currently mirror to the artifacts DB table, so the
        // on-disk scanner is the authoritative source.
        const { listArtifacts } = await import('../artifact-store.ts');
        const all = listArtifacts(row.workspace_path);
        const items = all
          .filter((a) => a.manifest.recipe_instance_id === instanceId)
          .map((a) => ({
            id: a.manifest.id,
            type: a.manifest.type,
            title: a.manifest.title,
            recipe_instance_id: a.manifest.recipe_instance_id ?? null,
            recipe_step_id: a.manifest.step_id ?? null,
            created_at: a.manifest.created_at ?? 0,
            updated_at: a.manifest.created_at ?? 0,
          }))
          .sort((a, b) => b.created_at - a.created_at);
        sendJson(res, 200, { items });
        return true;
      }
    }
  }

  // ----- GET /api/recipe-instances/<id> -------------------------------------
  // Read the recipe instance + step status array. Used by the Terminals tab
  // side panel's "Recipe" view so users can see step progress at a glance.
  {
    const mri = path.match(/^\/api\/recipe-instances\/([^/]+)\/?$/);
    if (mri && method === 'GET') {
      const instanceId = decodeURIComponent(mri[1]!);
      const wsRow = ctx.db.prepare(
        `SELECT w.id AS workspace_id, w.path AS workspace_path
         FROM agent_sessions s
         JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.recipe_instance_id = ?
         ORDER BY s.started_at DESC LIMIT 1`,
      ).get(instanceId) as { workspace_id: string; workspace_path: string } | undefined;
      if (!wsRow) { sendJson(res, 404, { error: 'recipe instance not found' }); return true; }
      const { readRecipeInstance } = await import('../recipe-instances-store.ts');
      const inst = readRecipeInstance(wsRow.workspace_path, instanceId);
      if (!inst) { sendJson(res, 404, { error: 'recipe instance not found' }); return true; }
      // Augment with steps[] parsed from recipe_snapshot if the instance
      // itself doesn't already carry a structured steps array. The runner
      // stores the raw YAML in `recipe_snapshot` but doesn't always
      // materialize `steps`; for the side-panel UI we want the structured
      // list so users can see what the recipe is supposed to do.
      type WithSteps = typeof inst & { steps?: unknown[] };
      const withSteps = inst as WithSteps;
      if (!Array.isArray(withSteps.steps) || withSteps.steps.length === 0) {
        try {
          const { parseRecipeSource } = await import('../validators.ts');
          const snapshot = (inst as { recipe_snapshot?: string }).recipe_snapshot;
          if (typeof snapshot === 'string' && snapshot.length > 0) {
            const parsed = parseRecipeSource(snapshot) as Record<string, unknown> | null;
            const parsedSteps = parsed && Array.isArray(parsed.steps) ? parsed.steps : [];
            // Normalize each parsed step into our { id, title, status } shape
            // so the UI doesn't need to know about the raw YAML field names.
            withSteps.steps = parsedSteps.map((s: unknown, i: number) => {
              const obj = (s && typeof s === 'object') ? s as Record<string, unknown> : {};
              return {
                id: String(obj.id ?? i + 1),
                title: String(obj.goal ?? obj.title ?? `Step ${i + 1}`),
                status: 'pending' as const,
                message: null,
              };
            }) as typeof withSteps.steps;
          }
        } catch { /* leave steps unset */ }
      }
      sendJson(res, 200, withSteps);
      return true;
    }
  }

  // ----- GET /api/cron/status -----------------------------------------------
  // Bearer-gated routes below (/api/cron/*, /api/fires/*) — these are
  // maintenance/introspection surfaces, NOT SPA-consumed. /api/sessions*
  // sits OUTSIDE this gate (handled above) because the SPA consumes it
  // without a bearer like every other /api/* surface.
  if (path.startsWith('/api/cron/') || path.startsWith('/api/fires')) {
    if (ctx.expectedToken) {
      const token = bearer(req);
      if (!token) {
        reject401(res, 'missing bearer token');
        return true;
      }
      if (!constantTimeEquals(token, ctx.expectedToken)) {
        reject401(res, 'invalid bearer token');
        return true;
      }
    }
  }

  if (path === '/api/cron/status' && method === 'GET') {
    sendJson(res, 200, {
      service: ctx.service,
      scheduler: ctx.scheduler.status(),
      dispatcher: ctx.dispatcher.status(),
      db: { path: ctx.dbPath, schema_version: ctx.schemaVersion },
    });
    return true;
  }

  // ----- POST /api/cron/diagnose --------------------------------------------
  if (path === '/api/cron/diagnose' && method === 'POST') {
    try {
      ctx.scheduler.reschedule();
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    sendJson(res, 200, ctx.scheduler.status());
    return true;
  }

  // ----- POST /api/fires/:id/retry ------------------------------------------
  {
    const m = path.match(/^\/api\/fires\/([^/]+)\/retry\/?$/);
    if (m && method === 'POST') {
      const fireId = decodeURIComponent(m[1]!);
      const fire = getFire(ctx.db, fireId);
      if (!fire) {
        sendJson(res, 404, { error: 'fire not found', fire_id: fireId });
        return true;
      }
      if (
        fire.status !== 'failed' &&
        fire.status !== 'dead' &&
        fire.status !== 'skipped'
      ) {
        sendJson(res, 409, {
          error: `fire status is '${fire.status}'; only failed/dead/skipped fires can be retried`,
          fire_id: fireId,
        });
        return true;
      }
      markFireForRetry(ctx.db, fireId);
      try {
        ctx.scheduler.reschedule();
      } catch {
        /* best-effort */
      }
      sendJson(res, 200, { fire_id: fireId, status: 'queued' });
      return true;
    }
  }

  // ----- GET /api/fires/:id -------------------------------------------------
  {
    const m = path.match(/^\/api\/fires\/([^/]+)\/?$/);
    if (m && method === 'GET') {
      const fireId = decodeURIComponent(m[1]!);
      const fire = getFire(ctx.db, fireId);
      if (!fire) {
        sendJson(res, 404, { error: 'fire not found', fire_id: fireId });
        return true;
      }
      const wsPath = workspacePath(ctx.db, fire.workspace_id);
      if (!wsPath) {
        sendJson(res, 200, {
          fire,
          stdout: '',
          stderr: '',
          callbacks: [],
          attempts_available: [],
          truncated: false,
        });
        return true;
      }
      const fireDir = join(wsPath, '.clawdevbox', 'fires', fireId);
      const available = attemptsAvailable(fireDir);
      const requested = url.searchParams.get('attempt');
      let attempt = available.length > 0 ? available[available.length - 1]! : fire.attempt;
      if (requested != null) {
        const n = parseInt(requested, 10);
        if (Number.isInteger(n) && n > 0) attempt = n;
      }
      const dir = attemptDir(wsPath, fireId, attempt);
      const stdout = readFileTruncated(join(dir, 'stdout.txt'));
      const stderr = readFileTruncated(join(dir, 'stderr.txt'));
      let callbacks: unknown[] = [];
      try {
        const cbPath = join(dir, 'callbacks.json');
        if (existsSync(cbPath)) {
          const parsed = JSON.parse(readFileSync(cbPath, 'utf8'));
          if (Array.isArray(parsed)) callbacks = parsed;
        }
      } catch {
        /* best-effort */
      }
      sendJson(res, 200, {
        fire,
        stdout: stdout.text,
        stderr: stderr.text,
        callbacks,
        attempts_available: available,
        truncated: stdout.truncated || stderr.truncated,
        attempt,
      });
      return true;
    }
  }

  // ----- GET /api/fires (list) ---------------------------------------------
  if (path === '/api/fires' && method === 'GET') {
    const status = url.searchParams.get('status');
    const workspace_id = url.searchParams.get('workspace_id') ?? undefined;
    const trigger_id = url.searchParams.get('trigger_id') ?? undefined;
    const limitRaw = url.searchParams.get('limit');
    const beforeRaw = url.searchParams.get('before');
    let limit = 50;
    if (limitRaw != null) {
      const n = parseInt(limitRaw, 10);
      if (Number.isInteger(n) && n > 0) limit = Math.min(n, 500);
    }
    let before: number | undefined;
    if (beforeRaw != null) {
      const n = parseInt(beforeRaw, 10);
      if (Number.isInteger(n) && n > 0) before = n;
    }
    const fires: FireRow[] = listFires(ctx.db, {
      status: status ? status.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : undefined,
      workspace_id,
      trigger_id,
      limit,
      before,
    });
    const next_offset = fires.length === limit ? fires[fires.length - 1]!.scheduled_at : null;
    sendJson(res, 200, { fires, count: fires.length, next_offset });
    return true;
  }

  // Not a cron-api route. Return false so the caller can try the next
  // dispatcher (e.g. dispatchTerminalRequest for /terminal/<id>).
  return false;
}
