/**
 * main-agent-session-id.ts
 *
 * Persistence for the main agent's session id so the agent can RESUME
 * its prior conversation across `clawdevbox start` invocations + manual
 * restarts.
 *
 * Storage:
 *   <projectDir>/.clawdevbox/main-agent-session-id
 *
 * A plain text file containing one line: the UUIDv4 used as the
 * agent CLI's `--session-id`. Project-local so different projects keep
 * separate main-agent threads.
 *
 * Lifecycle:
 *   - `loadOrCreate(projectDir)` reads the file. Missing/invalid → mint
 *     a fresh UUIDv4, persist it, return `{ id, isNew: true }`. Otherwise
 *     return `{ id, isNew: false }`. Callers use `isNew` to decide
 *     between `init.kind: 'new'` (first launch) vs `'resume'` (subsequent).
 *   - `reset(projectDir)` deletes the persisted id. Next `loadOrCreate`
 *     mints a fresh one. Used by the "New Session" button so the user
 *     can intentionally start a clean conversation.
 *
 * The agent CLIs handle the id differently:
 *   - copilot: `--session-id <uuid>` works for BOTH new and resume; the
 *     CLI inspects its local store and creates-if-missing.
 *   - claude:  `--session-id <uuid>` is new-only; `--resume <uuid>` is
 *     resume. The provider chooses based on `init.kind`.
 *   - agency:  treats `init.session_id` opaquely.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.ts';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdPath(projectDir: string): string {
  return join(projectDir, '.clawdevbox', 'main-agent-session-id');
}

/**
 * Read the persisted main-agent session id for this project. If none
 * exists (or the file content isn't a valid UUID), mint a fresh one and
 * persist it.
 *
 * @returns the session id + whether this call created a new one.
 */
export function loadOrCreateMainAgentSessionId(projectDir: string): { id: string; isNew: boolean } {
  const path = sessionIdPath(projectDir);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (UUID_REGEX.test(raw)) {
        return { id: raw, isNew: false };
      }
      logger.warn({ path, raw: raw.slice(0, 40) }, 'main-agent-session-id: persisted value is not a UUID; replacing');
    } catch (err) {
      logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'main-agent-session-id: read failed; minting new');
    }
  }
  const id = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id + '\n', 'utf8');
  } catch (err) {
    logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'main-agent-session-id: persist failed; agent will not resume across restarts');
  }
  return { id, isNew: true };
}

/**
 * Forget the persisted main-agent session id. The next
 * `loadOrCreateMainAgentSessionId` call will mint a fresh one — used
 * by the SPA's "New Session" button.
 */
export function resetMainAgentSessionId(projectDir: string): void {
  const path = sessionIdPath(projectDir);
  if (existsSync(path)) {
    try { rmSync(path); }
    catch (err) {
      logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'main-agent-session-id: reset failed');
    }
  }
}
