/**
 * inbox-persistence.ts (DB + JSON dual-write)
 *
 * Disk layer for the inbox store. Phase 4 — the SQLite kernel DB is the
 * canonical metadata store; the legacy `<globalDir>/inbox.json` file is
 * preserved as a write-through mirror so existing tests that inspect the
 * file shape keep passing. Body sidecars under
 * `<globalDir>/inbox-bodies/<safe-id>.<ext>` are unchanged — bodies stay
 * on disk and the DB only knows the `body_path` pointing at them.
 *
 *   <globalDir>/inbox.json                      ← legacy metadata mirror
 *   <globalDir>/inbox-bodies/<safe-id>.<ext>     ← full description bodies
 *
 * Reads prefer the JSON file (it remains the live mirror); if the file
 * is missing we fall back to the `inbox_items` table. Writes go to the
 * file first (atomic) and then upsert into the DB.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDatabase } from './db/index.ts';
import { emitChange } from './event-bus.ts';
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

function safeDb(): Database | null {
  try {
    return getDatabase();
  } catch {
    return null;
  }
}

interface InboxRow {
  id: string;
  workspace_id: string | null;
  title: string;
  preview: string | null;
  body_path: string | null;
  attachments_json: string | null;
  labels_json: string | null;
  source: string | null;
  status: string;
  snoozed_until: number | null;
  recipe_instance_id: string | null;
  recipe_step_id: string | null;
  trigger_id: string | null;
  fire_id: string | null;
  agent_session_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToItem(row: InboxRow): InboxItem {
  return {
    id: row.id,
    kind: row.status, // kind is not first-class in DB; preserved via the JSON mirror.
    source: row.source ?? '',
    title: row.title || undefined,
    preview: row.preview ?? undefined,
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : undefined,
    labels: row.labels_json ? JSON.parse(row.labels_json) : undefined,
    recipe_instance: row.recipe_instance_id ? { id: row.recipe_instance_id } : undefined,
    trigger_id: row.trigger_id ?? undefined,
    recipe_step_id: row.recipe_step_id ?? undefined,
    agent_session_id: row.agent_session_id ?? undefined,
    state: 'new',
    snoozed_until: row.snoozed_until ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } as InboxItem;
}

// ============================================================================
// Read
// ============================================================================

export function loadInboxFromDisk(globalDir: string): InboxItem[] {
  const path = inboxFilePath(globalDir);
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<InboxFile>;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
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
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path },
        'inbox: file unreadable; falling back to DB',
      );
    }
  }

  // Fallback to DB when the JSON mirror is missing or unreadable.
  const conn = safeDb();
  if (!conn) return [];
  try {
    const rows = conn
      .prepare('SELECT * FROM inbox_items ORDER BY created_at DESC')
      .all() as InboxRow[];
    return rows.map(rowToItem);
  } catch {
    return [];
  }
}

// ============================================================================
// Write
// ============================================================================

export function saveInboxToDisk(globalDir: string, items: InboxItem[]): void {
  // 1. Legacy JSON mirror (atomic).
  const path = inboxFilePath(globalDir);
  mkdirSync(dirname(path), { recursive: true });
  const file: InboxFile = { version: 1, items };
  writeFileAtomic(path, JSON.stringify(file, null, 2) + '\n');

  // 2. DB mirror — replace all rows in a single transaction.
  const conn = safeDb();
  if (!conn) {
    emitChange('inbox');
    return;
  }
  try {
    const tx = conn.transaction((rows: InboxItem[]) => {
      conn.prepare('DELETE FROM inbox_items').run();
      const insertStmt = conn.prepare(
        `INSERT INTO inbox_items (
           id, workspace_id, title, preview, body_path,
           attachments_json, labels_json, source, status, snoozed_until,
           recipe_instance_id, recipe_step_id, trigger_id, fire_id,
           agent_session_id, created_at, updated_at
         ) VALUES (
           @id, @workspace_id, @title, @preview, @body_path,
           @attachments_json, @labels_json, @source, @status, @snoozed_until,
           @recipe_instance_id, @recipe_step_id, @trigger_id, @fire_id,
           @agent_session_id, @created_at, @updated_at
         )`,
      );
      for (const it of rows) {
        const bodyFmt = it.description_format as InboxBodyFormat | undefined;
        const body_path = bodyFmt ? inboxBodyPath(globalDir, it.id, bodyFmt) : null;
        const recipe_instance_id =
          (it.recipe_instance && typeof it.recipe_instance === 'object'
            ? (it.recipe_instance as { id?: string }).id
            : null) ?? null;
        insertStmt.run({
          id: it.id,
          workspace_id: null,
          title: it.title ?? '',
          preview: it.preview ?? null,
          body_path,
          attachments_json: it.attachments ? JSON.stringify(it.attachments) : null,
          labels_json: it.labels ? JSON.stringify(it.labels) : null,
          source: it.source ?? null,
          status: it.state ?? 'new',
          snoozed_until: it.snoozed_until ?? null,
          recipe_instance_id,
          recipe_step_id: (it.recipe_step_id as string | null) ?? null,
          trigger_id: (it.trigger_id as string | null) ?? null,
          fire_id: null,
          agent_session_id: (it.agent_session_id as string | null) ?? null,
          created_at: it.created_at,
          updated_at: it.updated_at,
        });
      }
    });
    tx(items);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'inbox: DB mirror save failed; JSON mirror remains authoritative',
    );
  }
  emitChange('inbox');
}

// ============================================================================
// Body sidecars (filesystem, unchanged)
// ============================================================================

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
