/**
 * Test helper: opens an in-memory kernel DB and installs it via
 * setDatabaseForTesting so DB-backed stores (triggers, recipe-instances,
 * inbox) have a working DB without a real globalDir.
 */
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations, setDatabaseForTesting } from '../../src/db/index.ts';

let active = null;

export function setupTestDatabase() {
  if (active) return active;
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  setDatabaseForTesting(db);
  active = db;
  return db;
}

export function teardownTestDatabase() {
  if (active) {
    try { active.close(); } catch { /* ignore */ }
    active = null;
  }
  setDatabaseForTesting(null);
}
