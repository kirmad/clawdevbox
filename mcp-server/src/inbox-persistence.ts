/**
 * inbox-persistence.ts
 *
 * Disk layer for the inbox store. Two-tier storage:
 *
 *   <globalDir>/inbox.json                       ← metadata only (small)
 *   <globalDir>/inbox-bodies/<safe-id>.<ext>      ← full description bodies
 *
 * The split keeps `/api/inbox` (the list endpoint) lightweight even when
 * some items carry hundreds of KB of markdown. The SPA fetches a body
 * lazily via `GET /api/inbox/:id` only when the user expands a card.
 *
 * Like `triggers-store.ts`, every read opens the file fresh and every
 * write is atomic (tempfile + rename via `writeFileAtomic`). No in-memory
 * cache — the file is the source of truth so the stdio-MCP server and
 * the `clawdevbox start --service` HTTP server stay consistent without
 * an external DB.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './fs-util.ts';
import { logger } from './logger.ts';
import type { InboxBodyFormat, InboxItem } from './store.ts';

const INBOX_FILENAME = 'inbox.json';
const BODIES_DIR = 'inbox-bodies';

export function inboxFilePath(globalDir: string): string {
  return join(globalDir, INBOX_FILENAME);
}

export function inboxBodiesDir(globalDir: string): string {
  return join(globalDir, BODIES_DIR);
}

/**
 * Map an arbitrary inbox id (e.g. `ado:pr:2401`) to a filesystem-safe
 * filename. Anything not in `[a-z0-9._-]` is replaced with `_`. Collisions
 * are theoretically possible but inbox ids are conventionally namespaced
 * (`<source>:<kind>:<localId>`) so this is fine in practice. The full
 * unmodified id remains the canonical key in inbox.json.
 */
function safeBodyBasename(id: string): string {
  // eslint-disable-next-line no-control-regex
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

function bodyExt(format: InboxBodyFormat): string {
  return format === 'markdown' ? 'md' : 'txt';
}

export function inboxBodyPath(
  globalDir: string,
  id: string,
  format: InboxBodyFormat,
): string {
  return join(inboxBodiesDir(globalDir), `${safeBodyBasename(id)}.${bodyExt(format)}`);
}

interface InboxFile {
  version: 1;
  items: InboxItem[];
}

export function loadInboxFromDisk(globalDir: string): InboxItem[] {
  const path = inboxFilePath(globalDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<InboxFile>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter(
      (it): it is InboxItem =>
        !!it &&
        typeof it === 'object' &&
        typeof (it as InboxItem).id === 'string' &&
        typeof (it as InboxItem).kind === 'string' &&
        typeof (it as InboxItem).source === 'string' &&
        typeof (it as InboxItem).state === 'string' &&
        typeof (it as InboxItem).created_at === 'number' &&
        typeof (it as InboxItem).updated_at === 'number',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'inbox: file unreadable; treating as empty',
    );
    return [];
  }
}

export function saveInboxToDisk(globalDir: string, items: InboxItem[]): void {
  const path = inboxFilePath(globalDir);
  mkdirSync(dirname(path), { recursive: true });
  const file: InboxFile = { version: 1, items };
  writeFileAtomic(path, JSON.stringify(file, null, 2) + '\n');
}

/**
 * Write a body sidecar. Removes any stale body in the *other* format so
 * switching between markdown ↔ text doesn't leave an orphan file.
 */
export function writeInboxBody(
  globalDir: string,
  id: string,
  body: string,
  format: InboxBodyFormat,
): void {
  mkdirSync(inboxBodiesDir(globalDir), { recursive: true });
  writeFileAtomic(inboxBodyPath(globalDir, id, format), body);
  // Clean up the opposite-format sidecar if it exists.
  const other: InboxBodyFormat = format === 'markdown' ? 'text' : 'markdown';
  const otherPath = inboxBodyPath(globalDir, id, other);
  if (existsSync(otherPath)) {
    try {
      unlinkSync(otherPath);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), otherPath },
        'inbox: failed to remove stale body sidecar',
      );
    }
  }
}

export function readInboxBody(
  globalDir: string,
  id: string,
  format: InboxBodyFormat,
): string | null {
  const path = inboxBodyPath(globalDir, id, format);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'inbox: body sidecar unreadable',
    );
    return null;
  }
}

/** Remove sidecars in either format. Idempotent. */
export function deleteInboxBody(globalDir: string, id: string): void {
  for (const format of ['markdown', 'text'] as const) {
    const path = inboxBodyPath(globalDir, id, format);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), path },
          'inbox: failed to remove body sidecar',
        );
      }
    }
  }
}
