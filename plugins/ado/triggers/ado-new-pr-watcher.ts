#!/usr/bin/env tsx
/**
 * ado-new-pr-watcher.ts
 *
 * Cold trigger script for the `ado.new-pr-watcher` trigger TYPE.
 *
 * The plugin manifest declares the type with `binds_callback_to_recipe:
 * pr-review`, so Clawdevbox mints a per-registration callback URL of the
 * shape `/callback/recipes/pr-review/run`. The script posts one callback
 * per detected PR with `{ prompt, attach_to_inbox_item_id }` shape — Mode B.
 *
 * REFERENCE IMPLEMENTATION of Mode B for a cold callback-recipe trigger.
 *
 * Param shape (from plugin.yaml `provides.trigger_types[0].parameters`):
 *   - repo:           string,  required  (ADO repo name)
 *   - assigned_to:    string,  optional  (filter to assignee)
 *   - opened_by:      string,  optional  (filter to author — typically self)
 *   - include_drafts: boolean, optional  (default false; drafts skipped)
 *
 * Initial state shape (per spec §8.5, params merge into state at register-time):
 *   { repo, assigned_to?, opened_by?, include_drafts, lastCheckedAt }
 *
 * Auth: same as ado-comment-watcher.ts —
 *   ADO_BEARER_TOKEN  preferred (AAD access token)
 *   ADO_PAT           fallback (basic auth)
 *
 * Mode B requires CLAWDEVBOX_MCP_SECRET for the Authorization header on
 * direct callback POSTs.
 *
 * Zero dependencies beyond Node 20+ built-in fetch.
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
  /** Pre-bound callback URL of shape /callback/recipes/pr-review/run. */
  callback_url: string;
  state: WatcherState;
  /** ADO service-hook body when fired_by='external'; otherwise null. */
  payload: AdoServiceHookPayload | null;
}

interface WatcherState {
  /** Required at registration time. */
  repo: string;
  /** Optional filters from registration params. */
  assigned_to?: string;
  opened_by?: string;
  include_drafts: boolean;
  /** Unix-ms cursor — only PRs created after this are picked up. 0 on first run. */
  lastCheckedAt: number;
}

interface AdoServiceHookPayload {
  resource?: AdoPullRequest;
}

interface AdoPullRequest {
  pullRequestId: number;
  title?: string;
  status?: string;          // 'active' | 'completed' | 'abandoned'
  isDraft?: boolean;
  creationDate?: string;    // ISO 8601
  createdBy?: { uniqueName?: string; displayName?: string };
  reviewers?: Array<{ uniqueName?: string; displayName?: string; isRequired?: boolean }>;
  repository?: { name?: string };
}

interface CallbackBody {
  prompt: string;
  attach_to_inbox_item_id?: string;
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
// ADO client (raw HTTP — bearer token preferred, PAT fallback)
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

/**
 * List active pull requests in a repo. We filter post-fetch rather than via
 * the ADO `searchCriteria.createdAfter` parameter because ADO's filter applies
 * to creationDate-as-string and isn't quite reliable — easier to fetch the
 * active set (which is small for most repos) and filter in JS.
 */
async function listActivePrs(repo: string): Promise<AdoPullRequest[]> {
  if (!ADO_ORG) throw new Error('ADO_ORG env var required');

  const url =
    `https://dev.azure.com/${ADO_ORG}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=active` +
    `&$top=100&api-version=7.1-preview.1`;

  const res = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
  if (!res.ok) throw new Error(`ADO ${res.status}: ${await res.text()}`);

  const body = (await res.json()) as { value?: AdoPullRequest[] };
  return body.value ?? [];
}

// ============================================================================
// Filtering — translate state into "should this PR ping the agent?"
// ============================================================================

function prMatchesFilters(pr: AdoPullRequest, state: WatcherState): boolean {
  // Skip drafts unless explicitly included.
  if (pr.isDraft && !state.include_drafts) return false;

  // Filter by creator if `opened_by` is set.
  if (state.opened_by && pr.createdBy?.uniqueName !== state.opened_by) return false;

  // Filter by reviewer assignment if `assigned_to` is set.
  if (state.assigned_to) {
    const reviewers = pr.reviewers ?? [];
    const assigned = reviewers.some((r) => r.uniqueName === state.assigned_to);
    if (!assigned) return false;
  }

  // Filter by creation cursor.
  const createdAtMs = pr.creationDate ? Date.parse(pr.creationDate) : 0;
  if (!createdAtMs || createdAtMs <= state.lastCheckedAt) return false;

  return true;
}

// ============================================================================
// Prompt construction — translate one PR into a callback body for pr-review
// ============================================================================

function bodyForPr(pr: AdoPullRequest, repo: string): CallbackBody {
  const id = pr.pullRequestId;
  const title = pr.title ?? '(untitled)';
  const author = pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? 'someone';
  const prompt = [
    `Review PR ${id} in ${repo}: ${title}`,
    ``,
    `Opened by ${author}.`,
    ``,
    `Use the pr-review recipe's steps as a starting point: read the diff and`,
    `prior iteration comments via ado.get_pr / ado.list_pr_comments, classify`,
    `changes, surface risks, and draft inline review comments. Request user`,
    `approval via approval.request before posting via ado.comment_pr.`,
  ].join('\n');
  return {
    prompt,
    attach_to_inbox_item_id: `ado:pr:${id}`,
    context: { source: 'ado', kind: 'pr.created', pr_id: id, repo },
  };
}

// ============================================================================
// Mode B — POST one callback per detected PR.
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

