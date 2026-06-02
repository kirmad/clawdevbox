/**
 * Typed wrappers around the same `/api/*` endpoints the legacy home page
 * used. Kept minimal: each helper returns the raw JSON; components keep
 * their own loading / error state.
 *
 * The server bootstraps `window.__CLAWDEVBOX__` with the MCP URL and the
 * project dir. `bootstrap()` reads it once at module load with sensible
 * dev fallbacks so the SPA still works when started via `vite dev`.
 */

export interface Bootstrap {
  mcpUrl: string;
  projectDir: string;
}

declare global {
  interface Window {
    __CLAWDEVBOX__?: Partial<Bootstrap>;
  }
}

export function bootstrap(): Bootstrap {
  const w = typeof window !== 'undefined' ? window.__CLAWDEVBOX__ : undefined;
  return {
    mcpUrl: w?.mcpUrl ?? `${location.protocol}//${location.host}/mcp`,
    projectDir: w?.projectDir ?? '(dev)',
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`${url} → HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// -- Inbox -------------------------------------------------------------------

export type InboxItemState = 'new' | 'open' | 'in_progress' | 'snoozed' | 'archived' | 'done' | 'cancelled';

export interface InboxAttachment {
  artifact_id: string;
  workspace_id?: string | null;
  title?: string | null;
  type?: string | null;
  view_url?: string | null;
  resolved?: boolean;
}

export interface InboxRecipeRef {
  id: string;
  workspace_id?: string | null;
  resolved?: boolean;
}

export interface InboxItem {
  id: string;
  title?: string;
  preview?: string;
  state: InboxItemState;
  source?: string;
  kind?: string;
  updated_at: number;
  created_at?: number;
  attachments?: InboxAttachment[];
  recipe_instance?: InboxRecipeRef | null;
  trigger_id?: string | null;
  labels?: string[];
  description_format?: 'markdown' | 'text';
  description_size?: number;
  snoozed_until?: number;
  agent_message?: string;
  agent_tone?: 'info' | 'warn' | 'err' | 'ok';
  /** Optional legacy URL for direct artifact open. */
  view_url?: string;
}

export interface InboxItemDetail {
  item: InboxItem;
  /** Raw body content. null when the item has no description. */
  description: string | null;
}

export function fetchInbox(): Promise<{ items: InboxItem[] }> {
  return fetchJson('/api/inbox');
}

export function fetchInboxItem(id: string): Promise<InboxItemDetail> {
  return fetchJson(`/api/inbox/${encodeURIComponent(id)}`);
}

async function postInboxAction<T = { item: InboxItem }>(
  id: string,
  verb: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`POST /api/inbox/${id}/${verb} → HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

export function postInboxDone(id: string): Promise<{ item: InboxItem }> {
  return postInboxAction(id, 'done');
}
export function postInboxArchive(id: string): Promise<{ item: InboxItem }> {
  return postInboxAction(id, 'archive');
}
export function postInboxState(
  id: string,
  state: 'new' | 'open' | 'done' | 'archived',
): Promise<{ item: InboxItem }> {
  return postInboxAction(id, 'state', { state });
}
export function postInboxSnooze(id: string, until: number): Promise<{ item: InboxItem }> {
  return postInboxAction(id, 'snooze', { until });
}

// -- Recipes -----------------------------------------------------------------

export type RecipeStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'awaiting_user' | 'skipped';

export interface RecipeStep {
  id: string;
  title: string;
  status: RecipeStepStatus;
  started_at?: number;
  completed_at?: number;
  message?: string;
  awaiting_user_prompt?: string;
  child_recipe_instance_id?: string;
  artifact_id?: string;
}

export interface RecipeProgress {
  total_steps: number;
  completed_steps: number;
  awaiting_user_count: number;
}

export interface RecipeChildLink {
  id: string;
  recipe_id: string;
  status: 'running' | 'success' | 'failure' | 'cancelled';
}

export interface RecipeInstance {
  id: string;
  recipe_id: string;
  status: 'running' | 'success' | 'failure' | 'cancelled';
  started_at?: number;
  completed_at?: number;
  prompt?: string;
  agent_cli?: string;
  workspace_id?: string;
  pid?: number;
  message?: string;
  session_id?: string;
  resume_of?: string | null;
  steps?: RecipeStep[];
  children?: RecipeChildLink[];
  progress?: RecipeProgress | null;
  parent_recipe_instance_id?: string | null;
}

export function fetchRecipes(): Promise<{ items: RecipeInstance[] }> {
  return fetchJson('/api/recipes');
}

export interface ResumeRecipeResponse {
  new_recipe_instance_id: string;
  session_id: string;
  resume_of: string;
  pid: number | null;
  agent_cli: string;
}

export async function postRecipeResume(
  id: string,
  prompt?: string,
): Promise<ResumeRecipeResponse> {
  const res = await fetch(`/api/recipes/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prompt ? { prompt } : {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`POST /api/recipes/${id}/resume → HTTP ${res.status} ${txt.slice(0, 300)}`);
  }
  return (await res.json()) as ResumeRecipeResponse;
}

// -- Triggers ----------------------------------------------------------------

export interface RegisteredTrigger {
  id: string;
  type: string;
  source_plugin_id: string | null;
  type_description?: string | null;
  params: Record<string, unknown>;
  cron: string | null | false;
  resolved_cron: string | null | false;
  cron_label?: string | null;
  next_run_at?: number | null;
  enabled: boolean;
  subscriber_thread_id: string | null;
  registered_at: number;
  last_run_at: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
}

export function fetchTriggers(): Promise<{ items: RegisteredTrigger[] }> {
  return fetchJson('/api/triggers');
}

export interface TriggerType {
  id: string;
  source_plugin_id: string;
  scope: string;
  description?: string;
  default_cron?: string;
  accepts_webhook?: boolean;
  identity_param?: string;
  parameters?: { name: string; type: string; required?: boolean; description?: string; default?: unknown }[];
}

export function fetchTriggerTypes(): Promise<{ items: TriggerType[]; errors: unknown[] }> {
  return fetchJson('/api/triggers/types');
}

// -- Approvals ---------------------------------------------------------------

export interface PendingApproval {
  id: string;
  thread_id: string;
  question: string;
  options?: string[];
  created_at: number;
}

export function fetchApprovals(): Promise<{ items: PendingApproval[] }> {
  return fetchJson('/api/approvals');
}

// -- Agent -------------------------------------------------------------------

export interface MainAgentStatus {
  running: boolean;
  exited?: boolean;
  exitCode?: number | null;
  /**
   * Human-readable reason `running` is false (provider missing, binary not on
   * PATH, spawn threw, process exited). Absent while running.
   */
  not_running_reason?: string;
}

export function fetchAgentStatus(): Promise<MainAgentStatus> {
  return fetchJson('/api/main-agent/status');
}

// -- Tunnel ------------------------------------------------------------------

export interface TunnelStatus {
  kind: 'none' | 'devtunnel';
  name?: string | null;
  port?: number | null;
  running?: boolean;
  url?: string | null;
  inspect_url?: string | null;
  error?: string | null;
  pid?: number | null;
}

export function fetchTunnelStatus(): Promise<TunnelStatus> {
  return fetchJson('/api/tunnel/status');
}

// -- Push --------------------------------------------------------------------

export interface PushVapidInfo {
  enabled: boolean;
  publicKey?: string;
}

export function fetchPushVapid(): Promise<PushVapidInfo> {
  return fetchJson('/api/push/vapid');
}

export interface PushSubscriber {
  endpoint: string;
  label?: string;
  created_at: number;
  last_seen_at?: number;
}

export interface PushStatus {
  enabled: boolean;
  subscriptions: PushSubscriber[];
}

export function fetchPushStatus(): Promise<PushStatus> {
  return fetchJson('/api/push/status');
}

export async function postPushSubscribe(sub: PushSubscriptionJSON, label: string): Promise<void> {
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, label }),
  });
}

export async function postPushUnsubscribe(endpoint: string): Promise<void> {
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}

export async function postPushTest(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/push/test', { method: 'POST' });
  return (await res.json()) as { ok: boolean; error?: string };
}

// -- Sessions / Terminals ----------------------------------------------------

export interface Session {
  instance_id: string;
  kind: 'main' | 'recipe' | 'adhoc' | 'foreign';
  state: 'starting' | 'idle' | 'busy' | 'exited' | 'archived' | 'unknown' | 'running' | 'needs_user_input' | 'foreign';
  provider_id: string | null;
  cli_session_id: string | null;
  recipe_id: string | null;
  label: string;
  started_at: number;
  ended_at: number | null;
  live: boolean;
  queue_depth: number;
  workspace_id: string;
  foreign?: boolean;
}

export interface FetchSessionsResponse {
  items: Session[];
  next_since?: number;
}

export function fetchSessions(opts: { status?: 'all'|'active'|'archived'; since?: number; limit?: number } = {}): Promise<FetchSessionsResponse> {
  const p = new URLSearchParams();
  if (opts.status) p.set('status', opts.status);
  if (opts.since !== undefined) p.set('since', String(opts.since));
  if (opts.limit !== undefined) p.set('limit', String(opts.limit));
  return fetchJson(`/api/sessions${p.toString() ? '?' + p.toString() : ''}`);
}

export interface ResumeSessionResponse {
  ok: true;
  new_instance_id: string;
  session_id: string;
}

export async function resumeSession(instanceId: string): Promise<ResumeSessionResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(instanceId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`resume failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as ResumeSessionResponse;
}
