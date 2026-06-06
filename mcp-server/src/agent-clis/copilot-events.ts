/**
 * copilot-events.ts — idle-state watcher for GitHub Copilot CLI sessions.
 *
 * Copilot CLI writes a structured JSONL event stream to
 * `<copilotDir>/session-state/<sessionId>/events.jsonl`. Each line is a
 * JSON object with `{ type, id, parentId, timestamp, data }`. We use
 * this stream as the authoritative "is the agent ready for input" signal,
 * complementing (not replacing) the existing TUI snapshot/glyph wait.
 *
 * Idle definition (verified against agent-watch state machine + live
 * inspection of ~/.copilot/session-state/<uuid>/events.jsonl):
 *
 *   The agent is IDLE when the last status-bearing event is one of:
 *     - assistant.turn_end       (normal "ready for next prompt")
 *     - session.task_complete    (explicit task completion)
 *
 *   The agent is BUSY when the last status-bearing event is one of:
 *     - user.message             (we just sent input; agent will respond)
 *     - assistant.turn_start     (turn opened, no output yet)
 *     - assistant.message        (mid-turn streaming or tool-request emission)
 *     - tool.execution_start     (tool running; may emit more after)
 *     - subagent.started         (subagent running)
 *
 *   Neutral / non-status events (do NOT flip idle ↔ busy):
 *     - session.context_changed  (just a context update)
 *     - hook.start / hook.end    (hook events around tool runs)
 *     - session.start            (initial line — handled specially below)
 *
 *   Terminal-but-not-idle:
 *     - session.shutdown / abort / session.error  →  reason='terminal',
 *       caller should NOT send to a dead session.
 *
 * `tool.execution_complete` is NOT idle — the assistant typically emits
 * more content in the same turn after a tool finishes (final answer or
 * another tool call). Only `assistant.turn_end` is the safe idle signal.
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
