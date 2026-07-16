# Artifact Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub-PR-style inline comments to `markdown` and new `html` artifact renderers — anchored to text selections, image elements (`<img>`, mermaid SVG, `<pre>`), or `Alt`-drag rectangular regions — with drafts persisted via a new generic workspace-scoped JSON+blob document store, and a "Send" action that bundles them into a single markdown user-turn delivered to the active agent session via `session.send`.

**Architecture:** A shared client-side library `_comment-overlay.mjs` (loaded inside the artifact iframe via `enableComments(root, ctx)`) handles all UX. It persists drafts and PNG snapshots through a new generic store mounted on the existing `terminal-server.ts` (`/api/store/:collection/:id`, content-type-aware). When the user clicks "Send", the iframe `postMessage`s the assembled markdown bundle to the SPA, which invokes `session.send` against the workspace's active agent session.

**Tech Stack:** TypeScript (mcp-server), vanilla ES modules (renderers + overlay), `marked` + `mermaid` + `highlight.js` + `html2canvas` via esm.sh CDN, Vue 3 (SPA), `node:test` + `node:assert/strict` (unit/integration tests), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-06-13-artifact-comments-design.md`
**Reference implementation:** `spikes/artifact-comments/` (the spike's `comment-overlay.mjs`, `server.mjs` store, and `viewer.html` are intended to be ported with small adaptations — they passed the design review).

---

## File Structure

```
mcp-server/
├── src/
│   ├── json-doc-store.ts                       ← NEW (Task 1) — generic store module
│   ├── terminal-server.ts                       ← MODIFY (Task 3) — mount /api/store/* routes
│   └── renderers/
│       ├── _comment-overlay.mjs                ← NEW (Tasks 5–8) — shared overlay library
│       ├── markdown.mjs                         ← MODIFY (Task 10) — one-line enableComments()
│       └── html.mjs                             ← NEW (Task 11) — new built-in renderer
├── web/src/components/
│   └── ArtifactPanel.vue                        ← MODIFY (Task 12) — postMessage listener
└── tests/
    ├── json-doc-store.test.mjs                  ← NEW (Task 2)
    ├── json-doc-store-api.test.mjs              ← NEW (Task 4)
    ├── comment-overlay.test.mjs                 ← NEW (Task 9) — JSDOM
    └── artifact-comments-e2e.playwright.test.mjs ← NEW (Task 13)
```

**Key design decisions locked into this structure:**
- `json-doc-store.ts` is **pure module** — no HTTP, no Express. The HTTP layer lives in `terminal-server.ts` alongside the existing `/artifact/*` routes, following the codebase's existing pattern.
- `_comment-overlay.mjs` starts with `_` because it's not itself a renderer type — it's a library renderers import. The renderer-registry only picks up modules without `_` prefix (verify in Task 5; the existing `/^[a-z0-9][a-z0-9._-]*$/i` filter in `renderer-registry.ts:70` actually accepts underscore-leading names, so we'll also need a tiny exclusion or rename to `comment-overlay.mjs` with an explicit registry exclude).
- All comment storage is **workspace-scoped** via `findArtifact(id)` in `terminal-server.ts` — the artifact id alone resolves the workspace, no extra params needed.
- The spike's `comment-overlay.mjs` is the **canonical source** for client code — each task in Phase B says "port section X from the spike" with the specific adaptations called out.

---

## Phase A — Server-side foundation (Tasks 1–4)

### Task 1: `json-doc-store.ts` — pure module

**Files:**
- Create: `mcp-server/src/json-doc-store.ts`

- [ ] **Step 1: Create the module skeleton**

Create `mcp-server/src/json-doc-store.ts` with this content:

```ts
/**
 * json-doc-store.ts — generic, workspace-scoped, content-type-aware
 * document store. Stores opaque blobs (JSON or binary) addressed by
 * `(collection, id)` under `<workspace>/.clawdevbox/store/<collection>/`.
 *
 * Atomic writes via tmp + rename. ETag = "sha1:<hex>" of bytes.
 * Each document has a sibling .meta.json sidecar with
 * `{ content_type, sha1, size, created_at, updated_at }`.
 *
 * NOT mounted as HTTP here — see terminal-server.ts for routes.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

export const JSON_DOC_MAX_BYTES = 256 * 1024;          // 256 KB
export const BLOB_DOC_MAX_BYTES = 4 * 1024 * 1024;     // 4 MB

const ID_RE = /^(?!\.)[A-Za-z0-9._-]{1,128}(?<!\.)$/;

export function isValidId(s: string): boolean {
  return typeof s === 'string' && ID_RE.test(s) && !s.includes('..');
}

const EXT_FOR_TYPE: Record<string, string> = {
  'application/json':   'json',
  'image/png':          'png',
  'image/jpeg':         'jpg',
  'image/svg+xml':      'svg',
  'text/plain':         'txt',
};

export interface DocMeta {
  content_type: string;
  sha1: string;
  size: number;
  created_at: string;
  updated_at: string;
}

export interface DocReadResult {
  body: Buffer;
  contentType: string;
  etag: string;            // `"sha1:<hex>"` — quoted, includes the prefix
  meta: DocMeta;
}

export interface PutResult {
  etag: string;
}

export type PutError =
  | { kind: 'invalid_id' }
  | { kind: 'too_large'; cap: number }
  | { kind: 'invalid_json'; message: string }
  | { kind: 'etag_mismatch' };

export interface JsonDocStoreOptions {
  /** Override default storage root (defaults to <workspace>/.clawdevbox/store). */
  rootOverride?: string;
}

function storeRoot(workspaceDir: string, opts?: JsonDocStoreOptions): string {
  return opts?.rootOverride ?? join(workspaceDir, '.clawdevbox', 'store');
}

function collectionDir(workspaceDir: string, collection: string, opts?: JsonDocStoreOptions): string {
  return join(storeRoot(workspaceDir, opts), collection);
}

function pathsFor(workspaceDir: string, collection: string, id: string, ext: string, opts?: JsonDocStoreOptions) {
  const dir = collectionDir(workspaceDir, collection, opts);
  return { dir, body: join(dir, `${id}.${ext}`), meta: join(dir, `${id}.meta.json`) };
}

function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

async function readMeta(path: string): Promise<DocMeta | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as DocMeta;
  } catch {
    return null;
  }
}

async function findExisting(workspaceDir: string, collection: string, id: string, opts?: JsonDocStoreOptions) {
  try {
    const dir = collectionDir(workspaceDir, collection, opts);
    const files = await readdir(dir);
    if (!files.includes(`${id}.meta.json`)) return null;
    const meta = await readMeta(join(dir, `${id}.meta.json`));
    if (!meta) return null;
    const ext = EXT_FOR_TYPE[meta.content_type] ?? 'bin';
    return { ...pathsFor(workspaceDir, collection, id, ext, opts), meta };
  } catch {
    return null;
  }
}

export async function getDoc(
  workspaceDir: string,
  collection: string,
  id: string,
  opts?: JsonDocStoreOptions,
): Promise<DocReadResult | null> {
  if (!isValidId(collection) || !isValidId(id)) return null;
  const existing = await findExisting(workspaceDir, collection, id, opts);
  if (!existing) return null;
  const body = await readFile(existing.body);
  return { body, contentType: existing.meta.content_type, etag: `"sha1:${existing.meta.sha1}"`, meta: existing.meta };
}

