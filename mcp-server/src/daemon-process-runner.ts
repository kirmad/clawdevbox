/**
 * daemon-process-runner.ts — long-lived script process supervision.
 *
 * Distinct from `trigger-runner.ts` (which is for short-lived event
 * scripts with a 60s timeout + buffered-in-memory stdout/stderr +
 * JSON-stdout parsing). Daemons:
 *
 *   - run indefinitely (no timeout),
 *   - stream stdout/stderr to a bounded rolling log file,
 *   - track pid + process group so kill() can escalate SIGTERM → SIGKILL
 *     and kill the whole tree on Windows via taskkill /F /T.
 *
 * One DaemonProcess instance per spawn attempt. The supervisor owns the
 * EventEmitter and listens for 'exit' to schedule the next restart.
 */

import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync, writeSync, closeSync, statSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleepP } from 'node:timers/promises';
import { logger } from './logger.ts';
import type { DaemonRuntime } from './db/daemons-store.ts';

/** Cap per log file. When exceeded, rotate to <name>.1 and start fresh. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** Time to wait between SIGTERM and SIGKILL. */
const KILL_ESCALATION_MS = 5_000;

export interface DaemonProcessOptions {
  runtime: DaemonRuntime;
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Absolute path to log file (parent dir auto-created). */
  logPath: string;
}

export interface DaemonExitInfo {
  exit_code: number | null;
  signal: string | null;
  /** Process-side error (e.g. ENOENT for missing binary). null if process started cleanly. */
  spawn_error: string | null;
}

/**
 * Build the argv to spawn for a given runtime. `direct` means "command[0]
 * is the binary, command[1..] are its args" — no wrapper.
 *
 * On Windows, npx/python/pwsh are typically .cmd shims; we wrap them in
 * cmd.exe per the same pattern used by trigger-runner.ts.
 */
function buildArgv(opts: DaemonProcessOptions): { command: string; args: string[] } {
  const { runtime, command } = opts;
  const win = process.platform === 'win32';
  const wrap = (bin: string, args: string[]): { command: string; args: string[] } =>
    win ? { command: 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] } : { command: bin, args };

  if (runtime === 'direct') {
    if (command.length === 0) throw new Error('daemon: direct runtime requires a non-empty command');
    return { command: command[0]!, args: command.slice(1) };
  }
  if (runtime === 'node') return wrap('node', command);
  if (runtime === 'tsx') return wrap('npx', ['tsx', ...command]);
  if (runtime === 'python') return wrap('python', command);
  if (runtime === 'bash') return win ? wrap('bash', command) : { command: 'bash', args: command };
  if (runtime === 'pwsh') return wrap('pwsh', ['-NoLogo', '-NoProfile', '-File', ...command]);
  throw new Error(`daemon: unknown runtime ${runtime}`);
}

export class DaemonProcess extends EventEmitter {
  readonly opts: DaemonProcessOptions;
  private child: ChildProcess | null = null;
  private logFd: number | null = null;
  private bytesWritten = 0;
  private stopRequested = false;
  private exitInfo: DaemonExitInfo | null = null;

  constructor(opts: DaemonProcessOptions) {
    super();
    this.opts = opts;
  }

  /** Returns the spawned PID, or throws if spawn fails synchronously. */
  start(): number {
    if (this.child) throw new Error('daemon: process already started');

    mkdirSync(dirname(this.opts.logPath), { recursive: true });
    this.logFd = openSync(this.opts.logPath, 'a');
    this.bytesWritten = statSync(this.opts.logPath).size;

    const { command, args } = buildArgv(this.opts);
    this.writeLog(`[clawdevbox] spawn ${command} ${args.join(' ')} cwd=${this.opts.cwd ?? '(inherit)'} pid=?\n`);

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detach + new process group so kill() can reach the whole tree
        // via tree-kill semantics (taskkill /T on Windows; -pgrp on POSIX).
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeLog(`[clawdevbox] spawn failed: ${msg}\n`);
      this.closeLog();
      this.exitInfo = { exit_code: null, signal: null, spawn_error: msg };
      // Emit exit asynchronously so listeners attached after start() still see it.
      setImmediate(() => this.emit('exit', this.exitInfo));
      throw err;
    }

    this.child = child;
    const pid = child.pid ?? -1;
    this.writeLog(`[clawdevbox] pid=${pid}\n`);

