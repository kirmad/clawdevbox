/**
 * home-page.ts
 *
 * Thin loader for the Vue + PrimeVue SPA built from `web/`.
 *
 * Production layout (`npm run build`):
 *   <package>/dist/cli.js
 *   <package>/dist/web/index.html        ← what we serve at GET /
 *   <package>/dist/web/assets/*.{js,css,svg,…}
 *
 * Dev layout (running via tsx without a Vite build):
 *   We fall back to a minimal HTML stub telling the developer to run
 *   `npm --prefix web run dev` so they don't get a blank page.
 *
 * The server injects `window.__CLAWDEVBOX__` (mcpUrl + projectDir) into
 * the HTML so the SPA can read these values synchronously on boot.
 *
 * The artifact viewer at `/artifact/<id>` is NOT served here — it lives
 * in terminal-server.ts and stays untouched (the Vue SPA opens artifacts
 * inside `<iframe src="/artifact/<id>">` tabs so the renderer contract
 * is preserved).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the built SPA `index.html`, in order:
 *   1. `<dist>/web/index.html` — production layout when running from
 *      the bundled `dist/cli.js`.
 *   2. `<repo>/web/dist/index.html` — when running `tsx src/cli/index.ts`
 *      during development, after `npm --prefix web run build` ran once.
 *   3. `<repo>/mcp-server/web/dist/index.html` — same as (2) but when
 *      the CLI runs from a parent directory.
 */
const SPA_INDEX_CANDIDATES = [
  resolve(here, 'web', 'index.html'),
  resolve(here, '..', 'web', 'dist', 'index.html'),
  resolve(here, '..', '..', 'web', 'dist', 'index.html'),
];

/**
 * Resolve a built SPA asset path (`/assets/foo-abc.js` → absolute file
 * path). Returns null when the file doesn't exist or is outside the SPA
 * build directory (path-escape guard).
 */
export function resolveSpaAsset(urlPath: string): string | null {
  // Strip the leading slash and any query/fragment.
  const cleaned = urlPath.replace(/^\/+/, '').split('?')[0]!.split('#')[0]!;
  if (cleaned.length === 0) return null;
  for (const indexPath of SPA_INDEX_CANDIDATES) {
    if (!existsSync(indexPath)) continue;
    const webRoot = dirname(indexPath);
    const candidate = resolve(webRoot, cleaned);
    if (!candidate.startsWith(webRoot)) return null; // path escape
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function renderHomePage(opts: { mcpUrl: string; projectDir: string }): string {
  for (const indexPath of SPA_INDEX_CANDIDATES) {
    if (!existsSync(indexPath)) continue;
    const html = readFileSync(indexPath, 'utf8');
    return injectBootstrap(html, opts);
  }
  return fallbackHtml(opts);
}

function injectBootstrap(html: string, opts: { mcpUrl: string; projectDir: string }): string {
  const bootstrap =
    `<script>window.__CLAWDEVBOX__=${JSON.stringify({
      mcpUrl: opts.mcpUrl,
      projectDir: opts.projectDir,
    }).replace(/</g, '\\u003c')};</script>`;
  // Place the bootstrap as the first child of <head> so it executes before
  // any Vite-emitted module scripts try to read it.
  return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${bootstrap}`);
}

function fallbackHtml(opts: { mcpUrl: string; projectDir: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>clawdevbox</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #14161b; color: #d8dee9; margin: 0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 32px;
  }
  main { max-width: 560px; }
  h1 { color: #88c0d0; margin-top: 0; font-size: 18px; }
  code { background: #20232c; color: #eceff4; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  p { color: #c0c5ce; }
</style>
</head>
<body>
  <main>
    <h1>clawdevbox — SPA not built</h1>
    <p>The Vue + PrimeVue UI hasn't been built yet. From <code>mcp-server/</code> run:</p>
    <pre><code>npm --prefix web ci
npm --prefix web run build
npm run build</code></pre>
    <p>Or run the SPA in dev mode (with Vite hot reload) on port 5173:</p>
    <pre><code>npm --prefix web run dev</code></pre>
    <p>Project: <code>${escapeHtml(opts.projectDir)}</code></p>
    <p>MCP:     <code>${escapeHtml(opts.mcpUrl)}</code></p>
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
