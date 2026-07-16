/**
 * tools/update_work_item.ts — `ado.update_work_item` hostable tool.
 *
 * Wraps PATCH /_apis/wit/workitems/{id}?api-version=7.1 with a JSON-patch
 * document. Supports the common cases the WI recipes need:
 *   - transition state (e.g. New → Active → Resolved → Closed)
 *   - set assignedTo
 *   - add/remove/replace tags
 *   - add an ArtifactLink relation (typically the PR back-link)
 *
 * For anything else, callers can pass raw `patches` JSON-patch ops directly.
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §7.
 */

import { z } from 'zod';
import type { ToolContext } from '@clawdevbox/sdk';
import { AdoConfigError, adoFetch } from './_auth.ts';

export const id = 'ado.update_work_item';

export const description =
  'Update an ADO work item. Supports common cases (state, assignedTo, tags, linking a PR via ArtifactLink) plus a raw `patches` escape hatch for arbitrary JSON-patch ops.';

const WIT_API_VERSION = '7.1';

const jsonPatchOp = z.object({
  op: z.enum(['add', 'replace', 'remove', 'test']),
  path: z.string().min(1),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

export const parameters = z.object({
  org: z.string().min(1).optional().describe('ADO org. Defaults to env ADO_ORG.'),
  project: z.string().min(1).optional().describe('ADO project. Defaults to env ADO_PROJECT.'),
  id: z.number().int().positive().describe('Work item id.'),

  state: z.string().min(1).optional().describe('New System.State value.'),
  assigned_to: z
    .string()
    .min(1)
    .optional()
    .describe(
      "New assignee (uniqueName or display name). Pass empty string with `clear_assigned_to: true` to unassign.",
    ),
  clear_assigned_to: z
    .boolean()
    .optional()
    .describe('When true, removes the assignee. Overrides `assigned_to`.'),
  add_tags: z
    .array(z.string().min(1))
    .optional()
    .describe('Tags to add (existing tags preserved; tool reads current value first).'),
  remove_tags: z
    .array(z.string().min(1))
    .optional()
    .describe('Tags to remove.'),
  set_tags: z
    .array(z.string().min(1))
    .optional()
    .describe('Replace the entire tag set with this list. Overrides add/remove.'),

  link_pr: z
    .object({
      org: z
        .string()
        .min(1)
        .optional()
        .describe('Org slug for the PR; defaults to the WI org.'),
      project_id: z
        .string()
        .min(1)
        .describe('Project GUID hosting the PR (NOT the project name).'),
      repo_id: z
        .string()
        .min(1)
        .describe('Repository GUID hosting the PR.'),
      pr_id: z.number().int().positive().describe('Pull request id.'),
      name: z
        .string()
        .optional()
        .describe(
          "ArtifactLink display name. Defaults to 'Pull Request'. Common ADO names include 'Pull Request', 'Branch', 'Commit'.",
        ),
    })
    .optional()
    .describe(
      'Attach a Pull-Request artifact link. ADO requires the project + repo GUIDs (not slugs); call ado.get_pr to discover them.',
    ),

  fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Generic field setter — keys are field reference names (e.g. "System.Title"), values are the replacement value.',
    ),

  patches: z
    .array(jsonPatchOp)
    .optional()
    .describe('Escape hatch — raw JSON-patch ops appended at the end of the document.'),
});

interface RawWorkItem {
  id?: number;
  rev?: number;
  fields?: Record<string, unknown>;
}

interface JsonPatchOp {
  op: 'add' | 'replace' | 'remove' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.trim();
    if (!k) continue;
    const lc = k.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(k);
  }
  return out;
}

