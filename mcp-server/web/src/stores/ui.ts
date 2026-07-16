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
  spawnSession,
  fetchInboxItem,
  fetchPushStatus,
  fetchPushVapid,
  fetchRecipes,
  fetchTriggers,
  fetchTunnelStatus,
  postInboxArchive,
  postInboxDone,
  postInboxReply,
  postInboxSnooze,
  postInboxState,
  postPushUnsubscribe,
  postRecipeResume,
  markInboxRead,
  markInboxUnread,
  type Bootstrap,
  type InboxAttachment,
  type InboxItem,
  type InboxReplyRequest,
  type InboxReplyResponse,
  type MainAgentStatus,
  type PendingApproval,
  type PushVapidInfo,
  type RecipeInstance,
  type RegisteredTrigger,
  type Session,
  type SpawnSessionRequest,
  type SpawnSessionResponse,
  type TunnelStatus,
} from '../api';
import { router, pathForTab } from '../router';

/**
 * Navigate to a tab/selection only if the URL would actually change.
 * Prevents feedback loops between route → store → route updates that
 * fire when a route change is what triggered the store mutation in the
 * first place.
 */
function navigateIfChanged(tab: string, itemId?: string | null): void {
  const target = pathForTab(tab, itemId);
  const current = router.currentRoute.value.fullPath;
  if (current === target) return;
  // `catch` swallows the redundant-navigation rejection vue-router
  // throws when two pushes for the same path race each other; we don't
  // want a Promise rejection turning into an unhandled console error.
  void router.push(target).catch(() => { /* ignore navigation aborts */ });
}

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

/**
 * In-context subtab inside a RecipeDetailPanel. Three flavours:
 *   - `artifact` — renders the artifact iframe inline.
 *   - `inbox`    — renders a full <InboxDetailPanel> inline so the user
 *                  can read the inbox item / reply / open its
 *                  attachments without leaving the recipe context.
 *   - `terminal` — renders the `/terminal/<instance_id>?embed=1` page
 *                  inline so the user can attach to the live tmux pane
 *                  (or read the archived log) without losing the
 *                  recipe context.
 *
 * The `id` is the tab key; for artifacts/inbox it doubles as the
 * artifact/inbox-item id, for terminals it's the recipe-instance id of
 * the run we're viewing (the same one or a freshly-resumed child).
 */
