/**
 * install-supervisor.ts
 *
 * Programmatic entry point for the Clawdevbox auto-restart supervisor +
 * Windows Task Scheduler "run at logon" task. Called from `clawdevbox
 * init` so a fresh setup gets crash-recovery out of the box (Windows
 * only — no equivalent on macOS / Linux yet).
 *
 * The actual supervisor logic lives in PowerShell scripts under
 * `mcp-server/supervisor/`. We invoke them via `powershell.exe -File
 * <install-task.ps1>` so the install logic stays in ONE place
 * (the PS script) and can also be run by hand from a non-init context.
 *
 * On non-Windows platforms this is a no-op (returns `{ ok: false }`).
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export interface InstallSupervisorResult {
  ok: boolean;
  /** Path to install-task.ps1 we tried to run. */
  scriptPath: string;
  /** Stdout from the install script, if any. */
  output?: string;
  /** Error message when ok=false. */
  error?: string;
  /** True when no supervisor support exists for this platform yet. */
  unsupportedPlatform?: boolean;
}

/**
 * Run `mcp-server/supervisor/install-task.ps1` against the given repo
 * root. Returns a structured result so callers can render a friendly
 * note to the user.
 */
export function installSupervisor(opts: { repoRoot: string }): InstallSupervisorResult {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      scriptPath: '',
      error: 'supervisor is currently Windows-only',
      unsupportedPlatform: true,
    };
  }

  // Locate install-task.ps1. Two candidates:
  //   1. <dist>/supervisor/install-task.ps1   (production layout — packaged)
  //   2. <repo>/mcp-server/supervisor/install-task.ps1  (dev mode)
  const candidates = [
    join(here, 'supervisor', 'install-task.ps1'),
    join(here, '..', 'supervisor', 'install-task.ps1'),
    join(here, '..', '..', 'supervisor', 'install-task.ps1'),
    join(opts.repoRoot, 'mcp-server', 'supervisor', 'install-task.ps1'),
  ];
  const scriptPath = candidates.find((p) => existsSync(p));
  if (!scriptPath) {
    return {
      ok: false,
      scriptPath: candidates[0],
      error: `install-task.ps1 not found (tried: ${candidates.join(', ')})`,
    };
  }

  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-RepoRoot', opts.repoRoot,
    ],
    {
      stdio: 'pipe',
      windowsHide: true,
      // 60s should be plenty for the registration; the script does a
      // single Register-ScheduledTask call.
      timeout: 60_000,
    },
  );
  const output =
    (r.stdout?.toString('utf8') ?? '') + (r.stderr?.toString('utf8') ?? '');
  if (r.status !== 0) {
    return {
      ok: false,
      scriptPath,
      output,
      error: `install-task.ps1 exited ${r.status}`,
    };
  }
  return { ok: true, scriptPath, output };
}
