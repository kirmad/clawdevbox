<script setup lang="ts">
/**
 * LibraryTriggerTemplates — browse trigger TYPES (the catalog of automations
 * the agent can register). The detail pane shows the parameter schema, the
 * default schedule, and the full trigger script.
 */
import { onMounted, ref, watch } from 'vue';
import {
  fetchLibraryTriggerTemplates,
  fetchLibraryTriggerTemplateScript,
  type LibraryTriggerTemplateSummary,
  type LibraryTriggerTemplateScript,
} from '../api';
import CodeBlock from './CodeBlock.vue';
import { scopeLabel, scopeSeverity } from './useLibraryScope';

const items = ref<LibraryTriggerTemplateSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

const script = ref<LibraryTriggerTemplateScript | null>(null);
const scriptLoading = ref(false);
const scriptError = ref<string | null>(null);
const showScript = ref(true);

function selected(): LibraryTriggerTemplateSummary | null {
  return items.value.find((i) => i.id === selectedId.value) ?? null;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchLibraryTriggerTemplates();
    items.value = res.items;
    error.value = null;
    if (!selectedId.value && items.value.length > 0) select(items.value[0].id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function select(id: string): void {
  selectedId.value = id;
  showScript.value = true;
}

watch(selectedId, async (id) => {
  if (!id) { script.value = null; return; }
  scriptLoading.value = true;
  scriptError.value = null;
  try {
    script.value = await fetchLibraryTriggerTemplateScript(id);
  } catch (err) {
    scriptError.value = err instanceof Error ? err.message : String(err);
    script.value = null;
  } finally {
    scriptLoading.value = false;
  }
});

function cronLabelText(t: LibraryTriggerTemplateSummary): string {
  return t.default_cron ? t.default_cron : 'manual / webhook';
}

onMounted(load);
</script>

<template>
  <div class="lib-md">
    <aside class="lib-rail">
      <header class="lib-rail__head">
        <span>Trigger Templates</span>
        <Badge v-if="items.length" :value="items.length" severity="secondary" />
      </header>
      <div class="lib-rail__list">
        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <div v-else-if="loading && !items.length" class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</div>
        <div v-else-if="!items.length" class="lib-muted">No trigger templates found.</div>
        <button
          v-for="it in items"
          :key="it.id"
          type="button"
          class="lib-card"
          :class="{ active: selectedId === it.id }"
          @click="select(it.id)"
        >
          <div class="lib-card__title">{{ it.id }}</div>
          <div class="lib-card__meta">
            <Tag :value="scopeLabel(it.scope)" :severity="scopeSeverity(it.scope)" />
            <Tag :value="it.runtime" severity="secondary" />
          </div>
          <div v-if="it.description" class="lib-card__desc">{{ it.description }}</div>
        </button>
      </div>
    </aside>

    <section class="lib-detail">
      <div v-if="!selected()" class="lib-empty"><i class="pi pi-bolt" /><span>Select a trigger template to view its script.</span></div>
      <div v-else class="lib-detail__scroll">
        <header class="lib-detail__head">
          <div>
            <h2>{{ selected()!.id }}</h2>
            <code v-if="selected()!.source_plugin_id" class="lib-detail__id">via plugin:{{ selected()!.source_plugin_id }}</code>
          </div>
          <Tag :value="scopeLabel(selected()!.scope)" :severity="scopeSeverity(selected()!.scope)" />
        </header>
        <p v-if="selected()!.description" class="lib-detail__desc">{{ selected()!.description }}</p>

        <section class="lib-block">
          <h3><i class="pi pi-info-circle" /> Overview</h3>
          <dl class="tt-meta">
            <dt>runtime</dt><dd><code>{{ selected()!.runtime }}</code></dd>
            <dt>schedule</dt><dd><code>{{ cronLabelText(selected()!) }}</code></dd>
            <dt>webhook</dt><dd>{{ selected()!.accepts_webhook ? 'accepted' : 'no' }}</dd>
            <dt v-if="selected()!.identity_param">identity</dt>
            <dd v-if="selected()!.identity_param"><code>{{ selected()!.identity_param }}</code></dd>
          </dl>
        </section>

        <section v-if="script && script.parameters.length" class="lib-block">
          <h3><i class="pi pi-sliders-h" /> Parameters ({{ script.parameters.length }})</h3>
          <table class="tt-params">
            <thead><tr><th>name</th><th>type</th><th>required</th><th>description</th></tr></thead>
            <tbody>
              <tr v-for="pm in script.parameters" :key="pm.name">
                <td><code>{{ pm.name }}</code></td>
                <td>{{ pm.type }}</td>
                <td>{{ pm.required ? 'yes' : 'no' }}</td>
                <td class="tt-params__desc">{{ pm.description || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="lib-block">
          <button type="button" class="lib-toggle" @click="showScript = !showScript">
            <i :class="showScript ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
            Script
          </button>
          <div v-if="showScript">
            <div v-if="scriptLoading" class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</div>
            <Message v-else-if="scriptError" severity="error" :closable="false">{{ scriptError }}</Message>
            <template v-else-if="script">
              <div v-if="script.path_rel" class="lib-path"><i class="pi pi-file" /> {{ script.path_rel }}</div>
              <Message v-if="script.error" severity="warn" :closable="false">{{ script.error.code }}: {{ script.error.message }}</Message>
              <CodeBlock v-if="script.source" :source="script.source" :runtime="script.runtime" :max-height="520" />
              <div v-else-if="!script.error" class="lib-muted">(script is empty)</div>
            </template>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lib-path { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11px; color: var(--p-text-color-secondary); margin: 4px 0 8px; display: flex; align-items: center; gap: 6px; }
.tt-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0; font-size: 12.5px; }
.tt-meta dt { color: var(--p-text-color-secondary); }
.tt-meta dd { margin: 0; }
.tt-params { width: 100%; border-collapse: collapse; font-size: 12px; }
.tt-params th, .tt-params td { border: 1px solid var(--p-content-border-color, #2a2e38); padding: 5px 8px; text-align: left; }
.tt-params th { color: var(--p-text-color-secondary); font-weight: 600; background: #16181e; }
.tt-params__desc { color: var(--p-text-color-secondary); }
code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 0.9em; background: #20232c; padding: 1px 5px; border-radius: 3px; }
</style>
