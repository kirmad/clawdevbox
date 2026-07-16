<script setup lang="ts">
/**
 * ArtifactsTabPanel — top-level Artifacts tab.
 *
 * Two views coexist behind a subtab strip at the top:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  [ All Artifacts ] [ my-design ]  [ pr-walkthrough-1234 × ]  │ ← subtab strip
 *   ├──────────────────────────────────────────────────────────────┤
 *   │                                                              │
 *   │   ▸ list view    (activeArtifactSubtab === null)             │
 *   │   OR                                                         │
 *   │   ▸ artifact iframe (activeArtifactSubtab is a subtab id)    │
 *   │                                                              │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Clicking an artifact in the list calls `store.openArtifact`, which
 * adds it to `store.artifactTabs`, activates it via
 * `store.activeArtifactSubtab`, and updates the URL to /artifacts/<id>.
 * The subtab strip renders one button per entry in `artifactTabs`;
 * closing a subtab drops it and (if it was active) falls back to
 * the list view.
 *
 * Contrast with the sibling ArtifactsPanel — that one is scoped to a
 * single recipe instance and lives inside SessionSidePanel; this one
 * is the global cross-workspace index.
 *
 * Refresh (list view only):
 *   - initial fetch on mount
 *   - re-fetch on `clawdevbox:sse:artifacts` (dispatched by realtime.ts
 *     when the server broadcasts an 'artifacts' topic change)
 *   - manual Refresh button
 *   - 60s poll fallback so the "5m ago" labels don't drift for hours
 *     if SSE is offline
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { fetchAllArtifacts, fetchArtifactSession, type AllArtifact } from '../api';
import { useUiStore } from '../stores/ui';
import InboxTerminalPanel from './InboxTerminalPanel.vue';

const store = useUiStore();

const items = ref<AllArtifact[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const search = ref('');
const now = ref(Date.now());

let pollTimer: number | null = null;
let clockTimer: number | null = null;

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await fetchAllArtifacts();
    items.value = r.items;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function onSseArtifacts(): void { void load(); }

onMounted(() => {
  void load();
  window.addEventListener('clawdevbox:sse:artifacts', onSseArtifacts);
  // Slower cadence than the SessionSidePanel — this tab is a browse
  // surface, not a live dashboard.
  pollTimer = window.setInterval(() => { void load(); }, 60_000);
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
});

onBeforeUnmount(() => {
  window.removeEventListener('clawdevbox:sse:artifacts', onSseArtifacts);
  if (pollTimer !== null) window.clearInterval(pollTimer);
  if (clockTimer !== null) window.clearInterval(clockTimer);
});

const filtered = computed<AllArtifact[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((a) => {
    const t = (a.title ?? '').toLowerCase();
    return (
      t.includes(q) ||
      a.id.toLowerCase().includes(q) ||
      a.type.toLowerCase().includes(q) ||
      (a.recipe_instance_id ?? '').toLowerCase().includes(q)
    );
  });
});

const openSubtabs = computed(() => store.artifactTabs);
const activeSubtab = computed<string | null>(() => store.activeArtifactSubtab);
const activeSubtabEntry = computed(() =>
  openSubtabs.value.find((t) => t.id === activeSubtab.value) ?? null,
);

// -- Agent terminal for the active artifact (local mode / 5201 SPA only) -----
// Reveals the live agent terminal that produced the artifact, mirroring the
// inbox item terminal panel. The session is resolved SERVER-SIDE via
// /artifact/<id>/session: attach to the live instance when running, else fall
// back to the manifest recipe-instance as a resume anchor so the reused
// InboxTerminalPanel can wake the conversation. The toggle is hidden when no
// session is bound. This is inherently local-mode-only: the SPA (and the
// /terminal/<id>/ws it uses) is never served on the shared 5301 tunnel.
const terminalOpen = ref(false);
const terminalSessionIds = ref<string[]>([]);
const terminalLabels = ref<string[]>([]);

async function loadArtifactSession(artifactId: string | null): Promise<void> {
  terminalSessionIds.value = [];
  terminalLabels.value = [];
  if (!artifactId) return;
  try {
    const s = await fetchArtifactSession(artifactId);
    if (!s) return;
    // Prefer the currently-live instance; fall back to the manifest instance
    // as a resume anchor when the conversation is asleep.
    const anchor = s.live_instance_id ?? s.recipe_instance_id;
    if (anchor) {
      terminalSessionIds.value = [anchor];
      terminalLabels.value = ['agent'];
    }
  } catch {
    /* no session bound / fetch failed — leave the toggle hidden */
  }
}

