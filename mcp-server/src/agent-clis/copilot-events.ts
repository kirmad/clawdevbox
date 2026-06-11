/**
 * copilot-events.ts — idle-state watcher for GitHub Copilot CLI sessions.
 *
 * Copilot CLI writes a structured JSONL event stream to
 * `<copilotDir>/session-state/<sessionId>/events.jsonl`. Each line is a
 * JSON object with `{ type, id, parentId, timestamp, data }`. We use
 * this stream as the authoritative "is the agent ready for input" signal
 * for FOLLOW-UP dispatches (the seed prompt is delivered via the CLI's
 * own argv hook — `copilot -i <prompt>` / `claude <prompt>` — so it does
 * not need an idle gate).
 *
 * Idle definition (verified against agent-watch state machine + live
 * inspection of ~/.copilot/session-state/<uuid>/events.jsonl):
 *
 *   IDLE when the last status-bearing event is one of:
 *     - assistant.turn_end       (normal "ready for next prompt")
 *     - session.task_complete    (explicit task completion)
 *
 *   BUSY when the last status-bearing event is one of:
 *     - user.message, assistant.turn_start, assistant.message
 *     - tool.execution_start, subagent.started, skill.invoked
 *     - session.compaction_start
 *
 *   TERMINAL: session.shutdown / abort / session.error  →  caller should NOT
 *   send to a dead session.
 *
 * Everything else is NEUTRAL (does NOT flip the state).
 */

import {
  existsSync, statSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleepP } from 'node:timers/promises';
import { logger } from '../logger.ts';

export type IdleReason = 'idle' | 'timeout' | 'terminal' | 'unknown-session';
export interface WaitForIdleOpts {
  /** Override the copilot root dir (default $USERPROFILE/.copilot). */
  copilotDir?: string;
  /** Hard timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Poll interval for file existence + tail check (default 200ms). */
  pollIntervalMs?: number;
  /**
   * Settle window: once idle is detected, observe the stream for this many
   * ms with no busy/terminal transition before resolving. Catches the rare
   * race where assistant.turn_end is followed by a new assistant.turn_start
   * (e.g. agent self-restarts a turn). Default 150ms.
   */
  settleMs?: number;
}

export interface WaitForIdleResult {
  ready: boolean;
  reason: IdleReason;
  lastEvent?: string;
  /** ms spent waiting. */
  waitedMs: number;
}

/** Set of event types that flip the agent into BUSY. */
const BUSY_EVENTS = new Set([
  'user.message',
  'assistant.turn_start',
  'assistant.message',
  'tool.execution_start',
  'subagent.started',
  // Discovered via real-session replay (validate-events-classifier.mjs):
  // - skill.invoked: agent is loading/running a skill mid-turn.
  // - session.compaction_start: agent is compacting context history; pty
  //   is unresponsive until compaction_complete fires. Sending input here
  //   would land in the wrong context.
  'skill.invoked',
  'session.compaction_start',
]);

/** Set of event types that mean "agent finished a turn — ready for next input". */
const IDLE_EVENTS = new Set([
  'assistant.turn_end',
  'session.task_complete',
]);

/** Session has exited or errored — caller should not try to send. */
const TERMINAL_EVENTS = new Set([
  'session.shutdown',
  'session.error',
  'abort',
]);

/**
 * Events we deliberately ignore for idle/busy classification.
 *
 * The expanded set was discovered by replaying 42,555 real events across
 * 9 days of Copilot sessions (`scripts/validate-events-classifier.mjs`).
 * Categories:
 *   - Tool/subagent lifecycle complementary events (we treat the *_start
 *     as busy and ignore *_complete because the assistant may continue
 *     emitting in the same turn).
 *   - Hook events (always fire around tool calls, neutral wrt turn state).
 *   - System messages / notifications / info / warnings (diagnostic only,
 *     not turn state).
 *   - Context-management events (workspace_file_changed, plan_changed,
 *     mode_changed, truncation, compaction_complete) — these don't tell
 *     us anything about the turn state.
 *   - subagent.failed — failure of one subagent doesn't necessarily end
 *     the parent's turn; we wait for assistant.turn_end as the authority.
 */
const NEUTRAL_EVENTS = new Set([
  'session.context_changed',
  'hook.start',
  'hook.end',
  'tool.execution_complete',  // assistant may continue same turn after
  'subagent.completed',
  'subagent.failed',
  'session.start',
  'session.resume',
  'system.message',
  'system.notification',
  'session.workspace_file_changed',
  'session.plan_changed',
  'session.info',
  'session.warning',
  'session.compaction_complete',
  'session.truncation',
  'session.mode_changed',
]);

