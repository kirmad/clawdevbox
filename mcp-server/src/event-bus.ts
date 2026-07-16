/**
 * event-bus.ts
 *
 * One-line pub/sub for "something changed, clients should refetch":
 *
 *   emitChange('inbox')   →  every SSE subscriber gets { topic: 'inbox' }
 *
 * Topics are the noun the client cares about, not the operation. Coalescing
 * happens browser-side (debounced refetch). No payload — the client always
 * re-reads the source-of-truth endpoint (`/api/inbox`, `/api/recipes`,
 * `/api/main-agent/status`, `/api/tunnel/status`). That keeps the bus
 * trivial and avoids stale-state risk.
 */

import { EventEmitter } from 'node:events';

export type ChangeTopic =
  | 'inbox'
  | 'recipes'
  | 'agent'
  | 'tunnel'
  | 'notifications'
  | 'triggers'
  | 'approvals'
  | 'fires'
  | 'sessions'
  | 'artifacts'
  | 'daemons';

const bus = new EventEmitter();
// Many SSE clients can subscribe concurrently — lift the default 10 cap.
bus.setMaxListeners(0);

export function emitChange(topic: ChangeTopic): void {
  bus.emit('change', topic);
}

export function onChange(handler: (topic: ChangeTopic) => void): () => void {
  bus.on('change', handler);
  return () => bus.off('change', handler);
}

/**
 * Scoped artifact Q&A change signal, carrying the artifact id so a
 * per-artifact SSE stream (see terminal-server's `/artifact/<id>/qa/events`)
 * only pushes to viewers of THAT artifact. Emitted whenever a question or
 * answer is appended (qa-store). Kept separate from the topic bus above
 * because it needs a payload (the artifact id) rather than a broad noun.
 */
export function emitQaChange(artifactId: string): void {
  bus.emit('qa-change', artifactId);
}

export function onQaChange(handler: (artifactId: string) => void): () => void {
  bus.on('qa-change', handler);
  return () => bus.off('qa-change', handler);
}