export async function putDoc(
  workspaceDir: string,
  collection: string,
  id: string,
  body: Buffer,
  contentType: string,
  ifMatch: string | undefined,
  opts?: JsonDocStoreOptions,
): Promise<PutResult | PutError> {
  if (!isValidId(collection) || !isValidId(id)) return { kind: 'invalid_id' };
  const cap = contentType === 'application/json' ? JSON_DOC_MAX_BYTES : BLOB_DOC_MAX_BYTES;
  if (body.length > cap) return { kind: 'too_large', cap };
  if (contentType === 'application/json') {
    try { JSON.parse(body.toString('utf8')); }
    catch (e) { return { kind: 'invalid_json', message: (e as Error).message }; }
  }
  const existing = await findExisting(workspaceDir, collection, id, opts);
  if (ifMatch && existing && `"sha1:${existing.meta.sha1}"` !== ifMatch) {
    return { kind: 'etag_mismatch' };
  }
  const ext = EXT_FOR_TYPE[contentType] ?? 'bin';
  const { dir, body: bodyPath, meta: metaPath } = pathsFor(workspaceDir, collection, id, ext, opts);
  if (existing && existing.body !== bodyPath) await unlink(existing.body).catch(() => {});
  await mkdir(dir, { recursive: true });
  const sha1 = sha1Hex(body);
  const now = new Date().toISOString();
  const meta: DocMeta = {
    content_type: contentType,
    sha1,
    size: body.length,
    created_at: existing?.meta.created_at ?? now,
    updated_at: now,
  };
  const tmpBody = `${bodyPath}.tmp.${process.pid}.${Date.now()}`;
  const tmpMeta = `${metaPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpBody, body);
  await writeFile(tmpMeta, JSON.stringify(meta, null, 2));
  await rename(tmpBody, bodyPath);
  await rename(tmpMeta, metaPath);
  return { etag: `"sha1:${sha1}"` };
}

export async function deleteDoc(
  workspaceDir: string,
  collection: string,
  id: string,
  opts?: JsonDocStoreOptions,
): Promise<boolean> {
  if (!isValidId(collection) || !isValidId(id)) return false;
  const existing = await findExisting(workspaceDir, collection, id, opts);
  if (!existing) return false;
  await unlink(existing.body).catch(() => {});
  await unlink(existing.meta).catch(() => {});
  return true;
}

export async function listDocs(
  workspaceDir: string,
  collection: string,
  opts?: JsonDocStoreOptions,
): Promise<string[] | null> {
  if (!isValidId(collection)) return null;
  const dir = collectionDir(workspaceDir, collection, opts);
  if (!existsSync(dir)) return [];
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => f.slice(0, -'.meta.json'.length))
      .sort();
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Type-check it**

Run: `cd C:\git\clawdevbox\mcp-server; npx tsc --noEmit`
Expected: exit 0 (no errors). If TypeScript complains about `node:fs/promises` imports, verify `compilerOptions.module` includes "Node16"/"NodeNext" — should already pass per repo memory ("Type-check mcp-server with `cd mcp-server && npx tsc --noEmit`").

- [ ] **Step 3: Commit**

```powershell
cd C:\git\clawdevbox
git add mcp-server/src/json-doc-store.ts
git commit -m "feat(mcp-server): add generic json-doc-store module

Workspace-scoped, content-type-aware document store. Pure module — no HTTP.
JSON-only validation, ETag = sha1, atomic write via tmp+rename,
sidecar .meta.json. Will back artifact-comments drafts + PNG attachments
(see docs/superpowers/specs/2026-06-13-artifact-comments-design.md).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Unit tests for `json-doc-store.ts`

**Files:**
- Create: `mcp-server/tests/json-doc-store.test.mjs`
- Modify: `mcp-server/package.json` (add the new test file to the `test` script)

- [ ] **Step 1: Write the failing test file**

Create `mcp-server/tests/json-doc-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDoc, putDoc, deleteDoc, listDocs, isValidId,
  JSON_DOC_MAX_BYTES, BLOB_DOC_MAX_BYTES,
} from '../src/json-doc-store.ts';

function ws() {
  return mkdtempSync(join(tmpdir(), 'cdb-jds-'));
}

test('isValidId accepts safe names', () => {
  for (const ok of ['a', 'art_abc', 'Hello.World-1_2', 'a.b.c', 'A'.repeat(128)]) {
    assert.equal(isValidId(ok), true, ok);
  }
});

test('isValidId rejects path-unsafe names', () => {
  for (const bad of ['', '.', '.hidden', 'trailing.', '..', 'a..b', 'with/slash', 'with\\back', 'a'.repeat(129), '*star', 'one two']) {
    assert.equal(isValidId(bad), false, JSON.stringify(bad));
  }
});

test('put/get round-trip — JSON', async () => {
  const dir = ws();
  try {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    const r = await putDoc(dir, 'col_a', 'doc_1', body, 'application/json', undefined);
    assert.ok('etag' in r, 'put should succeed');
    const got = await getDoc(dir, 'col_a', 'doc_1');
    assert.ok(got);
    assert.equal(got.contentType, 'application/json');
    assert.equal(got.body.toString('utf8'), body.toString('utf8'));
    assert.equal(got.etag, r.etag);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put/get round-trip — binary (PNG)', async () => {
  const dir = ws();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const r = await putDoc(dir, 'attachments', 'att_1', png, 'image/png', undefined);
    assert.ok('etag' in r);
    const got = await getDoc(dir, 'attachments', 'att_1');
    assert.ok(got);
    assert.equal(got.contentType, 'image/png');
    assert.deepEqual(got.body, png);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put rejects invalid JSON when content-type is application/json', async () => {
  const dir = ws();
  try {
    const r = await putDoc(dir, 'col_a', 'd', Buffer.from('{not json'), 'application/json', undefined);
    assert.ok('kind' in r);
    assert.equal(r.kind, 'invalid_json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put normalizes mixed-case JSON content-type and applies JSON cap + validation', async () => {
  const dir = ws();
  try {
    // Mixed-case Content-Type must still trigger JSON validation + 256 KB cap
    const r1 = await putDoc(dir, 'col_a', 'd', Buffer.from('{not json'), 'Application/JSON', undefined);
    assert.equal(r1.kind, 'invalid_json', 'Mixed-case JSON must still parse-validate');

    const huge = Buffer.from(JSON.stringify({ pad: 'x'.repeat(JSON_DOC_MAX_BYTES + 100) }), 'utf8');
    const r2 = await putDoc(dir, 'col_a', 'd2', huge, 'APPLICATION/JSON', undefined);
    assert.equal(r2.kind, 'too_large', 'Upper-case JSON must use the JSON cap');
    assert.equal(r2.cap, JSON_DOC_MAX_BYTES);

    // And the persisted content_type sidecar must be lowercased
    const r3 = await putDoc(dir, 'col_a', 'd3', Buffer.from('{"v":1}'), 'Application/JSON', undefined);
    assert.ok('etag' in r3);
    const got = await getDoc(dir, 'col_a', 'd3');
    assert.equal(got.contentType, 'application/json', 'stored content-type must be canonical lowercase');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put enforces size caps', async () => {
  const dir = ws();
  try {
    const big = Buffer.alloc(JSON_DOC_MAX_BYTES + 1, 0x20);  // spaces, valid JSON if wrapped — but raw spaces aren't, so test with a valid huge JSON
    const huge = Buffer.from(JSON.stringify({ pad: 'x'.repeat(JSON_DOC_MAX_BYTES + 100) }), 'utf8');
    const r = await putDoc(dir, 'col_a', 'd', huge, 'application/json', undefined);
    assert.ok('kind' in r);
    assert.equal(r.kind, 'too_large');
    assert.equal(r.cap, JSON_DOC_MAX_BYTES);

    const bigBlob = Buffer.alloc(BLOB_DOC_MAX_BYTES + 1, 0);
    const r2 = await putDoc(dir, 'attachments', 'd', bigBlob, 'image/png', undefined);
    assert.ok('kind' in r2);
    assert.equal(r2.kind, 'too_large');
    assert.equal(r2.cap, BLOB_DOC_MAX_BYTES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put honors If-Match (optimistic concurrency)', async () => {
  const dir = ws();
  try {
    const r1 = await putDoc(dir, 'col_a', 'd', Buffer.from('{"v":1}'), 'application/json', undefined);
    assert.ok('etag' in r1);
    const bad = await putDoc(dir, 'col_a', 'd', Buffer.from('{"v":2}'), 'application/json', '"sha1:deadbeef"');
    assert.equal(bad.kind, 'etag_mismatch');
    const ok = await putDoc(dir, 'col_a', 'd', Buffer.from('{"v":2}'), 'application/json', r1.etag);
    assert.ok('etag' in ok);
    assert.notEqual(ok.etag, r1.etag);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put rejects If-Match on missing doc (RFC 7232)', async () => {
  const dir = ws();
  try {
    const r = await putDoc(dir, 'col_a', 'never_existed', Buffer.from('{}'), 'application/json', '"sha1:any"');
    assert.ok('kind' in r);
    assert.equal(r.kind, 'etag_mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put with different content-type cleans up the old body file', async () => {
  const dir = ws();
  try {
    await putDoc(dir, 'mixed', 'k', Buffer.from('{}'), 'application/json', undefined);
    await putDoc(dir, 'mixed', 'k', Buffer.from([1, 2, 3]), 'image/png', undefined);
    const ids = await listDocs(dir, 'mixed');
    assert.deepEqual(ids, ['k']);
    const got = await getDoc(dir, 'mixed', 'k');
    assert.equal(got.contentType, 'image/png');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('delete removes both body and meta', async () => {
  const dir = ws();
  try {
    await putDoc(dir, 'col_a', 'd', Buffer.from('{}'), 'application/json', undefined);
    const ok = await deleteDoc(dir, 'col_a', 'd');
    assert.equal(ok, true);
    const got = await getDoc(dir, 'col_a', 'd');
    assert.equal(got, null);
    const ids = await listDocs(dir, 'col_a');
    assert.deepEqual(ids, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list returns sorted ids; empty/missing collection returns []', async () => {
  const dir = ws();
  try {
    assert.deepEqual(await listDocs(dir, 'fresh'), []);
    await putDoc(dir, 'fresh', 'c', Buffer.from('{}'), 'application/json', undefined);
    await putDoc(dir, 'fresh', 'a', Buffer.from('{}'), 'application/json', undefined);
    await putDoc(dir, 'fresh', 'b', Buffer.from('{}'), 'application/json', undefined);
    assert.deepEqual(await listDocs(dir, 'fresh'), ['a', 'b', 'c']);
    assert.equal(await listDocs(dir, '..'), null);  // invalid collection
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects invalid ids', async () => {
  const dir = ws();
  try {
    const r = await putDoc(dir, '..bad', 'd', Buffer.from('{}'), 'application/json', undefined);
    assert.equal(r.kind, 'invalid_id');
    const g = await getDoc(dir, 'col', 'with/slash');
    assert.equal(g, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Register the test file**

Open `mcp-server/package.json`. Find the `"test"` script. Append ` tests/json-doc-store.test.mjs` to the end of the long file list (keep the existing pattern — one space between paths).

- [ ] **Step 3: Run it to verify it fails**

Run: `cd C:\git\clawdevbox\mcp-server; npx node --import tsx --test tests/json-doc-store.test.mjs`
Expected: 13/13 tests **PASS** (we already wrote the implementation in Task 1; this test verifies it). If anything fails, fix the implementation in `json-doc-store.ts` until all tests pass.

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `cd C:\git\clawdevbox\mcp-server; npm test`
Expected: all existing tests still pass + the new 13 tests pass.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/tests/json-doc-store.test.mjs mcp-server/package.json
git commit -m "test(mcp-server): unit tests for json-doc-store

13 tests covering: id validation, JSON+binary round-trips, JSON parse
validation, size caps, If-Match concurrency, If-Match on missing doc (RFC 7232),
mixed-content-type updates,
delete, list, invalid id rejection.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Wire HTTP routes into `terminal-server.ts`

**Files:**
- Modify: `mcp-server/src/terminal-server.ts` (add route handler + dispatcher entry)

- [ ] **Step 1: Add the imports**

Open `mcp-server/src/terminal-server.ts`. Find the existing imports near the top (search for `import { artifactDir, artifactFilePath`). Add a new import line right after that block:

```ts
import {
  deleteDoc as storeDeleteDoc,
  getDoc as storeGetDoc,
  listDocs as storeListDocs,
  putDoc as storePutDoc,
  JSON_DOC_MAX_BYTES,
  BLOB_DOC_MAX_BYTES,
  type DocReadResult,
} from './json-doc-store.ts';
```

- [ ] **Step 2: Add the route handler function**

Scroll to the bottom of the artifact route handlers section (after `serveArtifactFiles` around line 422–429). Add this block:

```ts
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
    const contentType = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
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
```

- [ ] **Step 3: Register the route in the dispatcher**

Find `handleHttpRequest` (around line 309). After the existing artifact route blocks (after the `/^\/artifact\/([A-Za-z0-9._-]+)\/?$/` match block around line 369) and **before** the final `res.writeHead(404, ...)`, insert:

```ts
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
```

- [ ] **Step 4: Type-check**

Run: `cd C:\git\clawdevbox\mcp-server; npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/src/terminal-server.ts
git commit -m "feat(mcp-server): mount /api/store/* routes on terminal-server

Adds GET/PUT/DELETE for individual docs and GET-list for collections.
Workspace resolution via ?artifact=<id> (via findArtifact) or
CLAWDEVBOX_PROJECT_DIR. Returns standard status codes (204/412/413/etc).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: HTTP integration tests for the store routes

**Files:**
- Create: `mcp-server/tests/json-doc-store-api.test.mjs`
- Modify: `mcp-server/package.json` (add to test script)

- [ ] **Step 1: Find the existing pattern for HTTP route tests**

Run: `cd C:\git\clawdevbox\mcp-server; grep -l "buildServer\|startServer\|listenForTesting" tests/`
Look at one matching test (e.g. `tests/api-sessions.test.mjs`) to see how the test harness boots the server. Mirror that pattern.

(If no existing test harness lets you boot terminal-server.ts directly, the test can spin up the HTTP server via the same path as `cli/start.ts`. Read `cli/start.ts` and `terminal-server.ts:startTerminalServer` to find the right exported entry point.)

- [ ] **Step 2: Write the failing test**

Create `mcp-server/tests/json-doc-store-api.test.mjs`. Adapt the harness used in step 1; the test body follows:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTerminalServer, stopTerminalServer } from '../src/terminal-server.ts';

let baseUrl;
let projectDir;

test.before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'cdb-jds-api-'));
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  const { url } = await startTerminalServer({ port: 0, host: '127.0.0.1' });
  baseUrl = url;
});