  // Hydrate state with defaults (spread so the envelope's `state` overrides).
  const defaults: WatcherState = {
    repo: '',
    include_drafts: false,
    lastCheckedAt: 0,
  };
  const state: WatcherState = { ...defaults, ...env.state };

  if (!state.repo) {
    blockingError('state.repo must be set when the trigger is registered');
  }

  const callbackUrl = env.callback_url;
  if (!callbackUrl) {
    blockingError('env.callback_url missing — required for Mode B live POSTs');
  }

  let posted = 0;

  // ----- Real-time path: ADO service hook delivered exactly this PR -----
  if (env.fired_by === 'external' && env.payload?.resource?.pullRequestId) {
    const pr = env.payload.resource;
    // Note we don't compare repo here — the service hook is configured per repo,
    // so any payload reaching us is for the repo this registration tracks.
    if (prMatchesFilters({ ...pr, creationDate: pr.creationDate ?? new Date().toISOString() }, state)) {
      await postCallback(callbackUrl, bodyForPr(pr, state.repo));
      posted++;
    }

    // Advance the cursor to "now" so cron-fire backups don't re-pick this PR.
    state.lastCheckedAt = Math.max(state.lastCheckedAt, Date.parse(pr.creationDate ?? '') || Date.now());

    writeStdout({
      state,
      systemMessage:
        posted > 0
          ? `Forwarded 1 new PR (${pr.pullRequestId}) from ADO service hook.`
          : `External PR ${pr.pullRequestId} did not match filters; skipped.`,
    });
    return;
  }

  // ----- Cron / manual / agent: poll ADO and filter -----
  const prs = await listActivePrs(state.repo);
  // Sort by creationDate ascending so the cursor advances monotonically.
  prs.sort((a, b) => (Date.parse(a.creationDate ?? '') || 0) - (Date.parse(b.creationDate ?? '') || 0));

  let cursor = state.lastCheckedAt;
  for (const pr of prs) {
    if (!prMatchesFilters(pr, state)) continue;
    await postCallback(callbackUrl, bodyForPr(pr, state.repo));
    posted++;
    const createdAtMs = pr.creationDate ? Date.parse(pr.creationDate) : 0;
    if (createdAtMs > cursor) cursor = createdAtMs;
  }
  // Even if no PRs matched, push the cursor forward so empty ticks remain cheap
  // and we don't re-scan the same window forever. Use the most recent PR's
  // creationDate as the high-water mark, falling back to "now" when the repo
  // has no active PRs at all.
  if (cursor === state.lastCheckedAt && prs.length > 0) {
    const newestSeen = prs.reduce(
      (acc, pr) => Math.max(acc, pr.creationDate ? Date.parse(pr.creationDate) : 0),
      cursor,
    );
    cursor = newestSeen;
  } else if (cursor === state.lastCheckedAt) {
    cursor = Date.now();
  }
  state.lastCheckedAt = cursor;

  writeStdout({
    state,
    systemMessage:
      posted > 0
        ? `Picked up ${posted} new PR(s) in ${state.repo} (fired_by=${env.fired_by}).`
        : `No new PRs in ${state.repo} (fired_by=${env.fired_by}).`,
  });
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.stderr.write('\n');
  process.exit(1);
});
