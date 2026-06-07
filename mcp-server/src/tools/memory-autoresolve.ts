/**
 * tools/memory-autoresolve.ts
 *
 * Phase 8 — optional wiki-conflict auto-resolution via spawned agent.
 *
 * Only triggers on wiki body conflicts (everything else in the design
 * is conflict-free by construction: append-only events + immutable
 * memory/lesson/session bodies).
 *
 * Default is OFF — opt-in via config.auto_resolve_conflicts === 'auto'.
 * Even when enabled, multiple safety gates restrict what auto-resolve
 * will attempt:
 *   - only wiki body conflicts
 *   - max diff lines (default 100)
 *   - max conflicts per file per hour (default 3)
 *   - spawn timeout (default 5 min)
 *
 * Pre-merge git tags are always created BEFORE any merge attempt so the
 * pre-conflict state is recoverable for 30 days:
 *   memory-pre-merge/<ms>-ours    → HEAD before the merge
 *   memory-pre-merge/<ms>-theirs  → FETCH_HEAD at the time of conflict
 *
 * The spawnAgent function is injected to keep this module testable
 * without a real CLI subprocess. Production wires it to session.send.
 */

import { spawnSync } from 'node:child_process';
import type { VaultInfo } from '../vault-chain.ts';
import type { MemoryConfig } from './memory-config.ts';

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gitOrThrow(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

export interface SpawnAgentResult {
  exit_code: number;
  /** SHA of the merge commit the agent produced (if any). */
  merged_commit?: string;
  /** Optional human-readable hint when the agent declined. */
  reason?: string;
}

export type SpawnAgentFn = (args: {
  cwd: string;
  prompt: string;
  sessionId: string;
  timeoutMs: number;
}) => Promise<SpawnAgentResult>;

export interface ConflictContext {
  vault: VaultInfo;
  conflictPath: string;        // vault-relative, e.g. "p/wiki/architecture/overview.md"
  base_sha: string;
  our_sha: string;
  their_sha: string;
}

export interface AutoResolveOptions {
  config: MemoryConfig;
  spawnAgent: SpawnAgentFn;
  now: () => Date;
  /** Best-effort inbox hook (failures swallowed). */
  inbox?: (entry: InboxEntry) => Promise<void> | void;
}

export interface InboxEntry {
  severity: 'info' | 'warning';
  title: string;
  hint: string;
}

export interface AutoResolveResult {
  /** Was auto-resolve attempted (vs gated off). */
  attempted: boolean;
  /** Did the merge succeed and produce a commit. */
  resolved: boolean;
  /** Human-readable summary. */
  reason: string;
  /** Pre-merge git tag created for revert (always present after this returns). */
  preMergeTag?: string;
  /** Theirs-side tag for inspection. */
  preMergeTagTheirs?: string;
}

// ---------------------------------------------------------------------------
// Per-file conflict frequency tracking — in-memory, prune-on-read.
// ---------------------------------------------------------------------------

const conflictHistory: Map<string, number[]> = new Map();

function recordConflict(key: string, now: number): void {
  const arr = conflictHistory.get(key) ?? [];
  arr.push(now);
  // prune entries older than 1 hour
  const cutoff = now - 60 * 60 * 1000;
  const fresh = arr.filter((ts) => ts >= cutoff);
  conflictHistory.set(key, fresh);
}

function recentConflictCount(key: string, now: number): number {
  const arr = conflictHistory.get(key) ?? [];
  const cutoff = now - 60 * 60 * 1000;
  return arr.filter((ts) => ts >= cutoff).length;
}

export function _resetConflictHistory(): void {
  conflictHistory.clear();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function attemptAutoResolve(
  conflict: ConflictContext,
  opts: AutoResolveOptions,
): Promise<AutoResolveResult> {
  const nowMs = opts.now().getTime();
  recordConflict(`${conflict.vault.id}:${conflict.conflictPath}`, nowMs);

  // Always tag pre-merge state — independent of whether we attempt.
  const tagBase = `memory-pre-merge/${nowMs}`;
  const tagOurs = `${tagBase}-ours`;
  const tagTheirs = `${tagBase}-theirs`;
  try {
    gitOrThrow(conflict.vault.path, ['tag', tagOurs, conflict.our_sha]);
  } catch {
    // If we couldn't tag (e.g., SHA invalid), still continue — caller
    // already has a problem, we just can't help with revert.
  }
  try {
    gitOrThrow(conflict.vault.path, ['tag', tagTheirs, conflict.their_sha]);
  } catch { /* ignore */ }

  // Gate 1: opt-in only.
  if (opts.config.auto_resolve_conflicts !== 'auto') {
    return halt({
      reason: `auto_resolve_conflicts is 'manual'; conflict left for human resolution`,
      preMergeTag: tagOurs, preMergeTagTheirs: tagTheirs,
    });
  }

  // Gate 2: wiki subtree only.
  if (!isWikiPath(conflict.conflictPath)) {
    return halt({
      reason: `conflict in non-wiki path (${conflict.conflictPath}) — auto-resolve is wiki-only`,
      preMergeTag: tagOurs, preMergeTagTheirs: tagTheirs,
    });
  }

  // Gate 3: frequency cap.
  const recent = recentConflictCount(`${conflict.vault.id}:${conflict.conflictPath}`, nowMs);
  if (recent > opts.config.auto_resolve.max_conflicts_per_file_per_hour) {
    return halt({
      reason: `${recent} conflicts in last hour for ${conflict.conflictPath} exceeds cap of ${opts.config.auto_resolve.max_conflicts_per_file_per_hour}`,
      preMergeTag: tagOurs, preMergeTagTheirs: tagTheirs,
    });
  }

  // Gate 4: diff size cap.
  const diffLines = countDiffLines(conflict);
  if (diffLines > opts.config.auto_resolve.max_diff_lines) {
    return halt({
      reason: `diff size ${diffLines} > cap ${opts.config.auto_resolve.max_diff_lines}; likely a real disagreement`,
      preMergeTag: tagOurs, preMergeTagTheirs: tagTheirs,
    });
  }

  // All gates passed — try the spawn.
  const prompt = buildPrompt(conflict);
  const sessionId = `memory-conflict-${slugForSession(conflict.conflictPath)}-${nowMs}`;

  let result: SpawnAgentResult;
  try {
    result = await opts.spawnAgent({
      cwd: conflict.vault.path,
      prompt,
      sessionId,
      timeoutMs: opts.config.auto_resolve.spawn_timeout_ms,
    });
  } catch (err) {
    const entry: InboxEntry = {
      severity: 'warning',
      title: `Auto-merge spawn errored for ${conflict.conflictPath}`,
      hint: `${(err as Error).message}. Revert with: git reset --hard ${tagOurs}`,
    };
    await safeInbox(opts, entry);
    return {
      attempted: true,
      resolved: false,
      reason: `spawn error: ${(err as Error).message}`,
      preMergeTag: tagOurs,
      preMergeTagTheirs: tagTheirs,
    };
  }

  if (result.exit_code === 0 && hasNewCommitOn(conflict)) {
    await safeInbox(opts, {
      severity: 'info',
      title: `Auto-merged ${conflict.conflictPath} — please review`,
      hint: `Pre-merge state preserved at tag: ${tagOurs}. Revert with: git reset --hard ${tagOurs}`,
    });
    return {
      attempted: true,
      resolved: true,
      reason: result.reason ?? 'merged',
      preMergeTag: tagOurs,
      preMergeTagTheirs: tagTheirs,
    };
  }

  // Spawn ran but didn't merge: declined or failed.
  await safeInbox(opts, {
    severity: 'warning',
    title: `Auto-merge declined for ${conflict.conflictPath}`,
    hint: `${result.reason ?? `exit ${result.exit_code}`}. Resolve manually. Revert with: git reset --hard ${tagOurs}`,
  });
  return {
    attempted: true,
    resolved: false,
    reason: result.reason ?? `agent exit ${result.exit_code}`,
    preMergeTag: tagOurs,
    preMergeTagTheirs: tagTheirs,
  };
}

function halt(o: { reason: string; preMergeTag?: string; preMergeTagTheirs?: string }): AutoResolveResult {
  return { attempted: false, resolved: false, reason: o.reason, preMergeTag: o.preMergeTag, preMergeTagTheirs: o.preMergeTagTheirs };
}

async function safeInbox(opts: AutoResolveOptions, entry: InboxEntry): Promise<void> {
  if (!opts.inbox) return;
  try { await opts.inbox(entry); } catch { /* never fail on inbox */ }
}

function isWikiPath(path: string): boolean {
  // Vault-relative: <project>/wiki/<rest>.md
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 3 && parts[1] === 'wiki';
}

function countDiffLines(conflict: ConflictContext): number {
  // Compare our_sha vs their_sha for the conflict path. If the SHAs are
  // missing or the diff command fails, return Infinity so the gate
  // refuses the merge (fail-closed).
  if (!conflict.our_sha || !conflict.their_sha) return Number.POSITIVE_INFINITY;
  const r = git(conflict.vault.path, [
    'diff', '--numstat',
    conflict.our_sha, conflict.their_sha,
    '--', conflict.conflictPath,
  ]);
  if (r.status !== 0) return Number.POSITIVE_INFINITY;
  // numstat lines: "added\tdeleted\tpath"
  let total = 0;
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (!m) continue;
    const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
    const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10);
    total += added + deleted;
  }
  return total;
}