// Re-resolve whenever the active artifact changes; close the panel so a stale
// terminal from the previously-viewed artifact is never shown.
watch(
  () => activeSubtab.value,
  (id) => {
    terminalOpen.value = false;
    void loadArtifactSession(id);
  },
  { immediate: true },
);

function relTime(ts: number): string {
  if (!ts) return 'unknown';
  const diff = now.value - ts;
  if (diff < 0) return 'just now';
  if (diff < 60_000)    return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function absTime(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

function iconFor(type: string): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('pr-review'))   return 'pi pi-code';
  if (t.includes('walkthrough')) return 'pi pi-book';
  if (t.includes('markdown'))    return 'pi pi-file-edit';
  if (t.includes('mermaid'))     return 'pi pi-sitemap';
  if (t.includes('json'))        return 'pi pi-code';
  if (t.includes('html'))        return 'pi pi-globe';
  if (t.includes('image'))       return 'pi pi-image';
  if (t.includes('table') || t.includes('csv')) return 'pi pi-table';
  return 'pi pi-file';
}

function workspaceLabel(a: AllArtifact): string {
  if (a.workspace_id === 'project') return 'project';
  // Show a compact tail of the workspace path — the full ws_<ts>_<rand>
  // ids aren't user-friendly.
  const parts = a.workspace_path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? a.workspace_id;
}

function open(a: AllArtifact): void {
  // Adds a subtab to store.artifactTabs + activates it. The subtab
  // strip and iframe pane both react to store.activeArtifactSubtab.
  store.openArtifact({
    id: a.id,
    title: a.title ?? a.id,
    url: a.view_url || `/artifact/${encodeURIComponent(a.id)}`,
  });
}

function selectList(): void {
  store.setActiveArtifactSubtab(null);
}
function selectSubtab(id: string): void {
  store.setActiveArtifactSubtab(id);
}
function closeSubtab(id: string, ev?: Event): void {
  ev?.stopPropagation();
  store.closeArtifact(id);
}
</script>

