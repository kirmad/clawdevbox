/**
 * stale-locks.ts
 *
 * Remove stale `inuse.<pid>.lock` files from `~/.copilot/session-state/<uuid>/`
 * directories. Copilot writes these locks when a session opens and removes
 * them on CLEAN exit (graceful SIGINT, `/exit` typed by user). On UNCLEAN
 * exit (force-kill, OS crash, SIGKILL, power loss) the locks stay behind
 * referencing dead PIDs.
 *
 * The next time copilot opens any of those sessions — via clawdevbox's
 * spawn, or via the user running `copilot --session-id=<uuid>` directly —
 * it sees the stale lock and shows the "Session in use" modal that
 * swallows our initial prompt.
 *
 * Solution: on clawdevbox startup, sweep all `~/.copilot/session-state/*`
 * directories, find every `inuse.<pid>.lock` file, and check if the referenced
 * PID is alive. If it is NOT alive, the lock is stale — remove it.
 *
 * This is safe to run concurrently with live copilot processes because:
 *   - We only remove locks whose PID is NOT in the process table
 *   - A live copilot's lock file always references its own PID (alive),
 *     so we never touch in-use locks
 *
 * Called from cli/start.ts at startup, BEFORE any spawn happens.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { logger } from './logger.ts';

const LOCK_FILE_RE = /^inuse\.(\d+)\.lock$/;

function copilotSessionStateRoot(): string {
  return join(os.homedir(), '.copilot', 'session-state');
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  // Windows: process.kill(pid, 0) is unreliable on Windows (returns EPERM
  // for many cases regardless of whether the PID exists). Use tasklist and
  // additionally check the process name — `copilot.exe` locks belong to
  // copilot; if the PID got reused by something else (msedge, uvx, …) the
  // lock is stale even though the PID is "alive".
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      // CSV row format: "ImageName","PID","Session","Session#","Mem"
      const m = out.match(/^"([^"]+)","(\d+)"/m);
      if (!m) return false;
      const imageName = m[1].toLowerCase();
      // Treat as "alive copilot" only if the image name actually looks like
      // copilot. Anything else means the PID was reused.
      return imageName.startsWith('copilot');
    } catch {
      return false;
    }
  }
  // POSIX: kill(pid, 0) raises ESRCH if not found, EPERM only when process
  // exists but we lack permission (which still means it's alive). We don't
  // attempt the process-name check on POSIX because reused PIDs are far
  // less common (PID reuse only after wraparound).
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Sweep `~/.copilot/session-state/` for stale `inuse.<pid>.lock` files
 * and remove them. Returns {scanned, removed} for logging.
 *
 * Always returns; never throws. Permission errors and missing directories
 * are silently tolerated.
 */
export function cleanCopilotStaleLocks(): { scanned: number; removed: number } {
  const root = copilotSessionStateRoot();
  let scanned = 0;
  let removed = 0;

  if (!existsSync(root)) return { scanned, removed };

  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(root);
  } catch {
    return { scanned, removed };
  }

  for (const sessionDir of sessionDirs) {
    const sessionPath = join(root, sessionDir);
    let st;
    try {
      st = statSync(sessionPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let entries: string[];
    try {
      entries = readdirSync(sessionPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const m = entry.match(LOCK_FILE_RE);
      if (!m) continue;
      scanned++;
      const pid = parseInt(m[1], 10);
      if (isPidAlive(pid)) continue;
      try {
        unlinkSync(join(sessionPath, entry));
        removed++;
      } catch (err) {
        logger.warn(
          { sessionDir, entry, err: err instanceof Error ? err.message : String(err) },
          'stale-locks: failed to remove stale inuse lock',
        );
      }
    }
  }

  return { scanned, removed };
}
