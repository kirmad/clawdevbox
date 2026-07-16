/**
 * share-tunnel.ts
 *
 * Sibling of `tunnel.ts`. Manages a SECOND Microsoft Dev Tunnel that exposes
 * the share HTTP listener (see `share-server.ts`). Lives in its own module
 * so the existing single-instance state in `tunnel.ts` stays untouched.
 *
 * Why a separate tunnel?
 * ----------------------
 * The main `/mcp` tunnel is intentionally locked down (bearer-token gated
 * on the HTTP side, devtunnel access tokens on the tunnel side). The share
 * tunnel needs DIFFERENT access semantics — typically tenant-restricted
 * (so colleagues in the same Microsoft Entra tenant can hit it via SSO
 * without a per-user token) or anonymous (when the share is meant to be
 * public-readable). Trying to fit both modes onto one tunnel would mean
 * either over-exposing /mcp or under-exposing the share endpoint.
 *
 * Setup (idempotent — re-run safely on every `clawdevbox start`):
 *   1. `devtunnel show <name> -j`        — does the tunnel already exist?
 *   2. If not, `devtunnel create <name> [--allow-anonymous]`.
 *   3. `devtunnel port list <name> -j`   — does the port mapping exist?
 *   4. If not, `devtunnel port create <name> -p <port> --protocol http`.
 *   5. For each tenant in `tenants`, ensure an access rule:
 *        `devtunnel access list <name> -j`  (idempotency check)
 *        `devtunnel access create <name> --tenant <id> --port <port>`
 *
 * Host: `devtunnel host <name>` runs as a long-lived child inside a PTY.
 * stdout is scanned for the public URL.
 *
 * Spawn / setup failures (CLI missing, not logged in, network) are surfaced
 * via `getShareTunnelStatus().error` — they do NOT crash the HTTP server.
 *
 * Access-control semantics
 * ------------------------
 *   - allowAnonymous: true             → anyone with the URL gets in
 *   - allowAnonymous: false, no tenants → owner-only (default devtunnel ACL)
 *   - tenants: ['<guid>', ...]         → access rule per tenant (one rule
 *     per tenant — devtunnel collapses duplicates if the (--tenant, --port)
 *     pair already exists, so re-runs are idempotent)
 *   - allowAnonymous + tenants together is rejected up-front
 */

import { spawnSync } from 'node:child_process';
import * as pty from 'node-pty';
import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';

export type ShareTunnelKind = 'none' | 'devtunnel';

export interface ShareTunnelStatus {
  kind: ShareTunnelKind;
  name: string | null;
  port: number | null;
  running: boolean;
  url: string | null;
  inspect_url: string | null;
  error: string | null;
  pid: number | null;
  /** Snapshot of access semantics in effect (for /api/share/status). */
  access: {
    allow_anonymous: boolean;
    tenants: string[];
  };
}

let current: ShareTunnelStatus = emptyStatus();
let hostProc: pty.IPty | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let stopRequested = false;

function emptyStatus(): ShareTunnelStatus {
  return {
    kind: 'none',
    name: null,
    port: null,
    running: false,
    url: null,
    inspect_url: null,
    error: null,
    pid: null,
    access: { allow_anonymous: false, tenants: [] },
  };
}

export function getShareTunnelStatus(): ShareTunnelStatus {
  return {
    ...current,
    access: { ...current.access, tenants: [...current.access.tenants] },
  };
}

export interface StartShareTunnelOptions {
  /** Stable devtunnel id. Lowercase alnum + hyphens. */
  name: string;
  /** Local share port to forward. */
  port: number;
  /** When true, tunnel is created with --allow-anonymous. */
  allowAnonymous: boolean;
  /**
   * Microsoft Entra tenant ids granted access. When non-empty, one
   * `devtunnel access create --tenant <id>` is issued per tenant.
   * Mutually exclusive with `allowAnonymous`.
   */
  tenants: string[] | null;
  /**
   * Internal seam so unit tests can inject a fake CLI without touching
   * the system PATH or spawning a real devtunnel host. Production
   * callers omit this and the module uses `node:child_process.spawnSync`
   * + `node-pty.spawn` as documented above.
   */
  _runner?: ShareTunnelRunner;
}

/** Test seam: pluggable runner so unit tests can simulate the devtunnel CLI. */
export interface ShareTunnelRunner {
  /** Mirror of `spawnSync('devtunnel', args)`. */
  run(args: string[]): { status: number; stdout: string; stderr: string };
  /**
   * Mirror of `pty.spawn(devtunnelPath, ['host', name])`. Should emit data
   * events that include a `https://*.devtunnels.ms` URL so URL discovery
   * succeeds. Tests typically return a tiny EventEmitter-like stub.
   */
  spawnHost(name: string): FakeHostProc | pty.IPty;
}

