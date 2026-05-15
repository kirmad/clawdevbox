/**
 * Workspaces store — prepared-statement CRUD for the `workspaces` table.
 *
 * A workspace is a directory + identity that owns artifacts, recipe
 * instances, and trigger registrations (spec §3, primitive 1). Paths are
 * normalized via `path.resolve()` so equivalent inputs map to the same row.
 */

import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

export interface WorkspaceRow {
  id: string;
  path: string;
  name: string | null;
  parent_workspace_id: string | null;
  created_at: number;
}

function normalizePath(p: string): string {
  return resolve(p);
}

export function mintWorkspaceId(): string {
  return `ws_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function ensureWorkspace(
  db: Database,
  opts: {
    id?: string;
    path: string;
    name?: string;
    parent_workspace_id?: string;
  },
): WorkspaceRow {
  const path = normalizePath(opts.path);
  const existing = getWorkspaceByPath(db, path);
  if (existing) return existing;
  const id = opts.id ?? mintWorkspaceId();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO workspaces (id, path, name, parent_workspace_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, path, opts.name ?? null, opts.parent_workspace_id ?? null, created_at);
  return {
    id,
    path,
    name: opts.name ?? null,
    parent_workspace_id: opts.parent_workspace_id ?? null,
    created_at,
  };
}

export function getWorkspaceByPath(db: Database, path: string): WorkspaceRow | null {
  const row = db
    .prepare('SELECT * FROM workspaces WHERE path = ?')
    .get(normalizePath(path)) as WorkspaceRow | undefined;
  return row ?? null;
}

export function getWorkspaceById(db: Database, id: string): WorkspaceRow | null {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    | WorkspaceRow
    | undefined;
  return row ?? null;
}

export function listWorkspaces(db: Database): WorkspaceRow[] {
  return db
    .prepare('SELECT * FROM workspaces ORDER BY created_at ASC')
    .all() as WorkspaceRow[];
}
