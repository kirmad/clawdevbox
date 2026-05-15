/**
 * pwa-assets.ts
 *
 * Static PWA assets served by `clawdevbox start`:
 *   /manifest.webmanifest  — install metadata
 *   /sw.js                 — service worker (offline shell)
 *   /icon.svg              — vector icon used by the manifest + favicon
 *   /icon-maskable.svg     — same glyph with a centered safe zone
 *
 * Everything is generated in code (no PNG assets to ship) so the build
 * footprint stays small and the icon can be re-themed from one place.
 */

/** App-wide branding tokens. Keep in sync with home-page.ts CSS. */
const BG = '#14161b';
const FG = '#88c0d0';
const FG_DIM = '#5e93a0';

export function manifestJson(): string {
  return JSON.stringify(
    {
      name: 'clawdevbox',
      short_name: 'clawdevbox',
      description: 'AI coding agents, headless — inbox + main agent on your phone.',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: BG,
      theme_color: BG,
      categories: ['developer', 'productivity'],
      icons: [
        { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
        { src: '/icon-maskable.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
}

/**
 * Stylized lowercase "c" glyph on a dark rounded square — recognizable at
 * favicon sizes, scales without artifacts to install-prompt sizes. The
 * `purpose: any` variant keeps the glyph close to the edge; the maskable
 * variant pulls it inward by ~20% so platform masks (rounded square /
 * circle / squircle) don't crop it.
 */
export function iconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="clawdevbox">
  <rect width="512" height="512" rx="96" fill="${BG}" />
  <g transform="translate(106 84)">
    <path d="M222 80 a172 172 0 1 0 0 188" fill="none" stroke="${FG}" stroke-width="60" stroke-linecap="round" />
    <circle cx="244" cy="100" r="22" fill="${FG_DIM}" />
  </g>
</svg>`;
}

export function iconMaskableSvg(): string {
  // Maskable icons need ~20% padding so platform masks don't clip.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="clawdevbox">
  <rect width="512" height="512" fill="${BG}" />
  <g transform="translate(160 132) scale(0.78)">
    <rect width="512" height="512" rx="96" fill="${BG}" />
    <g transform="translate(106 84)">
      <path d="M222 80 a172 172 0 1 0 0 188" fill="none" stroke="${FG}" stroke-width="60" stroke-linecap="round" />
      <circle cx="244" cy="100" r="22" fill="${FG_DIM}" />
    </g>
  </g>
</svg>`;
}

/**
 * Service worker. Strategy:
 *   - Install: precache the app shell.
 *   - Navigation requests (`/`): network-first with cache fallback so the
 *     page updates without a hard refresh but still works offline.
 *   - Same-origin static (`/icon.svg`, `/manifest.webmanifest`, `/sw.js`):
 *     stale-while-revalidate.
 *   - Everything else (esm.sh modules, /api/..., /terminal/.../ws): network
 *     pass-through. We don't try to cache the xterm modules — they're
 *     versioned URLs from a CDN, and aggressive caching of API/WS would
 *     mask backend state.
 *
 * Cache name carries a version so bumps invalidate stale shells.
 */
export function serviceWorkerJs(): string {
  return `// clawdevbox PWA shell + push receiver
const CACHE = 'clawdevbox-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-maskable.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp') || url.pathname.startsWith('/terminal/')) return;

  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match('/')),
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        }).catch(() => cached);
        return cached || network;
      }),
    );
  }
});

// ----- Web Push --------------------------------------------------------
//
// Payload (set by the server in notifications.ts):
//   { title, body, url, icon, tag, require_interaction }
//
// Fallback: if the push service delivers an empty payload (some browsers
// strip it under data limits), we still show a generic "clawdevbox" toast
// rather than letting the push fizzle silently.
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try { payload = event.data.json(); } catch { /* not JSON */ }
  }
  const title = payload.title || 'clawdevbox';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon.svg',
    badge: '/icon.svg',
    tag: payload.tag || 'clawdevbox',
    data: { url: payload.url || '/' },
    requireInteraction: !!payload.require_interaction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tap-to-focus. If the app is already open, focus that tab; otherwise
// open a new one. Same-origin only so we never deep-link off our app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      const u = new URL(c.url);
      if (u.origin === self.location.origin) {
        try { await c.focus(); } catch {}
        try { await c.navigate(targetUrl); } catch {}
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});

// Pushed subscription change (key rotation / restore from backup). Tell
// the server about the new endpoint so we keep receiving pushes.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const r = await fetch('/api/push/vapid');
      const v = await r.json();
      if (!v.publicKey) return;
      const newSub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(v.publicKey),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(newSub.toJSON()),
      });
    } catch {
      /* best effort */
    }
  })());
});

function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
`;
}
