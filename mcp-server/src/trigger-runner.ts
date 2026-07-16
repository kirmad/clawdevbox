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
import {
  closeSync, existsSync, openSync, readdirSync, readSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

/**
 * A single observation file the trigger script wrote under
 * `envelope.output_dir`, captured into a bounded, JSON-safe shape so it can
 * be returned by `trigger.test` (the dir itself is deleted right after).
 */
export interface ObservationFile {
  /** Path relative to output_dir, always forward-slash separated. */
  path: string;
  /** True on-disk size in bytes (before any content truncation). */
  bytes: number;
  /** `utf8` for text; `base64` when the file looks binary (contains NUL). */
  encoding: 'utf8' | 'base64';
  /** File content, possibly truncated to the per-file byte cap. */
  content: string;
  /** True when `content` was cut short because the file exceeded the cap. */
  truncated: boolean;
}

export interface CollectObservationsResult {
  observations: ObservationFile[];
  /**
   * True when the capture was incomplete for ANY reason: a file/total/depth
   * cap was hit, or an entry was skipped (symlink, special file, unreadable).
   * Signals "there was more than what you see here" without leaking details.
   */
  truncated: boolean;
}

export interface CollectObservationsOptions {
  /** Max number of files captured (sorted order). Default 50. */
  maxFiles?: number;
  /** Max bytes of content read per file. Default 64 KiB. */
  maxFileBytes?: number;
  /** Max total content bytes across all files. Default 1 MiB. */
  maxTotalBytes?: number;
  /** Max directory recursion depth. Default 8. */
  maxDepth?: number;
}

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 8;

/**
 * Walk `dir` and return a bounded, safe representation of the observation
 * files a trigger script wrote there. Design constraints:
 *   - NON-MUTATING: reads only; the caller owns deletion of `dir`.
 *   - Symlinks are NOT followed (they are skipped), so a malicious script
 *     cannot exfiltrate files outside the sandboxed output dir via a link.
 *   - Every captured path is re-verified to resolve inside `dir` (defence in
 *     depth against traversal).
 *   - Deterministic ordering: results sorted by relative path.
 *   - Bounded: per-file, total-bytes, file-count, and recursion-depth caps
 *     keep binary/large/deeply-nested trees from blowing up the response.
 */
export function collectObservations(
  dir: string,
  opts: CollectObservationsOptions = {},
): CollectObservationsResult {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  if (!dir || !existsSync(dir)) return { observations: [], truncated: false };

  const rootAbs = resolve(dir);
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  let truncated = false;

  // Phase 1: enumerate regular files (deterministically), skipping symlinks
  // and special files. `withFileTypes` reflects lstat, so symlinked dirs are
  // reported as symlinks and never recursed into.
  const files: string[] = [];
  const walk = (abs: string, depth: number): void => {
    if (depth > maxDepth) { truncated = true; return; }
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      truncated = true;
      return;
    }
    for (const entry of entries) {
      const childAbs = join(abs, entry.name);
      if (entry.isSymbolicLink()) { truncated = true; continue; }
      if (entry.isDirectory()) { walk(childAbs, depth + 1); continue; }
      if (!entry.isFile()) { truncated = true; continue; }
      // Defence in depth: never accept a path that escapes the root.
      const resolved = resolve(childAbs);
      if (resolved !== rootAbs && !resolved.startsWith(rootPrefix)) {
        truncated = true;
        continue;
      }
      files.push(childAbs);
    }
  };
  walk(rootAbs, 0);

  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Phase 2: read bounded content for each file until caps are hit.
  const observations: ObservationFile[] = [];
  let totalBytes = 0;
  for (const abs of files) {
    if (observations.length >= maxFiles) { truncated = true; break; }
    if (totalBytes >= maxTotalBytes) { truncated = true; break; }

    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      truncated = true;
      continue;
    }

    const budget = Math.min(maxFileBytes, maxTotalBytes - totalBytes);
    const toRead = Math.min(size, budget);
    const buf = Buffer.alloc(toRead);
    let readBytes = 0;
    try {
      const fd = openSync(abs, 'r');
      try {
        while (readBytes < toRead) {
          const n = readSync(fd, buf, readBytes, toRead - readBytes, readBytes);
          if (n <= 0) break;
          readBytes += n;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      truncated = true;
      continue;
    }

    const slice = readBytes === buf.length ? buf : buf.subarray(0, readBytes);
    const isBinary = slice.includes(0);
    const fileTruncated = size > readBytes;
    if (fileTruncated) truncated = true;

    const rel = relative(rootAbs, abs).split(sep).join('/');
    observations.push({
      path: rel,
      bytes: size,
      encoding: isBinary ? 'base64' : 'utf8',
      content: isBinary ? slice.toString('base64') : slice.toString('utf8'),
      truncated: fileTruncated,
    });
    totalBytes += readBytes;
  }

  return { observations, truncated };
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
