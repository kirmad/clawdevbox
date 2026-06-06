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
  listArtifactFiles,
  readArtifact,
} from './artifact-store.ts';
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
import { resolveRendererFile } from './renderer-registry.ts';
import type { Workspace } from './workspace.ts';
import { listWorkspaces, resolveWorkspacesRoot } from './workspaces-store.ts';
import { readRecipeInstance } from './recipe-instances-store.ts';

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
 * Force a tmux pane + window to the given dimensions. Required on psmux
 * (Windows) because `aggressive-resize` does not propagate SIGWINCH from an
 * `attach-session` client back to the tmux server — so the pane stays at its
 * creation size (120×30) even after the browser sends a resize message.
 *
 * We run both `resize-window` and `resize-pane` because psmux sometimes needs
 * both: resize-window sets the window geometry; resize-pane adjusts the
 * individual pane within it.  Both are fire-and-forget via spawnSync with a
 * short timeout so they don't block the Node event loop.
 */
function tmuxResizePane(
  tmuxBin: string,
  tmuxSocket: string | null,
  sessionName: string,
  cols: number,
  rows: number,
): void {
  const socketArgs = tmuxSocket ? ['-L', tmuxSocket] : [];
  // eslint-disable-next-line no-console
  console.log('[tmux-resize]', JSON.stringify({ session: sessionName, cols, rows }));
  // psmux (Windows) reserves 1 row internally even with `status off`, so the
  // visible pane height is window_height - 1.  The caller already compensated
  // in ipty.resize (passing rows+1); here we pass the original rows so that
  // resize-window + ipty together converge on the correct pane height.
  // resize-pane with only -x keeps pane width in sync; omitting -y avoids the
  // double-subtract that would give rows-2.
  for (const subcmd of [
    ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)],
    ['resize-pane', '-t', sessionName, '-x', String(cols)],
    ['refresh-client', '-t', sessionName],
  ]) {
    try {
      spawnSync(tmuxBin, [...socketArgs, ...subcmd], {
        timeout: 2000,
        stdio: 'ignore',
        // tmuxResizePane fires 3× per browser resize message; without
        // windowsHide each one pops a brief console window on Windows.
        windowsHide: true,
      });
    } catch { /* ignore — psmux may return non-zero for unsupported commands */ }
  }
}

/**
 * Probe whether a tmux session with the given name exists on the default
 * socket. Uses the cached `tmuxSessionRuntime().list()` (1s TTL) instead of
 * spawning a fresh `tmux has-session` subprocess — at SPA poll rates (every
 * 2s on /api/sessions + per-WS-attach probe), forking a child on every
 * check would block the Node event loop for 100ms+ on Windows psmux.
 */
