<script setup lang="ts">
/**
 * LibraryPanel — the "Library" tab: a browsable catalog of everything the
 * agent can do. A left sub-nav switches between two families:
 *
 *   Templates → Recipes · Skills · Trigger Templates
 *   Memory    → Facts · Lessons · Wiki
 *
 * The active section is driven by the ui store (persisted + URL-synced via
 * /library/<section>), so deep links and refreshes land on the right view.
 * Each section component fetches its own data on mount, so switching is
 * cheap and always fresh.
 */
import { computed } from 'vue';
import { useUiStore } from '../stores/ui';
import LibraryRecipes from './LibraryRecipes.vue';
import LibrarySkills from './LibrarySkills.vue';
import LibraryTriggerTemplates from './LibraryTriggerTemplates.vue';
import LibraryMemory from './LibraryMemory.vue';
import './library-shared.css';

const store = useUiStore();

interface SectionDef { key: string; label: string; icon: string }
interface SectionGroup { label: string; items: SectionDef[] }

const groups: SectionGroup[] = [
  {
    label: 'Templates',
    items: [
      { key: 'recipes', label: 'Recipes', icon: 'pi pi-sitemap' },
      { key: 'skills', label: 'Skills', icon: 'pi pi-book' },
      { key: 'triggers', label: 'Trigger Templates', icon: 'pi pi-bolt' },
    ],
  },
  {
    label: 'Memory',
    items: [
      { key: 'facts', label: 'Facts', icon: 'pi pi-verified' },
      { key: 'lessons', label: 'Lessons', icon: 'pi pi-graduation-cap' },
      { key: 'wiki', label: 'Wiki', icon: 'pi pi-file-word' },
    ],
  },
];

const validKeys = groups.flatMap((g) => g.items.map((i) => i.key));
const section = computed(() => (validKeys.includes(store.activeLibrarySection) ? store.activeLibrarySection : 'recipes'));

function pick(key: string): void {
  store.setLibrarySection(key);
}
</script>

<template>
  <section class="library-panel">
    <nav class="lib-subnav">
      <div v-for="g in groups" :key="g.label" class="lib-subnav__group">
        <header class="lib-subnav__head">{{ g.label }}</header>
        <button
          v-for="it in g.items"
          :key="it.key"
          type="button"
          class="lib-subnav__item"
          :class="{ 'is-active': section === it.key }"
          @click="pick(it.key)"
        >
          <i :class="it.icon" />
          <span>{{ it.label }}</span>
        </button>
      </div>
    </nav>

    <div class="library-panel__content">
      <LibraryRecipes v-if="section === 'recipes'" />
      <LibrarySkills v-else-if="section === 'skills'" />
      <LibraryTriggerTemplates v-else-if="section === 'triggers'" />
      <LibraryMemory v-else-if="section === 'facts'" key="mem-fact" type="fact" />
      <LibraryMemory v-else-if="section === 'lessons'" key="mem-lesson" type="lesson" />
      <LibraryMemory v-else-if="section === 'wiki'" key="mem-wiki" type="wiki" />
    </div>
  </section>
</template>

<style scoped>
.library-panel {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 172px 1fr;
  overflow: hidden;
}
.lib-subnav {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 8px;
  border-right: 1px solid var(--p-content-border-color, #2a2e38);
  background: #121419;
  overflow-y: auto;
}
.lib-subnav__group { display: flex; flex-direction: column; gap: 2px; }
.lib-subnav__head {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--p-text-color-secondary);
  padding: 2px 10px 4px;
  font-weight: 600;
}
.lib-subnav__item {
  display: flex;
  align-items: center;
  gap: 9px;
  background: transparent;
  border: none;
  border-left: 2px solid transparent;
  color: var(--p-text-color-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  padding: 7px 10px;
  border-radius: 5px;
  text-align: left;
}
.lib-subnav__item:hover { background: rgba(255, 255, 255, 0.05); color: var(--p-text-color); }
.lib-subnav__item.is-active {
  background: #1e2430;
  color: var(--p-text-color);
  border-left-color: var(--p-primary-color, #88c0d0);
}
.lib-subnav__item i { font-size: 13px; width: 16px; text-align: center; }
.library-panel__content { min-height: 0; overflow: hidden; }

@media (max-width: 760px) {
  .library-panel { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .lib-subnav { flex-direction: row; flex-wrap: wrap; gap: 4px; border-right: none; border-bottom: 1px solid var(--p-content-border-color, #2a2e38); overflow-x: auto; }
  .lib-subnav__group { flex-direction: row; align-items: center; gap: 2px; }
  .lib-subnav__head { display: none; }
}
</style>
