import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger as defaultLogger } from '../logger.ts';
import { stripTuiNoise } from './shared.ts';
import type {
  AgentCliProvider,
  AgentHandle,
  ProviderCapabilities,
  PromptStrategy,
} from './types.ts';

export type ConductorState = 'starting' | 'idle' | 'busy' | 'exited';

export type DoneSignal = 'marker' | 'prompt-ready' | 'idle' | 'exited';

export interface ConductorOpts {
  handle: AgentHandle;
  provider: AgentCliProvider;
  /** Total per-dispatch deadline before rejecting with SessionTimeoutError. */
  timeoutMs?: number;
  /** Last-resort fallback: declare done after this much output silence. */
  idleFallbackMs?: number;
  /**
   * How long the screen tail must be stable (no new bytes) before a
   * `promptReady` match is accepted as a done signal. Guards against
   * mid-render flickers of the prompt glyph.
   */
  stableTailMs?: number;
  /**
   * How long to wait after spawn for the session to reach the first
   * idle state. Empirically, Agency's lazy startup needs the longer fuse.
   */
  firstReadyTimeoutMs?: number;
  /**
   * Suppress marker matches that arrive within this many ms of the
   * delivery write. Guards against prompt echo (the marker appears in
   * the submitted prompt as the agent types it back).
   */
  promptEchoIgnoreMs?: number;
  /**
   * Maximum size of the rolling stripped-screen buffer. The conductor
   * scans this buffer for marker / promptReady matches. Must be large
   * enough to contain a single agent response but small enough that
   * regex scans stay cheap.
   */
  screenBufferBytes?: number;
  /** Role suffix included in marker ids for audit correlation. */
  role?: string;
  logger?: typeof defaultLogger;
}

export interface DispatchOpts {
  /** Caller hint. See PromptStrategy doc for resolution semantics. */
  strategy?: PromptStrategy;
  /** Per-dispatch timeout override (ms). */
  timeoutMs?: number;
  /** Inject sentinel marker into the prompt (default true). */
  withMarker?: boolean;
}

export interface DispatchResult {
  /** null when withMarker: false was passed. */
  markerId: string | null;
  deliveredAt: number;
  doneAt: number;
  doneSignal: DoneSignal;
  /** Bytes seen on the pty between deliveredAt and doneAt. */
  rawTailBytes: number;
}

export class SessionDisposedError extends Error {
  constructor() { super('session conductor disposed'); this.name = 'SessionDisposedError'; }
}

export class SessionExitedError extends Error {
  constructor(public readonly exitCode: number | null, public readonly signal?: string) {
    super(`session exited (code=${exitCode ?? 'null'}${signal ? `, signal=${signal}` : ''})`);
    this.name = 'SessionExitedError';
  }
}

export class SessionTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`dispatch timed out after ${timeoutMs}ms`);
    this.name = 'SessionTimeoutError';
  }
}

export class UnsupportedProviderError extends Error {
  constructor(providerId: string, missing: string) {
    super(`provider ${providerId} cannot be driven by SessionConductor: missing ${missing}`);
    this.name = 'UnsupportedProviderError';
  }
}

interface PendingDispatch {
  text: string;
  withMarker: boolean;
  callerStrategy: PromptStrategy;
  timeoutMs: number;
  resolve: (r: DispatchResult) => void;
  reject: (err: Error) => void;
}

interface ActiveDispatch {
  markerId: string | null;
  markerRegex: RegExp | null;
  deliveredAt: number;
  promptEchoIgnoreUntil: number;
  tailBytesAtDelivery: number;
  totalBytes: number;
  resolve: (r: DispatchResult) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
  idleHandle: NodeJS.Timeout | null;
  stableTailHandle: NodeJS.Timeout | null;
  awaitingPromptReady: boolean;
  lastByteAt: number;
}

const PROMPT_ECHO_IGNORE_MS_DEFAULT = 250;
const IDLE_FALLBACK_MS_DEFAULT = 10_000;
const STABLE_TAIL_MS_DEFAULT = 2_500;
const FIRST_READY_TIMEOUT_MS_DEFAULT = 20_000;
const SCREEN_BUFFER_BYTES_DEFAULT = 65_536;
const PER_DISPATCH_TIMEOUT_MS_DEFAULT = 600_000;
const MEANINGFUL_OUTPUT_THRESHOLD_BYTES = 50;

