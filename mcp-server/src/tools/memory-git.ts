/**
 * tools/memory-git.ts
 *
 * Inline `git add + commit` helper. Detects external (manual) changes
 * to the working tree before our own commit and snapshots them in a
 * preceding "memory: external edits detected" commit so they survive.
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

export function hasUnstagedChanges(repoPath: string): boolean {
  const out = run(repoPath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

export function getCurrentSha(repoPath: string): string {
  return run(repoPath, ['rev-parse', 'HEAD']).trim();
}

/**
 * List every changed file (untracked, modified, staged), one path per
 * line. Uses `-uall` so untracked directories expand to individual
 * files instead of being reported as the directory itself — without
 * this, our own new files inside a new directory get misclassified as
 * "external" changes.
 */
function listChangedFiles(repoPath: string): string[] {
  const out = run(repoPath, ['status', '-uall', '--porcelain']);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3).replace(/\\/g, '/');
    // git quotes paths containing special chars
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
