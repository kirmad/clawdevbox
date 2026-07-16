/**
 * terminal-server.ts
 *
 * HTTP + WebSocket server hosting two surfaces on the same port:
 *
 *   PTY VIEWER (xterm.js attached to live agent shells):
 *     GET  /terminal/:instanceId           → HTML host page
 *     WS   /terminal/:instanceId/ws        → bidirectional pty bridge
 *
 *   ARTIFACT VIEWER (rendered bundles from artifact.add):
 *     GET  /artifact/:id                   → HTML host page (dynamic-imports the type's renderer)
 *     GET  /artifact/:id/manifest          → manifest.json
 *     GET  /artifact/:id/files             → list of content files
 *     GET  /artifact/:id/file/:filename    → raw content
 *     GET  /__renderer/:type.mjs           → resolved renderer (workspace → plugin → builtin)
 *
 *   GET  /healthz                          → "ok"
 *
 * PTY WS protocol (server → client):
 *   { "type": "snapshot", "content": "<scrollback>", "cols": N, "rows": N,
 *     "exited": false, "exitCode": null }
 *   { "type": "data",     "chunk":   "<utf8 chunk>" }
 *   { "type": "exit",     "exitCode": N, "signal": N? }
 * PTY WS protocol (client → server):
 *   { "type": "input",  "data": "<utf8 keystrokes>" }
 *   { "type": "resize", "cols": N, "rows": N }
 *   { "type": "kill",   "signal": "SIGTERM"? }
 *
 * Multiple viewers per pty session are supported (broadcast on data),
 * mirroring taskdock's watcher pattern.
 */

import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  artifactDir,
  artifactFilePath,
  artifactManifestPath,
  findArtifact,
  listArtifactFiles,
} from './artifact-store.ts';
import {
  deleteDoc as storeDeleteDoc,
  getDoc as storeGetDoc,
  listDocs as storeListDocs,
  putDoc as storePutDoc,
  JSON_DOC_MAX_BYTES,
  BLOB_DOC_MAX_BYTES,
} from './json-doc-store.ts';
import {
  hasSession,
  killPty,
  resizePty,
  subscribe,
  writeToPty,
  getSessionMeta,
  type PtySessionMeta,
} from './pty-registry.ts';
import { tmuxSessionRegistry } from './cli-sessions/tmux-session-runtime.ts';
import { spawn as ptySpawn } from 'node-pty';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from './config.ts';
import { builtinRenderersDir, resolveRendererFile } from './renderer-registry.ts';
import type { Workspace } from './workspace.ts';
import { listWorkspaces, resolveWorkspacesRoot } from './workspaces-store.ts';
import { readRecipeInstance } from './recipe-instances-store.ts';
import { getDatabase } from './db/index.ts';
import { getOutbox, type OutboxRow } from './db/artifact-outbox-store.ts';
import { appendQuestion as qaAppendQuestion, readThread as qaReadThread } from './qa-store.ts';
import { onQaChange } from './event-bus.ts';

/**
 * Quietly terminate a viewer ipty (tmux attach).
 *
 * Two-step cleanup so tmux sees a clean detach and doesn't leave phantom
 * client entries in its server-side table:
 *
 *   1. Write `\x02d` (tmux prefix Ctrl-B + 'd' = detach-key) into the pty.
 *      tmux processes the prefix + detach key and exits the attach client
 *      normally — its server-side client table is updated. This avoids
 *      the "phantom client" problem where tmux list-clients keeps showing
 *      a now-dead viewer indefinitely (observed on Windows after the
 *      taskkill-only path).
 *
 *   2. After a short delay (200ms is enough for tmux to ack), force-kill
 *      anything that's still alive. On Windows, `taskkill /F /PID <pid>`
 *      bypasses the buggy node-pty conpty_console_list_agent fork that
 *      crashes with "AttachConsole failed" after console teardown.
 *
 * On POSIX `ipty.kill()` is fine (SIGHUP via pty controller).
 */
function killViewerIpty(ipty: { pid?: number; write?: (s: string) => void; kill: (s?: string) => void }): void {
  // Step 1: clean detach.
  try { ipty.write?.('\x02d'); } catch { /* pipe already closed; fine */ }

  const pid = ipty.pid;
  // Step 2: defer the hard kill so tmux can process the detach cleanly.
  setTimeout(() => {
    if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
      try {
        spawnSync('taskkill', ['/F', '/PID', String(pid)], {
          windowsHide: true,
          timeout: 5000,
        });
        return;
      } catch { /* fall through to ipty.kill */ }
    }
    try { ipty.kill(); } catch { /* ignore */ }
  }, 200).unref?.();
}

/**
 * Resolve the absolute path to `tmux.exe` (Windows) / `tmux` (Unix). node-pty
 * doesn't search PATH the way child_process.spawn does on Windows, so we need
 * an absolute path. Result is cached for the process lifetime.
 */
let _tmuxBinPath: string | null = null;
function resolveTmuxBin(): string {
  if (_tmuxBinPath) return _tmuxBinPath;
  const isWin = process.platform === 'win32';
  const which = spawnSync(isWin ? 'where.exe' : 'which', ['tmux'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (which.status === 0) {
    // `where` returns one path per line; take the first.
    const first = which.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first) {
      _tmuxBinPath = first;
      return first;
    }
  }
  // Fallback: well-known location (matches the smoke probe / cdb.tmux.conf
  // bundling) — emits the original name and lets node-pty surface ENOENT.
  _tmuxBinPath = isWin ? 'tmux.exe' : 'tmux';
  return _tmuxBinPath;
}

/**
 * Clamp a possibly-NaN / out-of-range pty dimension to a sane integer.
 * Used when parsing the optional ?cols=&rows= query string on /terminal/<id>/ws.
 * Range chosen to cover real desktop viewports (240 cols ≈ 4K @ 13px) without
 * letting a buggy / hostile client request something silly.
 */
function clampDim(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < 20) return fallback; // < 20 ⇒ measurement against a hidden host; refuse
  if (n > 500) return 500;
  return n;
}

/**
 * Probe whether a tmux session with the given name exists on the default
 * socket. Uses the cached `tmuxSessionRuntime().list()` (1s TTL) instead of
 * spawning a fresh `tmux has-session` subprocess — at SPA poll rates (every
 * 2s on /api/sessions + per-WS-attach probe), forking a child on every
 * check would block the Node event loop for 100ms+ on Windows psmux.
 */
/**
 * Look up the actual tmux session name for a given instance id.
 *
 * Clawdevbox-spawned tmux sessions live under `cdb_<instance_id>`; foreign
 * (user-spawned) tmux sessions may live under the bare instance id. This
 * helper prefers the clawdevbox-owned session so we don't accidentally
 * hijack a foreign session that happens to share a suffix.
 *
 * Returns the exact tmux session name to pass into `tmux attach -t …`,
 * or null if neither variant exists. Callers used to compare
 * `s.name === instanceId` directly, which never matched clawdevbox-spawned
 * sessions (they're always prefixed) — that made the "dormant tmux still
 * alive after a server restart" fallback unreachable and every terminal
 * attach for a not-in-registry session fell through to the archived-log
 * path (and then to auto-resume, which spawns a fresh CLI even though the
 * original one is right there).
 */
async function findTmuxSessionName(instanceId: string): Promise<string | null> {
  try {
    const { tmuxSessionRuntime } = await import('./cli-sessions/tmux-session-runtime.ts');
    const list = await tmuxSessionRuntime().list();
    const preferred = list.find((s) => s.name === `cdb_${instanceId}`);
    if (preferred) return preferred.name;
    const fallback = list.find((s) => s.name === instanceId);
    return fallback?.name ?? null;
  } catch {
    return null;
  }
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    const { tmuxSessionRuntime } = await import('./cli-sessions/tmux-session-runtime.ts');
    const list = await tmuxSessionRuntime().list();
    return list.some((s) => s.name === name || s.name === `cdb_${name}`);
  } catch {
    return false;
  }
}

// ============================================================================
// Server boot
// ============================================================================

let httpServer: Server | null = null;
let wsServer: WebSocketServer | null = null;
let boundPort: number | null = null;
let boundHost = '127.0.0.1';
let activeHandle: TerminalServerHandle | null = null;
let activeWorkspace: Workspace | null = null;

export interface TerminalServerHandle {
  url(instanceId: string): string;
  port(): number;
  close(): Promise<void>;
}

/** Returns the currently running handle, or null if `startTerminalServer` was never called. */
export function getTerminalServer(): TerminalServerHandle | null {
  return activeHandle;
}

