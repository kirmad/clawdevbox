#!/usr/bin/env tsx
/**
 * ado-comment-watcher.ts
 *
 * A working trigger that listens for new comments on Azure DevOps PRs and
 * asks the agent to address each one.
 *
 * REFERENCE IMPLEMENTATION of Mode B (live POSTs during the run).
 *
 * Two execution modes are supported by the protocol — this script uses Mode B.
 *
 *   Mode A (NOT used here): respond via stdout.
 *     Build a single `callback: { body: {...} }` object on the JSON response
 *     and write it on stdout. Clawdevbox delivers that one entry to the
 *     trigger's pre-bound `env.callback_url`. The script makes zero HTTP calls.
 *     Mode A's `callback` is SINGULAR — at most one delivery per run, suitable
 *     for one-shot triggers or final/summary actions.
 *
 *   Mode B (USED HERE): script POSTs to env.callback_url directly during the
 *     run, once per detected event. Required when a single run may need to
 *     deliver more than one event. The stdout response carries only `{ state,
 *     systemMessage }` — no `callback` field, since the live POSTs already
 *     delivered the work.
 *
 *   No-op: just `{ "state": <unchanged> }` and exit 0. No HTTP calls.
 *
 * The script does NOT think about routing. Clawdevbox pre-bound
 * `env.callback_url` to the right action when this trigger was registered
 * (in this case: append + wake the subscriber thread). The URL itself
 * carries the routing context; the script just delivers the prompt.
 *
 * Two firing modes (orthogonal to A/B above), same handler:
 *   - fired_by="external": ADO service hook delivered the comment payload directly
 *   - fired_by="cron|manual|agent": no payload; poll ADO since lastCommentId
 *
 * Zero dependencies beyond Node 18+ built-in fetch.
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
  /** Workspace root — the user's project directory. */
  project_dir: string;
  /**
   * Per-trigger scratch directory at
   *   <project_dir>/.clawdevbox/triggers/<trigger_id>/data/
   * The script can write/read any files here to maintain data across runs
   * (caches, downloaded artifacts, anything too large for `state`).
   * Clawdevbox creates it on first run and cleans it up when the trigger is
   * deleted (for hot triggers, when the subscriber thread terminates).
   */
  trigger_data_dir: string;
  subscriber_thread_id: string | null;
  /**
   * Pre-bound callback URL. In Mode B (this script), the script POSTs each
   * detected event directly to this URL during the run.
   */
  callback_url: string;
  state: WatcherState;
  payload: AdoServiceHookPayload | null;
}

interface WatcherState {
  /** PR id this trigger watches (set once at trigger.upsert). */
  prId: number;
  /** ADO repo name. */
  repo: string;
  /** Last comment id we forwarded; advances monotonically. */
  lastCommentId: number;
  /** Skip our own comments to avoid reply loops. */
  selfUser: string;
}

interface AdoServiceHookPayload {
  resource?: {
    pullRequest?: { pullRequestId: number };
    comment?: {
      id: number;
      content: string;
      commentType?: 'system' | 'text';
      author?: { uniqueName?: string; displayName?: string };
      publishedDate?: string;
    };
  };
}

interface AdoComment {
  id: number;
  content: string;
  author: { uniqueName?: string; displayName?: string };
  publishedDate: string;
}

/** Body the script POSTs to env.callback_url for each detected event (Mode B). */
interface CallbackBody {
  prompt: string;
  context?: Record<string, unknown>;
}

