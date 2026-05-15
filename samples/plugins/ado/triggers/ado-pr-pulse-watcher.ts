#!/usr/bin/env tsx
/**
 * ado-pr-pulse-watcher.ts
 *
 * A long-running trigger that watches an Azure DevOps PR for live activity
 * (new comments + new iteration pushes) and pings the agent in real time.
 *
 * REFERENCE IMPLEMENTATION of MIXED MODE A + MODE B (spec §8.4).
 *
 * Why both modes in one script:
 *   - Live events (new comment / new iteration) want the LOWEST possible
 *     latency. The script POSTs each one directly to env.callback_url as
 *     soon as it sees the event (Mode B). The agent gets pinged within the
 *     poll interval, not on the next cron tick.
 *   - The final summary ("budget reached" / "PR closed") doesn't need that
 *     latency — it's emitted once on exit. We deliver it the simple way:
 *     a single Mode A `callback` object on stdout (singular — the spec allows
 *     at most one). The script's exit is the natural handoff point.
 *
 * Clawdevbox's callback fan-out treats both modes identically, so the agent
 * on the receiving end sees one homogeneous stream of `{ prompt, context }`
 * pings.
 *
 * Lifecycle (per invocation):
 *   1. Compute deadline = now + state.maxRunSec * 1000.
 *   2. Loop until deadline OR PR closes:
 *        a. Fetch PR status. If status != "active", break.
 *        b. Fetch new comments since state.lastCommentId. POST each one
 *           (Mode B) and advance state.lastCommentId.
 *        c. Fetch iterations. POST each one with id > state.lastIterationId
 *           (Mode B) and advance state.lastIterationId.
 *        d. Sleep state.pollIntervalSec * 1000 — but never past deadline.
 *   3. Build ONE summary callback describing exit cause.
 *   4. Stdout: { state, callback: <summary>, systemMessage }, exit 0.
 *
 * One failed poll inside the loop should NOT kill the run — wrap each tick
 * in try/catch, log to stderr, and try again next tick. The summary at the
 * end will still fire.
 *
 * Auth (same as ado-comment-watcher.ts):
 *   ADO_BEARER_TOKEN — preferred (AAD access token).
 *   ADO_PAT          — fallback (basic auth).
 *
 * Mode B requires CLAWDEVBOX_MCP_SECRET for the Authorization header on
 * direct callback POSTs. (Mode A doesn't — Clawdevbox authenticates its own
 * internal fan-out.)
 *
 * Zero dependencies beyond Node 20+ built-ins.
 */

// ============================================================================
// Types
// ============================================================================

type FiredBy = 'external' | 'cron' | 'manual' | 'agent';

interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  fired_by: FiredBy;
  fired_at: number;
  cwd: string;
  project_dir: string;
  trigger_data_dir: string;
  subscriber_thread_id: string | null;
  /** Pre-bound callback URL. Used in BOTH Mode B (direct POSTs during loop)
   *  AND Mode A (Clawdevbox delivers the on-exit summary entry to this URL). */
  callback_url: string;
  state: WatcherState;
  payload: unknown;
}

interface WatcherState {
  /** PR id this trigger watches. */
  prId: number;
  /** ADO repo name. */
  repo: string;
  /** Skip events authored by this user. */
  selfUser: string;
  /** Last comment id forwarded; advances monotonically. */
  lastCommentId: number;
  /** Last iteration id forwarded; advances monotonically. */
  lastIterationId: number;
  /** Seconds between polls inside the loop. */
  pollIntervalSec: number;
  /** Total seconds this invocation is allowed to run. */
  maxRunSec: number;
}

interface AdoComment {
  id: number;
  content: string;
  author: { uniqueName?: string; displayName?: string };
  publishedDate: string;
}

interface AdoIteration {
  id: number;
  description?: string;
  author?: { uniqueName?: string; displayName?: string };
  createdDate?: string;
  sourceRefCommit?: { commitId?: string };
}

interface CallbackBody {
  prompt: string;
  context?: Record<string, unknown>;
}

interface CallbackRequest {
  body: CallbackBody;
}