/** Subset of the pty.IPty surface area that `share-tunnel` actually consumes. */
export interface FakeHostProc {
  pid?: number;
  onData(cb: (chunk: string) => void): { dispose(): void } | void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
  kill?(): void;
}

/**
 * Bring up the share tunnel. Idempotent.
 *
 * Returns a status snapshot. On failure (missing CLI, not logged in,
 * network) the `error` field is populated and `running` is false; the HTTP
 * server remains up.
 */
export async function startShareTunnel(
  opts: StartShareTunnelOptions,
): Promise<ShareTunnelStatus> {
  if (opts.allowAnonymous && opts.tenants && opts.tenants.length > 0) {
    current = {
      ...emptyStatus(),
      kind: 'devtunnel',
      name: opts.name,
      port: opts.port,
      access: { allow_anonymous: true, tenants: [...opts.tenants] },
      error: 'share.tunnel.allow_anonymous and tenants are mutually exclusive',
    };
    logger.warn(
      { err: current.error, name: opts.name },
      'share-tunnel: invalid config (anonymous + tenants)',
    );
    return getShareTunnelStatus();
  }

  const tenants = opts.tenants ?? [];
  current = {
    ...emptyStatus(),
    kind: 'devtunnel',
    name: opts.name,
    port: opts.port,
    access: { allow_anonymous: opts.allowAnonymous, tenants: [...tenants] },
  };

  const runner = opts._runner ?? defaultRunner();

  // 1) Verify CLI presence + login state up-front for actionable errors.
  const cliCheck = runner.run(['--version']);
  if (cliCheck.status !== 0) {
    current.error =
      '`devtunnel` CLI not found on PATH. Install via `winget install Microsoft.devtunnel` ' +
      '(Windows) or `brew install --cask devtunnel` (macOS).';
    logger.warn({ err: current.error }, 'share-tunnel: cli missing');
    return getShareTunnelStatus();
  }

  const userCheck = runner.run(['user', 'show']);
  const userOut = (userCheck.stdout ?? '') + (userCheck.stderr ?? '');
  if (userCheck.status !== 0 || /not logged in/i.test(userOut)) {
    current.error =
      'Not logged in to dev tunnels. Run `devtunnel user login` (or `devtunnel user login -g`) and try again.';
    logger.warn({ err: current.error }, 'share-tunnel: not logged in');
    return getShareTunnelStatus();
  }

  // 2) Ensure the named tunnel exists.
  const showRes = runner.run(['show', opts.name, '-j']);
  if (showRes.status !== 0) {
    const createArgs = ['create', opts.name];
    if (opts.allowAnonymous) createArgs.push('--allow-anonymous');
    const createRes = runner.run(createArgs);
    if (createRes.status !== 0) {
      current.error = `devtunnel create failed: ${oneLine(createRes.stderr || createRes.stdout)}`;
      logger.warn({ err: current.error }, 'share-tunnel: create failed');
      return getShareTunnelStatus();
    }
    logger.info({ name: opts.name }, 'share-tunnel: created named tunnel');
  }

  // 3) Ensure the port mapping exists (force --protocol http).
  const portListRes = runner.run(['port', 'list', opts.name, '-j']);
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
      /* unparseable — fall through to create path */
    }
  }

  if (portExists && portProtocol && portProtocol !== 'http') {
    const delRes = runner.run(['port', 'delete', opts.name, '-p', String(opts.port)]);
    if (delRes.status === 0) {
      logger.info(
        { name: opts.name, port: opts.port, from: portProtocol, to: 'http' },
        'share-tunnel: deleted mis-protocol port; will recreate as http',
      );
      portExists = false;
    }
  }

  if (!portExists) {
    const portCreateRes = runner.run([
      'port', 'create', opts.name, '-p', String(opts.port), '--protocol', 'http',
    ]);
    if (portCreateRes.status !== 0) {
      const reList = runner.run(['port', 'list', opts.name, '-j']);
      const stillExists =
        reList.status === 0 && reList.stdout.includes(`"portNumber": ${opts.port}`);
      if (!stillExists) {
        current.error = `devtunnel port create failed: ${oneLine(portCreateRes.stderr || portCreateRes.stdout)}`;
        logger.warn({ err: current.error }, 'share-tunnel: port create failed');
        return getShareTunnelStatus();
      }
    }
    logger.info({ name: opts.name, port: opts.port }, 'share-tunnel: registered port');
  }

  // 4) Per-tenant access rules. devtunnel access create dedupes on
  //    (subject, scope, port) so re-running is safe; we additionally
  //    list first and skip when an obvious match exists to keep noise low.
  for (const tenantId of tenants) {
    const accessListRes = runner.run(['access', 'list', opts.name, '-j']);
    let alreadyHasRule = false;
    if (accessListRes.status === 0) {
      try {
        const parsed = JSON.parse(accessListRes.stdout) as unknown;
        const arr = Array.isArray(parsed) ? parsed : [];
        alreadyHasRule = arr.some((row): boolean => {
          if (!row || typeof row !== 'object') return false;
          const r = row as Record<string, unknown>;
          const tenantField = (r.tenantId ?? r.tenant ?? r.subject) as
            | string
            | undefined;
          const scopePort = (r.port ?? r.portNumber) as number | undefined;
          if (tenantField !== tenantId) return false;
          if (scopePort != null && scopePort !== opts.port) return false;
          return true;
        });
      } catch {
        /* fall through and try to create — devtunnel will dedupe */
      }
    }
    if (alreadyHasRule) {
      logger.info(
        { name: opts.name, tenant: tenantId },
        'share-tunnel: tenant access rule already present',
      );
      continue;
    }
    const accessRes = runner.run([
      'access', 'create', opts.name,
      '--tenant', tenantId,
      '--port', String(opts.port),
    ]);
    if (accessRes.status !== 0) {
      // Tolerate "already exists" — log and continue. Anything else is
      // surfaced via the running status but doesn't block hosting.
      const out = oneLine(accessRes.stderr || accessRes.stdout);
      if (!/already.*exists/i.test(out)) {
        logger.warn(
          { name: opts.name, tenant: tenantId, err: out },
          'share-tunnel: access create failed (continuing — host will still start, but tenant may not have access)',
        );
      }
    } else {
      logger.info(
        { name: opts.name, tenant: tenantId },
        'share-tunnel: created tenant access rule',
      );
    }
  }

  // 5) Spawn the host PTY.
  stopRequested = false;
  spawnHostPty(opts, runner);

  // Give the host a moment to print the URL so the banner can show it.
  await waitForUrl(5500);

  return getShareTunnelStatus();
}

