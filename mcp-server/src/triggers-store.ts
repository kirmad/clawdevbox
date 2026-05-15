/**
 * triggers-store.ts (DB-backed)
 *
 * Storage layer for REGISTERED triggers (spec §8.3). Phase 4 — body is
 * now backed by the SQLite kernel DB. Function signatures are unchanged
 * so existing callers (`tools/trigger.ts`, `cli/start.ts`) keep working.
 *
 * `path` is preserved on the API for compatibility — it points at the
 * legacy `<workspace>/.clawdevbox/triggers.json` file and is used to
 * derive the workspace path (and thus `workspace_id`). The file itself
 * is no longer read or written here; `workspace.create` still seeds an
 * empty `{registered:[]}` so the historical disk shape remains visible
 * for inspection and for the legacy-files warning scan.
 *
 * Cron mapping:
 *   - cron === null       → cron_mode='inherit',  cron_expression=NULL
 *   - cron === false / '' → cron_mode='disabled', cron_expression=NULL
 *   - cron === '<expr>'   → cron_mode='override', cron_expression='<expr>'
 *
 * `subscriber_thread_id` has no first-class DB column; it round-trips
 * inside `state_json` under the `__subscriber_thread_id` key so call
 * sites that still depend on the field don't break.
 */

import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import { getDatabase } from './db/index.ts';
import { ensureWorkspace } from './db/workspaces-store.ts';
import { emitChange } from './event-bus.ts';

// ============================================================================
// Disk shape (kept for API compatibility)
// ============================================================================

/**
 * A registered trigger instance. `cron` semantics:
 *   - string                       → override the type's default_cron
 *   - null / undefined             → inherit the type's default_cron
 *   - false / "" (stored as false) → cron disabled (webhook/manual only)
 */
export interface RegisteredTrigger {
  id: string;
  type: string;
  params: Record<string, unknown>;
  cron: string | null | false;
  enabled: boolean;
  subscriber_thread_id: string | null;
  expires_at: number | null;
  once: boolean;
  registered_at: number;
  state: Record<string, unknown>;
  last_run_at: number | null;
  last_run_status: 'ok' | 'error' | null;
  last_run_error: string | null;
  // New Phase 4 fields — pass-through to the DB columns when present.
  recipe_instance_id?: string;
  recipe_step_id?: string;
  binds_callback_to?: 'agent_session_resume';
  binds_callback_to_recipe?: string;
  auto_declared?: boolean;
  auto_registered_by_step_id?: string;
  max_attempts?: number;
  backoff_ms?: number[];
}

interface TriggersFile {
  registered: RegisteredTrigger[];
}