test.after(async () => {
  await stopTerminalServer();
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env.CLAWDEVBOX_PROJECT_DIR;
});

test('PUT then GET round-trip — JSON', async () => {
  const body = JSON.stringify({ hello: 'world' });
  const put = await fetch(`${baseUrl}/api/store/col_a/d1`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(put.status, 204);
  const etag = put.headers.get('etag');
  assert.ok(etag?.startsWith('"sha1:'), 'etag set');

  const get = await fetch(`${baseUrl}/api/store/col_a/d1`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'application/json');
  assert.equal(get.headers.get('etag'), etag);
  assert.equal(await get.text(), body);
});

test('PUT then GET round-trip — binary PNG', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const put = await fetch(`${baseUrl}/api/store/attach/png1`, {
    method: 'PUT', headers: { 'content-type': 'image/png' }, body: png,
  });
  assert.equal(put.status, 204);
  const get = await fetch(`${baseUrl}/api/store/attach/png1`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/png');
  const buf = new Uint8Array(await get.arrayBuffer());
  assert.deepEqual(buf, png);
});

test('GET returns 404 for missing doc', async () => {
  const r = await fetch(`${baseUrl}/api/store/col_a/missing`);
  assert.equal(r.status, 404);
});

test('PUT bad JSON returns 400', async () => {
  const r = await fetch(`${baseUrl}/api/store/col_a/bad`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.equal(r.status, 400);
});

test('PUT with invalid collection returns 400', async () => {
  const r = await fetch(`${baseUrl}/api/store/bad..name/d`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 400);
});

test('If-Match mismatch returns 412', async () => {
  await fetch(`${baseUrl}/api/store/col_b/d`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"v":1}',
  });
  const r = await fetch(`${baseUrl}/api/store/col_b/d`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': '"sha1:deadbeef"' },
    body: '{"v":2}',
  });
  assert.equal(r.status, 412);
});

