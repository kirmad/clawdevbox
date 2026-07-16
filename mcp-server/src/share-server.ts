/**
 * share-server.ts
 *
 * A second HTTP listener that serves ONLY artifact-related routes — the
 * "share endpoint". Designed to be exposed publicly via its own dev tunnel
 * (see `share-tunnel.ts`) so colleagues can view + comment on artifacts
 * without being handed the full clawdevbox surface area (no MCP transport,
 * no `/api/sessions`, no `/api/cron/*`, no `/spawn`, etc.).
 *
 * Architecture
 * ============
 * - The share server runs in the SAME process as the main HTTP server.
 *   It binds a separate port (default `cfg.http.port + 100`) and a
 *   separate `http.Server` instance — there is no shared state beyond
 *   the in-process artifact / json-doc stores it implicitly reads
 *   through `handleHttpRequest` from terminal-server.ts.
 * - The dispatcher enforces a strict allow-list before delegating. Any
 *   path / method tuple that is not on the list returns
 *   `{ error: 'NOT_AVAILABLE_ON_SHARE' }` with a 404.
 * - The `/dispatch` endpoint is gated by `cfg.share.allow_dispatch`. When
 *   permitted, a caller-provided handler is invoked (cli/start.ts wires
 *   this to `handleCronApi` so the existing dispatch implementation is
 *   reused). When forbidden — or when no handler is supplied — the path
 *   falls through to the standard 404.
 *
 * Allow-list (see `isAllowed()`)
 * ------------------------------
 *   GET    /healthz
 *   GET    /artifact/<id>                    (host page)
 *   GET    /artifact/<id>/manifest
 *   GET    /artifact/<id>/files
 *   GET    /artifact/<id>/file/<name>
 *   GET    /artifact/<id>/session
 *   GET    /__renderer/<type>.mjs
 *   GET    /__renderer-lib/<_name>.mjs
 *   GET    /api/store/<collection>           (list ids for sidebar refresh)
 *   GET    /api/store/<collection>/<id>      (read — drafts + attachments)
 *   PUT    /api/store/<collection>/<id>      (write — colleagues add comments)
 *   POST   /dispatch                         (optional — see allow_dispatch)
 *
 *   DELETE on /api/store/... is intentionally NOT allowed (colleagues
 *   shouldn't be able to delete each other's comments).
 *
 * Everything else — including `/mcp`, `/spawn`, `/api/sessions`,
 * `/api/cron/*`, `/api/inbox/*`, `/terminal/*` — returns 404 with
 * `{ error: 'NOT_AVAILABLE_ON_SHARE' }`.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { handleHttpRequest } from './terminal-server.ts';

export type ShareDispatchHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface StartShareServerOptions {
  port: number;
  host: string;
  /**
   * When true, `POST /dispatch` is on the allow-list AND delegated to
   * `dispatchHandler`. When false (or `dispatchHandler` is null) the
   * `/dispatch` path falls through to the standard NOT_AVAILABLE_ON_SHARE
   * response.
   */
  allowDispatch: boolean;
  /**
   * Wired by cli/start.ts to `handleCronApi(req, res, cronApiCtx)` once
   * the cron context is built. Optional so tests can boot the share server
   * without standing up the full cron stack — they pass `null` and assert
   * that dispatch correctly falls through to 404 when `allowDispatch` is
   * also false.
   */
  dispatchHandler: ShareDispatchHandler | null;
}

export interface ShareServerHandle {
  /** Actual bound port (resolved if caller passed 0 for ephemeral). */
  port(): number;
  /** Bound host as supplied by the caller. */
  host(): string;
  /** Construct a local share URL for the given artifact id. */
  url(artifactId: string): string;
  close(): Promise<void>;
}

let activeServer: Server | null = null;
let activeHandle: ShareServerHandle | null = null;

export function getShareServer(): ShareServerHandle | null {
  return activeHandle;
}

