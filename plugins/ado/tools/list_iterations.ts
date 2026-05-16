/**
 * tools/list_iterations.ts — `ado.list_iterations` hostable tool (spec §10.3).
 *
 * Wraps GET /_apis/git/repositories/{repo}/pullRequests/{prId}/iterations.
 * Returns iteration summaries oldest → newest.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { adoFetch, API_VERSION, resolveScope, urlBase } from './_auth.ts';

export const id = 'ado.list_iterations';

export const description =
  'List the iterations (pushed-update snapshots) of a PR, oldest → newest. Each entry carries id, createdDate, and source/target commit hashes.';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  repo: z.string().min(1).describe('ADO repository name.'),
  pr_id: z.number().int().positive().describe('Pull request id.'),
});

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

interface IterationSummary {
  id: number;
  createdDate: string;
  description: string | null;
  sourceRefCommit: string | null;
  targetRefCommit: string | null;
  push: { pushId: number; date: string } | null;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; iterations: IterationSummary[]; count: number }> {
  const resolved = resolveScope(ctx, args);
  const base = urlBase(resolved);
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(resolved.repo)}/pullRequests/${args.pr_id}/iterations?api-version=${API_VERSION}`;
  const raw = await adoFetch<AdoListResponse<RawIteration>>(ctx, url);

  const iterations: IterationSummary[] = (raw.value ?? [])
    .map((it) => ({
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

  const summary =
    iterations.length === 0
      ? `No iterations found for PR ${args.pr_id}.`
      : `Found ${iterations.length} iteration(s) on PR ${args.pr_id}. Latest id=${iterations[iterations.length - 1].id}.`;
  return { summary, iterations, count: iterations.length };
}
