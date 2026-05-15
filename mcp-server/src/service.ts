/**
 * service.ts
 *
 * Cross-platform background-service support for the Clawdevbox MCP server.
 *
 *   - `spawnDetached(...)`  spawns `clawdevbox start` (or whatever the
 *                            installer passes) as a fully detached process
 *                            and records the PID + port in
 *                            `<globalDir>/service.json`.
 *   - `stopService(ws)`     reads the state file, sends Stop-Process /
 *                            SIGTERM, clears the file.
 *   - `serviceStatus(ws)`   returns running flag + state file contents.
 *   - `installAutoStart` /
 *     `uninstallAutoStart`  register / remove an OS-level "start at login"
 *                           entry: Windows Task Scheduler (`schtasks`),
 *                           macOS LaunchAgent plist (`launchctl`), Linux
 *                           systemd-user unit (`systemctl --user`).
 *
 * The OS-specific installers shell out to the user's `schtasks` /
 * `launchctl` / `systemctl` — no extra dependency. Failures (e.g. tools
 * not on PATH) surface as exceptions for the CLI to print.
 *
 * State file schema (`<globalDir>/service.json`):
 *
 *   {
 *     pid: 12345,
 *     port: 5201,
 *     started_at: 1715534812000,
 *     version: "0.1.0",
 *     exec_path: "clawdevbox",
 *     exec_args: ["start", "--service-runner"]
 *   }
 */

import { spawnSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVICE_FILENAME = 'service.json';
export const SERVICE_TASK_NAME = 'ClawDevbox';
export const SERVICE_LAUNCHD_LABEL = 'com.clawdevbox.server';
export const SERVICE_SYSTEMD_UNIT = 'clawdevbox.service';

export interface ServiceState {
  pid: number;
  port: number | null;
  started_at: number;
  version: string;
  exec_path: string;
  exec_args: string[];
}

export function serviceStatePath(globalDir: string): string {
  return join(globalDir, SERVICE_FILENAME);
}

export function readServiceState(globalDir: string): ServiceState | null {
  const p = serviceStatePath(globalDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<ServiceState>;
    if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      port: typeof parsed.port === 'number' ? parsed.port : null,
      started_at: typeof parsed.started_at === 'number' ? parsed.started_at : 0,
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      exec_path: typeof parsed.exec_path === 'string' ? parsed.exec_path : '',
      exec_args: Array.isArray(parsed.exec_args) ? (parsed.exec_args as string[]) : [],
    };
  } catch {
    return null;
  }
}

