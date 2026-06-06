<script setup lang="ts">
/**
 * ArtifactsPanel — list of artifacts produced by this session's recipe
 * instance. Each item, when clicked, swaps the panel body to an iframe
 * pointing at /artifact/:id (the existing standalone artifact viewer).
 *
 * Why iframe: the viewer page already dynamic-loads the right renderer
 * for each artifact type (json, markdown, html, etc.). Re-implementing
 * that inline would multiply the renderer registry's surface area.
 *
 * Refresh: parent bumps `refreshNonce` on the 'artifacts' SSE topic.
 */
import { computed, ref, watch } from 'vue';
import { fetchSessionArtifacts, type SessionArtifact } from '../api';

const props = defineProps<{
  instanceId: string;
  /** Bump to force re-fetch. */
  refreshNonce?: number;
}>();

const items = ref<SessionArtifact[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const r = await fetchSessionArtifacts(props.instanceId);
    items.value = r.items.sort((a, b) => b.created_at - a.created_at);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.instanceId, props.refreshNonce ?? 0] as const,
  () => {
    selectedId.value = null;   // reset viewer when switching sessions
    load();
  },
  { immediate: true },
);

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return `${Math.floor(diff / 86400_000)}d`;
}

function iconFor(type: string): string {
  if (type.includes('json'))     return 'pi pi-code';
  if (type.includes('markdown')) return 'pi pi-file-edit';
  if (type.includes('html'))     return 'pi pi-globe';
  if (type.includes('image'))    return 'pi pi-image';
  if (type.includes('table') || type.includes('csv')) return 'pi pi-table';
  return 'pi pi-file';
}

const selected = computed(() => items.value.find((it) => it.id === selectedId.value) ?? null);
</script>

<template>
  <div class="artifacts-panel">
    <!-- List view -->
    <template v-if="!selected">
      <div v-if="error" class="empty err">Error: {{ error }}</div>
      <div v-else-if="loading && items.length === 0" class="empty muted">Loading…</div>
      <div v-else-if="items.length === 0" class="empty muted">No artifacts yet.</div>
      <ul v-else class="art-list">
        <li
          v-for="a in items"
          :key="a.id"
          class="art-item"
          @click="selectedId = a.id"
        >
          <i :class="iconFor(a.type)" />
          <div class="art-body">
            <div class="art-title">{{ a.title || a.id }}</div>
            <div class="art-meta muted">{{ a.type }} · {{ relTime(a.created_at) }}</div>
          </div>
        </li>
      </ul>
    </template>

    <!-- Viewer drilldown -->
    <template v-else>
      <div class="viewer-header">
        <button class="back-btn" @click="selectedId = null" title="Back to list">
          <i class="pi pi-arrow-left" />
        </button>
        <div class="viewer-title">
          <div class="muted small">{{ selected.type }}</div>
          <div class="bold">{{ selected.title || selected.id }}</div>
        </div>
        <a
          class="open-ext"
          :href="`/artifact/${encodeURIComponent(selected.id)}`"
          target="_blank"
          rel="noopener"
          title="Open in new tab"
        >
          <i class="pi pi-external-link" />
        </a>
      </div>
      <iframe
        :src="`/artifact/${encodeURIComponent(selected.id)}`"
        class="viewer-frame"
        sandbox="allow-same-origin allow-scripts allow-popups"
      />
    </template>
  </div>
</template>

<style scoped>
.artifacts-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

.art-list { list-style: none; margin: 0; padding: 4px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.art-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 3px; cursor: pointer; color: #d8dee9; }
.art-item:hover { background: #1c2029; }
.art-item i { font-size: 13px; color: #79b8ff; }
.art-body { min-width: 0; flex: 1 1 auto; }
.art-title { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.art-meta { font-size: 10px; margin-top: 1px; }

.viewer-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #23262d;
  flex: 0 0 auto;
}
.back-btn, .open-ext {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  background: transparent; border: 1px solid #3a3f4a; border-radius: 3px;
  color: #d8dee9; cursor: pointer; text-decoration: none;
}
.back-btn:hover, .open-ext:hover { border-color: #4a8be8; color: #79b8ff; }
.viewer-title { flex: 1 1 auto; min-width: 0; }
.viewer-title .bold { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viewer-title .small { font-size: 10px; }
.viewer-frame { flex: 1 1 auto; border: 0; background: #15171d; min-height: 0; }

.empty { font-size: 11px; padding: 8px; }
.empty.err { color: #e06c75; }
.muted { color: #7c8290; }
</style>
