/**
 * memory-sync-register.ts
 *
 * Ensures the memory-sync trigger type is installed in the global
 * trigger-types directory and a default instance row exists in the DB.
 * Idempotent — safe to call on every startup.
 */
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { ensureWorkspace } from './db/workspaces-store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIGGER_TYPE_SRC = join(HERE, '..', 'trigger-types', 'memory-sync');

/**
 * Copy the trigger type files (template.yaml, trigger.ts, package.json)
 * into the global trigger-types directory if not already present.
 */
export function ensureMemorySyncTriggerType(globalDir: string): void {
  const dest = join(globalDir, 'trigger-types', 'memory-sync');
  if (existsSync(join(dest, 'template.yaml'))) return;
  if (!existsSync(TRIGGER_TYPE_SRC)) return; // source not available (e.g. bundled dist)
  mkdirSync(dest, { recursive: true });
  cpSync(TRIGGER_TYPE_SRC, dest, { recursive: true });
}

/**
 * Ensure a default memory-sync trigger instance exists in the DB.
 * Uses the triggers table directly.
 *
 * `triggers.workspace_id` references `workspaces(id)`. Resolve the global
 * directory through the canonical workspace store before inserting so fresh
 * deployments satisfy that foreign key.
 */
export function ensureMemorySyncInstance(db: Database, globalDir?: string): void {
  const existing = db.prepare(
    `SELECT id FROM triggers WHERE type = 'memory-sync' LIMIT 1`
  ).get() as { id: string } | undefined;
  if (existing) return;

  const resolvedGlobalDir = resolve(
    globalDir ?? process.env.CLAWDEVBOX_GLOBAL_DIR ?? join(homedir(), '.clawdevbox'),
  );
  const workspace = ensureWorkspace(db, { path: resolvedGlobalDir });

  const now = Date.now();
  // The dispatcher hands the trigger SCRIPT `envelope.state = state_json`
  // (no params merge). The script reads its configuration from that state
  // (state.vault_scope / state.auto_push), so — matching the framework
  // convention in the trigger.instance.register handler — the bootstrap
  // instance must seed state_json FROM its params. Otherwise the registered
  // vault_scope / auto_push are dead and the script silently falls back to
  // its hardcoded defaults regardless of what was registered.
  const defaultParams = { vault_scope: 'all', auto_push: true };
  const paramsJson = JSON.stringify(defaultParams);
  db.prepare(`
    INSERT INTO triggers (id, type, name, cron_mode, cron_expression, enabled, state_json, params_json, registered_at, workspace_id)
    VALUES (?, 'memory-sync', 'Memory vault sync', 'inherit', NULL, 1, ?, ?, ?, ?)
  `).run('memory-sync-default', paramsJson, paramsJson, now, workspace.id);
}
