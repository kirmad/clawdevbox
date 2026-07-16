/**
 * inbox-persistence.ts (DB-first; JSON file is a debounced legacy mirror)
 *
 * The SQLite kernel DB is the canonical inbox store. Each row is full-fidelity:
 * the `raw_json` column stores the original `InboxItem` shape so future field
 * additions don't require schema migrations. The indexed columns (`status`,
 * `state`, `kind`, `created_at`, etc.) exist for filtering / ordering.
 *
 * Body sidecars under `<globalDir>/inbox-bodies/<safe-id>.<ext>` remain
 * on-disk and are referenced via `body_path` — the DB only tracks the path.
 *
 *   <globalDir>/inbox.json                       ← legacy mirror (debounced)
 *   <globalDir>/inbox-bodies/<safe-id>.<ext>      ← full description bodies
 *
 * Why the JSON file still exists: scripts + old test fixtures inspect it.
 * The mirror is written ~500ms after the latest mutation via a single timer,
 * NOT on every save, so list/upsert latency is dominated by the SQL queries.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDatabase } from './db/index.ts';
import { emitChange } from './event-bus.ts';
import { writeFileAtomic } from './fs-util.ts';
import { logger } from './logger.ts';
import type { InboxBodyFormat, InboxItem, InboxQuestion } from './store.ts';

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
  // V6 additions
  kind: string | null;
  state: string | null;
  description_format: string | null;
  description_size: number | null;
  raw_json: string | null;
}

function rowToItem(row: InboxRow): InboxItem {
  // V6+: raw_json is full-fidelity. Use it when present; fall back to a
  // best-effort reconstruction from indexed columns (handles pre-V6 rows
  // that haven't been re-saved since the migration).
  if (row.raw_json) {
    try {
      const parsed = JSON.parse(row.raw_json) as InboxItem;
      // Make sure the indexed fields win over any stale embedded copy.
      const migrated = migrateLegacyQuestion({
        ...parsed,
        id: row.id,
        kind: row.kind ?? parsed.kind,
        state: (row.state as InboxItem['state']) ?? parsed.state,
        source: row.source ?? parsed.source ?? '',
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
      return migrated;
    } catch {
      // Corrupted blob — fall through to column-based reconstruction.
    }
  }
  return {
    id: row.id,
    kind: row.kind ?? row.status,
    source: row.source ?? '',
    title: row.title || undefined,
    preview: row.preview ?? undefined,
    description_format: (row.description_format as InboxBodyFormat | null) ?? undefined,
    description_size: row.description_size ?? undefined,
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : undefined,
    labels: row.labels_json ? JSON.parse(row.labels_json) : undefined,
    recipe_instance: row.recipe_instance_id ? { id: row.recipe_instance_id } : undefined,
    trigger_id: row.trigger_id ?? undefined,
    recipe_step_id: row.recipe_step_id ?? undefined,
    agent_session_id: row.agent_session_id ?? undefined,
    state: (row.state as InboxItem['state']) ?? 'new',
    snoozed_until: row.snoozed_until ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  } as InboxItem;
}

/**
 * Auto-migrate legacy single-question inbox items to the multi-question
 * shape. Items written before the multi-question feature carried a
 * singular `question?: InboxQuestion`. New items use `questions?:
 * InboxQuestion[]` with an explicit per-question `id`. This helper
 * lifts the legacy field into `questions[0]` on every read so callers
 * never see the legacy shape. The migration is read-side only — old
 * raw_json blobs stay as-written until the item is next upsert'd.
 */
