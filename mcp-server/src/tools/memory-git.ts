/**
 * tools/memory-git.ts
 *
 * Inline `git add + commit` helper + git status / sync helpers.
 *
 * Detects external (manual) changes to the working tree before our
 * own commit and snapshots them in a preceding "memory: external
 * edits detected" commit so they survive.
 *
 * Synchronous execution by design — all calls go through withVaultLock
 * upstream, so blocking the event loop briefly is acceptable.
 */

import { spawnSync } from 'node:child_process';

function run(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${r.status}) in ${cwd}\n` +
      `stderr: ${r.stderr ?? ''}\nstdout: ${r.stdout ?? ''}`,
    );
  }
  return r.stdout ?? '';
}

function runAllowFailure(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function hasUnstagedChanges(repoPath: string): boolean {
  const out = run(repoPath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

export function getCurrentSha(repoPath: string): string {
  return run(repoPath, ['rev-parse', 'HEAD']).trim();
}

export function getCurrentBranch(repoPath: string): string {
  return run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export interface RepoState {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  has_remote: boolean;
}

export function getRepoState(repoPath: string): RepoState {
  const branch = getCurrentBranch(repoPath);
  const remoteCheck = runAllowFailure(repoPath, ['remote']);
  const hasRemote = remoteCheck.stdout.trim().length > 0;
  const dirty = hasUnstagedChanges(repoPath);
  let ahead = 0;
  let behind = 0;
  if (hasRemote) {
    const tracking = runAllowFailure(repoPath, ['rev-list', '--left-right', '--count', `${branch}...@{u}`]);
    if (tracking.status === 0) {
      const parts = tracking.stdout.trim().split(/\s+/);
      ahead = parseInt(parts[0] ?? '0', 10) || 0;
      behind = parseInt(parts[1] ?? '0', 10) || 0;
    }
  }
  return { branch, ahead, behind, dirty, has_remote: hasRemote };
}

export interface SyncOutcome {
  branch: string;
  pulled: boolean;
  pushed: boolean;
  conflict: boolean;
  message: string;
  /** When conflict=true: SHAs needed by auto-resolve. */
  base_sha?: string;
  our_sha?: string;
  their_sha?: string;
  /** When conflict=true: vault-relative paths of files in conflict. */
  conflict_paths?: string[];
}

/**
 * Sync a single repo with its remote: fetch + pull --rebase + push.
 * If no remote is configured, returns a no-op outcome. If pull-rebase
 * encounters a conflict, returns conflict=true plus the base/ours/theirs
 * SHAs needed by auto-resolve. The working tree is LEFT IN the conflict
 * state (rebase --abort would discard local changes); the caller is
 * responsible for either invoking attemptAutoResolve, aborting, or
 * surfacing to the user via inbox.
 */
export function syncRepo(repoPath: string): SyncOutcome {
  const branch = getCurrentBranch(repoPath);
  const remoteCheck = runAllowFailure(repoPath, ['remote']);
  if (!remoteCheck.stdout.trim()) {
    return { branch, pulled: false, pushed: false, conflict: false, message: 'no remote configured; skipped' };
  }

  // Capture our HEAD BEFORE the rebase attempt so auto-resolve can revert.
  const oursBefore = runAllowFailure(repoPath, ['rev-parse', 'HEAD']).stdout.trim();

  // Fetch first.
  const fetched = runAllowFailure(repoPath, ['fetch', '--quiet']);
  if (fetched.status !== 0) {
    return {
      branch, pulled: false, pushed: false, conflict: false,
      message: `git fetch failed: ${fetched.stderr.trim() || `exit ${fetched.status}`}`,
    };
  }

  // Capture remote head (FETCH_HEAD) and the merge base for context if conflict.
  const theirsSha = runAllowFailure(repoPath, ['rev-parse', 'FETCH_HEAD']).stdout.trim();

  // Try rebase.
  const rebased = runAllowFailure(repoPath, ['pull', '--rebase', '--quiet', '--no-edit']);
  if (rebased.status !== 0) {
    const baseSha = runAllowFailure(repoPath, ['merge-base', oursBefore, theirsSha]).stdout.trim();
    const conflictPaths = listConflictPaths(repoPath);
    return {
      branch, pulled: false, pushed: false, conflict: true,
      message: `pull --rebase conflict: ${rebased.stderr.trim()}`,
      base_sha: baseSha || undefined,
      our_sha: oursBefore || undefined,
      their_sha: theirsSha || undefined,
      conflict_paths: conflictPaths,
    };
  }

  // Push.
  const pushed = runAllowFailure(repoPath, ['push', '--quiet', 'origin', branch]);
  if (pushed.status !== 0) {
    return {
      branch, pulled: true, pushed: false, conflict: false,
      message: `git push failed: ${pushed.stderr.trim() || `exit ${pushed.status}`}`,
    };
  }

  return { branch, pulled: true, pushed: true, conflict: false, message: 'ok' };
}

function listConflictPaths(repoPath: string): string[] {
  const r = runAllowFailure(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Abort an in-progress rebase. Best-effort; safe to call when no rebase active. */
export function abortRebase(repoPath: string): void {
  runAllowFailure(repoPath, ['rebase', '--abort']);
}

/** Try a single-file fast-forward push for an already-resolved conflict. */
export function tryPush(repoPath: string, branch?: string): { ok: boolean; message: string } {
  const b = branch ?? getCurrentBranch(repoPath);
  const r = runAllowFailure(repoPath, ['push', '--quiet', 'origin', b]);
  if (r.status === 0) return { ok: true, message: 'ok' };
  return { ok: false, message: r.stderr.trim() || `exit ${r.status}` };
}

/**
 * List every changed file (untracked, modified, staged), one path per
 * line. Uses `-uall` so untracked directories expand to individual
 * files instead of being reported as the directory itself.
 */
function listChangedFiles(repoPath: string): string[] {
  const out = run(repoPath, ['status', '-uall', '--porcelain']);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).replace(/\\/g, '/');
    if (p.startsWith('"') && p.endsWith('"')) {
      p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    paths.push(p);
  }
  return paths;
}

export function commitInline(
  repoPath: string,
  paths: string[],
  message: string,
): string {
  const ourSet = new Set(paths.map((p) => p.replace(/\\/g, '/')));
  const allChanged = listChangedFiles(repoPath);
  const externals = allChanged.filter((p) => !ourSet.has(p));

  if (externals.length > 0) {
    run(repoPath, ['add', '--', ...externals]);
    run(repoPath, ['commit', '-q', '-m', 'memory: external edits detected']);
  }

  run(repoPath, ['add', '--', ...paths]);
  run(repoPath, ['commit', '-q', '-m', message]);
  return getCurrentSha(repoPath);
}
