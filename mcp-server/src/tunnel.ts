/**
 * tunnel.ts
 *
 * Stable Microsoft Dev Tunnel manager. One named tunnel per workspace, so
 * the public URL survives `clawdevbox start` restarts.
 *
 * Setup (idempotent — done at the start of every `clawdevbox start`):
 *   1. `devtunnel show <name> -j`   — does the tunnel already exist?
 *   2. If not, `devtunnel create <name> [--allow-anonymous]`.
 *   3. `devtunnel port list <name> -j` — does the port mapping exist?
 *   4. If not, `devtunnel port create <name> -p <port> --protocol https`.
 *
 * Host:
 *   - `devtunnel host <name> -p <port>` runs as a long-lived child.
 *   - stdout is scanned for the "Connect via browser:" line to extract the
 *     stable public URL.
 *   - The child is killed on `clawdevbox start` shutdown.
 *
 * Prerequisites the user must satisfy:
 *   - `devtunnel` CLI on PATH (winget install Microsoft.devtunnel, or
 *     brew install --cask devtunnel)
 *   - `devtunnel user login`
 *
 * Spawn failures (CLI missing, not logged in, network) are surfaced via
 * `getTunnelStatus().error` — they do not crash the HTTP server.
 */

import { spawnSync } from 'node:child_process';
import * as pty from 'node-pty';
import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';

export type TunnelKind = 'none' | 'devtunnel';

export interface TunnelStatus {
  kind: TunnelKind;
  name: string | null;
  port: number | null;
  running: boolean;
  url: string | null;
  inspect_url: string | null;
  error: string | null;
  pid: number | null;
}

let current: TunnelStatus = emptyStatus();
let hostProc: pty.IPty | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let stopRequested = false;

function emptyStatus(): TunnelStatus {
  return {
    kind: 'none',
    name: null,
    port: null,
    running: false,
    url: null,
    inspect_url: null,
    error: null,
    pid: null,
  };
}

export function getTunnelStatus(): TunnelStatus {
  return { ...current };
}

export interface StartTunnelOptions {
  kind: TunnelKind;
  name: string;
  port: number;
  allowAnonymous: boolean;
}

/**
 * Bring up the tunnel. Idempotent — the tunnel + port are created only if
 * missing, so the URL stays stable across restarts.
 *
 * Returns a status snapshot. On failure (missing CLI, not logged in, network)
 * the `error` field is populated and `running` is false; the HTTP server
 * remains up.
 */
