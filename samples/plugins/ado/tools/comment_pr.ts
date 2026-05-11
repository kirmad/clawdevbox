/**
 * tools/comment_pr.ts — `ado.comment_pr` hostable tool (spec §10.3).
 *
 * Posts a comment on a PR. If `in_reply_to_thread_id` is set, the comment
 * is appended to that thread; otherwise a new top-level thread is created.
 */

import { z } from 'zod';
import type { ToolContext } from '@conductor/sdk';
import {
  AdoConfigError,
  AdoHttpError,
  adoFetch,
  API_VERSION,
  resolveScope,
  urlBase,
} from './_auth.ts';

export const id = 'ado.comment_pr';

export const description =
  'Post a comment on a PR. If `in_reply_to_thread_id` is set, the comment is appended to that thread; otherwise a new top-level thread is created.';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  repo: z.string().min(1).describe('ADO repository name.'),
  pr_id: z.number().int().positive().describe('Pull request id.'),
  content: z.string().min(1).describe('Comment body (markdown is supported by the ADO UI).'),
  in_reply_to_thread_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('When set, append the comment to this existing thread instead of starting a new one.'),
});

interface NewCommentResponse {
  id?: number;
}

interface NewThreadResponse {
  id?: number;
  comments?: Array<{ id?: number }>;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; commentId: number; threadId: number }> {
  if (!args.content || args.content.trim().length === 0) {
    throw new AdoConfigError('`content` must be a non-empty string.');
  }
  const resolved = resolveScope(ctx, args);
  const base = urlBase(resolved);

  if (typeof args.in_reply_to_thread_id === 'number' && args.in_reply_to_thread_id > 0) {
    const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${args.pr_id}/threads/${args.in_reply_to_thread_id}/comments?api-version=${API_VERSION}`;
    const body = {
      content: args.content,
      commentType: 1, // 1 = text
      parentCommentId: 0,
    };
    const raw = await adoFetch<NewCommentResponse>(ctx, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (typeof raw.id !== 'number') {
      throw new AdoHttpError(200, url, 'ADO returned no comment id on reply');
    }
    return {
      summary: `Replied on thread ${args.in_reply_to_thread_id} of PR ${args.pr_id} (comment id ${raw.id}).`,
      commentId: raw.id,
      threadId: args.in_reply_to_thread_id,
    };
  }

  // New top-level thread carrying one text comment.
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${args.pr_id}/threads?api-version=${API_VERSION}`;
  const body = {
    comments: [
      {
        parentCommentId: 0,
        content: args.content,
        commentType: 1,
      },
    ],
    status: 1, // 1 = active
  };
  const raw = await adoFetch<NewThreadResponse>(ctx, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const newComment = (raw.comments ?? [])[0];
  if (!raw.id || !newComment || typeof newComment.id !== 'number') {
    throw new AdoHttpError(200, url, 'ADO returned no thread/comment id on new-thread post');
  }
  return {
    summary: `Posted new comment thread ${raw.id} on PR ${args.pr_id} (comment id ${newComment.id}).`,
    commentId: newComment.id,
    threadId: raw.id,
  };
}
