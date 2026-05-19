/**
 * ensure-devtunnel.ts
 *
 * Cross-platform end-to-end setup for Microsoft Dev Tunnels.
 *
 * Called from `clawdevbox init` when the user picks `devtunnel` as tunnel
 * kind. Walks the user through every gate to "tunnel actually works":
 *
 *   1. CLI install — probe `devtunnel --version`; if missing, ask permission
 *      and run the platform-appropriate package-manager command:
 *        - Windows: winget install Microsoft.devtunnel
 *        - macOS:   brew install --cask devtunnel
 *        - Linux:   curl -sL https://aka.ms/DevTunnelCliInstall | bash
 *
 *   2. PATH refresh — after install, merge the install dir into
 *      process.env.PATH so the rest of init (and the child service we
 *      spawn) can find the binary without a shell restart.
 *
 *   3. Login — probe `devtunnel user show`; if not authenticated, ask the
 *      user which provider they want (Microsoft / GitHub) and run
 *      `devtunnel user login` inherited-stdio so the OAuth flow happens
 *      in the same terminal.
 *
 *   4. Re-verification — after each step, re-probe to confirm.
 *
 * Returns a structured result the caller can log + branch on. None of the
 * steps throw — failures are reported via `{ ok: false, reason }`.
 */

import { spawnSync } from 'node:child_process';
import { confirm, isCancel, log, select, spinner } from '@clack/prompts';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';

export type EnsureStage = 'install' | 'login' | 'verify';

