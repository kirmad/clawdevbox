#!/usr/bin/env tsx
/**
 * ado-new-work-item-watcher.ts
 *
 * Cold trigger script for the `ado.new-work-item-watcher` trigger TYPE.
 *
 * The plugin manifest binds this type to the `triage-work-item` recipe, so
 * Clawdevbox mints a per-registration callback URL of the shape
 * `/callback/recipes/triage-work-item/run`. The script POSTs one callback
 * per matched work item (Mode B).
 *
 * Auth:
 *   ADO_BEARER_TOKEN  preferred (AAD access token, audience 499b84ac-…)
 *   ADO_PAT           fallback  (basic auth)
 *
 * Mode B requires CLAWDEVBOX_MCP_SECRET for the Authorization header on
 * direct callback POSTs.
 *
 * Zero dependencies beyond Node 20+ built-in fetch.
 *
 * Spec: docs/superpowers/specs/2026-05-26-ado-work-item-recipes-design.md §8.
 */

// ============================================================================
// Types
// ============================================================================

type FiredBy = 'external' | 'cron' | 'manual' | 'agent';

interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  fired_by: FiredBy;
  fired_at: number;
  cwd: string;
  project_dir: string;
  trigger_data_dir: string;
  subscriber_thread_id: string | null;
  /** Pre-bound callback URL of shape /callback/recipes/triage-work-item/run. */
  callback_url: string;
  state: WatcherState;
  /** Optional ADO service-hook body when fired_by='external'; otherwise null. */
  payload: AdoServiceHookPayload | null;
}

interface WatcherState {
  org: string;
  project: string;
  area_path: string;
  assigned_to?: string;
  work_item_types?: string[];
  states?: string[];
  exclude_tags?: string[];
  /** Unix-ms cursor — only WIs ChangedDate > this are picked up. 0 on first run. */
  lastCheckedAt: number;
}

interface AdoServiceHookPayload {
  resource?: {
    id?: number;
    fields?: Record<string, unknown>;
  };
}

interface AdoWorkItemRef {
  id: number;
}

interface AdoWorkItem {
  id: number;
  url?: string;
  fields?: Record<string, unknown>;
}

interface CallbackBody {
  prompt: string;
  attach_to_inbox_item_id?: string;
  context?: Record<string, unknown>;
}

interface TriggerResponse {
  state?: WatcherState;
  systemMessage?: string;
  decision?: 'ok' | 'block';
  reason?: string;
}

// ============================================================================
// I/O helpers
// ============================================================================

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeStdout(response: TriggerResponse): void {
  process.stdout.write(JSON.stringify(response));
}

function blockingError(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// ============================================================================
// ADO client (raw HTTP — bearer preferred, PAT fallback)
// ============================================================================

const ADO_PAT = process.env.ADO_PAT ?? '';
const ADO_BEARER_TOKEN = process.env.ADO_BEARER_TOKEN ?? '';
const CLAWDEVBOX_MCP_SECRET = process.env.CLAWDEVBOX_MCP_SECRET ?? '';

const WIT_API_VERSION = '7.1';

function adoAuthHeader(): string {
  if (ADO_BEARER_TOKEN) return `Bearer ${ADO_BEARER_TOKEN}`;
  if (ADO_PAT) return `Basic ${Buffer.from(`:${ADO_PAT}`).toString('base64')}`;
  throw new Error('ADO_BEARER_TOKEN or ADO_PAT env var required');
}

function escapeWiqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function orgBaseUrl(org: string): string {
  return org.includes('/')
    ? `https://dev.azure.com/${org.split('/')[0]}`
    : `https://dev.azure.com/${encodeURIComponent(org)}`;
}

async function runWiql(state: WatcherState): Promise<AdoWorkItemRef[]> {
  const clauses: string[] = [];
  clauses.push(`[System.TeamProject] = '${escapeWiqlString(state.project)}'`);
  clauses.push(`[System.AreaPath] UNDER '${escapeWiqlString(state.area_path)}'`);
  const types = state.work_item_types ?? ['User Story', 'Feature', 'Bug', 'Task'];
  clauses.push(
    `[System.WorkItemType] IN (${types.map((t) => `'${escapeWiqlString(t)}'`).join(', ')})`,
  );
  const states = state.states ?? ['New'];
  clauses.push(
    `[System.State] IN (${states.map((s) => `'${escapeWiqlString(s)}'`).join(', ')})`,
  );
  if (state.assigned_to) {
    if (state.assigned_to === '@me') {
      clauses.push(`[System.AssignedTo] = @Me`);
    } else {
      clauses.push(`[System.AssignedTo] = '${escapeWiqlString(state.assigned_to)}'`);
    }
  }
  if (state.lastCheckedAt > 0) {
    // ADO WIQL only accepts date-precision for `>` on date fields. We pass
    // a date string (1 day earlier in UTC to avoid TZ skew) and rely on the
    // ms-precise post-filter below to dedup against `lastCheckedAt`.
    const since = new Date(state.lastCheckedAt - 24 * 60 * 60 * 1000);
    const sinceDate = `${since.getUTCFullYear()}-${String(since.getUTCMonth() + 1).padStart(2, '0')}-${String(since.getUTCDate()).padStart(2, '0')}`;
    clauses.push(`[System.ChangedDate] >= '${escapeWiqlString(sinceDate)}'`);
  }
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] ASC`;

  const url = `${orgBaseUrl(state.org)}/_apis/wit/wiql?api-version=${WIT_API_VERSION}&$top=200`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: adoAuthHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: wiql }),
  });
  if (!res.ok) throw new Error(`ADO WIQL ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { workItems?: Array<{ id?: number }> };
  return (body.workItems ?? [])
    .map((w) => w.id)
    .filter((n): n is number => typeof n === 'number')
    .map((id) => ({ id }));
}