export async function startTerminalServer(opts: {
  port?: number;
  host?: string;
  /** Workspace context (used for renderer resolution & artifact lookup). */
  workspace?: Workspace;
  /**
   * If provided, mount terminal routes onto this server instead of creating
   * a new one. Useful when sharing a port with the HTTP MCP transport.
   * When set, `port` / `host` are ignored and `handle.port()` reads from the
   * supplied server's `.address()`.
   */
  sharedServer?: Server;
} = {}): Promise<TerminalServerHandle> {
  if (httpServer) {
    throw new Error('terminal server already running');
  }

  activeWorkspace = opts.workspace ?? null;
  boundHost = opts.host ?? '127.0.0.1';

  if (opts.sharedServer) {
    // Caller (HTTP CLI) owns request dispatch. We only attach the WS
    // upgrade handler below; the caller routes /mcp to the MCP transport
    // and delegates everything else by invoking `dispatchTerminalRequest`.
    httpServer = opts.sharedServer;
  } else {
    const desiredPort =
      opts.port ?? Number.parseInt(process.env.CLAWDEVBOX_TERMINAL_PORT ?? '0', 10);
    httpServer = createServer((req, res) => handleHttpRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      httpServer!.once('error', reject);
      httpServer!.listen(desiredPort, boundHost, () => {
        const addr = httpServer!.address();
        if (addr && typeof addr === 'object') {
          boundPort = addr.port;
        }
        resolve();
      });
    });
  }

  wsServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${boundHost}`);
    const wsMatch = url.pathname.match(/^\/terminal\/([A-Za-z0-9_-]+)\/ws$/);
    if (!wsMatch) {
      socket.destroy();
      return;
    }
    const instanceId = wsMatch[1];
    // Parse optional ?cols=&rows= so the FIRST tmux-attach IPty is born at
    // the viewer's actual viewport size. On psmux (Windows) the pane's conpty
    // dimensions are locked at attach-client creation time — `resize-window`
    // and SIGWINCH-via-ipty.resize() are both no-ops. The only reliable way
    // to update the underlying CLI's terminal size is to spawn a NEW
    // `tmux attach-session` IPty at the new dims, which is what the WS
    // 'resize' handler now does (see attachWebsocketViaTmux). Passing dims
    // up-front avoids a flicker where the initial paint happens at the
    // default 120×30 and then re-flows when the first resize message lands.
    const cols = clampDim(Number(url.searchParams.get('cols')), 120);
    const rows = clampDim(Number(url.searchParams.get('rows')), 30);
    wsServer!.handleUpgrade(req, socket, head, (ws) => {
      void attachWebsocket(ws, instanceId, { cols, rows });
    });
  });

  if (opts.sharedServer) {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object') {
      boundPort = addr.port;
    } else {
      // Shared server hasn't started listening yet (caller will call
      // listen() afterwards). Pick up the port once the listen completes
      // so handle.url() returns a valid URL.
      httpServer.once('listening', () => {
        const a = httpServer?.address();
        if (a && typeof a === 'object') {
          boundPort = a.port;
        }
      });
    }
  }

  activeHandle = {
    url: (instanceId: string) => {
      // Defensive: if boundPort hasn't been set yet (shared server still
      // pre-listen), return null-equivalent string so callers can fall
      // back. Callers like buildViewUrl() handle null-port by returning
      // null themselves rather than constructing an invalid URL.
      if (boundPort == null) return '';
      return `http://${boundHost}:${boundPort}/terminal/${encodeURIComponent(instanceId)}`;
    },
    port: () => boundPort ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        wsServer?.close();
        httpServer?.close(() => {
          httpServer = null;
          wsServer = null;
          boundPort = null;
          activeHandle = null;
          resolve();
        });
      }),
  };
  return activeHandle;
}

// ============================================================================
// HTTP handler
// ============================================================================

/**
 * Dispatch a request through the terminal/artifact routes.
 *
 * Exported so the HTTP CLI can compose this with the MCP transport on the
 * same server — the CLI routes `/mcp*` to the MCP handler and falls through
 * here for everything else.
 */
export function dispatchTerminalRequest(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  handleHttpRequest(req, res);
}

/**
 * Re-export the internal request dispatcher so the share-server module can
 * delegate to it for the allow-listed artifact/store routes without duplicating
 * the route table. The share-server adds its own 404 gate on top, so callers
 * MUST allow-list before invoking this. Public consumers should prefer
 * `dispatchTerminalRequest`.
 */
