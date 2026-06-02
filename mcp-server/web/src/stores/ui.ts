/**
 * Pinia store — single source of truth for inbox / recipes / agent /
 * tunnel / push state + the list of open artifact tabs. Components watch
 * the parts they care about; the store handles fetching, SSE wiring, and
 * push subscribe/unsubscribe.
 */

import { defineStore } from 'pinia';
import {
  bootstrap,
  fetchAgentStatus,
  fetchApprovals,
  fetchInbox,
  fetchSessions,
  resumeSession,
  deleteSession,
  fetchInboxItem,
  fetchPushStatus,
  fetchPushVapid,
  fetchRecipes,
  fetchTriggers,
  fetchTunnelStatus,
  postInboxArchive,
  postInboxDone,
  postInboxSnooze,
  postInboxState,
  postPushUnsubscribe,
  postRecipeResume,
  type Bootstrap,
  type InboxAttachment,
  type InboxItem,
  type MainAgentStatus,
  type PendingApproval,
  type PushVapidInfo,
  type RecipeInstance,
  type RegisteredTrigger,
  type Session,
  type TunnelStatus,
} from '../api';

export type LiveState = 'live' | 'offline';
export type PushState = 'off' | 'pending' | 'live' | 'error' | 'unknown';

export interface OpenArtifactTab {
  /** Artifact id (the SPA tab key + iframe src segment). */
  id: string;
  /** Optional display title (falls back to the artifact id). */
  title?: string;
  /** Source URL — usually `/artifact/<id>`. */
  url: string;
  /**
   * Where to return when the user clicks the in-panel "back" arrow.
   *   inbox-list — the master-detail Inbox tab with `inboxId` selected.
   *   inbox-tab  — the popped-out `inbox-detail:<inboxId>` tab.
   * Set when the artifact was opened from an inbox attachment click;
   * unset for artifacts opened standalone (e.g. directly via URL).
   */
  returnTo?: { kind: 'inbox-list' | 'inbox-tab'; inboxId: string };
}

export interface OpenInboxTab {
  /** Inbox item id (tab key). */
  id: string;
  /** Display title (falls back to id). */
  title?: string;
}

interface State {
  boot: Bootstrap;
  inbox: InboxItem[];
  inboxLoading: boolean;
  inboxError: string | null;
  /** Body cache keyed by inbox item id. Fetched lazily on tab open. */
  inboxBodies: Record<string, { body: string | null; loading: boolean; error: string | null }>;
  /** Open inbox detail tabs (one per id). */
  inboxTabs: OpenInboxTab[];
  /** Id of the inbox item shown in the master-detail right pane (null = none). */
  selectedInboxId: string | null;
  recipes: RecipeInstance[];
  recipesLoading: boolean;
  recipesError: string | null;
  selectedRecipeId: string | null;
  triggers: RegisteredTrigger[];
  triggersLoading: boolean;
  triggersError: string | null;
  selectedTriggerId: string | null;
  approvals: PendingApproval[];
  agent: MainAgentStatus;
  tunnel: TunnelStatus;
  liveState: LiveState;
  push: {
    state: PushState;
    enabledOnServer: boolean;
    publicKey: string | null;
    permissionDenied: boolean;
    subscribed: boolean;
    hint: string;
    /** Total subscribers across all devices, fetched from /api/push/status. */
    subscriberCount: number;
  };
  artifactTabs: OpenArtifactTab[];
  /** Pane id currently rendered fullscreen, e.g. `inbox-detail:<id>` or `artifact:<id>`. Null = none. */
  fullscreenPaneId: string | null;
  /**
   * Single-shot signal: when set, the InboxPanel should re-open its
   * mobile detail navigation for this id on its next tick. Consumed
   * and cleared by InboxPanel. Used after "back from artifact" on
   * mobile to land the user back in the detail view (not the list).
   */
  pendingMobileDetailRestore: string | null;
  activeTab: string;
  terminals: {
    items: Session[];
    selectedInstanceId: string | null;
    archiveSince: number;
    archiveCursor: number | undefined;
    archiveExpanded: boolean;
    loading: boolean;
  };
}