async function batchFetch(org: string, ids: number[]): Promise<AdoWorkItem[]> {
  if (ids.length === 0) return [];
  const url = `${orgBaseUrl(org)}/_apis/wit/workitemsbatch?api-version=${WIT_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: adoAuthHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      ids,
      fields: [
        'System.Id',
        'System.WorkItemType',
        'System.State',
        'System.Title',
        'System.AreaPath',
        'System.Tags',
        'System.AssignedTo',
        'System.ChangedDate',
      ],
    }),
  });
  if (!res.ok) throw new Error(`ADO batch ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { value?: AdoWorkItem[] };
  return body.value ?? [];
}

// ============================================================================
// Filtering
// ============================================================================

function wiMatchesFilters(wi: AdoWorkItem, state: WatcherState): boolean {
  const fields = wi.fields ?? {};
  if (state.exclude_tags && state.exclude_tags.length > 0) {
    const tagsRaw =
      typeof fields['System.Tags'] === 'string'
        ? (fields['System.Tags'] as string).toLowerCase()
        : '';
    if (tagsRaw) {
      for (const ex of state.exclude_tags) {
        if (tagsRaw.split(';').map((t) => t.trim()).includes(ex.toLowerCase())) {
          return false;
        }
      }
    }
  }
  return true;
}

// ============================================================================
// Prompt construction
// ============================================================================

function bodyForWorkItem(wi: AdoWorkItem, state: WatcherState): CallbackBody {
  const fields = wi.fields ?? {};
  const id = wi.id;
  const type =
    typeof fields['System.WorkItemType'] === 'string'
      ? (fields['System.WorkItemType'] as string)
      : 'Work Item';
  const title =
    typeof fields['System.Title'] === 'string'
      ? (fields['System.Title'] as string)
      : '(untitled)';
  const wiState =
    typeof fields['System.State'] === 'string' ? (fields['System.State'] as string) : '';
  const area =
    typeof fields['System.AreaPath'] === 'string' ? (fields['System.AreaPath'] as string) : '';
  const assignedToObj = fields['System.AssignedTo'];
  const assignee =
    assignedToObj && typeof assignedToObj === 'object'
      ? ((assignedToObj as Record<string, unknown>).displayName as string | undefined) ??
        ((assignedToObj as Record<string, unknown>).uniqueName as string | undefined) ??
        '<unassigned>'
      : '<unassigned>';

  const prompt = [
    `Triage ADO work item ${id} (${type}, ${wiState}): ${title}`,
    ``,
    `Area: ${area}`,
    `Assignee: ${assignee}`,
    `Project: ${state.project}  Org: ${state.org}`,
    ``,
    `Apply the triage-work-item recipe: read the WI (ado.get_work_item),`,
    `resolve the affected repo(s) via .clawdevbox/repo-registry.md (Phase 0`,
    `of the spec), and dispatch to implement-feature or fix-bug. Only ask`,
    `the user about repo selection when not confident.`,
  ].join('\n');

  return {
    prompt,
    attach_to_inbox_item_id: `ado:wi:${id}`,
    context: {
      source: 'ado',
      kind: 'wi.fired',
      wi_id: id,
      wi_type: type,
      wi_state: wiState,
      area_path: area,
      title,
      assignee,
      org: state.org,
      project: state.project,
    },
  };
}

