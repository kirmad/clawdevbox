<script setup lang="ts">
/**
 * LibrarySkills — browse skills. The detail pane renders the SKILL.md body
 * as markdown and lists every supporting file in the skill directory
 * (scripts, templates, …), each expandable into a syntax-highlighted view.
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  fetchLibrarySkills,
  fetchLibrarySkill,
  type LibrarySkillSummary,
  type LibrarySkillDetail,
  type LibrarySkillFile,
} from '../api';
import CodeBlock from './CodeBlock.vue';
import { renderInboxBody } from '../markdown';
import { scopeLabel, scopeSeverity } from './useLibraryScope';

const items = ref<LibrarySkillSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const selectedId = ref<string | null>(null);

const detail = ref<LibrarySkillDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref<string | null>(null);
const showSkillMd = ref(true);
const openFiles = ref<Set<string>>(new Set());

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchLibrarySkills();
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
  showSkillMd.value = true;
  openFiles.value = new Set();
}

watch(selectedId, async (id) => {
  if (!id) { detail.value = null; return; }
  detailLoading.value = true;
  detailError.value = null;
  try {
    detail.value = await fetchLibrarySkill(id);
  } catch (err) {
    detailError.value = err instanceof Error ? err.message : String(err);
    detail.value = null;
  } finally {
    detailLoading.value = false;
  }
});

const bodyHtml = computed(() => (detail.value ? renderInboxBody(detail.value.body, 'markdown') : ''));

function toggleFile(rel: string): void {
  const next = new Set(openFiles.value);
  if (next.has(rel)) next.delete(rel); else next.add(rel);
  openFiles.value = next;
}
function isMarkdown(f: LibrarySkillFile): boolean {
  return f.ext === 'md' || f.ext === 'mdx';
}
function fileHtml(f: LibrarySkillFile): string {
  return f.source ? renderInboxBody(f.source, 'markdown') : '';
}
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fileIcon(f: LibrarySkillFile): string {
  if (isMarkdown(f)) return 'pi pi-file-edit';
  if (['ts', 'mts', 'js', 'mjs', 'cjs', 'py', 'sh', 'bash', 'ps1'].includes(f.ext)) return 'pi pi-code';
  if (['yaml', 'yml', 'json', 'toml'].includes(f.ext)) return 'pi pi-cog';
  return 'pi pi-file';
}

onMounted(load);
</script>

<template>
  <div class="lib-md">
    <aside class="lib-rail">
      <header class="lib-rail__head">
        <span>Skills</span>
        <Badge v-if="items.length" :value="items.length" severity="secondary" />
      </header>
      <div class="lib-rail__list">
        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <div v-else-if="loading && !items.length" class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</div>
        <div v-else-if="!items.length" class="lib-muted">No skills found.</div>
        <button
          v-for="it in items"
          :key="it.id"
          type="button"
          class="lib-card"
          :class="{ active: selectedId === it.id }"
          @click="select(it.id)"
        >
          <div class="lib-card__title">{{ it.name }}</div>
          <div class="lib-card__meta">
            <Tag :value="scopeLabel(it.scope)" :severity="scopeSeverity(it.scope)" />
          </div>
          <div v-if="it.description" class="lib-card__desc">{{ it.description }}</div>
        </button>
      </div>
    </aside>

    <section class="lib-detail">
      <div v-if="detailLoading" class="lib-pad"><span class="lib-loading"><i class="pi pi-spin pi-spinner" /> Loading…</span></div>
      <div v-else-if="detailError" class="lib-pad"><Message severity="error" :closable="false">{{ detailError }}</Message></div>
      <div v-else-if="!detail" class="lib-empty"><i class="pi pi-book" /><span>Select a skill to read its SKILL.md.</span></div>
      <div v-else class="lib-detail__scroll">
        <header class="lib-detail__head">
          <div>
            <h2>{{ detail.name }}</h2>
            <code class="lib-detail__id">{{ detail.id }}</code>
          </div>
          <Tag :value="scopeLabel(detail.scope)" :severity="scopeSeverity(detail.scope)" />
        </header>
        <p v-if="detail.description" class="lib-detail__desc">{{ detail.description }}</p>
        <div class="lib-path"><i class="pi pi-folder" /> {{ detail.path_rel }}</div>

        <section class="lib-block">
          <button type="button" class="lib-toggle" @click="showSkillMd = !showSkillMd">
            <i :class="showSkillMd ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" />
            SKILL.md
          </button>
          <div v-if="showSkillMd" class="lib-prose skill-md" v-html="bodyHtml" />
        </section>

        <section class="lib-block">
          <h3><i class="pi pi-paperclip" /> Files ({{ detail.files.length }})</h3>
          <div v-if="!detail.files.length" class="lib-muted">No supporting files — this skill is a single SKILL.md.</div>
          <div v-for="f in detail.files" :key="f.rel" class="skill-file">
            <button type="button" class="skill-file__head" @click="toggleFile(f.rel)">
              <i :class="openFiles.has(f.rel) ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="skill-file__chevron" />
              <i :class="fileIcon(f)" class="skill-file__icon" />
              <span class="skill-file__name">{{ f.rel }}</span>
              <span class="skill-file__size">{{ humanSize(f.size) }}</span>
            </button>
            <div v-if="openFiles.has(f.rel)" class="skill-file__body">
              <div v-if="!f.is_text || f.source === null" class="lib-muted skill-file__binary">
                <i class="pi pi-lock" /> Binary or non-text file — not shown inline.
              </div>
              <div v-else-if="isMarkdown(f)" class="lib-prose" v-html="fileHtml(f)" />
              <CodeBlock v-else :source="f.source" :runtime="f.ext" :max-height="420" />
            </div>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.lib-path { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 11px; color: var(--p-text-color-secondary); margin-top: 6px; display: flex; align-items: center; gap: 6px; }
.skill-md { margin-top: 4px; }
.skill-file { border: 1px solid var(--p-content-border-color, #2a2e38); border-radius: 6px; margin-bottom: 7px; overflow: hidden; }
.skill-file__head { width: 100%; display: flex; align-items: center; gap: 8px; background: #1c1f27; border: none; color: var(--p-text-color); cursor: pointer; font: inherit; padding: 8px 10px; }
.skill-file__head:hover { background: #20232c; }
.skill-file__chevron { font-size: 10px; color: var(--p-text-color-secondary); }
.skill-file__icon { font-size: 12px; color: var(--p-primary-color, #88c0d0); }
.skill-file__name { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-file__size { font-size: 11px; color: var(--p-text-color-secondary); }
.skill-file__body { padding: 10px; background: #14161c; }
.skill-file__binary { display: flex; align-items: center; gap: 6px; }
</style>