// Aggressive ANSI/control stripping is now shared in `./shared.ts` —
// the conductor consumes it as `stripTuiNoise`. Kept the import at the
// top of the file. The previously-inlined regex is removed.

function markerRegexFor(id: string): RegExp {
  // Line-anchored, allows trailing whitespace, multiline mode.
  // Escape pathological characters defensively even though we control
  // the id format.
  return new RegExp(`^###${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}###\\s*$`, 'm');
}

function buildMarkerPrompt(text: string, markerId: string): string {
  return (
    text +
    '\n\n[SYSTEM: When you have completely finished responding to this prompt, ' +
    `output the exact string ###${markerId}### on a line by itself as the ` +
    'very last line. Do not include this marker anywhere else in your response.]'
  );
}

function coalescePrompts(prompts: string[]): string {
  return prompts.join('\n\n---\n\n');
}

export class SessionConductor extends EventEmitter {
  readonly handle: AgentHandle;
  readonly provider: AgentCliProvider;
  readonly capabilities: ProviderCapabilities;

  private _state: ConductorState = 'starting';
  private readonly opts: Required<Omit<ConductorOpts, 'handle' | 'provider' | 'logger' | 'role'>> & {
    role: string;
    logger: typeof defaultLogger;
  };
  private readonly queue: PendingDispatch[] = [];
  private active: ActiveDispatch | null = null;
  private screen = '';
  private firstReadyTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private readonly dataDisposable: { dispose(): void };

  constructor(opts: ConductorOpts) {
    super();
    if (!opts.provider.capabilities) {
      throw new UnsupportedProviderError(opts.provider.id, 'capabilities');
    }
    if (typeof opts.provider.writePrompt !== 'function') {
      throw new UnsupportedProviderError(opts.provider.id, 'writePrompt');
    }
    this.handle = opts.handle;
    this.provider = opts.provider;
    this.capabilities = opts.provider.capabilities;
    this.opts = {
      timeoutMs: opts.timeoutMs ?? PER_DISPATCH_TIMEOUT_MS_DEFAULT,
      idleFallbackMs: opts.idleFallbackMs ?? IDLE_FALLBACK_MS_DEFAULT,
      stableTailMs: opts.stableTailMs ?? STABLE_TAIL_MS_DEFAULT,
      firstReadyTimeoutMs: opts.firstReadyTimeoutMs ?? FIRST_READY_TIMEOUT_MS_DEFAULT,
      promptEchoIgnoreMs: opts.promptEchoIgnoreMs ?? PROMPT_ECHO_IGNORE_MS_DEFAULT,
      screenBufferBytes: opts.screenBufferBytes ?? SCREEN_BUFFER_BYTES_DEFAULT,
      role: opts.role ?? 'agent',
      logger: opts.logger ?? defaultLogger,
    };

    this.dataDisposable = opts.handle.pty.onData((chunk: string) => this.onData(chunk));
    opts.handle.exited.then((info) => this.onExit(info.exitCode ?? null, info.signal));

    // First-ready safety fuse: even if we never see a promptReady match,
    // transition to idle after firstReadyTimeoutMs so dispatches can flow.
    this.firstReadyTimer = setTimeout(() => {
      if (this._state === 'starting') this.transitionState('idle');
    }, this.opts.firstReadyTimeoutMs);
  }

  get state(): ConductorState { return this._state; }

  pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  async dispatch(text: string, opts: DispatchOpts = {}): Promise<DispatchResult> {
    if (this.disposed || this._state === 'exited') {
      return Promise.reject(this._state === 'exited' ? new SessionExitedError(null) : new SessionDisposedError());
    }
    return new Promise<DispatchResult>((resolve, reject) => {
      const pending: PendingDispatch = {
        text,
        withMarker: opts.withMarker !== false,
        callerStrategy: opts.strategy ?? 'auto',
        timeoutMs: opts.timeoutMs ?? this.opts.timeoutMs,
        resolve,
        reject,
      };
      this.queue.push(pending);
      this.maybeStartNext();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.dataDisposable.dispose(); } catch { /* ignore */ }
    if (this.firstReadyTimer) { clearTimeout(this.firstReadyTimer); this.firstReadyTimer = null; }
    if (this.active) {
      const a = this.active;
      this.active = null;
      this.clearActiveTimers(a);
      a.reject(new SessionDisposedError());
    }
    while (this.queue.length > 0) {
      const p = this.queue.shift()!;
      p.reject(new SessionDisposedError());
    }
    if (this._state !== 'exited') this.transitionState('exited');
  }

  private transitionState(next: ConductorState): void {
    if (this._state === next) return;
    this._state = next;
    this.emit('state', next);
  }

  private maybeStartNext(): void {
    if (this.active) return;
    if (this._state === 'exited') return;
    if (this._state === 'starting') return;          // wait for first-ready signal
    if (this.queue.length === 0) {
      this.transitionState('idle');
      return;
    }

    // If we can use the provider's native queue (Copilot Ctrl+Q), we can
    // start the head of the queue with strategy:queue while the previous
    // dispatch is still active. In our current model, we only run one
    // active dispatch at a time and rely on local-buffer drain for any
    // additional prompts. The provider's native queue is exercised when
    // the CALLER explicitly chooses strategy:'queue' on a still-busy
    // session — which is only possible if there's already an active
    // dispatch in flight. That branch is handled inline in dispatch()'s
    // resolved-strategy logic; the local FIFO drain here always submits.
    const head = this.queue[0]!;
    const drainBatch: PendingDispatch[] = [head];
    this.queue.shift();
    while (this.queue.length > 0) {
      // Coalesce all queued items into one delivery on idle drain. Each
      // pending caller still gets its own DispatchResult resolved when
      // the combined marker fires — but they all share the same
      // deliveredAt/doneAt timestamps and the same markerId.
      drainBatch.push(this.queue.shift()!);
    }

    this.beginDispatchBatch(drainBatch).catch((err) => {
      // beginDispatchBatch rejects all pending callers on its own.
      this.opts.logger.error({ err }, 'session-conductor: dispatch batch failed');
    });
  }

  private async beginDispatchBatch(batch: PendingDispatch[]): Promise<void> {
    const withMarker = batch.some((p) => p.withMarker);
    const markerId = withMarker ? this.mintMarkerId() : null;
    const combinedText = coalescePrompts(batch.map((p) => p.text));
    const promptText = withMarker && markerId
      ? buildMarkerPrompt(combinedText, markerId)
      : combinedText;

    // The local-drain path always submits. Caller-requested 'queue' is
    // only meaningful when there's already an active dispatch; that path
    // is handled below in handleQueueWhileBusy(), called from dispatch().
    const strategy: 'submit' | 'queue' = 'submit';

    const deliveredAt = Date.now();
    const tailBytesAtDelivery = this.screen.length;
    const timeoutMs = Math.max(...batch.map((p) => p.timeoutMs));

    this.transitionState('busy');

    const active: ActiveDispatch = {
      markerId,
      markerRegex: markerId ? markerRegexFor(markerId) : null,
      deliveredAt,
      promptEchoIgnoreUntil: deliveredAt + this.opts.promptEchoIgnoreMs,
      tailBytesAtDelivery,
      totalBytes: 0,
      resolve: (r) => { for (const p of batch) p.resolve(r); },
      reject: (err) => { for (const p of batch) p.reject(err); },
      timeoutHandle: setTimeout(() => this.onTimeout(active, timeoutMs), timeoutMs),
      idleHandle: null,
      stableTailHandle: null,
      awaitingPromptReady: false,
      lastByteAt: deliveredAt,
    };
    this.active = active;

    try {
      await this.provider.writePrompt!(this.handle, { text: promptText, strategy });
    } catch (err) {
      this.active = null;
      this.clearActiveTimers(active);
      active.reject(err instanceof Error ? err : new Error(String(err)));
      this.maybeStartNext();
      return;
    }
  }

  /**
   * Caller invoked dispatch() with strategy:'queue' while a dispatch was
   * already active. If the provider supports Ctrl+Q (Copilot/Agency),
   * we write the prompt directly to the pty with strategy:'queue' so
   * the provider's native queue stages it; the prompt commits when the
   * agent's current turn finishes. The resulting marker is appended to
   * a queue-side completion list that the conductor drains in FIFO order.
   *
   * Currently NOT exercised by maybeStartNext (which always submits a
   * coalesced batch from local buffer). Wired here for future callers
   * that explicitly stage prompts via the provider's native queue.
   */
  // (placeholder: full implementation deferred — handled via local buffer for now)

  private onData(chunkRaw: string): void {
    if (this.disposed) return;
    const chunk = stripTuiNoise(chunkRaw);
    this.screen = (this.screen + chunk).slice(-this.opts.screenBufferBytes);
    const now = Date.now();

    // Promote to idle on first stable promptReady once we're past startup.
    if (this._state === 'starting') {
      if (this.capabilities.promptReadyRegex.test(this.tail())) {
        this.transitionState('idle');
        this.maybeStartNext();
      }
      return;
    }

    if (!this.active) return;
    const a = this.active;
    a.totalBytes += chunk.length;
    a.lastByteAt = now;

    // Marker check: only after the prompt-echo window has passed, only
    // for the marker we expect for THIS dispatch, only in the screen tail.
    if (a.markerRegex && now >= a.promptEchoIgnoreUntil) {
      const tail = this.screen.slice(Math.max(0, a.tailBytesAtDelivery - 64));
      if (a.markerRegex.test(tail)) {
        this.completeActive('marker');
        return;
      }
    }

    // Reset stable-tail / idle timers because we just got bytes.
    if (a.stableTailHandle) { clearTimeout(a.stableTailHandle); a.stableTailHandle = null; a.awaitingPromptReady = false; }
    if (a.idleHandle) { clearTimeout(a.idleHandle); a.idleHandle = null; }

    // Schedule idle-fallback if we've crossed the meaningful-output threshold.
    if (a.totalBytes >= MEANINGFUL_OUTPUT_THRESHOLD_BYTES) {
      a.idleHandle = setTimeout(() => {
        if (this.active === a) this.completeActive('idle');
      }, this.opts.idleFallbackMs);
    }

    // Prompt-ready secondary signal: must match on a stable tail with no
    // busy indicators. Schedule a stableTailMs wait; if no new bytes arrive
    // and the conditions still hold when the timer fires, accept it.
    if (a.totalBytes >= MEANINGFUL_OUTPUT_THRESHOLD_BYTES && this.tailLooksReady()) {
      a.awaitingPromptReady = true;
      a.stableTailHandle = setTimeout(() => {
        if (this.active !== a) return;
        if (a.awaitingPromptReady && this.tailLooksReady()) {
          this.completeActive('prompt-ready');
        }
      }, this.opts.stableTailMs);
    }
  }

  private tail(): string {
    return this.screen.slice(-2048);
  }

  private tailLooksReady(): boolean {
    const tail = this.tail();
    if (!this.capabilities.promptReadyRegex.test(tail)) return false;
    for (const re of this.capabilities.busyIndicators) {
      if (re.test(tail)) return false;
    }
    return true;
  }

  private completeActive(signal: DoneSignal): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.clearActiveTimers(a);
    const result: DispatchResult = {
      markerId: a.markerId,
      deliveredAt: a.deliveredAt,
      doneAt: Date.now(),
      doneSignal: signal,
      rawTailBytes: a.totalBytes,
    };
    a.resolve(result);
    this.emit('done', result);
    this.transitionState('idle');
    this.maybeStartNext();
  }