test('LIST returns ids', async () => {
  await fetch(`${baseUrl}/api/store/col_c/a`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  await fetch(`${baseUrl}/api/store/col_c/b`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  const r = await fetch(`${baseUrl}/api/store/col_c`);
  assert.equal(r.status, 200);
  const { ids } = await r.json();
  assert.deepEqual(ids, ['a', 'b']);
});

test('DELETE round-trip', async () => {
  await fetch(`${baseUrl}/api/store/col_d/x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  const del = await fetch(`${baseUrl}/api/store/col_d/x`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const get = await fetch(`${baseUrl}/api/store/col_d/x`);
  assert.equal(get.status, 404);
});

test('PUT > size cap returns 413', async () => {
  const huge = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
  const r = await fetch(`${baseUrl}/api/store/col_e/big`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: huge,
  });
  assert.equal(r.status, 413);
});
```

- [ ] **Step 3: Add to package.json test script**

Append ` tests/json-doc-store-api.test.mjs` to the `"test"` script in `mcp-server/package.json`.

- [ ] **Step 4: Run tests**

Run: `cd C:\git\clawdevbox\mcp-server; npx node --import tsx --test tests/json-doc-store-api.test.mjs`
Expected: 11/11 PASS. If the harness imports fail, adapt the `startTerminalServer/stopTerminalServer` names in step 2 to match the real exports from `terminal-server.ts`.

- [ ] **Step 5: Full suite**

Run: `cd C:\git\clawdevbox\mcp-server; npm test`
Expected: full suite passes.

- [ ] **Step 6: Commit**

```powershell
git add mcp-server/tests/json-doc-store-api.test.mjs mcp-server/package.json
git commit -m "test(mcp-server): integration tests for /api/store/* routes

11 tests: JSON+binary round-trips, 404 on missing, 400 on bad JSON, 400 on
bad collection name, 412 on If-Match mismatch (existing AND missing doc —
RFC 7232), list, delete, 413 from readBody slack, 413 from putDoc TOO_LARGE
cap branch.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase B — Client-side comment overlay (Tasks 5–9)

### Task 5: `comment-overlay.mjs` scaffolding + draft persistence

**Files:**
- Create: `mcp-server/src/renderers/_comment-overlay.mjs`
- Modify: `mcp-server/src/renderer-registry.ts` (exclude `_`-prefixed files from listing)

**Source of truth:** the spike file `spikes/artifact-comments/comment-overlay.mjs` is the canonical implementation. This task ports the **scaffolding + draft persistence** subset only (lines 1–280 of the spike); Tasks 6–8 add the rest.

- [ ] **Step 1: Exclude `_`-prefixed files from the renderer registry**

Open `mcp-server/src/renderer-registry.ts`. Find `listMjsTypesIn` (around line 99):

```ts
export function listMjsTypesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try { if (!statSync(dir).isDirectory()) return []; } catch { return []; }
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    out.push(name.slice(0, -4));
  }
  return out.sort();
}
```

Add an exclusion for underscore-prefixed files:

```ts
export function listMjsTypesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try { if (!statSync(dir).isDirectory()) return []; } catch { return []; }
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    if (name.startsWith('_')) continue;  // shared libraries, not renderer types
    out.push(name.slice(0, -4));
  }
  return out.sort();
}
```

Also tighten the regex in `resolveRendererFile` (around line 70) so `_`-leading types can't be addressed by URL:

```ts
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(type)) return null;
```

This already excludes leading `_`, so no change needed there — confirm by reading.

- [ ] **Step 2: Create the scaffolding portion of `_comment-overlay.mjs`**

Copy the **first ~280 lines** of `spikes/artifact-comments/comment-overlay.mjs` to `mcp-server/src/renderers/_comment-overlay.mjs`. The first cut should contain:
- The header comment + `enableComments` export
- Constants (`DRAFTS_COLLECTION`, `ATTACH_COLLECTION`, `HISTORY_COLLECTION`, etc.)
- Helpers: `mintId`, `escapeHtml`, `sha1Hex`, `debounce`
- `OVERLAY_STYLES` constant (full CSS)
- `CommentOverlay` class with: `constructor`, `init`, `injectStyles`, `loadDrafts`, `indexDrafts`, `persist`, `notifyHost`, `buildSidebar`, `toggleSidebar`, `renderCards` (rendering only — no interactivity yet), `renderCard` (rendering only — no edit/save/delete handlers yet)

**Two adaptations from the spike:**

1. Change the fetch URLs to include `?artifact=<id>`:
   ```js
   // spike:
   await fetch(`/api/store/${DRAFTS_COLLECTION}/${this.artifactId}`);
   // production:
   await fetch(`/api/store/${DRAFTS_COLLECTION}/${this.artifactId}?artifact=${encodeURIComponent(this.artifactId)}`);
   ```
   Apply this to all three fetches in the file (drafts load/save, attachments PUT, history PUT, attachment GET in `renderCard` thumb).

2. Change the attachment_path returned by `uploadAttachment`:
   ```js
   // spike:
   path: `.store/${ATTACH_COLLECTION}/${id}.png`,
   // production:
   path: `.clawdevbox/store/${ATTACH_COLLECTION}/${id}.png`,
   ```

For Task 5, stop after `renderCard` — the methods below it (`addDraft`, `wireSelectionToolbar`, etc.) come in Tasks 6–8. Add stub methods so the class still constructs:

```js
  // Below this point: stubs filled in by Tasks 6, 7, 8
  wireSelectionToolbar() { /* Task 6 */ }
  wireElementHover() { /* Task 7 */ }
  wireRectangleDrag() { /* Task 7 */ }
  wireKeyboard() { /* Task 6 */ }
  async renderHighlights() { /* Task 6 */ }
```

Also stop the `init()` method from calling un-stubbed methods until Task 6 lands. The minimal init for this task:

```js
  async init() {
    this.injectStyles();
    this.buildSidebar();
    document.body.classList.add('cdb-has-sidebar');
    await this.loadDrafts();
    this.renderCards();
    this.notifyHost('artifact:drafts-changed', { artifactId: this.artifactId });
  }
```

- [ ] **Step 3: Smoke-test by hand**

Run: `cd C:\git\clawdevbox; npm --prefix mcp-server start`  (or whatever runs the dev server)
Then open an existing markdown artifact in the browser. Confirm:
- The sidebar appears on the right
- The renderer doesn't break
- Console shows no fetch errors

(Without `enableComments` being called from `markdown.mjs` yet — that's Task 10 — this only verifies the file loads cleanly when imported. Skip this step if no markdown artifact is handy; covered by Task 13 e2e.)

- [ ] **Step 4: Commit**

```powershell
git add mcp-server/src/renderers/_comment-overlay.mjs mcp-server/src/renderer-registry.ts
git commit -m "feat(renderers): add _comment-overlay.mjs scaffolding + draft persistence