interface TriggerRow {
  id: string;
  workspace_id: string;
  type: string;
  params_json: string;
  cron_mode: 'inherit' | 'override' | 'disabled';
  cron_expression: string | null;
  enabled: number;
  recipe_instance_id: string | null;
  recipe_step_id: string | null;
  binds_callback_to: string | null;
  binds_callback_to_recipe: string | null;
  auto_declared: number;
  auto_registered_by_step_id: string | null;
  expires_at: number | null;
  once: number;
  max_attempts: number;
  backoff_ms_json: string;
  registered_at: number;
  state_json: string;
  last_run_at: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Derive the workspace directory from the legacy triggers.json path.
 * `<workspace>/.clawdevbox/triggers.json` → `<workspace>`.
 */
function workspacePathFromTriggersFile(path: string): string {
  return dirname(dirname(path));
}

function rowToRegistered(row: TriggerRow): RegisteredTrigger {
  const cron: string | null | false =
    row.cron_mode === 'inherit'
      ? null
      : row.cron_mode === 'disabled'
        ? false
        : (row.cron_expression ?? null);

  const state = JSON.parse(row.state_json) as Record<string, unknown>;
  // Pull the round-tripped subscriber_thread_id out of state, if present.
  let subscriber_thread_id: string | null = null;
  if (typeof state.__subscriber_thread_id === 'string') {
    subscriber_thread_id = state.__subscriber_thread_id;
    delete state.__subscriber_thread_id;
  }

  const reg: RegisteredTrigger = {
    id: row.id,
    type: row.type,
    params: JSON.parse(row.params_json),
    cron,
    enabled: row.enabled === 1,
    subscriber_thread_id,
    expires_at: row.expires_at,
    once: row.once === 1,
    registered_at: row.registered_at,
    state,
    last_run_at: row.last_run_at,
    last_run_status: (row.last_run_status as 'ok' | 'error' | null) ?? null,
    last_run_error: row.last_run_error,
  };
  if (row.recipe_instance_id) reg.recipe_instance_id = row.recipe_instance_id;
  if (row.recipe_step_id) reg.recipe_step_id = row.recipe_step_id;
  if (row.binds_callback_to)
    reg.binds_callback_to = row.binds_callback_to as 'agent_session_resume';
  if (row.binds_callback_to_recipe)
    reg.binds_callback_to_recipe = row.binds_callback_to_recipe;
  if (row.auto_declared === 1) reg.auto_declared = true;
  if (row.auto_registered_by_step_id)
    reg.auto_registered_by_step_id = row.auto_registered_by_step_id;
  reg.max_attempts = row.max_attempts;
  try {
    reg.backoff_ms = JSON.parse(row.backoff_ms_json) as number[];
  } catch {
    reg.backoff_ms = [30000, 120000, 600000];
  }
  return reg;
}

function db(): Database {
  return getDatabase();
}

// ============================================================================
// Read / write
// ============================================================================

export function readTriggersFile(path: string): TriggersFile {
  let conn: Database;
  try {
    conn = db();
  } catch {
    return { registered: [] };
  }
  const ws = ensureWorkspace(conn, { path: workspacePathFromTriggersFile(path) });
  const rows = conn
    .prepare('SELECT * FROM triggers WHERE workspace_id = ? ORDER BY registered_at ASC')
    .all(ws.id) as TriggerRow[];
  return { registered: rows.map(rowToRegistered) };
}

export function writeTriggersFile(path: string, file: TriggersFile): void {
  const conn = db();
  const ws = ensureWorkspace(conn, { path: workspacePathFromTriggersFile(path) });

  const tx = conn.transaction((items: RegisteredTrigger[]) => {
    const keepIds = new Set(items.map((r) => r.id));
    const existing = conn
      .prepare('SELECT id FROM triggers WHERE workspace_id = ?')
      .all(ws.id) as Array<{ id: string }>;
    const delStmt = conn.prepare('DELETE FROM triggers WHERE id = ?');
    for (const row of existing) {
      if (!keepIds.has(row.id)) delStmt.run(row.id);
    }

    const upsert = conn.prepare(
      `INSERT INTO triggers (
         id, workspace_id, type, params_json,
         cron_mode, cron_expression, enabled,
         recipe_instance_id, recipe_step_id,
         binds_callback_to, binds_callback_to_recipe,
         auto_declared, auto_registered_by_step_id,
         expires_at, once, max_attempts, backoff_ms_json,
         registered_at, state_json,
         last_run_at, last_run_status, last_run_error
       ) VALUES (
         @id, @workspace_id, @type, @params_json,
         @cron_mode, @cron_expression, @enabled,
         @recipe_instance_id, @recipe_step_id,
         @binds_callback_to, @binds_callback_to_recipe,
         @auto_declared, @auto_registered_by_step_id,
         @expires_at, @once, @max_attempts, @backoff_ms_json,
         @registered_at, @state_json,
         @last_run_at, @last_run_status, @last_run_error
       )
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         params_json = excluded.params_json,
         cron_mode = excluded.cron_mode,
         cron_expression = excluded.cron_expression,
         enabled = excluded.enabled,
         recipe_instance_id = excluded.recipe_instance_id,
         recipe_step_id = excluded.recipe_step_id,
         binds_callback_to = excluded.binds_callback_to,
         binds_callback_to_recipe = excluded.binds_callback_to_recipe,
         auto_declared = excluded.auto_declared,
         auto_registered_by_step_id = excluded.auto_registered_by_step_id,
         expires_at = excluded.expires_at,
         once = excluded.once,
         max_attempts = excluded.max_attempts,
         backoff_ms_json = excluded.backoff_ms_json,
         state_json = excluded.state_json,
         last_run_at = excluded.last_run_at,
         last_run_status = excluded.last_run_status,
         last_run_error = excluded.last_run_error`,
    );

    for (const r of items) {
      let cron_mode: 'inherit' | 'override' | 'disabled';
      let cron_expression: string | null;
      if (r.cron === null || r.cron === undefined) {
        cron_mode = 'inherit';
        cron_expression = null;
      } else if (r.cron === false || r.cron === '') {
        cron_mode = 'disabled';
        cron_expression = null;
      } else {
        cron_mode = 'override';
        cron_expression = r.cron;
      }

      const stateWithThread: Record<string, unknown> = { ...(r.state ?? {}) };
      if (r.subscriber_thread_id) {
        stateWithThread.__subscriber_thread_id = r.subscriber_thread_id;
      }

      upsert.run({
        id: r.id,
        workspace_id: ws.id,
        type: r.type,
        params_json: JSON.stringify(r.params ?? {}),
        cron_mode,
        cron_expression,
        enabled: r.enabled ? 1 : 0,
        recipe_instance_id: r.recipe_instance_id ?? null,
        recipe_step_id: r.recipe_step_id ?? null,
        binds_callback_to: r.binds_callback_to ?? null,
        binds_callback_to_recipe: r.binds_callback_to_recipe ?? null,
        auto_declared: r.auto_declared ? 1 : 0,
        auto_registered_by_step_id: r.auto_registered_by_step_id ?? null,
        expires_at: r.expires_at ?? null,
        once: r.once ? 1 : 0,
        max_attempts: r.max_attempts ?? 3,
        backoff_ms_json: JSON.stringify(r.backoff_ms ?? [30000, 120000, 600000]),
        registered_at: r.registered_at ?? Date.now(),
        state_json: JSON.stringify(stateWithThread),
        last_run_at: r.last_run_at ?? null,
        last_run_status: r.last_run_status ?? null,
        last_run_error: r.last_run_error ?? null,
      });
    }
  });
  tx(file.registered);
  emitChange('triggers');
}

// ============================================================================
// Id minting (spec §8.3) — unchanged
// ============================================================================

/**
 * Mint a registered-trigger id.
 *
 *   - If `identityParam` is set and the params object carries it, the id is
 *     `<type_id>#<param[identityParam]>` (e.g. `ado.new-pr-watcher#auth-svc`).
 *     We URL-encode the param value to keep ids file-safe.
 *
 *   - Otherwise, deterministically hash all params and use the first 8 hex
 *     chars: `<type_id>#<hash8>`.
 *
 * Deterministic stable hashing requires canonical key ordering — we sort the
 * top-level keys before stringifying. Nested objects/arrays use their natural
 * JSON.stringify order; canonical-json (RFC 8785) is a future upgrade if
 * deeper nesting starts producing collisions.
 */
export function mintRegisteredId(
  typeId: string,
  params: Record<string, unknown>,
  identityParam?: string,
): string {
  if (identityParam && Object.prototype.hasOwnProperty.call(params, identityParam)) {
    const raw = params[identityParam];
    if (raw === null || raw === undefined || raw === '') {
      // Fall through to hash if the identity value is empty.
    } else {
      return `${typeId}#${encodeURIComponent(String(raw))}`;
    }
  }
  const sortedKeys = Object.keys(params).sort();
  const canonical = sortedKeys.map((k) => [k, params[k]] as const);
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 8);
  return `${typeId}#${hash}`;
}
