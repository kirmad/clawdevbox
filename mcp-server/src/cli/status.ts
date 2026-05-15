/**
 * cli/status.ts
 *
 * `clawdevbox status` — print whether the background service is running
 * and whether OS auto-start is registered. Reads `<globalDir>/service.json`
 * and queries the OS (Task Scheduler / launchd / systemd-user) for the
 * auto-start state.
 *
 * Exit code: 0 if a service entry exists AND the process is alive; 1
 * otherwise — useful for shell scripting (`clawdevbox status && ...`).
 */

import { applyConfigToEnv, ConfigError, resolveConfig } from '../config.ts';
import { logger } from '../logger.ts';
import {
  autoStartPlatform,
  fetchTunnelStatus,
  isAutoStartInstalled,
  isProcessAlive,
  readServiceState,
} from '../service.ts';
import { renderTunnelInfo } from './tunnel-display.ts';
import type { Flags } from './index.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export async function runStatus(flags: Flags): Promise<void> {
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
  const platformLabel = autoStartPlatform();
  const autoStart = platformLabel === 'unsupported'
    ? { installed: false, platform: platformLabel }
    : isAutoStartInstalled();

  const lines: string[] = [];
  lines.push(`Global dir:  ${cfg.globalDir}`);
  lines.push(`Platform:    ${platformLabel}`);
  if (!state) {
    lines.push(`Service:     not installed (no ${cfg.globalDir}/service.json)`);
  } else {
    const alive = isProcessAlive(state.pid);
    lines.push(`Service:     ${alive ? 'running' : 'NOT running (stale state)'}`);
    lines.push(`  pid:       ${state.pid}`);
    lines.push(`  port:      ${state.port ?? '?'}`);
    lines.push(`  version:   ${state.version}`);
    lines.push(`  started:   ${new Date(state.started_at).toISOString()}`);
    lines.push(`  exec:      ${state.exec_path} ${state.exec_args.join(' ')}`);
  }
  lines.push(`Auto-start:  ${autoStart.installed ? 'installed' : 'not installed'}`);
  lines.push(
    `Tunnel cfg:  ${cfg.tunnel.kind}${cfg.tunnel.name ? ` "${cfg.tunnel.name}"` : ''}`,
  );

  process.stdout.write(lines.join('\n') + '\n');

  // If the service is running AND a tunnel is configured, probe the
  // running server for the live tunnel URL + render a QR code. Best
  // effort: we don't fail status if the server is unreachable or the URL
  // hasn't been minted yet.
  const serviceUp = !!state && isProcessAlive(state.pid);
  if (serviceUp && cfg.tunnel.kind === 'devtunnel' && cfg.http.token && state) {
    const port = state.port ?? cfg.http.port;
    const tunnel = await fetchTunnelStatus({
      host: cfg.http.host,
      port,
      token: cfg.http.token,
      timeoutMs: 3000,
      waitForUrl: false,
    });
    if (tunnel) {
      if (tunnel.url) {
        renderTunnelInfo({
          url: tunnel.url,
          inspectUrl: tunnel.inspect_url ?? null,
        });
      } else if (tunnel.error) {
        process.stdout.write(`\nTunnel:      ${tunnel.error}\n`);
      } else {
        process.stdout.write(
          `\nTunnel:      configured (devtunnel "${cfg.tunnel.name ?? '?'}") but URL not yet bound — try again in a few seconds.\n`,
        );
      }
    } else {
      process.stdout.write(
        `\nTunnel:      could not reach http://${cfg.http.host}:${port}/api/tunnel/status (auth or network issue)\n`,
      );
    }
  }

  if (state && isProcessAlive(state.pid)) {
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }
}
