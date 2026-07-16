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

// -- Questions + replies -----------------------------------------------------

export type InboxQuestionMode = 'single' | 'multi' | 'text';

export interface InboxQuestionOption {
  id: string;
  label: string;
  value?: string;
  /** Agent's recommended choice — highlighted in the UI. */
  isRecommended?: boolean;
  /** Brief tradeoff explanation shown below the label. */
  rationale?: string;
}

export interface InboxQuestionDispatch {
  session_id?: string;
  provider?: string;
  workspace_id?: string;
  workspace_path?: string;
  prompt_template?: string;
}

export interface InboxQuestion {
  /** Stable id within the parent item ("q1", "db", etc.). */
  id: string;
  prompt: string;
  /** Optional short header above the prompt. */
  title?: string;
  mode?: InboxQuestionMode;
  options?: InboxQuestionOption[];
  allow_freeform?: boolean;
  placeholder?: string;
  close_on_answer?: boolean;
  closed?: boolean;
  dispatch?: InboxQuestionDispatch;
}

export type InboxReplyAuthor = 'user' | 'agent';

export interface InboxReplyDispatch {
  mode: 'spawn' | 'dispatch' | 'resume' | 'noop' | 'failed';
  instance_id?: string;
  session_id?: string;
  code?: string;
  error?: string;
}

export interface InboxReplyAnswer {
  question_id: string;
  option_ids?: string[];
  freeform?: string;
  text?: string;
}