function hasNewCommitOn(conflict: ConflictContext): boolean {
  // After a successful merge, HEAD should differ from both our_sha and
  // their_sha (it's a new merge commit or a fast-forward to their_sha).
  const head = git(conflict.vault.path, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return false;
  const headSha = head.stdout.trim();
  // We accept either a new commit (typical merge) OR a fast-forward to their_sha
  // (rare, but valid resolution if the agent rebased our changes onto theirs).
  return headSha !== conflict.our_sha;
}

function buildPrompt(conflict: ConflictContext): string {
  return `You are resolving a 3-way merge conflict in a team memory wiki page.

Repo: ${conflict.vault.path}
File: ${conflict.conflictPath}

Read all three versions:
  git show ${conflict.base_sha}:${conflict.conflictPath}     # common ancestor
  git show ${conflict.our_sha}:${conflict.conflictPath}      # our edit
  git show ${conflict.their_sha}:${conflict.conflictPath}    # their edit

Produce a merged body preserving both teammates' intent. If sections
genuinely conflict, prefer the more recent edit and add an Obsidian
callout pointing to ${conflict.their_sha} for the alternate version:

  > [!note] Auto-merged ${new Date().toISOString().slice(0, 10)} — both teammates edited this
  > section. Kept the more recent version; the alternate is preserved at
  > commit ${conflict.their_sha} for reference.

When done:
  git add ${conflict.conflictPath}
  git commit -m "wiki: auto-resolve merge for ${conflict.conflictPath}"
  exit 0

If you cannot safely merge (file deleted on either side, frontmatter
conflicts, code-block boundaries you can't reconcile, etc.):
  git merge --abort
  exit 1
`;
}

function slugForSession(path: string): string {
  return path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
}
