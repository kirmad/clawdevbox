/**
 * SQLite database singleton for the clawdevbox kernel.
 *
 * Exposes a module-scope singleton because the DB is a per-process resource
 * (single WAL writer) and threading it through every call-site would be
 * gratuitous. Tests can override via `setDatabaseForTesting()`.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { migrations } from './migrations.ts';

let db: Database | null = null;
let dbPath: string | null = null;

export interface OpenedDatabase {
  db: Database;
  path: string;
  schemaVersion: number;
}

export function openDatabase(globalDir: string): OpenedDatabase {
  if (db) {
    return { db, path: dbPath!, schemaVersion: currentSchemaVersion(db) };
  }
  mkdirSync(globalDir, { recursive: true });
  const path = join(globalDir, 'clawdevbox.db');
  const instance = new BetterSqlite3(path);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('synchronous = NORMAL');
  runMigrations(instance);
  db = instance;
  dbPath = path;
  return { db, path, schemaVersion: currentSchemaVersion(db) };
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error('database not open — call openDatabase() first');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // best-effort
    }
    db = null;
    dbPath = null;
  }
}

export function setDatabaseForTesting(instance: Database | null, path = ':memory:'): void {
  db = instance;
  dbPath = instance ? path : null;
}

function currentSchemaVersion(instance: Database): number {
  const row = instance
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { name?: string } | undefined;
  if (!row) return 0;
  const r = instance
    .prepare('SELECT MAX(version) AS v FROM schema_version')
    .get() as { v: number | null };
  return r?.v ?? 0;
}

/**
 * Runs every migration whose `version` is greater than the current max
 * `schema_version.version`. Each migration runs inside a transaction so a
 * partial failure rolls back cleanly.
 */
export function runMigrations(instance: Database): void {
  const hasTable = instance
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get();
  const current = hasTable
    ? ((instance.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0)
    : 0;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    const tx = instance.transaction(() => {
      migration.up(instance);
      instance
        .prepare('INSERT INTO schema_version(version) VALUES (?)')
        .run(migration.version);
    });
    tx();
  }
}
