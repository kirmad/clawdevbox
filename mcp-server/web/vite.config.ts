import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { PrimeVueResolver } from '@primevue/auto-import-resolver';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite build for the clawdevbox SPA.
 *
 * - Outputs to `dist/` (this directory). `mcp-server`'s top-level build
 *   then copies us into `<mcp-server>/dist/web/` so the published
 *   package ships the SPA.
 * - `dev` mode proxies all server routes to the foreground
 *   `clawdevbox start` so we get HMR + a real backend without
 *   double-launching anything.
 */
export default defineConfig({
  plugins: [
    vue(),
    // Auto-import PrimeVue components by tag name (<Button>, <Tabs>, ...).
    Components({
      resolvers: [PrimeVueResolver()],
      dts: true,
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Forward everything the SPA does NOT own to the foreground server
    // (default port 5201). Run `clawdevbox start` in another terminal
    // before `npm --prefix web run dev`.
    proxy: {
      '/api':            { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/mcp':            { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/artifact':       { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/terminal':       { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: true },
      '/__renderer':     { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/healthz':        { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/sw.js':          { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/manifest.webmanifest': { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/icon.svg':       { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
      '/icon-maskable.svg': { target: 'http://127.0.0.1:5201', changeOrigin: false, ws: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    // Inline small assets so we ship fewer round-trips for icons / qr.
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // Keep entry / chunk names deterministic so SW caching works.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
