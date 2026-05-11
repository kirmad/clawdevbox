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

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
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
} from './pty-registry.ts';
import { resolveRendererFile } from './renderer-registry.ts';
import type { Workspace } from './workspace.ts';
import { listWorkspaces, resolveWorkspacesRoot } from './workspaces-store.ts';

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
} = {}): Promise<TerminalServerHandle> {
  if (httpServer) {
    throw new Error('terminal server already running');
  }

  activeWorkspace = opts.workspace ?? null;
  boundHost = opts.host ?? '127.0.0.1';
  const desiredPort =
    opts.port ?? Number.parseInt(process.env.CONDUCTOR_TERMINAL_PORT ?? '0', 10);

  httpServer = createServer((req, res) => handleHttpRequest(req, res));
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
      attachWebsocket(ws, instanceId);
    });
  });

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

  activeHandle = {
    url: (instanceId: string) =>
      `http://${boundHost}:${boundPort}/terminal/${encodeURIComponent(instanceId)}`,
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderTerminalHtml(instanceId));
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

/** Locate an artifact across every registered workspace. */
function findArtifact(id: string): FoundArtifact | null {
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
    <b>Conductor</b>
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
      window.__conductorArtifact = { id, type, manifest, files: filesList };
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

function renderTerminalHtml(instanceId: string): string {
  const safeId = instanceId.replace(/[^A-Za-z0-9_-]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Conductor recipe terminal · ${safeId}</title>
  <link rel="stylesheet" href="https://esm.sh/@xterm/xterm@5.5.0/css/xterm.css" />
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 8px 12px; font-size: 12px; background: #2d2d30; border-bottom: 1px solid #3e3e42; display: flex; gap: 12px; align-items: center; }
    header b { color: #fff; }
    header .status { padding: 2px 8px; border-radius: 4px; background: #0e639c; font-size: 11px; }
    header .status.exited { background: #6e6e6e; }
    header button { background: #f14c4c; color: #fff; border: 0; padding: 4px 10px; font-size: 11px; border-radius: 3px; cursor: pointer; margin-left: auto; }
    header button:disabled { background: #6e6e6e; cursor: not-allowed; }
    #term { flex: 1; padding: 4px; min-height: 0; overflow: auto; }
    .xterm, .xterm-viewport { background: #1e1e1e !important; }
  </style>
</head>
<body>
  <header>
    <b>Conductor</b>
    <span>recipe instance <code id="iid">${safeId}</code></span>
    <span class="status" id="status">connecting…</span>
    <button id="killBtn" title="SIGTERM the pty">Kill</button>
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
      // currently-on-screen TUI like agency's command palette) was painted
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

    window.__conductorTerm = term;
  </script>
</body>
</html>`;
}

// ============================================================================
// WS handler
// ============================================================================

function attachWebsocket(ws: WebSocket, instanceId: string): void {
  if (!hasSession(instanceId)) {
    try {
      ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }));
    } catch { /* ignore */ }
    try { ws.close(1011, 'unknown instance'); } catch { /* ignore */ }
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