export type OpenRecipeSubtab =
  | { kind: 'artifact'; id: string; title: string; url: string }
  | { kind: 'inbox'; id: string; title: string }
  | { kind: 'terminal'; id: string; title: string; url: string };

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
  /**
   * "Unread only" toggle for the inbox list rail. Lifted into the store
   * (instead of living as a local ref in InboxListRail) so the master
   * pane can auto-deselect items that get filtered out — e.g. when the
   * currently-selected item is marked read while the filter is active,
   * the detail pane should clear instead of continuing to show the
   * now-filtered-out item.
   *
   * Persisted in localStorage under `clawdevbox.inbox.unreadOnly`.
   */
  inboxShowUnreadOnly: boolean;
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
  /**
   * Currently-active artifact subtab inside the Artifacts tab. `null`
   * = the cross-workspace list view; otherwise an entry id in
   * `artifactTabs`. Opening / closing subtabs mutates BOTH this and
   * `artifactTabs`; components read this to decide what to render
   * inside <ArtifactsTabPanel>.
   */
  activeArtifactSubtab: string | null;
  /**
   * Per-inbox artifact subtabs. Each inbox item has its own list of
   * artifact subtabs that render inside the inbox detail panel (instead
   * of opening top-level tabs that lose context). Keyed by inbox item id.
   * `active` tracks which subtab is currently visible for that item;
   * `null` = the inbox item content view, otherwise an artifact id.
   */
  inboxArtifactSubtabs: Record<string, {
    tabs: OpenArtifactTab[];
    active: string | null;  // null = "Item" content view; otherwise artifact id
  }>;
  /**
   * Per-recipe subtabs (mirror of inboxArtifactSubtabs, but each tab
   * can be either an ARTIFACT (rendered as iframe) or an INBOX ITEM
   * (rendered as <InboxDetailPanel> inline). Keyed by recipe instance id.
   * `active` is null → the "Steps" content view, otherwise a tab id.
   *
   * Lets the user open a step's artifact OR a recipe-linked inbox item
   * IN-CONTEXT inside the recipe detail panel without losing the
   * stepper / awaiting-user banner / metadata they were just looking at.
   */
  recipeSubtabs: Record<string, {
    tabs: OpenRecipeSubtab[];
    active: string | null;  // null = "Steps" view, else tab.id
  }>;
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
  /** Which Library sub-section is active (recipes|skills|triggers|facts|lessons|wiki). */
  activeLibrarySection: string;
  /** Global compose-to-agent dialog (Ctrl+Shift+Q). */
  composeDialogOpen: boolean;
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
    inboxShowUnreadOnly: ((): boolean => {
      try { return localStorage.getItem('clawdevbox.inbox.unreadOnly') === '1'; } catch { return false; }
    })(),
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
    activeArtifactSubtab: null,
    inboxArtifactSubtabs: {},
    recipeSubtabs: {},
    fullscreenPaneId: null,
    pendingMobileDetailRestore: null,
    activeTab: 'main-agent',
    activeLibrarySection: ((): string => {
      try { return localStorage.getItem('clawdevbox.library.section') || 'recipes'; } catch { return 'recipes'; }
    })(),
    composeDialogOpen: false,
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
    unreadInboxCount: (s) => s.inbox.filter((it) => it.unread === true).length,
    waitingRecipesCount: (s) => s.recipes.filter((r) => r.progress && r.progress.awaiting_user_count > 0).length,
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
     *
     * **Use `openInboxAttachmentInline` instead** when the user is in
     * the inbox detail panel and the artifact should appear as a subtab
     * within that panel (in-context view). This top-level-tab variant is
     * kept for non-inbox callers (recipe steps, etc).
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
     * Open an inbox attachment as a SUBTAB within the inbox detail panel.
     * Adds the artifact to the per-inbox subtabs list and activates it.
     * Re-opening the same attachment is idempotent (just activates the
     * existing subtab). Persists across inbox-item navigation — clicking
     * back to this item later restores the subtab state.
     */
    openInboxAttachmentInline(
      attachment: InboxAttachment,
      inboxId: string,
    ): void {
      if (!attachment.view_url) return;
      const match = attachment.view_url.match(/^\/artifact\/([A-Za-z0-9._-]+)/);
      if (!match) return;
      const entry = this.inboxArtifactSubtabs[inboxId] ?? { tabs: [], active: null };
      if (!entry.tabs.some((t) => t.id === attachment.artifact_id)) {
        entry.tabs = [...entry.tabs, {
          id: attachment.artifact_id,
          title: attachment.title ?? attachment.artifact_id,
          url: attachment.view_url,
        }];
      }
      entry.active = attachment.artifact_id;
      this.inboxArtifactSubtabs = { ...this.inboxArtifactSubtabs, [inboxId]: entry };
    },

    /** Close an inbox artifact subtab. If it was active, fall back to "Item". */
    closeInboxArtifactSubtab(inboxId: string, artifactId: string): void {
      const entry = this.inboxArtifactSubtabs[inboxId];
      if (!entry) return;
      const tabs = entry.tabs.filter((t) => t.id !== artifactId);
      const active = entry.active === artifactId ? null : entry.active;
      this.inboxArtifactSubtabs = {
        ...this.inboxArtifactSubtabs,
        [inboxId]: { tabs, active },
      };
    },

    /** Switch the active subtab for an inbox item. `null` = "Item" content view. */
    setActiveInboxSubtab(inboxId: string, active: string | null): void {
      const entry = this.inboxArtifactSubtabs[inboxId] ?? { tabs: [], active: null };
      this.inboxArtifactSubtabs = {
        ...this.inboxArtifactSubtabs,
        [inboxId]: { ...entry, active },
      };
    },

    // -----------------------------------------------------------------
    // Recipe subtabs — analogous to inbox subtabs above. Each recipe
    // owns a list of "open" subtabs (artifact iframes or inline inbox
    // panels) that render inside RecipeDetailPanel. Opening the same
    // subtab twice is idempotent; closing an active subtab falls back
    // to the "Steps" view (`active = null`).
    // -----------------------------------------------------------------

    /** Open an artifact as a subtab inside the recipe detail panel. */
    openRecipeArtifactInline(
      recipeId: string,
      artifactId: string,
      title?: string,
    ): void {
      const entry = this.recipeSubtabs[recipeId] ?? { tabs: [], active: null };
      if (!entry.tabs.some((t) => t.id === artifactId)) {
        entry.tabs = [
          ...entry.tabs,
          {
            kind: 'artifact',
            id: artifactId,
            title: title ?? artifactId,
            url: `/artifact/${encodeURIComponent(artifactId)}`,
          },
        ];
      }
      entry.active = artifactId;
      this.recipeSubtabs = { ...this.recipeSubtabs, [recipeId]: entry };
    },

    /** Open an inbox item as a subtab inside the recipe detail panel. */
    openRecipeInboxInline(
      recipeId: string,
      inboxId: string,
      title?: string,
    ): void {
      const entry = this.recipeSubtabs[recipeId] ?? { tabs: [], active: null };
      if (!entry.tabs.some((t) => t.id === inboxId)) {
        entry.tabs = [
          ...entry.tabs,
          { kind: 'inbox', id: inboxId, title: title ?? inboxId },
        ];
      }
      entry.active = inboxId;
      this.recipeSubtabs = { ...this.recipeSubtabs, [recipeId]: entry };
      // Auto-fetch body (same path selectInboxItem takes) so the
      // inline InboxDetailPanel doesn't render with "Loading body…"
      // forever — the master-detail Inbox tab triggers a fetch on
      // selectInboxItem, but inline subtabs bypass that flow.
      const item = this.inbox.find((it) => it.id === inboxId);
      if (item && (item.description_size ?? 0) > 0) {
        this.fetchInboxBody(inboxId);
      }
    },

    /** Open the live xterm viewer for a recipe instance as an inline subtab. */
    openRecipeTerminalInline(
      recipeId: string,
      terminalInstanceId: string,
      title?: string,
    ): void {
      // Tab id is prefixed so it can never collide with an artifact id
      // (which we want to allow opening alongside it).
      const tabId = `term-${terminalInstanceId}`;
      const entry = this.recipeSubtabs[recipeId] ?? { tabs: [], active: null };
      // `?embed=1` strips the terminal-server page's chrome so the
      // recipe panel's own header isn't duplicated. A monotonic `&_=ts`
      // nonce forces the iframe to refetch on every open — without it,
      // re-clicking Terminal after a reattach would reuse the stale
      // 'session has exited' iframe instead of attaching to the fresh
      // live pty we just spawned.
      const url = `/terminal/${encodeURIComponent(terminalInstanceId)}?embed=1&_=${Date.now()}`;
      const existing = entry.tabs.find((t) => t.id === tabId);
      if (existing && existing.kind === 'terminal') {
        // Re-opening: update the URL so the iframe reloads.
        entry.tabs = entry.tabs.map((t) =>
          t.id === tabId && t.kind === 'terminal' ? { ...t, url, title: title ?? t.title } : t,
        );
      } else {
        entry.tabs = [
          ...entry.tabs,
          { kind: 'terminal', id: tabId, title: title ?? 'Terminal', url },
        ];
      }
      entry.active = tabId;
      this.recipeSubtabs = { ...this.recipeSubtabs, [recipeId]: entry };
    },

    /** Close a recipe subtab. If it was active, fall back to "Steps". */
    closeRecipeSubtab(recipeId: string, subtabId: string): void {
      const entry = this.recipeSubtabs[recipeId];
      if (!entry) return;
      const tabs = entry.tabs.filter((t) => t.id !== subtabId);
      const active = entry.active === subtabId ? null : entry.active;
      this.recipeSubtabs = {
        ...this.recipeSubtabs,
        [recipeId]: { tabs, active },
      };
    },

    /** Switch the active recipe subtab. `null` = "Steps" content view. */
    setActiveRecipeSubtab(recipeId: string, active: string | null): void {
      const entry = this.recipeSubtabs[recipeId] ?? { tabs: [], active: null };
      this.recipeSubtabs = {
        ...this.recipeSubtabs,
        [recipeId]: { ...entry, active },
      };
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
          navigateIfChanged(this.activeTab);
          return;
        }
        // Popped-out tab was closed — fall through to inbox-list.
      }
      this.selectedInboxId = returnTo.inboxId;
      this.pendingMobileDetailRestore = returnTo.inboxId;
      this.activeTab = 'inbox';
      navigateIfChanged('inbox', returnTo.inboxId);
    },

    /**
     * Select an inbox item for the master-detail right pane (desktop)
     * or for the mobile detail view. Lazily fetches the body. Updates
     * the URL to /inbox/<id> (or /inbox when id is null) so the
     * selection is shareable / browser-back-able.
     */
    selectInboxItem(id: string | null): void {
      this.selectedInboxId = id;
      if (id) {
        const item = this.inbox.find((it) => it.id === id);
        if (item && (item.description_size ?? 0) > 0) {
          this.fetchInboxBody(id);
        }
      }
      // Only re-route when the inbox tab is the active one — leaves
      // the URL alone if the user is, say, replying from a popped-out
      // tab or another panel that internally select()s an item.
      if (this.activeTab === 'inbox') {
        navigateIfChanged('inbox', id);
      }
    },

    /**
     * Toggle/persist the inbox "unread only" filter. Lives in the
     * store (not in InboxListRail) so master-detail selection can
     * react when the filter hides the currently-selected item.
     */
    setInboxShowUnreadOnly(value: boolean): void {
      this.inboxShowUnreadOnly = value;
      try { localStorage.setItem('clawdevbox.inbox.unreadOnly', value ? '1' : '0'); } catch { /* ignore */ }
      // When toggling the filter ON, deselect if the current item is already read.
      if (value && this.selectedInboxId) {
        const item = this.inbox.find((it) => it.id === this.selectedInboxId);
        if (item && !item.unread) {
          this.selectedInboxId = null;
          navigateIfChanged('inbox', null);
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
      navigateIfChanged(this.activeTab);
      const item = this.inbox.find((it) => it.id === id);
      if (item && (item.description_size ?? 0) > 0) {
        this.fetchInboxBody(id);
      }
    },
    closeInboxTab(id: string): void {
      this.inboxTabs = this.inboxTabs.filter((t) => t.id !== id);
      // If we're closing the active tab, fall back to the Inbox list.
      if (this.activeTab === `inbox-detail:${id}`) {
        this.activeTab = 'inbox';
        navigateIfChanged('inbox', this.selectedInboxId);
      }
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

    /**
     * Submit a reply to an inbox question (clickable options + freeform).
     * The server validates + dispatches to the agent via spawnDispatchOrResume
     * and persists the reply on the item. Refreshes the list afterward so the
     * chain is visible immediately (SSE will also fire a refresh).
     */
    async submitInboxReply(id: string, body: InboxReplyRequest): Promise<InboxReplyResponse> {
      const result = await postInboxReply(id, body);
      // Optimistically replace the in-memory item so the reply bubble renders
      // before the SSE refresh round-trips.
      const idx = this.inbox.findIndex((it) => it.id === id);
      if (idx >= 0) {
        this.inbox = [
          ...this.inbox.slice(0, idx),
          result.item,
          ...this.inbox.slice(idx + 1),
        ];
      }
      // Fire-and-forget refresh — keeps the list in sync with the server.
      void this.refreshInbox();
      return result;
    },

    /**
     * Mark an inbox item as read (clear the unread flag). Idempotent.
     * Called automatically when the user opens the detail panel + on
     * explicit "Mark as read" button. Optimistically updates the local
     * `unread` flag so the badge clears immediately.
     */
    async markInboxItemRead(id: string): Promise<void> {
      const idx = this.inbox.findIndex((it) => it.id === id);
      if (idx >= 0 && this.inbox[idx].unread !== true) return; // already read
      // Optimistic clear.
      if (idx >= 0) {
        const updated = { ...this.inbox[idx], unread: false };
        this.inbox = [...this.inbox.slice(0, idx), updated, ...this.inbox.slice(idx + 1)];
      }
      try {
        await markInboxRead(id);
      } catch (err) {
        // Rollback on failure; surface as a transient note (don't block UX).
        console.warn('markInboxRead failed; rolling back optimistic clear:', err);
        if (idx >= 0) {
          const reverted = { ...this.inbox[idx], unread: true };
          this.inbox = [...this.inbox.slice(0, idx), reverted, ...this.inbox.slice(idx + 1)];
        }
      }
    },

    /**
     * Mark an inbox item as unread. Optimistically sets the local flag
     * so the badge updates immediately.
     */
    async markInboxItemUnread(id: string): Promise<void> {
      const idx = this.inbox.findIndex((it) => it.id === id);
      if (idx >= 0 && this.inbox[idx].unread === true) return; // already unread
      if (idx >= 0) {
        const updated = { ...this.inbox[idx], unread: true };
        this.inbox = [...this.inbox.slice(0, idx), updated, ...this.inbox.slice(idx + 1)];
      }
      try {
        await markInboxUnread(id);
      } catch (err) {
        console.warn('markInboxUnread failed; rolling back:', err);
        if (idx >= 0) {
          const reverted = { ...this.inbox[idx], unread: false };
          this.inbox = [...this.inbox.slice(0, idx), reverted, ...this.inbox.slice(idx + 1)];
        }
      }
    },

    // --- recipes ----------------------------------------------------------
    async refreshRecipes(): Promise<void> {
      this.recipesLoading = true;
      try {
        const { items } = await fetchRecipes();
        // Show recipes that have steps — regardless of whether they're template-backed
        // or inline (adhoc). The step count is the quality signal, not the recipe_id prefix.
        this.recipes = items.filter((r) => r.progress && r.progress.total_steps > 0);
        this.recipesError = null;
      } catch (err) {
        this.recipesError = err instanceof Error ? err.message : String(err);
      } finally {
        this.recipesLoading = false;
      }
    },
    selectRecipe(id: string | null): void {
      this.selectedRecipeId = id;
      if (this.activeTab === 'recipes') {
        navigateIfChanged('recipes', id);
      }
    },

    /**
     * Re-attach to a recipe's agent CLI session.
     *
     * Per user feedback, this is the ONE-click "Terminal" action: don't
     * spawn a new recipe row, don't navigate, just spawn a fresh agent
     * process with `--resume <session_id>` bound to the SAME
     * recipe-instance row. The DB upserts the row back to status=running
     * + adds a new agent_sessions entry under the same instance_id.
     *
     * Returns the resumed instance id (always equal to the input id when
     * keep_instance_id is honored — the SPA opens its inline Terminal
     * subtab against that id). Throws on failure so the caller can fall
     * back to opening whatever archived terminal log exists.
     */
    async reattachRecipe(id: string): Promise<string> {
      const r = await postRecipeResume(id, { keep_instance_id: true });
      await this.refreshRecipes();
      // selectedRecipeId stays where it was — caller is already viewing
      // the recipe it asked to reattach, and we don't want to disrupt
      // its master-detail position.
      return r.new_recipe_instance_id;
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
      if (this.activeTab === 'triggers') {
        navigateIfChanged('triggers', id);
      }
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
    /**
     * Open an artifact as a SUBTAB inside the top-level Artifacts panel.
     * Adds to `artifactTabs` (idempotent), makes it the active subtab,
     * routes to /artifacts/<id>. Does NOT create a pinned side-nav tab —
     * the artifact only lives inside the Artifacts pane.
     */
    openArtifact(tab: OpenArtifactTab): void {
      if (!this.artifactTabs.some((t) => t.id === tab.id)) {
        this.artifactTabs.push(tab);
      }
      this.activeArtifactSubtab = tab.id;
      this.activeTab = 'artifacts';
      navigateIfChanged('artifacts', tab.id);
    },
    /**
     * Close an artifact subtab. If it was the active one, fall back to
     * the "All Artifacts" list view (activeArtifactSubtab = null).
     */
    closeArtifact(id: string): void {
      this.artifactTabs = this.artifactTabs.filter((t) => t.id !== id);
      if (this.activeArtifactSubtab === id) {
        this.activeArtifactSubtab = null;
        if (this.activeTab === 'artifacts') {
          navigateIfChanged('artifacts');
        }
      }
    },
    /**
     * Switch the active subtab inside the Artifacts panel. `null`
     * activates the "All Artifacts" list view. Adding the artifact
     * to `artifactTabs` is the caller's responsibility (via
     * `openArtifact`) — this action just switches which subtab is
     * currently rendered.
     */
    setActiveArtifactSubtab(id: string | null): void {
      this.activeArtifactSubtab = id;
      if (this.activeTab === 'artifacts') {
        navigateIfChanged('artifacts', id ?? undefined);
      }
    },
    setActiveTab(key: string): void {
      this.activeTab = key;
      // For main tabs, carry over the current item selection into the
      // URL so /inbox restores /inbox/<id> when the user toggles back
      // to it. For pop-out/artifact tab keys, the key itself carries
      // the id and pathForTab() handles it.
      if (key === 'inbox') navigateIfChanged('inbox', this.selectedInboxId);
      else if (key === 'recipes') navigateIfChanged('recipes', this.selectedRecipeId);
      else if (key === 'triggers') navigateIfChanged('triggers', this.selectedTriggerId);
      else if (key === 'agent') navigateIfChanged('agent', this.terminals.selectedInstanceId);
      else if (key === 'artifacts') navigateIfChanged('artifacts', this.activeArtifactSubtab ?? undefined);
      else if (key === 'library') navigateIfChanged('library', this.activeLibrarySection);
      else navigateIfChanged(key);
    },
    /** Switch the active Library sub-section and reflect it in the URL. */
    setLibrarySection(section: string): void {
      this.activeLibrarySection = section;
      try { localStorage.setItem('clawdevbox.library.section', section); } catch { /* */ }
      if (this.activeTab === 'library') navigateIfChanged('library', section);
    },
    /** Toggle the global compose-to-agent dialog (Ctrl+Shift+Q). */
    toggleComposeDialog(open?: boolean): void {
      this.composeDialogOpen = open ?? !this.composeDialogOpen;
    },

    /**
     * Reconcile store state with the current route. Called from
     * App.vue on every route change so back/forward / direct deep
     * links land on the right tab + selection without re-pushing the
     * URL (the helpers use navigateIfChanged so loops are avoided).
     *
     * Route → store mapping:
     *   /main-agent              → activeTab = 'main-agent'
     *   /inbox                   → activeTab = 'inbox', selectedInboxId = null
     *   /inbox/<id>              → activeTab = 'inbox-detail:<id>' if a
     *                              pop-out tab for <id> already exists,
     *                              else activeTab = 'inbox' + selected = <id>
     *   /recipes[/<id>]          → activeTab = 'recipes', selectedRecipeId = <id>|null
     *   /triggers[/<id>]         → activeTab = 'triggers', selectedTriggerId = <id>|null
     *   /terminals[/<id>]        → activeTab = 'agent', selectedInstanceId = <id>|null
     *   /artifacts               → activeTab = 'artifacts', activeArtifactSubtab = null
     *   /artifacts/<id>          → activeTab = 'artifacts', activeArtifactSubtab = <id>
     *                              (auto-adds a tab entry to artifactTabs
     *                              if one doesn't already exist)
     */
    syncFromRoute(payload: {
      name: string | null | undefined;
      params: Record<string, string | string[] | undefined>;
    }): void {
      const name = payload.name ?? '';
      const p = payload.params;
      switch (name) {
        case 'main-agent':
          this.activeTab = 'main-agent';
          break;
        case 'inbox':
          this.activeTab = 'inbox';
          this.selectedInboxId = null;
          break;
        case 'inbox-item': {
          const id = typeof p.itemId === 'string' ? p.itemId : '';
          // If a popped-out tab for this id is ALREADY the active tab,
          // keep it (the user clicked the pop-out tab and that's what
          // triggered this navigation). Otherwise default to the
          // master inbox view with the id selected — even when a
          // popped-out tab exists, a deep link / browser-back / refresh
          // should land on the master tab so the user can switch away
          // from it. They can always click the popped-out tab to
          // re-activate it.
          if (id && this.activeTab === `inbox-detail:${id}`) {
            // Stay on the popped-out tab.
          } else {
            this.activeTab = 'inbox';
            this.selectedInboxId = id || null;
            if (id) {
              const item = this.inbox.find((it) => it.id === id);
              if (item && (item.description_size ?? 0) > 0) {
                this.fetchInboxBody(id);
              }
            }
          }
          break;
        }
        case 'recipes':
          this.activeTab = 'recipes';
          this.selectedRecipeId = null;
          break;
        case 'recipe-detail': {
          this.activeTab = 'recipes';
          this.selectedRecipeId = typeof p.recipeId === 'string' ? p.recipeId : null;
          break;
        }
        case 'triggers':
          this.activeTab = 'triggers';
          this.selectedTriggerId = null;
          break;
        case 'trigger-detail': {
          this.activeTab = 'triggers';
          this.selectedTriggerId = typeof p.triggerId === 'string' ? p.triggerId : null;
          break;
        }
        case 'daemons':
          this.activeTab = 'daemons';
          break;
        case 'library':
          this.activeTab = 'library';
          break;
        case 'library-section': {
          this.activeTab = 'library';
          const section = typeof p.section === 'string' ? p.section : '';
          if (section) {
            this.activeLibrarySection = section;
            try { localStorage.setItem('clawdevbox.library.section', section); } catch { /* */ }
          }
          break;
        }
        case 'terminals':
          this.activeTab = 'agent';
          this.terminals.selectedInstanceId = null;
          break;
        case 'terminal-detail': {
          this.activeTab = 'agent';
          this.terminals.selectedInstanceId =
            typeof p.instanceId === 'string' ? p.instanceId : null;
          break;
        }
        case 'artifacts':
          this.activeTab = 'artifacts';
          this.activeArtifactSubtab = null;
          break;
        case 'artifact': {
          const id = typeof p.artifactId === 'string' ? p.artifactId : '';
          // Deep link to an artifact subtab under the Artifacts tab.
          // Auto-synthesize an entry if one doesn't already exist —
          // artifact viewer URLs are canonical (`/artifact/<id>`) so we
          // don't need any additional metadata from the original opener,
          // unlike the old top-level tab flow.
          this.activeTab = 'artifacts';
          if (id) {
            if (!this.artifactTabs.some((t) => t.id === id)) {
              this.artifactTabs.push({
                id,
                title: id,
                url: `/artifact/${encodeURIComponent(id)}`,
              });
            }
            this.activeArtifactSubtab = id;
          } else {
            this.activeArtifactSubtab = null;
          }
          break;
        }
        default:
          this.activeTab = 'main-agent';
          break;
      }
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
          // The Main Agent has its own dedicated top-level tab, so the
          // Terminals tab should auto-select the first NON-main session.
          const firstNonMainLive = this.terminals.items.find(
            (i) => i.live && i.instance_id !== 'main',
          );
          const firstNonMain = this.terminals.items.find((i) => i.instance_id !== 'main');
          const chosen = firstNonMainLive ?? firstNonMain;
          if (chosen) this.terminals.selectedInstanceId = chosen.instance_id;
        }
      } finally {
        this.terminals.loading = false;
      }
    },

    selectTerminal(instanceId: string): void {
      this.terminals.selectedInstanceId = instanceId;
      if (this.activeTab === 'agent') {
        navigateIfChanged('agent', instanceId);
      }
    },

    async resumeTerminal(instanceId: string): Promise<string> {
      const r = await resumeSession(instanceId);
      this.terminals.selectedInstanceId = r.new_instance_id;
      // Optimistic — the 'sessions' topic event will refresh authoritatively.
      await this.refreshTerminals({ status: 'all' });
      return r.new_instance_id;
    },

    /**
     * Spawn a brand-new agent CLI session via POST /spawn.
     *
     * When workspace_id/workspace_path are both omitted, the server
     * auto-creates and pins a fresh workspace under
     * `<workspaces_root>/ws_<id>/`. The returned instance is auto-selected
     * so the xterm switches to the new session immediately.
     */
    async spawnTerminal(req: SpawnSessionRequest): Promise<SpawnSessionResponse> {
      const r = await spawnSession(req);
      this.terminals.selectedInstanceId = r.instance_id;
      // Optimistic refresh — the 'sessions' topic event will also fire.
      await this.refreshTerminals({ status: 'all' });
      return r;
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
