/**
 * _auth.ts — shared helpers for the ADO plugin's hostable tools.
 *
 * Files prefixed with `_` are NOT registered as tools (they don't appear in
 * `provides.tools[]`). They're internal helpers used across the tool files.
 *
 * Auth precedence:
 *   1. ADO_BEARER_TOKEN — AAD access token. Preferred.
 *   2. ADO_PAT          — Personal access token. Fallback.
 *
 * Defaults:
 *   - org     defaults to env ADO_ORG
 *   - project defaults to env ADO_PROJECT
 *
 * Errors:
 *   - Missing required input throws an Error tagged with `code: 'ADO_CONFIG_ERROR'`.
 *   - Non-2xx HTTP throws an Error tagged with `code: 'ADO_HTTP_ERROR'` and the
 *     status / url / body attached for debuggability.
 *
 * The Clawdevbox host catches thrown errors and surfaces them as MCP tool
 * errors with structured `{ code, message }` (see `tools/hosted.ts`).
 */

import type { ToolContext } from '@clawdevbox/sdk';

export const API_VERSION = '7.1-preview.1';

export class AdoConfigError extends Error {
  readonly code = 'ADO_CONFIG_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'AdoConfigError';
  }
}

export class AdoHttpError extends Error {
  readonly code = 'ADO_HTTP_ERROR';
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`ADO ${status} on ${url}: ${body.slice(0, 500)}`);
    this.name = 'AdoHttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Build the Authorization header from ctx.env (bearer preferred, PAT fallback). */
export function authHeader(ctx: ToolContext): string {
  const bearer = ctx.env.ADO_BEARER_TOKEN;
  const pat = ctx.env.ADO_PAT;
  if (bearer && bearer.length > 0) return `Bearer ${bearer}`;
  if (pat && pat.length > 0) return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  throw new AdoConfigError(
    'ADO auth missing. Set ADO_BEARER_TOKEN (AAD) or ADO_PAT (basic auth) in the Clawdevbox server env.',
  );
}

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

export function resolveScope(
  ctx: ToolContext,
  scope: AdoScope,
  requireProject = false,
): ResolvedScope {
  const org = scope.org ?? ctx.env.ADO_ORG ?? '';
  if (!org) {
    throw new AdoConfigError(
      'ADO_ORG missing. Pass `org` in the tool args or set ADO_ORG in the server env.',
    );
  }
  if (!scope.repo) {
    throw new AdoConfigError('`repo` is required.');
  }
  const project = scope.project ?? ctx.env.ADO_PROJECT ?? null;
  if (requireProject && !project) {
    throw new AdoConfigError(
      'ADO project missing. Pass `project` in the tool args or set ADO_PROJECT in the server env.',
    );
  }
  return { org, project, repo: scope.repo };
}

/**
 * Compose the `dev.azure.com/<org>[/<project>]` URL prefix.
 *
 * The `org` value may contain a slash for "<org>/<urlencoded project>" — that's
 * what the trigger samples emit. We honor that form unchanged.
 */
export function urlBase(resolved: ResolvedScope): string {
  if (resolved.org.includes('/')) {
    return `https://dev.azure.com/${resolved.org}`;
  }
  if (resolved.project) {
    return `https://dev.azure.com/${encodeURIComponent(resolved.org)}/${encodeURIComponent(resolved.project)}`;
  }
  return `https://dev.azure.com/${encodeURIComponent(resolved.org)}`;
}

/** Wrapper around ctx.fetch that adds auth, json header, and AbortSignal pass-through. */
export async function adoFetch<T>(
  ctx: ToolContext,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', authHeader(ctx));
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  const res = await ctx.fetch(url, { ...init, headers, signal: ctx.signal });
  const text = await res.text();
  if (!res.ok) throw new AdoHttpError(res.status, url, text);
  if (text.length === 0) return null as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AdoHttpError(res.status, url, `Invalid JSON in 2xx response: ${(err as Error).message}`);
  }
}

/** ADO vote scale → label. 10=approved, 5=approved-with-suggestions, 0=no-vote, -5=waiting, -10=rejected. */
export function mapVoteLabel(vote: number): VoteLabel {
  switch (vote) {
    case 10: return 'approved';
    case 5: return 'approved-with-suggestions';
    case 0: return 'no-vote';
    case -5: return 'waiting-for-author';
    case -10: return 'rejected';
    default: return 'unknown';
  }
}

export type VoteLabel =
  | 'approved'
  | 'approved-with-suggestions'
  | 'no-vote'
  | 'waiting-for-author'
  | 'rejected'
  | 'unknown';
