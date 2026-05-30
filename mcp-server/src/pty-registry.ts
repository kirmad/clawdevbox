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
import type { AgentCliProvider, AgentHandle } from './agent-clis/types.ts';
import { createSessionConductor, UnsupportedProviderError, type SessionConductor } from './agent-clis/session-conductor.ts';
import { emitChange } from './event-bus.ts';
import { logger } from './logger.ts';

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

/**
 * Lightweight metadata captured at spawn time and surfaced in the terminal
 * viewer header so a human reattaching to a running pty can see WHAT shell
 * is in the pane, WHERE it was started, and WHICH recipe/session/agent it
 * belongs to without grepping logs.
 *
 * All fields are best-effort — registerPty() takes them as `meta?` and
 * older call sites (e.g. the playwright fixture) can still register without
 * meta. The terminal-server then falls back to on-disk recipe-instance state
 * for archived sessions.
 */
export interface PtySessionMeta {
  /** Working directory the pty was spawned in (absolute path). */
  cwd?: string;
  /** Command line as a single human-readable string, e.g. `claude --resume sess_x`. */
  commandLine?: string;
  /** Provider id (e.g. `copilot`, `claude`, `agency`). */
  agentCli?: string;
  /** Agent session id (recipe.run's sessionId — not the recipe_instance_id). */
  sessionId?: string;
  /** Recipe id (slug) if this pty backs a recipe instance. */
  recipeId?: string;
  /** Epoch ms when registerPty was called. */
  startedAt: number;
}

export interface PtyRegisterOptions {
  instanceId: string;
  workspaceId: string;
  cols: number;
  rows: number;
  ipty: IPty;
  meta?: Omit<PtySessionMeta, 'startedAt'>;
  /**
   * Provider that spawned this pty. Required for the registry to build a
   * SessionConductor. When omitted, the session has no conductor and
   * getConductor(instanceId) returns null. Legacy callers (playwright
   * fixture, raw test harnesses) can still register without this.
   */
  provider?: AgentCliProvider;
  /**
   * Agent handle whose .pty is `ipty`. Required iff `provider` is provided —
   * the conductor needs handle.exited to track the exited state transition.
   */
  agentHandle?: AgentHandle;
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
  meta: PtySessionMeta;
  conductor: SessionConductor | null;
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
    meta: { ...(opts.meta ?? {}), startedAt: Date.now() },
    conductor: null,
  };

  let conductor: SessionConductor | null = null;
  if (opts.provider && opts.agentHandle) {
    try {
      conductor = createSessionConductor({
        handle: opts.agentHandle,
        provider: opts.provider,
        role: opts.instanceId,
      });
    } catch (err) {
      // UnsupportedProviderError is expected: provider lacks capabilities
      // or writePrompt (e.g. echo-stub). The session remains valid for
      // raw terminal viewing — the caller just can't dispatch through
      // the conductor API. Anything else is unexpected and worth a log:
      // the handle could be malformed (closed pty, missing exited
      // thenable, etc.) and silently returning null hides that.
      if (err instanceof UnsupportedProviderError) {
        conductor = null;
      } else {
        logger.warn(
          {
            instance_id: opts.instanceId,
            provider_id: opts.provider.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'pty-registry: unexpected error creating SessionConductor; session will have no conductor',
        );
        conductor = null;
      }
    }
  }
  session.conductor = conductor;

  sessions.set(opts.instanceId, session);
  emitChange('sessions');

  opts.ipty.onData((data) => {
    appendToBuffer(session, data);
    for (const sub of session.subscribers) {
      try { sub({ type: 'data', chunk: data }); } catch { /* viewer drop */ }
    }
  });

  opts.ipty.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode ?? 0;
    if (session.conductor) {
      try { session.conductor.dispose(); } catch { /* idempotent */ }
    }
    for (const sub of session.subscribers) {
      try { sub({ type: 'exit', exitCode: exitCode ?? 0, signal }); } catch { /* viewer drop */ }
    }
    emitChange('sessions');
    setTimeout(() => {
      // Drop the session only if no one is still hanging on.
      const s = sessions.get(opts.instanceId);
      if (s && s.exited && s.subscribers.size === 0) {
        sessions.delete(opts.instanceId);
        emitChange('sessions');
      }
    }, EXIT_RETAIN_MS);
  });
}

export function hasSession(instanceId: string): boolean {
  return sessions.has(instanceId);
}

/**
 * Return the metadata captured at register time for `instanceId`, or null
 * if the pty has fully exited and been garbage-collected. Used by the
 * terminal viewer to populate the header with cwd / command / session.
 */
export function getSessionMeta(instanceId: string): PtySessionMeta | null {
  const s = sessions.get(instanceId);
  return s ? s.meta : null;
}

/**
 * Return the SessionConductor for `instanceId`, or null if:
 *  - the session is unknown,
 *  - the session was registered without a provider+agentHandle pair, or
 *  - the provider didn't declare capabilities/writePrompt (conductor creation threw).
 */
export function getConductor(instanceId: string): SessionConductor | null {
  const s = sessions.get(instanceId);
  return s ? s.conductor : null;
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
