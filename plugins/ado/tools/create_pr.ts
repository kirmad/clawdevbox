/**
 * tools/create_pr.ts — `ado.create_pr` hostable tool.
 *
 * Wraps POST /_apis/git/repositories/{repo}/pullrequests with optional
 * work-item refs so the PR auto-links to one or more WIs.
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import {
  AdoConfigError,
  AdoHttpError,
  adoFetch,
  API_VERSION,
  resolveScope,
  urlBase,
} from './_auth.ts';

export const id = 'ado.create_pr';

export const description =
  'Open a pull request. Supports `work_item_refs` to link the PR to one or more ADO work items, optional reviewers, draft mode, and `delete_source_branch` on completion.';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  repo: z.string().min(1).describe('ADO repository name.'),
  source_ref: z
    .string()
    .min(1)
    .describe("Source ref (the branch you're merging from). 'mybranch' or 'refs/heads/mybranch'."),
  target_ref: z
    .string()
    .min(1)
    .describe("Target ref. Same accepted shapes. Typically 'main' or 'master'."),
  title: z.string().min(1).describe('PR title.'),
  description: z.string().optional().describe('PR description (markdown).'),
  is_draft: z.boolean().optional().describe('Open as a draft PR. Defaults false.'),
  reviewers: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional list of reviewers. Each entry is a user `id` GUID OR a uniqueName / email (the tool sends them under `reviewers[].id`, so prefer GUIDs).',
    ),
  work_item_refs: z
    .array(z.union([z.number().int().positive(), z.string().min(1)]))
    .optional()
    .describe(
      'List of work-item ids to link via the PR\'s built-in workItemRefs. Numbers and numeric strings both accepted.',
    ),
  delete_source_branch_on_complete: z
    .boolean()
    .optional()
    .describe('Set the completion option to delete the source branch on merge.'),
});

function normalizeRef(ref: string): string {
  return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}

interface RawPullRequest {
  pullRequestId?: number;
  status?: string;
  url?: string;
  repository?: { id?: string; name?: string; project?: { id?: string; name?: string } };
  sourceRefName?: string;
  targetRefName?: string;
  isDraft?: boolean;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{
  summary: string;
  pullRequest: {
    pullRequestId: number;
    status: string;
    url: string;
    sourceRefName: string;
    targetRefName: string;
    isDraft: boolean;
    repositoryId: string;
    projectId: string;
  };
}> {
  if (!args.source_ref || !args.target_ref) {
    throw new AdoConfigError('`source_ref` and `target_ref` are required.');
  }
  if (args.source_ref === args.target_ref) {
    throw new AdoConfigError('`source_ref` and `target_ref` must differ.');
  }
  const resolved = resolveScope(ctx, args);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullrequests?api-version=${API_VERSION}`;

  const body: Record<string, unknown> = {
    sourceRefName: normalizeRef(args.source_ref),
    targetRefName: normalizeRef(args.target_ref),
    title: args.title,
    description: args.description ?? '',
    isDraft: args.is_draft === true,
  };
  if (args.reviewers && args.reviewers.length > 0) {
    body.reviewers = args.reviewers.map((r) => ({ id: r }));
  }
  if (args.work_item_refs && args.work_item_refs.length > 0) {
    body.workItemRefs = args.work_item_refs.map((ref) => ({
      id: String(ref),
      url: '',
    }));
  }
  if (args.delete_source_branch_on_complete) {
    body.completionOptions = { deleteSourceBranch: true };
  }

  const raw = await adoFetch<RawPullRequest>(ctx, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (typeof raw.pullRequestId !== 'number') {
    throw new AdoHttpError(200, url, 'ADO returned no pullRequestId on create_pr');
  }

  const out = {
    pullRequestId: raw.pullRequestId,
    status: raw.status ?? 'active',
    url: raw.url ?? '',
    sourceRefName: raw.sourceRefName ?? normalizeRef(args.source_ref),
    targetRefName: raw.targetRefName ?? normalizeRef(args.target_ref),
    isDraft: raw.isDraft === true,
    repositoryId: raw.repository?.id ?? '',
    projectId: raw.repository?.project?.id ?? '',
  };

  return {
    summary: `Opened PR ${out.pullRequestId} in ${resolved.repo} (${out.sourceRefName} → ${out.targetRefName})${out.isDraft ? ' [DRAFT]' : ''}. Linked ${args.work_item_refs?.length ?? 0} work item(s).`,
    pullRequest: out,
  };
}
