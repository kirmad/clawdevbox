// server.mjs — standalone spike server for artifact-comments.
//
// Three responsibilities:
//   1. Serve static files (index.html, viewer.html, *.mjs, sample-artifact.md)
//   2. Implement the generic JSON+blob document store HTTP API exactly as it
//      will ship in mcp-server/src/json-doc-store.ts.
//   3. Echo "session.send" calls to stdout so we can see what the agent would
//      receive.
//
// No dependencies. Pure node:* APIs.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, unlink, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_ROOT = resolvePath(HERE, '.store');
const PORT = Number(process.env.PORT ?? 7777);

const ID_RE = /^(?!\.)[A-Za-z0-9._-]{1,128}(?<!\.)$/;  // no leading/trailing dot, no /
function isValidId(s) {
  return ID_RE.test(s) && !s.includes('..');
}
const MAX_JSON = 256 * 1024;                       // 256 KB per JSON doc
const MAX_BLOB = 4 * 1024 * 1024;                  // 4 MB per binary

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

const EXT_FOR_TYPE = {
  'application/json':   'json',
  'image/png':          'png',
  'image/jpeg':         'jpg',
  'image/svg+xml':      'svg',
  'text/plain':         'txt',
};

// --------------------------------------------------------------------------
// Generic JSON+blob document store
// --------------------------------------------------------------------------

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

function collectionDir(collection) {
  return join(STORE_ROOT, collection);
}

function pathsFor(collection, id, ext) {
  const dir = collectionDir(collection);
  return {
    dir,
    body: join(dir, `${id}.${ext}`),
    meta: join(dir, `${id}.meta.json`),
  };
}

