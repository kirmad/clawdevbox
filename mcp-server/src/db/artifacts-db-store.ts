/**
 * Artifacts metadata store — DB side of the artifact primitive.
 *
 * Files for an artifact stay on disk under `dir_path`; this table holds
 * only metadata (type, title, declared-id, lineage, JSON blob). Renderers
 * in the SPA read files from `dir_path` directly. See spec §3 primitive 5
 * and §4.2 for the schema.
 */

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { emitChange } from '../event-bus.ts';

export interface ArtifactDbRow {
  id: string;
  workspace_id: string;
  recipe_instance_id: string | null;
  recipe_step_id: string | null;
  agent_session_id: string | null;
  artifact_decl_id: string | null;
  type: string;
  title: string | null;
  dir_path: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export function mintArtifactId(): string {
  return `art_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
}

export function registerArtifact(
  db: Database,
  opts: {
    workspace_id: string;
    recipe_instance_id?: string;
    recipe_step_id?: string;
    agent_session_id?: string;
    artifact_decl_id?: string;
    type: string;
    title?: string;
    dir_path: string;
    metadata?: Record<string, unknown>;
  },
): ArtifactDbRow {
  const id = mintArtifactId();
  const now = Date.now();
  const metadata_json = JSON.stringify(opts.metadata ?? {});
  db.prepare(
    `INSERT INTO artifacts (
       id, workspace_id, recipe_instance_id, recipe_step_id, agent_session_id,
       artifact_decl_id, type, title, dir_path, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.workspace_id,
    opts.recipe_instance_id ?? null,
    opts.recipe_step_id ?? null,
    opts.agent_session_id ?? null,
    opts.artifact_decl_id ?? null,
    opts.type,
    opts.title ?? null,
    opts.dir_path,
    metadata_json,
    now,
    now,
  );
  emitChange('artifacts');
  return getArtifact(db, id)!;
}

export function linkArtifactToStep(
  db: Database,
  art_id: string,
  recipe_step_id: string,
  agent_session_id?: string,
): void {
  const now = Date.now();
  db.prepare(
    `UPDATE artifacts SET
       recipe_step_id = ?,
       agent_session_id = COALESCE(?, agent_session_id),
       updated_at = ?
     WHERE id = ?`,
  ).run(recipe_step_id, agent_session_id ?? null, now, art_id);
  emitChange('artifacts');
}

export function listArtifactsForWorkspace(
  db: Database,
  workspace_id: string,
  opts: { limit?: number; before?: number } = {},
): ArtifactDbRow[] {
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspace_id];
  if (opts.before !== undefined) {
    where.push('created_at < ?');
    params.push(opts.before);
  }
  const limit = Math.min(opts.limit ?? 100, 500);
  params.push(limit);
  return db
    .prepare(
      `SELECT * FROM artifacts WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params) as ArtifactDbRow[];
}

export function listArtifactsForStep(
  db: Database,
  recipe_step_id: string,
): ArtifactDbRow[] {
  return db
    .prepare(
      `SELECT * FROM artifacts WHERE recipe_step_id = ? ORDER BY created_at ASC`,
    )
    .all(recipe_step_id) as ArtifactDbRow[];
}

export function getArtifact(db: Database, art_id: string): ArtifactDbRow | null {
  const row = db
    .prepare('SELECT * FROM artifacts WHERE id = ?')
    .get(art_id) as ArtifactDbRow | undefined;
  return row ?? null;
}
