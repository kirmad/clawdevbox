/**
 * trigger-runner.ts
 *
 * The script-spawning primitive. Reused by trigger.test today and intended
 * for the future cron daemon's trigger.fire path.
 *
 * Responsibilities:
 *   - Resolve a runtime to a spawn argv (`tsx` / `node` / `python` / `bash`).
 *   - Spawn the script with the envelope on stdin.
 *   - Capture stdout + stderr.
 *   - Enforce a hard timeout (kills the process tree on Windows + POSIX).
 *   - Parse stdout as JSON if possible (used for Mode A callback extraction).
 *
 * The HTTP receiver for Mode B callbacks lives in tools/trigger.ts (only
 * `trigger.test` needs it — the cron daemon will dispatch Mode B callbacks
 * directly to /callback/* which already exists).
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from './logger.ts';
import type { TriggerRuntime } from './validators.ts';

export interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  /**
   * Absolute path to the per-attempt output directory the dispatcher
   * created BEFORE spawning this script. Scripts may write audit /
   * observation files here directly via filesystem; the kernel does not
   * read them. Path shape: <ws>/.clawdevbox/fires/<fire_id>/attempt-<N>/
   */
  output_dir: string;
  /**
   * URL to POST { prompt: string } to dispatch a prompt to the agent
   * attached to THIS trigger's subscriber_thread_id. Present only when
   * the trigger registration has subscriber_thread_id set AND that
   * thread's pty is live in pty-registry at script-spawn time.
   */
  dispatch_url?: string;
  /**
   * URL to POST { prompt: string, agent?: string, workspace_id?: string }
   * to spawn a fresh interactive agent. Always present.
   */
  spawn_url: string;
  /**
   * Back-compat alias. Older plugin trigger scripts read env.callback_url
   * (single URL, Mode B "POST events as you find them"). New scripts
   * should use dispatch_url ?? spawn_url explicitly; the alias keeps
   * shipped plugins working without rewrites.
   */
  callback_url?: string;
  /**
   * Back-compat field — older scripts switch on `fired_by` to decide
   * between live-event vs poll handling. Values mirror fires.source:
   *   'cron'     — scheduler tick
   *   'manual'   — POST /api/triggers/:id/fire or trigger.fire MCP
   *   'external' — inbound webhook (e.g. ADO service hook)
   */
  fired_by?: 'cron' | 'manual' | 'external';
  /**
   * Per-trigger persistent scratch directory. Survives across runs.
   * Path shape: <ws>/.clawdevbox/triggers/<trigger_id>/data/
   */
  trigger_data_dir?: string;
  state: Record<string, unknown>;
  payload: unknown;
}

export interface RunOptions {
  scriptPath: string;
  runtime: TriggerRuntime;
  envelope: TriggerEnvelope;
  timeoutMs: number;
  cwd?: string;
  /** Extra env vars merged into the spawn env. */
  env?: Record<string, string>;
}

export interface RunResult {
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  stdout_parsed: unknown | null;
}

function spawnArgv(runtime: TriggerRuntime, scriptPath: string): { command: string; args: string[] } {
  // On Windows, npx/python are typically .cmd shims (e.g. npx.cmd installed
  // via Node, python.exe shim from the App Execution Aliases). Spawning a
  // shim directly works on older Node, but Node 22+ deprecated the
  // `shell: true` hack that used to be the cross-platform escape. Wrap
  // them in `cmd.exe /d /s /c <bin> <args...>` instead — same approach
  // we use for the agent CLIs (claude.ts).
  const wrap = (bin: string, args: string[]): { command: string; args: string[] } => {
    if (process.platform === 'win32') {
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
    }
    return { command: bin, args };
  };

  switch (runtime) {
    case 'tsx':  return wrap('npx', ['tsx', scriptPath]);
    case 'node': return wrap('node', [scriptPath]);
    case 'python': {
      const cmd = process.platform === 'win32' ? 'python' : 'python3';
      return wrap(cmd, [scriptPath]);
    }
    case 'bash': return wrap('bash', [scriptPath]);
  }
}

export async function runTriggerScript(opts: RunOptions): Promise<RunResult> {
  // Defensive: tsx/node scripts need a sibling package.json with
  // `"type":"module"` so top-level await + ESM imports work. Save-time
  // helpers (writeTemplate / writeVaultTemplate) drop this for tools we
  // own; this catches legacy / out-of-band scripts (e.g. vault content
  // committed by hand) so the runner stays bulletproof.
  if (opts.runtime === 'tsx' || opts.runtime === 'node') {
    const dir = dirname(opts.scriptPath);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) {
      try { writeFileSync(pkgPath, '{"type":"module"}\n'); }
      catch { /* best-effort; spawn below will surface any real failure */ }
    }
  }

  const { command, args } = spawnArgv(opts.runtime, opts.scriptPath);
  const started = Date.now();
  let timedOut = false;
  let stdout = '';
  let stderr = '';

  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...(opts.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Cap each stream at 4 MB. A buggy trigger spamming stdout could otherwise
  // grow these strings unboundedly inside the kernel process. Once the cap is
  // hit we drop further bytes from THAT stream (timeout still bounds total
  // duration; this just bounds total RAM per invocation).
  const STREAM_CAP_BYTES = 4 * 1024 * 1024;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  child.stdout.on('data', (d: Buffer) => {
    if (stdoutTruncated) return;
    const remaining = STREAM_CAP_BYTES - Buffer.byteLength(stdout, 'utf8');
    if (remaining <= 0) {
      stdoutTruncated = true;
      stdout += `\n[clawdevbox] stdout truncated at ${STREAM_CAP_BYTES} bytes\n`;
      return;
    }
    const chunk = d.length <= remaining ? d.toString('utf8') : d.subarray(0, remaining).toString('utf8');
    stdout += chunk;
    if (d.length > remaining) {
      stdoutTruncated = true;
      stdout += `\n[clawdevbox] stdout truncated at ${STREAM_CAP_BYTES} bytes\n`;
    }
  });
  child.stderr.on('data', (d: Buffer) => {
    if (stderrTruncated) return;
    const remaining = STREAM_CAP_BYTES - Buffer.byteLength(stderr, 'utf8');
    if (remaining <= 0) {
      stderrTruncated = true;
      stderr += `\n[clawdevbox] stderr truncated at ${STREAM_CAP_BYTES} bytes\n`;
      return;
    }
    const chunk = d.length <= remaining ? d.toString('utf8') : d.subarray(0, remaining).toString('utf8');
    stderr += chunk;
    if (d.length > remaining) {
      stderrTruncated = true;
      stderr += `\n[clawdevbox] stderr truncated at ${STREAM_CAP_BYTES} bytes\n`;
    }
  });

  child.stdin.end(JSON.stringify(opts.envelope));

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch (err) {
      logger.warn({ err: String(err) }, 'trigger-runner: kill-on-timeout failed');
    }
  }, opts.timeoutMs);

  const exitCode: number | null = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  clearTimeout(timer);

  let parsed: unknown | null = null;
  if (stdout.trim()) {
    try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
  }

  return {
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    timed_out: timedOut,
    stdout, stderr,
    stdout_parsed: parsed,
  };
}
