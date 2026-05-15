/**
 * cli/uninstall-service.ts
 *
 * `clawdevbox uninstall-service` — stop the running service (if any) and
 * remove the OS-level auto-start registration. Use this when you want the
 * service fully gone, not just halted until next login.
 *
 * Does NOT delete `<globalDir>/config.json` or any installed plugins; the
 * MCP server can still be run on-demand via `clawdevbox start` or
 * `clawdevbox mcp` after uninstall.
 */

import { applyConfigToEnv, ConfigError, resolveConfig } from '../config.ts';
import { logger } from '../logger.ts';
import {
  autoStartPlatform,
  isAutoStartInstalled,
  stopService,
  uninstallAutoStart,
} from '../service.ts';
import type { Flags } from './index.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export async function runUninstallService(flags: Flags): Promise<void> {
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

  const stop = stopService(cfg.globalDir);
  const lines: string[] = [];
  if (stop.stopped) {
    lines.push(`Stopped running service (pid ${stop.pid}).`);
  } else if (stop.pid === null) {
    lines.push(`No running service to stop.`);
  } else {
    lines.push(`Could not stop pid ${stop.pid}: ${stop.reason ?? 'unknown'}`);
  }

  if (autoStartPlatform() === 'unsupported') {
    lines.push(`Auto-start is not supported on this platform — nothing to uninstall.`);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  if (!isAutoStartInstalled().installed) {
    lines.push(`Auto-start was not installed.`);
    process.stdout.write(lines.join('\n') + '\n');
    return;
  }

  try {
    const r = uninstallAutoStart();
    lines.push(`Removed auto-start registration (${r.platform}).`);
  } catch (err) {
    lines.push(
      `Failed to remove auto-start: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.stdout.write(lines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(lines.join('\n') + '\n');
}