async function readMeta(metaPath) {
  try {
    const raw = await readFile(metaPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function findExisting(collection, id) {
  // Look for any <id>.* file with a sibling .meta.json
  try {
    const files = await readdir(collectionDir(collection));
    const meta = files.find(f => f === `${id}.meta.json`);
    if (!meta) return null;
    const m = await readMeta(join(collectionDir(collection), meta));
    if (!m) return null;
    const ext = EXT_FOR_TYPE[m.content_type] ?? 'bin';
    return { ...pathsFor(collection, id, ext), meta: m };
  } catch {
    return null;
  }
}

async function storeGet(collection, id) {
  const existing = await findExisting(collection, id);
  if (!existing) return null;
  const body = await readFile(existing.body);
  return { body, contentType: existing.meta.content_type, etag: `"sha1:${existing.meta.sha1}"` };
}

async function storePut(collection, id, body, contentType, ifMatch) {
  if (!isValidId(collection) || !isValidId(id)) {
    return { error: 400, msg: 'invalid collection or id' };
  }
  const ext = EXT_FOR_TYPE[contentType] ?? 'bin';
  const cap = contentType === 'application/json' ? MAX_JSON : MAX_BLOB;
  if (body.length > cap) return { error: 413, msg: `body exceeds ${cap}B cap` };

  // If JSON, sanity-check it parses
  if (contentType === 'application/json') {
    try { JSON.parse(body.toString('utf8')); }
    catch (e) { return { error: 400, msg: 'invalid JSON: ' + e.message }; }
  }

  const existing = await findExisting(collection, id);
  if (ifMatch && existing && `"sha1:${existing.meta.sha1}"` !== ifMatch) {
    return { error: 412, msg: 'etag mismatch' };
  }

  // If a previous version exists with a *different* extension, delete it
  if (existing && !existing.body.endsWith(`.${ext}`)) {
    await unlink(existing.body).catch(() => {});
  }

  const { dir, body: bodyPath, meta: metaPath } = pathsFor(collection, id, ext);
  await ensureDir(dir);

  const sha1 = sha1Hex(body);
  const now = new Date().toISOString();
  const meta = {
    content_type: contentType,
    sha1,
    size: body.length,
    created_at: existing?.meta.created_at ?? now,
    updated_at: now,
  };

  // Atomic write via tmp + rename
  const tmpBody = bodyPath + '.tmp.' + process.pid;
  const tmpMeta = metaPath + '.tmp.' + process.pid;
  await writeFile(tmpBody, body);
  await writeFile(tmpMeta, JSON.stringify(meta, null, 2));
  await rename(tmpBody, bodyPath);
  await rename(tmpMeta, metaPath);

  return { etag: `"sha1:${sha1}"` };
}

async function storeDelete(collection, id) {
  const existing = await findExisting(collection, id);
  if (!existing) return false;
  await unlink(existing.body).catch(() => {});
  await unlink(existing.meta_path ?? join(collectionDir(collection), `${id}.meta.json`)).catch(() => {});
  return true;
}

async function storeList(collection) {
  if (!isValidId(collection)) return null;
  try {
    const files = await readdir(collectionDir(collection));
    const ids = files
      .filter(f => f.endsWith('.meta.json'))
      .map(f => f.slice(0, -'.meta.json'.length))
      .sort();
    return ids;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// --------------------------------------------------------------------------
// HTTP server
// --------------------------------------------------------------------------

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > cap + 1024) {
        reject(Object.assign(new Error('payload too large'), { httpCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, {
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buf);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });
}

async function handleStore(req, res, segments) {
  // /api/store/:collection            (GET → ids)
  // /api/store/:collection/:id        (GET/PUT/DELETE)
  if (segments.length === 1) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const ids = await storeList(segments[0]);
    if (ids === null) return json(res, 400, { error: 'invalid collection' });
    return json(res, 200, { ids });
  }
  if (segments.length !== 2) return json(res, 404, { error: 'not found' });

  const [collection, id] = segments;
  if (!isValidId(collection) || !isValidId(id)) {
    return json(res, 400, { error: 'invalid collection or id' });
  }

  if (req.method === 'GET') {
    const got = await storeGet(collection, id);
    if (!got) return json(res, 404, { error: 'not found' });
    return send(res, 200, got.body, { 'Content-Type': got.contentType, 'ETag': got.etag });
  }
  if (req.method === 'PUT') {
    const contentType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
    const cap = contentType === 'application/json' ? MAX_JSON : MAX_BLOB;
    let body;
    try { body = await readBody(req, cap); }
    catch (e) { return json(res, e.httpCode ?? 400, { error: e.message }); }
    const ifMatch = req.headers['if-match'];
    const result = await storePut(collection, id, body, contentType, ifMatch);
    if (result.error) return json(res, result.error, { error: result.msg });
    return send(res, 204, '', { 'ETag': result.etag });
  }
  if (req.method === 'DELETE') {
    const ok = await storeDelete(collection, id);
    return send(res, ok ? 204 : 404, '');
  }
  return json(res, 405, { error: 'method not allowed' });
}

async function handleSessionSend(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const body = await readBody(req, 1024 * 1024);
  const payload = JSON.parse(body.toString('utf8'));

  console.log('\n\x1b[36m═══ session.send (faked) ═══\x1b[0m');
  console.log('\x1b[2martifactId:\x1b[0m ' + payload.artifactId);
  console.log('\x1b[2mdraftCount:\x1b[0m ' + payload.draftCount);
  console.log('\x1b[2m── markdown body ──\x1b[0m');
  console.log(payload.markdown);
  console.log('\x1b[36m═══════════════════════════\x1b[0m\n');

  return json(res, 200, { ok: true, deliveredAt: new Date().toISOString() });
}

async function handleStatic(req, res, urlPath) {
  // Default
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // Whitelist: only files in HERE, no traversal
  const filePath = resolvePath(HERE, '.' + urlPath);
  if (!filePath.startsWith(HERE)) return json(res, 403, { error: 'forbidden' });
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return json(res, 404, { error: 'not found' });
    const ext = extname(filePath).toLowerCase();
    const buf = await readFile(filePath);
    return send(res, 200, buf, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  } catch {
    return json(res, 404, { error: 'not found: ' + urlPath });
  }
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;

    if (path.startsWith('/api/store/')) {
      return handleStore(req, res, path.slice('/api/store/'.length).split('/').filter(Boolean));
    }
    if (path === '/api/session-send') {
      return handleSessionSend(req, res);
    }
    return handleStatic(req, res, path);
  } catch (err) {
    console.error('server error:', err);
    if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
  }
});

await ensureDir(STORE_ROOT);
server.listen(PORT, () => {
  console.log(`\nSpike listening on http://localhost:${PORT}`);
  console.log(`Store root: ${STORE_ROOT}`);
  console.log(`Open the URL in a browser. Press Ctrl+C to stop.\n`);
});