    child.stdout?.on('data', (b: Buffer) => this.writeLog(b));
    child.stderr?.on('data', (b: Buffer) => this.writeLog(b));

    let exitEmitted = false;
    const emitExit = (info: DaemonExitInfo) => {
      if (exitEmitted) return;
      exitEmitted = true;
      this.exitInfo = info;
      this.closeLog();
      this.emit('exit', info);
    };

    child.on('error', (err) => {
      this.writeLog(`[clawdevbox] process error: ${err.message}\n`);
      // On Windows, spawning a missing binary fires 'error' but may NOT
      // fire 'exit'. Emit our synthetic exit so the supervisor never hangs.
      emitExit({ exit_code: null, signal: null, spawn_error: err.message });
    });

    child.on('exit', (code, signal) => {
      this.writeLog(`[clawdevbox] exit code=${code} signal=${signal} stopRequested=${this.stopRequested}\n`);
      emitExit({
        exit_code: code,
        signal: typeof signal === 'string' ? signal : null,
        spawn_error: null,
      });
    });

    return pid;
  }

  /**
   * Politely stop the process: SIGTERM, wait KILL_ESCALATION_MS, then
   * SIGKILL / taskkill /F /T. On Windows, taskkill /T also reaps the
   * process tree. Resolves once the process is gone.
   */
  async stop(): Promise<void> {
    if (!this.child) return;
    if (this.stopRequested) return;
    this.stopRequested = true;
    const pid = this.child.pid;
    if (!pid) return;

    if (process.platform === 'win32') {
      // Windows has no concept of signals — go straight to taskkill /T
      // (tree kill). Try without /F first to allow graceful shutdown,
      // then escalate.
      spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true });
      await this.waitForExit(KILL_ESCALATION_MS);
      if (this.child && this.child.exitCode === null) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        await this.waitForExit(2_000);
      }
      return;
    }

    // POSIX: send to the negative pid to hit the whole process group.
    try { process.kill(-pid, 'SIGTERM'); } catch { /* group may already be dead */ }
    await this.waitForExit(KILL_ESCALATION_MS);
    if (this.child && this.child.exitCode === null) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      await this.waitForExit(2_000);
    }
  }

  private async waitForExit(maxMs: number): Promise<void> {
    const start = Date.now();
    while (this.child && this.child.exitCode === null && Date.now() - start < maxMs) {
      await sleepP(50);
    }
  }

  private writeLog(chunk: Buffer | string): void {
    if (this.logFd === null) return;
    try {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      writeSync(this.logFd, buf);
      this.bytesWritten += buf.length;
      if (this.bytesWritten > LOG_ROTATE_BYTES) this.rotateLog();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'daemon-runner: log write failed');
    }
  }

  private rotateLog(): void {
    if (this.logFd === null) return;
    try {
      closeSync(this.logFd);
    } catch { /* ignore */ }
    this.logFd = null;
    const rotated = `${this.opts.logPath}.1`;
    try {
      if (existsSync(rotated)) {
        // Drop the older rotation — single-file backlog only.
        try { renameSync(rotated, `${rotated}.tmp`); } catch { /* ignore */ }
      }
      renameSync(this.opts.logPath, rotated);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'daemon-runner: log rotate failed');
    }
    try {
      this.logFd = openSync(this.opts.logPath, 'a');
      this.bytesWritten = 0;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'daemon-runner: reopen log failed');
    }
  }

  private closeLog(): void {
    if (this.logFd !== null) {
      try { closeSync(this.logFd); } catch { /* ignore */ }
      this.logFd = null;
    }
  }
}

/**
 * Resolve the absolute log path for a given daemon + run inside the
 * workspace's `.clawdevbox/daemons/` tree.
 */
export function daemonLogPath(workspacePath: string, daemonId: string, runId: string): string {
  return join(workspacePath, '.clawdevbox', 'daemons', daemonId, `${runId}.log`);
}

/** Tail the last N bytes of a daemon log file. */
export function readDaemonLog(logPath: string, tailBytes = 32_768): string {
  try {
    if (!existsSync(logPath)) return '';
    const { openSync, fstatSync, readSync, closeSync } = require('node:fs') as typeof import('node:fs');
    const fd = openSync(logPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return `(failed to read log: ${err instanceof Error ? err.message : String(err)})`;
  }
}
