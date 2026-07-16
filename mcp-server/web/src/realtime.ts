/**
 * Real-time updates over `/api/events` (SSE). The browser EventSource
 * auto-reconnects with backoff if the connection drops — we only manage
 * topic-debounced refresh callbacks.
 */

import { useUiStore } from './stores/ui';

export function setupRealtime(): () => void {
  const store = useUiStore();
  let es: EventSource | null = null;
  const timers: Record<string, number | null> = {
    inbox: null, recipes: null, agent: null, tunnel: null, triggers: null, approvals: null, sessions: null,
  };

  function schedule(topic: keyof typeof timers, fn: () => void | Promise<void>): void {
    if (timers[topic] !== null) return;
    timers[topic] = window.setTimeout(() => {
      timers[topic] = null;
      void fn();
    }, 80);
  }

  function connect(): void {
    try { es?.close(); } catch { /* ignore */ }
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => {
      store.setLive('live');
      schedule('inbox', () => store.refreshInbox());
      schedule('recipes', () => store.refreshRecipes());
      schedule('agent', () => store.refreshAgent());
      schedule('tunnel', () => store.refreshTunnel());
      schedule('triggers', () => store.refreshTriggers());
      schedule('approvals', () => store.refreshApprovals());
    });
    es.addEventListener('change', (ev) => {
      let payload: { topic?: string };
      try { payload = JSON.parse((ev as MessageEvent).data || '{}'); } catch { return; }
      const t = payload.topic;
      if (t === 'inbox')     schedule('inbox', () => store.refreshInbox());
      if (t === 'recipes')   schedule('recipes', () => store.refreshRecipes());
      if (t === 'agent')     schedule('agent', () => store.refreshAgent());
      if (t === 'tunnel')    schedule('tunnel', () => store.refreshTunnel());
      if (t === 'triggers')  schedule('triggers', () => store.refreshTriggers());
      if (t === 'approvals') schedule('approvals', () => store.refreshApprovals());
      if (t === 'sessions')  schedule('sessions', () => store.refreshTerminals({ status: 'active' }));
      // 'notifications' is handled separately via refreshPush — most
      // pages don't need to react to it here.

      // Per-topic window events for components that observe directly
      // (e.g. SessionSidePanel re-fetches its data on sessions/recipes/
      // artifacts events without going through the Pinia store).
      if (typeof t === 'string') {
        try {
          window.dispatchEvent(new CustomEvent(`clawdevbox:sse:${t}`));
        } catch { /* ignore */ }
      }
    });
    es.onerror = () => store.setLive('offline');
  }
  connect();

  // Reconnect when the page becomes visible — mobile browsers freeze
  // background tabs and may not auto-reconnect promptly.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible' && (!es || es.readyState === 2)) connect();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    try { es?.close(); } catch { /* ignore */ }
    document.removeEventListener('visibilitychange', onVisible);
  };
}