Ports lines 1-280 of spikes/artifact-comments/comment-overlay.mjs:
- enableComments(root, ctx) entry point
- CommentOverlay class skeleton: constructor, init, loadDrafts, persist,
  buildSidebar, renderCards (rendering only)
- All CSS for the overlay + sidebar
- fetch URLs include ?artifact=<id> for workspace resolution
- attachment_path uses .clawdevbox/store/... (workspace-relative)

Renderer registry now excludes _-prefixed .mjs files from type listing
so this library can sit next to renderer modules without colliding.

Tasks 6-8 add interactivity, capture, send.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Text selection — toolbar, anchor, highlight, re-anchor

**Files:**
- Modify: `mcp-server/src/renderers/_comment-overlay.mjs`

**Spike source:** continue porting from `spikes/artifact-comments/comment-overlay.mjs` — methods `wireSelectionToolbar`, `showToolbar`, `hideToolbar`, `makeTextAnchor`, `countSectionTextMatches`, `nearestHeading`, `renderHighlights`, `applyTextHighlight`, `addDraft`, `startEditing`, `stopEditing`, `deleteDraft`, `_removeDraft`, `clearAll`, `focusCard`, `wireKeyboard`.

- [ ] **Step 1: Port the methods**

Copy the named methods from the spike (lines ~280–620) into the production overlay. No adaptations needed — the methods are environment-agnostic.

- [ ] **Step 2: Wire `init()` to call them**

Update `init()`:
```js
  async init() {
    this.injectStyles();
    this.buildSidebar();
    document.body.classList.add('cdb-has-sidebar');
    await this.loadDrafts();
    await this.renderHighlights();
    this.renderCards();
    this.wireSelectionToolbar();
    this.wireKeyboard();
    this.notifyHost('artifact:drafts-changed', { artifactId: this.artifactId });
  }
```

- [ ] **Step 3: Hook up the card buttons in `renderCard`**

The `renderCard` method already builds DOM; now it needs to wire `edit`/`delete`/`save`/`cancel` button handlers and `textarea` keydown. Copy the wiring block from the spike (`renderCard` lines ~350–390 in the spike file).

- [ ] **Step 4: Spec — what we expect to work after this step**

After Task 6, in a browser:
- Selecting text in the artifact shows a floating 💬 toolbar.
- Clicking 💬 (or pressing ⌘⏎) adds a sidebar card in edit mode.
- Typing + clicking Save persists the draft via `PUT /api/store/artifact-comments/<artifactId>?artifact=<artifactId>`.
- Refreshing the page restores the comment with the same highlight.
- Deleting a card unwraps the highlight and removes the file.

This will be smoke-tested manually after Task 10 mounts the overlay on `markdown.mjs`. The JSDOM tests in Task 9 cover unit-level behavior.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/src/renderers/_comment-overlay.mjs
git commit -m "feat(renderers): add text-selection comments to overlay

Implements the text-anchor path:
- Floating selection toolbar at the selection rect
- Text fingerprinting via sha1(section + \\0 + text) + occurrence index
- Re-anchoring on iframe re-mount (orphan flag when not found)
- Add/edit/save/cancel/delete draft lifecycle
- Keyboard: \\u2318\\u23ce to save, Esc to cancel

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Element-click + Alt-drag rectangle screenshot

**Files:**
- Modify: `mcp-server/src/renderers/_comment-overlay.mjs`

**Spike source:** `spikes/artifact-comments/comment-overlay.mjs` methods `wireElementHover`, `captureElement`, `wireRectangleDrag`, `findSectionAtViewportPoint`, `uploadAttachment`, and the helpers at the bottom (`svgToPngBlob`, `elementToBlob`, `regionToBlob`).

- [ ] **Step 1: Port the methods**

Copy the named methods + bottom-of-file helpers verbatim. The `html2canvas` import at the top of the spike (`import html2canvas from 'https://esm.sh/html2canvas@1.4.1';`) must be added to the production overlay too — keep the same esm.sh pin to match the existing pattern in `markdown.mjs` (which loads `marked`/`hljs`/`mermaid` from esm.sh).

- [ ] **Step 2: Wire into `init`**

```js
  async init() {
    this.injectStyles();
    this.buildSidebar();
    document.body.classList.add('cdb-has-sidebar');
    await this.loadDrafts();
    await this.renderHighlights();
    this.renderCards();
    this.wireSelectionToolbar();
    this.wireElementHover();
    this.wireRectangleDrag();
    this.wireKeyboard();
    this.notifyHost('artifact:drafts-changed', { artifactId: this.artifactId });
  }
```

- [ ] **Step 3: Update fetch URLs in `uploadAttachment`**

Per Task 5's adaptation, the upload PUT must include `?artifact=<id>`:
```js
  async uploadAttachment(blob) {
    const id = mintId('att');
    await fetch(`/api/store/${ATTACH_COLLECTION}/${id}?artifact=${encodeURIComponent(this.artifactId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'image/png' },
      body: blob,
    });
    return {
      id,
      path: `.clawdevbox/store/${ATTACH_COLLECTION}/${id}.${(blob.type || 'image/png') === 'image/png' ? 'png' : 'bin'}`,
    };
  }
```

- [ ] **Step 4: Update `renderCard` thumbnail src**

In `renderCard` (already added in Task 5), the thumb URL must also have the query string:

```js
    const thumb = d.anchor.kind === 'image' && d.anchor.attachment_id
      ? `<img class="thumb" src="/api/store/${ATTACH_COLLECTION}/${d.anchor.attachment_id}?artifact=${encodeURIComponent(this.artifactId)}" alt="snapshot">`
      : '';