export interface InboxReply {
  id: string;
  author: InboxReplyAuthor;
  text: string;
  option_ids?: string[];
  freeform?: string;
  /** Per-question batched answers (multi-question items). */
  answers?: InboxReplyAnswer[];
  /** Follow-up questions on agent-authored replies. */
  questions?: InboxQuestion[];
  attachments?: InboxAttachment[];
  created_at: number;
  dispatch?: InboxReplyDispatch;
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
  /** One or more clickable questions on this item (batch UX). */
  questions?: InboxQuestion[];
  /** Item-level dispatch — used by the always-on freeform reply box. */
  dispatch?: InboxQuestionDispatch;
  /** True when there is unseen agent activity. Cleared on view / mark-read. */
  unread?: boolean;
  replies?: InboxReply[];
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

// -- Inbox reply -------------------------------------------------------------

export interface InboxReplyRequest {
  /** Legacy single-question fields (still accepted for 1-question items). */
  option_ids?: string[];
  text?: string;
  /** Batched per-question answers (multi-question items — one entry per question). */
  answers?: Array<{
    question_id: string;
    option_ids?: string[];
    text?: string;
  }>;
  /** Set false to persist the reply without dispatching to the agent. Default: true. */
  dispatch?: boolean;
}

export interface InboxReplyResponse {
  item: InboxItem;
  reply: InboxReply;
  dispatch?: InboxReplyDispatch | null;
}

export async function postInboxReply(
  id: string,
  body: InboxReplyRequest,
): Promise<InboxReplyResponse> {
  const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`POST /api/inbox/${id}/reply → HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as InboxReplyResponse;
}

/**
 * Mark an inbox item as read (clear the unread flag). The SPA calls this
 * when the user opens the detail panel (auto) or clicks the explicit
 * "Mark as read" button. Idempotent — re-marking a read item is a no-op.
 */
export async function markInboxRead(id: string): Promise<{ item: InboxItem }> {
  const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/mark-read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`POST /api/inbox/${id}/mark-read → HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as { item: InboxItem };
}

export async function markInboxUnread(id: string): Promise<{ item: InboxItem }> {
  const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/mark-unread`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`POST /api/inbox/${id}/mark-unread → HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as { item: InboxItem };
}

// -- Inbox compose (create item + spawn session) ------------------------------

export interface ComposeInboxRequest {
  /** The user's message / prompt for the agent. */
  prompt: string;
  /** Optional title for the inbox item. Defaults to first line of prompt. */
  title?: string;
  /** Agent CLI provider (defaults to server configured). */
  provider?: string;
  /** Labels for the inbox item. */
  labels?: string[];
  /** Base64-encoded images (pasted from clipboard). */
  images?: string[];
  /** If true, save as draft without spawning an agent session. */
  draft?: boolean;
}

export interface ComposeInboxResponse {
  item: InboxItem;
  session: {
    instance_id: string;
    session_id: string;
  } | null;
  image_paths?: string[];
}

export async function composeInboxSession(req: ComposeInboxRequest): Promise<ComposeInboxResponse> {
  const res = await fetch('/api/inbox/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`POST /api/inbox/compose → HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as ComposeInboxResponse;
}

export async function sendInboxDraft(id: string, opts?: { prompt?: string; provider?: string }): Promise<ComposeInboxResponse> {
  const res = await fetch(`/api/inbox/${encodeURIComponent(id)}/send-draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts ?? {}),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`POST /api/inbox/${id}/send-draft → HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as ComposeInboxResponse;
}

// -- Recipes -----------------------------------------------------------------

export type RecipeStepStatus = 'pending' | 'running' | 'validating' | 'done' | 'failed' | 'awaiting_user' | 'skipped';

export type VerdictKind = 'PASS' | 'FAIL' | 'BLOCKED';

/** One declared validation gate on a step. */
export interface ValidationGate {
  name: string;
  mode: string;
  criteria?: string;
}

/** One independent verifier run for a validation-gated step. */
export interface ValidationRound {
  attempt: number;
  gate?: string;
  mode?: string;
  verdict?: VerdictKind;
  evidence?: string;
  gaps?: string;
  started_at?: number;
  decided_at?: number;
  verifier_session_id?: string;
  terminal?: { instance_id: string; cli_session_id?: string };
  error?: string;
}

/** Validation-gate state for a gated step (present only when the step is gated). */
export interface StepValidation {
  mode: string;
  criteria?: string;
  in_progress: boolean;
  attempt: number;
  rework_count: number;
  verifier_session_id?: string;
  latest?: { verdict: VerdictKind; evidence: string; gaps?: string };
  rounds: ValidationRound[];
  gates: ValidationGate[];
  passed_gates: number;
  total_gates: number;
}

export interface RecipeStep {
  id: string;
  /** Short human-readable TL;DR for the UI (≤ 200 chars). */
  title: string;
  /** Full agent-facing prompt; rendered in a collapsible panel. Optional. */
  ai_instructions?: string;
  status: RecipeStepStatus;
  required?: boolean;
  started_at?: number;
  completed_at?: number;
  message?: string;
  awaiting_user_prompt?: string;
  child_recipe_instance_id?: string;
  artifact_id?: string;
  /** Present only when the step is validation-gated. Drives the gate UI. */
  validation?: StepValidation;
  lane?: string;
  terminal?: { instance_id: string; cli_session_id?: string };
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
  /** Human-readable label from the recipe YAML's `name` field. */
  recipe_name?: string | null;
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
  opts: { prompt?: string; keep_instance_id?: boolean } = {},
): Promise<ResumeRecipeResponse> {
  const body: Record<string, unknown> = {};
  if (opts.prompt) body.prompt = opts.prompt;
  if (opts.keep_instance_id) body.keep_instance_id = true;
  const res = await fetch(`/api/recipes/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
  /** Human-readable label provided at registration time. */
  name?: string | null;
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

export interface TriggerScript {
  id: string;
  type: string;
  runtime: 'node' | 'tsx' | 'python' | 'bash' | string;
  path: string | null;
  path_rel: string | null;
  source: string | null;
  found: boolean;
  error: { code: string; message: string } | null;
}

export function fetchTriggerScript(id: string): Promise<TriggerScript> {
  return fetchJson(`/api/triggers/${encodeURIComponent(id)}/script`);
}

export interface FireTriggerResult {
  ok: boolean;
  structuredContent: { fire_id?: string; status?: string; trigger_id?: string } | null;
  content: unknown;
}

export async function fireTrigger(id: string, payload?: unknown): Promise<FireTriggerResult> {
  const res = await fetch(`/api/triggers/${encodeURIComponent(id)}/fire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload === undefined ? {} : { payload }),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === 'object' && 'error' in parsed)
        ? JSON.stringify((parsed as { error: unknown }).error)
        : text || `HTTP ${res.status}`;
    throw new Error(`fireTrigger failed: ${msg}`);
  }
  return parsed as FireTriggerResult;
}

export interface TriggerFireRow {
  fire_id: string;
  source: string;
  status: string;
  attempt: number;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  exit_code: number | null;
  duration_ms: number | null;
  output_dir: string | null;
  error: string | null;
  has_output_dir: boolean;
}

export interface TriggerRunsResponse {
  items: TriggerFireRow[];
  latest: {
    fire_id: string;
    stdout: string | null;
    stderr: string | null;
    stdout_parsed: unknown | null;
  } | null;
}

export function fetchTriggerRuns(id: string, limit = 10): Promise<TriggerRunsResponse> {
  return fetchJson(`/api/triggers/${encodeURIComponent(id)}/runs?limit=${limit}`);
}

// -- Daemons -----------------------------------------------------------------

export type DaemonHealth = 'running' | 'starting' | 'stopped' | 'crashed' | 'down';

export interface DaemonInfo {
  id: string;
  name: string;
  workspace_id: string;
  runtime: string;
  command: string[];
  cwd: string | null;
  enabled: boolean;
  health: DaemonHealth;
  pid: number | null;
  started_at: number | null;
  uptime_ms: number | null;
  restart_count: number;
  last_exit_at: number | null;
  last_error: string | null;
  next_restart_at: number | null;
}

export function fetchDaemons(): Promise<{ items: DaemonInfo[] }> {
  return fetchJson('/api/daemons');
}

export type DaemonAction = 'start' | 'stop' | 'restart';

export async function daemonAction(id: string, action: DaemonAction): Promise<{ ok: boolean; daemon?: DaemonInfo; error?: string }> {
  const res = await fetch(`/api/daemons/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  const text = await res.text();
  let parsed: { ok?: boolean; daemon?: DaemonInfo; error?: string } | null = null;
  try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok || !parsed?.ok) {
    throw new Error(parsed?.error || text || `HTTP ${res.status}`);
  }
  return { ok: true, daemon: parsed.daemon };
}

export function fetchDaemonLogs(id: string, tailBytes = 32_768): Promise<{ run_id: string | null; log_path: string | null; tail: string }> {
  return fetchJson(`/api/daemons/${encodeURIComponent(id)}/logs?tail_bytes=${tailBytes}`);
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

/**
 * Kill the running main agent (if any) and respawn it. Returns the
 * post-restart status. Used by the Main Agent tab's "Restart" button
 * for recovery when the agent has exited (provider binary missing,
 * spawn threw, crash).
 */
export function restartMainAgent(opts: { newSession?: boolean } = {}): Promise<MainAgentStatus> {
  return fetchJson('/api/main-agent/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ new_session: !!opts.newSession }),
  });
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
  state: 'starting' | 'idle' | 'busy' | 'exited' | 'archived' | 'unknown' | 'running' | 'needs_user_input' | 'foreign' | 'thinking' | 'tool_use' | 'waiting' | 'error';
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
  end_reason?: string | null;
  task_title?: string | null;
  subtask_title?: string | null;
  status_text?: string | null;
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

export async function deleteSession(instanceId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`delete session failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

// -- Session side-panel data ------------------------------------------------

export interface SessionArtifact {
  id: string;
  type: string;
  title: string | null;
  recipe_instance_id: string | null;
  recipe_step_id: string | null;
  created_at: number;
  updated_at: number;
}

export async function fetchSessionArtifacts(instanceId: string): Promise<{ items: SessionArtifact[] }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(instanceId)}/artifacts`);
  if (!res.ok) return { items: [] };
  return (await res.json()) as { items: SessionArtifact[] };
}

// -- Cross-workspace artifact index -----------------------------------------
// Powers the top-level Artifacts tab (see ArtifactsTabPanel.vue). One item
// per artifact folder found under CLAWDEVBOX_PROJECT_DIR + every registered
// workspace, sorted by created_at DESC.

export interface AllArtifact {
  id: string;
  type: string;
  title: string | null;
  workspace_id: string;
  workspace_path: string;
  recipe_instance_id: string | null;
  recipe_step_id: string | null;
  created_at: number;
  updated_at: number;
  /** Ready-to-embed viewer URL (`/artifact/<id>`) served by terminal-server. */
  view_url: string;
}

export async function fetchAllArtifacts(): Promise<{ items: AllArtifact[] }> {
  const res = await fetch('/api/artifacts');
  if (!res.ok) return { items: [] };
  return (await res.json()) as { items: AllArtifact[] };
}

export interface ArtifactSession {
  /** The CLI conversation id (cli_session_id) bound to this artifact, if any. */
  session_id: string | null;
  workspace_id: string;
  /** The recipe-instance currently LIVE for this conversation, or null. */
  live_instance_id: string | null;
  /** The recipe-instance that produced the artifact — a stable resume anchor. */
  recipe_instance_id: string | null;
}

/**
 * Resolve the agent session behind an artifact, for the SPA's artifact
 * terminal panel. Returns the live instance to attach to (when running) and
 * the manifest recipe-instance as a resume anchor (when asleep). Served by
 * terminal-server on 5201 — NOT on the 5301 share allow-list, so this is a
 * local-mode-only capability by construction.
 */
export async function fetchArtifactSession(artifactId: string): Promise<ArtifactSession | null> {
  const res = await fetch(`/artifact/${encodeURIComponent(artifactId)}/session`);
  if (!res.ok) return null;
  return (await res.json()) as ArtifactSession;
}

export interface RecipeStepView {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped' | string;
  message?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
}

export interface RecipeInstanceView {
  id: string;
  recipe_id: string;
  status: 'running' | 'success' | 'failure' | 'cancelled' | string;
  steps?: RecipeStepView[];
  workspace_path: string;
  message?: string | null;
}

export async function fetchRecipeInstance(instanceId: string): Promise<RecipeInstanceView | null> {
  const res = await fetch(`/api/recipe-instances/${encodeURIComponent(instanceId)}`);
  if (!res.ok) return null;
  return (await res.json()) as RecipeInstanceView;
}

// -- Spawn / agent CLIs ------------------------------------------------------

export interface SpawnSessionRequest {
  /** First user-style message for the agent. Required, non-empty. */
  prompt: string;
  /** Friendly alias for the session (becomes the canonical GUID's display name). */
  session_id?: string;
  /** Agent CLI id (e.g. 'copilot', 'agency'). Omit to use the server default. */
  provider?: string;
  /** Persona / agent flag passed to the CLI. */
  agent?: string;
  /** Model override (e.g. 'claude-opus-4.7-1m-internal'). */
  model?: string;
  /** Existing workspace id to run in. If both id and path are omitted, a fresh
   *  workspace is auto-created and pinned to the session_id for reuse. */
  workspace_id?: string;
  /** Absolute workspace path. */
  workspace_path?: string;
}

export interface SpawnSessionResponse {
  ok: true;
  mode: 'spawn' | 'dispatch' | 'resume';
  instance_id: string;
  session_id: string;
  session_alias: string | null;
  workspace_id?: string;
  workspace_path?: string;
  state?: 'dispatched';
  resumed_from?: string;
}

export async function spawnSession(req: SpawnSessionRequest): Promise<SpawnSessionResponse> {
  const res = await fetch('/spawn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = (body.error as string | undefined) ?? `spawn failed: HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as unknown as SpawnSessionResponse;
}

export interface AgentCliDetect {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface AgentCliInfo {
  id: string;
  display_name: string;
  description?: string;
  source: string;
  internal: boolean;
  detect: AgentCliDetect;
}

export interface AgentClisResponse {
  configured: string | null;
  providers: AgentCliInfo[];
  errors: unknown[];
}

export function fetchAgentClis(): Promise<AgentClisResponse> {
  return fetchJson<AgentClisResponse>('/api/agent-clis');
}

// -- Library (read-only catalog of templates + memory) -----------------------

export interface LibraryRecipeSummary {
  id: string;
  scope: string;
  name: string;
  description: string;
  step_count: number;
}

export interface LibraryRecipeStep {
  id: string;
  goal: string;
  depends: string[];
  has_ai_instructions: boolean;
  /** Present when the step declares a `validation:` gate. */
  validation?: { gates: ValidationGate[] };
  params?: unknown;
  artifacts?: unknown;
  triggers?: unknown;
}

export interface LibraryRecipeDetail {
  id: string;
  scope: string;
  name: string;
  description: string;
  source: string;
  steps: LibraryRecipeStep[];
  found: boolean;
}

export interface LibrarySkillSummary {
  id: string;
  scope: string;
  name: string;
  description: string;
}

export interface LibrarySkillFile {
  name: string;
  rel: string;
  ext: string;
  size: number;
  is_text: boolean;
  source: string | null;
  truncated: boolean;
}

export interface LibrarySkillDetail {
  id: string;
  scope: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  source: string;
  path_rel: string;
  files: LibrarySkillFile[];
}

export interface LibraryTriggerTemplateSummary {
  id: string;
  scope: string;
  source_plugin_id: string;
  description: string;
  default_cron: string | null;
  accepts_webhook: boolean;
  identity_param: string | null;
  runtime: string;
  param_count: number;
}

export interface LibraryTriggerTemplateScript {
  id: string;
  runtime: string;
  path: string | null;
  path_rel: string | null;
  source: string | null;
  truncated?: boolean;
  found: boolean;
  parameters: Array<{ name: string; type: string; required?: boolean; description?: string; default?: unknown }>;
  description?: string;
  default_cron?: string | null;
  error: { code: string; message: string } | null;
}

export type MemoryDocType = 'fact' | 'lesson' | 'wiki';

export interface LibraryMemorySummary {
  key: string;
  vault_id: string;
  scope: 'personal' | 'team';
  type: MemoryDocType;
  title: string;
  tags: string[];
  created: string | null;
  created_by: string | null;
  category: string | null;
  votes: { up: number; down: number };
  confidence: number | null;
  reinforcement_count: number | null;
  path_rel: string;
}

export interface LibraryMemoryDoc extends LibraryMemorySummary {
  citations: string | null;
  reason: string | null;
  context: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  found: boolean;
}

export function fetchLibraryRecipes(): Promise<{ items: LibraryRecipeSummary[]; count: number }> {
  return fetchJson('/api/library/recipes');
}
export function fetchLibraryRecipe(id: string): Promise<LibraryRecipeDetail> {
  return fetchJson(`/api/library/recipes/${encodeURIComponent(id)}`);
}
export function fetchLibrarySkills(): Promise<{ items: LibrarySkillSummary[]; count: number }> {
  return fetchJson('/api/library/skills');
}
export function fetchLibrarySkill(id: string): Promise<LibrarySkillDetail> {
  return fetchJson(`/api/library/skills/${encodeURIComponent(id)}`);
}
export function fetchLibraryTriggerTemplates(): Promise<{ items: LibraryTriggerTemplateSummary[]; count: number; errors: unknown[] }> {
  return fetchJson('/api/library/trigger-templates');
}
export function fetchLibraryTriggerTemplateScript(id: string): Promise<LibraryTriggerTemplateScript> {
  return fetchJson(`/api/library/trigger-templates/${encodeURIComponent(id)}/script`);
}
export function fetchLibraryMemory(type: MemoryDocType): Promise<{ items: LibraryMemorySummary[]; count: number; type: MemoryDocType }> {
  return fetchJson(`/api/library/memory?type=${encodeURIComponent(type)}`);
}
export function fetchLibraryMemoryDoc(key: string): Promise<LibraryMemoryDoc> {
  return fetchJson(`/api/library/memory/doc?key=${encodeURIComponent(key)}`);
}
