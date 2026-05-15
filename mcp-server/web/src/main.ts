/**
 * SPA entry — Vue 3 + PrimeVue (Aura Dark) + Pinia.
 *
 * `window.__CLAWDEVBOX__` is injected by the server in production
 * (`renderHomePage` in `src/home-page.ts`). In dev mode (`npm --prefix web
 * run dev`) the value is undefined; the bootstrap composable falls back to
 * sensible defaults so the SPA still renders against a foreground
 * `clawdevbox start` via Vite's proxy.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import ConfirmationService from 'primevue/confirmationservice';
import Aura from '@primeuix/themes/aura';

import App from './App.vue';
import 'primeicons/primeicons.css';
import './style.css';

const app = createApp(App);

app.use(createPinia());
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark-mode',
      cssLayer: {
        name: 'primevue',
        order: 'tailwind-base, primevue, tailwind-utilities',
      },
    },
  },
});
app.use(ToastService);
app.use(ConfirmationService);

// Force dark mode globally — the server's existing palette is dark, and
// auto-detecting based on prefers-color-scheme would yield a mismatch on
// machines where the OS is light.
document.documentElement.classList.add('dark-mode');

// Register the PWA service worker after first paint so it doesn't block
// the SPA shell. The worker only intercepts static shell paths — /api,
// /mcp, /artifact, /__renderer always hit the network.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* best-effort */
    });
  });
}

app.mount('#app');