<template>
  <section class="panel">
    <!-- Subtab strip: "All" + one tab per open artifact. Only visible
         when at least one artifact has been opened (otherwise the list
         is the only view and a strip would be visual clutter). -->
    <div
      v-if="openSubtabs.length > 0"
      class="subtab-strip"
      role="tablist"
      aria-label="Artifact views"
    >
      <button
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: activeSubtab === null }"
        :aria-selected="activeSubtab === null"
        @click="selectList"
      >
        <i class="pi pi-folder-open" />
        <span>All Artifacts</span>
      </button>
      <button
        v-for="tab in openSubtabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="subtab"
        :class="{ active: activeSubtab === tab.id }"
        :aria-selected="activeSubtab === tab.id"
        :title="tab.title || tab.id"
        @click="selectSubtab(tab.id)"
      >
        <i class="pi pi-file" />
        <span class="subtab-label">{{ tab.title || tab.id }}</span>
        <i
          class="pi pi-times subtab-close"
          role="button"
          tabindex="0"
          aria-label="Close artifact tab"
          :title="`Close ${tab.title || tab.id}`"
          @click="closeSubtab(tab.id, $event)"
        />
      </button>

      <!-- Right-aligned controls for the active artifact. Merged here from the
           old artifact-toolbar row to save a full bar of vertical chrome. -->
      <div v-if="activeSubtabEntry" class="subtab-actions">
        <button
          v-if="terminalSessionIds.length > 0"
          type="button"
          class="term-toggle"
          :class="{ active: terminalOpen }"
          :title="terminalOpen ? 'Hide agent terminal' : 'Show the agent terminal for this artifact'"
          @click="terminalOpen = !terminalOpen"
        >
          <i class="pi pi-microchip-ai" />
          <span>Terminal</span>
        </button>
        <a
          class="open-ext"
          :href="activeSubtabEntry.url"
          target="_blank"
          rel="noopener"
          title="Open artifact in a new tab"
        >
          <i class="pi pi-external-link" />
        </a>
      </div>
    </div>

    <!-- Artifact viewer subpane (active when a subtab is selected). -->
    <div v-if="activeSubtabEntry" class="artifact-subpane">
      <div class="artifact-body">
        <iframe
          :src="activeSubtabEntry.url"
          :title="activeSubtabEntry.title || activeSubtabEntry.id"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          loading="lazy"
          referrerpolicy="same-origin"
          class="artifact-iframe"
        />
        <InboxTerminalPanel
          v-if="terminalOpen && terminalSessionIds.length > 0"
          :key="activeSubtabEntry.id"
          :sessionIds="terminalSessionIds"
          :sessionLabels="terminalLabels"
          class="artifact-terminal"
          @close="terminalOpen = false"
        />
      </div>
    </div>

    <!-- List view (default). -->
    <div v-else class="list-view">
      <header class="head">
        <h1>Artifacts</h1>
        <Badge
          v-if="items.length > 0"
          :value="String(items.length)"
          severity="secondary"
        />
        <span class="spacer" />
        <InputText
          v-model="search"
          placeholder="Filter by title, id, type…"
          size="small"
          class="search"
        />
        <Button
          icon="pi pi-refresh"
          label="Refresh"
          size="small"
          severity="secondary"
          outlined
          :loading="loading"
          @click="load()"
        />
      </header>

      <p v-if="error" class="error-banner">{{ error }}</p>

      <div v-if="!loading && items.length === 0" class="empty">
        No artifacts yet. Agents produce artifacts via <code>artifact.add</code>
        (design docs, PR reviews, walkthroughs, mermaid diagrams, etc.) — they
        show up here as soon as they're written.
      </div>

      <div v-else-if="!loading && filtered.length === 0" class="empty muted">
        No artifacts match "{{ search }}".
      </div>

      <ul v-else class="cards">
        <li
          v-for="a in filtered"
          :key="a.id"
          class="card"
          role="button"
          tabindex="0"
          @click="open(a)"
          @keydown.enter="open(a)"
          @keydown.space.prevent="open(a)"
        >
          <i :class="iconFor(a.type)" class="type-icon" />
          <div class="body">
            <div class="title-row">
              <span class="title">{{ a.title || a.id }}</span>
              <Tag :value="a.type" severity="secondary" class="type-tag" />
            </div>
            <div class="meta-row">
              <span class="meta"><i class="pi pi-folder" /> {{ workspaceLabel(a) }}</span>
              <span
                v-if="a.recipe_instance_id"
                class="meta muted"
                :title="a.recipe_instance_id"
              >
                <i class="pi pi-list-check" /> {{ a.recipe_instance_id }}
              </span>
              <span class="meta muted" :title="absTime(a.created_at)">
                <i class="pi pi-clock" /> {{ relTime(a.created_at) }}
              </span>
              <span class="meta muted abs-time">{{ absTime(a.created_at) }}</span>
            </div>
            <code class="id">{{ a.id }}</code>
          </div>
          <i class="pi pi-external-link open-icon" />
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ---- Subtab strip (mirrors InboxDetailPanel styling) ---------------- */
.subtab-strip {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 6px 8px 0 8px;
  background: #181a21;
  border-bottom: 1px solid #2a2e38;
  overflow-x: auto;
  flex-shrink: 0;
}
.subtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  color: var(--p-text-color-secondary, #99a3b3);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  max-width: 240px;
  font: inherit;
}
.subtab i { font-size: 11px; }
.subtab:hover { background: #20232c; color: var(--p-text-color); }
.subtab.active {
  background: var(--p-content-background, #14161c);
  border-color: #2a2e38;
  color: var(--p-text-color, #d8dee9);
  position: relative;
  top: 1px;
}
.subtab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
.subtab-close {
  color: var(--p-text-color-secondary, #99a3b3);
  border-radius: 3px;
  padding: 2px;
}
.subtab-close:hover { background: #2a2e38; color: var(--p-text-color); }

/* ---- Artifact viewer subpane --------------------------------------- */
.artifact-subpane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Active-artifact controls, right-aligned inside the subtab strip. Sticky so
   they stay pinned to the right edge even when the tab list scrolls. */
.subtab-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  position: sticky;
  right: 0;
  padding: 0 2px 6px 10px;
  background: #181a21;
  z-index: 1;
}
.term-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--p-content-border-color, #2a2e38);
  background: transparent;
  color: var(--p-text-color, #d8dee9);
  font-size: 12px;
  cursor: pointer;
}
.term-toggle:hover { background: #21252e; }
.term-toggle.active {
  background: var(--p-primary-color, #4f8cff);
  color: #0b0d10;
  border-color: transparent;
}
.term-toggle .pi { font-size: 13px; }
.open-ext {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border-radius: 6px;
  color: var(--p-text-muted-color, #9aa0aa);
  text-decoration: none;
}
.open-ext:hover { background: #21252e; color: var(--p-text-color, #d8dee9); }
.artifact-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: row;
}
.artifact-terminal {
  flex: 0 0 42%;
  min-width: 0;
  border-left: 1px solid var(--p-content-border-color, #2a2e38);
}
.artifact-iframe {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: #15171d;
  min-height: 0;
}

/* ---- List view ----------------------------------------------------- */
.list-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  gap: 12px;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.head h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--p-text-color, #d8dee9);
}
.spacer { flex: 1 1 auto; }
.search { min-width: 220px; }

.error-banner {
  background: #3a1f22;
  color: #f8b4b4;
  border: 1px solid #7a3a3f;
  border-radius: 4px;
  padding: 6px 10px;
  margin: 0;
  font-size: 12px;
}

.empty {
  padding: 16px;
  border: 1px dashed #2a2e38;
  border-radius: 4px;
  color: var(--p-text-color-secondary, #99a3b3);
  font-size: 12px;
  line-height: 1.5;
}
.empty code {
  background: #20232c;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.empty.muted { border-style: solid; text-align: center; }

.cards {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: #181b22;
  border: 1px solid #23262d;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s ease, border-color 0.1s ease;
}
.card:hover {
  background: #1c2029;
  border-color: #2f4a72;
}
.card:focus-visible {
  outline: 2px solid var(--p-primary-color, #88c0d0);
  outline-offset: -1px;
}
.type-icon {
  font-size: 16px;
  color: #79b8ff;
  flex-shrink: 0;
  margin-top: 2px;
}
.body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.title {
  font-size: 13px;
  font-weight: 500;
  color: var(--p-text-color, #d8dee9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 0 1 auto;
}
.type-tag {
  font-size: 10px;
  flex-shrink: 0;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--p-text-color-secondary, #99a3b3);
}
.meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.meta i { font-size: 10px; }
.meta.muted { color: #6b7280; }
.abs-time {
  font-variant-numeric: tabular-nums;
}
.id {
  font-size: 10px;
  color: #6b7280;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.open-icon {
  font-size: 11px;
  color: #6b7280;
  align-self: center;
  flex-shrink: 0;
}
.card:hover .open-icon { color: #79b8ff; }

@media (max-width: 720px) {
  .search { display: none; }
  .abs-time { display: none; }
}
</style>
