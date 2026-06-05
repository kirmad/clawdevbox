/**
 * session-aliases-store.ts
 *
 * Maps caller-supplied friendly session names (e.g. "my-feature",
 * "pr-4547615", "demo") to stable GUIDs that the underlying agent CLI
 * (copilot --session-id, claude --session-id) requires.
 *
 * Used by the /spawn endpoint's smart routing so callers can use any
 * string as a session identifier without having to mint and remember
 * UUIDs themselves. The first time an unknown alias is presented, we
 * mint a new GUID and persist the mapping. Subsequent calls with the
 * same alias resolve to the same GUID, which copilot then uses to
 * resume the prior session.
 *
 * GUIDs in this codebase are RFC4122 UUIDs (lowercase, hyphenated).
 */

import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

export interface SessionAliasRow {
  alias: string;
  session_id: string;
  created_at: number;
}

export function getAlias(db: Database, alias: string): SessionAliasRow | null {
  const row = db
    .prepare('SELECT * FROM session_aliases WHERE alias = ?')
    .get(alias) as SessionAliasRow | undefined;
  return row ?? null;
}

export function insertAlias(db: Database, alias: string, sessionId: string): SessionAliasRow {
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO session_aliases (alias, session_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(alias) DO NOTHING`,
  ).run(alias, sessionId, created_at);
  // Re-read in case ON CONFLICT skipped: return whatever's there now.
  return getAlias(db, alias)!;
}

export function lookupAlias(
  db: Database,
  input: string | undefined | null,
): { guid: string; alias: string | null } | null {
  if (!input || typeof input !== 'string' || input.length === 0) return null;
  if (isGuid(input)) return { guid: input.toLowerCase(), alias: null };
  const existing = getAlias(db, input);
  if (!existing) return null;
  return { guid: existing.session_id, alias: input };
}

/**
 * Resolve a caller-supplied session identifier to a canonical GUID.
 *
 * - If `input` is a valid GUID, returns it unchanged (no alias row created).
 * - If `input` is anything else, treats it as a friendly alias:
 *     - Existing alias row → returns the mapped GUID.
 *     - Otherwise mints a new GUID + inserts the alias row, returns the GUID.
 *
 * Returns the resolved GUID and the alias (if any) so callers can echo
 * the mapping back in their response.
 */
export function resolveSessionId(
  db: Database,
  input: string | undefined | null,
): { guid: string; alias: string | null } {
  if (!input || typeof input !== 'string' || input.length === 0) {
    return { guid: randomUUID(), alias: null };
  }
  if (isGuid(input)) {
    return { guid: input.toLowerCase(), alias: null };
  }
  const existing = getAlias(db, input);
  if (existing) {
    return { guid: existing.session_id, alias: input };
  }
  const guid = randomUUID();
  insertAlias(db, input, guid);
  return { guid, alias: input };
}