interface ParsedEvent {
  type: string;
  timestamp?: string;
}

function defaultCopilotDir(): string {
  return process.env.COPILOT_DIR ?? join(homedir(), '.copilot');
}

export function eventsJsonlPath(sessionId: string, copilotDir?: string): string {
  return join(copilotDir ?? defaultCopilotDir(), 'session-state', sessionId, 'events.jsonl');
}

/**
 * Read the last `maxBytes` of the events.jsonl file as parsed events.
 * Tolerates a truncated leading partial line.
 */
function tailEvents(path: string, maxBytes = 64 * 1024): ParsedEvent[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Drop leading partial line if we didn't read from offset 0.
    const lines = (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
    const out: ParsedEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as ParsedEvent;
        if (typeof obj?.type === 'string') out.push(obj);
      } catch { /* incomplete line */ }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * Classify the most-recent status-bearing event into idle/busy/terminal.
 * Returns null when no status-bearing event has happened yet (e.g. the
 * file only contains session.start / session.context_changed).
 */
function classifyTail(events: ParsedEvent[]):
  | { kind: 'idle' | 'busy' | 'terminal'; lastEvent: string }
  | null
{
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const t = events[i]!.type;
    if (TERMINAL_EVENTS.has(t)) return { kind: 'terminal', lastEvent: t };
    if (BUSY_EVENTS.has(t)) return { kind: 'busy', lastEvent: t };
    if (IDLE_EVENTS.has(t)) return { kind: 'idle', lastEvent: t };
    if (NEUTRAL_EVENTS.has(t)) continue;
    // Unknown event types are treated as neutral — Copilot may emit new
    // ones we don't recognize, and we shouldn't falsely flip busy.
  }
  return null;
}

/**
 * Wait until the agent's events.jsonl shows it's idle (or terminal/timeout).
 *
 * Uses polling rather than fs.watch — fs.watch on Windows is flaky for
 * append-only files in some configurations, and polling every 200ms is
 * cheap (we only tail the last 64 KB).
 */
export async function waitForCopilotIdle(
  sessionId: string,
  opts: WaitForIdleOpts = {},
): Promise<WaitForIdleResult> {
  const path = eventsJsonlPath(sessionId, opts.copilotDir);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollIntervalMs ?? 200;
  const settleMs = opts.settleMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let idleSince: number | null = null;
  let lastEventSeen: string | undefined;

  while (Date.now() < deadline) {
    const events = tailEvents(path);
    const cls = classifyTail(events);
    if (cls === null) {
      // File missing OR only contains pre-status events. Wait + poll.
      idleSince = null;
      await sleepP(pollMs);
      continue;
    }
    lastEventSeen = cls.lastEvent;
    if (cls.kind === 'terminal') {
      return { ready: false, reason: 'terminal', lastEvent: cls.lastEvent,
               waitedMs: Date.now() - startedAt };
    }
    if (cls.kind === 'busy') {
      idleSince = null;
      await sleepP(pollMs);
      continue;
    }
    // cls.kind === 'idle' — start/continue the settle window.
    if (idleSince === null) idleSince = Date.now();
    if (Date.now() - idleSince >= settleMs) {
      return { ready: true, reason: 'idle', lastEvent: cls.lastEvent,
               waitedMs: Date.now() - startedAt };
    }
    await sleepP(pollMs);
  }

  logger.warn({ sessionId, lastEventSeen, timeoutMs },
    'copilot-events: waitForIdle timed out');
  return { ready: false, reason: 'timeout', lastEvent: lastEventSeen,
           waitedMs: Date.now() - startedAt };
}

/**
 * Read-only one-shot: is the agent currently idle? Returns false on
 * unknown / file-missing / busy / terminal. Used for fast-path checks
 * by callers that don't want to block.
 */
export function isCopilotIdleNow(sessionId: string, copilotDir?: string): boolean {
  const path = eventsJsonlPath(sessionId, copilotDir);
  if (!existsSync(path)) return false;
  const cls = classifyTail(tailEvents(path));
  return cls?.kind === 'idle';
}

// ---------------------------------------------------------------------------
// Live status watcher (drives the tab indicator)
// ---------------------------------------------------------------------------

