/**
 * tools/list_pr_comments.ts — `ado.list_pr_comments` hostable tool (spec §10.3).
 *
 * Wraps GET /_apis/git/repositories/{repo}/pullRequests/{prId}/threads.
 * Flattens user-authored comments (skips ADO `system` comment type) and
 * optionally filters to id > since_id (use for polling).
 */

import { z } from 'zod';
import type { ToolContext } from '@conductor/sdk';
import { adoFetch, API_VERSION, resolveScope, urlBase } from './_auth.ts';

export const id = 'ado.list_pr_comments';

export const description =
  'List user-authored comments on a PR. Skips ADO system comments. Optionally filter to id > since_id (use for polling).';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  repo: z.string().min(1).describe('ADO repository name.'),
  pr_id: z.number().int().positive().describe('Pull request id.'),
  since_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Return only comments with id > since_id. Omit or 0 to return all.'),
});

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

interface AdoListResponse<T> {
  value?: T[];
  count?: number;
}

interface FlattenedComment {
  id: number;
  threadId: number;
  content: string;
  commentType: string;
  author: { displayName: string; uniqueName: string };
  publishedDate: string;
  lastUpdatedDate: string;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; comments: FlattenedComment[]; count: number }> {
  const resolved = resolveScope(ctx, args);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${args.pr_id}/threads?api-version=${API_VERSION}`;
  const raw = await adoFetch<AdoListResponse<RawCommentThread>>(ctx, url);

  const cutoff = typeof args.since_id === 'number' && args.since_id > 0 ? args.since_id : 0;
  const out: FlattenedComment[] = [];
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
  out.sort((a, b) => a.id - b.id);

  const summary =
    out.length === 0
      ? `No comments on PR ${args.pr_id}${args.since_id ? ` since id ${args.since_id}` : ''}.`
      : `Found ${out.length} comment(s) on PR ${args.pr_id}${args.since_id ? ` since id ${args.since_id}` : ''}. Latest id=${out[out.length - 1].id}.`;

  return { summary, comments: out, count: out.length };
}