export async function stopShareTunnel(): Promise<void> {
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
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
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

function spawnHostPty(
  opts: StartShareTunnelOptions,
  runner: ShareTunnelRunner,
): void {
  const URL_RE = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.devtunnels\.ms/gi;
  let tail = '';
  let startedAt = Date.now();
  let proc: FakeHostProc | pty.IPty;
  try {
    proc = runner.spawnHost(opts.name);
  } catch (err) {
    current.error = `devtunnel host spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    current.running = false;
    current.pid = null;
    logger.warn({ err: current.error }, 'share-tunnel: host spawn failed');
    return;
  }
  hostProc = proc as pty.IPty;
  current.pid = proc.pid ?? null;
  current.running = true;
  current.error = null;
  emitChange('tunnel');

  proc.onData((chunk: string) => {
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
        logger.info({ name: opts.name, url: u }, 'share-tunnel: live');
        emitChange('tunnel');
      }
    }
  });

  const fallbackTimer = setTimeout(() => {
    if (current.url) return;
    const portsRes = runner.run(['port', 'list', opts.name, '-j']);
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
      logger.info(
        { name: opts.name, url: current.url, via: 'port-list' },
        'share-tunnel: live',
      );
      emitChange('tunnel');
    } catch {
      /* ignore */
    }
  }, 4000);

  proc.onExit(({ exitCode, signal }) => {
    clearTimeout(fallbackTimer);
    const liveFor = Date.now() - startedAt;
    logger.info(
      { code: exitCode, signal, name: opts.name, liveForMs: liveFor, tail: tail.slice(-200) },
      'share-tunnel: host exited',
    );
    current.running = false;
    current.pid = null;
    hostProc = null;
    emitChange('tunnel');

    if (stopRequested) return;
    const delay = liveFor < 5000 ? Math.min(30_000, 1000 * Math.pow(2, restartFailures())) : 1000;
    bumpRestartFailures(liveFor);
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopRequested) return;
      logger.info({ name: opts.name, delay }, 'share-tunnel: host restarting');
      startedAt = Date.now();
      spawnHostPty(opts, runner);
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

/** Default runner — wraps `devtunnel` via cmd.exe on Windows. */
function defaultRunner(): ShareTunnelRunner {
  return {
    run: (args: string[]) => runDevtunnel(args),
    spawnHost: (name: string) => {
      const devtunnelPath = resolveDevtunnelPath();
      return pty.spawn(devtunnelPath, ['host', name], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      });
    },
  };
}

function resolveDevtunnelPath(): string {
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

function runDevtunnel(args: string[]): { status: number; stdout: string; stderr: string } {
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