export default async function execute(
  args: z.infer<typeof parameters>,
  ctx: ToolContext,
): Promise<{ summary: string; workItem: { id: number; rev: number; state: string; tags: string[]; assignedTo: string } }> {
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

  const ops: JsonPatchOp[] = [];

  // ADO quirk: `op: add` silently no-ops on already-set fields. We always
  // use `op: replace` for `/fields/*` paths so updates actually apply, and
  // reserve `op: add` for `/relations/-` (append) and `op: remove` for
  // specific path removals.
  if (args.state) {
    ops.push({ op: 'replace', path: '/fields/System.State', value: args.state });
  }
  if (args.clear_assigned_to) {
    ops.push({ op: 'remove', path: '/fields/System.AssignedTo' });
  } else if (args.assigned_to) {
    ops.push({ op: 'replace', path: '/fields/System.AssignedTo', value: args.assigned_to });
  }

  // Tags handling — if any tag op is set, read the current tag list first so we
  // can compose the replacement value (ADO Tags is a single semicolon-delimited string).
  const tagOpRequested =
    Boolean(args.set_tags) ||
    Boolean(args.add_tags && args.add_tags.length > 0) ||
    Boolean(args.remove_tags && args.remove_tags.length > 0);

  if (tagOpRequested) {
    let nextTags: string[];
    if (args.set_tags) {
      nextTags = dedupeTags(args.set_tags);
    } else {
      const getUrl = `${base}/_apis/wit/workitems/${args.id}?api-version=${WIT_API_VERSION}&fields=System.Tags`;
      const current = await adoFetch<RawWorkItem>(ctx, getUrl);
      const tagsRaw = current.fields && typeof current.fields['System.Tags'] === 'string'
        ? (current.fields['System.Tags'] as string)
        : '';
      const have = tagsRaw ? tagsRaw.split(';').map((t) => t.trim()).filter(Boolean) : [];
      const removeSet = new Set((args.remove_tags ?? []).map((t) => t.toLowerCase()));
      const filtered = have.filter((t) => !removeSet.has(t.toLowerCase()));
      nextTags = dedupeTags([...filtered, ...(args.add_tags ?? [])]);
    }
    ops.push({ op: 'replace', path: '/fields/System.Tags', value: nextTags.join('; ') });
  }

  if (args.fields) {
    for (const [key, value] of Object.entries(args.fields)) {
      ops.push({ op: 'replace', path: `/fields/${key}`, value });
    }
  }

  if (args.link_pr) {
    const linkOrg = args.link_pr.org ?? (org.includes('/') ? org.split('/')[0] : org);
    const artifactUrl =
      `vstfs:///Git/PullRequestId/${args.link_pr.project_id}%2F${args.link_pr.repo_id}%2F${args.link_pr.pr_id}`;
    void linkOrg; // ArtifactLink uses GUIDs, not org slug; kept for future ref.
    ops.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'ArtifactLink',
        url: artifactUrl,
        attributes: {
          name: args.link_pr.name ?? 'Pull Request',
        },
      },
    });
  }

  if (args.patches && args.patches.length > 0) {
    for (const p of args.patches) ops.push(p);
  }

  if (ops.length === 0) {
    throw new AdoConfigError(
      'No update specified — set at least one of state/assigned_to/tags/fields/link_pr/patches.',
    );
  }

  const url = `${base}/_apis/wit/workitems/${args.id}?api-version=${WIT_API_VERSION}`;
  const raw = await adoFetch<RawWorkItem>(ctx, url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(ops),
  });

  const fields = raw.fields ?? {};
  const tagsRaw = typeof fields['System.Tags'] === 'string' ? (fields['System.Tags'] as string) : '';
  const tags = tagsRaw ? tagsRaw.split(';').map((t) => t.trim()).filter(Boolean) : [];
  const assignedToField = fields['System.AssignedTo'];
  const assignedTo =
    assignedToField && typeof assignedToField === 'object'
      ? ((assignedToField as Record<string, unknown>).displayName as string | undefined) ?? ''
      : '';
  const state = typeof fields['System.State'] === 'string' ? (fields['System.State'] as string) : '';

  return {
    summary: `Patched WI ${raw.id ?? args.id} (rev=${raw.rev ?? '?'}). state=${state} tags=${tags.length} ops=${ops.length}.`,
    workItem: {
      id: raw.id ?? args.id,
      rev: raw.rev ?? 0,
      state,
      tags,
      assignedTo,
    },
  };
}
