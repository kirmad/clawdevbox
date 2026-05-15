/**
 * cli/stop.ts
 *
 * `clawdevbox stop` — halt the background service started by
 * `clawdevbox start --service`. Reads the PID from
 * `<globalDir>/service.json`, sends the right OS-level signal, and clears
 * the state file. Idempotent: if no service is recorded or the recorded
 * PID is already gone, reports so without erroring.
 *
 * Does NOT remove the OS auto-start registration — use
 * `clawdevbox uninstall-service` for that.
 */

import { applyConfigToEnv, ConfigError, resolveConfig } from '../config.ts';
import { logger } from '../logger.ts';
import { readServiceState, stopService } from '../service.ts';
import type { Flags } from './index.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export async function runStop(flags: Flags): Promise<void> {
  let cfg;
  try {
    cfg = resolveConfig({
      projectDir: str(flags, 'project'),
      globalDir: str(flags, 'global'),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ err: err.message }, 'config error');
      process.exit(2);
    }
    throw err;
  }
  applyConfigToEnv(cfg);

  const state = readServiceState(cfg.globalDir);
  const result = stopService(cfg.globalDir);
  if (result.stopped) {
    process.stdout.write(
      `Stopped clawdevbox service (pid ${result.pid}${
        state?.port ? `, port ${state.port}` : ''
      }).\n`,
    );
    return;
  }
  // Not stopped — either nothing was running, or the kill failed.
  const reason = result.reason ?? 'unknown';
  if (result.pid === null) {
    process.stdout.write(`No service is running (no ${cfg.globalDir}/service.json).\n`);
    return;
  }
  process.stdout.write(
    `Could not stop service (pid ${result.pid}): ${reason}\n`,
  );
  process.exitCode = 1;
}