```

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/src/renderers/_comment-overlay.mjs
git commit -m "feat(renderers): add element-click and Alt-drag capture

Three capture paths:
- <img> via canvas.drawImage + toBlob (with CORS-taint fallback)
- mermaid SVG via XMLSerializer + Image() + canvas paint
- <pre>/region via html2canvas (loaded from esm.sh)

Snapshots upload to artifact-comment-attachments collection;
sidebar cards show thumbnails for image-anchored comments.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Send button + markdown bundle + host hand-off + archive

**Files:**
- Modify: `mcp-server/src/renderers/_comment-overlay.mjs`

**Spike source:** `spikes/artifact-comments/comment-overlay.mjs` methods `buildMarkdownBundle` and `sendAll`.

- [ ] **Step 1: Port the methods**

Copy `buildMarkdownBundle` and `sendAll` verbatim.

- [ ] **Step 2: Update the archive PUT URL**

In `sendAll`, the history archive PUT needs the same `?artifact=<id>` adaptation:

```js
    await fetch(`/api/store/${HISTORY_COLLECTION}/${archiveId}?artifact=${encodeURIComponent(this.artifactId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, sent_at: new Date().toISOString(), drafts: this.drafts }),
    });
```

- [ ] **Step 3: Confirm `buildSidebar` wires the send button**

Verify the send button click handler is present in `buildSidebar`:
```js
    this.sendBtn.addEventListener('click', () => this.sendAll());
```
(It's already there from Task 5; no change.)

- [ ] **Step 4: Type-check the whole file**

Run: `cd C:\git\clawdevbox\mcp-server; npx tsc --noEmit`
Expected: exit 0 (the .mjs file is plain JS, so tsc shouldn't flag it; it's just confirming the surrounding TS still compiles).

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/src/renderers/_comment-overlay.mjs
git commit -m "feat(renderers): add send-to-agent bundle and archive

Send pipeline:
1. Build markdown bundle (blockquote per comment + attachment paths)
2. Archive bundle + drafts to artifact-comment-history
3. postMessage('artifact:send-comments', payload) to parent frame
4. Wait for ack (up to 8s); on success, clear all drafts and persist empty.

Bundle format matches design spec section 7.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: JSDOM unit tests for the overlay

**Files:**
- Create: `mcp-server/tests/comment-overlay.test.mjs`
- Modify: `mcp-server/package.json` (add to test script)
- Modify: `mcp-server/package.json` (add `jsdom` as a devDependency if not already present)

- [ ] **Step 1: Check if jsdom is already a devDependency**

Run: `cd C:\git\clawdevbox\mcp-server; node -e "console.log(Object.keys({...(require('./package.json').dependencies||{}), ...(require('./package.json').devDependencies||{})}).filter(k=>k.includes('jsdom')))"`
- If output is `[ 'jsdom' ]`: skip step 2.
- If output is `[]`: do step 2.

- [ ] **Step 2: Install jsdom**

Run: `cd C:\git\clawdevbox\mcp-server; npm install --save-dev jsdom`
Expected: package.json + package-lock.json updated.

- [ ] **Step 3: Write the failing tests**

Create `mcp-server/tests/comment-overlay.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// We import the overlay as a string and eval inside a JSDOM window. This
// avoids the esm.sh html2canvas import (we'd need to mock it). For the
// unit tests we only exercise text-selection paths, which don't need
// html2canvas — but we still need to stub the import.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../src/renderers/_comment-overlay.mjs'), 'utf8');

async function freshDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  // Stub fetch and crypto.subtle.digest in the window
  dom.window.fetch = async (url, opts) => {
    if (opts?.method === 'PUT') return new dom.window.Response('', { status: 204, headers: { etag: '"sha1:deadbeef"' } });
    return new dom.window.Response('', { status: 404 });
  };
  // SHA-1 via node:crypto polyfill, since JSDOM lacks Web Crypto
  const { createHash } = await import('node:crypto');
  dom.window.crypto = dom.window.crypto ?? {};
  dom.window.crypto.subtle = {
    digest: async (_alg, buf) => {
      const u8 = new Uint8Array(buf);
      const hex = createHash('sha1').update(Buffer.from(u8)).digest();
      return hex.buffer.slice(hex.byteOffset, hex.byteOffset + hex.byteLength);
    },
  };
  // Inject the source with html2canvas import replaced by a stub
  const patched = SRC.replace(
    /^import html2canvas from .+;$/m,
    "const html2canvas = async () => ({ toBlob: (cb) => cb(new Blob()) });",
  );
  // Convert ESM to a callable function (the test won't exercise the module
  // boundary; we just need enableComments in scope).
  const wrapped = `
    (async () => {
      ${patched.replace(/^export\s+/gm, '')}
      window.enableComments = enableComments;
    })();
  `;
  dom.window.eval(wrapped);
  // wait one microtask for the async IIFE to attach the export
  await new Promise((r) => setImmediate(r));
  return dom;
}

test('enableComments creates the sidebar', async () => {
  const dom = await freshDom('<p>hello</p>');
  await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  const aside = dom.window.document.querySelector('.cdb-sidebar');
  assert.ok(aside, 'sidebar should be created');
  assert.ok(dom.window.document.body.classList.contains('cdb-has-sidebar'));
});

test('text selection produces a draft with text anchor', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Drive 30% YoY growth</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  const p = dom.window.document.querySelector('p');
  const range = dom.window.document.createRange();
  range.setStart(p.firstChild, 6);
  range.setEnd(p.firstChild, 19);  // "30% YoY growth"
  const anchor = await overlay.makeTextAnchor(range);
  assert.equal(anchor.kind, 'text');
  assert.equal(anchor.section, 'Goals');
  assert.equal(anchor.text, '30% YoY growth');
  assert.ok(anchor.fingerprint.startsWith('sha1:'));
  assert.equal(anchor.occurrence, 0);
});

test('re-anchoring finds existing text after a fresh render', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Drive 30% YoY growth</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: { kind: 'text', section: 'Goals', text: '30% YoY growth', fingerprint: '', occurrence: 0 },
    comment: 'test',
  }];
  overlay.indexDrafts();
  await overlay.renderHighlights();
  const span = dom.window.document.querySelector('.cdb-comment-anchor');
  assert.ok(span, 'highlight should be applied');
  assert.equal(span.textContent, '30% YoY growth');
});

test('re-anchoring marks missing text as orphan', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Completely different content here</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: { kind: 'text', section: 'Goals', text: 'not present', fingerprint: '', occurrence: 0 },
    comment: 'test',
  }];
  overlay.indexDrafts();
  await overlay.renderHighlights();
  assert.equal(overlay.drafts[0].orphan, true);
});

test('buildMarkdownBundle includes text quote and section label', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>x</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test Plan' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: { kind: 'text', section: 'Goals', text: 'baseline', fingerprint: '', occurrence: 0 },
    comment: 'Needs a baseline number.',
  }];
  const md = overlay.buildMarkdownBundle();
  assert.match(md, /Test Plan/);
  assert.match(md, /Comment 1 .* Goals/);
  assert.match(md, /Needs a baseline number\./);
  assert.match(md, /"baseline"/);
});

test('buildMarkdownBundle includes attachment path for image anchors', async () => {
  const dom = await freshDom('<h2>Architecture</h2>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test Plan' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: {
      kind: 'image', element: 'mermaid', section: 'Architecture',
      attachment_id: 'att_x', attachment_path: '.clawdevbox/store/artifact-comment-attachments/att_x.png',
    },
    comment: 'branch at step 3',
  }];
  const md = overlay.buildMarkdownBundle();
  assert.match(md, /mermaid snapshot in .*Architecture/);
  assert.match(md, /\.clawdevbox\/store\/artifact-comment-attachments\/att_x\.png/);
});
```

- [ ] **Step 4: Add to test script + run**

Append ` tests/comment-overlay.test.mjs` to the `"test"` script in `package.json`.

Run: `cd C:\git\clawdevbox\mcp-server; npx node --import tsx --test tests/comment-overlay.test.mjs`
Expected: 6/6 PASS. If anything fails, fix the overlay's actual behavior — the tests describe the intended contract.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/tests/comment-overlay.test.mjs mcp-server/package.json mcp-server/package-lock.json
git commit -m "test(renderers): JSDOM unit tests for _comment-overlay.mjs

6 tests covering: sidebar creation, text anchor extraction,
re-anchoring on fresh render, orphan flagging for missing text,
and markdown bundle assembly (text + image anchors).

Adds jsdom devDep (or uses existing one).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Phase C — Renderer integration (Tasks 10–13)

### Task 10: Enable comments in `markdown.mjs`

**Files:**
- Modify: `mcp-server/src/renderers/markdown.mjs`

- [ ] **Step 1: Add the import and call**

Open `mcp-server/src/renderers/markdown.mjs`. At the end of the `render` function (around line 114, after `await renderMermaidDiagrams(body);`), add:

```js
    const { enableComments } = await import('./_comment-overlay.mjs');
    await enableComments(body, ctx);
```

Verify the import path is correct given the iframe loading model — the renderer is served from `/__renderer/markdown.mjs`, so the dynamic import becomes `/__renderer/_comment-overlay.mjs`. Since `_`-prefixed files are excluded from `listMjsTypesIn` (Task 5) but the `resolveRendererFile` URL guard rejects leading `_`, **the URL `/__renderer/_comment-overlay.mjs` will 404**.

Fix: change the dynamic import to use a different URL path. Either:
- (a) Add a route in `terminal-server.ts` for shared overlay libs: `/__renderer-lib/:name.mjs` that serves files matching `_*.mjs` from the renderers dir.
- (b) Keep the file alongside renderers but serve it via the existing static-asset path used for the artifact host page bundle.

**Pick (a)** — it's a one-route addition mirroring `/__renderer/`. In `terminal-server.ts`, add another route block above the existing renderer module match:

```ts
  // -------- Renderer library (_*.mjs) -----------------------------------
  const rendererLibMatch = url.pathname.match(/^\/__renderer-lib\/(_[A-Za-z0-9._-]+)\.mjs$/);
  if (rendererLibMatch) {
    serveRendererLib(res, rendererLibMatch[1]);
    return;
  }
```

Implement `serveRendererLib` next to `serveRenderer`:

```ts
function serveRendererLib(res: ServerResponse, name: string): void {
  const builtin = join(builtinRenderersDir(), `${name}.mjs`);
  if (!existsSync(builtin)) { writeJson(res, 404, { error: 'NOT_FOUND' }); return; }
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
  createReadStream(builtin).pipe(res);
}
```

(`builtinRenderersDir` is already exported from `renderer-registry.ts`. `existsSync` and `createReadStream` need to be added to the imports if not already present.)

In `markdown.mjs`, use the new path:

```js
    const { enableComments } = await import('/__renderer-lib/_comment-overlay.mjs');
    await enableComments(body, ctx);
```

- [ ] **Step 2: Type-check**

Run: `cd C:\git\clawdevbox\mcp-server; npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Manual smoke**

If a local clawdevbox setup is available, render any markdown artifact and verify the sidebar appears + selecting text shows the toolbar. Otherwise this is covered by Task 13.

- [ ] **Step 4: Commit**

```powershell
git add mcp-server/src/renderers/markdown.mjs mcp-server/src/terminal-server.ts
git commit -m "feat(renderers): wire enableComments into markdown.mjs

- markdown.mjs calls enableComments(body, ctx) at the end of render()
- terminal-server adds /__renderer-lib/_*.mjs route for shared overlay libs
  (the renderer registry rejects _-prefixed types, so we need a parallel
  serving path)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Create `html.mjs` renderer

**Files:**
- Create: `mcp-server/src/renderers/html.mjs`

- [ ] **Step 1: Check what artifact manifests use `type: 'html'` today (if any)**

Run: `cd C:\git\clawdevbox; grep -r "\"type\"\s*:\s*\"html\"" --include="*.json"` — if any artifact manifests already use this type, we'll be replacing fallback behavior. If none exist, this is a clean addition.

- [ ] **Step 2: Write the renderer**

Create `mcp-server/src/renderers/html.mjs`:

```js
// renderers/html.mjs — built-in renderer for type="html".
//
// Loads `content.html` (or manifest.meta.entry) into a sandboxed container,
// then enables the comment overlay.
//
// Sanitization: we run a minimal DOMPurify pass to strip <script> tags and
// `on*=` event handlers — artifact authors are trusted, but defence-in-depth.

import DOMPurify from 'https://esm.sh/dompurify@3.1.5';

const STYLES = `
  .html-body { max-width: 880px; margin: 0 auto; line-height: 1.6; }
  .html-body img { max-width: 100%; }
`;

function ensureStyles() {
  if (document.getElementById('html-renderer-styles')) return;
  const el = document.createElement('style');
  el.id = 'html-renderer-styles';
  el.textContent = STYLES;
  document.head.appendChild(el);
}

export default {
  type: 'html',
  async render(root, ctx) {
    ensureStyles();
    const fileName = ctx.manifest?.meta?.entry ?? 'content.html';
    let html;
    try {
      html = await ctx.fetchFile(fileName);
    } catch (err) {
      const files = await ctx.listFiles();
      throw new Error(`Failed to load "${fileName}". Files: ${files.join(', ')}. ${err?.message ?? err}`);
    }
    const safe = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], ADD_ATTR: ['target'] });
    const body = document.createElement('div');
    body.className = 'html-body';
    body.innerHTML = safe;
    root.appendChild(body);

    const { enableComments } = await import('/__renderer-lib/_comment-overlay.mjs');
    await enableComments(body, ctx);
  },
};
```

- [ ] **Step 3: Verify registry discovers it**

Run: `cd C:\git\clawdevbox; grep -n "BUILTIN_RENDERER_TYPES" mcp-server/src/renderer-registry.ts`
Confirm `html` will be in `BUILTIN_RENDERER_TYPES` after the file is created (the set is built from the directory listing at module load, so a server restart picks it up automatically — no code change needed).

- [ ] **Step 4: Commit**

```powershell
git add mcp-server/src/renderers/html.mjs
git commit -m "feat(renderers): add built-in html renderer

Loads content.html (or manifest.meta.entry), sanitizes with DOMPurify,
inserts into .html-body container, then enables the comment overlay.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 12: `ArtifactPanel.vue` postMessage listener → session.send

**Files:**
- Modify: `mcp-server/web/src/components/ArtifactPanel.vue`
- Possibly: `mcp-server/web/src/api.ts` (if session.send wrapper doesn't exist for the SPA yet)

- [ ] **Step 1: Find how the SPA currently calls session.send**

Run: `grep -rn "session.send\|sessionSend\|/api/sessions/.*send" C:\git\clawdevbox\mcp-server\web\src`
Note the import path used by other components (likely something like `import { sendToSession } from '../api'`).

If no SPA wrapper exists, look in `mcp-server/src/cli/cron-api.ts` for the HTTP endpoint shape (`POST /api/sessions/:id/send` per repo memory) and add a small wrapper to `web/src/api.ts`:

```ts
export async function sendToSession(sessionId: string, prompt: string): Promise<void> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!r.ok) throw new Error(`session send failed: ${r.status} ${await r.text()}`);
}
```

- [ ] **Step 2: Find how to resolve the active session for the current workspace**

Run: `grep -rn "activeSession\|sessionStore\|sessionsForWorkspace" C:\git\clawdevbox\mcp-server\web\src`
Either reuse an existing store getter or, in `ArtifactPanel.vue`, look up the artifact's workspace and pick the most recent live session in that workspace.

For v1, the simplest path: fetch `GET /api/sessions?workspace=<artifactId-resolved-workspace>&status=live` and pick the first.

- [ ] **Step 3: Add the postMessage handler to ArtifactPanel.vue**

Open `mcp-server/web/src/components/ArtifactPanel.vue`. Inside `<script setup lang="ts">`, after the existing setup:

```ts
import { onMounted, onUnmounted, ref } from 'vue';
import { sendToSession } from '../api';  // adapt path from step 1