export function writeServiceState(globalDir: string, state: ServiceState): void {
  const p = serviceStatePath(globalDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function clearServiceState(globalDir: string): void {
  const p = serviceStatePath(globalDir);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * `process.kill(pid, 0)` is a no-op signal that only checks permission.
 * Returns true when the process exists and we can signal it; false on
 * ESRCH or EPERM (the process is gone or we can't touch it).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we don't have permission — still alive.
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Spawn a fully-detached child process. On POSIX we set `detached: true` and
 * redirect stdio to `<globalDir>/service.log` so the child outlives the
 * parent AND the user can diagnose silent failures; on Windows we use the
 * same flags plus `windowsHide: true` so no console window flashes.
 *
 * The returned PID is recorded in `<globalDir>/service.json` by the caller.
 * If `logDir` is supplied, stdout/stderr are appended to
 * `<logDir>/service.log` (truncated to keep the file from growing
 * unbounded — last 1 MB only kept across spawns).
 */
export function spawnDetached(
  execPath: string,
  args: string[],
  opts: { logDir?: string } = {},
): { pid: number; logPath: string | null } {
  let stdio: 'ignore' | ['ignore', number, number];
  let logPath: string | null = null;

  if (opts.logDir) {
    mkdirSync(opts.logDir, { recursive: true });
    logPath = join(opts.logDir, 'service.log');
    // Truncate prior log to ~1 MB before each spawn so a long-running
    // service doesn't accumulate gigabytes of `pino` output.
    rotateLog(logPath, 1024 * 1024);
    const out = openSync(logPath, 'a');
    const err = openSync(logPath, 'a');
    stdio = ['ignore', out, err];
  } else {
    stdio = 'ignore';
  }

  const child = spawn(execPath, args, {
    detached: true,
    stdio,
    windowsHide: true,
    shell: false,
  });
  // Unref so the parent process can exit without waiting on the child.
  child.unref();
  if (!child.pid) {
    throw new Error(`Failed to spawn detached process: ${execPath} ${args.join(' ')}`);
  }
  return { pid: child.pid, logPath };
}

function rotateLog(path: string, maxBytes: number): void {
  try {
    const stat = statSync(path);
    if (stat.size <= maxBytes) return;
    // Keep tail; truncate from the head. Cheap and good-enough.
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const offset = stat.size - maxBytes;
      readSync(fd, buf, 0, maxBytes, offset);
      writeFileSync(path, buf);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort: missing file, permission issue, etc.
  }
}

/** Path to the service log file the detached child writes to. */
export function serviceLogPath(globalDir: string): string {
  return join(globalDir, 'service.log');
}

/**
 * Poll `http://<host>:<port>/api/tunnel/status` until the tunnel URL is
 * known (or timeout). Used by `init` and `status` to surface the public
 * devtunnel URL + QR code without each command duplicating the polling
 * logic.
 *
 * Returns the tunnel status object (`{ kind, url, ... }`) on success or
 * `null` if the request never succeeds. A 401 (no/invalid token) is also
 * treated as `null` so callers can fall back to printing config-only info.
 */
export async function fetchTunnelStatus(args: {
  host: string;
  port: number;
  token: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** When true, wait until `url` is non-null (or timeout). */
  waitForUrl?: boolean;
}): Promise<TunnelStatusResponse | null> {
  const timeoutMs = args.timeoutMs ?? 10000;
  const intervalMs = args.intervalMs ?? 400;
  const url = `http://${args.host}:${args.port}/api/tunnel/status`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.min(intervalMs * 2, 1000));
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${args.token}` },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) {
        const body = (await res.json()) as TunnelStatusResponse;
        if (!args.waitForUrl) return body;
        if (body.kind === 'none' || body.error || body.url) return body;
      }
    } catch {
      /* try again until deadline */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export interface TunnelStatusResponse {
  kind: 'none' | 'devtunnel';
  name?: string | null;
  port?: number | null;
  running?: boolean;
  url?: string | null;
  inspect_url?: string | null;
  error?: string | null;
  pid?: number | null;
}

/**
 * Stop the running service if one is recorded and alive. Returns details
 * about what happened so the CLI can render a friendly summary.
 */
export function stopService(globalDir: string): {
  stopped: boolean;
  pid: number | null;
  reason?: string;
} {
  const state = readServiceState(globalDir);
  if (!state) return { stopped: false, pid: null, reason: 'no service.json found' };
  if (!isProcessAlive(state.pid)) {
    clearServiceState(globalDir);
    return { stopped: false, pid: state.pid, reason: 'recorded process is not running (state cleared)' };
  }
  try {
    if (platform() === 'win32') {
      // Stop-Process on Windows isn't available via process.kill('SIGTERM')
      // for non-Node child processes the same way; we go through the OS
      // taskkill so a tree of child processes is also taken down. /T = tree,
      // /F = force (lets us bypass console-handler hangs).
      const r = spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (r.status !== 0 && isProcessAlive(state.pid)) {
        return {
          stopped: false,
          pid: state.pid,
          reason: `taskkill failed: ${r.stderr ?? r.stdout ?? `exit ${r.status}`}`,
        };
      }
    } else {
      process.kill(state.pid, 'SIGTERM');
    }
  } catch (err) {
    return {
      stopped: false,
      pid: state.pid,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  clearServiceState(globalDir);
  return { stopped: true, pid: state.pid };
}

// ============================================================================
// OS-level auto-start registration
// ============================================================================

export interface AutoStartInstallArgs {
  /** Full path to the executable that will run at login. */
  execPath: string;
  /** Arguments. The installer is responsible for whatever quoting the OS needs. */
  args: string[];
  /** Display label for the OS service / task. */
  label?: string;
}

export type AutoStartPlatform = 'win32' | 'darwin' | 'linux';

export function autoStartPlatform(): AutoStartPlatform | 'unsupported' {
  const p = platform();
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  return 'unsupported';
}

export function installAutoStart(args: AutoStartInstallArgs): {
  installed: boolean;
  path: string;
  platform: AutoStartPlatform;
} {
  const p = autoStartPlatform();
  if (p === 'unsupported') {
    throw new Error(`auto-start not supported on platform: ${platform()}`);
  }
  if (p === 'win32') return installWindowsTask(args);
  if (p === 'darwin') return installLaunchdAgent(args);
  return installSystemdUserUnit(args);
}

export function uninstallAutoStart(): { uninstalled: boolean; platform: AutoStartPlatform } {
  const p = autoStartPlatform();
  if (p === 'unsupported') {
    throw new Error(`auto-start not supported on platform: ${platform()}`);
  }
  if (p === 'win32') return uninstallWindowsTask();
  if (p === 'darwin') return uninstallLaunchdAgent();
  return uninstallSystemdUserUnit();
}

export function isAutoStartInstalled(): { installed: boolean; platform: AutoStartPlatform } {
  const p = autoStartPlatform();
  if (p === 'unsupported') {
    return { installed: false, platform: 'linux' };
  }
  if (p === 'win32') return { installed: windowsTaskExists(), platform: p };
  if (p === 'darwin') return { installed: existsSync(launchdPlistPath()), platform: p };
  return { installed: existsSync(systemdUnitPath()), platform: p };
}

// ---- Windows ---------------------------------------------------------------

const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function installWindowsTask(args: AutoStartInstallArgs): {
  installed: boolean;
  path: string;
  platform: 'win32';
} {
  // HKCU Run is the per-user, no-admin auto-start mechanism on Windows.
  // Each value under this key is a command string Windows runs at login.
  // Unlike schtasks, this key is writable by the current user under all
  // common group policies — schtasks ONLOGON often fails with "Access is
  // denied" on managed corporate machines.
  const taskName = args.label ?? SERVICE_TASK_NAME;
  const cmd = [quoteWin(args.execPath), ...args.args.map(quoteWin)].join(' ');
  const r = spawnSync(
    'reg',
    ['add', WIN_RUN_KEY, '/v', taskName, '/t', 'REG_SZ', '/d', cmd, '/f'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(
      `reg add HKCU\\...\\Run failed (exit ${r.status}): ${r.stderr ?? r.stdout ?? ''}`,
    );
  }
  return { installed: true, path: `${WIN_RUN_KEY}\\${taskName}`, platform: 'win32' };
}

function uninstallWindowsTask(): { uninstalled: boolean; platform: 'win32' } {
  if (!windowsTaskExists()) return { uninstalled: false, platform: 'win32' };
  const r = spawnSync(
    'reg',
    ['delete', WIN_RUN_KEY, '/v', SERVICE_TASK_NAME, '/f'],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (r.status !== 0) {
    throw new Error(
      `reg delete failed (exit ${r.status}): ${r.stderr ?? r.stdout ?? ''}`,
    );
  }
  return { uninstalled: true, platform: 'win32' };
}

function windowsTaskExists(): boolean {
  if (platform() !== 'win32') return false;
  const r = spawnSync('reg', ['query', WIN_RUN_KEY, '/v', SERVICE_TASK_NAME], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return r.status === 0;
}

/** Quote a single CLI arg for the registry Run value. */
function quoteWin(s: string): string {
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ---- macOS (launchd) -------------------------------------------------------

function launchdPlistPath(label: string = SERVICE_LAUNCHD_LABEL): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

function installLaunchdAgent(args: AutoStartInstallArgs): {
  installed: boolean;
  path: string;
  platform: 'darwin';
} {
  const label = args.label ?? SERVICE_LAUNCHD_LABEL;
  const plistPath = launchdPlistPath(label);
  const program = [args.execPath, ...args.args];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...program.map((p) => `    <string>${escapeXml(p)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, xml, 'utf8');
  const loaded = spawnSync('launchctl', ['load', '-w', plistPath], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (loaded.status !== 0) {
    // Roll back the file so the user isn't left with an orphaned plist.
    try {
      unlinkSync(plistPath);
    } catch {
      /* best-effort */
    }
    throw new Error(
      `launchctl load failed (exit ${loaded.status}): ${loaded.stderr ?? loaded.stdout ?? ''}`,
    );
  }
  return { installed: true, path: plistPath, platform: 'darwin' };
}

function uninstallLaunchdAgent(): { uninstalled: boolean; platform: 'darwin' } {
  const plistPath = launchdPlistPath();
  if (!existsSync(plistPath)) return { uninstalled: false, platform: 'darwin' };
  // unload first (ignore errors — the plist might not be loaded yet), then remove.
  spawnSync('launchctl', ['unload', '-w', plistPath], { stdio: 'pipe', encoding: 'utf8' });
  try {
    unlinkSync(plistPath);
  } catch (err) {
    throw new Error(
      `Failed to remove ${plistPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { uninstalled: true, platform: 'darwin' };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Linux (systemd --user) ------------------------------------------------

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SERVICE_SYSTEMD_UNIT);
}

function installSystemdUserUnit(args: AutoStartInstallArgs): {
  installed: boolean;
  path: string;
  platform: 'linux';
} {
  const unitPath = systemdUnitPath();
  const execLine = [args.execPath, ...args.args].map((p) => quotePosix(p)).join(' ');
  const unit = [
    '[Unit]',
    'Description=Clawdevbox MCP server',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execLine}`,
    'Restart=on-failure',
    'RestartSec=5s',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit, 'utf8');
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (reload.status !== 0) {
    try {
      unlinkSync(unitPath);
    } catch {
      /* best-effort */
    }
    throw new Error(
      `systemctl --user daemon-reload failed (exit ${reload.status}): ${reload.stderr ?? reload.stdout ?? ''}`,
    );
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', SERVICE_SYSTEMD_UNIT], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (enable.status !== 0) {
    throw new Error(
      `systemctl --user enable failed (exit ${enable.status}): ${enable.stderr ?? enable.stdout ?? ''}`,
    );
  }
  // Enable lingering so the user service survives logout — required for
  // headless deployments and for "always running across reboots" semantics.
  // Best-effort: requires root on many distros via sudo; ignore if it fails
  // (the service still works for the duration of the current session).
  spawnSync('loginctl', ['enable-linger'], { stdio: 'pipe', encoding: 'utf8' });
  return { installed: true, path: unitPath, platform: 'linux' };
}

function uninstallSystemdUserUnit(): { uninstalled: boolean; platform: 'linux' } {
  const unitPath = systemdUnitPath();
  if (!existsSync(unitPath)) return { uninstalled: false, platform: 'linux' };
  spawnSync('systemctl', ['--user', 'disable', SERVICE_SYSTEMD_UNIT], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  spawnSync('systemctl', ['--user', 'stop', SERVICE_SYSTEMD_UNIT], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  try {
    unlinkSync(unitPath);
  } catch (err) {
    throw new Error(
      `Failed to remove ${unitPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe', encoding: 'utf8' });
  return { uninstalled: true, platform: 'linux' };
}

function quotePosix(s: string): string {
  if (!/[\s"'$`\\]/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

// ============================================================================
// Health probe
// ============================================================================

/**
 * Poll `http://<host>:<port>/healthz` until it returns `ok` or the timeout
 * elapses. Used by `start --service` to confirm the detached child is
 * actually listening before declaring success — without this, a failed
 * spawn (port in use, missing token, plugin import error) only surfaces
 * via stale state files long after the user has walked away.
 *
 * Returns `{ ok: true }` on a 200/`ok` response; `{ ok: false, reason }`
 * on any other outcome (timeout, ECONNREFUSED, non-200). Uses Node's
 * built-in `fetch` — no extra dep.
 */
export async function probeHealth(args: {
  host: string;
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timeoutMs = args.timeoutMs ?? 5000;
  const intervalMs = args.intervalMs ?? 250;
  const url = `http://${args.host}:${args.port}/healthz`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: string = 'never reached';

  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.min(intervalMs * 2, 1000));
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const body = await res.text();
        if (body.trim() === 'ok') return { ok: true };
        lastErr = `unexpected /healthz body: ${body.slice(0, 80)}`;
      } else {
        lastErr = `/healthz returned HTTP ${res.status}`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, reason: `timeout after ${timeoutMs}ms (last: ${lastErr})` };
}
