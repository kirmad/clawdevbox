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
 *   POST /callback/:fire_id       per-fire-secret Mode B callback drop
 *
 * Auth: all `/api/*` routes require `Authorization: Bearer <token>` matched
 * against `cfg.http.token`. `/callback/:fire_id` uses a per-fire secret
 * minted by the dispatcher when a script binding runs.
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
import {
  attemptDir,
  getFire,
  listFires,
  markFireForRetry,
  type FireRow,
} from '../db/fires-store.ts';
import type { Dispatcher } from '../dispatcher.ts';
import type { Scheduler } from '../scheduler.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CronApiContext {
  db: Database;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  dbPath: string;
  schemaVersion: number;
  service: { pid: number; port: number; started_at: number; version: string };
  expectedToken: string;
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
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="clawdevbox"',
  });
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

  if (!path.startsWith('/api/cron/') && !path.startsWith('/api/fires')) {
    return false;
  }

  // ----- bearer auth for all /api/* in this handler -------------------------
  const token = bearer(req);
  if (!token) {
    reject401(res, 'missing bearer token');
    return true;
  }
  if (!constantTimeEquals(token, ctx.expectedToken)) {
    reject401(res, 'invalid bearer token');
    return true;
  }

  // ----- GET /api/cron/status -----------------------------------------------
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

  sendJson(res, 404, { error: 'not found', path });
  return true;
}
