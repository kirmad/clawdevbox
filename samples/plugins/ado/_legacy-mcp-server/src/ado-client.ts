/**
 * ado-client.ts
 *
 * Thin HTTP wrapper around the Azure DevOps REST API. Used by the MCP tool
 * handlers in `tools.ts`. Mirrors the raw-fetch pattern of the trigger samples
 * (no SDK, no extra runtime dep) so that this server can be inspected against
 * the bare ADO REST endpoints documented at
 * https://learn.microsoft.com/azure/devops/rest/.
 *
 * Auth precedence (per call):
 *   1. ADO_BEARER_TOKEN — AAD access token (e.g. `az account get-access-token
 *      --resource 499b84ac-1321-427f-aa17-267ca6975798`). Preferred when set.
 *   2. ADO_PAT — Personal access token (basic auth). Legacy fallback.
 *
 * Defaults:
 *   - `org` defaults to env ADO_ORG when not passed.
 *   - `project` defaults to env ADO_PROJECT when not passed.
 *
 * Errors:
 *   - Missing required input throws `AdoConfigError` (caller maps to MCP InvalidParams).
 *   - Non-2xx HTTP throws `AdoHttpError` with status, response body, and request URL
 *     (caller maps to MCP InternalError so the AI sees the actual ADO failure).
 */

// ============================================================================
// Errors
// ============================================================================

export class AdoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdoConfigError';
  }
}

export class AdoHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBody: string;
  constructor(status: number, url: string, responseBody: string) {
    super(`ADO ${status} on ${url}: ${responseBody.slice(0, 500)}`);
    this.name = 'AdoHttpError';
    this.status = status;
    this.url = url;
    this.responseBody = responseBody;
  }
}

// ============================================================================
// Auth
// ============================================================================

function authHeader(): string {
  const bearer = process.env.ADO_BEARER_TOKEN;
  const pat = process.env.ADO_PAT;
  if (bearer && bearer.length > 0) return `Bearer ${bearer}`;
  if (pat && pat.length > 0) return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  throw new AdoConfigError(
    'ADO auth missing. Set ADO_BEARER_TOKEN (AAD) or ADO_PAT (basic auth) in the MCP server env.',
  );
}

// ============================================================================
// Org / project / URL building
// ============================================================================

export interface AdoScope {
  org?: string;
  project?: string;
  repo: string;
}

interface ResolvedScope {
  org: string;
  project: string | null;
  repo: string;
}

function resolveScope(scope: AdoScope, requireProject: boolean): ResolvedScope {
  const org = scope.org ?? process.env.ADO_ORG ?? '';
  if (!org) {
    throw new AdoConfigError(
      'ADO_ORG missing. Pass `org` in the tool args or set ADO_ORG in the MCP server env.',
    );
  }
  if (!scope.repo) {
    throw new AdoConfigError('`repo` is required.');
  }
  const project = scope.project ?? process.env.ADO_PROJECT ?? null;
  if (requireProject && !project) {
    throw new AdoConfigError(
      'ADO project missing. Pass `project` in the tool args or set ADO_PROJECT in the MCP server env.',
    );
  }
  return { org, project, repo: scope.repo };
}

/**
 * Compose the `dev.azure.com/<org>[/<project>]` URL prefix. ADO accepts org-scoped
 * URLs for *most* PR endpoints when the repository name is unambiguous within
 * the org, but project-qualified URLs are always safe. We prefer the qualified
 * form when a project is available.
 *
 * The `org` value may itself contain a slash for "<org>/<project>" — that's
 * what the trigger samples and setup-ado scripts emit. We honor that form
 * unchanged for compatibility with the test config.
 */
function urlBase(resolved: ResolvedScope): string {
  if (resolved.org.includes('/')) {
    // Already an "<org>/<project>" composite — trust the caller.
    return `https://dev.azure.com/${resolved.org}`;
  }
  if (resolved.project) {
    return `https://dev.azure.com/${encodeURIComponent(resolved.org)}/${encodeURIComponent(resolved.project)}`;
  }
  return `https://dev.azure.com/${encodeURIComponent(resolved.org)}`;
}

async function adoFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', authHeader());
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new AdoHttpError(res.status, url, text);
  }
  if (text.length === 0) return null as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AdoHttpError(res.status, url, `Invalid JSON in 2xx response: ${(err as Error).message}`);
  }
}

// ============================================================================
// Types (the shapes we surface — narrowed from ADO's raw responses)
// ============================================================================