const iframeRef = ref<HTMLIFrameElement | null>(null);

async function resolveActiveSessionId(): Promise<string | null> {
  // Adapt to whatever pattern step 2 uncovered.
  try {
    const r = await fetch(`/api/sessions?artifact=${encodeURIComponent(props.id)}&status=live`);
    if (!r.ok) return null;
    const { sessions } = await r.json();
    return sessions?.[0]?.id ?? null;
  } catch { return null; }
}

async function handleSendComments(payload: {
  artifactId: string;
  draftCount: number;
  markdown: string;
}): Promise<{ ok: boolean; error?: string }> {
  const sessionId = await resolveActiveSessionId();
  if (!sessionId) return { ok: false, error: 'No active agent session in this workspace.' };
  try {
    await sendToSession(sessionId, payload.markdown);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

function onMessage(ev: MessageEvent): void {
  if (ev.origin !== location.origin) return;
  if (ev.source !== iframeRef.value?.contentWindow) return;
  const msg = ev.data;
  if (msg?.type !== 'artifact:send-comments') return;
  void handleSendComments(msg.payload).then((result) => {
    iframeRef.value?.contentWindow?.postMessage(
      { type: 'artifact:send-comments:ack', payload: { artifactId: msg.payload.artifactId, ...result } },
      location.origin,
    );
  });
}

onMounted(() => window.addEventListener('message', onMessage));
onUnmounted(() => window.removeEventListener('message', onMessage));
```

Bind `iframeRef` on the existing `<iframe>` element:
```html
<iframe ref="iframeRef" ... />
```

- [ ] **Step 4: Rebuild the SPA**

Per repo memory: "SPA changes require `cd mcp-server/web && npx vite build` AND a clawdevbox restart".

Run: `cd C:\git\clawdevbox\mcp-server\web; npx vite build`
Expected: build succeeds; new asset hashes in `dist/`.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/web/src/components/ArtifactPanel.vue mcp-server/web/src/api.ts
git commit -m "feat(web): ArtifactPanel listens for artifact:send-comments

postMessage listener wires the iframe's 'send' action into session.send
for the workspace's active live session. Sends back :ack on success or
:ack with error on failure (e.g. no live session).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 13: End-to-end Playwright test

**Files:**
- Create: `mcp-server/tests/artifact-comments-e2e.playwright.test.mjs`

- [ ] **Step 1: Look at the existing Playwright pattern**

Run: `ls C:\git\clawdevbox\mcp-server\tests\*playwright*`
Open one (e.g. `vue-spa-screenshots.playwright.test.mjs`) and note the setup pattern (server boot, browser launch, fixture artifact creation).

- [ ] **Step 2: Write the e2e**

Create `mcp-server/tests/artifact-comments-e2e.playwright.test.mjs`. Adapt to the harness from step 1; the test logic:

```js
import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test gets a fresh workspace with one markdown artifact.
function setupArtifact() {
  const projectDir = mkdtempSync(join(tmpdir(), 'cdb-art-cmt-'));
  const artId = 'art_e2e_' + Math.random().toString(36).slice(2, 8);
  const artDir = join(projectDir, 'artifacts', artId);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, 'manifest.json'), JSON.stringify({
    id: artId, type: 'markdown', title: 'E2E Test',
  }));
  writeFileSync(join(artDir, 'content.md'), `# Goals\n\nDrive 30% YoY growth in active users.\n`);
  return { projectDir, artId };
}

