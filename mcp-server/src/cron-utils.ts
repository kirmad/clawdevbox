/**
 * cron-utils.ts
 *
 * Per-request helpers that turn raw cron strings into UI-friendly
 * fields:
 *   - `cronLabel(expr)`         → human-readable ("every 5 minutes")
 *   - `nextRunAfter(expr, now)` → unix-ms timestamp of the next fire,
 *                                 or null if the expression is invalid /
 *                                 disabled.
 *
 * Both wrap third-party libraries (`cronstrue`, `cron-parser`) in
 * try/catch so a malformed cron in a single trigger registration never
 * tanks the whole `/api/triggers` endpoint.
 */

import cronParser from 'cron-parser';
import cronstrue from 'cronstrue';
import { logger } from './logger.ts';

/** Returns a human-readable string ("every 5 minutes") or null on parse error. */
export function cronLabel(expr: string | null | false | undefined): string | null {
  if (!expr || typeof expr !== 'string') return null;
  try {
    return cronstrue.toString(expr, { verbose: false }).toLowerCase();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), expr },
      'cron-utils: failed to humanize cron',
    );
    return null;
  }
}

/**
 * Compute the next fire time AFTER `now`. We deliberately key off
 * Date.now() (not the trigger's last_run_at) so a trigger that missed
 * runs while the service was down still shows a sensible "next fire in
 * 2m" rather than a stale past timestamp.
 */
export function nextRunAfter(
  expr: string | null | false | undefined,
  now: number = Date.now(),
): number | null {
  if (!expr || typeof expr !== 'string') return null;
  try {
    const interval = cronParser.parseExpression(expr, { currentDate: new Date(now) });
    return interval.next().getTime();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), expr },
      'cron-utils: failed to compute next fire',
    );
    return null;
  }
}