/**
 * Fine-grained UI states derived from the events stream.
 *
 * `idle`     — agent finished its turn, ready for next input
 * `thinking` — assistant.turn_start or assistant.message (no tool block)
 * `tool_use` — tool.execution_start, subagent.started, skill.invoked
 * `waiting`  — agent self-reported needs_user_input (set elsewhere, NOT here)
 * `error`    — session.error / session.shutdown(non-routine) / abort
 *
 * Note: `waiting` is NOT emitted by this watcher because it requires
 * agent self-reporting via the update_status MCP tool. The UI combines
 * `derived_state` with `needs_user_input` and prefers the latter when set.
 */
export type DerivedState = 'idle' | 'thinking' | 'tool_use' | 'error';

const THINKING_EVENTS = new Set([
  'assistant.turn_start',
  'assistant.message',
  'user.message',         // we just sent input — agent is about to think
  'session.compaction_start',
]);

const TOOL_USE_EVENTS = new Set([
  'tool.execution_start',
  'subagent.started',
  'skill.invoked',
]);

/**
 * Classify the most recent status-bearing event into a fine-grained
 * UI state. Returns null when no classifiable event has happened yet.
 *
 * Walks the tail backward and returns on the first matching event.
 * Same precedence as `classifyTail`: terminal > tool_use > thinking > idle,
 * which matches what an operator would see (a tool execution that hasn't
 * completed beats a stale assistant.message earlier in the stream).
 */
function classifyTailForUi(events: ParsedEvent[]):
  | { state: DerivedState; lastEvent: string }
  | null
{
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const t = events[i]!.type;
    if (TERMINAL_EVENTS.has(t)) return { state: 'error', lastEvent: t };
    if (TOOL_USE_EVENTS.has(t)) return { state: 'tool_use', lastEvent: t };
    if (THINKING_EVENTS.has(t)) return { state: 'thinking', lastEvent: t };
    if (IDLE_EVENTS.has(t)) return { state: 'idle', lastEvent: t };
    // Skip NEUTRAL_EVENTS and unknown types.
  }
  return null;
}

export interface WatchOpts {
  copilotDir?: string;
  /** Poll interval ms (default 250). */
  pollIntervalMs?: number;
  /** Minimum gap between consecutive emissions of the SAME state (default 0 — always emit on change). */
  debounceMs?: number;
}

export interface StatusWatcher {
  /** Stop polling. Idempotent. */
  stop(): void;
  /** Current derived state (last emitted), or null if never seen one. */
  current(): { state: DerivedState; lastEvent: string } | null;
}

/**
 * Start a long-lived watcher on a Copilot session's events.jsonl.
 *
 * Calls `onChange` exactly when the derived state transitions to a NEW
 * value. The watcher is the source of truth for the live UI dot:
 *   - polls every 250ms (cheap — tails last 64 KB only)
 *   - reads the same idle/busy classifier as `waitForCopilotIdle` so the
 *     two stay consistent
 *   - tolerates the file not existing yet (newly-spawned sessions)
 *
 * Caller MUST call `.stop()` when the agent session ends. Otherwise the
 * watcher keeps polling forever (small but real leak — ~1 stat + 1 read
 * per session per 250 ms).
 *
 * Returns the watcher handle synchronously; the first poll runs after
 * one pollIntervalMs delay (not immediately) so callers can attach
 * other state without racing the first emission.
 */
export function watchCopilotStatus(
  sessionId: string,
  onChange: (s: { state: DerivedState; lastEvent: string }) => void,
  opts: WatchOpts = {},
): StatusWatcher {
  const path = eventsJsonlPath(sessionId, opts.copilotDir);
  const pollMs = opts.pollIntervalMs ?? 250;
  let stopped = false;
  let last: { state: DerivedState; lastEvent: string } | null = null;

  const tick = (): void => {
    if (stopped) return;
    try {
      const events = tailEvents(path);
      const cls = classifyTailForUi(events);
      if (cls && (!last || last.state !== cls.state)) {
        last = cls;
        try { onChange(cls); } catch (err) {
          logger.warn({ err: String(err), sessionId },
            'copilot-events: watcher onChange threw');
        }
      }
    } catch (err) {
      // tailEvents may throw if the file disappears mid-read. Log + retry.
      logger.debug({ err: String(err), sessionId },
        'copilot-events: tail failed, will retry');
    } finally {
      if (!stopped) setTimeout(tick, pollMs).unref();
    }
  };

  setTimeout(tick, pollMs).unref();

  return {
    stop(): void { stopped = true; },
    current(): { state: DerivedState; lastEvent: string } | null { return last; },
  };
}