interface TriggerResponse {
  state?: WatcherState;
  /** Mode A — at most ONE callback per run (the on-exit summary). */
  callback?: CallbackRequest;
  systemMessage?: string;
}

// ============================================================================
// I/O helpers
// ============================================================================

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeStdout(response: TriggerResponse): void {
  process.stdout.write(JSON.stringify(response));
}

function blockingError(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

function logErr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// ADO client (raw HTTP — bearer token preferred, basic-auth with PAT fallback)
// Auth-header logic copied verbatim from ado-comment-watcher.ts (intentional —
// each sample is self-contained; no cross-file refactor).
// ============================================================================

const ADO_ORG = process.env.ADO_ORG ?? '';
const ADO_PAT = process.env.ADO_PAT ?? '';
const ADO_BEARER_TOKEN = process.env.ADO_BEARER_TOKEN ?? '';

/** Mode B requires this for the Authorization header on direct callback POSTs. */
const CLAWDEVBOX_MCP_SECRET = process.env.CLAWDEVBOX_MCP_SECRET ?? '';

function adoAuthHeader(): string {
  if (ADO_BEARER_TOKEN) return `Bearer ${ADO_BEARER_TOKEN}`;
  if (ADO_PAT) return `Basic ${Buffer.from(`:${ADO_PAT}`).toString('base64')}`;
  throw new Error('ADO_BEARER_TOKEN or ADO_PAT env var required');
}

function adoBaseUrl(repo: string): string {
  if (!ADO_ORG) throw new Error('ADO_ORG env var required');
  return `https://dev.azure.com/${ADO_ORG}/_apis/git/repositories/${encodeURIComponent(repo)}`;
}

interface PrStatus {
  status: string;
  title: string;
}

async function fetchPrStatus(repo: string, prId: number): Promise<PrStatus> {
  const url = `${adoBaseUrl(repo)}/pullRequests/${prId}?api-version=7.1-preview.1`;
  const res = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
  if (!res.ok) throw new Error(`ADO PR ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { status?: string; title?: string };
  return { status: body.status ?? 'unknown', title: body.title ?? '' };
}

async function listPrComments(repo: string, prId: number, sinceId: number): Promise<AdoComment[]> {
  const url = `${adoBaseUrl(repo)}/pullRequests/${prId}/threads?api-version=7.1-preview.1`;
  const res = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
  if (!res.ok) throw new Error(`ADO threads ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as {
    value?: Array<{ comments?: Array<Record<string, unknown>> }>;
  };

  const comments: AdoComment[] = [];
  for (const thread of body.value ?? []) {
    for (const c of thread.comments ?? []) {
      if (c.commentType === 'system') continue;
      const id = c.id as number;
      if (typeof id !== 'number' || id <= sinceId) continue;
      const author = c.author as { uniqueName?: string; displayName?: string } | undefined;
      comments.push({
        id,
        content: (c.content as string) ?? '',
        author: { uniqueName: author?.uniqueName, displayName: author?.displayName },
        publishedDate: (c.publishedDate as string) ?? new Date().toISOString(),
      });
    }
  }

  return comments.sort((a, b) => a.id - b.id);
}

async function listPrIterations(repo: string, prId: number, sinceId: number): Promise<AdoIteration[]> {
  const url = `${adoBaseUrl(repo)}/pullRequests/${prId}/iterations?api-version=7.1-preview.1`;
  const res = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
  if (!res.ok) throw new Error(`ADO iterations ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as {
    value?: Array<Record<string, unknown>>;
  };

  const iterations: AdoIteration[] = [];
  for (const it of body.value ?? []) {
    const id = it.id as number;
    if (typeof id !== 'number' || id <= sinceId) continue;
    const author = it.author as { uniqueName?: string; displayName?: string } | undefined;
    const sourceRefCommit = it.sourceRefCommit as { commitId?: string } | undefined;
    iterations.push({
      id,
      description: (it.description as string | undefined) ?? '',
      author: { uniqueName: author?.uniqueName, displayName: author?.displayName },
      createdDate: (it.createdDate as string | undefined) ?? new Date().toISOString(),
      sourceRefCommit: sourceRefCommit ? { commitId: sourceRefCommit.commitId } : undefined,
    });
  }

  return iterations.sort((a, b) => a.id - b.id);
}

// ============================================================================
// Prompt construction — translate raw events into agent-readable instructions.
// ============================================================================

function commentToPrompt(prId: number, comment: AdoComment): string {
  const author = comment.author.displayName ?? comment.author.uniqueName ?? 'a reviewer';
  const at = new Date(comment.publishedDate).toLocaleString();
  return [
    `[live] New comment on PR ${prId} from ${author} (${at}):`,
    ``,
    `> ${comment.content.split('\n').join('\n> ')}`,
    ``,
    `This came in while you were watching the PR. Address it now if you can —`,
    `if it's a question, answer it; if it's a change request, draft a plan and`,
    `ask for approval before applying. Otherwise acknowledge briefly.`,
  ].join('\n');
}

function iterationToPrompt(prId: number, iter: AdoIteration): string {
  const author = iter.author?.displayName ?? iter.author?.uniqueName ?? 'the author';
  const at = iter.createdDate ? new Date(iter.createdDate).toLocaleString() : 'just now';
  const commit = iter.sourceRefCommit?.commitId ? ` (commit ${iter.sourceRefCommit.commitId.slice(0, 8)})` : '';
  const desc = iter.description ? `\n\nDescription:\n> ${iter.description.split('\n').join('\n> ')}` : '';
  return [
    `[live] New iteration #${iter.id} pushed on PR ${prId} by ${author} at ${at}${commit}.${desc}`,
    ``,
    `Re-read the diff for the latest iteration. If your previous review`,
    `comments still apply, restate them; if they were addressed, acknowledge`,
    `and move on. Look for new issues introduced by this push.`,
  ].join('\n');
}

// ============================================================================
// Mode B — POST a single callback directly to env.callback_url.
// ============================================================================

async function postLiveCallback(callbackUrl: string, body: CallbackBody): Promise<void> {
  if (!CLAWDEVBOX_MCP_SECRET) {
    throw new Error('CLAWDEVBOX_MCP_SECRET env var required for Mode B callback POSTs');
  }
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CLAWDEVBOX_MCP_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`callback POST ${res.status}: ${text}`);
  }
}

