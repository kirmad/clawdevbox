/**
 * Vue Router setup — makes the SPA tabs routable.
 *
 * Routes:
 *   /                          → redirect to /main-agent  (default)
 *   /main-agent                → MainAgentPanel
 *   /inbox                     → InboxPanel (no item selected)
 *   /inbox/:itemId             → InboxPanel with item selected
 *   /recipes                   → RecipesPanel
 *   /recipes/:recipeId         → RecipesPanel with recipe selected
 *   /triggers                  → TriggersPanel
 *   /triggers/:triggerId       → TriggersPanel with trigger selected
 *   /terminals                 → TerminalsPanel
 *   /terminals/:instanceId     → TerminalsPanel with session selected
 *   /artifacts                 → ArtifactsTabPanel (cross-workspace list)
 *   /artifacts/:artifactId     → ArtifactPanel (top-level popped-out viewer)
 *   /:pathMatch(.*)*           → redirect to /main-agent
 *
 * The route IS the source of truth for "what is currently being viewed".
 * App.vue derives `activeTab` from the route, and tab clicks /
 * selection mutations push a new route. The store mutations that change
 * which item is selected (`selectInboxItem`, `selectRecipe`, …) call
 * `navigateForSelection` so URL stays in sync.
 *
 * The matching is permissive on a path style: routes that end in `/`
 * are normalised. Unknown paths bounce to `/main-agent` so a stale link
 * doesn't leave the user looking at a blank tab list.
 *
 * Note: `/artifact/:id` (singular) is a server-rendered HTML host page
 * served by terminal-server.ts and embedded inside iframes; the SPA
 * route here is `/artifacts/:artifactId` (plural) to avoid clashing
 * with that server-side endpoint.
 */

import { defineComponent, h } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

export type TabKey =
  | 'main-agent'
  | 'inbox'
  | 'recipes'
  | 'triggers'
  | 'daemons'
  | 'library'
  | 'agent' /* terminals tab — historical key */
  | 'artifacts' /* cross-workspace list + inline artifact subtabs */
  | `inbox-detail:${string}`;

/**
 * A no-op route component. App.vue renders its own tab panels based on
 * the current route's `meta.tab`; routes only need to MATCH paths and
 * supply a component to satisfy vue-router's typing. The empty render
 * keeps things tidy if anyone adds a `<router-view>` later.
 */
const EmptyView = defineComponent({
  name: 'EmptyView',
  render: () => h('div', { style: 'display:none' }),
});

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/main-agent' },
  { path: '/main-agent', name: 'main-agent', component: EmptyView, meta: { tab: 'main-agent' } },
  { path: '/inbox', name: 'inbox', component: EmptyView, meta: { tab: 'inbox' } },
  { path: '/inbox/:itemId', name: 'inbox-item', component: EmptyView, meta: { tab: 'inbox' } },
  { path: '/recipes', name: 'recipes', component: EmptyView, meta: { tab: 'recipes' } },
  { path: '/recipes/:recipeId', name: 'recipe-detail', component: EmptyView, meta: { tab: 'recipes' } },
  { path: '/triggers', name: 'triggers', component: EmptyView, meta: { tab: 'triggers' } },
  { path: '/triggers/:triggerId', name: 'trigger-detail', component: EmptyView, meta: { tab: 'triggers' } },
  { path: '/daemons', name: 'daemons', component: EmptyView, meta: { tab: 'daemons' } },
  { path: '/library', name: 'library', component: EmptyView, meta: { tab: 'library' } },
  { path: '/library/:section', name: 'library-section', component: EmptyView, meta: { tab: 'library' } },
  { path: '/terminals', name: 'terminals', component: EmptyView, meta: { tab: 'agent' } },
  { path: '/terminals/:instanceId', name: 'terminal-detail', component: EmptyView, meta: { tab: 'agent' } },
  { path: '/artifacts', name: 'artifacts', component: EmptyView, meta: { tab: 'artifacts' } },
  { path: '/artifacts/:artifactId', name: 'artifact', component: EmptyView, meta: { tab: 'artifact' } },
  { path: '/:pathMatch(.*)*', redirect: '/main-agent' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * Map a tab key + optional item id to a URL path. Used by store
 * mutations + tab-click handlers so we have a single source of truth
 * for the URL shape.
 */
export function pathForTab(tab: string, itemId?: string | null): string {
  if (tab.startsWith('inbox-detail:')) {
    const id = tab.slice('inbox-detail:'.length);
    return id ? `/inbox/${encodeURIComponent(id)}` : '/inbox';
  }
  switch (tab) {
    case 'main-agent': return '/main-agent';
    case 'inbox':      return itemId ? `/inbox/${encodeURIComponent(itemId)}` : '/inbox';
    case 'recipes':    return itemId ? `/recipes/${encodeURIComponent(itemId)}` : '/recipes';
    case 'triggers':   return itemId ? `/triggers/${encodeURIComponent(itemId)}` : '/triggers';
    case 'daemons':    return '/daemons';
    case 'library':    return itemId ? `/library/${encodeURIComponent(itemId)}` : '/library';
    case 'agent':      return itemId ? `/terminals/${encodeURIComponent(itemId)}` : '/terminals';
    case 'artifacts':  return itemId ? `/artifacts/${encodeURIComponent(itemId)}` : '/artifacts';
    default:           return '/main-agent';
  }
}
