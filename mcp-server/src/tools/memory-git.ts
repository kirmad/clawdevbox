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
}

/**
 * Sync a single repo with its remote: fetch + pull --rebase + push.
 * If no remote is configured, returns a no-op outcome. If pull-rebase
 * encounters a conflict, returns conflict=true; the working tree is
 * LEFT IN the conflict state (rebase --abort would discard the user's
 * pending changes). The caller is responsible for surfacing this to
 * the user via inbox.
 */
export function syncRepo(repoPath: string): SyncOutcome {
  const branch = getCurrentBranch(repoPath);
  const remoteCheck = runAllowFailure(repoPath, ['remote']);
  if (!remoteCheck.stdout.trim()) {
    return { branch, pulled: false, pushed: false, conflict: false, message: 'no remote configured; skipped' };
  }

  // Fetch first so we have an up-to-date view.
  const fetched = runAllowFailure(repoPath, ['fetch', '--quiet']);
  if (fetched.status !== 0) {
    return {
      branch, pulled: false, pushed: false, conflict: false,
      message: `git fetch failed: ${fetched.stderr.trim() || `exit ${fetched.status}`}`,
    };
  }

  // Try to rebase onto remote.
  const rebased = runAllowFailure(repoPath, ['pull', '--rebase', '--quiet', '--no-edit']);
  let pulled = rebased.status === 0;
  if (rebased.status !== 0) {
    // Detect conflict via in-progress rebase marker.
    const isRebasing = runAllowFailure(repoPath, ['rev-parse', '--git-path', 'rebase-merge']);
    const isApplying = runAllowFailure(repoPath, ['rev-parse', '--git-path', 'rebase-apply']);
    const hint = `${rebased.stderr.trim()} (rebase-merge=${isRebasing.stdout.trim()}, rebase-apply=${isApplying.stdout.trim()})`;
    return {
      branch, pulled: false, pushed: false, conflict: true,
      message: `pull --rebase conflict: ${hint}`,
    };
  }

  // Push.
  const pushed = runAllowFailure(repoPath, ['push', '--quiet', 'origin', branch]);
  if (pushed.status !== 0) {
    return {
      branch, pulled, pushed: false, conflict: false,
      message: `git push failed: ${pushed.stderr.trim() || `exit ${pushed.status}`}`,
    };
  }

  return { branch, pulled, pushed: true, conflict: false, message: 'ok' };
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
