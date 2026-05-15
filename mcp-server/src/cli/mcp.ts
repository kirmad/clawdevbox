/**
 * cli/mcp.ts
 *
 * `clawdevbox mcp` — run the MCP server over stdio.
 *
 * Resolves config (flags > env > .clawdevbox/config.json > defaults),
 * boots the terminal viewer on its own port so spawned recipes can hand out
 * a view_url, then connects an stdio transport. Logs to stderr — stdout is
 * reserved for MCP protocol frames.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { applyConfigToEnv, ConfigError, resolveConfig, type ResolvedConfig } from '../config.ts';
import { openDatabase } from '../db/index.ts';
import { logger } from '../logger.ts';
import { buildServer } from '../server.ts';
import {
  clearServiceState,
  isProcessAlive,
  probeHealth,
  readServiceState,
  spawnDetached,
  writeServiceState,
} from '../service.ts';
import { startTerminalServer } from '../terminal-server.ts';
import { loadWorkspaceFromEnv, WorkspaceConfigError } from '../workspace.ts';
import type { Flags } from './index.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export interface EnsureHttpServiceCfg {
  globalDir: string;
  http: { host: string; port: number; token: string };
}

export interface BootstrapResult {
  running: boolean;
  started?: boolean;
  pid?: number;
  port?: number;
  reason?: string;
  logPath?: string | null;
}

function resolveExecForBootstrap(): { execPath: string; execArgs: string[] } {
  const execPath = process.execPath;
  const here = dirname(fileURLToPath(import.meta.url));
  // Only trust process.argv[1] when it looks like a clawdevbox CLI entry —
  // otherwise tests (whose argv[1] is the test file path) would mis-route
  // the child spawn at themselves.
  const looksLikeCli = (p: string): boolean => {
    const lower = p.toLowerCase();
    return (
      lower.endsWith('cli.js') ||
      lower.endsWith('cli.ts') ||
      lower.endsWith('cli.mjs') ||
      lower.endsWith('index.js') ||
      lower.endsWith('index.ts')
    );
  };
  const candidates: string[] = [];
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0 && looksLikeCli(process.argv[1])) {
    candidates.push(process.argv[1]);
  }
  candidates.push(
    resolve(here, '..', '..', 'dist', 'cli.js'),
    resolve(here, '..', 'cli.js'),
    resolve(here, '..', '..', 'src', 'cli', 'index.ts'),
  );
  for (const c of candidates) {
    if (existsSync(c)) return { execPath, execArgs: [c] };
  }
  return { execPath, execArgs: [candidates[0] ?? ''] };
}

function readOwnVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', 'package.json'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        const parsed = JSON.parse(readFileSync(c, 'utf8')) as { version?: string };
        if (parsed.version) return parsed.version;
      }
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

function forwardedFlags(cfg: EnsureHttpServiceCfg): string[] {
  // Forward the bits that affect where the child looks for config + which
  // socket it binds. Token is intentionally NOT forwarded — the child
  // resolves it from its own config / env so MCP and HTTP can never have
  // drifted-apart tokens.
  return [
    '--global', cfg.globalDir,
    '--host', cfg.http.host,
    '--port', String(cfg.http.port),
  ];
}

/**
 * Bootstrap the long-lived HTTP service from a stdio MCP session.
 *
 * - If `service.json` records a live PID AND `/healthz` answers within
 *   1.5s, reuse it (running=true, started=false).
 * - Otherwise clear any stale state, `spawnDetached` a new
 *   `clawdevbox start --service-runner ...` child, record fresh
 *   `service.json`, then probe `/healthz` for up to 10s.
 *
 * Bootstrap failures are NEVER fatal to the MCP session — `runMcp()`
 * always proceeds so the agent sees the full tool surface. The returned
 * `reason` + `logPath` are logged as a WARN.
 */