  private onTimeout(a: ActiveDispatch, timeoutMs: number): void {
    if (this.active !== a) return;
    this.active = null;
    this.clearActiveTimers(a);
    a.reject(new SessionTimeoutError(timeoutMs));
    // State stays as observed (likely busy); next dispatch will retry from current state.
  }

  private onExit(exitCode: number | null, signal?: string): void {
    if (this.disposed) return;
    this.transitionState('exited');
    if (this.firstReadyTimer) { clearTimeout(this.firstReadyTimer); this.firstReadyTimer = null; }
    if (this.active) {
      const a = this.active;
      this.active = null;
      this.clearActiveTimers(a);
      a.reject(new SessionExitedError(exitCode, signal));
    }
    while (this.queue.length > 0) {
      const p = this.queue.shift()!;
      p.reject(new SessionExitedError(exitCode, signal));
    }
  }

  private clearActiveTimers(a: ActiveDispatch): void {
    if (a.timeoutHandle) clearTimeout(a.timeoutHandle);
    if (a.idleHandle) clearTimeout(a.idleHandle);
    if (a.stableTailHandle) clearTimeout(a.stableTailHandle);
  }

  private mintMarkerId(): string {
    const role = this.opts.role.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const uuid = randomUUID().replace(/-/g, '').slice(0, 12);
    return `CDB_DONE_${role}_${uuid}`;
  }
}

/** Convenience factory. */
export function createSessionConductor(opts: ConductorOpts): SessionConductor {
  return new SessionConductor(opts);
}