export { handleHttpRequest };

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${boundHost}`);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  // -------- PTY viewer ---------------------------------------------------
  const ptyMatch = url.pathname.match(/^\/terminal\/([A-Za-z0-9_-]+)\/?$/);
  if (ptyMatch) {
    const instanceId = ptyMatch[1];
    const meta = resolveTerminalMeta(instanceId);
    // `?embed=1` is set by the SPA when rendering this page inside an
    // iframe subtab — strips the metadata header (which would duplicate
    // the recipe panel's own header) and lets the xterm fill the iframe.
    const embed = url.searchParams.get('embed') === '1';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderTerminalHtml(instanceId, meta, { embed }));
    return;
  }

  // -------- Renderer library (_*.mjs) -----------------------------------
  const rendererLibMatch = url.pathname.match(/^\/__renderer-lib\/(_[A-Za-z0-9._-]+)\.mjs$/);
  if (rendererLibMatch) {
    serveRendererLib(res, rendererLibMatch[1]);
    return;
  }

  // -------- Renderer module ----------------------------------------------
  const rendererMatch = url.pathname.match(/^\/__renderer\/([A-Za-z0-9._-]+)\.mjs$/);
  if (rendererMatch) {
    const name = rendererMatch[1];
    // Underscore-prefixed names are renderer-libraries (shared styles/
    // helpers that a renderer imports via a relative sibling path like
    // `./_pr-walkthrough-styles.mjs`). The browser resolves that against
    // /__renderer/<type>.mjs, landing here. Delegate to the lib handler
    // so authors can use natural relative imports between sibling files
    // in src/renderers/ without hard-coding the /__renderer-lib/ prefix.
    if (name.startsWith('_')) {
      serveRendererLib(res, name);
      return;
    }
    serveRenderer(res, name);
    return;
  }

  // -------- Artifact: file content --------------------------------------
  const artifactFileMatch = url.pathname.match(
    /^\/artifact\/([A-Za-z0-9._-]+)\/file\/([^/]+)\/?$/,
  );
  if (artifactFileMatch) {
    serveArtifactFile(res, artifactFileMatch[1], decodeURIComponent(artifactFileMatch[2]));
    return;
  }

  // -------- Artifact: files listing -------------------------------------
  const artifactFilesMatch = url.pathname.match(/^\/artifact\/([A-Za-z0-9._-]+)\/files\/?$/);
  if (artifactFilesMatch) {
    serveArtifactFiles(res, artifactFilesMatch[1]);
    return;
  }

  // -------- Artifact: per-step Q&A thread --------------------------------
  // GET  /artifact/<id>/qa/step-<N>.json — read the thread
  // POST /artifact/<id>/qa/step-<N>.json — append a question; body {text}
  // The browser is responsible for dispatching the prompt to the live agent
  // session via the existing /spawn or /dispatch endpoints (same pattern as
  // _comment-overlay.mjs sendAll). This route is persistence-only.
  //
  // GET /artifact/<id>/qa/events — SSE stream (checked first). Pushes a
  // notification whenever this artifact's Q&A changes, so every viewer
  // (other machines, the shared URL) sees new questions/answers live
  // without polling. The client re-reads the step-<N>.json thread on notify.
  const qaEventsMatch = url.pathname.match(/^\/artifact\/([A-Za-z0-9._-]+)\/qa\/events\/?$/);
  if (qaEventsMatch) {
    serveArtifactQaEvents(req, res, qaEventsMatch[1]);
    return;
  }
  const qaMatch = url.pathname.match(/^\/artifact\/([A-Za-z0-9._-]+)\/qa\/step-(\d+)\.json$/);
  if (qaMatch) {
    void serveArtifactQa(req, res, qaMatch[1], Number(qaMatch[2])).catch((err) => {
      if (!res.headersSent) writeJson(res, 500, { error: 'INTERNAL', detail: String(err?.message ?? err) });
    });
    return;
  }

  // GET /artifact/<id>/outbox/<message_id> — delivery status of a queued
  // message (durable artifact outbox). Read-only + scoped to the artifact, so
  // it's share-forwardable: a colleague on the shared URL can watch their
  // comment/question flip from "sending…" → "✓ sent" (or "⚠ failed") without
  // touching any privileged surface. The write side (enqueue) is the scoped
  // POST /artifact/<id>/ask, handled in cron-api.
  const outboxMatch = url.pathname.match(
    /^\/artifact\/([A-Za-z0-9._-]+)\/outbox\/([A-Za-z0-9._-]+)\/?$/,
  );
  if (outboxMatch) {
    serveArtifactOutboxStatus(res, outboxMatch[1], outboxMatch[2]);
    return;
  }

  // -------- Artifact: session resolution --------------------------------
  // Lets the comment overlay discover the canonical session_id and any
  // live instance_id associated with this artifact, so Send can route
  // to /dispatch (live pty) or /spawn (resume archived session) without
  // depending on a live SPA session list. See serveArtifactSession.
  const artifactSessionMatch = url.pathname.match(/^\/artifact\/([A-Za-z0-9._-]+)\/session\/?$/);
  if (artifactSessionMatch) {
    serveArtifactSession(res, artifactSessionMatch[1]);
    return;
  }

  // -------- Artifact: manifest ------------------------------------------
  const artifactManifestMatch = url.pathname.match(
    /^\/artifact\/([A-Za-z0-9._-]+)\/manifest\/?$/,
  );
  if (artifactManifestMatch) {
    serveArtifactManifest(res, artifactManifestMatch[1]);
    return;
  }

  // -------- Artifact: HTML host page ------------------------------------
  const artifactMatch = url.pathname.match(/^\/artifact\/([A-Za-z0-9._-]+)\/?$/);
  if (artifactMatch) {
    serveArtifactHost(req, res, artifactMatch[1]);
    return;
  }

  // -------- Generic document store --------------------------------------
  if (url.pathname.startsWith('/api/store/')) {
    const segments = url.pathname.slice('/api/store/'.length).split('/').filter(Boolean);
    if (segments.length >= 1 && segments.length <= 2) {
      void handleStoreRoute(req, res, url, segments).catch((err) => {
        if (!res.headersSent) writeJson(res, 500, { error: 'INTERNAL', detail: String(err?.message ?? err) });
      });
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// ============================================================================
// Artifact route handlers
// ============================================================================

// findArtifact + FoundArtifact moved to artifact-store.ts so the new
// pr-walkthrough.answer MCP tool can reuse the same resolution chain.

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function serveArtifactManifest(res: ServerResponse, id: string): void {
  const found = findArtifact(id);
  if (!found) {
    writeJson(res, 404, { error: 'ARTIFACT_NOT_FOUND', id });
    return;
  }
  writeJson(res, 200, found.manifest);
}

function serveArtifactFiles(res: ServerResponse, id: string): void {
  const found = findArtifact(id);
  if (!found) {
    writeJson(res, 404, { error: 'ARTIFACT_NOT_FOUND', id });
    return;
  }
  const files = listArtifactFiles(found.workspacePath, id);
  writeJson(res, 200, { id, dir: artifactDir(found.workspacePath, id), files });
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.diff': 'text/plain; charset=utf-8',
  '.patch': 'text/plain; charset=utf-8',
};

function serveArtifactFile(res: ServerResponse, id: string, filename: string): void {
  // Defensive: no traversal even after URL decode.
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename === 'manifest.json'
  ) {
    writeJson(res, 400, { error: 'INVALID_FILENAME', filename });
    return;
  }
  const found = findArtifact(id);
  if (!found) {
    writeJson(res, 404, { error: 'ARTIFACT_NOT_FOUND', id });
    return;
  }
  const filePath = artifactFilePath(found.workspacePath, id, filename);
  if (!existsSync(filePath)) {
    writeJson(res, 404, { error: 'FILE_NOT_FOUND', id, filename });
    return;
  }
  try {
    if (!statSync(filePath).isFile()) {
      writeJson(res, 400, { error: 'NOT_A_FILE', id, filename });
      return;
    }
  } catch {
    writeJson(res, 500, { error: 'STAT_FAILED', id, filename });
    return;
  }
  const ext = extname(filename).toLowerCase();
  res.writeHead(200, {
    'content-type': CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(res);
}

function serveArtifactHost(req: IncomingMessage, res: ServerResponse, id: string): void {
  const found = findArtifact(id);
  if (!found) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>404</title><pre>Artifact "${escapeHtml(id)}" not found in any registered workspace.</pre>`);
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // Host page is a thin loader that pulls the (no-store) renderer module;
    // keep it uncached too so a stale host never pins an old renderer URL.
    'cache-control': 'no-store',
  });
  const shared = !!(req as IncomingMessage & { __cdbShareMode?: boolean }).__cdbShareMode;
  res.end(renderArtifactHostHtml(id, found.manifest.type, found.manifest.title, shared));
}

/**
 * Resolve an artifact to its canonical agent session + live instance (if any).
 *
 * Used by the comment overlay's Send button so it can route comments to
 * the agent that actually produced the artifact, even from a standalone
 * /artifact/<id> page where no SPA session list is in scope.
 *
 * Resolution chain:
 *   1. findArtifact → manifest (404 if the artifact doesn't exist).
 *   2. If manifest.recipe_instance_id, readRecipeInstance → session_id
 *      (the canonical cli_session_id agents resume against).
 *   3. If session_id is known, query agent_sessions for any matching
 *      cli_session_id whose recipe_instance_id is currently live in the
 *      pty-registry or tmux-session-registry. Newest match wins.
 *
 * Response shape: { session_id, workspace_id, live_instance_id }. All
 * fields may be null except workspace_id (always present once we've
 * resolved the artifact). Always returns 200 for an existing artifact —
 * the absence of session_id / live_instance_id is informational, not an
 * error: the overlay falls back to the legacy "any live session in this
 * workspace" search when both are null.
 */
/**
 * Resolve the CLI session + workspace an artifact belongs to (server-side).
 * Shared by serveArtifactSession (informational) and the scoped
 * `/artifact/<id>/ask` endpoint (cron-api) so a share-tunnel caller can
 * message ONLY the conversation that produced the artifact — the session id
 * is never taken from the client. Returns null when the artifact is unknown.
 */
export interface ArtifactSessionInfo {
  sessionId: string | null;
  workspaceId: string;
  workspacePath: string;
  /**
   * The recipe-instance that produced this artifact (from its manifest). Used
   * as a stable RESUME ANCHOR for the SPA's artifact terminal panel: even when
   * no instance is live right now, this id lets the panel resume the
   * conversation (the resume endpoint resolves it → cli_session_id → live or
   * fresh instance). Null for artifacts not produced by a recipe instance.
   */
  recipeInstanceId: string | null;
}
export function resolveArtifactSessionInfo(id: string): ArtifactSessionInfo | null {
  const found = findArtifact(id);
  if (!found) return null;
  const recipeInstanceId = found.manifest.recipe_instance_id ?? null;
  let sessionId: string | null = null;
  if (recipeInstanceId) {
    // Try the artifact's own workspace first, then every registered
    // workspace because manifests can outlive their workspace registration.
    const inst = readRecipeInstance(found.workspacePath, recipeInstanceId);
    if (inst?.session_id) {
      sessionId = inst.session_id;
    } else {
      const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR;
      const candidates: string[] = [];
      if (projectDir && projectDir !== found.workspacePath) candidates.push(projectDir);
      try {
        const root = resolveWorkspacesRoot();
        for (const w of listWorkspaces(root)) {
          if (w.path !== found.workspacePath) candidates.push(w.path);
        }
      } catch { /* ignore */ }
      for (const wsPath of candidates) {
        try {
          const altInst = readRecipeInstance(wsPath, recipeInstanceId);
          if (altInst?.session_id) { sessionId = altInst.session_id; break; }
        } catch { /* try next */ }
      }
    }
  }
  return { sessionId, workspaceId: found.workspaceId, workspacePath: found.workspacePath, recipeInstanceId };
}

