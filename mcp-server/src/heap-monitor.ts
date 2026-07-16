/**
 * heap-monitor.ts
 *
 * Lightweight memory observability for `clawdevbox start`. We're chasing a
 * slow OOM (heap creeps past 4 GB after ~30 min of uptime); this module
 * gives us two visible signals so the next leak is debuggable instead of
 * mysterious:
 *
 *   1. **Periodic heap usage log** (default every 60 s) — single pino line
 *      with rss / heapUsed / heapTotal / external in MB plus the
 *      configured max-old-space-size (parsed from `--max-old-space-size`
 *      arg or `NODE_OPTIONS`). Sampled with `process.memoryUsage()` which
 *      is cheap (microseconds), so the cadence is safe to enable in prod.
 *
 *   2. **Automatic heap snapshot at high-water mark** — when heapUsed
 *      crosses `snapshotThresholdRatio * maxOldSpaceMB` (default 0.80),
 *      write a `<dir>/clawdevbox-heap-<ts>.heapsnapshot` via
 *      `v8.writeHeapSnapshot()` and log the path. We only snapshot ONCE
 *      per process to avoid flooding disk during a thrash phase; rearm
 *      via `armSnapshot()` if a programmatic caller wants another.
 *
 * Why this module and not `--heapsnapshot-near-heap-limit`?
 *   That built-in flag works, but it only fires when the V8 limit is
 *   _already_ being hit (the process may be too OOM-thrashed to flush).
 *   This module catches the climb earlier and lets us correlate the
 *   snapshot with logger context.
 *
 * Why default to 80%?
 *   At 80% V8 is still doing useful work (GC isn't yet thrashing). The
 *   snapshot itself allocates ~heapTotal bytes during dumping, so taking
 *   it at 80% is safer than at 95%.
 */

import { writeHeapSnapshot } from 'node:v8';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger as defaultLogger } from './logger.ts';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_RATIO = 0.80;

export interface HeapMonitorOptions {
  /** Where to drop heap snapshots when threshold is crossed. */
  snapshotDir: string;
  /** Sampling interval. Default: 60 s. */
  intervalMs?: number;
  /**
   * Take the snapshot when `heapUsed / maxOldSpaceMB` reaches this ratio.
   * Default: 0.80. Set to a value > 1 to disable auto-snapshots.
   */
  snapshotThresholdRatio?: number;
}

export interface HeapMonitorHandle {
  /** Stop sampling. Idempotent. */
  stop: () => void;
  /** Re-enable the auto-snapshot trigger if it has already fired. */
  armSnapshot: () => void;
  /** Force a snapshot now and return the file path (or null on failure). */
  snapshotNow: () => string | null;
  /** Latest sample (also published with each periodic log). */
  lastSample: () => HeapSample;
}

export interface HeapSample {
  ts: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /** Configured V8 max-old-space-size in MB (parsed from CLI / NODE_OPTIONS). */
  maxOldSpaceMb: number | null;
  /** heapUsedMb / maxOldSpaceMb, or null when maxOldSpaceMb is unknown. */
  usedRatio: number | null;
}

const log = defaultLogger.child({ svc: 'clawdevbox', component: 'heap-monitor' });

/**
 * Parse the effective `--max-old-space-size=N` (MB) from the process flags
 * Node was started with. Looks at three places, in order of precedence:
 *   1. process.execArgv (flags passed directly to `node ...`)
 *   2. NODE_OPTIONS env var (flags hoisted into argv at startup)
 *   3. process.argv (some launchers pass it as a regular arg)
 *
 * Returns null when the flag isn't set anywhere — V8's default depends on
 * machine RAM (~4 GB on a 16 GB box) so we can't reliably guess.
 */
export function parseMaxOldSpaceMb(): number | null {
  const SOURCES: string[] = [
    ...process.execArgv,
    ...(process.env.NODE_OPTIONS ?? '').split(/\s+/),
    ...process.argv,
  ];
  // Both --max-old-space-size=N and --max-old-space-size N (space-separated)
  // are accepted by V8.
  for (let i = 0; i < SOURCES.length; i++) {
    const tok = SOURCES[i] ?? '';
    if (tok.startsWith('--max-old-space-size=')) {
      const n = Number(tok.slice('--max-old-space-size='.length));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (tok === '--max-old-space-size' && i + 1 < SOURCES.length) {
      const n = Number(SOURCES[i + 1]);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

function bytesToMb(n: number): number {
  return Math.round((n / (1024 * 1024)) * 10) / 10;
}

function sample(maxOldSpaceMb: number | null): HeapSample {
  const m = process.memoryUsage();
  const heapUsedMb = bytesToMb(m.heapUsed);
  return {
    ts: Date.now(),
    rssMb: bytesToMb(m.rss),
    heapUsedMb,
    heapTotalMb: bytesToMb(m.heapTotal),
    externalMb: bytesToMb(m.external),
    arrayBuffersMb: bytesToMb(m.arrayBuffers ?? 0),
    maxOldSpaceMb,
    usedRatio: maxOldSpaceMb ? Math.round((heapUsedMb / maxOldSpaceMb) * 1000) / 1000 : null,
  };
}

export function startHeapMonitor(opts: HeapMonitorOptions): HeapMonitorHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdRatio = opts.snapshotThresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
  const maxOldSpaceMb = parseMaxOldSpaceMb();

  let snapshotArmed = true;
  let last: HeapSample = sample(maxOldSpaceMb);

  try {
    mkdirSync(opts.snapshotDir, { recursive: true });
  } catch {
    /* best effort — snapshotNow() surfaces a hard error if it later fails */
  }

  log.info(
    { intervalMs, thresholdRatio, maxOldSpaceMb, snapshotDir: opts.snapshotDir },
    'heap-monitor: started',
  );

  function snapshotNow(): string | null {
    try {
      const ts = new Date(Date.now()).toISOString().replace(/[:.]/g, '-');
      const file = join(opts.snapshotDir, `clawdevbox-heap-${ts}.heapsnapshot`);
      writeHeapSnapshot(file);
      log.warn({ file, sample: last }, 'heap-monitor: heap snapshot written');
      return file;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'heap-monitor: writeHeapSnapshot failed',
      );
      return null;
    }
  }

  function tick(): void {
    last = sample(maxOldSpaceMb);
    log.info(last, 'heap-monitor: sample');
    if (snapshotArmed && last.usedRatio !== null && last.usedRatio >= thresholdRatio) {
      snapshotArmed = false;
      log.warn(
        { sample: last, thresholdRatio },
        'heap-monitor: heap above threshold — capturing snapshot',
      );
      snapshotNow();
    }
  }

  const interval = setInterval(tick, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();
  // Take a baseline sample immediately so /api/heap-status returns useful
  // data even before the first tick fires.
  tick();

  return {
    stop: () => {
      try { clearInterval(interval); } catch { /* ignore */ }
    },
    armSnapshot: () => { snapshotArmed = true; },
    snapshotNow,
    lastSample: () => last,
  };
}
