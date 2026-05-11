/**
 * pty-registry.ts
 *
 * In-memory registry of live recipe ptys, keyed by recipe_instance_id.
 * `recipe.run` spawns a hidden node-pty (no OS console window on Windows via
 * ConPTY) and hands the IPty to this registry. Browser clients can later
 * attach over the terminal-server HTTP/WS endpoint and stream live output,
 * send keystrokes, resize, or kill the agent — without leaking the spawn
 * details into every consumer.
 *
 * This is the smaller cousin of taskdock's TerminalService
 * (src/main/terminal/terminal-service.ts) — a single mode (interactive),
 * unified output stream, fixed scrollback. We keep the same vocabulary
 * (snapshot / data / exit) so the terminal-server WebSocket protocol
 * mirrors taskdock's.
 *
 * Lifecycle:
 *   register()        → store session, hook IPty.onData/onExit
 *   subscribe()       → start receiving live chunks; first delivers snapshot
 *   write/resize/kill → forward to underlying IPty
 *   onExit            → flush exit event to subscribers, mark `exited`
 *                       but keep session in map for `EXIT_RETAIN_MS` so
 *                       late attaches still see the tail
 */

import type { IPty } from 'node-pty';

// ============================================================================
// Tunables
// ============================================================================

/** Rolling output buffer kept per session for late-attach snapshots. */
const BUFFER_LIMIT_BYTES = 256 * 1024;

/** Hold exited sessions this long so a reconnecting viewer still sees the tail. */
const EXIT_RETAIN_MS = 10_000;

// ============================================================================
// Types
// ============================================================================

export type PtyServerEvent =
  | { type: 'snapshot'; content: string; cols: number; rows: number; exited: boolean; exitCode?: number }
  | { type: 'data'; chunk: string }
  | { type: 'exit'; exitCode: number; signal?: number };

export type PtySubscriber = (event: PtyServerEvent) => void;

export interface PtyRegisterOptions {
  instanceId: string;
  workspaceId: string;
  cols: number;
  rows: number;
  ipty: IPty;
}

interface PtySession {
  instanceId: string;
  workspaceId: string;
  ipty: IPty;
  cols: number;
  rows: number;
  buffer: string[];        // ring of recent chunks
  bufferBytes: number;     // approximate total bytes in buffer
  subscribers: Set<PtySubscriber>;
  exited: boolean;
  exitCode: number | null;
}

// ============================================================================
// Registry
// ============================================================================

const sessions = new Map<string, PtySession>();

/** Append a chunk to the ring buffer, dropping head entries while we're over the limit. */
function appendToBuffer(s: PtySession, chunk: string): void {
  s.buffer.push(chunk);
  s.bufferBytes += chunk.length;
  while (s.bufferBytes > BUFFER_LIMIT_BYTES && s.buffer.length > 1) {
    const head = s.buffer.shift();
    if (head !== undefined) s.bufferBytes -= head.length;
  }
}

export function registerPty(opts: PtyRegisterOptions): void {
  if (sessions.has(opts.instanceId)) {
    throw new Error(`pty session already registered for instance ${opts.instanceId}`);
  }
  const session: PtySession = {
    instanceId: opts.instanceId,
    workspaceId: opts.workspaceId,
    ipty: opts.ipty,
    cols: opts.cols,
    rows: opts.rows,
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    exited: false,
    exitCode: null,
  };
  sessions.set(opts.instanceId, session);

  opts.ipty.onData((data) => {
    appendToBuffer(session, data);
    for (const sub of session.subscribers) {
      try { sub({ type: 'data', chunk: data }); } catch { /* viewer drop */ }
    }
  });

  opts.ipty.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode ?? 0;
    for (const sub of session.subscribers) {
      try { sub({ type: 'exit', exitCode: exitCode ?? 0, signal }); } catch { /* viewer drop */ }
    }
    setTimeout(() => {
      // Drop the session only if no one is still hanging on.
      const s = sessions.get(opts.instanceId);
      if (s && s.exited && s.subscribers.size === 0) {
        sessions.delete(opts.instanceId);
      }
    }, EXIT_RETAIN_MS);
  });
}

export function hasSession(instanceId: string): boolean {
  return sessions.has(instanceId);
}

export function subscribe(
  instanceId: string,
  fn: PtySubscriber,
): { unsubscribe: () => void; sentSnapshot: boolean } {
  const s = sessions.get(instanceId);
  if (!s) return { unsubscribe: () => {}, sentSnapshot: false };
  s.subscribers.add(fn);
  try {
    fn({
      type: 'snapshot',
      content: s.buffer.join(''),
      cols: s.cols,
      rows: s.rows,
      exited: s.exited,
      exitCode: s.exitCode ?? undefined,
    });
  } catch { /* viewer drop */ }
  return {
    sentSnapshot: true,
    unsubscribe: () => {
      const cur = sessions.get(instanceId);
      if (!cur) return;
      cur.subscribers.delete(fn);
      if (cur.exited && cur.subscribers.size === 0) {
        sessions.delete(instanceId);
      }
    },
  };
}

export function writeToPty(instanceId: string, data: string): boolean {
  const s = sessions.get(instanceId);
  if (!s || s.exited) return false;
  s.ipty.write(data);
  return true;
}

export function resizePty(instanceId: string, cols: number, rows: number): boolean {
  const s = sessions.get(instanceId);
  if (!s || s.exited) return false;
  s.cols = cols;
  s.rows = rows;
  try {
    s.ipty.resize(cols, rows);
  } catch {
    return false;
  }
  return true;
}

export function killPty(instanceId: string, signal?: string): boolean {
  const s = sessions.get(instanceId);
  if (!s || s.exited) return false;
  try {
    s.ipty.kill(signal);
  } catch {
    return false;
  }
  return true;
}

export function listSessions(): { instanceId: string; workspaceId: string; exited: boolean }[] {
  return Array.from(sessions.values()).map((s) => ({
    instanceId: s.instanceId,
    workspaceId: s.workspaceId,
    exited: s.exited,
  }));
}