export async function startTunnel(opts: StartTunnelOptions): Promise<TunnelStatus> {
  if (opts.kind === 'none') {
    current = emptyStatus();
    return getTunnelStatus();
  }

  current = {
    ...emptyStatus(),
    kind: 'devtunnel',
    name: opts.name,
    port: opts.port,
  };

  // 1) Verify CLI presence + login state up-front so the error is
  //    actionable (don't wait for `host` to fail mid-stream).
  const cliCheck = runDevtunnel(['--version']);
  if (cliCheck.status !== 0) {
    current.error =
      '`devtunnel` CLI not found on PATH. Install via `winget install Microsoft.devtunnel` ' +
      '(Windows) or `brew install --cask devtunnel` (macOS).';
    logger.warn({ err: current.error }, 'tunnel: cli missing');
    return getTunnelStatus();
  }

  const userCheck = runDevtunnel(['user', 'show']);
  const userOut = (userCheck.stdout ?? '') + (userCheck.stderr ?? '');
  if (userCheck.status !== 0 || /not logged in/i.test(userOut)) {
    current.error =
      'Not logged in to dev tunnels. Run `devtunnel user login` (or `devtunnel user login -g` for GitHub) and try again.';
    logger.warn({ err: current.error }, 'tunnel: not logged in');
    return getTunnelStatus();
  }

  // 2) Ensure the named tunnel exists.
  const showRes = runDevtunnel(['show', opts.name, '-j']);
  if (showRes.status !== 0) {
    const createArgs = ['create', opts.name];
    if (opts.allowAnonymous) createArgs.push('--allow-anonymous');
    const createRes = runDevtunnel(createArgs);
    if (createRes.status !== 0) {
      current.error = `devtunnel create failed: ${oneLine(createRes.stderr || createRes.stdout)}`;
      logger.warn({ err: current.error }, 'tunnel: create failed');
      return getTunnelStatus();
    }
    logger.info({ name: opts.name }, 'tunnel: created named tunnel');
  }

  // 3) Ensure the port mapping exists AND uses --protocol http. `port list -j`
  //    returns the array we walk to detect both presence and protocol drift.
  //    If a previous run created the port with the wrong protocol (e.g. the
  //    earlier `https` default), we update it so the tunnel actually proxies
  //    instead of returning 502 / "can't currently handle this request".
  const portListRes = runDevtunnel(['port', 'list', opts.name, '-j']);
  let portExists = false;
  let portProtocol: string | undefined;
  if (portListRes.status === 0) {
    try {
      const parsed = JSON.parse(portListRes.stdout) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { ports?: unknown[] }).ports)
          ? (parsed as { ports: unknown[] }).ports
          : [];
      const portRow = arr.find(
        (p): p is Record<string, unknown> =>
          !!p &&
          typeof p === 'object' &&
          (p as { portNumber?: number }).portNumber === opts.port,
      );
      if (portRow) {
        portExists = true;
        const proto = portRow.protocol;
        if (typeof proto === 'string') portProtocol = proto.toLowerCase();
      }
    } catch {
      // Unparseable output — fall through and try to create; the create
      // call will succeed-or-409 and we'll catch any "already exists" error.
    }
  }

  if (portExists && portProtocol && portProtocol !== 'http') {
    // Drift: existing port was created with the wrong protocol (most likely
    // `https`, which makes devtunnel try a TLS handshake against our plain-
    // HTTP local server → 502). `port update` doesn't accept --protocol, so
    // delete + recreate is the only path. Tunnel id (and therefore the
    // public URL) stays the same — only the port row is rewritten.
    const delRes = runDevtunnel(['port', 'delete', opts.name, '-p', String(opts.port)]);
    if (delRes.status === 0) {
      logger.info(
        { name: opts.name, port: opts.port, from: portProtocol, to: 'http' },
        'tunnel: deleted mis-protocol port; will recreate as http below',
      );
      portExists = false; // fall through to the create branch
    } else {
      logger.warn(
        {
          name: opts.name,
          port: opts.port,
          err: oneLine(delRes.stderr || delRes.stdout),
        },
        'tunnel: could not delete mis-protocol port — recreate the tunnel manually if 502s persist (`devtunnel delete <name> -f` then restart)',
      );
    }
  }

  if (!portExists) {
    // --protocol http: clawdevbox's HTTP server listens in plain HTTP on the
    // local port. Devtunnel terminates TLS at its edge and forwards plain
    // HTTP to localhost — so the local end MUST be 'http', not 'https'. The
    // public URL is always `https://…` regardless.
    const portCreateRes = runDevtunnel([
      'port',
      'create',
      opts.name,
      '-p',
      String(opts.port),
      '--protocol',
      'http',
    ]);
    if (portCreateRes.status !== 0) {
      // Tolerate the "port already exists" race — re-list and recheck.
      const reList = runDevtunnel(['port', 'list', opts.name, '-j']);
      const stillExists =
        reList.status === 0 && reList.stdout.includes(`"portNumber": ${opts.port}`);
      if (!stillExists) {
        current.error = `devtunnel port create failed: ${oneLine(portCreateRes.stderr || portCreateRes.stdout)}`;
        logger.warn({ err: current.error }, 'tunnel: port create failed');
        return getTunnelStatus();
      }
    }
    logger.info({ name: opts.name, port: opts.port }, 'tunnel: registered port');
  }

  // 4) Spawn the host process inside a PTY. We do NOT pass `-p` here —
  //    the tunnel already has its port registered (step 3) and the host CLI
  //    rejects a "batch update" of ports if `-p` redeclares one.
  //
  // node-pty (ConPTY on Windows) is necessary because the 1.0.x devtunnel
  // CLI exits a few seconds after going live when its stdio is a plain
  // pipe — it expects a real terminal handle and silently bails otherwise.
  // The pty also gives us hidden execution (no console window flashing).
  //
  // On exit (clean or crash), the watcher auto-respawns the host so the
  // public URL keeps forwarding through transient device-side hiccups.
  stopRequested = false;
  spawnHostPty(opts);

  // Give the host process a moment to print the URL so the banner can show
  // it. Bumped slightly past the 4s port-list fallback so the synchronous
  // banner usually has a URL to print. If neither succeeds, the URL still
  // surfaces via /api/tunnel/status as soon as it lands.
  await waitForUrl(5500);

  return getTunnelStatus();
}