interface TriggerResponse {
  state?: WatcherState;
  systemMessage?: string;
  decision?: 'ok' | 'block';
  reason?: string;
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

// ============================================================================
// ADO client (raw HTTP — bearer token preferred, basic-auth with PAT fallback)
//
// Auth env vars (one of these is required):
//   ADO_BEARER_TOKEN  — AAD access token (e.g. from `az account get-access-token`).
//                       Preferred when both are set.
//   ADO_PAT           — Azure DevOps personal access token (basic auth).
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

async function listPrComments(repo: string, prId: number, sinceId: number): Promise<AdoComment[]> {
  if (!ADO_ORG) throw new Error('ADO_ORG env var required');

  const url =
    `https://dev.azure.com/${ADO_ORG}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullRequests/${prId}/threads?api-version=7.1-preview.1`;

  const res = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
  if (!res.ok) throw new Error(`ADO ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as {
    value?: Array<{ comments?: Array<Record<string, unknown>> }>;
  };

  const comments: AdoComment[] = [];
  for (const thread of body.value ?? []) {
    for (const c of thread.comments ?? []) {
      if (c.commentType === 'system') continue;
      const id = c.id as number;
      if (id <= sinceId) continue;
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

// ============================================================================
// Prompt construction — the actual "intelligence" of this trigger
// ============================================================================

/**
 * Translate a raw ADO comment into a human-framed instruction for the agent.
 * The agent reads this prompt and decides how to respond.
 */
function commentToPrompt(prId: number, comment: AdoComment): string {
  const author = comment.author.displayName ?? comment.author.uniqueName ?? 'a reviewer';
  const at = new Date(comment.publishedDate).toLocaleString();

  return [
    `New comment on PR ${prId} from ${author} (${at}):`,
    ``,
    `> ${comment.content.split('\n').join('\n> ')}`,
    ``,
    `Look at this comment in the context of your current review.`,
    `If it's a question, draft a clear answer grounded in the diff.`,
    `If it's a change request, draft a plan and ask the user via approval.request before applying.`,
    `If it's affirming, acknowledge briefly and continue.`,
    `Consult the respond-to-pr-comment template for tone and structure.`,
  ].join('\n');
}

// ============================================================================
// Mode B — POST a single callback directly to env.callback_url.
// ============================================================================

async function postCallback(callbackUrl: string, body: CallbackBody): Promise<void> {
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

function bodyForComment(prId: number, comment: AdoComment): CallbackBody {
  return {
    prompt: commentToPrompt(prId, comment),
    context: { source: 'ado', kind: 'pr.commented', pr_id: prId, comment_id: comment.id },
  };
}

// ============================================================================
// Main
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

  // Hydrate state with defaults (spread first so env.state can override)
  const defaults: WatcherState = { prId: 0, repo: '', lastCommentId: 0, selfUser: '' };
  const state: WatcherState = { ...defaults, ...env.state };

  if (!state.prId || !state.repo) {
    blockingError('state.prId and state.repo must be set when the trigger is registered');
  }

  const callbackUrl = env.callback_url;
  if (!callbackUrl) {
    blockingError('env.callback_url missing — required for Mode B live POSTs');
  }

  // Note: env.trigger_data_dir is available as a per-trigger scratch directory
  // at `<project_dir>/.clawdevbox/triggers/<trigger_id>/data/`. This script
  // doesn't need it (lastCommentId fits in `state`), but a richer trigger
  // could write blobs there, e.g.:
  //   import { writeFile, mkdir } from 'node:fs/promises';
  //   import { join } from 'node:path';
  //   await mkdir(env.trigger_data_dir, { recursive: true });
  //   await writeFile(join(env.trigger_data_dir, `comment-${c.id}.json`), JSON.stringify(c));

  let posted = 0;

  // ----- Real-time path: ADO service hook delivered the comment -----
  const externalComment = env.payload?.resource?.comment;
  const externalPrMatches = env.payload?.resource?.pullRequest?.pullRequestId === state.prId;

  if (env.fired_by === 'external' && externalComment && externalPrMatches) {
    if (
      externalComment.commentType !== 'system' &&
      externalComment.author?.uniqueName !== state.selfUser
    ) {
      const c: AdoComment = {
        id: externalComment.id,
        content: externalComment.content,
        author: { uniqueName: externalComment.author?.uniqueName },
        publishedDate: externalComment.publishedDate ?? new Date().toISOString(),
      };
      await postCallback(callbackUrl, bodyForComment(state.prId, c));
      state.lastCommentId = c.id;
      posted++;
    }

    writeStdout({
      state,
      systemMessage:
        posted > 0
          ? `Forwarded 1 comment from ADO service hook (PR ${state.prId}).`
          : `Skipped self/system comment.`,
    });
    return;
  }

  // ----- Cron / manual / agent: poll ADO for new comments -----
  const newComments = await listPrComments(state.repo, state.prId, state.lastCommentId);

  for (const c of newComments) {
    if (c.author.uniqueName === state.selfUser) continue;
    await postCallback(callbackUrl, bodyForComment(state.prId, c));
    state.lastCommentId = c.id;
    posted++;
  }

  writeStdout({
    state,
    systemMessage:
      posted > 0
        ? `Forwarded ${posted} new comment(s) on PR ${state.prId} (fired_by=${env.fired_by}).`
        : `No new comments on PR ${state.prId} (fired_by=${env.fired_by}).`,
  });
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.stderr.write('\n');
  process.exit(1);
});
