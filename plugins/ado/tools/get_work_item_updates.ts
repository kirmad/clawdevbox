/**
 * tools/get_work_item_updates.ts — `ado.get_work_item_updates` hostable tool.
 *
 * Wraps GET /_apis/wit/workitems/{id}/updates?api-version=7.1.
 * Returns the WI's revision history, narrowed to the fields/relations that
 * actually changed at each revision. Used to detect:
 *   - assignment changes (reassigned mid-flight)
 *   - state transitions (closed / reopened mid-flight)
 *   - links added/removed
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { AdoConfigError, adoFetch } from './_auth.ts';

export const id = 'ado.get_work_item_updates';

export const description =
  'Return the revision history of a work item — each entry is a delta (changed fields + added/removed relations) since the prior revision.';

const WIT_API_VERSION = '7.1';

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  id: z.number().int().positive().describe('Work item id.'),
  since_rev: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Return only updates with rev > since_rev. Use for polling.'),
  max: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('Cap on returned updates (default 50, hard cap 200).'),
});

interface RawFieldUpdate {
  oldValue?: unknown;
  newValue?: unknown;
}

interface RawWorkItemUpdate {
  id?: number;
  workItemId?: number;
  rev?: number;
  revisedBy?: {
    displayName?: string;
    uniqueName?: string;
    id?: string;
    date?: string;
  };
  revisedDate?: string;
  fields?: Record<string, RawFieldUpdate>;
  relations?: {
    added?: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }>;
    removed?: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }>;
  };
}

interface ListResponse {
  count?: number;
  value?: RawWorkItemUpdate[];
}

interface NarrowedFieldUpdate {
  oldValue: unknown;
  newValue: unknown;
}

interface NarrowedRelation {
  rel: string;
  url: string;
  name: string | null;
}

interface NarrowedUpdate {
  id: number;
  rev: number;
  revisedDate: string;
  revisedBy: { displayName: string; uniqueName: string; id: string };
  fields: Record<string, NarrowedFieldUpdate>;
  relationsAdded: NarrowedRelation[];
  relationsRemoved: NarrowedRelation[];
}

function narrowRelations(
  arr: Array<{ rel?: string; url?: string; attributes?: Record<string, unknown> }> | undefined,
): NarrowedRelation[] {
  if (!arr) return [];
  return arr
    .filter(
      (r): r is { rel: string; url: string; attributes?: Record<string, unknown> } =>
        typeof r.rel === 'string' && typeof r.url === 'string',
    )
    .map((r) => ({
      rel: r.rel,
      url: r.url,
      name:
        r.attributes && typeof r.attributes['name'] === 'string'
          ? (r.attributes['name'] as string)
          : null,
    }));
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; updates: NarrowedUpdate[]; count: number }> {
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

  const max = args.max ?? 50;
  const url = `${base}/_apis/wit/workitems/${args.id}/updates?api-version=${WIT_API_VERSION}&$top=${max}`;
  const raw = await adoFetch<ListResponse>(ctx, url);

  const cutoff = typeof args.since_rev === 'number' && args.since_rev > 0 ? args.since_rev : 0;

  const out: NarrowedUpdate[] = [];
  for (const u of raw.value ?? []) {
    if (typeof u.id !== 'number' || typeof u.rev !== 'number') continue;
    if (u.rev <= cutoff) continue;
    const narrowedFields: Record<string, NarrowedFieldUpdate> = {};
    for (const [k, v] of Object.entries(u.fields ?? {})) {
      narrowedFields[k] = { oldValue: v.oldValue ?? null, newValue: v.newValue ?? null };
    }
    out.push({
      id: u.id,
      rev: u.rev,
      revisedDate: u.revisedDate ?? u.revisedBy?.date ?? '',
      revisedBy: {
        displayName: u.revisedBy?.displayName ?? '',
        uniqueName: u.revisedBy?.uniqueName ?? '',
        id: u.revisedBy?.id ?? '',
      },
      fields: narrowedFields,
      relationsAdded: narrowRelations(u.relations?.added),
      relationsRemoved: narrowRelations(u.relations?.removed),
    });
  }
  out.sort((a, b) => a.rev - b.rev);

  const summary =
    out.length === 0
      ? `No updates on WI ${args.id}${args.since_rev ? ` since rev ${args.since_rev}` : ''}.`
      : `Found ${out.length} update(s) on WI ${args.id}${args.since_rev ? ` since rev ${args.since_rev}` : ''}. Latest rev=${out[out.length - 1].rev}.`;
  return { summary, updates: out, count: out.length };
}
