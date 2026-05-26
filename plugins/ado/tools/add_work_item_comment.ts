/**
 * tools/add_work_item_comment.ts — `ado.add_work_item_comment` hostable tool.
 *
 * Wraps POST /_apis/wit/workItems/{id}/comments?api-version=7.1-preview.3.
 * Posts a single user comment on the work item's discussion log.
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { AdoConfigError, AdoHttpError, adoFetch } from './_auth.ts';

export const id = 'ado.add_work_item_comment';

export const description =
  'Post a comment on an ADO work item. Body supports HTML (default) or markdown when `format: "markdown"` is set.';

const WIT_COMMENTS_API = '7.1-preview.3';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  id: z.number().int().positive().describe('Work item id.'),
  text: z.string().min(1).describe('Comment body.'),
  format: z
    .enum(['html', 'markdown'])
    .optional()
    .describe("Comment format. Defaults to 'html'."),
});

interface NewCommentResponse {
  id?: number;
  workItemId?: number;
  text?: string;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; commentId: number }> {
  if (!args.text || args.text.trim().length === 0) {
    throw new AdoConfigError('`text` must be a non-empty string.');
  }
  const org = args.org ?? ctx.env.ADO_ORG ?? '';
  if (!org) {
    throw new AdoConfigError(
      'ADO_ORG missing. Pass `org` in the tool args or set ADO_ORG in the server env.',
    );
  }
  const project = args.project ?? ctx.env.ADO_PROJECT ?? null;
  if (!project && !org.includes('/')) {
    throw new AdoConfigError(
      'ADO project missing. Pass `project` in the tool args or set ADO_PROJECT in the server env.',
    );
  }
  const base = org.includes('/')
    ? `https://dev.azure.com/${org}`
    : `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project!)}`;

  const url = `${base}/_apis/wit/workItems/${args.id}/comments?api-version=${WIT_COMMENTS_API}`;
  const body: Record<string, unknown> = { text: args.text };
  if (args.format) body.format = args.format;

  const raw = await adoFetch<NewCommentResponse>(ctx, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (typeof raw.id !== 'number') {
    throw new AdoHttpError(200, url, 'ADO returned no comment id on add-comment');
  }
  return {
    summary: `Posted comment ${raw.id} on WI ${args.id}.`,
    commentId: raw.id,
  };
}