async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    const { tmuxSessionRuntime } = await import('./cli-sessions/tmux-session-runtime.ts');
    const list = await tmuxSessionRuntime().list();
    return list.some((s) => s.name === name);
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
    wsServer!.handleUpgrade(req, socket, head, (ws) => {
      void attachWebsocket(ws, instanceId);
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderTerminalHtml(instanceId, meta));
    return;
  }

  // -------- Renderer module ----------------------------------------------
  const rendererMatch = url.pathname.match(/^\/__renderer\/([A-Za-z0-9._-]+)\.mjs$/);
  if (rendererMatch) {
    serveRenderer(res, rendererMatch[1]);
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
    serveArtifactHost(res, artifactMatch[1]);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// ============================================================================
// Artifact route handlers
// ============================================================================

interface FoundArtifact {
  workspacePath: string;
  workspaceId: string;
  manifest: NonNullable<ReturnType<typeof readArtifact>>['manifest'];
}

/** Locate an artifact across the project dir + every registered workspace. */
function findArtifact(id: string): FoundArtifact | null {
  // The project dir itself is treated as a workspace with id 'project' so
  // artifacts written under <projectDir>/artifacts/<id>/ are discoverable
  // without the user explicitly registering a workspace. This matches the
  // /api/inbox enrichment helper in cli/start.ts.
  const projectDir = process.env.CLAWDEVBOX_PROJECT_DIR;
  if (projectDir) {
    const rec = readArtifact(projectDir, id);
    if (rec) {
      return { workspacePath: projectDir, workspaceId: 'project', manifest: rec.manifest };
    }
  }
  const root = resolveWorkspacesRoot();
  for (const w of listWorkspaces(root)) {
    const rec = readArtifact(w.path, id);
    if (rec) {
      return { workspacePath: w.path, workspaceId: w.id, manifest: rec.manifest };
    }
  }
  return null;
}

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

function serveArtifactHost(res: ServerResponse, id: string): void {
  const found = findArtifact(id);
  if (!found) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>404</title><pre>Artifact "${escapeHtml(id)}" not found in any registered workspace.</pre>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(renderArtifactHostHtml(id, found.manifest.type, found.manifest.title));
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
  res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
  res.end(body);
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

function renderArtifactHostHtml(id: string, type: string, title: string): string {
  const safeId = escapeHtml(id);
  const safeType = escapeHtml(type);
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${safeTitle} · ${safeType}</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 8px 12px; font-size: 12px; background: #2d2d30; border-bottom: 1px solid #3e3e42;
      display: flex; gap: 12px; align-items: center; }
    header b { color: #fff; }
    header .pill { padding: 2px 8px; border-radius: 4px; background: #0e639c; font-size: 11px; }
    header .pill.type { background: #4d4d4d; }
    #artifact-root { flex: 1; min-height: 0; overflow: auto; padding: 12px 16px; }
    #artifact-error { color: #f14c4c; padding: 12px 16px; font-family: Consolas, monospace; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <b>Clawdevbox</b>
    <span>artifact <code id="iid">${safeId}</code></span>
    <span class="pill type">type: ${safeType}</span>
    <span class="pill" id="title-pill">${safeTitle}</span>
  </header>
  <div id="artifact-root"></div>
  <script type="module">
    const id = ${JSON.stringify(id)};
    const type = ${JSON.stringify(type)};
    const root = document.getElementById('artifact-root');

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

function renderTerminalHtml(instanceId: string, meta: TerminalHeaderMeta): string {
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
    #term { flex: 1; padding: 4px; min-height: 0; overflow: auto; }
    .xterm, .xterm-viewport { background: #1e1e1e !important; }
  </style>
</head>
<body>
  <header>
    <div class="row">
      <b>Clawdevbox</b>
      <span>recipe instance <code class="iid" id="iid">${safeId}</code></span>
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
    term.open(document.getElementById('term'));
    fit.fit();

    const statusEl = document.getElementById('status');
    const killBtn = document.getElementById('killBtn');

    const wsUrl = new URL(\`/terminal/\${instanceId}/ws\`, location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl.toString());

    ws.onopen = () => {
      statusEl.textContent = 'attached';
      // Fit ONCE to the actual rendered xterm size, then lock. We don't
      // re-fit on window resize because the pty's scrollback (and any
      // currently-on-screen TUI like a CLI's command palette) was painted
      // using ANSI column positioning at the old cols. Re-fitting reflows
      // those columns onto a different viewport width and the boxes /
      // multi-column layouts misalign. Lock-after-attach gives a stable,
      // predictable view; the browser viewport can grow or shrink freely
      // (overflow handles the rest) without poisoning the visible buffer.
      fit.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Intentionally no resize listener. The pty + xterm cols/rows are locked
    // at attach time. If the browser viewport changes, the xterm DOM keeps
    // its locked pixel dimensions and overflow:auto on the container scrolls.
    // See the comment above ws.onopen for the rationale.

    killBtn.addEventListener('click', () => {
      if (ws.readyState === WebSocket.OPEN) {
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

async function attachWebsocket(ws: WebSocket, instanceId: string): Promise<void> {
  // T19: tmux-attach path. If the instance is a tmux-backed agent in our
  // registry, spawn a per-viewer `tmux attach` IPty. xterm.js capability
  // replies go INTO tmux (a TUI client) and never reach the agent — this is
  // the structural fix for the viewer-input race.
  const tmuxSession = tmuxSessionRegistry.get(instanceId);
  if (tmuxSession) {
    attachWebsocketViaTmux(ws, instanceId, tmuxSession.name);
    return;
  }

  // Not in tmuxSessionRegistry — could be a foreign tmux session OR a leftover
  // clawdevbox-spawned tmux session that survived a kernel restart (cdb_<id>
  // name still alive in tmux). In either case, if a tmux session with the
  // exact instance_id name exists, attach to it. Uses the cached tmux list
  // (1s TTL) so back-to-back WS attaches don't fork a child each.
  if (!hasSession(instanceId) && await tmuxSessionExists(instanceId)) {
    attachWebsocketViaTmux(ws, instanceId, instanceId);
    return;
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
 */
function attachWebsocketViaTmux(
  ws: WebSocket,
  instanceId: string,
  tmuxSessionName: string,
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
  console.log('[tmux-attach]', JSON.stringify({ bin: tmuxBin, args, cwd: process.cwd() }));

  let ipty: ReturnType<typeof ptySpawn>;
  try {
    ipty = ptySpawn(tmuxBin, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        content: `[clawdevbox] failed to attach tmux viewer: ${(err as Error).message}\r\n`,
        cols: 120, rows: 30, exited: true, exitCode: 1,
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

  ipty.onData((chunk) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'data', chunk })); } catch { /* viewer drop */ }
  });
  ipty.onExit(({ exitCode }) => {
    if (closed) return;
    try { ws.send(JSON.stringify({ type: 'exit', exitCode: exitCode ?? 0 })); } catch {}
    try { ws.close(1000, 'tmux attach exited'); } catch {}
  });

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
      const cols = m.cols as number;
      const rows = m.rows as number;
      // psmux on Windows: the SIGWINCH path through `ipty.resize` tells tmux
      // attach that the viewport is cols×rows, but aggressive-resize subtracts
      // 1 row from the reported size when it propagates to the pane.  Pass
      // rows+1 to ipty so the pane ends up at the rows the browser expects.
      try { ipty.resize(cols, rows + 1); } catch { /* attach dead */ }
      // Explicit resize-window / resize-pane as belt-and-suspenders for psmux
      // (aggressive-resize alone doesn't update the pane on Windows).
      tmuxResizePane(tmuxBin, tmuxSocket, tmuxSessionName, cols, rows);
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