export interface AdoPullRequest {
  pullRequestId: number;
  title: string;
  description: string;
  status: string;
  sourceRefName: string;
  targetRefName: string;
  creationDate: string;
  closedDate: string | null;
  isDraft: boolean;
  mergeStatus: string | null;
  createdBy: {
    displayName: string;
    uniqueName: string;
    id: string;
  };
  repository: {
    id: string;
    name: string;
    project: { id: string; name: string };
  };
  url: string;
}

export interface AdoPrComment {
  id: number;
  threadId: number;
  content: string;
  commentType: string;
  author: {
    displayName: string;
    uniqueName: string;
  };
  publishedDate: string;
  lastUpdatedDate: string;
}

export interface AdoIterationSummary {
  id: number;
  createdDate: string;
  description: string | null;
  sourceRefCommit: string | null;
  targetRefCommit: string | null;
  push: { pushId: number; date: string } | null;
}

export interface AdoPrStatus {
  status: string;
  mergeStatus: string | null;
  votes: Array<{
    reviewerId: string;
    displayName: string;
    vote: number;
    voteLabel: 'approved' | 'approved-with-suggestions' | 'no-vote' | 'waiting-for-author' | 'rejected' | 'unknown';
    isRequired: boolean;
  }>;
}

export interface AdoCommentPostResult {
  commentId: number;
  threadId: number;
}

// ============================================================================
// Raw shapes we narrow from (kept loose — ADO can add fields)
// ============================================================================

interface RawPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  sourceRefName?: string;
  targetRefName?: string;
  creationDate: string;
  closedDate?: string;
  isDraft?: boolean;
  mergeStatus?: string;
  createdBy?: { displayName?: string; uniqueName?: string; id?: string };
  repository?: {
    id?: string;
    name?: string;
    project?: { id?: string; name?: string };
  };
  url?: string;
  reviewers?: Array<{
    id?: string;
    displayName?: string;
    vote?: number;
    isRequired?: boolean;
  }>;
}

interface RawCommentThread {
  id: number;
  status?: string;
  comments?: Array<{
    id?: number;
    content?: string;
    commentType?: string;
    author?: { displayName?: string; uniqueName?: string };
    publishedDate?: string;
    lastUpdatedDate?: string;
  }>;
}

interface RawIteration {
  id: number;
  description?: string;
  createdDate?: string;
  sourceRefCommit?: { commitId?: string };
  targetRefCommit?: { commitId?: string };
  push?: { pushId?: number; date?: string };
}

interface AdoListResponse<T> {
  value?: T[];
  count?: number;
}

// ============================================================================
// API surface
// ============================================================================

const API_VERSION = '7.1-preview.1';

