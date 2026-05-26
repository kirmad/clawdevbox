/**
 * tools/get_work_item.ts — `ado.get_work_item` hostable tool.
 *
 * Wraps GET /_apis/wit/workitems/{id}?$expand=relations
 * Returns narrowed WI metadata + relations (PR links, parent, children, ...).
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { AdoConfigError, adoFetch, resolveScope } from './_auth.ts';

export const id = 'ado.get_work_item';

export const description =
  'Get a single ADO work item by id. Returns narrowed fields (type, state, title, description, area path, tags, assignedTo) plus expanded relations (PR links, parent, children).';

// Work-item APIs require api-version=7.1 (not 7.1-preview.1 like the git APIs).
const WIT_API_VERSION = '7.1';

export const parameters = z.object({
  org: z
    .string()
    .min(1)
    .optional()
    .describe('ADO organization slug. Defaults to env ADO_ORG.'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe('ADO project name. Defaults to env ADO_PROJECT.'),
  id: z.number().int().positive().describe('Work item id.'),
  fields: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional list of `System.*` / `Microsoft.VSTS.*` field names to return. When omitted, the host returns the curated default set.',
    ),
});

interface RawRelation {
  rel?: string;
  url?: string;
  attributes?: Record<string, unknown>;
}

interface RawWorkItem {
  id?: number;
  rev?: number;
  url?: string;
  fields?: Record<string, unknown>;
  relations?: RawRelation[];
}

interface NarrowedRelation {
  rel: string;
  url: string;
  name: string | null;
}

interface NarrowedWorkItem {
  id: number;
  rev: number;
  url: string;
  type: string;
  state: string;
  title: string;
  description: string;
  reproSteps: string;
  acceptanceCriteria: string;
  areaPath: string;
  iterationPath: string;
  tags: string[];
  assignedTo: { displayName: string; uniqueName: string; id: string };
  createdBy: { displayName: string; uniqueName: string; id: string };
  createdDate: string;
  changedDate: string;
  fields: Record<string, unknown>;
  relations: NarrowedRelation[];
}

function strField(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === 'string' ? v : '';
}

function identityField(
  fields: Record<string, unknown>,
  key: string,
): { displayName: string; uniqueName: string; id: string } {
  const v = fields[key];
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    return {
      displayName: typeof obj.displayName === 'string' ? obj.displayName : '',
      uniqueName: typeof obj.uniqueName === 'string' ? obj.uniqueName : '',
      id: typeof obj.id === 'string' ? obj.id : '',
    };
  }
  return { displayName: '', uniqueName: '', id: '' };
}

function projectScopedBase(
  org: string,
  project: string | null,
): string {
  // org may be composite "<org>/<urlencoded-project>"
  if (org.includes('/')) {
    return `https://dev.azure.com/${org}`;
  }
  if (!project) {
    throw new AdoConfigError(
      'ADO project missing. Pass `project` in the tool args or set ADO_PROJECT in the server env.',
    );
  }
  return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; workItem: NarrowedWorkItem }> {
  // Work-item endpoints don't need a `repo` — but resolveScope insists on it.
  // We inline scope resolution here instead so callers don't need a fake repo.
  const org = args.org ?? ctx.env.ADO_ORG ?? '';
  if (!org) {
    throw new AdoConfigError(
      'ADO_ORG missing. Pass `org` in the tool args or set ADO_ORG in the server env.',
    );
  }
  const project = args.project ?? ctx.env.ADO_PROJECT ?? null;
  const base = projectScopedBase(org, project);
  void resolveScope; // silence unused-import on TS strict

  const fieldsParam = args.fields && args.fields.length > 0
    ? `&fields=${args.fields.map((f) => encodeURIComponent(f)).join(',')}`
    : '';
  // When `fields` is set, ADO disallows $expand. Only expand when no fields filter.
  const expandParam = fieldsParam ? '' : '&$expand=relations';
  const url = `${base}/_apis/wit/workitems/${args.id}?api-version=${WIT_API_VERSION}${expandParam}${fieldsParam}`;
  const raw = await adoFetch<RawWorkItem>(ctx, url);

  const fields = raw.fields ?? {};
  const tagsRaw = strField(fields, 'System.Tags');
  const tags = tagsRaw ? tagsRaw.split(';').map((t) => t.trim()).filter(Boolean) : [];

  const narrowedRelations: NarrowedRelation[] = (raw.relations ?? [])
    .filter((r): r is RawRelation & { rel: string; url: string } =>
      typeof r.rel === 'string' && typeof r.url === 'string',
    )
    .map((r) => {
      const attrName = r.attributes && typeof r.attributes['name'] === 'string'
        ? (r.attributes['name'] as string)
        : null;
      return { rel: r.rel, url: r.url, name: attrName };
    });

  const wi: NarrowedWorkItem = {
    id: typeof raw.id === 'number' ? raw.id : args.id,
    rev: typeof raw.rev === 'number' ? raw.rev : 0,
    url: raw.url ?? '',
    type: strField(fields, 'System.WorkItemType'),
    state: strField(fields, 'System.State'),
    title: strField(fields, 'System.Title'),
    description: strField(fields, 'System.Description'),
    reproSteps: strField(fields, 'Microsoft.VSTS.TCM.ReproSteps'),
    acceptanceCriteria: strField(fields, 'Microsoft.VSTS.Common.AcceptanceCriteria'),
    areaPath: strField(fields, 'System.AreaPath'),
    iterationPath: strField(fields, 'System.IterationPath'),
    tags,
    assignedTo: identityField(fields, 'System.AssignedTo'),
    createdBy: identityField(fields, 'System.CreatedBy'),
    createdDate: strField(fields, 'System.CreatedDate'),
    changedDate: strField(fields, 'System.ChangedDate'),
    fields,
    relations: narrowedRelations,
  };

  const summary = `WI ${wi.id} — [${wi.type}] ${wi.title} (${wi.state}) — area=${wi.areaPath} assignee=${wi.assignedTo.displayName || '<unassigned>'}; ${wi.relations.length} relation(s)`;
  return { summary, workItem: wi };
}