function serveArtifactSession(res: ServerResponse, id: string): void {
  const info = resolveArtifactSessionInfo(id);
  if (!info) {
    writeJson(res, 404, { error: 'ARTIFACT_NOT_FOUND', id });
    return;
  }
  const sessionId = info.sessionId;
  let liveInstanceId: string | null = null;
  if (sessionId) {
    try {
      const db = getDatabase();
      // Pull every interactive agent_sessions row bound to this
      // cli_session_id (newest first). For each, check whether the
      // corresponding recipe_instance_id has a live pty in either of
      // our two registries. The first live hit wins. Mirrors the
      // resolution dispatcher.findLiveInstanceForSession does, but
      // synchronously (no tmux runtime probe) — good enough for an
      // informational endpoint the overlay calls before Send.
      const rows = db
        .prepare(
          `SELECT recipe_instance_id FROM agent_sessions
           WHERE cli_session_id = ? AND interactive = 1
             AND recipe_instance_id IS NOT NULL
           ORDER BY started_at DESC LIMIT 20`,
        )
        .all(sessionId) as Array<{ recipe_instance_id: string }>;
      for (const r of rows) {
        if (hasSession(r.recipe_instance_id) || tmuxSessionRegistry.get(r.recipe_instance_id)) {
          // Verify the agent is actually alive inside the session, not just
          // a zombie tmux shell. Check derived_state — if it's 'exited' or
          // 'completed', the agent has finished and dispatch would silently
          // write to an empty shell.
          try {
            const stateRow = db.prepare(
              `SELECT derived_state FROM agent_sessions
               WHERE recipe_instance_id = ?
               ORDER BY started_at DESC LIMIT 1`,
            ).get(r.recipe_instance_id) as { derived_state: string | null } | undefined;
            const state = stateRow?.derived_state;
            if (state === 'exited' || state === 'completed' || state === 'error') {
              continue; // agent finished — don't treat as live
            }
          } catch { /* check failed — assume live */ }
          liveInstanceId = r.recipe_instance_id;
          break;
        }
      }
    } catch {
      // DB not open or query failed — leave liveInstanceId null. The
      // overlay falls back to a /spawn smart-route on the session_id.
    }
  }

  writeJson(res, 200, {
    session_id: sessionId,
    workspace_id: info.workspaceId,
    live_instance_id: liveInstanceId,
    recipe_instance_id: info.recipeInstanceId,
  });
}

/**
 * GET /artifact/<id>/outbox/<message_id> — delivery status of a queued
 * artifact message. Read-only; scoped to the artifact so a share-tunnel
 * viewer can only poll the status of a message that belongs to THIS artifact.
 * Lives here (terminal-server) rather than cron-api so it's reachable through
 * the share server's `forward` path, alongside the other artifact sub-routes.
 */
function serveArtifactOutboxStatus(res: ServerResponse, artifactId: string, messageId: string): void {
  let row: OutboxRow | null = null;
  try {
    row = getOutbox(getDatabase(), messageId);
  } catch {
    writeJson(res, 500, { error: 'INTERNAL' });
    return;
  }
  if (!row || row.artifact_id !== artifactId) {
    writeJson(res, 404, { error: 'MESSAGE_NOT_FOUND', id: messageId });
    return;
  }
  writeJson(res, 200, {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_error: row.last_error,
    delivered_instance_id: row.delivered_instance_id,
  });
}

/**
 * SSE stream of Q&A changes for a single artifact. Emits a `qa` event every
 * time a question/answer is appended to ANY step of this artifact (see
 * qa-store → emitQaChange). The client re-reads the affected step thread on
 * notify — the event is a lightweight "something changed" ping, mirroring the
 * event-bus/`/api/events` contract used by the main SPA.
 *
 * Works over both the main and the tenant-scoped share tunnel (plain GET,
 * allow-listed in share-server). A 25s keepalive comment keeps intermediaries
 * from closing an idle stream; `retry:` tells EventSource how fast to
 * reconnect if it drops.
 */
function serveArtifactQaEvents(req: IncomingMessage, res: ServerResponse, id: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disable proxy buffering (nginx/devtunnel) so events flush immediately.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');

  const unsub = onQaChange((changedId) => {
    if (changedId !== id) return;
    try { res.write('event: qa\ndata: changed\n\n'); } catch { /* client gone */ }
  });
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* client gone */ }
  }, 25_000);

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsub();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Persist per-step Q&A threads for a PR-walkthrough artifact. GET reads
 * the thread (empty array if no questions yet); POST appends a question.
 * Answers are written separately by the pr-walkthrough.answer MCP tool.
 *
 * This route is persistence-only: the browser is responsible for routing
 * the prompt to a live agent via /dispatch or /spawn (same fall-through
 * the comment overlay uses for Send).
 */
