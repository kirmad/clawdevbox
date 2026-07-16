/**
 * Legacy-file detection — INFO-level boot-time warning for the file-backed
 * JSON stores that the SQLite kernel replaces.
 *
 * Per spec §4.5, the kernel does NOT read, delete, or move these files —
 * it just notes their presence so the operator sees a clear "you have
 * legacy data here; re-register what you want" signal. The `kv` table
 * remembers paths we've already warned about so each path is only logged
 * once per install (subsequent boots stay quiet).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { ResolvedConfig } from '../config.ts';
import { logger } from '../logger.ts';

const KV_PREFIX = 'legacy_file_seen:';

function collectCandidatePaths(cfg: ResolvedConfig): string[] {
  const out: string[] = [];
  out.push(join(cfg.projectDir, '.clawdevbox', 'triggers.json'));
  out.push(join(cfg.globalDir, 'inbox.json'));

  // <workspacesRoot>/*/.clawdevbox/triggers.json
  if (existsSync(cfg.workspacesRoot)) {
    try {
      for (const entry of readdirSync(cfg.workspacesRoot)) {
        const wsDir = join(cfg.workspacesRoot, entry);
        try {
          if (!statSync(wsDir).isDirectory()) continue;
        } catch {
          continue;
        }
        out.push(join(wsDir, '.clawdevbox', 'triggers.json'));
      }
    } catch {
      // best-effort; the dir may have just been deleted
    }
  }

  // <projectDir>/.clawdevbox/recipe-instances/*.json
  // and <workspacesRoot>/*/.clawdevbox/recipe-instances/*.json
  const recipeRoots = [join(cfg.projectDir, '.clawdevbox', 'recipe-instances')];
  if (existsSync(cfg.workspacesRoot)) {
    try {
      for (const entry of readdirSync(cfg.workspacesRoot)) {
        recipeRoots.push(
          join(cfg.workspacesRoot, entry, '.clawdevbox', 'recipe-instances'),
        );
      }
    } catch {
      // ignore
    }
  }
  for (const root of recipeRoots) {
    if (!existsSync(root)) continue;
    try {
      for (const f of readdirSync(root)) {
        if (f.endsWith('.json')) out.push(join(root, f));
      }
    } catch {
      // ignore
    }
  }

  return out.map((p) => resolve(p));
}

/**
 * Scan for legacy file-backed JSON stores and emit a one-time INFO warning
 * for each one found. Records the warning in the `kv` table so we don't
 * spam on subsequent boots.
 */
export function scanLegacyFiles(cfg: ResolvedConfig, db: Database): void {
  const candidates = collectCandidatePaths(cfg);
  const getStmt = db.prepare('SELECT value FROM kv WHERE key = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  );
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const key = `${KV_PREFIX}${path}`;
    const seen = getStmt.get(key) as { value: string } | undefined;
    if (seen) continue;
    logger.info(
      { path },
      `legacy file detected at ${path} — ignored; re-register if needed`,
    );
    upsertStmt.run(
      key,
      JSON.stringify({ first_seen_at: Date.now() }),
      Date.now(),
    );
  }
}
