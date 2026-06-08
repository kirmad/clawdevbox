/**
 * _auth.ts — shared helpers for the ADO plugin's hostable tools.
 *
 * Files prefixed with `_` are NOT registered as tools (they don't appear in
 * `provides.tools[]`). They're internal helpers used across the tool files.
 *
 * Auth precedence (highest wins):
 *   1. `az account get-access-token` — automatic, refreshed before expiry.
 *      Requires the user to be `az login`'d. This is the default for any
 *      Azure-authenticated environment.
 *   2. ADO_BEARER_TOKEN env var — explicit AAD access token override.
 *   3. ADO_PAT env var — personal access token (basic auth) fallback for
 *      environments without AAD.
 *
 * The `az` path is preferred even when env tokens exist because env tokens
 * commonly go stale (manual refresh) whereas `az` will silently refresh.
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
import { spawn } from 'node:child_process';

export const API_VERSION = '7.1-preview.1';

/** Azure AD application id for the Azure DevOps service. Stable. */
const ADO_AAD_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

/** Refresh the cached token when fewer than this many ms remain to expiry. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;  // 5 min

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

// ---------------------------------------------------------------------------
// `az account get-access-token` integration
// ---------------------------------------------------------------------------

interface CachedAzToken {
  token: string;
  expiresAtMs: number;
}

/** In-memory token cache. Module-scope so all tools in this process share it. */
let cachedAzToken: CachedAzToken | null = null;

/** Coalesce concurrent fetches so we never fire `az` more than once at a time. */
let inFlightAzFetch: Promise<CachedAzToken | null> | null = null;

/** Set to `false` after a failed `az` call so we don't re-try on every tool invocation. */
let azAvailable = true;

/**
 * Injection seam for tests. Production uses the real `child_process.spawn`-
 * backed runner; tests can substitute a stub via `_setAzRunnerForTesting`.
 */
let azRunner: () => Promise<CachedAzToken | null> = realAzRunner;

/**
 * Run `az account get-access-token --resource <ADO> --output json` and return
 * the parsed { token, expiresAtMs }. Returns null when `az` is not installed,
 * not authenticated, or otherwise fails. The first failure marks `azAvailable
 * = false` so subsequent calls fall straight through to env-token fallback
 * (no repeated spawn overhead).
 */
async function realAzRunner(): Promise<CachedAzToken | null> {
  // On Windows, `az` is a .cmd / .bat shim, so we must shell out via cmd.exe
  // or set `shell: true` so node-pty resolves it. `shell: true` is the
  // portable choice.
  return await new Promise<CachedAzToken | null>((resolve) => {
    const proc = spawn(
      'az',
      ['account', 'get-access-token', '--resource', ADO_AAD_RESOURCE_ID, '--output', 'json'],
      { shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => { /* swallow — diagnosed via exit code */ });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { accessToken?: string; expiresOn?: string; expires_on?: number };
        const token = parsed.accessToken;
        if (!token) { resolve(null); return; }
        // `expiresOn` is local time like "2026-06-08 00:12:34.567890" (no tz).
        // `expires_on` is a unix-seconds epoch (newer az versions; reliable).
        // Prefer the epoch when present.
        let expiresAtMs: number;
        if (typeof parsed.expires_on === 'number') {
          expiresAtMs = parsed.expires_on * 1000;
        } else if (typeof parsed.expiresOn === 'string') {
          const t = Date.parse(parsed.expiresOn.replace(' ', 'T'));
          expiresAtMs = Number.isFinite(t) ? t : Date.now() + 50 * 60 * 1000;
        } else {
          // Conservative fallback: assume 50 minutes (tokens are typically 60-90).
          expiresAtMs = Date.now() + 50 * 60 * 1000;
        }
        resolve({ token, expiresAtMs });
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Return a fresh `az`-issued AAD token, or `null` when `az` is unavailable.
 * Uses an in-memory cache with a 5-min expiry buffer; concurrent calls
 * coalesce into a single `az` invocation.
 */
async function getAzToken(): Promise<string | null> {
  if (!azAvailable) return null;
  const now = Date.now();
  if (cachedAzToken && cachedAzToken.expiresAtMs - now > TOKEN_REFRESH_BUFFER_MS) {
    return cachedAzToken.token;
  }
  if (inFlightAzFetch) {
    const r = await inFlightAzFetch;
    return r ? r.token : null;
  }
  inFlightAzFetch = azRunner();
  try {
    const r = await inFlightAzFetch;
    if (r) {
      cachedAzToken = r;
    } else {
      azAvailable = false;
    }
    return r ? r.token : null;
  } finally {
    inFlightAzFetch = null;
  }
}

/** Test-only: reset the module-level cache + availability flag. */
export function _resetAzTokenCacheForTesting(): void {
  cachedAzToken = null;
  inFlightAzFetch = null;
  azAvailable = true;
}

/** Test-only: substitute the `az` runner. Pass `null` to restore the real one. */
export function _setAzRunnerForTesting(
  runner: (() => Promise<{ token: string; expiresAtMs: number } | null>) | null,
): void {
  azRunner = runner ?? realAzRunner;
}

/**
 * Build the Authorization header. Precedence:
 *   1. `az account get-access-token` (auto, with cache + refresh)
 *   2. ctx.env.ADO_BEARER_TOKEN
 *   3. ctx.env.ADO_PAT
 *
 * `az` is preferred even when env tokens exist because env tokens commonly
 * go stale (manual refresh) whereas `az` silently refreshes via cached
 * credentials. Set both env tokens to empty if you want to FORCE `az`.
 */
export async function authHeader(ctx: ToolContext): Promise<string> {
  const azToken = await getAzToken();
  if (azToken) return `Bearer ${azToken}`;

  const bearer = ctx.env.ADO_BEARER_TOKEN;
  if (bearer && bearer.length > 0) return `Bearer ${bearer}`;
  const pat = ctx.env.ADO_PAT;
  if (pat && pat.length > 0) return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

  throw new AdoConfigError(
    'ADO auth missing. Either run `az login` (preferred — token auto-refreshes), ' +
    'or set ADO_BEARER_TOKEN / ADO_PAT in the Clawdevbox server env.',
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
  headers.set('Authorization', await authHeader(ctx));
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