export async function ensureHttpServiceRunning(
  cfg: EnsureHttpServiceCfg,
): Promise<BootstrapResult> {
  const state = readServiceState(cfg.globalDir);
  if (state && isProcessAlive(state.pid)) {
    const port = state.port ?? cfg.http.port;
    const probe = await probeHealth({
      host: cfg.http.host,
      port,
      timeoutMs: 1500,
    });
    if (probe.ok) {
      return { running: true, pid: state.pid, port, started: false };
    }
  }
  if (state) {
    clearServiceState(cfg.globalDir);
  }

  logger.info({ globalDir: cfg.globalDir }, 'http service not running — bootstrapping');
  const { execPath, execArgs } = resolveExecForBootstrap();
  const childArgs = [...execArgs, 'start', '--service-runner', ...forwardedFlags(cfg)];
  let pid: number;
  let logPath: string | null = null;
  try {
    const out = spawnDetached(execPath, childArgs, { logDir: cfg.globalDir });
    pid = out.pid;
    logPath = out.logPath;
  } catch (err) {
    return {
      running: false,
      reason: err instanceof Error ? err.message : String(err),
      logPath: null,
    };
  }

  writeServiceState(cfg.globalDir, {
    pid,
    port: cfg.http.port,
    started_at: Date.now(),
    version: readOwnVersion(),
    exec_path: execPath,
    exec_args: childArgs,
  });

  const probe = await probeHealth({
    host: cfg.http.host,
    port: cfg.http.port,
    timeoutMs: 10_000,
  });
  if (probe.ok) {
    return { running: true, pid, port: cfg.http.port, started: true };
  }
  return { running: false, reason: probe.reason, logPath };
}

export async function runMcp(flags: Flags): Promise<void> {
  let cfg;
  try {
    cfg = resolveConfig({
      projectDir: str(flags, 'project'),
      globalDir: str(flags, 'global'),
      workspacesRoot: str(flags, 'workspaces-root'),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ err: err.message }, 'config error');
      process.exit(2);
    }
    throw err;
  }
  applyConfigToEnv(cfg);

  let ws;
  try {
    ws = loadWorkspaceFromEnv();
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      logger.error({ err: err.message }, 'workspace config error');
      process.exit(2);
    }
    throw err;
  }

  // Open the kernel DB so DB-backed stores (triggers, recipe-instances,
  // inbox) have a working singleton. Runs migrations on first open.
  try {
    const opened = openDatabase(cfg.globalDir);
    logger.info(
      { path: opened.path, schema_version: opened.schemaVersion },
      'db opened',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'db open failed',
    );
    process.exit(2);
  }

  const { server, hostedRegistry } = await buildServer(ws);

  let terminalPort = 0;
  try {
    const handle = await startTerminalServer({ workspace: ws });
    terminalPort = handle.port();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'terminal-server failed to start; recipes will run without a view_url',
    );
  }

  const transport = new StdioServerTransport();

  // Bootstrap the long-lived HTTP service so cron triggers continue to
  // fire even when no user is logged in (spec §8.1). Failures are NEVER
  // fatal — log + carry on; the agent still gets every tool over stdio.
  try {
    const bs = await ensureHttpServiceRunning({
      globalDir: cfg.globalDir,
      http: { host: cfg.http.host, port: cfg.http.port, token: cfg.http.token ?? '' },
    });
    if (bs.running) {
      logger.info(
        { pid: bs.pid, port: bs.port, started: bs.started ?? false },
        bs.started ? 'http service bootstrapped' : 'http service already running',
      );
    } else {
      logger.warn(
        { reason: bs.reason, logPath: bs.logPath },
        'http service bootstrap failed — MCP session will continue without a running cron kernel',
      );
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'ensureHttpServiceRunning threw — MCP session will continue',
    );
  }

  await server.connect(transport);
  server.server.onclose = () => process.exit(0);

  logger.info(
    {
      transport: 'stdio',
      projectDir: ws.projectDir,
      plugins: ws.plugins.size,
      hostedTools: hostedRegistry.tools.length,
      hostedErrors: hostedRegistry.errors.length,
      terminalPort,
    },
    'ready',
  );
}
