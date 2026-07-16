// mcp-server/src/cli-sessions/wait-for-ready.ts
/**
 * Snapshot-poll readiness gate for tmux-backed CLI sessions.
 *
 * Replaces the byte-stream `deliverInitialPromptWhenReady` helper from the
 * IPty era. In the tmux model, agent output isn't observable via raw bytes
 * (xterm.js viewers go through `tmux attach`, not the agent fd), so we poll
 * `tmux capture-pane` snapshots via `CliSession.snapshot()` instead.
 *
 * Used by the dispatcher's first-dispatch flow: after a fresh provider
 * spawn, wait for the prompt-ready glyph (and optionally a fully-rendered
 * indicator like the model line) to be visible on a stable snapshot, then
 * deliver the initial prompt as a regular dispatch.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { CliSession } from './types.ts';

export interface WaitForReadyOpts {
  /** Required: must match the rendered prompt-ready glyph on the snapshot. */
  promptReadyRegex: RegExp;
  /**
   * Optional: must ALSO match before the stable timer starts. Useful for
   * gating on a fully-rendered TUI (e.g. the "context (N%)" model line in
   * Copilot's status bar — `❯` appears earlier during splash transitions).
   */
  fullyRenderedRegex?: RegExp;
  /** How often to call `snapshot()`. Default 500ms. */
  pollIntervalMs?: number;
  /**
   * How long both regexes must keep matching on consecutive polls before
   * we declare ready. Default 2500ms.
   */
  stableMs?: number;
  /** Overall timeout. Default 90s. */
  timeoutMs?: number;
}

/**
 * Poll `session.snapshot()` until `promptReadyRegex` (and optionally
 * `fullyRenderedRegex`) both match for `stableMs` of consecutive polls.
 * Resolves with `'ready'` or rejects with a timeout error.
 *
 * The stable-window logic: every time a poll returns a non-matching snapshot
 * the `stableSince` timestamp resets. Only when polls match continuously for
 * `stableMs` do we return.
 */
export async function waitForReady(
  session: CliSession,
  opts: WaitForReadyOpts,
): Promise<'ready'> {
  const pollMs = opts.pollIntervalMs ?? 500;
  const stableMs = opts.stableMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  let stableSince: number | null = null;

  while (Date.now() - start < timeoutMs) {
    const snap = await session.snapshot();
    const ready =
      opts.promptReadyRegex.test(snap) &&
      (!opts.fullyRenderedRegex || opts.fullyRenderedRegex.test(snap));
    if (ready) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= stableMs) return 'ready';
    } else {
      stableSince = null;
    }
    await sleep(pollMs);
  }
  throw new Error(`waitForReady: timed out after ${timeoutMs}ms`);
}