/** GET /{org}/_apis/git/repositories/{repo}/pullRequests/{prId} */
export async function getPullRequest(scope: AdoScope, prId: number): Promise<AdoPullRequest> {
  const resolved = resolveScope(scope, false);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${prId}?api-version=${API_VERSION}`;
  const raw = await adoFetch<RawPullRequest>(url);
  return narrowPullRequest(raw);
}

/**
 * GET threads → flatten user-authored comments. Optionally filter to id > sinceId.
 * Skips `commentType === 'system'` (ADO posts those on votes, branch updates, etc.).
 */
export async function listPrComments(
  scope: AdoScope,
  prId: number,
  sinceId?: number,
): Promise<AdoPrComment[]> {
  const resolved = resolveScope(scope, false);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${prId}/threads?api-version=${API_VERSION}`;
  const raw = await adoFetch<AdoListResponse<RawCommentThread>>(url);
  const cutoff = typeof sinceId === 'number' && sinceId > 0 ? sinceId : 0;
  const out: AdoPrComment[] = [];
  for (const thread of raw.value ?? []) {
    for (const c of thread.comments ?? []) {
      if (typeof c.id !== 'number') continue;
      if (c.commentType === 'system') continue;
      if (c.id <= cutoff) continue;
      out.push({
        id: c.id,
        threadId: thread.id,
        content: c.content ?? '',
        commentType: c.commentType ?? 'text',
        author: {
          displayName: c.author?.displayName ?? '',
          uniqueName: c.author?.uniqueName ?? '',
        },
        publishedDate: c.publishedDate ?? new Date().toISOString(),
        lastUpdatedDate: c.lastUpdatedDate ?? c.publishedDate ?? new Date().toISOString(),
      });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Post a comment. If `inReplyToThreadId` is set, append to that thread.
 * Otherwise create a new top-level thread containing one comment.
 *
 * Returns `{ commentId, threadId }`.
 */
export async function commentOnPr(
  scope: AdoScope,
  prId: number,
  content: string,
  inReplyToThreadId?: number,
): Promise<AdoCommentPostResult> {
  if (!content || content.trim().length === 0) {
    throw new AdoConfigError('`content` must be a non-empty string.');
  }
  const resolved = resolveScope(scope, false);
  const base = urlBase(resolved);

  if (typeof inReplyToThreadId === 'number' && inReplyToThreadId > 0) {
    const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${prId}/threads/${inReplyToThreadId}/comments?api-version=${API_VERSION}`;
    const body = {
      content,
      commentType: 1, // 1 = text (0 = unknown, 2 = codeChange, 3 = system)
      parentCommentId: 0,
    };
    const raw = await adoFetch<{ id?: number }>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (typeof raw.id !== 'number') {
      throw new AdoHttpError(200, url, 'ADO returned no comment id on reply');
    }
    return { commentId: raw.id, threadId: inReplyToThreadId };
  }

  // New top-level thread carrying one text comment.
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${prId}/threads?api-version=${API_VERSION}`;
  const body = {
    comments: [
      {
        parentCommentId: 0,
        content,
        commentType: 1,
      },
    ],
    status: 1, // 1 = active
  };
  const raw = await adoFetch<RawCommentThread>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const newComment = (raw.comments ?? [])[0];
  if (!raw.id || !newComment || typeof newComment.id !== 'number') {
    throw new AdoHttpError(200, url, 'ADO returned no thread/comment id on new-thread post');
  }
  return { commentId: newComment.id, threadId: raw.id };
}

/** GET /pullRequests/{prId}/iterations — returns iteration summaries. */
export async function listIterations(scope: AdoScope, prId: number): Promise<AdoIterationSummary[]> {
  const resolved = resolveScope(scope, false);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${prId}/iterations?api-version=${API_VERSION}`;
  const raw = await adoFetch<AdoListResponse<RawIteration>>(url);
  return (raw.value ?? [])
    .map<AdoIterationSummary>((it) => ({
      id: it.id,
      createdDate: it.createdDate ?? '',
      description: it.description ?? null,
      sourceRefCommit: it.sourceRefCommit?.commitId ?? null,
      targetRefCommit: it.targetRefCommit?.commitId ?? null,
      push:
        it.push && typeof it.push.pushId === 'number'
          ? { pushId: it.push.pushId, date: it.push.date ?? '' }
          : null,
    }))
    .sort((a, b) => a.id - b.id);
}

/**
 * Derive a status summary + vote roll-up. ADO surfaces reviewer votes inline
 * on the PR resource, so we reuse `getPullRequest` and project the reviewers
 * list into a clean shape.
 */
export async function getPrStatus(scope: AdoScope, prId: number): Promise<AdoPrStatus> {
  const resolved = resolveScope(scope, false);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${prId}?api-version=${API_VERSION}`;
  const raw = await adoFetch<RawPullRequest>(url);
  return {
    status: raw.status,
    mergeStatus: raw.mergeStatus ?? null,
    votes: (raw.reviewers ?? []).map((r) => ({
      reviewerId: r.id ?? '',
      displayName: r.displayName ?? '',
      vote: typeof r.vote === 'number' ? r.vote : 0,
      voteLabel: mapVoteLabel(typeof r.vote === 'number' ? r.vote : 0),
      isRequired: r.isRequired === true,
    })),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function narrowPullRequest(raw: RawPullRequest): AdoPullRequest {
  return {
    pullRequestId: raw.pullRequestId,
    title: raw.title,
    description: raw.description ?? '',
    status: raw.status,
    sourceRefName: raw.sourceRefName ?? '',
    targetRefName: raw.targetRefName ?? '',
    creationDate: raw.creationDate,
    closedDate: raw.closedDate ?? null,
    isDraft: raw.isDraft === true,
    mergeStatus: raw.mergeStatus ?? null,
    createdBy: {
      displayName: raw.createdBy?.displayName ?? '',
      uniqueName: raw.createdBy?.uniqueName ?? '',
      id: raw.createdBy?.id ?? '',
    },
    repository: {
      id: raw.repository?.id ?? '',
      name: raw.repository?.name ?? '',
      project: {
        id: raw.repository?.project?.id ?? '',
        name: raw.repository?.project?.name ?? '',
      },
    },
    url: raw.url ?? '',
  };
}

function mapVoteLabel(vote: number): AdoPrStatus['votes'][number]['voteLabel'] {
  // ADO vote scale: 10=approved, 5=approved-with-suggestions, 0=no-vote,
  // -5=waiting-for-author, -10=rejected. Anything else → unknown.
  switch (vote) {
    case 10: return 'approved';
    case 5: return 'approved-with-suggestions';
    case 0: return 'no-vote';
    case -5: return 'waiting-for-author';
    case -10: return 'rejected';
    default: return 'unknown';
  }
}
