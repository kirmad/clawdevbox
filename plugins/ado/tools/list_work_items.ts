/**
 * tools/list_work_items.ts — `ado.list_work_items` hostable tool.
 *
 * Runs a bounded WIQL query (caller supplies the WHERE clause, or a
 * structured filter we compose into one) and returns narrowed WI metadata.
 *
 * Two call shapes:
 *   1. { wiql: "SELECT [System.Id], [System.Title] FROM WorkItems WHERE ..." }
 *      Caller controls the entire query (recommended for ad-hoc triage).
 *   2. { filter: { project?, area_path?, types?, states?, assigned_to?,
 *                  changed_since_iso?, tags_any?, tags_none? } }
 *      Tool composes a safe WIQL from the structured fields. Easier from
 *      a recipe that doesn't want to hand-craft WIQL.
 *
 * Either way the result is the WI list batched via /workitemsbatch.
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { AdoConfigError, adoFetch } from './_auth.ts';

export const id = 'ado.list_work_items';

export const description =
  'Run a bounded WIQL query (or compose one from a structured filter) and return narrowed work-item metadata. Use the `wiql` field for full control, or `filter` for the common cases (area path, types, states, assignee, changed-since, tags).';

const WIT_API_VERSION = '7.1';
// Default cap on results returned to the caller (and on the batch fetch).
const DEFAULT_MAX = 50;
const ABSOLUTE_MAX = 200;

export const parameters = z
  .object({
    org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
    project: z
      .string()
      .min(1)
      .optional()
      .describe('ADO project. Defaults to env ADO_PROJECT.'),
    wiql: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Full WIQL query string. The query MUST `SELECT [System.Id]` at minimum (other selected fields are ignored — the tool re-fetches via workitemsbatch).',
      ),
    filter: z
      .object({
        project: z.string().min(1).optional(),
        area_path: z.string().min(1).optional(),
        types: z.array(z.string().min(1)).optional(),
        states: z.array(z.string().min(1)).optional(),
        assigned_to: z.string().min(1).optional(),
        changed_since_iso: z.string().min(1).optional(),
        tags_any: z.array(z.string().min(1)).optional(),
        tags_none: z.array(z.string().min(1)).optional(),
      })
      .optional()
      .describe('Structured filter, composed into WIQL when `wiql` is not set.'),
    max: z
      .number()
      .int()
      .positive()
      .max(ABSOLUTE_MAX)
      .optional()
      .describe(`Cap on returned work items (default ${DEFAULT_MAX}, hard cap ${ABSOLUTE_MAX}).`),
  })
  .refine((v) => Boolean(v.wiql) || Boolean(v.filter), {
    message: 'Either `wiql` or `filter` must be set.',
  });

interface WiqlResponse {
  workItems?: Array<{ id?: number }>;
}

interface RawWorkItem {
  id?: number;
  url?: string;
  fields?: Record<string, unknown>;
}

interface BatchResponse {
  value?: RawWorkItem[];
}

interface ListedWorkItem {
  id: number;
  type: string;
  state: string;
  title: string;
  areaPath: string;
  iterationPath: string;
  tags: string[];
  assignedTo: { displayName: string; uniqueName: string };
  changedDate: string;
  url: string;
}

function escapeWiqlString(s: string): string {
  // WIQL strings use single quotes. Escape single-quote by doubling.
  return s.replace(/'/g, "''");
}

function composeWiql(
  filter: NonNullable<z.infer<typeof parameters>['filter']>,
  defaultProject: string | null,
): string {
  const parts: string[] = [];
  const project = filter.project ?? defaultProject;
  if (project) {
    parts.push(`[System.TeamProject] = '${escapeWiqlString(project)}'`);
  }
  if (filter.area_path) {
    parts.push(`[System.AreaPath] UNDER '${escapeWiqlString(filter.area_path)}'`);
  }
  if (filter.types && filter.types.length > 0) {
    const list = filter.types.map((t) => `'${escapeWiqlString(t)}'`).join(', ');
    parts.push(`[System.WorkItemType] IN (${list})`);
  }
  if (filter.states && filter.states.length > 0) {
    const list = filter.states.map((s) => `'${escapeWiqlString(s)}'`).join(', ');
    parts.push(`[System.State] IN (${list})`);
  }
  if (filter.assigned_to) {
    if (filter.assigned_to === '@me') {
      parts.push(`[System.AssignedTo] = @Me`);
    } else {
      parts.push(`[System.AssignedTo] = '${escapeWiqlString(filter.assigned_to)}'`);
    }
  }
  if (filter.changed_since_iso) {
    parts.push(`[System.ChangedDate] > '${escapeWiqlString(filter.changed_since_iso)}'`);
  }
  if (filter.tags_any && filter.tags_any.length > 0) {
    // WIQL has `[System.Tags] CONTAINS '<tag>'`. OR them together.
    const clauses = filter.tags_any
      .map((t) => `[System.Tags] CONTAINS '${escapeWiqlString(t)}'`)
      .join(' OR ');
    parts.push(`(${clauses})`);
  }
  if (filter.tags_none && filter.tags_none.length > 0) {
    for (const t of filter.tags_none) {
      parts.push(`[System.Tags] NOT CONTAINS '${escapeWiqlString(t)}'`);
    }
  }
  const where = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
  return `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`;
}

function strField(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === 'string' ? v : '';
}

function identityName(
  fields: Record<string, unknown>,
  key: string,
): { displayName: string; uniqueName: string } {
  const v = fields[key];
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return {
      displayName: typeof obj.displayName === 'string' ? obj.displayName : '',
      uniqueName: typeof obj.uniqueName === 'string' ? obj.uniqueName : '',
    };
  }
  return { displayName: '', uniqueName: '' };
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; workItems: ListedWorkItem[]; count: number }> {
  const org = args.org ?? ctx.env.ADO_ORG ?? '';
  if (!org) {
    throw new AdoConfigError(
      'ADO_ORG missing. Pass `org` in the tool args or set ADO_ORG in the server env.',
    );
  }
  const project = args.project ?? ctx.env.ADO_PROJECT ?? null;
  const max = args.max ?? DEFAULT_MAX;

  const wiql = args.wiql ?? composeWiql(args.filter!, project);

  // Org-scoped (org-level) WIQL endpoint requires no project segment, but
  // when scoping `[System.TeamProject]` in WHERE clauses we pass it.
  // We always go through the org-scope endpoint to keep one code path.
  const baseOrg = org.includes('/')
    ? `https://dev.azure.com/${org.split('/')[0]}`
    : `https://dev.azure.com/${encodeURIComponent(org)}`;

  const wiqlUrl = `${baseOrg}/_apis/wit/wiql?api-version=${WIT_API_VERSION}&$top=${max}`;
  const wiqlBody = JSON.stringify({ query: wiql });
  const wiqlResp = await adoFetch<WiqlResponse>(ctx, wiqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: wiqlBody,
  });

  const ids = (wiqlResp.workItems ?? [])
    .map((w) => w.id)
    .filter((n): n is number => typeof n === 'number')
    .slice(0, max);

  if (ids.length === 0) {
    return { summary: 'No work items matched.', workItems: [], count: 0 };
  }

  const batchUrl = `${baseOrg}/_apis/wit/workitemsbatch?api-version=${WIT_API_VERSION}`;
  const batchBody = JSON.stringify({
    ids,
    fields: [
      'System.Id',
      'System.WorkItemType',
      'System.State',
      'System.Title',
      'System.AreaPath',
      'System.IterationPath',
      'System.Tags',
      'System.AssignedTo',
      'System.ChangedDate',
    ],
  });
  const batch = await adoFetch<BatchResponse>(ctx, batchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: batchBody,
  });

  // Preserve the WIQL ORDER BY (workitemsbatch returns in id order).
  const byId = new Map<number, RawWorkItem>();
  for (const w of batch.value ?? []) {
    if (typeof w.id === 'number') byId.set(w.id, w);
  }

  const items: ListedWorkItem[] = [];
  for (const id of ids) {
    const w = byId.get(id);
    if (!w) continue;
    const fields = w.fields ?? {};
    const tagsRaw = strField(fields, 'System.Tags');
    items.push({
      id,
      type: strField(fields, 'System.WorkItemType'),
      state: strField(fields, 'System.State'),
      title: strField(fields, 'System.Title'),
      areaPath: strField(fields, 'System.AreaPath'),
      iterationPath: strField(fields, 'System.IterationPath'),
      tags: tagsRaw ? tagsRaw.split(';').map((t) => t.trim()).filter(Boolean) : [],
      assignedTo: identityName(fields, 'System.AssignedTo'),
      changedDate: strField(fields, 'System.ChangedDate'),
      url: w.url ?? '',
    });
  }

  return {
    summary: `Found ${items.length} work item(s).`,
    workItems: items,
    count: items.length,
  };
}