export async function stopTunnel(): Promise<void> {
  stopRequested = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!hostProc) return;
  const proc = hostProc;
  const pid = proc.pid;
  hostProc = null;
  try {
    if (process.platform === 'win32' && pid) {
      // taskkill /T kills the entire devtunnel process tree.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      proc.kill();
    }
  } catch {
    /* best effort */
  }
  current.running = false;
  current.pid = null;
}

/**
 * Spawn `devtunnel host` inside a PTY and register a restart-on-exit
 * watcher. URL discovery happens by scanning the pty output stream; if the
 * stream stays quiet within 4s, we fall back to `devtunnel port list -j` so
 * a stable URL still shows up in `/api/tunnel/status`.
 */
function resolveDevtunnelPath(): string {
  // node-pty doesn't do PATH lookups the way child_process.spawn does, so
  // resolve to an absolute path. On Windows, `where devtunnel.exe` returns
  // the actual .exe (not the .cmd shim); on POSIX, `which devtunnel` is
  // the equivalent. Targeting `.exe` instead of bare `devtunnel` is
  // important on Windows because `where devtunnel` returns the WinGet .cmd
  // shim, which node-pty.spawn cannot execute directly.
  if (process.platform === 'win32') {
    try {
      const res = spawnSync('cmd.exe', ['/d', '/s', '/c', 'where', 'devtunnel.exe'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      if (res.status === 0) {
        const first = (res.stdout ?? '').split(/\r?\n/).find((l) => l.trim().endsWith('.exe'));
        if (first) return first.trim();
      }
    } catch {
      /* fall through */
    }
    return 'devtunnel.exe';
  }
  try {
    const res = spawnSync('which', ['devtunnel'], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = (res.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0);
      if (first) return first.trim();
    }
  } catch {
    /* fall through */
  }
  return 'devtunnel';
}

function spawnHostPty(opts: StartTunnelOptions): void {
  const URL_RE = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.devtunnels\.ms/gi;
  let tail = '';
  let startedAt = Date.now();
  let proc: pty.IPty;
  const devtunnelPath = resolveDevtunnelPath();
  try {
    proc = pty.spawn(devtunnelPath, ['host', opts.name], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    current.error = `devtunnel host spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    current.running = false;
    current.pid = null;
    logger.warn({ err: current.error }, 'tunnel: host spawn failed');
    return;
  }
  hostProc = proc;
  current.pid = proc.pid ?? null;
  current.running = true;
  current.error = null;
  emitChange('tunnel');

  proc.onData((chunk) => {
    tail = (tail + chunk).slice(-500);
    for (const m of chunk.matchAll(URL_RE)) {
      const u = m[0];
      if (u.includes('-inspect.')) {
        if (!current.inspect_url) {
          current.inspect_url = u;
          emitChange('tunnel');
        }
      } else if (!current.url || current.url !== u) {
        current.url = u;
        logger.info({ name: opts.name, url: u }, 'tunnel: live');
        emitChange('tunnel');
      }
    }
  });

  // Fallback URL lookup if the pty stream stays quiet (some networks /
  // older CLIs).
  const fallbackTimer = setTimeout(() => {
    if (current.url) return;
    const portsRes = runDevtunnel(['port', 'list', opts.name, '-j']);
    if (portsRes.status !== 0) return;
    try {
      const parsed = JSON.parse(portsRes.stdout) as unknown;
      const arr = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : ((parsed as { ports?: Array<Record<string, unknown>> }).ports ?? []);
      const portRow = arr.find(
        (p) => p && typeof p === 'object' && p.portNumber === opts.port,
      );
      if (!portRow) return;
      const uri =
        (portRow.portForwardingUris as string[] | undefined)?.[0] ??
        (portRow.portUri as string | undefined);
      if (typeof uri !== 'string') return;
      current.url = uri.replace(/\/$/, '');
      const m = uri.match(/^https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.devtunnels\.ms/i);
      if (m) current.inspect_url = `https://${m[1]}-inspect.${m[2]}.devtunnels.ms`;
      logger.info({ name: opts.name, url: current.url, via: 'port-list' }, 'tunnel: live');
      emitChange('tunnel');
    } catch {
      /* ignore — surface as "URL pending" */
    }
  }, 4000);

  proc.onExit(({ exitCode, signal }) => {
    clearTimeout(fallbackTimer);
    const liveFor = Date.now() - startedAt;
    logger.info(
      { code: exitCode, signal, name: opts.name, liveForMs: liveFor, tail: tail.slice(-200) },
      'tunnel: host exited',
    );
    current.running = false;
    current.pid = null;
    hostProc = null;
    emitChange('tunnel');

    if (stopRequested) return;

    // Auto-restart. Back off if the host died quickly (< 5s) to avoid a
    // hot loop when the tunnel is fundamentally broken.
    const delay = liveFor < 5000 ? Math.min(30_000, 1000 * Math.pow(2, restartFailures())) : 1000;
    bumpRestartFailures(liveFor);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopRequested) return;
      logger.info({ name: opts.name, delay }, 'tunnel: host restarting');
      startedAt = Date.now();
      spawnHostPty(opts);
    }, delay);
    if (typeof restartTimer.unref === 'function') restartTimer.unref();
  });
}