function migrateLegacyQuestion(item: InboxItem): InboxItem {
  // Already migrated, or never had a question.
  if (Array.isArray(item.questions) && item.questions.length > 0) {
    // Also strip the legacy field if both are present (questions wins).
    if (item.question) {
      const { question, ...rest } = item as InboxItem & { question?: unknown };
      void question;
      return rest as InboxItem;
    }
    return item;
  }
  // The legacy `question` field on-disk may pre-date the `id` requirement
  // we added in the multi-question rollout. Treat it loosely (as any) and
  // synthesize an id of "q1" so callers can rely on the new shape.
  const legacy = item.question as (Partial<InboxQuestion> & Record<string, unknown>) | undefined;
  if (!legacy || typeof legacy !== 'object' || typeof legacy.prompt !== 'string') return item;
  const migrated: InboxQuestion = {
    id: typeof legacy.id === 'string' && legacy.id ? legacy.id : 'q1',
    prompt: legacy.prompt,
    mode: legacy.mode as InboxQuestion['mode'],
    options: legacy.options as InboxQuestion['options'],
    allow_freeform: legacy.allow_freeform as boolean | undefined,
    placeholder: legacy.placeholder as string | undefined,
    title: legacy.title as string | undefined,
    close_on_answer: legacy.close_on_answer as boolean | undefined,
    closed: legacy.closed as boolean | undefined,
    dispatch: legacy.dispatch as InboxQuestion['dispatch'],
  };
  const { question, ...rest } = item as InboxItem & { question?: unknown };
  void question;
  return { ...rest, questions: [migrated] } as InboxItem;
}

// ============================================================================
// Read
// ============================================================================

export function loadInboxFromDisk(globalDir: string): InboxItem[] {
  void globalDir;
  // DB is authoritative (V6+). The JSON file is a debounced one-way mirror
  // for human inspection / backup — never read from in the hot path.
  const conn = safeDb();
  if (!conn) {
    // DB not open yet — try the legacy JSON file ONCE for boot-time reads
    // before migrations run. Production callers always have the DB open.
    const path = inboxFilePath(globalDir);
    if (!existsSync(path)) return [];
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
        ).map(migrateLegacyQuestion);   // run multi-question migration on JSON-path reads too
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path },
        'inbox: pre-DB boot read failed; returning empty list',
      );
    }
    return [];
  }
  try {
    const rows = conn
      .prepare('SELECT * FROM inbox_items ORDER BY created_at DESC, id DESC')
      .all() as InboxRow[];
    return rows.map(rowToItem);
  } catch {
    return [];
  }
}

// ============================================================================
// Write
// ============================================================================

/**
 * Debounce timer for the legacy JSON mirror write. Collapses many rapid
 * inbox mutations into a single file rewrite. Module-scoped because the
 * mirror is global per-process (only one globalDir per kernel).
 */
const JSON_MIRROR_DEBOUNCE_MS = 500;
let pendingMirrorTimer: NodeJS.Timeout | null = null;
let pendingMirrorPath: string | null = null;
let pendingMirrorItems: InboxItem[] | null = null;

function scheduleJsonMirror(path: string, items: InboxItem[]): void {
  pendingMirrorPath = path;
  pendingMirrorItems = items;
  if (pendingMirrorTimer) return;
  pendingMirrorTimer = setTimeout(() => {
    pendingMirrorTimer = null;
    const p = pendingMirrorPath;
    const it = pendingMirrorItems;
    pendingMirrorPath = null;
    pendingMirrorItems = null;
    if (!p || !it) return;
    try {
      mkdirSync(dirname(p), { recursive: true });
      const file: InboxFile = { version: 1, items: it };
      writeFileAtomic(p, JSON.stringify(file, null, 2) + '\n');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), path: p },
        'inbox: legacy JSON mirror write failed (DB remains authoritative)',
      );
    }
  }, JSON_MIRROR_DEBOUNCE_MS);
  if (typeof pendingMirrorTimer.unref === 'function') pendingMirrorTimer.unref();
}

/**
 * Single-row read by id. Returns null if not found.
 * Fast path used by InboxStore.read() — avoids loading the whole table.
 * Falls back to the JSON file when the DB is unavailable (tests, pre-boot).
 */
