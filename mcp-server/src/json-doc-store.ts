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
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomicAsync } from './fs-util.js';

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

/**
 * Locate an existing doc. Returns null for missing OR unreadable docs —
 * deliberate for the single-writer workspace-local store. A corrupt sidecar
 * causes the next putDoc to overwrite (and reset created_at), which is
 * acceptable here.
 */
async function findExisting(workspaceDir: string, collection: string, id: string, opts?: JsonDocStoreOptions) {
  const dir = collectionDir(workspaceDir, collection, opts);
  const metaPath = join(dir, `${id}.meta.json`);
  if (!existsSync(metaPath)) return null;
  const meta = await readMeta(metaPath);
  if (!meta) return null;
  const ext = EXT_FOR_TYPE[meta.content_type] ?? 'bin';
  const paths = pathsFor(workspaceDir, collection, id, ext, opts);
  return { dir: paths.dir, body: paths.body, metaPath, meta };
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
  const normalizedType = contentType.toLowerCase();
  const cap = normalizedType === 'application/json' ? JSON_DOC_MAX_BYTES : BLOB_DOC_MAX_BYTES;
  if (body.length > cap) return { kind: 'too_large', cap };
  if (normalizedType === 'application/json') {
    try { JSON.parse(body.toString('utf8')); }
    catch (e) { return { kind: 'invalid_json', message: (e as Error).message }; }
  }
  const existing = await findExisting(workspaceDir, collection, id, opts);
  if (ifMatch && (!existing || `"sha1:${existing.meta.sha1}"` !== ifMatch)) {
    return { kind: 'etag_mismatch' };
  }
  const ext = EXT_FOR_TYPE[normalizedType] ?? 'bin';
  const { dir, body: bodyPath, meta: metaPath } = pathsFor(workspaceDir, collection, id, ext, opts);
  if (existing && existing.body !== bodyPath) await unlink(existing.body).catch(() => {});
  await mkdir(dir, { recursive: true });
  const sha1 = sha1Hex(body);
  const now = new Date().toISOString();
  const meta: DocMeta = {
    content_type: normalizedType,
    sha1,
    size: body.length,
    created_at: existing?.meta.created_at ?? now,
    updated_at: now,
  };
  await writeFileAtomicAsync(bodyPath, body);
  await writeFileAtomicAsync(metaPath, JSON.stringify(meta, null, 2));
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
  await unlink(existing.metaPath).catch(() => {});
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