export const useUiStore = defineStore('ui', {
  state: (): State => ({
    boot: bootstrap(),
    inbox: [],
    inboxLoading: false,
    inboxError: null,
    inboxBodies: {},
    inboxTabs: [],
    selectedInboxId: null,
    recipes: [],
    recipesLoading: false,
    recipesError: null,
    selectedRecipeId: null,
    triggers: [],
    triggersLoading: false,
    triggersError: null,
    selectedTriggerId: null,
    approvals: [],
    agent: { running: false },
    tunnel: { kind: 'none' },
    liveState: 'offline',
    push: {
      state: 'unknown',
      enabledOnServer: false,
      publicKey: null,
      permissionDenied: false,
      subscribed: false,
      hint: '',
      subscriberCount: 0,
    },
    artifactTabs: [],
    fullscreenPaneId: null,
    pendingMobileDetailRestore: null,
    activeTab: 'inbox',
    terminals: {
      items: [],
      selectedInstanceId: null,
      archiveSince: 0,
      archiveCursor: undefined,
      archiveExpanded: false,
      loading: false,
    },
  }),
  getters: {
    pushReady: (s) => s.push.enabledOnServer && !!s.push.publicKey,
    runningRecipes: (s) => s.recipes.filter((r) => r.status === 'running'),
    completedRecipes: (s) => s.recipes.filter((r) => r.status !== 'running'),
  },
  actions: {
    // --- inbox ------------------------------------------------------------
    async refreshInbox(): Promise<void> {
      this.inboxLoading = true;
      try {
        const { items } = await fetchInbox();
        // Invalidate cached body entries whose underlying item changed
        // (updated_at advanced) or disappeared.
        const prevById = new Map(this.inbox.map((it) => [it.id, it.updated_at]));
        const nextById = new Map(items.map((it) => [it.id, it.updated_at]));
        const nextBodies: typeof this.inboxBodies = {};
        for (const [id, entry] of Object.entries(this.inboxBodies)) {
          const prevTs = prevById.get(id);
          const nextTs = nextById.get(id);
          if (nextTs !== undefined && nextTs === prevTs) {
            nextBodies[id] = entry;
          }
        }
        this.inboxBodies = nextBodies;
        this.inbox = items;
        this.inboxError = null;
      } catch (err) {
        this.inboxError = err instanceof Error ? err.message : String(err);
      } finally {
        this.inboxLoading = false;
      }
    },

    /**
     * Fetch the full description body for an inbox item if it has one.
     * Cached per id — re-calling is cheap. If the item has no body,
     * stores `body: null` so the UI can render "no body" once.
     */
    async fetchInboxBody(id: string): Promise<void> {
      const existing = this.inboxBodies[id];
      if (existing && !existing.error) return;
      this.inboxBodies = {
        ...this.inboxBodies,
        [id]: { body: existing?.body ?? null, loading: true, error: null },
      };
      try {
        const { description } = await fetchInboxItem(id);
        this.inboxBodies = {
          ...this.inboxBodies,
          [id]: { body: description, loading: false, error: null },
        };
      } catch (err) {
        this.inboxBodies = {
          ...this.inboxBodies,
          [id]: {
            body: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },

    /**
     * Open an attachment as an artifact SPA tab. Falls through silently
     * if the attachment didn't resolve to a workspace. If a pane is
     * currently fullscreen, exit it so the artifact tab is visible.
     *
     * `from` records the parent context so the artifact tab gets a
     * "← back" button that returns to that view.
     */
    openInboxAttachment(
      attachment: InboxAttachment,
      from?: { kind: 'inbox-list' | 'inbox-tab'; inboxId: string },
    ): void {
      if (!attachment.view_url) return;
      const match = attachment.view_url.match(/^\/artifact\/([A-Za-z0-9._-]+)/);
      if (!match) return;
      if (this.fullscreenPaneId) this.fullscreenPaneId = null;
      this.openArtifact({
        id: attachment.artifact_id,
        title: attachment.title ?? attachment.artifact_id,
        url: attachment.view_url,
        returnTo: from,
      });
    },

    /**
     * Navigate "back" from an artifact tab to its parent inbox view.
     * Behavior depends on the recorded `returnTo`:
     *   inbox-tab  → switch to that popped-out tab if still open,
     *                otherwise fall back to the master-detail.
     *   inbox-list → switch to the Inbox tab + ensure the item is
     *                selected. On mobile, signal the InboxPanel to
     *                re-open the detail view (the list is the default
     *                mobile view when activating the Inbox tab).
     */
    navigateBackFromArtifact(returnTo: NonNullable<OpenArtifactTab['returnTo']>): void {
      // Exit fullscreen if the artifact is fullscreened.
      if (this.fullscreenPaneId) this.fullscreenPaneId = null;
      if (returnTo.kind === 'inbox-tab') {
        if (this.inboxTabs.some((t) => t.id === returnTo.inboxId)) {
          this.activeTab = `inbox-detail:${returnTo.inboxId}`;
          return;
        }
        // Popped-out tab was closed — fall through to inbox-list.
      }
      this.selectedInboxId = returnTo.inboxId;
      this.pendingMobileDetailRestore = returnTo.inboxId;
      this.activeTab = 'inbox';
    },

    /**
     * Select an inbox item for the master-detail right pane (desktop)
     * or for the mobile detail view. Lazily fetches the body.
     */
    selectInboxItem(id: string | null): void {
      this.selectedInboxId = id;
      if (id) {
        const item = this.inbox.find((it) => it.id === id);
        if (item && (item.description_size ?? 0) > 0) {
          this.fetchInboxBody(id);
        }
      }
    },

    /**
     * Open an inbox item as a dedicated SPA tab (pop-out). Multiple
     * items can be open simultaneously. The same component is used
     * here and in the master-detail right pane — they share the body
     * cache and the lifecycle store.
     */
    popOutInbox(id: string, title?: string): void {
      if (!this.inboxTabs.some((t) => t.id === id)) {
        this.inboxTabs.push({ id, title });
      }
      this.activeTab = `inbox-detail:${id}`;
      const item = this.inbox.find((it) => it.id === id);
      if (item && (item.description_size ?? 0) > 0) {
        this.fetchInboxBody(id);
      }
    },
    closeInboxTab(id: string): void {
      this.inboxTabs = this.inboxTabs.filter((t) => t.id !== id);
      // If we're closing the active tab, fall back to the Inbox list.
      if (this.activeTab === `inbox-detail:${id}`) this.activeTab = 'inbox';
      // If this pane was fullscreen, exit fullscreen.
      if (this.fullscreenPaneId === `inbox-detail:${id}`) this.fullscreenPaneId = null;
    },

    /**
     * Lifecycle actions. After a state change, auto-advance the
     * master-detail selection to the next item in the current sort
     * order (rubber-duck recommendation): better triage UX than
     * leaving the user on a "done" item or an empty pane.
     */
    async _runInboxAction(
      id: string,
      run: () => Promise<{ item: InboxItem }>,
      opts: { advance?: boolean } = {},
    ): Promise<void> {
      const advance = opts.advance ?? true;
      // Capture neighbours BEFORE the action — the SSE refresh may
      // reorder/filter the list afterward.
      let nextId: string | null = null;
      if (advance && this.selectedInboxId === id) {
        const idx = this.inbox.findIndex((it) => it.id === id);
        if (idx >= 0) {
          nextId = this.inbox[idx + 1]?.id ?? this.inbox[idx - 1]?.id ?? null;
        }
      }
      try {
        await run();
      } catch (err) {
        // Surface via a toast? For now, log + set inboxError so the
        // user gets visible feedback.
        const message = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error('inbox action failed:', message);
        this.inboxError = message;
        return;
      }
      // Refresh the list (SSE will also trigger this, but explicitly
      // doing it here means the UI updates synchronously).
      await this.refreshInbox();
      if (advance && this.selectedInboxId === id) {
        this.selectInboxItem(nextId);
      }
    },

    async markInboxDone(id: string): Promise<void> {
      await this._runInboxAction(id, () => postInboxDone(id));
    },
    async archiveInbox(id: string): Promise<void> {
      await this._runInboxAction(id, () => postInboxArchive(id));
    },
    async snoozeInbox(id: string, until: number): Promise<void> {
      await this._runInboxAction(id, () => postInboxSnooze(id, until));
    },
    async reopenInbox(id: string): Promise<void> {
      // "Reopen" = back to 'open'. We don't auto-advance here — the
      // user explicitly wants to re-engage with this item.
      await this._runInboxAction(id, () => postInboxState(id, 'open'), { advance: false });
    },

    // --- recipes ----------------------------------------------------------
    async refreshRecipes(): Promise<void> {
      this.recipesLoading = true;
      try {
        const { items } = await fetchRecipes();
        this.recipes = items;
        this.recipesError = null;
      } catch (err) {
        this.recipesError = err instanceof Error ? err.message : String(err);
      } finally {
        this.recipesLoading = false;
      }
    },
    selectRecipe(id: string | null): void {
      this.selectedRecipeId = id;
    },

    /**
     * Resume a recipe instance — POST /api/recipes/:id/resume. Refreshes
     * the recipes list afterward, selects the new instance, and opens
     * its live terminal tab so the user lands directly in the
     * interactive xterm session (real CLIs like copilot/claude are spawned
     * without -p so the resumed session is interactive).
     */
    async resumeRecipe(id: string, prompt?: string): Promise<void> {
      try {
        const r = await postRecipeResume(id, prompt);
        await this.refreshRecipes();
        this.selectedRecipeId = r.new_recipe_instance_id;
        // Land the user in the live terminal so they can interact.
        // Skip for echo-stub since the script is non-interactive and the
        // terminal will only show a banner before exit.
        if (r.agent_cli !== 'echo-stub') {
          this.openArtifact({
            id: `term-${r.new_recipe_instance_id}`,
            title: `Terminal · ${r.agent_cli}`,
            url: `/terminal/${encodeURIComponent(r.new_recipe_instance_id)}`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.recipesError = message;
      }
    },

    // --- triggers ---------------------------------------------------------
    async refreshTriggers(): Promise<void> {
      this.triggersLoading = true;
      try {
        const { items } = await fetchTriggers();
        this.triggers = items;
        this.triggersError = null;
      } catch (err) {
        this.triggersError = err instanceof Error ? err.message : String(err);
      } finally {
        this.triggersLoading = false;
      }
    },
    selectTrigger(id: string | null): void {
      this.selectedTriggerId = id;
    },

    // --- approvals --------------------------------------------------------
    async refreshApprovals(): Promise<void> {
      try {
        const { items } = await fetchApprovals();
        this.approvals = items;
      } catch {
        this.approvals = [];
      }
    },

    // --- agent ------------------------------------------------------------
    async refreshAgent(): Promise<void> {
      try {
        this.agent = await fetchAgentStatus();
      } catch {
        this.agent = { running: false };
      }
    },

    // --- tunnel -----------------------------------------------------------
    async refreshTunnel(): Promise<void> {
      try {
        this.tunnel = await fetchTunnelStatus();
      } catch {
        this.tunnel = { kind: 'none', error: 'status unavailable' };
      }
    },

    // --- push -------------------------------------------------------------
    async refreshPush(): Promise<void> {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        this.push.state = 'off';
        this.push.hint = 'Push not supported in this browser.';
        return;
      }
      let v: PushVapidInfo;
      try {
        v = await fetchPushVapid();
      } catch {
        this.push.state = 'error';
        this.push.hint = 'Server unreachable.';
        return;
      }
      this.push.enabledOnServer = !!v.enabled;
      this.push.publicKey = v.publicKey ?? null;
      if (!v.enabled) {
        this.push.state = 'off';
        this.push.hint = 'Disabled in config. Re-run `clawdevbox init` to enable.';
        return;
      }
      this.push.permissionDenied = Notification.permission === 'denied';
      if (this.push.permissionDenied) {
        this.push.state = 'error';
        this.push.hint = 'Permission denied. Re-enable in browser site settings.';
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      this.push.subscribed = !!sub;

      // Server-side subscriber count is independent of this device's state.
      try {
        const st = await fetchPushStatus();
        this.push.subscriberCount = st.subscriptions.length;
      } catch {
        this.push.subscriberCount = 0;
      }

      if (sub) {
        this.push.state = 'live';
        this.push.hint = `This device is subscribed. ${this.push.subscriberCount} device(s) total.`;
      } else {
        this.push.state = 'pending';
        const total = this.push.subscriberCount;
        const totalHint = total === 0 ? 'No devices subscribed yet.' : `${total} other device(s) subscribed.`;
        this.push.hint = `${totalHint} Tap Enable to subscribe this device.`;
      }
    },

    async subscribePush(): Promise<void> {
      if (!this.pushReady) {
        this.push.state = 'error';
        this.push.hint = 'Push not ready: server has no VAPID keys.';
        return;
      }
      // iOS Safari refuses pushManager.subscribe unless the page is running
      // as an installed PWA (Add to Home Screen). Detect up-front and tell
      // the user *before* the API throws a useless "NotAllowedError".
      if (this.isIosWebPushBlocked()) {
        this.push.state = 'error';
        this.push.hint =
          'iOS push requires installing the page to your home screen first. Tap Share → Add to Home Screen, then open the app from the icon and try again.';
        return;
      }
      try {
        if (Notification.permission !== 'granted') {
          const granted = await Notification.requestPermission();
          if (granted !== 'granted') {
            this.push.state = 'error';
            this.push.hint = `Permission ${granted}. Re-enable in your browser's site settings.`;
            await this.refreshPush();
            return;
          }
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(this.push.publicKey!) as unknown as BufferSource,
        });
        const subscribeRes = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: sub.toJSON().endpoint,
            keys: sub.toJSON().keys,
            label: navigator.userAgent.slice(0, 80),
          }),
        });
        if (!subscribeRes.ok) {
          const txt = await subscribeRes.text().catch(() => '');
          throw new Error(`server rejected subscription (HTTP ${subscribeRes.status}) ${txt.slice(0, 200)}`);
        }
        await this.refreshPush();
      } catch (err) {
        this.push.state = 'error';
        this.push.hint = `Subscribe failed: ${err instanceof Error ? err.message : String(err)}`;
        // Log a structured warning so devtools shows the real stack.
        // eslint-disable-next-line no-console
        console.warn('[push] subscribe failed', err);
      }
    },

    /**
     * iOS Safari 16+ supports Web Push but ONLY when the page is launched
     * as an installed home-screen PWA (`display-mode: standalone`). In a
     * regular browser tab `pushManager.subscribe` throws `NotAllowedError`.
     * Other platforms have no such restriction.
     */
    isIosWebPushBlocked(): boolean {
      try {
        const ua = navigator.userAgent || '';
        const isIos = /iPhone|iPad|iPod/.test(ua) && !(window as Window & { MSStream?: unknown }).MSStream;
        if (!isIos) return false;
        const standalone =
          (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true;
        return !standalone;
      } catch {
        return false;
      }
    },

    async unsubscribePush(): Promise<void> {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        try { await sub.unsubscribe(); } catch { /* ignore */ }
        await postPushUnsubscribe(endpoint);
      }
      await this.refreshPush();
    },

    async testPush(): Promise<string> {
      // The server-side endpoint always returns the web-push delivery
      // stats. When `attempted === 0`, the click looked like it worked
      // but nothing actually went out — surface that explicitly so the
      // user knows their device isn't really subscribed.
      try {
        const res = await fetch('/api/push/test', { method: 'POST' });
        const body = (await res.json()) as {
          attempted?: number;
          delivered?: number;
          pruned?: number;
          errors?: unknown[];
          error?: string;
        };
        if (!res.ok || body.error) {
          return `Test failed: ${body.error ?? `HTTP ${res.status}`}`;
        }
        const attempted = body.attempted ?? 0;
        const delivered = body.delivered ?? 0;
        if (attempted === 0) {
          return 'No subscribed devices on this server. Tap Enable to subscribe this device.';
        }
        if (delivered === 0) {
          return `Sent to ${attempted} device(s) but 0 delivered. Push service rejected them — likely stale subscription. Try Disable + Enable.`;
        }
        return `Test push sent to ${delivered}/${attempted} device(s).`;
      } catch (err) {
        return `Test failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },

    // --- artifact tabs ----------------------------------------------------
    openArtifact(tab: OpenArtifactTab): void {
      if (!this.artifactTabs.some((t) => t.id === tab.id)) {
        this.artifactTabs.push(tab);
      }
      this.activeTab = `artifact:${tab.id}`;
    },
    closeArtifact(id: string): void {
      this.artifactTabs = this.artifactTabs.filter((t) => t.id !== id);
      if (this.activeTab === `artifact:${id}`) this.activeTab = 'inbox';
    },
    setActiveTab(key: string): void {
      this.activeTab = key;
    },

    // --- terminals --------------------------------------------------------
    async refreshTerminals(opts: { status?: 'all'|'active'|'archived'; since?: number } = {}): Promise<void> {
      this.terminals.loading = true;
      try {
        const status = opts.status ?? (this.terminals.archiveExpanded ? 'all' : 'all');
        const res = await fetchSessions({ status, since: opts.since, limit: 50 });
        // For an "active-only" refresh (e.g. from a 'sessions' topic event),
        // merge: replace live entries, keep archived as-is.
        if (status === 'active') {
          const archived = this.terminals.items.filter((i) => !i.live);
          this.terminals.items = [...res.items, ...archived];
        } else {
          this.terminals.items = res.items;
          this.terminals.archiveCursor = res.next_since;
        }
        if (!this.terminals.selectedInstanceId && this.terminals.items.length > 0) {
          // Prefer main, else first live, else first overall.
          const main = this.terminals.items.find((i) => i.instance_id === 'main');
          const firstLive = this.terminals.items.find((i) => i.live);
          this.terminals.selectedInstanceId = (main ?? firstLive ?? this.terminals.items[0]!).instance_id;
        }
      } finally {
        this.terminals.loading = false;
      }
    },

    selectTerminal(instanceId: string): void {
      this.terminals.selectedInstanceId = instanceId;
    },

    async resumeTerminal(instanceId: string): Promise<void> {
      const r = await resumeSession(instanceId);
      this.terminals.selectedInstanceId = r.new_instance_id;
      // Optimistic — the 'sessions' topic event will refresh authoritatively.
      await this.refreshTerminals({ status: 'all' });
    },

    async killTerminal(instanceId: string): Promise<void> {
      await deleteSession(instanceId);
      if (this.terminals.selectedInstanceId === instanceId) {
        this.terminals.selectedInstanceId = null;
      }
      this.terminals.items = this.terminals.items.filter((i) => i.instance_id !== instanceId);
      // Authoritative refresh so state dot, archive sections all stay correct.
      await this.refreshTerminals({ status: 'all' });
    },

    async loadMoreArchive(): Promise<void> {
      if (!this.terminals.archiveCursor) return;
      const res = await fetchSessions({ status: 'archived', since: this.terminals.archiveCursor, limit: 50 });
      // Append (archive is sorted desc; older items go to the end).
      this.terminals.items = [...this.terminals.items, ...res.items];
      this.terminals.archiveCursor = res.next_since;
    },

    // --- realtime ---------------------------------------------------------
    setLive(state: LiveState): void {
      this.liveState = state;
    },
  },
});

/**
 * Decode a base64url-encoded VAPID public key into the Uint8Array
 * `PushManager.subscribe()` expects.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