export async function startShareServer(
  opts: StartShareServerOptions,
): Promise<ShareServerHandle> {
  if (activeServer) {
    throw new Error('share server already running');
  }

  const dispatchHandler = opts.allowDispatch ? opts.dispatchHandler : null;

  const server = createServer((req, res) => {
    // Mark every request entering via the share server so downstream handlers
    // (host page → window.__CDB_SHARED__, Q&A attribution) know this is a
    // shared/colleague context, not the owner's local surface.
    (req as IncomingMessage & { __cdbShareMode?: boolean }).__cdbShareMode = true;
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    // Use a stable origin for URL parsing — we only care about pathname.
    const url = new URL(rawUrl, `http://${opts.host}`);
    const allowance = classify(url.pathname, method, !!dispatchHandler);

    if (allowance === 'dispatch') {
      Promise.resolve()
        .then(() => dispatchHandler!(req, res))
        .catch((err) => {
          if (!res.headersSent) {
            writeJson(res, 500, {
              error: 'INTERNAL',
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        });
      return;
    }

    if (allowance === 'forward') {
      // Delegate to terminal-server's allow-listed handler. It already
      // handles 404s for anything inside its own table that we don't
      // recognise (defence in depth).
      try {
        handleHttpRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          writeJson(res, 500, {
            error: 'INTERNAL',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    writeJson(res, 404, {
      error: 'NOT_AVAILABLE_ON_SHARE',
      detail:
        'This endpoint is not exposed on the share server. Only artifact view + comment routes are available here.',
      path: url.pathname,
      method,
    });
  });

  await new Promise<void>((resolveP, rejectP) => {
    server.once('error', rejectP);
    server.listen(opts.port, opts.host, () => resolveP());
  });

  activeServer = server;

  const addr = server.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : opts.port;

  activeHandle = {
    port: () => boundPort,
    host: () => opts.host,
    url: (artifactId: string) =>
      `http://${opts.host}:${boundPort}/artifact/${encodeURIComponent(artifactId)}`,
    close: () =>
      new Promise<void>((resolveP) => {
        server.close(() => {
          activeServer = null;
          activeHandle = null;
          resolveP();
        });
      }),
  };

  return activeHandle;
}

export async function stopShareServer(): Promise<void> {
  if (activeHandle) {
    await activeHandle.close();
  }
}

type Allowance = 'forward' | 'dispatch' | 'deny';

/**
 * Classify a path/method tuple against the share-server allow-list.
 *
 * Returns:
 *   - 'forward'   → delegate to handleHttpRequest (terminal-server)
 *   - 'dispatch'  → POST /dispatch and dispatchHandler is available
 *   - 'deny'      → respond 404 NOT_AVAILABLE_ON_SHARE
 *
 * Exported as a pure function so tests can exhaustively cover the table
 * without spinning up a server.
 */
export function classify(
  pathname: string,
  method: string,
  dispatchEnabled: boolean,
): Allowance {
  const m = method.toUpperCase();

  // -------- /healthz ----------------------------------------------------
  if (pathname === '/healthz' && m === 'GET') return 'forward';

  // -------- /dispatch ---------------------------------------------------
  if (pathname === '/dispatch') {
    return m === 'POST' && dispatchEnabled ? 'dispatch' : 'deny';
  }

  // -------- /artifact/<id>/ask ------------------------------------------
  // Scoped "ask a question about this artifact". Routes to the cron-api
  // dispatch handler, which resolves the session SERVER-SIDE from the
  // artifact — a share caller can only message that artifact's own
  // conversation, never spawn arbitrary agents. Gated on `send` (dispatch).
  if (/^\/artifact\/[A-Za-z0-9._-]+\/ask\/?$/.test(pathname)) {
    return m === 'POST' && dispatchEnabled ? 'dispatch' : 'deny';
  }

  // -------- /__renderer / __renderer-lib --------------------------------
  if (m === 'GET') {
    if (/^\/__renderer\/[A-Za-z0-9._-]+\.mjs$/.test(pathname)) return 'forward';
    if (/^\/__renderer-lib\/_[A-Za-z0-9._-]+\.mjs$/.test(pathname)) return 'forward';
  }

  // -------- /artifact/... Q&A thread (GET read / POST append) -----------
  // Append-only per-step Q&A. Colleagues with the share link can read the
  // thread and post a question (scoped to this artifact, append-only via
  // qaAppendQuestion — they can't edit/delete). The actual dispatch to the
  // agent goes through the scoped POST /artifact/<id>/ask above.
  if (
    (m === 'GET' || m === 'POST') &&
    /^\/artifact\/[A-Za-z0-9._-]+\/qa\/step-\d+\.json$/.test(pathname)
  ) {
    return 'forward';
  }
  // Live Q&A change stream (SSE) — lets shared viewers see new questions/
  // answers in real time without polling. Read-only GET.
  if (m === 'GET' && /^\/artifact\/[A-Za-z0-9._-]+\/qa\/events\/?$/.test(pathname)) {
    return 'forward';
  }
  // Delivery status for a queued artifact message (durable outbox). Read-only
  // GET, scoped to the artifact — lets a shared viewer see their comment/
  // question flip from "sending…" → "✓ sent" (or "⚠ failed") without polling
  // any privileged surface. The message itself was enqueued via the scoped
  // POST /artifact/<id>/ask above.
  if (m === 'GET' && /^\/artifact\/[A-Za-z0-9._-]+\/outbox\/[A-Za-z0-9._-]+\/?$/.test(pathname)) {
    return 'forward';
  }

  // -------- /artifact/... -----------------------------------------------
  // Only GET. Anything else (PUT/DELETE/POST against an artifact path)
  // is rejected so colleagues can't mutate the on-disk artifact.
  if (m === 'GET') {
    if (/^\/artifact\/[A-Za-z0-9._-]+\/?$/.test(pathname)) return 'forward';
    if (/^\/artifact\/[A-Za-z0-9._-]+\/manifest\/?$/.test(pathname)) return 'forward';
    if (/^\/artifact\/[A-Za-z0-9._-]+\/files\/?$/.test(pathname)) return 'forward';
    if (/^\/artifact\/[A-Za-z0-9._-]+\/file\/[^/]+\/?$/.test(pathname)) return 'forward';
    if (/^\/artifact\/[A-Za-z0-9._-]+\/session\/?$/.test(pathname)) return 'forward';
  }

  // -------- /api/store/... ----------------------------------------------
  // GET list (collection), GET/PUT doc (collection + id). DELETE is
  // intentionally NOT on the allow-list — colleagues commenting via the
  // share endpoint must not be able to wipe each other's data.
  if (pathname.startsWith('/api/store/')) {
    const segments = pathname.slice('/api/store/'.length).split('/').filter(Boolean);
    if (segments.length === 1 && m === 'GET') return 'forward';
    if (segments.length === 2 && (m === 'GET' || m === 'PUT')) return 'forward';
    // DELETE / POST / segments.length>2 → fall through to deny.
  }

  return 'deny';
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
