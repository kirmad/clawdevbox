/**
 * tools/list_work_item_comments.ts — `ado.list_work_item_comments` hostable tool.
 *
 * Wraps GET /_apis/wit/workItems/{id}/comments?api-version=7.1-preview.3.
 * Returns user-authored comments oldest → newest.
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { AdoConfigError, adoFetch } from './_auth.ts';

export const id = 'ado.list_work_item_comments';

export const description =
  'List user-authored comments on an ADO work item, oldest → newest. Optionally return only comments with id > since_id (use for polling).';

// Work-item comments require the 7.1-preview.3 API version (per ADO REST docs).
const WIT_COMMENTS_API = '7.1-preview.3';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  id: z.number().int().positive().describe('Work item id.'),
  since_id: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Return only comments with id > since_id. Omit or 0 for all.'),
  max: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Cap on returned comments (default 100, hard cap 500).'),
});

interface RawWiComment {
  id?: number;
  workItemId?: number;
  text?: string;
  createdBy?: { displayName?: string; uniqueName?: string; id?: string };
  createdDate?: string;
  modifiedDate?: string;
  modifiedBy?: { displayName?: string; uniqueName?: string; id?: string };
  version?: number;
  format?: string;
}

interface ListResponse {
  totalCount?: number;
  count?: number;
  comments?: RawWiComment[];
}

interface NarrowedComment {
  id: number;
  workItemId: number;
  text: string;
  format: string;
  createdBy: { displayName: string; uniqueName: string; id: string };
  createdDate: string;
  modifiedBy: { displayName: string; uniqueName: string; id: string };
  modifiedDate: string;
}

function identity(
  o: { displayName?: string; uniqueName?: string; id?: string } | undefined,
): { displayName: string; uniqueName: string; id: string } {
  return {
    displayName: o?.displayName ?? '',
    uniqueName: o?.uniqueName ?? '',
    id: o?.id ?? '',
  };
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; comments: NarrowedComment[]; count: number }> {
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
  const max = args.max ?? 100;
  // Comments endpoint returns newest first by default; ask for oldest → newest via $top + order=asc.
  const url = `${base}/_apis/wit/workItems/${args.id}/comments?api-version=${WIT_COMMENTS_API}&$top=${max}&order=asc`;
  const raw = await adoFetch<ListResponse>(ctx, url);

  const cutoff = typeof args.since_id === 'number' && args.since_id > 0 ? args.since_id : 0;
  const out: NarrowedComment[] = [];
  for (const c of raw.comments ?? []) {
    if (typeof c.id !== 'number') continue;
    if (c.id <= cutoff) continue;
    out.push({
      id: c.id,
      workItemId: typeof c.workItemId === 'number' ? c.workItemId : args.id,
      text: c.text ?? '',
      format: c.format ?? 'html',
      createdBy: identity(c.createdBy),
      createdDate: c.createdDate ?? '',
      modifiedBy: identity(c.modifiedBy ?? c.createdBy),
      modifiedDate: c.modifiedDate ?? c.createdDate ?? '',
    });
  }
  out.sort((a, b) => a.id - b.id);

  const summary =
    out.length === 0
      ? `No comments on WI ${args.id}${args.since_id ? ` since id ${args.since_id}` : ''}.`
      : `Found ${out.length} comment(s) on WI ${args.id}${args.since_id ? ` since id ${args.since_id}` : ''}. Latest id=${out[out.length - 1].id}.`;
  return { summary, comments: out, count: out.length };
}