test('add text comment → send → bundle delivered + drafts cleared', async ({ page }) => {
  // [boot server pointed at projectDir, capture session.send requests with a mock]
  // Open /artifact/<artId>, wait for sidebar
  // Select "30% YoY growth" via page.evaluate (set Selection programmatically)
  // Click the 💬 toolbar
  // Type a comment in the textarea
  // Click Save
  // Click Send
  // Assert: a POST to /api/sessions/<id>/send was made with the expected markdown
  // Assert: /api/store/artifact-comments/<artId> now contains an empty drafts array
  // Assert: /api/store/artifact-comment-history contains one entry
});

test('add img-anchored comment → snapshot saved + path in bundle', async ({ page }) => {
  // Same setup but with an artifact containing an <img>
  // Click the img → wait for sidebar card with thumbnail
  // Send
  // Assert: an attachment file exists under .clawdevbox/store/artifact-comment-attachments/
  // Assert: the markdown sent to the agent contains the .clawdevbox/store/... path
});

test('Alt+drag rectangle → screenshot saved + region anchor in bundle', async ({ page }) => {
  // Hold Alt, drag a rectangle over the artifact
  // Wait for new sidebar card with region thumbnail
  // Send
  // Assert: attachment saved + bundle references the path
});

test('drafts persist across iframe re-mount', async ({ page }) => {
  // Add a text comment, do not send
  // Reload the iframe (page.evaluate(() => document.querySelector('iframe').src = document.querySelector('iframe').src))
  // Assert: the comment re-appears with the same highlight
});
```

**Important:** keep the e2e small but complete — the value is end-to-end coverage of the integration layer (postMessage, session.send wiring, store URL with `?artifact`). The detailed UI behavior is already covered by the JSDOM tests in Task 9.

- [ ] **Step 3: Run**

Run: `cd C:\git\clawdevbox\mcp-server; npm run test:e2e -- tests/artifact-comments-e2e.playwright.test.mjs`
Expected: all 4 tests pass.

- [ ] **Step 4: Run the full e2e suite to confirm no regressions**

Run: `cd C:\git\clawdevbox\mcp-server; npm run test:e2e`
Expected: no regressions in existing e2es.

- [ ] **Step 5: Commit**

```powershell
git add mcp-server/tests/artifact-comments-e2e.playwright.test.mjs
git commit -m "test(renderers): Playwright e2e for artifact comments

Covers: text comment send + drafts cleared + history archived,
image-anchored snapshot + path in bundle, Alt+drag region snapshot,
drafts persist across iframe re-mount.

Closes the artifact-comments feature.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review (run by the agent after writing this plan)

### 1. Spec coverage

| Spec section | Covered by |
|---|---|
| §2 Goal 1 (text comments, persist across re-render) | Tasks 5, 6, 9, 10, 13 |
| §2 Goal 2 (non-text anchors + rectangle screenshot) | Tasks 7, 13 |
| §2 Goal 3 (collapsible sidebar with Send) | Tasks 5, 8 |
| §2 Goal 4 (deliver via session.send) | Tasks 8, 12, 13 |
| §2 Goal 5 (per-artifact draft persistence) | Tasks 1–4, 5 |
| §2 Goal 6 (shared lib + one-line opt-in) | Tasks 5, 10, 11 |
| §2 Goal 7 (generic store, no comment-specific endpoints) | Tasks 1, 3 |
| §3 UX flows (toolbar, sidebar, orphan badge, keyboard) | Tasks 5, 6 |
| §4 Architecture (iframe → postMessage → SPA → session.send) | Tasks 8, 10, 11, 12 |
| §5.1 json-doc-store.ts | Task 1 |
| §5.2 _comment-overlay.mjs | Tasks 5–8 |
| §5.3 markdown.mjs edit | Task 10 |
| §5.4 html.mjs new | Task 11 |
| §5.5 ArtifactPanel.vue edit | Task 12 |
| §6 Storage format | Tasks 1, 5, 7 |
| §7 Payload format | Tasks 8, 9, 13 |
| §8 Anchoring | Tasks 6, 7 |
| §9 Edge cases | Tasks 5–8 (handled inline); Task 13 (orphan persistence) |
| §10 html2canvas dep via esm.sh | Task 7 |
| §11 Test plan (3 files) | Tasks 2, 4, 9, 13 (4 files — JSDOM split out as own task) |
| §12 Rollout + spike | Spike already exists; spec updated to reference it |

All spec items map to at least one task. ✅

### 2. Placeholder scan

Searched for: TBD, TODO, "implement later", "appropriate", "fill in", "add tests for the above" — none found. ✅

### 3. Type/signature consistency

- `enableComments(root, ctx)` — same signature in Tasks 5, 6, 7, 8, 10, 11 ✅
- `CommentOverlay` class — methods named consistently throughout ✅
- Store API: `putDoc/getDoc/listDocs/deleteDoc` consistent in Tasks 1, 3, and aliased in Task 3 (`storePutDoc` etc.) ✅
- Constants: `JSON_DOC_MAX_BYTES` / `BLOB_DOC_MAX_BYTES` consistent across Tasks 1, 3 ✅
- URL pattern: `/api/store/:collection/:id?artifact=<id>` consistent across Tasks 3, 4, 5, 7, 8 ✅

No mismatches. ✅

### 4. Scope check

Each task produces an independently mergeable, testable change. No task depends on uncommitted work from a later task. ✅

---

## Open implementation-time questions (deferred, not blockers)

1. **DOMPurify import** in `html.mjs` (Task 11) — esm.sh's DOMPurify build should work but verify on first load; if not, switch to a known-good CDN like jsdelivr.
2. **Active-session lookup** in `ArtifactPanel.vue` (Task 12 step 2) — exact endpoint TBD by inspection of the live SPA. The shape `/api/sessions?artifact=<id>&status=live` is the proposed but unverified path; adapt to whatever the existing pattern uses.
3. **Playwright fixture** for `session.send` (Task 13) — depending on whether the test can boot a real agent session, may need to mock the session.send endpoint at the HTTP layer.
