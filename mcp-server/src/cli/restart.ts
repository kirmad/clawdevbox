/**
 * cli/restart.ts
 *
 * `clawdevbox restart` — halt the running background service (if any) and
 * re-install it with the current config. Equivalent to
 * `clawdevbox stop && clawdevbox start --service` but as a single
 * idempotent operation: it works whether or not a service is currently
 * running.
 *
 * Auto-start registration is preserved (we don't unregister); the
 * underlying `reg add /f` / `launchctl load -w` / systemd `enable`
 * commands overwrite any prior registration so the install path stays in
 * sync with whatever node binary + script path we're running from today.
 *
 * After the new service is healthy, the same tunnel URL + QR code is
 * printed as `start --service`.
 */

import { applyConfigToEnv, ConfigError, resolveConfig, type ResolvedConfig } from '../config.ts';
import { logger } from '../logger.ts';
import { isProcessAlive, readServiceState, stopService } from '../service.ts';
import { installAsService } from './start.ts';
import type { Flags } from './index.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  if (typeof v !== 'string') return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new ConfigError(`--${key} must be an integer in 1..65535 (got ${v})`);
  }
  return n;
}

export async function runRestart(flags: Flags): Promise<void> {
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig({
      projectDir: str(flags, 'project'),
      globalDir: str(flags, 'global'),
      workspacesRoot: str(flags, 'workspaces-root'),
      port: num(flags, 'port'),
      host: str(flags, 'host'),
      token: str(flags, 'token'),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ err: err.message }, 'config error');
      process.exit(2);
    }
    throw err;
  }
  applyConfigToEnv(cfg);

  if (!cfg.http.token) {
    logger.error(
      { projectDir: cfg.projectDir },
      'no bearer token configured — run `clawdevbox init` (or pass --token / set CLAWDEVBOX_TOKEN)',
    );
    process.exit(2);
  }

  // 1) Stop any running instance.
  const prior = readServiceState(cfg.globalDir);
  const priorAlive = prior ? isProcessAlive(prior.pid) : false;
  if (priorAlive && prior) {
    process.stdout.write(`Stopping previous instance (pid ${prior.pid})...\n`);
    const stop = stopService(cfg.globalDir);
    if (!stop.stopped && stop.pid !== null) {
      // stopService failed — surface the reason but try the install anyway;
      // installAsService's "already running" guard will catch it again.
      process.stdout.write(
        `Warning: could not cleanly stop pid ${stop.pid}: ${stop.reason ?? '?'}\n`,
      );
    }
    // Give the OS a moment to release the port so the new spawn can bind.
    await new Promise((r) => setTimeout(r, 500));
  } else if (prior && !priorAlive) {
    process.stdout.write(`Previous service.json was stale; cleared.\n`);
  } else {
    process.stdout.write(`No running service to stop — installing fresh.\n`);
  }

  // 2) Re-install via the same code path as `start --service`. This
  //    re-registers OS auto-start with the current exec path (so the
  //    install survives node-version upgrades / npm-link changes), writes
  //    a fresh service.json, and probes /healthz before reporting success.
  // Force `flags.service = true` so installAsService is invoked unambiguously.
  await installAsService(cfg, { ...flags, service: true });
}
