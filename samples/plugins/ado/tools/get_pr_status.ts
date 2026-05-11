/**
 * tools/get_pr_status.ts — `ado.get_pr_status` hostable tool (spec §10.3).
 *
 * Derives PR status + reviewer vote roll-up. Reuses the PR endpoint that
 * `ado.get_pr` hits — ADO surfaces reviewer votes inline on the PR resource.
 */

import { z } from 'zod';
import type { ToolContext } from '@conductor/sdk';
import {
  adoFetch,
  API_VERSION,
  mapVoteLabel,
  resolveScope,
  urlBase,
  type VoteLabel,
} from './_auth.ts';

export const id = 'ado.get_pr_status';

export const description =
  'Derived PR status: PR.status, mergeStatus, and the per-reviewer vote roll-up (vote int + label).';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  repo: z.string().min(1).describe('ADO repository name.'),
  pr_id: z.number().int().positive().describe('Pull request id.'),
});

interface RawPullRequest {
  status: string;
  mergeStatus?: string;
  reviewers?: Array<{
    id?: string;
    displayName?: string;
    vote?: number;
    isRequired?: boolean;
  }>;
}

interface PrVote {
  reviewerId: string;
  displayName: string;
  vote: number;
  voteLabel: VoteLabel;
  isRequired: boolean;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{
  summary: string;
  status: string;
  mergeStatus: string | null;
  votes: PrVote[];
}> {
  const resolved = resolveScope(ctx, args);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${args.pr_id}?api-version=${API_VERSION}`;
  const raw = await adoFetch<RawPullRequest>(ctx, url);

  const votes: PrVote[] = (raw.reviewers ?? []).map((r) => ({
    reviewerId: r.id ?? '',
    displayName: r.displayName ?? '',
    vote: typeof r.vote === 'number' ? r.vote : 0,
    voteLabel: mapVoteLabel(typeof r.vote === 'number' ? r.vote : 0),
    isRequired: r.isRequired === true,
  }));

  const approved = votes.filter((v) => v.vote >= 5).length;
  const rejected = votes.filter((v) => v.vote < 0).length;
  const summary = `PR ${args.pr_id} status=${raw.status} merge=${raw.mergeStatus ?? 'n/a'} — ${votes.length} reviewer(s): ${approved} approved, ${rejected} blocking.`;

  return {
    summary,
    status: raw.status,
    mergeStatus: raw.mergeStatus ?? null,
    votes,
  };
}
