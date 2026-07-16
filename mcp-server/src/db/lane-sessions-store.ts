import type { Database } from 'better-sqlite3';

export interface LaneSessionRow {
  recipe_instance_id: string;
  lane: string;
  cli_session_id: string | null;
  status: string;      // 'live' | 'idle' | 'done'
  spawned_at: number;
}

export function upsertLaneSession(
  db: Database,
  row: { recipe_instance_id: string; lane: string; cli_session_id: string | null; status?: string },
): void {
  db.prepare(
    `INSERT INTO recipe_lane_sessions (recipe_instance_id, lane, cli_session_id, status, spawned_at)
       VALUES (@recipe_instance_id, @lane, @cli_session_id, COALESCE(@status, 'live'), @spawned_at)
     ON CONFLICT(recipe_instance_id, lane) DO UPDATE SET
       cli_session_id = COALESCE(excluded.cli_session_id, recipe_lane_sessions.cli_session_id),
       status = COALESCE(@status, recipe_lane_sessions.status)`,
  ).run({
    recipe_instance_id: row.recipe_instance_id,
    lane: row.lane,
    cli_session_id: row.cli_session_id,
    status: row.status ?? null,
    spawned_at: Date.now(),
  });
}

export function getLaneSession(db: Database, recipe_instance_id: string, lane: string): LaneSessionRow | undefined {
  return db.prepare(`SELECT * FROM recipe_lane_sessions WHERE recipe_instance_id = ? AND lane = ?`)
    .get(recipe_instance_id, lane) as LaneSessionRow | undefined;
}

export function listLaneSessions(db: Database, recipe_instance_id: string): LaneSessionRow[] {
  return db.prepare(`SELECT * FROM recipe_lane_sessions WHERE recipe_instance_id = ?`)
    .all(recipe_instance_id) as LaneSessionRow[];
}

export function resolveLaneBySession(db: Database, cli_session_id: string): { recipe_instance_id: string; lane: string } | null {
  const r = db.prepare(
    `SELECT recipe_instance_id, lane FROM recipe_lane_sessions WHERE cli_session_id = ? ORDER BY spawned_at DESC LIMIT 1`,
  ).get(cli_session_id) as { recipe_instance_id: string; lane: string } | undefined;
  return r ?? null;
}

export function setLaneStatus(db: Database, recipe_instance_id: string, lane: string, status: string): void {
  db.prepare(`UPDATE recipe_lane_sessions SET status = ? WHERE recipe_instance_id = ? AND lane = ?`)
    .run(status, recipe_instance_id, lane);
}