// ============================================================================
// Main loop
// ============================================================================

async function main(): Promise<void> {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    writeStdout({ systemMessage: 'No stdin envelope received.' });
    return;
  }

  let env: TriggerEnvelope;
  try {
    env = JSON.parse(stdin);
  } catch (err) {
    blockingError(`Invalid JSON on stdin: ${(err as Error).message}`);
  }

  // Hydrate state with defaults (spread first so env.state can override).
  const defaults: WatcherState = {
    prId: 0,
    repo: '',
    selfUser: '',
    lastCommentId: 0,
    lastIterationId: 0,
    pollIntervalSec: 5,
    maxRunSec: 60,
  };
  const state: WatcherState = { ...defaults, ...env.state };

  if (!state.prId || !state.repo) {
    blockingError('state.prId and state.repo must be set when the trigger is registered');
  }
  if (state.pollIntervalSec <= 0) {
    blockingError('state.pollIntervalSec must be > 0');
  }
  if (state.maxRunSec <= 0) {
    blockingError('state.maxRunSec must be > 0');
  }

  const callbackUrl = env.callback_url;
  if (!callbackUrl) {
    blockingError('env.callback_url missing — required for Mode B live POSTs');
  }

  const startedAt = Date.now();
  const deadline = startedAt + state.maxRunSec * 1000;

  let liveCommentsPosted = 0;
  let liveIterationsPosted = 0;
  let prClosed = false;
  let lastPrStatus = 'unknown';
  let ticks = 0;
  let firstTickError: string | null = null;

  // ----- Loop -----
  while (Date.now() < deadline) {
    ticks++;
    try {
      // (a) PR status
      const prStatus = await fetchPrStatus(state.repo, state.prId);
      lastPrStatus = prStatus.status;
      if (prStatus.status !== 'active') {
        prClosed = true;
        break;
      }

      // (b) New comments → Mode B POST one-by-one.
      const newComments = await listPrComments(state.repo, state.prId, state.lastCommentId);
      for (const c of newComments) {
        if (c.author.uniqueName && c.author.uniqueName === state.selfUser) {
          // Still advance the cursor — we've "seen" it.
          state.lastCommentId = Math.max(state.lastCommentId, c.id);
          continue;
        }
        const body: CallbackBody = {
          prompt: commentToPrompt(state.prId, c),
          context: {
            source: 'ado',
            kind: 'pr.commented',
            pr_id: state.prId,
            comment_id: c.id,
            delivery: 'live',
          },
        };
        await postLiveCallback(callbackUrl, body);
        liveCommentsPosted++;
        state.lastCommentId = Math.max(state.lastCommentId, c.id);
      }

      // (c) New iterations → Mode B POST one-by-one.
      const newIterations = await listPrIterations(state.repo, state.prId, state.lastIterationId);
      for (const it of newIterations) {
        if (it.author?.uniqueName && it.author.uniqueName === state.selfUser) {
          state.lastIterationId = Math.max(state.lastIterationId, it.id);
          continue;
        }
        const body: CallbackBody = {
          prompt: iterationToPrompt(state.prId, it),
          context: {
            source: 'ado',
            kind: 'pr.iteration_pushed',
            pr_id: state.prId,
            iteration_id: it.id,
            delivery: 'live',
          },
        };
        await postLiveCallback(callbackUrl, body);
        liveIterationsPosted++;
        state.lastIterationId = Math.max(state.lastIterationId, it.id);
      }
    } catch (err) {
      // One failed poll shouldn't kill the run — log and continue.
      const msg = err instanceof Error ? err.message : String(err);
      logErr(`[pulse-watcher] tick ${ticks} failed: ${msg}`);
      if (!firstTickError) firstTickError = msg;
    }

    // (d) Sleep, deadline-aware.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const sleepMs = Math.min(state.pollIntervalSec * 1000, remaining);
    await sleep(sleepMs);
  }

  // ----- Build the on-exit Mode A summary callback -----
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  let summaryPrompt: string;
  let exitReason: 'pr_closed' | 'time_budget_reached';
  if (prClosed) {
    exitReason = 'pr_closed';
    summaryPrompt = [
      `Pulse-watch on PR ${state.prId} ended: PR status flipped to "${lastPrStatus}".`,
      ``,
      `Live events delivered during the watch:`,
      `  - comments: ${liveCommentsPosted}`,
      `  - iterations: ${liveIterationsPosted}`,
      ``,
      `Recommendation: close the watch step. The PR is no longer active, so`,
      `there's nothing more to monitor. Move on to your next item.`,
    ].join('\n');
  } else {
    exitReason = 'time_budget_reached';
    summaryPrompt = [
      `Pulse-watch on PR ${state.prId} ended: ran for ${elapsedSec}s (budget ${state.maxRunSec}s).`,
      ``,
      `Live events delivered during the watch:`,
      `  - comments: ${liveCommentsPosted}`,
      `  - iterations: ${liveIterationsPosted}`,
      ``,
      `PR is still active. Decide whether to extend the watch (re-fire this`,
      `trigger) or move on for now — the next cron tick will pick it up`,
      `automatically if you keep the trigger registered.`,
    ].join('\n');
  }

  const summaryEntry: CallbackRequest = {
    body: {
      prompt: summaryPrompt,
      context: {
        source: 'ado',
        kind: 'pr.pulse_summary',
        pr_id: state.prId,
        exit_reason: exitReason,
        elapsed_sec: elapsedSec,
        ticks,
        live_comments_posted: liveCommentsPosted,
        live_iterations_posted: liveIterationsPosted,
        last_pr_status: lastPrStatus,
        delivery: 'on_exit',
        ...(firstTickError ? { first_tick_error: firstTickError } : {}),
      },
    },
  };

  writeStdout({
    state,
    callback: summaryEntry,
    systemMessage:
      `Pulse-watch on PR ${state.prId} done (${exitReason}, ${elapsedSec}s). ` +
      `Live: ${liveCommentsPosted} comment(s), ${liveIterationsPosted} iteration(s).`,
  });
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.stderr.write('\n');
  process.exit(1);
});