export function readInboxItemById(globalDir: string, id: string): InboxItem | null {
  const conn = safeDb();
  if (conn) {
    try {
      const row = conn.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as InboxRow | undefined;
      return row ? rowToItem(row) : null;
    } catch {
      // Fall through to JSON fallback.
    }
  }
  // DB unavailable — read from the JSON mirror.
  const all = loadInboxFromDisk(globalDir);
  return all.find((it) => it.id === id) ?? null;
}

/**
 * Single-row upsert. Called from InboxStore.upsert/setState/snooze instead
 * of rewriting the whole table on every mutation. Same column set as the
 * bulk save below; the V6 `raw_json` blob captures any future field.
 */
export function upsertInboxItem(globalDir: string, item: InboxItem): void {
  const conn = safeDb();
  if (!conn) {
    // No DB — synchronous JSON fallback. Used by unit tests and pre-boot.
    const all = loadInboxFromDisk(globalDir);
    const idx = all.findIndex((it) => it.id === item.id);
    if (idx >= 0) all[idx] = item;
    else all.push(item);
    const path = inboxFilePath(globalDir);
    mkdirSync(dirname(path), { recursive: true });
    const file: InboxFile = { version: 1, items: all };
    writeFileAtomic(path, JSON.stringify(file, null, 2) + '\n');
    emitChange('inbox');
    return;
  }
  try {
    const bodyFmt = item.description_format as InboxBodyFormat | undefined;
    const body_path = bodyFmt ? inboxBodyPath(globalDir, item.id, bodyFmt) : null;
    const recipe_instance_id =
      (item.recipe_instance && typeof item.recipe_instance === 'object'
        ? (item.recipe_instance as { id?: string }).id
        : null) ?? null;
    conn.prepare(
      `INSERT INTO inbox_items (
         id, workspace_id, title, preview, body_path,
         attachments_json, labels_json, source, status, snoozed_until,
         recipe_instance_id, recipe_step_id, trigger_id, fire_id,
         agent_session_id, created_at, updated_at,
         kind, state, description_format, description_size, raw_json
       ) VALUES (
         @id, @workspace_id, @title, @preview, @body_path,
         @attachments_json, @labels_json, @source, @status, @snoozed_until,
         @recipe_instance_id, @recipe_step_id, @trigger_id, @fire_id,
         @agent_session_id, @created_at, @updated_at,
         @kind, @state, @description_format, @description_size, @raw_json
       )
       ON CONFLICT(id) DO UPDATE SET
         workspace_id        = excluded.workspace_id,
         title               = excluded.title,
         preview             = excluded.preview,
         body_path           = excluded.body_path,
         attachments_json    = excluded.attachments_json,
         labels_json         = excluded.labels_json,
         source              = excluded.source,
         status              = excluded.status,
         snoozed_until       = excluded.snoozed_until,
         recipe_instance_id  = excluded.recipe_instance_id,
         recipe_step_id      = excluded.recipe_step_id,
         trigger_id          = excluded.trigger_id,
         fire_id             = excluded.fire_id,
         agent_session_id    = excluded.agent_session_id,
         updated_at          = excluded.updated_at,
         kind                = excluded.kind,
         state               = excluded.state,
         description_format  = excluded.description_format,
         description_size    = excluded.description_size,
         raw_json            = excluded.raw_json`,
    ).run({
      id: item.id,
      workspace_id: null,
      title: item.title ?? '',
      preview: item.preview ?? null,
      body_path,
      attachments_json: item.attachments ? JSON.stringify(item.attachments) : null,
      labels_json: item.labels ? JSON.stringify(item.labels) : null,
      source: item.source ?? null,
      status: item.state ?? 'new',
      snoozed_until: item.snoozed_until ?? null,
      recipe_instance_id,
      recipe_step_id: (item.recipe_step_id as string | null) ?? null,
      trigger_id: (item.trigger_id as string | null) ?? null,
      fire_id: null,
      agent_session_id: (item.agent_session_id as string | null) ?? null,
      created_at: item.created_at,
      updated_at: item.updated_at,
      kind: item.kind ?? null,
      state: item.state ?? null,
      description_format: bodyFmt ?? null,
      description_size: item.description_size ?? null,
      raw_json: JSON.stringify(item),
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), id: item.id },
      'inbox: single-row upsert failed',
    );
  }

  // Schedule a debounced JSON mirror refresh — re-reads from DB at flush
  // time so the file always reflects the latest authoritative state.
  const path = inboxFilePath(globalDir);
  if (!pendingMirrorTimer) {
    pendingMirrorPath = path;
    pendingMirrorItems = null;
    pendingMirrorTimer = setTimeout(() => {
      pendingMirrorTimer = null;
      const p = pendingMirrorPath;
      pendingMirrorPath = null;
      pendingMirrorItems = null;
      if (!p) return;
      try {
        const all = loadInboxFromDisk(globalDir);
        mkdirSync(dirname(p), { recursive: true });
        const file: InboxFile = { version: 1, items: all };
        writeFileAtomic(p, JSON.stringify(file, null, 2) + '\n');
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), path: p },
          'inbox: legacy JSON mirror refresh failed (DB remains authoritative)',
        );
      }
    }, JSON_MIRROR_DEBOUNCE_MS);
    if (typeof pendingMirrorTimer.unref === 'function') pendingMirrorTimer.unref();
  }

  emitChange('inbox');
}