async function serveArtifactQa(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  stepN: number,
): Promise<void> {
  const found = findArtifact(id);
  if (!found) {
    writeJson(res, 404, { error: 'ARTIFACT_NOT_FOUND', id });
    return;
  }
  const dir = artifactDir(found.workspacePath, id);

  if (req.method === 'GET') {
    const thread = await qaReadThread({ artifactDir: dir, stepN });
    writeJson(res, 200, thread);
    return;
  }

  if (req.method === 'POST') {
    let raw: Buffer;
    try {
      raw = await readBody(req, JSON_DOC_MAX_BYTES);
    } catch (err) {
      writeJson(res, (err as { httpCode?: number }).httpCode ?? 400, { error: (err as Error).message });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      writeJson(res, 400, { error: 'INVALID_JSON' });
      return;
    }
    const text = (parsed as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      writeJson(res, 400, { error: 'TEXT_REQUIRED' });
      return;
    }
    // Optional: a line-anchored review comment (kind==='comment') vs a Q&A
    // question (default). Comments carry an anchor {file,line,side} so the
    // renderer can show them in the Comments tab pinned to a diff line.
    const rawKind = (parsed as { kind?: unknown })?.kind;
    const kind = rawKind === 'comment' ? 'comment' : 'question';
    const rawAnchor = (parsed as { anchor?: unknown })?.anchor;
    let anchor: { file?: string; line?: number; side?: string } | undefined;
    if (kind === 'comment' && rawAnchor && typeof rawAnchor === 'object') {
      const a = rawAnchor as Record<string, unknown>;
      anchor = {
        file: typeof a.file === 'string' ? a.file : undefined,
        line: typeof a.line === 'number' ? a.line : undefined,
        side: typeof a.side === 'string' ? a.side : undefined,
      };
    }
    // Shared-mode viewers (share server) must self-identify; the owner's
    // main-server questions carry no name and render as "You". Enforced
    // server-side so attribution can't be spoofed from either surface.
    const shared = !!(req as IncomingMessage & { __cdbShareMode?: boolean }).__cdbShareMode;
    const rawAskedBy = (parsed as { askedBy?: unknown })?.askedBy;
    const askedByClean = typeof rawAskedBy === 'string' && rawAskedBy.trim()
      ? rawAskedBy.trim().slice(0, 80)
      : undefined;
    if (shared && kind === 'question' && !askedByClean) {
      writeJson(res, 400, { error: 'NAME_REQUIRED' });
      return;
    }
    const entry = await qaAppendQuestion({
      artifactDir: dir, stepN, text, kind, anchor,
      askedBy: shared ? askedByClean : undefined,
    });
    writeJson(res, 201, entry);
    return;
  }

  writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

// ============================================================================
// /api/store/:collection/:id — generic JSON+blob document store routes
//
// All comment-related collections are artifact-scoped: the URL takes an
// `?artifact=<id>` query that resolves to a workspace via findArtifact().
// Without `?artifact=`, requests fall back to CLAWDEVBOX_PROJECT_DIR.
// ============================================================================

function resolveStoreWorkspace(url: URL): string | null {
  const artifactId = url.searchParams.get('artifact');
  if (artifactId) {
    const found = findArtifact(artifactId);
    if (found) return found.workspacePath;
    return null;
  }
  return process.env.CLAWDEVBOX_PROJECT_DIR ?? null;
}

async function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let len = 0;
  for await (const chunk of req) {
    const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    len += buf.length;
    if (len > cap + 1024) throw Object.assign(new Error('payload too large'), { httpCode: 413 });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function handleStoreRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  segments: string[],
): Promise<void> {
  const workspaceDir = resolveStoreWorkspace(url);
  if (!workspaceDir) {
    writeJson(res, 400, { error: 'WORKSPACE_UNRESOLVED', detail: 'pass ?artifact=<id> or set CLAWDEVBOX_PROJECT_DIR' });
    return;
  }

  // /api/store/:collection             (GET → ids)
  if (segments.length === 1) {
    if (req.method !== 'GET') { writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' }); return; }
    const ids = await storeListDocs(workspaceDir, segments[0]);
    if (ids === null) { writeJson(res, 400, { error: 'INVALID_COLLECTION' }); return; }
    writeJson(res, 200, { ids });
    return;
  }

  // /api/store/:collection/:id
  if (segments.length !== 2) { writeJson(res, 404, { error: 'NOT_FOUND' }); return; }
  const [collection, id] = segments;

  if (req.method === 'GET') {
    const got = await storeGetDoc(workspaceDir, collection, id);
    if (!got) { writeJson(res, 404, { error: 'NOT_FOUND' }); return; }
    res.writeHead(200, {
      'content-type': got.contentType,
      'etag': got.etag,
      'cache-control': 'no-store',
      'content-length': got.body.length,
    });
    res.end(got.body);
    return;
  }

  if (req.method === 'PUT') {
    const contentType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().toLowerCase();
    const cap = contentType === 'application/json' ? JSON_DOC_MAX_BYTES : BLOB_DOC_MAX_BYTES;
    let body: Buffer;
    try { body = await readBody(req, cap); }
    catch (err) {
      writeJson(res, (err as { httpCode?: number }).httpCode ?? 400, { error: (err as Error).message });
      return;
    }
    const ifMatch = req.headers['if-match'] as string | undefined;
    const result = await storePutDoc(workspaceDir, collection, id, body, contentType, ifMatch);
    if ('kind' in result) {
      const map = { invalid_id: 400, too_large: 413, invalid_json: 400, etag_mismatch: 412 } as const;
      writeJson(res, map[result.kind], { error: result.kind.toUpperCase() });
      return;
    }
    res.writeHead(204, { 'etag': result.etag });
    res.end();
    return;
  }

  if (req.method === 'DELETE') {
    const ok = await storeDeleteDoc(workspaceDir, collection, id);
    res.writeHead(ok ? 204 : 404);
    res.end();
    return;
  }

  writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
}

function serveRenderer(res: ServerResponse, type: string): void {
  if (!activeWorkspace) {
    writeJson(res, 500, { error: 'NO_WORKSPACE_CONTEXT', detail: 'terminal-server started without workspace' });
    return;
  }
  const entry = resolveRendererFile(type, activeWorkspace);
  if (!entry) {
    writeJson(res, 404, { error: 'RENDERER_NOT_FOUND', type });
    return;
  }
  let body: string;
  try {
    body = readFileSync(entry.filePath, 'utf8');
  } catch (err) {
    writeJson(res, 500, {
      error: 'RENDERER_READ_FAILED',
      type,
      detail: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    // Never cache the renderer module — deploys change it and a stale copy
    // silently breaks the artifact (e.g. old code hitting removed endpoints).
    // Matches serveRendererLib.
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveRendererLib(res: ServerResponse, name: string): void {
  const file = join(builtinRenderersDir(), `${name}.mjs`);
  if (!existsSync(file)) {
    writeJson(res, 404, { error: 'NOT_FOUND', detail: `library ${name}.mjs not found` });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&#39;',
  );
}

function renderArtifactHostHtml(id: string, type: string, title: string, shared = false): string {
  const safeId = escapeHtml(id);
  const safeType = escapeHtml(type);
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle} · ${safeType}</title>
  <script>window.__CDB_SHARED__ = ${shared ? 'true' : 'false'};</script>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 8px 12px; font-size: 12px; background: #2d2d30; border-bottom: 1px solid #3e3e42;
      display: flex; gap: 12px; align-items: center; }
    header b { color: #fff; }
    header .pill { padding: 2px 8px; border-radius: 4px; background: #0e639c; font-size: 11px; }
    header .pill.type { background: #4d4d4d; }
    header .spacer { flex: 1; }
    header .share-btn { background: none; border: 1px solid #555; border-radius: 4px; color: #ccc;
      padding: 3px 10px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; }
    header .share-btn:hover { background: #0e639c; border-color: #0e639c; color: #fff; }
    header .share-btn.copied { background: #2ea043; border-color: #2ea043; color: #fff; }
    #artifact-root { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; }
    #artifact-error { color: #f14c4c; padding: 12px 16px; font-family: Consolas, monospace; white-space: pre-wrap; }
    /* Immunize host chrome from author global-selector leakage. The html renderer
       injects author HTML via innerHTML, so an artifact's page-level rules
       (e.g. \`body { max-width: 1240px; margin: 0 auto; padding: 24px }\`) cascade
       onto THIS host <body> — shrinking + centering the header/#artifact-root and,
       combined with the comment-sidebar gutter (padding-right, border-box), letting
       the sidebar eat into the capped content when opened. Pin the host body to full
       width; the sidebar gutter (padding-right) is preserved by higher-specificity rules. */
    html > body { max-width: none !important; margin: 0 !important;
      padding-top: 0 !important; padding-left: 0 !important; padding-bottom: 0 !important; }
  </style>
</head>
<body>
  <header>
    <b>Clawdevbox</b>
    <span>artifact <code id="iid">${safeId}</code></span>
    <span class="pill type">type: ${safeType}</span>
    <span class="pill" id="title-pill">${safeTitle}</span>
    <span class="spacer"></span>
    <button class="share-btn" id="share-btn" title="Copy share link" onclick="copyShareUrl()">&#x1F517; Share</button>
  </header>
  <div id="artifact-root"></div>
  <script type="module">
    const id = ${JSON.stringify(id)};
    const type = ${JSON.stringify(type)};
    const root = document.getElementById('artifact-root');

    // Share: use the tenant-scoped share tunnel (safe for colleagues).
    // getArtifactShareUrl is exposed so an artifact renderer that hides this
    // host header (e.g. pr-walkthrough) can offer its own Share control.
    async function getArtifactShareUrl() {
      let url = window.location.href;
      try {
        const shareTunnel = await fetch('/api/share-tunnel/status').then(r => r.json());
        if (shareTunnel.url) {
          url = shareTunnel.url + '/artifact/' + encodeURIComponent(id);
        } else {
          // Fall back to main tunnel
          const tunnel = await fetch('/api/tunnel/status').then(r => r.json());
          if (tunnel.url) {
            const port = tunnel.port || 5201;
            url = tunnel.url.replace(/-\\d+\\./, '-' + port + '.') + '/artifact/' + encodeURIComponent(id);
          }
        }
      } catch { /* use current URL */ }
      return url;
    }
    async function copyShareUrl() {
      const btn = document.getElementById('share-btn');
      const url = await getArtifactShareUrl();
      try {
        await navigator.clipboard.writeText(url);
        if (btn) {
          btn.textContent = '✓ Copied';
          btn.classList.add('copied');
          setTimeout(() => { btn.innerHTML = '&#x1F517; Share'; btn.classList.remove('copied'); }, 2000);
        }
      } catch {
        prompt('Copy this URL:', url);
      }
    }
    window.copyShareUrl = copyShareUrl;
    window.getArtifactShareUrl = getArtifactShareUrl;

    async function fetchJson(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(\`GET \${url} → \${r.status}\`);
      return r.json();
    }
    async function fetchText(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(\`GET \${url} → \${r.status}\`);
      return r.text();
    }

    try {
      const manifest = await fetchJson(\`/artifact/\${encodeURIComponent(id)}/manifest\`);
      const filesList = (await fetchJson(\`/artifact/\${encodeURIComponent(id)}/files\`)).files;
      const ctx = {
        manifest,
        artifactId: id,
        listFiles: async () => filesList,
        fetchFile: (name) => fetchText(\`/artifact/\${encodeURIComponent(id)}/file/\${encodeURIComponent(name)}\`),
        fetchFileJson: (name) => fetchJson(\`/artifact/\${encodeURIComponent(id)}/file/\${encodeURIComponent(name)}\`),
      };
      const mod = await import(\`/__renderer/\${encodeURIComponent(type)}.mjs\`);
      const renderer = mod.default ?? mod;
      if (typeof renderer.render !== 'function') {
        throw new Error(\`renderer for "\${type}" has no .render(root, ctx) function\`);
      }
      await renderer.render(root, ctx);

      // Auto-enable the artifact-comments overlay for every renderer
      // unless its module opts out via 'comments: false'. This is the
      // single source of universality: any renderer (built-in, plugin,
      // workspace) gets selection/element/region comments without
      // having to import the overlay itself. Renderers that ship
      // their own sidebar UI (walkthrough, pr-review) opt out so the
      // two sidebars don't fight for screen real-estate.
      if (renderer.comments !== false) {
        try {
          const { enableComments } = await import('/__renderer-lib/_comment-overlay.mjs');
          await enableComments(root, ctx);
        } catch (overlayErr) {
          // Comments are non-critical — never block the renderer
          // because the overlay failed to load.
          console.warn('[clawdevbox] comment overlay failed to load:', overlayErr);
        }
      }

      window.__clawdevboxArtifact = { id, type, manifest, files: filesList };
    } catch (err) {
      root.innerHTML = '';
      const pre = document.createElement('div');
      pre.id = 'artifact-error';
      pre.textContent = 'Failed to render artifact:\\n' + (err && err.stack ? err.stack : String(err));
      root.appendChild(pre);
    }
  </script>
</body>
</html>`;
}

// ============================================================================
// HTML / xterm.js page
// ============================================================================

/**
 * Resolve the metadata we want to render in the terminal viewer header.
 *
 * Source priority:
 *   1. Live pty-registry meta (set by recipe-runner at register time).
 *   2. On-disk recipe-instance JSON in any registered workspace (archive
 *      fallback — pty exited and was GC'd from the registry, but the
 *      instance file still records agent_cli, session_id, workspace_path,
 *      log_path, recipe_id).
 *
 * Returns null only if neither source has any data. The header still
 * renders in that case (just with no detail pills).
 */
interface TerminalHeaderMeta {
  cwd?: string;
  commandLine?: string;
  agentCli?: string;
  sessionId?: string;
  recipeId?: string;
  startedAt?: number;
  archived?: boolean;
  status?: string;
}

function resolveTerminalMeta(instanceId: string): TerminalHeaderMeta {
  const live: PtySessionMeta | null = getSessionMeta(instanceId);
  if (live) {
    return {
      cwd: live.cwd,
      commandLine: live.commandLine,
      agentCli: live.agentCli,
      sessionId: live.sessionId,
      recipeId: live.recipeId,
      startedAt: live.startedAt,
    };
  }
  // Archive fallback — iterate registered workspaces (same strategy as
  // readArchivedTerminalLog) and try to load <ws>/.clawdevbox/recipe-instances/<id>.json
  const candidates: string[] = [];
  const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR;
  if (projectDir) candidates.push(projectDir);
  try {
    const root = resolveWorkspacesRoot();
    for (const w of listWorkspaces(root)) candidates.push(w.path);
  } catch {
    /* ignore */
  }
  for (const wsPath of candidates) {
    try {
      const inst = readRecipeInstance(wsPath, instanceId);
      if (inst) {
        return {
          cwd: inst.workspace_path,
          agentCli: inst.agent_cli,
          sessionId: inst.session_id,
          recipeId: inst.recipe_id,
          archived: true,
          status: inst.status,
        };
      }
    } catch {
      /* try next */
    }
  }
  return { archived: true };
}

function escapeHtmlAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderTerminalHtml(
  instanceId: string,
  meta: TerminalHeaderMeta,
  opts: { embed?: boolean } = {},
): string {
  const embed = opts.embed === true;
  const safeId = instanceId.replace(/[^A-Za-z0-9_-]/g, '');
  // Build the structured detail row (cwd / command / agent / session).
  // Each field is independently optional — only render pills we actually have.
  const pills: string[] = [];
  if (meta.agentCli) {
    pills.push(`<span class="pill agent" title="agent CLI provider">agent: <code>${escapeHtmlAttr(meta.agentCli)}</code></span>`);
  }
  if (meta.sessionId) {
    pills.push(`<span class="pill session" title="CLI session id (resumable)">session: <code>${escapeHtmlAttr(meta.sessionId)}</code></span>`);
  }
  if (meta.recipeId) {
    pills.push(`<span class="pill recipe" title="recipe id">recipe: <code>${escapeHtmlAttr(meta.recipeId)}</code></span>`);
  }
  const detailLines: string[] = [];
  if (meta.cwd) {
    detailLines.push(`<div class="detail"><span class="label">cwd</span><code class="path" title="${escapeHtmlAttr(meta.cwd)}">${escapeHtmlAttr(meta.cwd)}</code></div>`);
  }
  if (meta.commandLine) {
    detailLines.push(`<div class="detail"><span class="label">cmd</span><code class="cmd" title="${escapeHtmlAttr(meta.commandLine)}">${escapeHtmlAttr(meta.commandLine)}</code></div>`);
  }
  const archivedNotice = meta.archived && !getSessionMeta(instanceId)
    ? `<span class="pill archived" title="pty has exited; showing archived state">archived${meta.status ? ` · ${escapeHtmlAttr(meta.status)}` : ''}</span>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Clawdevbox recipe terminal · ${safeId}</title>
  <link rel="stylesheet" href="https://esm.sh/@xterm/xterm@5.5.0/css/xterm.css" />
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 8px 12px; font-size: 12px; background: #2d2d30; border-bottom: 1px solid #3e3e42; display: flex; flex-direction: column; gap: 6px; }
    header .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    header b { color: #fff; }
    header .iid { color: #9cdcfe; }
    header .status { padding: 2px 8px; border-radius: 4px; background: #0e639c; font-size: 11px; color: #fff; }
    header .status.exited { background: #6e6e6e; }
    header button { background: #f14c4c; color: #fff; border: 0; padding: 4px 10px; font-size: 11px; border-radius: 3px; cursor: pointer; margin-left: auto; }
    header button:disabled { background: #6e6e6e; cursor: not-allowed; }
    header .pill { padding: 2px 8px; border-radius: 4px; background: #3a3d41; font-size: 11px; color: #d4d4d4; white-space: nowrap; }
    header .pill code { background: transparent; color: #ce9178; font-family: Consolas, "Liberation Mono", Menlo, monospace; }
    header .pill.agent { background: #0e3a5c; }
    header .pill.session { background: #3a2a5c; }
    header .pill.recipe { background: #2d4a2d; }
    header .pill.archived { background: #6e6e6e; }
    header .detail { display: flex; gap: 8px; align-items: baseline; font-size: 11px; min-width: 0; }
    header .detail .label { color: #858585; text-transform: uppercase; letter-spacing: 0.05em; font-size: 10px; min-width: 32px; }
    header .detail code { font-family: Consolas, "Liberation Mono", Menlo, monospace; color: #d4d4d4; background: #252526; padding: 2px 6px; border-radius: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: calc(100vw - 80px); }
    header .detail code.path { color: #9cdcfe; }
    header .detail code.cmd { color: #d7ba7d; }
    /* Embed mode: a slim 1-line status strip + minimal chrome so the
     * recipe-panel iframe doesn't show duplicate metadata. Only the
     * status badge + Kill button remain. */
    header.embed { padding: 4px 8px; gap: 0; background: #1e1e1e; border-bottom-color: #2a2a2a; }
    header.embed .row { gap: 6px; font-size: 11px; }
    header.embed .row > b, header.embed .row > .recipe-iid-wrap, header.embed .pill, header.embed .pill.archived, header.embed .detail { display: none; }
    header.embed .status { font-size: 10.5px; padding: 1px 6px; }
    header.embed button { padding: 2px 8px; font-size: 10.5px; }
    #term { flex: 1; padding: 4px; min-height: 0; overflow: auto; }
    .xterm, .xterm-viewport { background: #1e1e1e !important; }
  </style>
</head>
<body>
  <header${embed ? ' class="embed"' : ''}>
    <div class="row">
      <b>Clawdevbox</b>
      <span class="recipe-iid-wrap">recipe instance <code class="iid" id="iid">${safeId}</code></span>
      ${pills.join('\n      ')}
      ${archivedNotice}
      <span class="status" id="status">connecting…</span>
      <button id="killBtn" title="SIGTERM the pty">Kill</button>
    </div>
    ${detailLines.length > 0 ? detailLines.join('\n    ') : ''}
  </header>
  <div id="term"></div>
  <script type="module">
    import { Terminal } from 'https://esm.sh/@xterm/xterm@5.5.0';
    import { FitAddon } from 'https://esm.sh/@xterm/addon-fit@0.10.0';

    const instanceId = ${JSON.stringify(safeId)};
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const termHost = document.getElementById('term');
    term.open(termHost);

    const statusEl = document.getElementById('status');
    const killBtn = document.getElementById('killBtn');

    // ---- Lifecycle: defer WS open until the iframe has STABLE non-zero
    // dimensions, then size the WS connect URL from the fitted cols/rows.
    //
    // User feedback: 'The initial width and height seems incorrect. It
    // gets fixed on resizing the windows.' Cause: when the page loads in
    // an iframe, the iframe element's pixel dims can be 0 for a tick
    // (Vue's flex parent hasn't fully laid out yet), and any fit.fit()
    // run during that window falls back to xterm's 80x24 defaults. We
    // now drive BOTH the initial fit AND every subsequent re-fit from a
    // ResizeObserver on the term host — first observation with non-zero
    // dimensions starts the WS, later observations re-fit + tell the
    // backend pty to resize.
    let ws = null;
    let wsOpened = false;

    function openWs() {
      if (wsOpened) return;
      wsOpened = true;
      const cols = (term.cols && term.cols >= 20) ? term.cols : 120;
      const rows = (term.rows && term.rows >= 5) ? term.rows : 30;
      const wsUrl = new URL(\`/terminal/\${instanceId}/ws\`, location.href);
      wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl.searchParams.set('cols', String(cols));
      wsUrl.searchParams.set('rows', String(rows));
      ws = new WebSocket(wsUrl.toString());

      ws.onopen = () => {
        statusEl.textContent = 'attached';
        // Belt-and-suspenders #1: re-fit on WS open. By the time the WS
        // handshake completes, layout has almost certainly settled (the
        // WS takes 50-200ms to negotiate). If our initial fit fired
        // against partial layout, this catches up and sends the right
        // dims via term.onResize -> backend pty SIGWINCH.
        try {
          if (termHost.clientWidth > 0 && termHost.clientHeight > 0) fit.fit();
        } catch { /* */ }
        // Belt-and-suspenders #2: ALWAYS send a resize on open so the
        // backend pty matches our current cols/rows even if fit was a
        // no-op. Server dedupes identical resizes.
        try { ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); } catch { /* */ }
      };
      ws.onclose = () => {
        statusEl.textContent = 'disconnected';
        statusEl.classList.add('exited');
        killBtn.disabled = true;
      };
      ws.onerror = () => { statusEl.textContent = 'error'; statusEl.classList.add('exited'); };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'snapshot') {
          if (msg.content) term.write(msg.content);
          if (msg.exited) { statusEl.textContent = 'exited (' + (msg.exitCode ?? '?') + ')'; statusEl.classList.add('exited'); killBtn.disabled = true; }
        } else if (msg.type === 'data') {
          term.write(msg.chunk);
        } else if (msg.type === 'exit') {
          statusEl.textContent = 'exited (' + msg.exitCode + ')';
          statusEl.classList.add('exited');
          killBtn.disabled = true;
        }
      };

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'input', data })); } catch { /* */ }
        }
      });
    }

    // Forwards xterm's dim changes (caused by fit.fit() or font-size
    // changes) to the backend pty so it issues a SIGWINCH-equivalent
    // and the agent re-renders at the new size.
    term.onResize(({ cols, rows }) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch { /* */ }
      }
    });

    // ResizeObserver drives BOTH the initial fit AND every subsequent
    // refit. First observation with non-zero dims opens the WS; later
    // ones just re-fit. 120ms debounce avoids spamming the backend
    // during a drag-resize.
    let refitTimer = null;
    function doFit() {
      if (termHost.clientWidth === 0 || termHost.clientHeight === 0) return;
      try { fit.fit(); } catch { /* layout in flux */ return; }
      if (!wsOpened) openWs();
    }
    const ro = new ResizeObserver(() => {
      if (refitTimer) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => { refitTimer = null; doFit(); }, 16);
    });
    ro.observe(termHost);
    window.addEventListener('resize', () => {
      if (refitTimer) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => { refitTimer = null; doFit(); }, 120);
    });

    // Belt #2: also try an immediate fit in case ResizeObserver doesn't
    // fire (e.g. termHost was already non-zero when observe() ran — some
    // browsers don't fire the initial observation in that case).
    requestAnimationFrame(() => doFit());

    // Belt #3: 1s deadline — if NOTHING fired and the WS still hasn't
    // opened, force-open at xterm's current dims (might be 80x24
    // defaults, but better than no WS at all so the user sees
    // something). The ResizeObserver will catch up and re-fit shortly.
    setTimeout(() => { if (!wsOpened) openWs(); }, 1000);

    killBtn.addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'kill' }));
      }
    });

    window.__clawdevboxTerm = term;
  </script>
</body>
</html>`;
}

// ============================================================================
// WS handler
// ============================================================================

async function attachWebsocket(
  ws: WebSocket,
  instanceId: string,
  initialDims: { cols: number; rows: number } = { cols: 120, rows: 30 },
): Promise<void> {
  // T19: tmux-attach path. If the instance is a tmux-backed agent in our
  // registry, spawn a per-viewer `tmux attach` IPty. xterm.js capability
  // replies go INTO tmux (a TUI client) and never reach the agent — this is
  // the structural fix for the viewer-input race.
  const tmuxSession = tmuxSessionRegistry.get(instanceId);
  if (tmuxSession) {
    attachWebsocketViaTmux(ws, instanceId, tmuxSession.name, initialDims);
    return;
  }

  // Not in tmuxSessionRegistry — could be a foreign tmux session OR a leftover
  // clawdevbox-spawned tmux session that survived a kernel restart (cdb_<id>
  // name still alive in tmux). In either case, if a tmux session for this
  // instance exists (either bare `<id>` or the canonical `cdb_<id>` name),
  // attach to it. Uses the cached tmux list (1s TTL) so back-to-back WS
  // attaches don't fork a child each.
  if (!hasSession(instanceId)) {
    const tmuxName = await findTmuxSessionName(instanceId);
    if (tmuxName) {
      attachWebsocketViaTmux(ws, instanceId, tmuxName, initialDims);
      return;
    }
  }

  // This exact instance is dead. But a resumed embodiment of the SAME CLI
  // conversation may be alive under a different recipe-instance id (each
  // `--resume` mints a new instance + `cdb_<newId>` tmux session, all
  // sharing one `cli_session_id`). Follow that link and attach to the live
  // sibling so callers holding an old id (e.g. an inbox item linked to a
  // now-resumed recipe) transparently see the LIVE terminal — instead of an
  // archived "session ended" snapshot that then tempts a duplicate spawn.
  if (!hasSession(instanceId)) {
    try {
      const { resolveLiveInstanceForInstance } = await import('./live-instance-resolver.ts');
      const resolved = await resolveLiveInstanceForInstance(getDatabase(), instanceId);
      if (resolved && resolved.liveInstanceId !== instanceId) {
        const liveTmux = tmuxSessionRegistry.get(resolved.liveInstanceId);
        const tmuxName = liveTmux?.name ?? await findTmuxSessionName(resolved.liveInstanceId);
        if (tmuxName) {
          attachWebsocketViaTmux(ws, resolved.liveInstanceId, tmuxName, initialDims);
          return;
        }
      }
    } catch { /* fall through to archived-log path */ }
  }

  if (!hasSession(instanceId)) {
    // Pty has exited and been garbage-collected from the registry.
    // Fall back to the on-disk log so the viewer at least shows what
    // the agent did during the live session. Searches the project dir
    // and every registered workspace.
    const snapshot = readArchivedTerminalLog(instanceId);
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        content: snapshot ?? '[clawdevbox] this session has exited and its log was not captured.\r\n',
        cols: 120,
        rows: 30,
        exited: true,
        exitCode: 0,
        archived: true,
      }));
      ws.send(JSON.stringify({ type: 'exit', exitCode: 0 }));
    } catch { /* ignore */ }
    try { ws.close(1000, 'session archived'); } catch { /* ignore */ }
    return;
  }

  const { unsubscribe } = subscribe(instanceId, (event) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch { /* viewer drop */ }
  });

  // The pty-registry path historically IGNORED the `?cols=&rows=` query
  // string — only the tmux-attach path honoured viewer dims at attach.
  // Result: the main agent's pty stayed at whatever spawn-time defaults
  // were registered (120×30) regardless of how big the viewer's xterm
  // actually was, so a 278×63 tile in the Workspace-grouped tiled view
  // saw copilot drawing in the top-left ~30 rows with the rest of the
  // tile empty. Resize now so the pty matches THIS viewer's intent.
  // Multi-viewer: the last connect wins, matching tmux's aggressive-
  // resize semantics on the other path.
  try { resizePty(instanceId, initialDims.cols, initialDims.rows); } catch { /* */ }

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (m.type === 'input' && typeof m.data === 'string') {
      writeToPty(instanceId, m.data);
    } else if (
      m.type === 'resize' &&
      typeof m.cols === 'number' &&
      typeof m.rows === 'number'
    ) {
      resizePty(instanceId, m.cols, m.rows);
    } else if (m.type === 'kill') {
      killPty(instanceId, typeof m.signal === 'string' ? m.signal : undefined);
    }
  });

  ws.on('close', () => unsubscribe());
  ws.on('error', () => unsubscribe());
}

/**
 * Live count of active viewer WebSockets per instance_id (tmux-backed
 * sessions). Incremented on attach, decremented on close/error. Used by
 * `idle-reaper.ts` to decide whether a session has any actual viewer:
 * `tmux list-clients` is unreliable on psmux (always reports a phantom
 * `/dev/pts/0` client even on a never-attached session), so we keep our
 * own count instead.
 *
 * Exposed via `viewerCountForInstance(instanceId)`.
 */
const tmuxViewerCounts = new Map<string, number>();

export function viewerCountForInstance(instanceId: string): number {
  return tmuxViewerCounts.get(instanceId) ?? 0;
}

/**
 * T19: spawn a per-viewer `tmux attach -t cdb_<instanceId>` IPty and wire it
 * to the WebSocket. Each viewer gets its own attach process; closing the WS
 * kills only that viewer's attach without affecting other viewers OR the
 * agent (which keeps running in tmux).
 *
 * RESIZE — on Windows psmux (3.3.2 port of tmux):
 *   • `tmux resize-window` / `resize-pane` are SILENT NO-OPS — they accept
 *     the request and return success but the pane's conpty never changes
 *     size.
 *   • `ipty.resize(cols, rows)` on the attach IPty DOES work — node-pty
 *     calls ResizePseudoConsole on the attach client's local conpty, the
 *     tmux-attach process detects SIGWINCH (well, the Win32 equivalent),
 *     and psmux applies the new size to the pane (because aggressive-resize
 *     is on per the bundled cdb.tmux.conf).
 *   • The pane's INITIAL size is locked at attach-client creation time. If
 *     we spawn the attach IPty at 120×30 then resize to 136×52, copilot's
 *     existing scrollback was rendered at 120 cols and tmux's re-flow of
 *     mixed-width content looks garbled. To avoid this, the WS upgrade
 *     handler parses `?cols=&rows=` and we pass them as the initial IPty
 *     dims — so the very first paint is already at the viewer's real size.
 */
function attachWebsocketViaTmux(
  ws: WebSocket,
  instanceId: string,
  tmuxSessionName: string,
  initialDims: { cols: number; rows: number } = { cols: 120, rows: 30 },
): void {
  const tmuxBin = resolveTmuxBin();
  const cfg = resolveConfig({
    projectDir: process.env.CLAWDEVBOX_PROJECT_DIR ?? process.cwd(),
    globalDir: process.env.CLAWDEVBOX_GLOBAL_DIR ?? '',
  });
  // See start.ts: default to the shared tmux server (no -L) because psmux on
  // Windows doesn't multiplex sessions per named socket — every new-session
  // creates a separate server process, which prevents `tmux attach` from
  // finding the right server.
  const tmuxSocket = (cfg as { tmux?: { socket: string | null } }).tmux?.socket ?? null;

  const args: string[] = [];
  if (tmuxSocket) args.push('-L', tmuxSocket);
  args.push('attach-session', '-t', tmuxSessionName);

  // eslint-disable-next-line no-console
  console.log('[tmux-attach]', JSON.stringify({
    bin: tmuxBin, args, cols: initialDims.cols, rows: initialDims.rows,
  }));

  let ipty: ReturnType<typeof ptySpawn>;
  try {
    ipty = ptySpawn(tmuxBin, args, {
      name: 'xterm-256color',
      cols: initialDims.cols,
      rows: initialDims.rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        content: `[clawdevbox] failed to attach tmux viewer: ${(err as Error).message}\r\n`,
        cols: initialDims.cols, rows: initialDims.rows, exited: true, exitCode: 1,
      }));
      ws.send(JSON.stringify({ type: 'exit', exitCode: 1 }));
      ws.close(1011, 'tmux attach failed');
    } catch { /* ignore */ }
    return;
  }

  let closed = false;
  // Bump the live-viewer counter; decrement on close/error/exit.
  tmuxViewerCounts.set(instanceId, (tmuxViewerCounts.get(instanceId) ?? 0) + 1);
  const decrementViewerCount = (): void => {
    const cur = tmuxViewerCounts.get(instanceId) ?? 0;
    if (cur <= 1) tmuxViewerCounts.delete(instanceId);
    else tmuxViewerCounts.set(instanceId, cur - 1);
  };

  // Coalesce tmux's tight redraw bursts into ≤120fps WS messages. Without
  // this, a full-screen tmux repaint flushes 100+ tiny chunks per second,
  // each becoming its own JSON.stringify + ws.send + onmessage + term.write
  // round-trip on the browser. Batching 8ms of chunks into one message
  // cuts xterm.js's writebuffer pressure dramatically and lets the WebGL
  // renderer draw entire repaints in a single frame.
  let pendingChunks: string[] = [];
  let flushTimer: ReturnType<typeof setImmediate> | null = null;
  const flush = (): void => {
    flushTimer = null;
    if (pendingChunks.length === 0) return;
    const merged = pendingChunks.length === 1 ? pendingChunks[0] : pendingChunks.join('');
    pendingChunks = [];
    if (closed || ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'data', chunk: merged })); } catch { /* viewer drop */ }
  };
  ipty.onData((chunk) => {
    if (closed) return;
    pendingChunks.push(chunk);
    if (!flushTimer) flushTimer = setImmediate(flush);
  });
  ipty.onExit(({ exitCode }) => {
    if (closed) return;
    flush();
    try { ws.send(JSON.stringify({ type: 'exit', exitCode: exitCode ?? 0 })); } catch {}
    try { ws.close(1000, 'tmux attach exited'); } catch {}
  });

  // Force psmux's aggressive-resize to propagate this viewer's dims to
  // the underlying tmux pane (and therefore to copilot's pty inside).
  // Without this, the pane stays at its spawn-time dims (default 120×30
  // per tmux-session.ts → spawn), so a wide-screen viewer sees copilot
  // drawing at 120×30 with empty rows/cols beyond — the "tile shows
  // content only in the top-left" rendering bug.
  //
  // We use ipty.resize() (not the WS resize-message path) because it
  // skips the no-op guard at the message handler (`if (cols === currentCols
  // && rows === currentRows) return;`) — currentCols/Rows start equal to
  // initialDims so the first matching WS resize message gets dropped.
  // The +1 on rows is the psmux compensation (file header note: psmux
  // subtracts one row when propagating SIGWINCH).
  //
  // Deferred ~200ms because tmux-attach needs a beat after node-pty's
  // CreatePseudoConsole to wire up its connection to the server's pane;
  // resizing during that window is silently ignored on Windows psmux.
  setTimeout(() => {
    if (closed) return;
    try {
      ipty.resize(initialDims.cols, initialDims.rows + 1);
    } catch { /* attach died early */ }
  }, 200);

  // Track the last applied dims so we can ignore no-op resize messages
  // (ResizeObserver fires many times during a viewport drag).
  let currentCols = initialDims.cols;
  let currentRows = initialDims.rows;

  ws.on('message', (raw) => {
    if (closed) return;
    let msg: unknown;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (m.type === 'input' && typeof m.data === 'string') {
      try { ipty.write(m.data); } catch { /* attach dead */ }
    } else if (
      m.type === 'resize' &&
      typeof m.cols === 'number' &&
      typeof m.rows === 'number'
    ) {
      const cols = clampDim(m.cols, currentCols);
      const rows = clampDim(m.rows, currentRows);
      if (cols === currentCols && rows === currentRows) return;
      currentCols = cols;
      currentRows = rows;
      // psmux on Windows: aggressive-resize subtracts 1 row when it propagates
      // the IPty's SIGWINCH-equivalent to the pane. Pass rows+1 to ipty so
      // the pane ends up at the rows the browser expects.
      try { ipty.resize(cols, rows + 1); } catch { /* attach dead */ }
    }
    // 'kill' on a tmux-attach viewer just detaches (kill the attach IPty),
    // not the agent. Use DELETE /api/sessions/<id> for full agent kill.
    if (m.type === 'kill') {
      killViewerIpty(ipty);
      closed = true;
      decrementViewerCount();
    }
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (flushTimer) { clearImmediate(flushTimer); flushTimer = null; }
    pendingChunks = [];
    killViewerIpty(ipty);
    decrementViewerCount();
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/**
 * Search the project dir + every registered workspace for the
 * `.clawdevbox/recipe-instances/<instanceId>.log` file written by the
 * recipe-run pty handler. Returns the file content (or null if no log
 * exists). Used as a fallback when the pty has exited and the registry
 * has dropped the session.
 */
function readArchivedTerminalLog(instanceId: string): string | null {
  const candidates: string[] = [];
  const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR;
  if (projectDir) {
    candidates.push(
      join(projectDir, '.clawdevbox', 'recipe-instances', `${instanceId}.log`),
    );
  }
  try {
    const root = resolveWorkspacesRoot();
    for (const w of listWorkspaces(root)) {
      candidates.push(
        join(w.path, '.clawdevbox', 'recipe-instances', `${instanceId}.log`),
      );
    }
  } catch {
    /* ignore */
  }
  // Hard tail cap: a forgotten-but-noisy agent can produce multi-GB log files.
  // Reading the whole file with readFileSync would allocate a giant string
  // inside the kernel process — a single such request can OOM the service.
  // 1 MB tail is enough for a meaningful "what was it doing" snapshot.
  const TAIL_BYTES = 1024 * 1024;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const { size } = statSync(p);
      if (size <= TAIL_BYTES) {
        return readFileSync(p, 'utf8');
      }
      // Tail: read the last TAIL_BYTES, prepend a truncation banner.
      const fd = openSync(p, 'r');
      try {
        const buf = Buffer.alloc(TAIL_BYTES);
        readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
        return `[clawdevbox] log truncated — showing last ${TAIL_BYTES} of ${size} bytes\r\n…\r\n` + buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      /* ignore — try next candidate */
    }
  }
  return null;
}
