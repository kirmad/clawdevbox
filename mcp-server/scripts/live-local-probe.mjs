#!/usr/bin/env node
/**
 * scripts/live-local-probe.mjs — MAINTAINED, explicit opt-in live probe runner.
 *
 * Runs the non-mocked local-trigger probes (tests/live/probes.mjs) against the
 * REAL configured resources on this box: the installed local.recipe-cron
 * script, the team-vault local.vault-test script, the git-tracked memory-sync
 * script, the running MCP server, the live SQLite DB, and the real memory
 * vault chain.
 *
 * SAFETY: recipe-cron runs dry (empty spawn_url), vault-test only echoes, and
 * memory-sync's spawn_url is a loopback recorder — so no agent is spawned and
 * no vault is committed/pulled/pushed. Every vault's git refs are asserted
 * unchanged before/after.
 *
 * OPT-IN: refuses to run unless CDB_LIVE_PROBE=1.
 *
 * Output: a SANITIZED JSON report (private remote URLs redacted) written to
 *   $CDB_LIVE_PROBE_REPORT (default: <os tmp>/cdb-live-local-probe-report.json).
 * Exit code: 0 iff every probe passed; non-zero on any probe failure.
 *
 *   CDB_LIVE_PROBE=1 node scripts/live-local-probe.mjs
 *   npm run test:triggers:live:local
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAllProbes } from '../tests/live/probes.mjs';

function log(...a) { process.stderr.write(a.join(' ') + '\n'); }

async function main() {
  if (process.env.CDB_LIVE_PROBE !== '1') {
    log('[live-local-probe] SKIPPED — set CDB_LIVE_PROBE=1 to run the non-mocked live probes.');
    log('[live-local-probe] This touches the real MCP server, live DB, and memory vault chain (read/dry-run only).');
    process.exit(0);
  }

  const reportPath = process.env.CDB_LIVE_PROBE_REPORT || join(tmpdir(), 'cdb-live-local-probe-report.json');

  let report;
  try {
    report = await runAllProbes();
  } catch (err) {
    report = {
      schema: 'cdb.live-local-probe/v1',
      generated_at: new Date().toISOString(),
      ok: false,
      fatal: String(err?.stack || err),
      summary: { total: 0, passed: 0, failed: ['<fatal>'] },
    };
  }

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  // Human-readable summary to stderr; report path + machine JSON stay clean.
  log('');
  log('=== live-local-probe report ===');
  log(`report: ${reportPath}`);
  if (report.host) log(`mcp: ${report.host.mcp_url} reachable=${report.host.mcp_reachable}`);
  for (const p of report.probes ?? []) {
    log(`\n[${p.ok ? 'PASS' : 'FAIL'}] ${p.name}`);
    for (const c of p.checks ?? []) {
      log(`   ${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : `  — ${c.detail ?? ''}`}`);
    }
  }
  if (report.fatal) log(`\nFATAL: ${report.fatal}`);
  log('');
  log(`summary: ${report.summary?.passed ?? 0}/${report.summary?.total ?? 0} probes passed` +
    (report.summary?.failed?.length ? ` (failed: ${report.summary.failed.join(', ')})` : ''));

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { log('unexpected: ' + (err?.stack || err)); process.exit(1); });
