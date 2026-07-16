<script setup lang="ts">
/**
 * LibraryMemory — browse durable memory of a given type (fact | lesson |
 * wiki) across all vaults. The detail pane renders the doc body as markdown
 * plus its metadata: vault/scope, tags, votes, and (for lessons) the
 * decay-adjusted confidence.
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  fetchLibraryMemory,
  fetchLibraryMemoryDoc,
  type LibraryMemorySummary,
  type LibraryMemoryDoc,
  type MemoryDocType,
} from '../api';
import { renderInboxBody } from '../markdown';

const props = defineProps<{ type: MemoryDocType }>();

const items = ref<LibraryMemorySummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedKey = ref<string | null>(null);

const detail = ref<LibraryMemoryDoc | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);

const railTitle = computed(() => (props.type === 'fact' ? 'Facts' : props.type === 'lesson' ? 'Lessons' : 'Wiki'));

async function load(): Promise<void> {
  loading.value = true;
  selectedKey.value = null;
  detail.value = null;
  try {
    const res = await fetchLibraryMemory(props.type);
    items.value = res.items;
    error.value = null;
    if (items.value.length > 0) select(items.value[0].key);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    items.value = [];
  } finally {
    loading.value = false;
  }
}

function select(key: string): void {
  selectedKey.value = key;
}

watch(selectedKey, async (key) => {
  if (!key) { detail.value = null; return; }
  detailLoading.value = true;
  detailError.value = null;
  try {
    detail.value = await fetchLibraryMemoryDoc(key);
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
});

watch(() => props.type, load);

const bodyHtml = computed(() => (detail.value ? renderInboxBody(detail.value.body, 'markdown') : ''));

function confidencePct(c: number | null): string {
  return c === null ? '' : `${Math.round(c * 100)}%`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

onMounted(load);
</script>

<template>
  <div class="lib-md">
    <aside class="lib-rail">
      <header class="lib-rail__head">
        <span>{{ railTitle }}</span>
        <Badge v-if="items.length" :value="items.length" severity="secondary" />
      </header>
      <div class="lib-rail__list">
        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <div v-else-if="loading && !items.length" class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</div>
        <div v-else-if="!items.length" class="lib-muted">No {{ railTitle.toLowerCase() }} recorded yet.</div>
        <button
          v-for="it in items"
          :key="it.key"
          type="button"
          class="lib-card"
          :class="{ active: selectedKey === it.key }"
          @click="select(it.key)"
        >
          <div class="lib-card__title">{{ it.title }}</div>
          <div class="lib-card__meta">
            <Tag :value="it.scope" :severity="it.scope === 'team' ? 'contrast' : 'secondary'" />
            <span v-if="type === 'lesson' && it.confidence !== null" class="mem-conf">{{ confidencePct(it.confidence) }}</span>
            <span v-if="it.votes.up || it.votes.down" class="lib-muted mem-votes">
              <i class="pi pi-thumbs-up" />{{ it.votes.up }} <i class="pi pi-thumbs-down" />{{ it.votes.down }}
            </span>
          </div>
          <div v-if="it.tags.length" class="mem-tags">
            <span v-for="t in it.tags.slice(0, 4)" :key="t" class="mem-tag">#{{ t }}</span>
          </div>
        </button>
      </div>
    </aside>

    <section class="lib-detail">
      <div v-if="detailLoading" class="lib-pad"><span class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</span></div>
      <div v-else-if="detailError" class="lib-pad"><Message severity="error" :closable="false">{{ detailError }}</Message></div>
      <div v-else-if="!detail" class="lib-empty"><i class="pi pi-database" /><span>Select an entry to read it.</span></div>
      <div v-else class="lib-detail__scroll">
        <header class="lib-detail__head">
          <h2>{{ detail.title }}</h2>
          <Tag :value="detail.scope" :severity="detail.scope === 'team' ? 'contrast' : 'secondary'" />
        </header>

        <dl class="mem-meta">
          <template v-if="detail.category"><dt>category</dt><dd>{{ detail.category }}</dd></template>
          <template v-if="type === 'lesson' && detail.confidence !== null"><dt>confidence</dt><dd>{{ confidencePct(detail.confidence) }}</dd></template>
          <dt>votes</dt><dd><i class="pi pi-thumbs-up" /> {{ detail.votes.up }} &nbsp; <i class="pi pi-thumbs-down" /> {{ detail.votes.down }}</dd>
          <template v-if="detail.created"><dt>created</dt><dd>{{ fmtDate(detail.created) }}<span v-if="detail.created_by"> · {{ detail.created_by }}</span></dd></template>
          <template v-if="detail.reinforcement_count"><dt>reinforced</dt><dd>{{ detail.reinforcement_count }}×</dd></template>
        </dl>

        <div v-if="detail.tags.length" class="mem-tags mem-tags--detail">
          <span v-for="t in detail.tags" :key="t" class="mem-tag">#{{ t }}</span>
        </div>

        <div class="lib-prose mem-body" v-html="bodyHtml" />

        <section v-if="detail.reason" class="lib-block">
          <h3><i class="pi pi-comment" /> Reason</h3>
          <p class="mem-aux">{{ detail.reason }}</p>
        </section>
        <section v-if="detail.context" class="lib-block">
          <h3><i class="pi pi-compass" /> Context</h3>
          <p class="mem-aux">{{ detail.context }}</p>
        </section>
        <section v-if="detail.citations" class="lib-block">
          <h3><i class="pi pi-link" /> Citations</h3>
          <pre class="mem-citations">{{ detail.citations }}</pre>
        </section>

        <div class="lib-path"><i class="pi pi-folder" /> {{ detail.vault_id }} / {{ detail.path_rel }}</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mem-conf { font-size: 11px; font-weight: 700; color: #6fbf73; }
.mem-votes { font-size: 11px; display: inline-flex; align-items: center; gap: 3px; }
.mem-votes i { font-size: 10px; }
.mem-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.mem-tags--detail { margin: 8px 0 4px; }
.mem-tag { font-size: 10.5px; color: var(--p-primary-color, #88c0d0); background: #1c2530; padding: 1px 6px; border-radius: 10px; }
.mem-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 10px 0 4px; font-size: 12.5px; }
.mem-meta dt { color: var(--p-text-color-secondary); }
.mem-meta dd { margin: 0; }
.mem-meta i { font-size: 11px; }
.mem-body { margin-top: 12px; }
.mem-aux { font-size: 12.5px; line-height: 1.5; color: var(--p-text-color); white-space: pre-wrap; margin: 0; }
.mem-citations { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11.5px; background: #14161c; border: 1px solid var(--p-content-border-color, #2a2e38); border-radius: 6px; padding: 10px; white-space: pre-wrap; word-break: break-word; margin: 0; }
.lib-path { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11px; color: var(--p-text-color-secondary); margin-top: 18px; display: flex; align-items: center; gap: 6px; }
</style>
