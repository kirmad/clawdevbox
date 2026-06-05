/**
 * Prune empty workspaces — workspaces that have NO agent_sessions,
 * NO artifacts, NO recipe_instances, and NO triggers / fires / daemons
 * referencing them. These accumulate from test runs and the
 * auto-managed-workspace feature (1250+ rows is realistic).
 *
 * Effects of NOT cleaning up:
 *   - findArtifact / readArchivedTerminalLog / findInstanceWorkspace
 *     iterate every workspace (1250 file syscalls per call → GC pressure)
 *   - On-disk index.json bloats (one line per workspace)
 *
 * This script:
 *   1. Identifies workspaces with no referencing rows in any of the
 *      tables that have a FK to workspaces.
 *   2. Filters to workspaces whose disk dir doesn't exist anymore OR
 *      is empty (so we never delete a project the user is actively using).
 *   3. Prints the plan, asks for confirmation, then deletes.
 *
 * Run with `--yes` to skip the prompt.
 */
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = join(homedir(), '.clawdevbox', 'clawdevbox.db');
const db = new BetterSqlite3(dbPath);
db.pragma('foreign_keys = ON');

const totalBefore = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
console.log(`workspaces table: ${totalBefore} rows`);

// Tables that reference workspaces.id (per migrations.ts V1+v7).
const REFERENCING = [
  'triggers',
  'recipe_instances',
  'agent_sessions',
  'artifacts',
  'inbox_items',
  'fires',
  'daemons',
];

// Find workspaces with NO referencing rows in any of the above.
const unreferencedQuery = `
  SELECT w.id, w.path, w.created_at
  FROM workspaces w
  WHERE NOT EXISTS (SELECT 1 FROM triggers          t WHERE t.workspace_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM recipe_instances ri WHERE ri.workspace_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM agent_sessions   a  WHERE a.workspace_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM artifacts        ar WHERE ar.workspace_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM inbox_items      ii WHERE ii.workspace_id = w.id)
    AND NOT EXISTS (SELECT 1 FROM fires            f  WHERE f.workspace_id  = w.id)
    AND NOT EXISTS (SELECT 1 FROM daemons          dm WHERE dm.workspace_id = w.id)
  ORDER BY w.created_at ASC
`;
const unreferenced = db.prepare(unreferencedQuery).all();
console.log(`unreferenced workspaces: ${unreferenced.length}`);

// Safety: only delete workspaces whose disk dir doesn't exist or is empty
// (skip any actively-used project dir even if the DB row has no refs).
function isSafeToDelete(p) {
  if (!existsSync(p)) return { safe: true, reason: 'no-disk-dir' };
  try {
    const entries = readdirSync(p);
    if (entries.length === 0) return { safe: true, reason: 'empty-dir' };
    // .clawdevbox subdir + nothing else is also safe (auto-created scaffolding).
    if (entries.length === 1 && entries[0] === '.clawdevbox') {
      const claw = join(p, '.clawdevbox');
      try {
        const clawEntries = readdirSync(claw);
        // Just the auto-generated workspace.json + triggers.json + empty subdirs.
        const allEmpty = clawEntries.every((e) => {
          const ep = join(claw, e);
          try {
            const s = statSync(ep);
            if (s.isFile()) return e === 'workspace.json' || e === 'triggers.json';
            if (s.isDirectory()) return readdirSync(ep).length === 0;
            return false;
          } catch { return false; }
        });
        if (allEmpty) return { safe: true, reason: 'empty-scaffolding' };
      } catch { /* ignore */ }
    }
    return { safe: false, reason: 'has-content' };
  } catch {
    return { safe: true, reason: 'unreadable' };
  }
}

const toDelete = [];
const skipped = [];
for (const w of unreferenced) {
  const { safe, reason } = isSafeToDelete(w.path);
  if (safe) {
    toDelete.push({ ...w, reason });
  } else {
    skipped.push({ ...w, reason });
  }
}
console.log(`safe to delete: ${toDelete.length}`);
console.log(`skipped (has content): ${skipped.length}`);

if (toDelete.length === 0) {
  console.log('nothing to do');
  db.close();
  process.exit(0);
}

// Show breakdown by reason
const reasonCounts = toDelete.reduce((m, w) => { m[w.reason] = (m[w.reason] ?? 0) + 1; return m; }, {});
console.log('breakdown:', reasonCounts);

if (!process.argv.includes('--yes')) {
  console.log('\nRun with --yes to actually delete. Sample (first 5):');
  for (const w of toDelete.slice(0, 5)) console.log(`  ${w.id}  ${w.reason}  ${w.path}`);
  db.close();
  process.exit(0);
}

// Delete in a single transaction.
const stmt = db.prepare('DELETE FROM workspaces WHERE id = ?');
const tx = db.transaction((rows) => {
  for (const w of rows) stmt.run(w.id);
});
tx(toDelete);

const totalAfter = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
console.log(`done: ${totalBefore} -> ${totalAfter} workspace rows (${totalBefore - totalAfter} deleted)`);

// Also rewrite the on-disk index.json so the in-memory listWorkspaces() also shrinks.
console.log('rewriting on-disk index.json...');
const indexPath = join(homedir(), '.clawdevbox', 'workspaces', 'index.json');
if (existsSync(indexPath)) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
  const remainingIds = new Set(db.prepare('SELECT id FROM workspaces').all().map((r) => r.id));
  const before = Object.keys(idx.workspaces ?? {}).length;
  for (const id of Object.keys(idx.workspaces ?? {})) {
    if (!remainingIds.has(id)) delete idx.workspaces[id];
  }
  const after = Object.keys(idx.workspaces).length;
  writeFileSync(indexPath, JSON.stringify(idx, null, 2) + '\n');
  console.log(`index.json: ${before} -> ${after} entries`);
} else {
  console.log(`(no index.json at ${indexPath} — skipping)`);
}

db.close();
