/** Quick read-only check of teams-listener daemon status. */
import BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readDaemonLog } from '../src/daemon-process-runner.ts';

const db = new BetterSqlite3(join(homedir(), '.clawdevbox', 'clawdevbox.db'), { readonly: true });

const d = db.prepare('SELECT * FROM daemons WHERE id = ?').get('dmn-teams-listener');
console.log('DAEMON:', d ? `id=${d.id} enabled=${d.enabled} restart_count=${d.restart_count} next_restart_at=${d.next_restart_at} last_error=${d.last_error}` : 'NOT FOUND');

const runs = db.prepare('SELECT * FROM daemon_runs WHERE daemon_id = ? ORDER BY started_at DESC LIMIT 5').all('dmn-teams-listener');
console.log(`RUNS (${runs.length}):`);
for (const r of runs) {
  const dur = r.exited_at ? `${r.exited_at - r.started_at}ms` : 'live';
  console.log(`  ${r.id} ${r.status} pid=${r.pid} dur=${dur} exit=${r.exit_code} sig=${r.signal} err=${r.error}`);
}

if (runs[0]?.log_path) {
  console.log('---LATEST LOG TAIL---');
  console.log(readDaemonLog(runs[0].log_path, 4096));
}

db.close();