// ============================================================================
// Mode B callback POST
// ============================================================================

async function postCallback(callbackUrl: string, body: CallbackBody): Promise<void> {
  if (!CLAWDEVBOX_MCP_SECRET) {
    throw new Error('CLAWDEVBOX_MCP_SECRET env var required for Mode B callback POSTs');
  }
  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CLAWDEVBOX_MCP_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`callback POST ${res.status}: ${text}`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    writeStdout({ systemMessage: 'No stdin envelope received.' });
    return;
  }

  let env: TriggerEnvelope;
  try {
    env = JSON.parse(stdin);
  } catch (err) {
    blockingError(`Invalid JSON on stdin: ${(err as Error).message}`);
  }

  const defaults: WatcherState = {
    org: '',
    project: '',
    area_path: '',
    work_item_types: ['User Story', 'Feature', 'Bug', 'Task'],
    states: ['New'],
    lastCheckedAt: 0,
  };
  const state: WatcherState = { ...defaults, ...env.state };

  if (!state.org) blockingError('state.org required (set at trigger registration)');
  if (!state.project) blockingError('state.project required (set at trigger registration)');
  if (!state.area_path) blockingError('state.area_path required (set at trigger registration)');

  const callbackUrl = env.callback_url;
  if (!callbackUrl) {
    blockingError('env.callback_url missing — required for Mode B live POSTs');
  }

  let posted = 0;

  // ---- Real-time path: ADO service hook delivered a single WI payload ----
  if (env.fired_by === 'external' && env.payload?.resource?.id) {
    const resource = env.payload.resource;
    const wi: AdoWorkItem = {
      id: resource.id,
      url: '',
      fields: resource.fields ?? {},
    };
    if (wiMatchesFilters(wi, state)) {
      await postCallback(callbackUrl, bodyForWorkItem(wi, state));
      posted++;
    }
    state.lastCheckedAt = Math.max(state.lastCheckedAt, Date.now());
    writeStdout({
      state,
      systemMessage:
        posted > 0
          ? `Forwarded 1 WI (${wi.id}) from ADO service hook.`
          : `External WI ${wi.id} did not match filters; skipped.`,
    });
    return;
  }

  // ---- Cron / manual / agent: WIQL poll ----
  const refs = await runWiql(state);
  if (refs.length === 0) {
    state.lastCheckedAt = state.lastCheckedAt || Date.now();
    writeStdout({
      state,
      systemMessage: `No new work items in ${state.area_path} (fired_by=${env.fired_by}).`,
    });
    return;
  }

  const wis = await batchFetch(state.org, refs.map((r) => r.id));
  // Sort by ChangedDate asc so cursor advances monotonically.
  wis.sort((a, b) => {
    const ad = typeof a.fields?.['System.ChangedDate'] === 'string'
      ? Date.parse(a.fields['System.ChangedDate'] as string)
      : 0;
    const bd = typeof b.fields?.['System.ChangedDate'] === 'string'
      ? Date.parse(b.fields['System.ChangedDate'] as string)
      : 0;
    return ad - bd;
  });

  let cursor = state.lastCheckedAt;
  for (const wi of wis) {
    if (!wiMatchesFilters(wi, state)) continue;
    const cd = typeof wi.fields?.['System.ChangedDate'] === 'string'
      ? Date.parse(wi.fields['System.ChangedDate'] as string)
      : 0;
    // Ms-precise dedup: WIQL only filters by date, so re-check here.
    if (state.lastCheckedAt > 0 && cd > 0 && cd <= state.lastCheckedAt) continue;
    await postCallback(callbackUrl, bodyForWorkItem(wi, state));
    posted++;
    if (cd > cursor) cursor = cd;
  }
  if (cursor === state.lastCheckedAt) cursor = Date.now();
  state.lastCheckedAt = cursor;

  writeStdout({
    state,
    systemMessage:
      posted > 0
        ? `Picked up ${posted} work item(s) in ${state.area_path} (fired_by=${env.fired_by}).`
        : `No matched work items in ${state.area_path} (fired_by=${env.fired_by}).`,
  });
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.stderr.write('\n');
  process.exit(1);
});