export interface EnsureDevtunnelResult {
  ok: boolean;
  /** True if devtunnel was already installed before this call ran. */
  cliPreInstalled?: boolean;
  /** True if user was already logged in before this call ran. */
  loginPreExisting?: boolean;
  /** When ok=false, which step caused the failure. */
  failedAt?: EnsureStage;
  /** Free-form description. */
  reason?: string;
  /** `devtunnel --version` output when ok=true. */
  version?: string;
  /** Logged-in account identifier (e.g. email or GitHub username). */
  account?: string;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Wrap a Windows shim-resolvable binary (like `devtunnel`, which exists as
 * `devtunnel.cmd` under `WinGet\Links\`) into a `cmd.exe /d /s /c ...`
 * invocation. On POSIX we exec directly. This avoids `shell: true`, which
 * Node 22+ deprecates (DEP0190 — args are not escaped, only concatenated).
 */
function windowsCmdWrap(bin: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
  }
  return { file: bin, args };
}

/** Returns the devtunnel version string when on PATH; null otherwise. */
export function probeDevtunnel(): string | null {
  const { file, args } = windowsCmdWrap('devtunnel', ['--version']);
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  return ((r.stdout ?? '') as string).trim().split(/\r?\n/)[0] || 'unknown';
}

/**
 * Returns the logged-in identifier (`devtunnel user show` first line) or
 * null when not logged in / CLI errors. `devtunnel user show` exits 0 with
 * the account line when logged in and exits non-zero (with a message to
 * stderr or stdout) when not.
 */
export function probeDevtunnelLogin(): string | null {
  const { file, args } = windowsCmdWrap('devtunnel', ['user', 'show']);
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  // devtunnel user show prints the account on the first non-empty line.
  const line = ((r.stdout ?? '') as string)
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)[0];
  return line ?? null;
}

// ---------------------------------------------------------------------------
// Platform-specific install
// ---------------------------------------------------------------------------

interface InstallCommand {
  display: string;
  file: string;
  args: string[];
  /** Paths to merge into process.env.PATH after install. */
  pathExtensions: string[];
}

function installCommandForPlatform(): InstallCommand | null {
  if (process.platform === 'win32') {
    return {
      display: 'winget install Microsoft.devtunnel',
      file: 'winget',
      args: [
        'install',
        '--id', 'Microsoft.devtunnel',
        '--exact',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--silent',
      ],
      pathExtensions: [
        join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'),
      ],
    };
  }
  if (process.platform === 'darwin') {
    return {
      display: 'brew install --cask devtunnel',
      file: 'brew',
      args: ['install', '--cask', 'devtunnel'],
      pathExtensions: ['/opt/homebrew/bin', '/usr/local/bin'],
    };
  }
  if (process.platform === 'linux') {
    return {
      display: 'curl -sL https://aka.ms/DevTunnelCliInstall | bash',
      file: 'bash',
      args: ['-c', 'curl -sL https://aka.ms/DevTunnelCliInstall | bash'],
      pathExtensions: [join(homedir(), 'bin'), '/usr/local/bin'],
    };
  }
  return null;
}

function refreshPath(extensions: string[]): void {
  const current = process.env.PATH ?? '';
  const segments = current.split(delimiter).filter(Boolean);
  let changed = false;
  for (const ext of extensions) {
    if (!segments.includes(ext)) {
      segments.unshift(ext);
      changed = true;
    }
  }
  if (changed) process.env.PATH = segments.join(delimiter);
}

/**
 * On Windows: ask PowerShell for the freshly-updated **registry** User and
 * Machine PATH (winget writes to the User registry hive; the running Node
 * process's env is a stale snapshot from before winget ran). Merge any new
 * segments into process.env.PATH so subsequent spawns see them without a
 * shell restart.
 *
 * On POSIX: no-op (no analogous registry layer; the platform's install
 * commands write into shell rc files instead of an env store, and those
 * only take effect on next shell). Callers fall back to scanning well-
 * known install dirs.
 */
function refreshPathFromRegistry(): void {
  if (process.platform !== 'win32') return;

  const cmd = `[Environment]::GetEnvironmentVariable("Path","User") + ";" + [Environment]::GetEnvironmentVariable("Path","Machine")`;
  const r = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    cmd,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) return;

  const registryPath = r.stdout.trim();
  const merged = `${process.env.PATH ?? ''}${delimiter}${registryPath}`;
  const seen = new Set<string>();
  const segments: string[] = [];
  for (const seg of merged.split(delimiter)) {
    const s = seg.trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    segments.push(s);
  }
  process.env.PATH = segments.join(delimiter);
}

/**
 * Scan well-known install locations for the devtunnel binary. Returns the
 * directory containing it, or null. Used as last-resort fallback after
 * registry refresh fails to surface the binary.
 */
function findDevtunnelInstallDir(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    candidates.push(
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(local, 'Microsoft', 'WinGet', 'Packages'),
      join(programFiles, 'Microsoft', 'dev-tunnel'),
      join(programFilesX86, 'Microsoft', 'dev-tunnel'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin');
  } else {
    candidates.push(join(homedir(), 'bin'), '/usr/local/bin', '/usr/bin');
  }

  const binName = process.platform === 'win32' ? 'devtunnel.exe' : 'devtunnel';
  for (const dir of candidates) {
    try {
      // Direct hit
      if (existsSync(join(dir, binName))) return dir;
      // Some installers nest under <dir>/<version>/devtunnel.exe — scan one level deep
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = join(dir, entry.name, binName);
        if (existsSync(nested)) return join(dir, entry.name);
      }
    } catch {
      // dir doesn't exist or not readable — skip
    }
  }
  return null;
}

/**
 * Idempotent: try every PATH-resolution trick we know to make devtunnel
 * findable in the current process. Returns true if devtunnel is on PATH
 * after the call (whether already-there or newly-resolved).
 *
 * Safe to call from any process at any time. Use this from the service
 * boot path so devtunnel works even when the service was started in a
 * shell that pre-dates the install — and from init's post-install path
 * so the immediate service spawn has the refreshed PATH.
 *
 * The 3 layers, in order, each followed by a re-probe:
 *   1. refreshPathFromRegistry() — Windows-only; ask PowerShell for the
 *      live HKCU\\Environment\\Path + HKLM\\...\\Path (catches winget's
 *      User-PATH update that the running Node process can't see).
 *   2. findDevtunnelInstallDir() — scan known install locations on every
 *      platform and add the matching one to process.env.PATH.
 *   3. (no-op — gives up)
 */
export function ensureDevtunnelOnPath(): boolean {
  if (probeDevtunnel()) return true;

  refreshPathFromRegistry();
  if (probeDevtunnel()) return true;

  const found = findDevtunnelInstallDir();
  if (found) {
    refreshPath([found]);
    if (probeDevtunnel()) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Step 1: install the CLI
// ---------------------------------------------------------------------------

async function installDevtunnelCli(): Promise<{
  ok: boolean;
  version?: string;
  reason?: string;
}> {
  const cmd = installCommandForPlatform();
  if (!cmd) {
    return {
      ok: false,
      reason: `Auto-install not supported on ${process.platform}. ` +
        'Install devtunnel manually: https://aka.ms/devtunnels/docs',
    };
  }

  log.warn('`devtunnel` CLI is not on PATH.');
  const proceed = await confirm({
    message: `Auto-install now via:  ${cmd.display}`,
    initialValue: true,
  });
  if (isCancel(proceed) || !proceed) {
    return {
      ok: false,
      reason: 'User declined auto-install. Install manually later and re-run init.',
    };
  }

  const sp = spinner();
  sp.start(`Installing devtunnel via ${cmd.file}...`);
  const installRes = spawnSync(cmd.file, cmd.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  if (installRes.error || installRes.status !== 0) {
    const errMsg = installRes.error?.message
      ?? (installRes.stderr || installRes.stdout || `exit ${installRes.status}`)
        .toString().trim().split(/\r?\n/).slice(-3).join(' / ');
    sp.stop(`Install failed: ${errMsg}`, 1);
    return { ok: false, reason: `Install failed: ${errMsg}` };
  }

  refreshPath(cmd.pathExtensions);

  // Use the same multi-layer resolver the service uses at boot time. This
  // catches winget's User-PATH update via the registry refresh and falls
  // back to scanning known install dirs.
  if (ensureDevtunnelOnPath()) {
    const postVersion = probeDevtunnel();
    sp.stop(`devtunnel installed (${postVersion}).`);
    return { ok: true, version: postVersion ?? undefined };
  }

  sp.stop(
    'Install completed but devtunnel is not on PATH in this shell. ' +
    'Restart your terminal and re-run init.', 1,
  );
  return {
    ok: false,
    reason: 'Installed but not visible in the current shell. Restart your terminal and re-run.',
  };
}

// ---------------------------------------------------------------------------
// Step 2: login
// ---------------------------------------------------------------------------

type LoginProvider = 'microsoft' | 'github' | 'device-code';

async function loginDevtunnel(): Promise<{
  ok: boolean;
  account?: string;
  reason?: string;
}> {
  log.warn('Not signed in to Microsoft Dev Tunnels.');
  const provider = await select<Array<{ value: LoginProvider; label: string; hint?: string }>, LoginProvider>({
    message: 'Sign in with which provider?',
    options: [
      { value: 'microsoft',   label: 'Microsoft account (opens browser)', hint: 'Default. Works for personal + work accounts.' },
      { value: 'github',      label: 'GitHub account (opens browser)',   hint: 'Use this if you authenticate to Microsoft via GitHub.' },
      { value: 'device-code', label: 'Device code (no browser on this machine)', hint: 'For headless / remote / SSH sessions.' },
    ],
    initialValue: 'microsoft',
  });
  if (isCancel(provider)) {
    return { ok: false, reason: 'Login cancelled.' };
  }

  const loginArgs = providerToArgs(provider);

  log.info(`Running:  devtunnel ${loginArgs.join(' ')}`);
  log.info('Follow the prompts in this terminal / your browser. This call blocks until you complete the flow.');

  // We need an interactive subprocess. spawnSync with stdio: 'inherit' lets
  // the user see the OAuth code / browser prompts and answer them right in
  // this terminal. clack's UI is paused until devtunnel exits.
  const { file, args: wrappedArgs } = windowsCmdWrap('devtunnel', loginArgs);
  const loginRes = spawnSync(file, wrappedArgs, {
    stdio: 'inherit',
    windowsHide: false,
  });

  if (loginRes.error || loginRes.status !== 0) {
    const reason = loginRes.error?.message ?? `devtunnel user login exited ${loginRes.status}`;
    return { ok: false, reason };
  }

  // Re-probe — login is only really done if `devtunnel user show` succeeds.
  const account = probeDevtunnelLogin();
  if (!account) {
    return {
      ok: false,
      reason: 'Login command exited 0 but `devtunnel user show` still reports not-signed-in. Try `devtunnel user login` manually.',
    };
  }
  return { ok: true, account };
}

function providerToArgs(provider: LoginProvider): string[] {
  switch (provider) {
    case 'github':      return ['user', 'login', '-g'];
    case 'device-code': return ['user', 'login', '-d'];
    case 'microsoft':
    default:            return ['user', 'login'];
  }
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * End-to-end: ensure devtunnel CLI is installed AND the user is signed in.
 *
 * Idempotent — call multiple times and it'll skip already-done steps.
 */
export async function ensureDevtunnelReady(): Promise<EnsureDevtunnelResult> {
  // ---- Step 1: CLI ------------------------------------------------------
  let version: string | undefined = probeDevtunnel() ?? undefined;
  const cliPreInstalled = !!version;
  if (!version) {
    const res = await installDevtunnelCli();
    if (!res.ok) {
      return { ok: false, failedAt: 'install', reason: res.reason, cliPreInstalled: false };
    }
    version = res.version;
  }

  // ---- Step 2: login ----------------------------------------------------
  let account: string | undefined = probeDevtunnelLogin() ?? undefined;
  const loginPreExisting = !!account;
  if (!account) {
    const res = await loginDevtunnel();
    if (!res.ok) {
      return {
        ok: false,
        failedAt: 'login',
        reason: res.reason,
        cliPreInstalled,
        loginPreExisting: false,
        version,
      };
    }
    account = res.account;
  }

  // ---- Step 3: final verify --------------------------------------------
  const finalVersion = probeDevtunnel() ?? undefined;
  const finalAccount = probeDevtunnelLogin() ?? undefined;
  if (!finalVersion || !finalAccount) {
    return {
      ok: false,
      failedAt: 'verify',
      reason: 'Final verification probe failed. The CLI or login may have regressed; try again or run `devtunnel user show` manually.',
      cliPreInstalled,
      loginPreExisting,
      version: finalVersion ?? version,
      account: finalAccount ?? account,
    };
  }

  return {
    ok: true,
    cliPreInstalled,
    loginPreExisting,
    version: finalVersion,
    account: finalAccount,
  };
}
