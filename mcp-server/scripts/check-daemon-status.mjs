#!/usr/bin/env node
// Quick read-only daemon + recent runs view from clawdevbox.db.
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), '.clawdevbox', 'clawdevbox.db');
const db = new Database(dbPath, { readonly: true });

console.log('--- daemons schema ---');
for (const row of db.prepare("PRAGMA table_info(daemons)").all()) {
  console.log(JSON.stringify(row));
}

console.log('--- daemons ---');
for (const row of db.prepare('SELECT * FROM daemons LIMIT 5').all()) {
  console.log(JSON.stringify(row));
}

console.log('--- daemon_runs schema ---');
for (const row of db.prepare("PRAGMA table_info(daemon_runs)").all()) {
  console.log(JSON.stringify(row));
}

console.log('--- daemon_runs (last 5) ---');
for (const row of db.prepare('SELECT * FROM daemon_runs ORDER BY rowid DESC LIMIT 5').all()) {
  console.log(JSON.stringify(row));
}
