/**
 * tools/get_pr.ts — `ado.get_pr` hostable tool (spec §10.3).
 *
 * Wraps GET /_apis/git/repositories/{repo}/pullRequests/{prId}.
 * Returns narrowed PR metadata.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { adoFetch, API_VERSION, resolveScope, urlBase } from './_auth.ts';

export const id = 'ado.get_pr';

export const description =
  'Get pull-request metadata (title, description, state, createdBy, repository, ...) for a single PR id.';

export const parameters = z.object({
  org: z
    .string()
    .min(1)
    .optional()
    .describe(
      'ADO organization slug, e.g. "myorg". May also be a composite "<org>/<urlencoded project>". Defaults to env ADO_ORG.',
    ),
  project: z.string().min(1).optional().describe('ADO project name. Defaults to env ADO_PROJECT.'),
  repo: z.string().min(1).describe('ADO repository name (the repo slug, not the GUID).'),
  pr_id: z.number().int().positive().describe('Pull request id (the numeric `pullRequestId`).'),
});

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
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; pullRequest: Record<string, unknown> }> {
  const resolved = resolveScope(ctx, args);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${args.pr_id}?api-version=${API_VERSION}`;
  const raw = await adoFetch<RawPullRequest>(ctx, url);

  const pullRequest = {
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

  const summary = `PR ${pullRequest.pullRequestId} — ${pullRequest.title} [${pullRequest.status}] by ${pullRequest.createdBy.displayName} in ${pullRequest.repository.project.name}/${pullRequest.repository.name}`;
  return { summary, pullRequest };
}