let _restartFailures = 0;
function restartFailures(): number {
  return _restartFailures;
}
function bumpRestartFailures(liveForMs: number): void {
  if (liveForMs >= 5000) _restartFailures = 0;
  else _restartFailures = Math.min(_restartFailures + 1, 6);
}

/** Derive a default tunnel name from a project dir path. */
export function deriveTunnelName(projectDir: string): string {
  const base = projectDir
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop() ?? 'clawdevbox';
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const head = /^[a-z]/.test(slug) ? slug : `cdb-${slug}`;
  // devtunnel names are typically <=60 chars; trim hard.
  return head.slice(0, 50) || 'clawdevbox';
}

function runDevtunnel(args: string[]): { status: number; stdout: string; stderr: string } {
  // On Windows, `devtunnel` is typically the WinGet `.cmd` shim (under
  // `LOCALAPPDATA\Microsoft\WinGet\Links`). Node's child_process.spawn
  // can't execute `.cmd` files directly anymore (DEP0190 deprecates the
  // shell:true workaround). Wrap with `cmd.exe /d /s /c` instead — same
  // pattern claude.ts and ensure-devtunnel.ts use.
  const { file, spawnArgs } = process.platform === 'win32'
    ? { file: 'cmd.exe', spawnArgs: ['/d', '/s', '/c', 'devtunnel', ...args] }
    : { file: 'devtunnel', spawnArgs: args };
  try {
    const res = spawnSync(file, spawnArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return {
      status: typeof res.status === 'number' ? res.status : -1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  } catch (err) {
    return {
      status: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function waitForUrl(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (current.url) return resolve();
    const start = Date.now();
    const id = setInterval(() => {
      if (current.url || Date.now() - start >= timeoutMs) {
        clearInterval(id);
        resolve();
      }
    }, 100);
  });
}
