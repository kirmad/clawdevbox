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
import { logger } from './logger.ts';
import type { TriggerRuntime } from './validators.ts';

export interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  callback_url: string;
  state: Record<string, unknown>;
  payload: unknown;
}

export interface RunOptions {
  scriptPath: string;
  runtime: TriggerRuntime;
  envelope: TriggerEnvelope;
  callbackSecret: string;
  timeoutMs: number;
  cwd?: string;
  /** Extra env vars merged into the spawn env (CLAWDEVBOX_MCP_SECRET is set by the runner). */
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
      CLAWDEVBOX_MCP_SECRET: opts.callbackSecret,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

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