/**
 * Single-row delete by id. No-op if the row doesn't exist or DB unavailable.
 */
export function deleteInboxItem(globalDir: string, id: string): void {
  const conn = safeDb();
  if (conn) {
    try {
      conn.prepare('DELETE FROM inbox_items WHERE id = ?').run(id);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), id },
        'inbox: single-row delete failed',
      );
    }
    scheduleJsonMirror(inboxFilePath(globalDir), loadInboxFromDisk(globalDir));
  } else {
    // No DB — synchronous JSON fallback.
    const all = loadInboxFromDisk(globalDir).filter((it) => it.id !== id);
    const path = inboxFilePath(globalDir);
    mkdirSync(dirname(path), { recursive: true });
    const file: InboxFile = { version: 1, items: all };
    writeFileAtomic(path, JSON.stringify(file, null, 2) + '\n');
  }
  emitChange('inbox');
}

export function saveInboxToDisk(globalDir: string, items: InboxItem[]): void {
  // 1. DB write — synchronous + authoritative. This is what /api/inbox reads.
  const conn = safeDb();
  if (conn) {
    try {
      const tx = conn.transaction((rows: InboxItem[]) => {
        conn.prepare('DELETE FROM inbox_items').run();
        const insertStmt = conn.prepare(
          `INSERT INTO inbox_items (
             id, workspace_id, title, preview, body_path,
             attachments_json, labels_json, source, status, snoozed_until,
             recipe_instance_id, recipe_step_id, trigger_id, fire_id,
             agent_session_id, created_at, updated_at,
             kind, state, description_format, description_size, raw_json
           ) VALUES (
             @id, @workspace_id, @title, @preview, @body_path,
             @attachments_json, @labels_json, @source, @status, @snoozed_until,
             @recipe_instance_id, @recipe_step_id, @trigger_id, @fire_id,
             @agent_session_id, @created_at, @updated_at,
             @kind, @state, @description_format, @description_size, @raw_json
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
            // V6 columns
            kind: it.kind ?? null,
            state: it.state ?? null,
            description_format: bodyFmt ?? null,
            description_size: it.description_size ?? null,
            raw_json: JSON.stringify(it),
          });
        }
      });
      tx(items);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'inbox: DB write failed; legacy JSON mirror will still be written',
      );
    }
  }

  // 2. Debounced legacy JSON mirror — humans / scripts inspecting the file
  // get an eventually-consistent view without paying file-write latency on
  // every mutation.
  scheduleJsonMirror(inboxFilePath(globalDir), items);

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
