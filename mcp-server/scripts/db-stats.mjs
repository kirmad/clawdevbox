import BetterSqlite3 from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';

const db = new BetterSqlite3(join(homedir(), '.clawdevbox', 'clawdevbox.db'), { readonly: true });

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get().n;
    if (c > 0) console.log(`${t.name.padEnd(40)} ${String(c).padStart(8)} rows`);
  } catch (e) { console.log(t.name, 'ERR', e.message); }
}

console.log('\n--- Largest tables by total text length ---');
for (const t of tables) {
  try {
    const r = db.prepare(`SELECT SUM(LENGTH(quote("rowid"))) AS s, COUNT(*) AS n FROM "${t.name}"`).get();
    if (r.s > 100_000) console.log(`${t.name.padEnd(40)} ${Math.round(r.s / 1024)} KB rowid total, ${r.n} rows`);
  } catch {}
}

console.log('\n--- step_events recent activity ---');
try {
  const r = db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS latest, MIN(created_at) AS earliest FROM step_events`).get();
  console.log(JSON.stringify(r));
} catch (e) { console.log('step_events err:', e.message); }
db.close();
