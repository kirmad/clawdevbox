/**
 * cli/start.ts
 *
 * `clawdevbox start` — Streamable HTTP MCP transport on a long-lived web
 * server. One http.Server hosts:
 *
 *   POST/GET/DELETE /mcp[/...]   → StreamableHTTPServerTransport
 *                                   (Authorization: Bearer <token> required)
 *   GET   /terminal/:id          → xterm.js viewer (delegated)
 *   GET   /artifact/:id[/...]    → artifact viewer (delegated)
 *   GET   /__renderer/:type.mjs  → renderer chain (delegated)
 *   WS    /terminal/:id/ws       → pty bridge (delegated)
 *   GET   /healthz               → "ok"
 *
 * The bearer token is read from `.clawdevbox/config.json` (or the
 * `CLAWDEVBOX_TOKEN` env override). Run `clawdevbox init` to mint one.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { applyConfigToEnv, ConfigError, resolveConfig, type ResolvedConfig } from '../config.ts';
import { handleTestHook } from '../api-test-hooks.ts';
import { onChange } from '../event-bus.ts';
import { renderHomePage, resolveSpaAsset } from '../home-page.ts';
import { logger } from '../logger.ts';
import { startHeapMonitor, type HeapMonitorHandle } from '../heap-monitor.ts';
import { startIdleReaper } from '../idle-reaper.ts';
import { cleanCopilotStaleLocks } from '../stale-locks.ts';
import { startMainAgent, getMainAgentStatus } from '../main-agent.ts';
import { buildProviderCtx } from '../agent-clis/shared.ts';
import type { Workspace } from '../workspace.ts';
import { getRegistry } from '../tools/registry.ts';
import {
  addSubscription,
  listSubscriptions,
  removeSubscription,
  sendNotification,
  type PushSubscriptionRecord,
} from '../notifications.ts';
import {
  iconMaskableSvg,
  iconSvg,
  manifestJson,
  serviceWorkerJs,
} from '../pwa-assets.ts';
import {
  listAllRecipeInstancesFromDb,
  type RecipeInstance,
} from '../recipe-instances-store.ts';
import { readInboxBody } from '../inbox-persistence.ts';
import { cronLabel, nextRunAfter } from '../cron-utils.ts';
import {
  readRecipeInstance,
  writeRecipeInstance,
  mintRecipeInstanceId,
  type RecipeInstance as RecipeInstanceRow,
} from '../recipe-instances-store.ts';
import { registerPty, killAllSessions, listSessions as listPtySessions, getSessionMeta as getPtySessionMeta } from '../pty-registry.ts';
import { tmuxSessionRegistry } from '../cli-sessions/tmux-session-runtime.ts';
import { buildServer, createSessionServer } from '../server.ts';
import {
  fetchTunnelStatus,
  installAutoStart,
  isProcessAlive,
  probeHealth,
  readServiceState,
  spawnDetached,
  writeServiceState,
  type ServiceState,
} from '../service.ts';
import { approvals, inbox } from '../store.ts';
import { dispatchTerminalRequest, startTerminalServer } from '../terminal-server.ts';
import {
  deriveTunnelName,
  getTunnelStatus,
  startTunnel,
  stopTunnel,
  type TunnelStatus,
} from '../tunnel.ts';
import { closeDatabase, getDatabase, openDatabase } from '../db/index.ts';
import { scanLegacyFiles } from '../db/legacy-files.ts';
import { readTriggersFile } from '../triggers-store.ts';
import { loadWorkspaceFromEnv, triggersJsonPath, WorkspaceConfigError } from '../workspace.ts';
import { Dispatcher } from '../dispatcher.ts';
import { Scheduler } from '../scheduler.ts';
import { DaemonSupervisor } from '../daemon-supervisor.ts';
import { handleCronApi, type CronApiContext } from './cron-api.ts';
import { handleAgentCliApi } from './agent-clis-api.ts';
import type { Flags } from './index.ts';
import {
  initTmuxSessionRuntime,
  reconcileOnStartup,
  bundledTmuxConfPath,
  sweepStaleTmuxSessions,
} from '../cli-sessions/tmux-session-runtime.ts';
import { tmuxRunAsync } from '../cli-sessions/tmux-client.ts';

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  if (typeof v !== 'string') return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new ConfigError(`--${key} must be an integer in 1..65535 (got ${v})`);
  }
  return n;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

function isMcpPath(pathname: string): boolean {
  return pathname === '/mcp' || pathname.startsWith('/mcp/') || pathname.startsWith('/mcp?');
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

function rejectUnauthorized(res: ServerResponse, message: string): void {
  // NOTE: we intentionally do NOT emit a `WWW-Authenticate: Bearer` header.
  // The MCP SDK in Copilot CLI treats that header as "OAuth required" and
  // attempts protected-resource discovery, which fails for our static
  // bearer setup. A plain 401 lets clients surface the error directly.
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message } }));
}

function getSessionIdHeader(req: IncomingMessage): string | undefined {
  const h = req.headers['mcp-session-id'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0 && typeof h[0] === 'string') return h[0];
  return undefined;
}

async function readJsonRpcBody(req: IncomingMessage): Promise<unknown | undefined> {
  const MAX = 8 * 1024 * 1024; // 8MB — plenty for tool args; ~64KB is typical.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c instanceof Buffer ? c : Buffer.from(c as ArrayBufferLike);
    total += buf.length;
    if (total > MAX) return undefined;
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Route an `/mcp` request to the correct per-session transport, creating a
 * new (server, transport) pair when the client sends a fresh `initialize`
 * request. Implements the MCP Streamable HTTP spec's session model:
 *
 *   - Client `initialize` (POST, no `mcp-session-id` header) → mint a new
 *     session ID, attach to a fresh `McpServer`, route the initialize body.
 *   - Subsequent calls (POST / GET SSE / DELETE) carry the issued session
 *     ID in `mcp-session-id` and are dispatched to the same transport.
 *   - Unknown session ID → 404 (don't silently mint a new one — that would
 *     mask client bugs).
 *
 * Session lifetime is owned by the SDK transport's lifecycle hooks: when
 * the client sends DELETE or the transport finalises, we drop the entry
 * from `transports` so the map doesn't leak.
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ws: Workspace,
  transports: Map<string, StreamableHTTPServerTransport>,
  recordAgentSessionId?: (mcpSessionId: string, agentSessionId: string | null) => void,
): Promise<void> {
  const method = req.method ?? 'GET';
  const sessionId = getSessionIdHeader(req);

  // Capture the agent session id from the request header so the idle
  // sweep can keep transports for alive sessions. The header is the
  // X-Clawdevbox-Session-Id value the per-session .mcp.json injects.
  if (sessionId && recordAgentSessionId) {
    const hdr = req.headers['x-clawdevbox-session-id'];
    const asid = Array.isArray(hdr) ? hdr[0] : hdr;
    recordAgentSessionId(sessionId, asid ?? null);
  }

  // Existing session: dispatch to its transport. Any HTTP method is fine —
  // POST = JSON-RPC call, GET = SSE notification stream, DELETE = terminate.
  if (sessionId) {
    const existing = transports.get(sessionId);
    if (!existing) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        }),
      );
      return;
    }
    try {
      await existing.handleRequest(req, res);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), sessionId },
        'mcp handler threw',
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'handler error' } }));
      }
    }
    return;
  }

  // No session ID. The only legitimate request is POST with an `initialize`
  // body — everything else is a client bug (forgot to include the session
  // header after init, or terminated then kept calling).
  if (method !== 'POST') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: missing mcp-session-id' },
        id: null,
      }),
    );
    return;
  }

  const body = await readJsonRpcBody(req);
  if (body === undefined) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error: invalid JSON or body too large' },
        id: null,
      }),
    );
    return;
  }

  // JSON-RPC batches CANNOT initialize a session (initialize must be a
  // standalone request per the MCP spec). Reject arrays here so we don't
  // accidentally mint a session for a batch of regular calls.
  if (!isInitializeRequest(body)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: missing mcp-session-id and not an initialize request',
        },
        id: null,
      }),
    );
    return;
  }

  const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, newTransport);
      logger.info({ sessionId: id, sessions: transports.size }, 'mcp session opened');
    },
    onsessionclosed: (id) => {
      transports.delete(id);
      logger.info({ sessionId: id, sessions: transports.size }, 'mcp session closed (client DELETE)');
    },
  });

  newTransport.onclose = () => {
    if (newTransport.sessionId && transports.delete(newTransport.sessionId)) {
      logger.info(
        { sessionId: newTransport.sessionId, sessions: transports.size },
        'mcp transport closed',
      );
    }
  };

  // Each session gets its own `McpServer`. Tool registration is cheap
  // (sync attach of handler functions); the heavy hosted-tool discovery
  // happened once at startup and populates the shared registry.
  const sessionServer = createSessionServer(ws);
  await sessionServer.connect(newTransport);

  try {
    await newTransport.handleRequest(req, res, body);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'mcp initialize handler threw',
    );
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'handler error' } }));
    }
    // If the SDK threw before the session was registered, the new
    // transport's `onclose` may not fire — best-effort cleanup.
    if (newTransport.sessionId) transports.delete(newTransport.sessionId);
  }
}

function bool(flags: Flags, key: string): boolean {
  const v = flags[key];
  return v === true || v === 'true' || v === '1';
}

export async function runStart(flags: Flags): Promise<void> {
  // Global last-resort error handlers. clawdevbox is a long-running daemon
  // and MUST not die from a Promise that nobody caught. node-pty's
  // conpty_console_list_agent.ts in particular crashes on Windows whenever
  // it tries to AttachConsole() to a console that's already torn down,
  // and the resulting unhandledRejection on the parent's _getConsoleProcessList
  // Promise has been observed to take the process down. Log + survive.
  //
  // CAUTION: do not also exit here. The whole point is that the process
  // KEEPS RUNNING. If a handler itself throws, default behavior re-applies
  // (process exit + crash dump), which is the right escape hatch.
  process.on('uncaughtException', (err, origin) => {
    try {
      logger.error(
        {
          err: err instanceof Error ? { message: err.message, stack: err.stack, name: err.name } : String(err),
          origin,
        },
        'uncaughtException — surviving (daemon)',
      );
    } catch { /* logging itself broken; nothing we can do */ }
  });
  process.on('unhandledRejection', (reason, _promise) => {
    try {
      logger.error(
        {
          reason: reason instanceof Error
            ? { message: reason.message, stack: reason.stack, name: reason.name }
            : String(reason),
        },
        'unhandledRejection — surviving (daemon)',
      );
    } catch { /* logging itself broken; nothing we can do */ }
  });

  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig({
      projectDir: str(flags, 'project'),
      globalDir: str(flags, 'global'),
      workspacesRoot: str(flags, 'workspaces-root'),
      port: num(flags, 'port'),
      host: str(flags, 'host'),
      token: str(flags, 'token'),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error({ err: err.message }, 'config error');
      process.exit(2);
    }
    throw err;
  }
  applyConfigToEnv(cfg);

  // Bearer auth is opt-in: an empty/missing `http.token` disables /mcp and
  // /api/* auth entirely. This is intentional for local-only setups where
  // 127.0.0.1 binding + OS-level isolation is sufficient. Refuse the unsafe
  // combination of "anonymous tunnel + no bearer" — that would expose the
  // server to the public internet with zero auth.
  if (!cfg.http.token && cfg.tunnel.kind !== 'none' && cfg.tunnel.allow_anonymous) {
    logger.error(
      { projectDir: cfg.projectDir, tunnel: cfg.tunnel.kind },
      'refusing to start: tunnel.allow_anonymous=true requires a bearer token (set http.token or disable tunnel.allow_anonymous)',
    );
    process.exit(2);
  }
  if (!cfg.http.token) {
    logger.warn(
      { projectDir: cfg.projectDir },
      'no bearer token configured — /mcp and /api/* are UNAUTHENTICATED (loopback-only protection); set http.token to enable auth',
    );
  }

  // Service install path: spawn a detached child + register OS auto-start
  // + write <globalDir>/service.json. No HTTP server runs in this process.
  if (bool(flags, 'service')) {
    await installAsService(cfg, flags);
    return;
  }

  let ws;
  try {
    ws = await loadWorkspaceFromEnv();
  } catch (err) {
    if (err instanceof WorkspaceConfigError) {
      logger.error({ err: err.message }, 'workspace config error');
      process.exit(2);
    }
    throw err;
  }

  // Open the kernel DB. Runs migrations on every boot. Done before the HTTP
  // server binds so a migration failure surfaces before any request lands.
  const opened = openDatabase(cfg.globalDir);
  logger.info(
    { path: opened.path, schema_version: opened.schemaVersion },
    'db opened',
  );
  scanLegacyFiles(cfg, opened.db);

  // Initialize tmux session runtime: required for tmux-migrated providers
  // (copilot, claude, agency, echo-stub). Probes the tmux binary first;
  // fatal-exit if missing.
  //
  // Hoisted to function scope so downstream subsystems (e.g. idle-reaper)
  // can issue their own tmux queries with the same socket/config.
  let tmuxClient: { socket: string | null; configPath: string | null };
  {
    // Default to the shared tmux server (no -L). psmux on Windows creates a
    // SEPARATE server per `new-session -L <name>` invocation rather than
    // multiplexing one server per socket name (real-tmux behavior), which
    // breaks `tmux attach` from secondary clients. Using the default socket
    // forces psmux to multiplex on one process, which works correctly. Set
    // `cfg.tmux.socket` to a non-null string only if you NEED isolation
    // (e.g., multiple clawdevbox instances on the same machine).
    const tmuxSocket = cfg.tmux?.socket ?? null;
    const tmuxConfPath = bundledTmuxConfPath();
    tmuxClient = { socket: tmuxSocket, configPath: tmuxConfPath };

    const probe = await tmuxRunAsync({ socket: null, configPath: null }, ['-V']);
    if (probe.exitCode !== 0) {
      process.stderr.write(
        `FATAL: tmux binary not found on PATH. Install tmux (https://github.com/tmux/tmux or psmux on Windows).\n`,
      );
      process.exit(2);
    }
    initTmuxSessionRuntime(tmuxClient);

    // Sweep orphan `cdb_*` tmux sessions before anything else uses tmux.
    // When clawdevbox dies hard (OOM, kill /F, power loss) the tmux servers
    // it spawned become orphans and the agency/copilot processes inside
    // keep running indefinitely, leaking ~5-10 processes per orphan. We
    // tag each session at creation with CDB_CREATOR_PID; this sweep kills
    // any cdb_* session whose creator PID is dead (or untagged, which
    // implies pre-fix legacy). Concurrent clawdevbox instances are safe:
    // their sessions stay because their PIDs are alive.
    try {
      const sweep = await sweepStaleTmuxSessions(tmuxClient);
      if (sweep.killed > 0 || sweep.kept > 0) {
        logger.info(
          { killed: sweep.killed, kept: sweep.kept },
          'tmux: swept orphan cdb_* sessions',
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'tmux orphan sweep failed (non-fatal)',
      );
    }

    // Fire-and-forget: reconcile orphan sessions in background so a slow
    // attach loop (464 stale rows on dev machines) doesn't block boot. The
    // reconcile only matters for adopting truly-still-alive tmux sessions
    // from a prior kernel run; HTTP server starts immediately.
    void reconcileOnStartup(opened.db).then((recon) => {
      if (recon.adopted > 0 || recon.orphaned > 0) {
        logger.info(
          { adopted: recon.adopted, orphaned: recon.orphaned },
          'tmux: reconciled sessions on startup',
        );
      }
    }).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'tmux reconcile failed');
    });
  }

  // Bidirectional plugin sync (spec §6). Eager when cfg.clientSync.mode='auto'
  // or 'discover-only'; otherwise a no-op. Failures degrade to WARN.
  try {
    const { maybeRunClientSync } = await import('../agent-clis/lifecycle.ts');
    await maybeRunClientSync(ws, cfg, 'boot');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'boot-time client plugin sync failed',
    );
  }

  // Discover hosted tools + register the initial server. The registry
  // persists for per-session servers; the server returned here is discarded
  // (each MCP HTTP session gets its own fresh server + transport pair).
  const { hostedErrors } = await buildServer(ws);

  // Per-session MCP transports. The MCP Streamable HTTP spec is stateful:
  // the SDK's `Server.connect(transport)` binds 1:1, so each client session
  // needs its own (server, transport) pair. Sessions are keyed by the
  // `mcp-session-id` response header issued on initialize, then echoed in
  // every subsequent request header. We tear entries down via three
  // overlapping hooks (one is enough; the others are safety nets):
  //   - `onsessionclosed`: client sent DELETE /mcp (explicit termination)
  //   - `onclose`: underlying transport finalized (covers HTTP close paths)
  //   - request-handler `.catch` logs but does NOT delete (the transport
  //     itself decides whether the session is still usable).
  //
  // **Idle sweep**: the MCP Streamable HTTP transport has NO server-side
  // way to detect that a client (agent process) has died — each request
  // opens a fresh HTTP connection keyed by mcp-session-id, so there's no
  // persistent socket whose closure would trigger `onclose`. Without a
  // sweep, every crashed/killed agent leaks one transport entry plus
  // whatever it references (recently-pushed messages, response buffers,
  // etc.). Observed in production: ~+30 MB RSS per leaked transport;
  // after ~100 spawns (one busy day) the heap OOMs.
  //
  // Sweep policy:
  //   1. Each transport entry tracks `lastActivity` (bumped on every
  //      request) and `lastAgentSessionId` (captured from
  //      X-Clawdevbox-Session-Id header when present).
  //   2. Periodically (every CLAWDEVBOX_MCP_SWEEP_MS, default 60s), walk
  //      the transport map. For each entry:
  //        - If the bound agent session is still alive (in
  //          tmuxSessionRegistry OR pty-registry OR the main agent),
  //          KEEP regardless of idle. Identified agents — like
  //          recipe-spawned children whose per-session .mcp.json has
  //          a session-id header that survives — get pinned to liveness.
  //        - Else if idle > CLAWDEVBOX_MCP_IDLE_MS, REAP. Default is
  //          24 hours — long enough that the main agent waiting for
  //          human input is never surprised by a 404, short enough that
  //          crashed / abandoned spawned agents don't accumulate
  //          indefinitely. (The main agent's session id is invisible
  //          to us when the spawn goes through a wrapper like agency
  //          that re-emits the `clawdevbox` MCP server entry without
  //          our headers — so isAgentSessionAlive can't pin it. Until
  //          we have a header-independent identification path (URL
  //          tokens etc.), the long idle timeout is the pragmatic
  //          correctness/cleanup trade-off.)
  //   3. Reaping calls transport.close() so the SDK releases sockets
  //      and message buffers, then drops the map entry.
  const MCP_IDLE_MS = Number(process.env.CLAWDEVBOX_MCP_IDLE_MS) || 24 * 60 * 60 * 1000;
  const MCP_SWEEP_MS = Number(process.env.CLAWDEVBOX_MCP_SWEEP_MS) || 60 * 1000;
  interface TransportEntry {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
    lastAgentSessionId: string | null;
  }
  const mcpTransportEntries = new Map<string, TransportEntry>();

  // Helper: is the agent session that this transport claims still alive?
  // "Alive" means we know about it through one of the runtime registries.
  // Returns true if we know it's alive; false if we know it's dead OR if
  // we have no agent-session binding (those fall back to idle-based sweep).
  // The main agent is included automatically: it registers in pty-registry
  // with sessionId=handle.sessionId (see main-agent.ts), so the
  // pty-registry walk below catches it as long as the main agent process
  // is still running.
  const isAgentSessionAlive = (asid: string | null | undefined): boolean => {
    if (!asid) return false;
    try {
      for (const e of tmuxSessionRegistry.list()) {
        if (e.instanceId === asid) return true;
      }
    } catch { /* registry not yet initialized */ }
    try {
      for (const s of listPtySessions()) {
        const meta = getPtySessionMeta(s.instanceId);
        if (meta?.sessionId === asid) return true;
      }
    } catch { /* registry not yet initialized */ }
    return false;
  };

  // Backward-compat proxy: existing call sites (and the SDK) want a
  // Map<string, transport>. We expose a get/set/delete proxy that keeps
  // the entries map in sync.
  const mcpTransports = new Proxy(new Map<string, StreamableHTTPServerTransport>(), {
    get(_target, prop, _receiver) {
      if (prop === 'get') {
        return (key: string) => {
          const entry = mcpTransportEntries.get(key);
          if (entry) entry.lastActivity = Date.now();
          return entry?.transport;
        };
      }
      if (prop === 'set') {
        return (key: string, value: StreamableHTTPServerTransport) => {
          mcpTransportEntries.set(key, {
            transport: value,
            lastActivity: Date.now(),
            lastAgentSessionId: null,
          });
          return mcpTransports;
        };
      }
      if (prop === 'delete') {
        return (key: string) => mcpTransportEntries.delete(key);
      }
      if (prop === 'has') {
        return (key: string) => mcpTransportEntries.has(key);
      }
      if (prop === 'size') {
        return mcpTransportEntries.size;
      }
      if (prop === Symbol.iterator || prop === 'entries') {
        return () => {
          const it = mcpTransportEntries.entries();
          return {
            [Symbol.iterator]() { return this; },
            next() {
              const r = it.next();
              if (r.done) return { done: true, value: undefined } as IteratorResult<[string, StreamableHTTPServerTransport]>;
              const [k, v] = r.value;
              return { done: false, value: [k, v.transport] as [string, StreamableHTTPServerTransport] };
            },
          };
        };
      }
      if (prop === 'forEach') {
        return (cb: (v: StreamableHTTPServerTransport, k: string) => void) => {
          for (const [k, entry] of mcpTransportEntries) cb(entry.transport, k);
        };
      }
      return undefined;
    },
  }) as unknown as Map<string, StreamableHTTPServerTransport>;

  // Track the agent session id per MCP request so the sweep can keep
  // transports that belong to alive agents. Exported so handleMcpRequest
  // can call it on every inbound HTTP request.
  const recordAgentSessionIdForMcpRequest = (
    mcpSessionId: string,
    agentSessionId: string | null,
  ): void => {
    const entry = mcpTransportEntries.get(mcpSessionId);
    if (entry && agentSessionId) entry.lastAgentSessionId = agentSessionId;
  };

  // Periodic idle sweep.
  const mcpSweepTimer = setInterval(() => {
    const now = Date.now();
    let reaped = 0;
    let kept = 0;
    for (const [sid, entry] of mcpTransportEntries) {
      if (isAgentSessionAlive(entry.lastAgentSessionId)) {
        kept++;
        continue;
      }
      if (now - entry.lastActivity <= MCP_IDLE_MS) {
        kept++;
        continue;
      }
      try { entry.transport.close?.(); } catch { /* ignore */ }
      mcpTransportEntries.delete(sid);
      reaped++;
    }
    if (reaped > 0) {
      logger.info(
        { reaped, kept, idleMs: MCP_IDLE_MS },
        'mcp: reaped idle transports',
      );
    }
  }, MCP_SWEEP_MS);
  if (mcpSweepTimer.unref) mcpSweepTimer.unref();

  const expectedToken = cfg.http.token;
  const homePageHtml = renderHomePage({
    mcpUrl: `http://${cfg.http.host}:${cfg.http.port}/mcp`,
    projectDir: ws.projectDir,
  });

  // Cron API context — populated once the dispatcher/scheduler exist.
  // The request handler closure reads `cronApiCtx` per-request, so by the
  // time the listener is actually accepting requests it's been assigned.
  let cronApiCtx: CronApiContext | null = null;
  let testHookDispatcher: Dispatcher | null = null;
  let testHookDaemonSupervisor: DaemonSupervisor | null = null;

  // ── Fast response caches for list endpoints ─────────────────────────────
  // /api/inbox and /api/recipes are now fully SQL-backed (V6+) and read in
  // <30ms cold. The cache is a thin rate-limiter that coalesces rapid SPA
  // polls (~every 2s) into a single SQL query. Invalidated on the relevant
  // event-bus topics; the 2 s TTL provides a fallback in case an event is
  // missed.
  const API_CACHE_TTL_MS = 2_000;
  const inboxCache: { json: string | null; ts: number } = { json: null, ts: 0 };
  const recipeCache: { json: string | null; ts: number } = { json: null, ts: 0 };

  onChange((topic) => {
    if (topic === 'inbox' || topic === 'artifacts') {
      inboxCache.json = null;
    }
    if (topic === 'recipes') {
      recipeCache.json = null;
    }
  });

  /** Pre-compute and store the inbox list cache entry. */
  const warmInboxCache = () => {
    try {
      const items = inbox.list({ limit: 200 });
      const enriched = enrichInboxItemsForList(items);
      inboxCache.json = JSON.stringify({ items: enriched });
      inboxCache.ts = Date.now();
    } catch { /* non-fatal; first request will recompute */ }
  };

  /** Pre-compute and store the recipe list cache entry. */
  const warmRecipeCache = () => {
    try {
      const items = listAllRecipeInstancesFromDb();
      items.sort((a, b) => {
        const ra = recipeSortRank(a.status);
        const rb = recipeSortRank(b.status);
        if (ra !== rb) return ra - rb;
        return (b.started_at ?? 0) - (a.started_at ?? 0);
      });
      const byParent = new Map<string, RecipeInstance[]>();
      for (const inst of items) {
        const pid = inst.parent_recipe_instance_id;
        if (typeof pid === 'string' && pid.length > 0) {
          const arr = byParent.get(pid) ?? [];
          arr.push(inst);
          byParent.set(pid, arr);
        }
      }
      const enriched = items.map((inst) => {
        const children = byParent.get(inst.id) ?? [];
        let awaiting_user_count = 0;
        let total_steps = 0;
        let completed_steps = 0;
        if (Array.isArray(inst.steps)) {
          total_steps = inst.steps.length;
          for (const s of inst.steps) {
            if (s.status === 'done' || s.status === 'skipped') completed_steps++;
            if (s.status === 'awaiting_user') awaiting_user_count++;
          }
        }
        return {
          ...inst,
          children: children.map((c) => ({ id: c.id, recipe_id: c.recipe_id, status: c.status })),
          progress: total_steps > 0
            ? { total_steps, completed_steps, awaiting_user_count }
            : null,
        };
      });
      recipeCache.json = JSON.stringify({ items: enriched });
      recipeCache.ts = Date.now();
    } catch { /* non-fatal */ }
  };

  const serviceStartedAt = Date.now();
  const ownVersion = readOwnVersion();

  // Long-running memory observability. Logs a heap-usage line every 60 s
  // and writes an automatic .heapsnapshot under <globalDir>/heap-snapshots/
  // when heap crosses 80% of the configured --max-old-space-size. We've
  // had OOM crashes after ~30 min uptime with no visible cause; this gives
  // the next leak an actionable artifact rather than a stack trace from
  // V8's mark-compact thrash. /api/heap-snapshot triggers one on demand
  // (loopback-only, no bearer). Started here (before createServer) so the
  // request-handler closure captures a fully-initialized handle even if
  // the very first request races the server.listen() callback.
  const heapMonitor: HeapMonitorHandle = startHeapMonitor({
    snapshotDir: join(ws.globalDir, 'heap-snapshots'),
  });

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${cfg.http.host}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    // Loopback-only memory diagnostics. GET returns the latest heap sample
    // (rss, heapUsed, heapTotal, configured max-old-space-size); POST writes
    // a `.heapsnapshot` under <globalDir>/heap-snapshots/ and returns the
    // path. Use to capture state on demand when investigating a memory leak
    // without restarting the server.
    if (url.pathname === '/api/heap-status' || url.pathname === '/api/heap-snapshot') {
      const remote = req.socket.remoteAddress ?? '';
      const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLoopback) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'LOOPBACK_ONLY' } }));
        return;
      }
      if (url.pathname === '/api/heap-status' && req.method === 'GET') {
        // Enrich the heap sample with per-subsystem counters so the next
        // climb is diagnosable from /api/heap-status alone (no need to
        // walk a heap snapshot for the obvious suspects).
        const { pendingDispatchStats } = await import('../pending-dispatch-registry.ts');
        const ptyLive = listPtySessions();
        const pendingStats = pendingDispatchStats();
        const enriched = {
          ...heapMonitor.lastSample(),
          counters: {
            mcpSessions: mcpTransports.size,
            ptySessions: ptyLive.length,
            ptyBufferBytesTotal: 0,  // pty buffers are bounded at 256 KB each
            tmuxSessions: tmuxSessionRegistry.list().length,
            pendingDispatch: pendingStats,
            workspacesInDb: opened.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number },
            daemonRunsLive: opened.db.prepare(
              "SELECT COUNT(*) AS n FROM daemon_runs WHERE status IN ('starting','running')"
            ).get() as { n: number },
          },
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(enriched));
        return;
      }
      if (url.pathname === '/api/heap-snapshot' && req.method === 'POST') {
        const file = heapMonitor.snapshotNow();
        heapMonitor.armSnapshot();
        res.writeHead(file ? 200 : 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(file ? { ok: true, file } : { ok: false, error: 'writeHeapSnapshot failed' }));
        return;
      }
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED' } }));
      return;
    }

    // Loopback-only test hooks: /api/test/recipe-run, /api/test/trigger-fire,
    // /api/test/run-e2e, /api/test/agent-clis. Handled before /mcp so they
    // never see bearer auth.
    if (url.pathname.startsWith('/api/test/')) {
      const handled = await handleTestHook(url, req, res, { cfg, ws, db: opened.db, getDispatcher: () => testHookDispatcher });
      if (handled) return;
    }

    if (isMcpPath(url.pathname)) {
      // Auth is opt-in: when no token is configured, /mcp is open (loopback
      // protection only). When a token IS set, we DO NOT send a
      // `WWW-Authenticate: Bearer` header on 401 because Copilot CLI's MCP
      // SDK interprets that as "OAuth required" and falls into a futile
      // discovery loop. Plain 401 lets clients see the failure and reuse
      // the configured static bearer.
      if (expectedToken) {
        const presented = bearerToken(req);
        if (!presented) {
          rejectUnauthorized(res, 'missing bearer token');
          return;
        }
        if (!constantTimeEquals(presented, expectedToken)) {
          rejectUnauthorized(res, 'invalid bearer token');
          return;
        }
      }
      await handleMcpRequest(req, res, ws, mcpTransports, recordAgentSessionIdForMcpRequest);
      return;
    }

    // Home page UI (loopback only — bearer auth is on /mcp).
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(homePageHtml);
      return;
    }

    // Standalone test UI — single self-contained HTML page with embedded
    // CSS + JS for hand-driving the /spawn + /dispatch + /api/sessions
    // endpoints. Loaded from CDN: xterm.js + addon-fit. No build step.
    // Accessible at http://127.0.0.1:5201/test-ui — loopback only.
    if (url.pathname === '/test-ui' || url.pathname === '/test-ui/' || url.pathname === '/test-ui/index.html') {
      const { renderTestUI } = await import('../test-ui.ts');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderTestUI());
      return;
    }

    // Vite-built SPA assets — /assets/<name>-<hash>.{js,css,svg,…}.
    // Long-cached because the filename is hashed; index.html itself is
    // re-fetched per visit so deploys land immediately.
    if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
      const filePath = resolveSpaAsset(url.pathname);
      if (filePath) {
        const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
        const ctype =
          ext === 'js'   ? 'application/javascript; charset=utf-8' :
          ext === 'css'  ? 'text/css; charset=utf-8' :
          ext === 'svg'  ? 'image/svg+xml; charset=utf-8' :
          ext === 'json' ? 'application/json; charset=utf-8' :
          ext === 'wasm' ? 'application/wasm' :
          ext === 'png'  ? 'image/png' :
          ext === 'webp' ? 'image/webp' :
          ext === 'woff2'? 'font/woff2' :
          ext === 'woff' ? 'font/woff' :
          'application/octet-stream';
        const buf = readFileSync(filePath);
        res.writeHead(200, {
          'content-type': ctype,
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(buf);
        return;
      }
      // Fall through to 404 below if not found.
    }

    // PWA assets — manifest, service worker, vector icon.
    if (url.pathname === '/manifest.webmanifest' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'application/manifest+json',
        'cache-control': 'public, max-age=300',
      });
      res.end(manifestJson());
      return;
    }
    if (url.pathname === '/sw.js' && req.method === 'GET') {
      // Service workers MUST be served with a JS MIME type, and shouldn't
      // be cached aggressively — browsers refetch sw.js every 24h anyway,
      // but `no-cache` ensures shell updates land on the next visit.
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      });
      res.end(serviceWorkerJs());
      return;
    }
    if (url.pathname === '/icon.svg' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      });
      res.end(iconSvg());
      return;
    }
    if (url.pathname === '/icon-maskable.svg' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      });
      res.end(iconMaskableSvg());
      return;
    }
    if (url.pathname === '/favicon.ico' && req.method === 'GET') {
      // 302 to the svg — saves shipping a separate .ico binary.
      res.writeHead(302, { location: '/icon.svg', 'cache-control': 'public, max-age=86400' });
      res.end();
      return;
    }

    if (url.pathname === '/api/inbox' && req.method === 'GET') {
      const now = Date.now();
      if (inboxCache.json && now - inboxCache.ts < API_CACHE_TTL_MS) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(inboxCache.json);
        return;
      }
      warmInboxCache();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(inboxCache.json ?? JSON.stringify({ items: [] }));
      return;
    }

    // GET /api/inbox/<id> — single item with body inlined (if any).
    if (url.pathname.startsWith('/api/inbox/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/inbox/'.length));
      if (!id) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing id' }));
        return;
      }
      const item = inbox.read(id);
      if (!item) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'inbox item not found', id }));
        return;
      }
      const [enriched] = enrichInboxItemsForList(
        [item],
      );
      let description: string | null = null;
      if (
        typeof item.description_size === 'number' &&
        item.description_size > 0 &&
        item.description_format
      ) {
        description = readInboxBody(cfg.globalDir, item.id, item.description_format);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ item: enriched, description }));
      return;
    }

    // POST /api/inbox/<id>/<verb> — lifecycle mutations.
    //   state    body { state: 'new'|'open'|'done'|'archived' }
    //   snooze   body { until: <unix-ms in the future> }
    //   archive  (no body — equivalent to state=archived)
    //   done     (no body — equivalent to state=done)
    {
      const m = url.pathname.match(
        /^\/api\/inbox\/([^/]+)\/(state|snooze|archive|done)\/?$/,
      );
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const verb = m[2] as 'state' | 'snooze' | 'archive' | 'done';
        await handleInboxAction(req, res, id, verb, cfg);
        return;
      }
    }

    // POST /api/recipes/<id>/resume — spawn a new agent CLI session with
    // `--resume <session_id>` and write a new recipe-instance row tied
    // back to the original via `resume_of`. Source instance must have
    // session_id set.
    {
      const m = url.pathname.match(/^\/api\/recipes\/([^/]+)\/resume\/?$/);
      if (m && req.method === 'POST') {
        await handleRecipeResume(req, res, decodeURIComponent(m[1]), cfg, ws);
        return;
      }
    }

    if (url.pathname === '/api/recipes' && req.method === 'GET') {
      const now = Date.now();
      if (recipeCache.json && now - recipeCache.ts < API_CACHE_TTL_MS) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(recipeCache.json);
        return;
      }
      warmRecipeCache();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(recipeCache.json ?? JSON.stringify({ items: [] }));
      return;
    }

    // Triggers — types catalog (read-only) + registered instances.
    if (url.pathname === '/api/triggers/types' && req.method === 'GET') {
      const items = [...ws.triggerTypes.values()].map((t) => ({
        id: t.id,
        source_plugin_id: t.source_plugin_id,
        scope: t.scope,
        description: t.description,
        default_cron: t.default_cron,
        accepts_webhook: t.accepts_webhook,
        identity_param: t.identity_param,
        parameters: t.parameters,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items, errors: ws.triggerTypeErrors }));
      return;
    }
    if (url.pathname === '/api/triggers' && req.method === 'GET') {
      const file = readTriggersFile(triggersJsonPath(ws));
      const now = Date.now();
      // Project the rows so we don't leak full state.* (might contain
      // plugin-private fields) but include the resolved cron the UI
      // needs to display "off / inherits / <expr>" plus a humanized
      // label and next_run_at when applicable.
      const items = file.registered.map((r) => {
        const type = ws.triggerTypes.get(r.type);
        const resolved_cron =
          r.cron === false || r.cron === ''
            ? false
            : typeof r.cron === 'string' && r.cron.length > 0
              ? r.cron
              : (type?.default_cron ?? null);
        // next_run_at is null unless this trigger is enabled AND has a
        // parseable cron expression. Disabled / webhook-only triggers
        // never get a next-fire prediction.
        const cronExpr =
          r.enabled && typeof resolved_cron === 'string' && resolved_cron.length > 0
            ? resolved_cron
            : null;
        return {
          id: r.id,
          type: r.type,
          source_plugin_id: type?.source_plugin_id ?? null,
          type_description: type?.description ?? null,
          params: r.params,
          cron: r.cron,
          resolved_cron,
          cron_label: cronExpr ? cronLabel(cronExpr) : null,
          next_run_at: cronExpr ? nextRunAfter(cronExpr, now) : null,
          enabled: r.enabled,
          subscriber_thread_id: r.subscriber_thread_id ?? null,
          registered_at: r.registered_at,
          last_run_at: r.last_run_at ?? null,
          last_run_status: r.last_run_status ?? null,
          last_run_error: r.last_run_error ?? null,
        };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items }));
      return;
    }

    // Pending approvals (for the "needs your input" badge).
    if (url.pathname === '/api/approvals' && req.method === 'GET') {
      const items = approvals.listPending();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items }));
      return;
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      handleSse(req, res);
      return;
    }

    // --- Push notifications --------------------------------------------
    if (url.pathname === '/api/push/vapid' && req.method === 'GET') {
      const enabled = !!cfg.notifications?.enabled;
      const pub = cfg.notifications?.vapid?.publicKey;
      if (!enabled || !pub) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ enabled: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, publicKey: pub }));
      return;
    }
    if (url.pathname === '/api/push/status' && req.method === 'GET') {
      const enabled = !!cfg.notifications?.enabled && !!cfg.notifications?.vapid;
      const subs = enabled
        ? listSubscriptions({ globalDir: cfg.globalDir, projectDir: cfg.projectDir })
        : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          enabled,
          subscriptions: subs.map((s) => ({
            endpoint: s.endpoint,
            label: s.label,
            created_at: s.created_at,
            last_seen_at: s.last_seen_at,
          })),
        }),
      );
      return;
    }
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      handlePushSubscribe(
        req,
        res,
        { globalDir: cfg.globalDir, projectDir: cfg.projectDir },
        !!cfg.notifications?.enabled,
      );
      return;
    }
    if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      handlePushUnsubscribe(req, res, { globalDir: cfg.globalDir, projectDir: cfg.projectDir });
      return;
    }
    if (url.pathname === '/api/push/test' && req.method === 'POST') {
      const vapid = cfg.notifications?.vapid;
      if (!vapid || !cfg.notifications?.enabled) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'notifications not enabled — re-run `clawdevbox init`' }));
        return;
      }
      sendNotification({ globalDir: cfg.globalDir, projectDir: cfg.projectDir }, vapid, {
        title: 'clawdevbox',
        body: 'Test notification — push is working.',
        url: '/',
        tag: 'clawdevbox-test',
      })
        .then((result) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        });
      return;
    }

    if (url.pathname === '/api/main-agent/status' && req.method === 'GET') {
      const status = getMainAgentStatus();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (url.pathname === '/api/tunnel/status' && req.method === 'GET') {
      const status = getTunnelStatus();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // Agent-CLI provider registry — bearer-protected list endpoint.
    if (await handleAgentCliApi(req, res, ws, cfg, expectedToken)) return;

    // Trigger-kernel introspection / control + Mode B callbacks.
    if (cronApiCtx) {
      if (await handleCronApi(req, res, cronApiCtx)) return;
    }

    dispatchTerminalRequest(req, res);
  });

  // Attach terminal viewer to the same server (it adds the WS upgrade
  // handler internally; request dispatch is composed above).
  await startTerminalServer({ workspace: ws, sharedServer: httpServer });

  // Construct the dispatcher and bind the session-helper context before
  // listen, so MCP session.* tools cannot observe an uninitialized context
  // after the HTTP server starts accepting requests.
  const dispatcher = new Dispatcher(opened.db, ws, {
    maxConcurrent: cfg.cron.max_concurrent,
    drainMs: cfg.cron.dispatcher_drain_ms,
    callbackUrlBase: `http://${cfg.http.host}:${cfg.http.port}`,
    defaultAgentCli: cfg.defaultAgentCli ?? 'copilot',
  });

  // Late-bind the session-helper context so MCP tools in tools/session.ts
  // can access dispatcher + db + cfg + ws at call time (they're registered
  // during buildServer(), before these values exist).
  (globalThis as Record<string, unknown>).__clawdevboxSessionHelperCtx = {
    db: opened.db,
    dispatcher,
    ws,
    cfg,
  };

  const listenResult = await listenOrConfirmExisting(
    httpServer,
    cfg.http.host,
    cfg.http.port,
    expectedToken,
  );
  if (listenResult === 'already-running') {
    logger.info(
      { port: cfg.http.port },
      'clawdevbox HTTP service already running — exiting cleanly',
    );
    closeDatabase();
    process.exit(0);
  }
  if (listenResult === 'conflict') {
    logger.error(
      { port: cfg.http.port },
      `port ${cfg.http.port} is in use by something else — exiting`,
    );
    closeDatabase();
    process.exit(1);
  }

  const addr = httpServer.address();
  const boundPort =
    addr && typeof addr === 'object' ? addr.port : cfg.http.port;

  // Bring up the trigger kernel — dispatcher first (it accepts pickUp()
  // calls immediately), then the scheduler that pokes it on each wake.
  testHookDispatcher = dispatcher;
  dispatcher.start();
  const scheduler = new Scheduler(opened.db, dispatcher, ws);
  scheduler.start();

  // Daemon supervisor — keeps `enabled=1` script daemons always running.
  // Looks up each daemon's workspace path through the workspaces table on
  // demand so a new workspace mid-session also resolves.
  const daemonSupervisor = new DaemonSupervisor(opened.db, {
    resolveWorkspacePath: (workspace_id: string) => {
      const row = opened.db.prepare('SELECT path FROM workspaces WHERE id = ?')
        .get(workspace_id) as { path: string } | undefined;
      return row?.path ?? null;
    },
  });
  daemonSupervisor.start();
  (globalThis as Record<string, unknown>).__clawdevboxDaemonToolCtx = {
    db: opened.db,
    supervisor: daemonSupervisor,
    defaultWorkspacePath: cfg.projectDir,
  };
  testHookDaemonSupervisor = daemonSupervisor;

  // Idle-session reaper — kills tmux-backed sessions that have sat idle
  // with no viewer attached for > 15 min, so /spawn'd copilot/agency
  // processes don't accumulate after the user closes their browser tab.
  // Exempts the Main Agent.
  const idleReaper = startIdleReaper({
    db: opened.db,
    tmuxClient,
  });
  cronApiCtx = {
    db: opened.db,
    scheduler,
    dispatcher,
    dbPath: opened.path,
    schemaVersion: opened.schemaVersion,
    service: {
      pid: process.pid,
      port: boundPort,
      started_at: serviceStartedAt,
      version: ownVersion,
    },
    expectedToken,
    ws,
    cfg,
  };
  logger.info(
    {
      max_concurrent: cfg.cron.max_concurrent,
      drain_ms: cfg.cron.dispatcher_drain_ms,
    },
    'trigger kernel started',
  );

  // Sweep stale `inuse.<pid>.lock` files left under
  // `~/.copilot/session-state/<uuid>/` by prior copilot processes that
  // were force-killed (clawdevbox crash, OS reboot, SIGKILL). If we don't
  // remove these BEFORE the main agent (or any other spawn) starts, the
  // next copilot --session-id=<uuid> hits the "Session in use" modal which
  // swallows our initial prompt.
  try {
    const { scanned, removed } = cleanCopilotStaleLocks();
    if (scanned > 0) {
      logger.info({ scanned, removed }, 'startup: swept stale copilot inuse locks');
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'startup: stale-lock sweep threw',
    );
  }

  // Spawn the dev-buddy main agent. Failures are non-fatal — the home page
  // still loads; the agent tab just shows a disconnected terminal.
  const mainAgent = await startMainAgent({
    workspace: ws,
    cfg,
    host: cfg.http.host,
    port: boundPort,
  });

  // Bring up the public tunnel (if configured). Spawn errors (CLI missing,
  // not logged in, network) are captured in tunnelStatus.error so the
  // banner + /api/tunnel/status surface a clear, actionable message.
  let tunnelStatus: TunnelStatus = getTunnelStatus();
  if (cfg.tunnel.kind === 'devtunnel' && cfg.tunnel.auto_start) {
    // Refresh PATH from registry / scan install dirs BEFORE probing for
    // devtunnel. On Windows the service can boot in a shell that pre-dates
    // a winget install (Run-key auto-start, npx invocation from an old
    // terminal, etc.) — the registry refresh catches that.
    const { ensureDevtunnelOnPath } = await import('./ensure-devtunnel.ts');
    ensureDevtunnelOnPath();

    const tunnelName = cfg.tunnel.name ?? deriveTunnelName(cfg.projectDir);
    tunnelStatus = await startTunnel({
      kind: 'devtunnel',
      name: tunnelName,
      port: boundPort,
      allowAnonymous: cfg.tunnel.allow_anonymous,
    });
  }

  logger.info(
    {
      transport: 'streamable-http',
      projectDir: ws.projectDir,
      url: `http://${cfg.http.host}:${boundPort}/mcp`,
      home: `http://${cfg.http.host}:${boundPort}/`,
      mainAgent: mainAgent.running ? 'running' : 'not-started',
      tunnel: {
        kind: tunnelStatus.kind,
        running: tunnelStatus.running,
        url: tunnelStatus.url,
        error: tunnelStatus.error,
      },
      plugins: ws.plugins.size,
      hostedErrors: hostedErrors.length,
    },
    'ready',
  );

  const tunnelBannerLine = formatTunnelBannerLine(
    tunnelStatus,
    boundPort,
    expectedToken,
    cfg.tunnel.allow_anonymous,
  );

  // Print a friendly banner to stderr so the user sees it in their terminal.
  const mcpLine = expectedToken
    ? `  MCP:        http://${cfg.http.host}:${boundPort}/mcp  (Authorization: Bearer ${maskToken(expectedToken)})\n`
    : `  MCP:        http://${cfg.http.host}:${boundPort}/mcp  (no bearer auth — loopback only)\n`;
  process.stderr.write(
    `\nclawdevbox ready at http://${cfg.http.host}:${boundPort}\n` +
      `  Home:       http://${cfg.http.host}:${boundPort}/   (Inbox + Main Agent)\n` +
      mcpLine +
      `  Terminal:   http://${cfg.http.host}:${boundPort}/terminal/<instance_id>\n` +
      `  Artifacts:  http://${cfg.http.host}:${boundPort}/artifact/<id>\n` +
      `  Health:     http://${cfg.http.host}:${boundPort}/healthz\n` +
      `  Main agent: ${
        mainAgent.running
          ? `${mainAgent.agent_cli} (running)`
          : `NOT running — ${
              mainAgent.not_running_reason ??
              `reason unknown (check the warn log lines above and the Agent tab at /terminal/main)`
            }`
      }\n` +
      tunnelBannerLine +
      `\nPress Ctrl+C to stop.\n`,
  );

  // Pre-warm API caches in the background so the first browser request is
  // fast (warm) rather than cold (18-20 s filesystem scan).  Fire-and-forget
  // after a short delay to avoid contending with the main-agent spawn.
  setImmediate(() => {
    warmInboxCache();
    warmRecipeCache();
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'shutting down');
    // Kill all live pty trees FIRST so child agent processes (agency.exe,
    // copilot.exe, claude.exe, plus their grandchildren) don't outlive us
    // as orphans. The two-phase implementation tries graceful exit via
    // \x03\x03 (double Ctrl+C) first so copilot can clean up its session
    // lock files, then force-kills the survivors.
    killAllSessions(2000)
      .then((killed) => {
        if (killed > 0) logger.info({ killed }, 'shutdown: killed pty trees');
      })
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'shutdown: killAllSessions threw',
        );
      });
    // Order: stop scheduler (no new wakes) → drain dispatcher → stop tunnel
    // → close DB → close HTTP. We give the dispatcher its configured drain
    // window before the hard 5s exit timeout below kicks in.
    scheduler.stop();
    heapMonitor.stop();
    idleReaper.stop();
    // Daemon supervisor: gracefully stop every supervised daemon. Best-
    // effort; bounded by the supervisor's drainMs.
    daemonSupervisor.stop().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'daemon-supervisor.stop threw',
      );
    });
    dispatcher
      .stop()
      .catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'dispatcher.stop threw',
        );
      })
      .finally(() => {
        stopTunnel().finally(() => {
          closeDatabase();
          httpServer.close(() => process.exit(0));
        });
      });
    // Hard exit after grace period in case sockets keep us alive.
    setTimeout(() => process.exit(0), 30_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function formatTunnelBannerLine(
  t: TunnelStatus,
  localPort: number,
  token: string | null,
  allowAnonymous: boolean,
): string {
  if (t.kind === 'none') return '';
  if (t.error) {
    return `  Tunnel:     devtunnel "${t.name ?? '?'}" FAILED — ${t.error}\n`;
  }
  if (!t.running) {
    return `  Tunnel:     devtunnel "${t.name ?? '?'}" starting…\n`;
  }
  const accessNote = allowAnonymous
    ? 'anonymous OK — only /mcp bearer auth gates access'
    : 'private — clients need a devtunnel access token + the /mcp bearer';
  if (t.url) {
    const mcpAuthSuffix = token ? `  (Authorization: Bearer ${maskToken(token)})` : '  (no bearer auth)';
    return (
      `  Tunnel:     ${t.url}   →   localhost:${localPort}  (${accessNote})\n` +
      `              public MCP: ${t.url}/mcp${mcpAuthSuffix}\n` +
      (t.inspect_url ? `              inspect:    ${t.inspect_url}\n` : '') +
      (!allowAnonymous
        ? `              get token:  devtunnel token ${t.name ?? '<name>'} -s\n`
        : '')
    );
  }
  return `  Tunnel:     devtunnel "${t.name ?? '?'}" running (URL pending — check /api/tunnel/status)\n`;
}

function maskToken(t: string): string {
  if (t.length <= 8) return '****';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/**
 * Read up to MAX bytes of a JSON request body. Returns the parsed object,
 * or writes a 400 and returns null.
 */
async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  const MAX = 64 * 1024; // 64KB — push subscriptions are <1KB; this is plenty.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c instanceof Buffer ? c : Buffer.from(c);
    total += buf.length;
    if (total > MAX) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      return null;
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'empty body' }));
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'invalid JSON: ' + (err instanceof Error ? err.message : String(err)),
      }),
    );
    return null;
  }
}

async function handlePushSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  loc: { globalDir: string; projectDir: string },
  enabled: boolean,
): Promise<void> {
  if (!enabled) {
    logger.warn({ projectDir: loc.projectDir }, 'push subscribe rejected: notifications disabled in config');
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'notifications not enabled — re-run `clawdevbox init`' }),
    );
    return;
  }
  const body = await readJsonBody<{
    endpoint: string;
    keys?: { p256dh?: string; auth?: string };
    label?: string;
  }>(req, res);
  if (!body) return;
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    logger.warn(
      { hasEndpoint: !!body.endpoint, hasP256: !!body.keys?.p256dh, hasAuth: !!body.keys?.auth },
      'push subscribe rejected: incomplete body',
    );
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'body must include { endpoint, keys: { p256dh, auth } }',
      }),
    );
    return;
  }
  const record: PushSubscriptionRecord = addSubscription(loc, {
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    label: typeof body.label === 'string' ? body.label.slice(0, 80) : undefined,
  });
  logger.info(
    { endpointHost: tryUrlHost(record.endpoint), label: record.label },
    'push subscribe accepted',
  );
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, endpoint: record.endpoint }));
}

function tryUrlHost(u: string): string {
  try { return new URL(u).host; } catch { return '?'; }
}

async function handlePushUnsubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  loc: { globalDir: string; projectDir: string },
): Promise<void> {
  const body = await readJsonBody<{ endpoint: string }>(req, res);
  if (!body) return;
  if (!body.endpoint) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'body must include { endpoint }' }));
    return;
  }
  const removed = removeSubscription(loc, body.endpoint);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, removed }));
}

/**
 * Handle the inbox lifecycle mutation routes — `state`, `snooze`,
 * `archive`, `done`. All four ultimately delegate to the InboxStore
 * (which emits SSE 'inbox' on mutation so connected SPAs auto-refresh).
 * Returns the enriched updated item.
 */
async function handleInboxAction(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  verb: 'state' | 'snooze' | 'archive' | 'done',
  cfg: ResolvedConfig,
): Promise<void> {
  const existing = inbox.read(id);
  if (!existing) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'inbox item not found', id }));
    return;
  }

  let updated;
  if (verb === 'archive') {
    updated = inbox.archive(id);
  } else if (verb === 'done') {
    updated = inbox.setState(id, 'done');
  } else if (verb === 'state') {
    const body = await readJsonBody<{ state?: string }>(req, res);
    if (!body) return;
    const allowed = ['new', 'open', 'done', 'archived'] as const;
    if (!body.state || !(allowed as readonly string[]).includes(body.state)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: `state must be one of: ${allowed.join(', ')}` }),
      );
      return;
    }
    updated = inbox.setState(id, body.state as 'new' | 'open' | 'done' | 'archived');
  } else if (verb === 'snooze') {
    const body = await readJsonBody<{ until?: number }>(req, res);
    if (!body) return;
    if (typeof body.until !== 'number' || !Number.isFinite(body.until)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'until must be a unix-ms number' }));
      return;
    }
    if (body.until <= Date.now()) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'until must be in the future',
          now: Date.now(),
          until: body.until,
        }),
      );
      return;
    }
    updated = inbox.snooze(id, body.until);
  } else {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `unknown verb: ${verb}` }));
    return;
  }

  if (!updated) {
    // shouldn't happen given the `existing` check above, but defensive
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'mutation returned no item' }));
    return;
  }
  const [enriched] = enrichInboxItemsForList(
    [updated],
  );
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ item: enriched }));
}

/**
 * Resume an agent CLI session. The caller passes the recipe-instance id
 * of the original run; we look up its `session_id` + `workspace_path` +
 * `agent_cli`, mint a new instance row tied back via `resume_of`, then
 * `pty.spawn` the agent with the appropriate `--resume <session_id>`
 * flag (Claude / Copilot / echo-stub). Demonstrates the explicit-session-id
 * pattern end-to-end.
 *
 * Body (optional): `{ prompt?: string }`. Defaults to "Continue."
 */
async function handleRecipeResume(
  req: IncomingMessage,
  res: ServerResponse,
  recipeInstanceId: string,
  cfg: ResolvedConfig,
  ws: Workspace,
): Promise<void> {
  // Locate the source instance directly from the DB (fast, no workspace scan).
  const allInstances = listAllRecipeInstancesFromDb();
  const source = allInstances.find((it) => it.id === recipeInstanceId);
  if (!source) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'recipe instance not found', id: recipeInstanceId }));
    return;
  }
  if (!source.session_id) {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'source instance has no session_id — cannot resume',
        id: recipeInstanceId,
      }),
    );
    return;
  }

  // Resume is interactive — no -p prompt is passed to the CLI. We still
  // accept an optional `prompt` in the body purely as the displayed
  // "first message" on the recipe-instance row (useful in the UI to
  // distinguish multiple resumes of the same session). Echo-stub uses
  // it as its inline-script prompt; real CLIs ignore it.
  const body = (await readJsonBody<{ prompt?: string }>(req, res)) ?? {};
  const prompt = body.prompt && body.prompt.length > 0 ? body.prompt : 'Resumed interactively from the UI.';

  const newInstanceId = mintRecipeInstanceId();
  const sessionId = source.session_id;
  const agentCli = source.agent_cli;
  const workspacePath = source.workspace_path;

  const instance: RecipeInstanceRow = {
    id: newInstanceId,
    recipe_id: source.recipe_id,
    recipe_snapshot: source.recipe_snapshot,
    workspace_id: source.workspace_id,
    workspace_path: workspacePath,
    prompt,
    params: source.params ?? {},
    agent_cli: agentCli,
    pid: null,
    started_at: Date.now(),
    status: 'running',
    completed_at: null,
    result: null,
    message: null,
    session_id: sessionId,
    resume_of: recipeInstanceId,
  };
  writeRecipeInstance(workspacePath, instance);

  // Resolve the provider from the workspace registry and delegate spawn.
  const provider = ws.agentCliProviders.get(agentCli);
  if (!provider) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'UNKNOWN_AGENT_CLI',
          message: `provider '${agentCli}' is not registered`,
        },
      }),
    );
    return;
  }

  const providerCtx = buildProviderCtx(ws, cfg);
  const spawnEnv: Record<string, string> = {
    CLAWDEVBOX_PROJECT_DIR: workspacePath,
    CLAWDEVBOX_RECIPE_INSTANCE_ID: newInstanceId,
    CLAWDEVBOX_WORKSPACE_ID: source.workspace_id,
    CLAWDEVBOX_WORKSPACES_ROOT: cfg.workspacesRoot,
    CLAWDEVBOX_SESSION_ID: sessionId,
  };

  let pid: number | undefined;
  try {
    const handle = await provider.spawnSession(providerCtx, {
      mode: 'interactive',
      init: { kind: 'resume', session_id: sessionId },
      role: 'recipe-instance',
      prompt,
      workspaceInfo: { id: source.workspace_id, path: workspacePath },
      ambientEnv: spawnEnv,
      mcp: {
        url: `http://${cfg.http.host}:${cfg.http.port}/mcp`,
        secret: cfg.http.token ?? '',
        workspaceId: source.workspace_id,
        recipeInstanceId: newInstanceId,
        projectDir: workspacePath,
        sessionId,
      },
      recipeInstanceId: newInstanceId,
      agentSessionId: sessionId,
      ptyCols: 120,
      ptyRows: 30,
    });
    const ptyProc = handle.pty!;
    pid = handle.pid ?? undefined;
    registerPty({
      instanceId: newInstanceId,
      workspaceId: source.workspace_id,
      cols: 120,
      rows: 30,
      ipty: ptyProc,
    });
    // Persist a copy of the pty stream to disk for post-mortem inspection.
    const logPath = join(
      workspacePath,
      '.clawdevbox',
      'recipe-instances',
      newInstanceId + '.log',
    );
    const logStream = (await import('node:fs')).createWriteStream(logPath, { flags: 'a' });
    ptyProc.onData((data) => { logStream.write(data); });
    ptyProc.onExit(({ exitCode }) => {
      try { logStream.end(); } catch { /* ignore */ }
      const current = readRecipeInstance(workspacePath, newInstanceId);
      if (current && current.status === 'running') {
        const ok = exitCode === 0;
        writeRecipeInstance(workspacePath, {
          ...current,
          status: ok ? 'success' : 'failure',
          completed_at: Date.now(),
          message: `agent exited with code ${exitCode}${ok ? '' : ' (no recipe.done call)'}`,
        });
      }
    });
    // Re-read before merging pid to avoid clobbering a fast-completing
    // agent (echo-stub) that already wrote status=success.
    const cur = readRecipeInstance(workspacePath, newInstanceId);
    if (cur) writeRecipeInstance(workspacePath, { ...cur, pid: pid ?? null });
    else writeRecipeInstance(workspacePath, { ...instance, pid: pid ?? null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeRecipeInstance(workspacePath, {
      ...instance,
      status: 'failure',
      completed_at: Date.now(),
      message: `spawn failed: ${msg}`,
    });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    new_recipe_instance_id: newInstanceId,
    session_id: sessionId,
    resume_of: recipeInstanceId,
    pid: pid ?? null,
    agent_cli: agentCli,
  }));
}

/**
 * Build a per-request lookup index covering every registered workspace
 * + the project dir. Resolves attachment / recipe-instance references
 * without making each lookup re-traverse the filesystem.
 */
interface ResolutionIndex {
  /** workspace_id → workspace path (also includes the project dir as 'project'). */
  workspacePaths: Map<string, string>;
  /** artifact_id → first workspace_id that holds it (or null if missing). */
  artifactWorkspaceById: Map<string, { workspaceId: string; type: string; title: string } | null>;
  /** recipe_instance_id → workspace_id holding it. */
  recipeInstanceWorkspaceById: Map<string, string | null>;
}

/**
 * Build a lookup index for the specific artifact IDs and recipe instance IDs
 * referenced in the given inbox items. Uses targeted DB queries (2 queries max)
 * instead of scanning all registered workspaces.
 */
function buildResolutionIndex(items: ReturnType<typeof inbox.list>): ResolutionIndex {
  const workspacePaths = new Map<string, string>();
  const artifactWorkspaceById = new Map<
    string,
    { workspaceId: string; type: string; title: string } | null
  >();
  const recipeInstanceWorkspaceById = new Map<string, string | null>();

  if (items.length === 0) {
    return { workspacePaths, artifactWorkspaceById, recipeInstanceWorkspaceById };
  }

  // Collect only the IDs that are actually referenced.
  const artifactIds: string[] = [];
  const recipeInstanceIds: string[] = [];
  for (const item of items) {
    const attachments = Array.isArray(item.attachments)
      ? (item.attachments as Array<{ artifact_id?: string }>)
      : [];
    for (const a of attachments) {
      if (typeof a.artifact_id === 'string' && a.artifact_id) {
        artifactIds.push(a.artifact_id);
      }
    }
    const ri = item.recipe_instance as { id: string } | null | undefined;
    if (ri && typeof ri.id === 'string' && ri.id) {
      recipeInstanceIds.push(ri.id);
    }
  }

  let db;
  try { db = getDatabase(); } catch { /* DB not open yet */ }
  if (!db) return { workspacePaths, artifactWorkspaceById, recipeInstanceWorkspaceById };

  if (artifactIds.length > 0) {
    const ph = artifactIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, workspace_id, type, COALESCE(title, '') AS title FROM artifacts WHERE id IN (${ph})`)
      .all(...artifactIds) as Array<{ id: string; workspace_id: string; type: string; title: string }>;
    for (const row of rows) {
      artifactWorkspaceById.set(row.id, {
        workspaceId: row.workspace_id,
        type: row.type,
        title: row.title,
      });
    }
  }

  if (recipeInstanceIds.length > 0) {
    const ph = recipeInstanceIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, workspace_id FROM recipe_instances WHERE id IN (${ph})`)
      .all(...recipeInstanceIds) as Array<{ id: string; workspace_id: string }>;
    for (const row of rows) {
      recipeInstanceWorkspaceById.set(row.id, row.workspace_id);
    }
  }

  return { workspacePaths, artifactWorkspaceById, recipeInstanceWorkspaceById };
}

interface EnrichedAttachment {
  artifact_id: string;
  workspace_id: string | null;
  title: string | null;
  type: string | null;
  /** `/artifact/<id>` if found; null otherwise. */
  view_url: string | null;
  resolved: boolean;
}

interface EnrichedRecipeRef {
  id: string;
  workspace_id: string | null;
  resolved: boolean;
}

/**
 * Add transient `view_url` + `resolved` fields to each item's
 * attachments and recipe_instance link. Uses targeted DB queries
 * to resolve only the IDs referenced in these items.
 */
function enrichInboxItemsForList(
  items: ReturnType<typeof inbox.list>,
) {
  if (items.length === 0) return [];
  const idx = buildResolutionIndex(items);

  return items.map((it) => {
    const attachments = Array.isArray(it.attachments) ? (it.attachments as Array<{
      artifact_id: string;
      workspace_id?: string;
      title?: string;
      type?: string;
    }>) : [];
    const enrichedAttachments: EnrichedAttachment[] = attachments.map((a) => {
      const hit = idx.artifactWorkspaceById.get(a.artifact_id) ?? null;
      const wsId = a.workspace_id ?? hit?.workspaceId ?? null;
      return {
        artifact_id: a.artifact_id,
        workspace_id: wsId,
        title: a.title ?? hit?.title ?? null,
        type: a.type ?? hit?.type ?? null,
        view_url: hit ? `/artifact/${encodeURIComponent(a.artifact_id)}` : null,
        resolved: !!hit,
      };
    });

    let recipeInstance: EnrichedRecipeRef | null = null;
    const ri = it.recipe_instance as { id: string; workspace_id?: string } | null | undefined;
    if (ri && typeof ri.id === 'string') {
      const hitWs = idx.recipeInstanceWorkspaceById.get(ri.id) ?? null;
      recipeInstance = {
        id: ri.id,
        workspace_id: ri.workspace_id ?? hitWs ?? null,
        resolved: !!hitWs,
      };
    }

    return {
      ...it,
      attachments: enrichedAttachments,
      recipe_instance: recipeInstance,
    };
  });
}

/** Sort priority — running first, then by completed-most-recent. */
function recipeSortRank(status: string): number {
  switch (status) {
    case 'running':
      return 0;
    case 'success':
      return 1;
    case 'failure':
      return 2;
    case 'cancelled':
      return 3;
    default:
      return 9;
  }
}

/**
 * SSE handler. Emits a `change` event whenever something the home page
 * cares about mutates — inbox / recipes / agent / tunnel. The browser
 * re-fetches the relevant API endpoint; the bus doesn't ship payloads, so
 * stale state isn't possible.
 *
 * Also sends a heartbeat comment every 25s so proxies that idle out long
 * connections (devtunnel, browser, corporate) keep the stream alive.
 */
function handleSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Disable buffering through nginx-style proxies and devtunnel.
    'x-accel-buffering': 'no',
  });
  // Push an opener so the client knows the connection is live and can
  // do an initial reconcile.
  res.write(`retry: 5000\n\n`);
  res.write(`event: hello\ndata: {}\n\n`);

  // SSE write backpressure guard. If the client connection is half-open
  // (TCP didn't notice the peer is gone, or a proxy is buffering), naïve
  // res.write() returns true but the data piles up in Node's send buffer
  // indefinitely. Over hours of background `change` events from the
  // event bus this can balloon into hundreds of MB per dead-but-not-
  // closed connection.
  //
  // Fix: when res.write() returns false (buffer above highWaterMark),
  // pause emitting until 'drain' fires. If 'drain' doesn't come within
  // a short timeout, treat the client as dead and tear the connection
  // down so cleanup() runs and the change-bus listener is unsubscribed.
  const DRAIN_TIMEOUT_MS = 30_000;
  let drainTimer: NodeJS.Timeout | null = null;
  let waitingForDrain = false;
  const safeWrite = (chunk: string): boolean => {
    if (waitingForDrain) {
      // Already backpressured — drop the chunk. This is the SSE
      // contract: clients are responsible for reconnecting and
      // doing a full re-sync via /api/* after the gap.
      return false;
    }
    let ok = false;
    try { ok = res.write(chunk); } catch { return false; }
    if (!ok) {
      waitingForDrain = true;
      drainTimer = setTimeout(() => {
        // Client hasn't drained in 30s — assume dead, force-close so
        // cleanup() runs. This is the only way to release the backed-up
        // buffer.
        try { res.destroy(); } catch { /* already closed */ }
      }, DRAIN_TIMEOUT_MS);
      if (drainTimer.unref) drainTimer.unref();
      res.once('drain', () => {
        waitingForDrain = false;
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      });
    }
    return ok;
  };

  const sendChange = (topic: string) => {
    safeWrite(`event: change\ndata: ${JSON.stringify({ topic })}\n\n`);
  };
  const unsubscribe = onChange(sendChange);

  const heartbeat = setInterval(() => {
    safeWrite(`: ping ${Date.now()}\n\n`);
  }, 25_000);
  // Don't keep the event loop alive for the heartbeat.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

/**
 * Wrap `server.listen(port, host)` so a second `clawdevbox start` against
 * the same port either:
 *   - returns `'already-running'`  if the existing listener responds to
 *                                  `GET /api/cron/status` with the expected
 *                                  token AND a body shaped like our own
 *                                  status payload, OR
 *   - returns `'conflict'`         if EADDRINUSE but the probe doesn't
 *                                  confirm a clawdevbox instance.
 * The plain success case returns `'listening'`.
 *
 * Exported so `tests/mcp-bootstrap.test.mjs` can exercise it without
 * needing a full `runStart` boot.
 */
export async function listenOrConfirmExisting(
  server: import('node:http').Server,
  host: string,
  port: number,
  token: string | null,
): Promise<'listening' | 'already-running' | 'conflict'> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    return 'listening';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') throw err;
    // Probe to see if it's our own service. When no token is configured the
    // running instance also has no auth, so we omit Authorization here.
    let probe: Response | null = null;
    try {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      probe = await fetch(`http://${host}:${port}/api/cron/status`, {
        headers,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      return 'conflict';
    }
    if (!probe || !probe.ok) return 'conflict';
    let body: unknown = null;
    try {
      body = await probe.json();
    } catch {
      return 'conflict';
    }
    const b = body as { db?: unknown; scheduler?: unknown; dispatcher?: unknown } | null;
    if (b && b.db && b.scheduler && b.dispatcher) return 'already-running';
    return 'conflict';
  }
}


/**
 * Spawn the foreground `clawdevbox start` as a detached background process,
 * register the OS auto-start entry so it relaunches at login, and record
 * the PID + port in `<globalDir>/service.json`.
 *
 * The detached child is launched with the same Node binary that ran us
 * (`process.execPath`) and the entry script `process.argv[1]`. That keeps
 * the install resilient to PATH changes — `clawdevbox stop` and the OS
 * auto-start command reference absolute paths, not bare `clawdevbox`.
 *
 * Idempotent: if a previous install is still running, refuses to spawn a
 * second instance and reports the existing PID. Re-exported for
 * `cli/restart.ts` which composes stopService + installAsService.
 */
export async function installAsService(cfg: ResolvedConfig, flags: Flags): Promise<void> {
  const existing = readServiceState(cfg.globalDir);
  if (existing && isProcessAlive(existing.pid)) {
    logger.info(
      {
        pid: existing.pid,
        port: existing.port,
        started_at: new Date(existing.started_at).toISOString(),
      },
      'service is already running — run `clawdevbox stop` first to relaunch',
    );
    process.stdout.write(
      `Service already running (pid ${existing.pid}, port ${existing.port ?? '?'}).\n` +
        `Run \`clawdevbox stop\` first if you want to relaunch.\n`,
    );
    return;
  }

  const { execPath, execArgs } = resolveExecForService();
  // The detached child runs `start` (no `--service` recursion). We forward
  // --project / --global / --port / --host / --token so the child sees the
  // same effective config the user kicked us off with.
  const childArgs = [...execArgs, 'start'];
  const forward = (k: string) => {
    const v = flags[k];
    if (typeof v === 'string') childArgs.push(`--${k}`, v);
  };
  forward('project');
  forward('global');
  forward('workspaces-root');
  forward('port');
  forward('host');
  forward('token');

  const { pid, logPath } = spawnDetached(execPath, childArgs, {
    logDir: cfg.globalDir,
  });

  const state: ServiceState = {
    pid,
    port: cfg.http.port,
    started_at: Date.now(),
    version: readOwnVersion(),
    exec_path: execPath,
    exec_args: childArgs,
  };
  writeServiceState(cfg.globalDir, state);

  // Health-probe the child so we don't claim success against a process
  // that crashed during startup (port-in-use, bad token, plugin import
  // failure, ...). On failure we surface the error AND clean up state so
  // a follow-up `clawdevbox stop` doesn't think a service is running.
  // We give cold starts a generous 30s — workspaces with many plugins
  // (each importing zod / heavy deps) can legitimately take 5–10s to bind.
  const probe = await probeHealth({
    host: cfg.http.host,
    port: cfg.http.port,
    timeoutMs: 30000,
  });
  if (!probe.ok) {
    logger.error(
      { reason: probe.reason, pid, port: cfg.http.port, logPath },
      'detached server did not become healthy — rolling back state',
    );
    // Tear down whatever we just spawned + clear state. Auto-start has
    // not been registered yet at this point.
    try {
      if (isProcessAlive(pid)) {
        if (process.platform === 'win32') {
          // Last-chance taskkill — server might have bound the port but
          // hung on init; we don't want a zombie listening on the user's
          // chosen port.
          const { spawnSync: sp } = await import('node:child_process');
          sp('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            encoding: 'utf8',
          });
        } else {
          process.kill(pid, 'SIGTERM');
        }
      }
    } catch {
      /* best-effort */
    }
    const { clearServiceState } = await import('../service.ts');
    clearServiceState(cfg.globalDir);
    const tailHint = logPath
      ? ` Last lines of ${logPath}:\n${tailFile(logPath, 30)}\n`
      : '';
    process.stdout.write(
      `Service spawn failed: ${probe.reason}\n` +
        (logPath ? `Full child log: ${logPath}\n` : '') +
        tailHint +
        `Run \`clawdevbox start\` in the foreground to see the underlying error.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Register OS auto-start. The same execPath + childArgs are used so the
  // login launch behaves identically to `clawdevbox start`.
  let autoStartInfo: { installed: boolean; path: string; platform: string } | null = null;
  let autoStartError: string | null = null;
  try {
    autoStartInfo = installAutoStart({ execPath, args: childArgs });
  } catch (err) {
    autoStartError = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: autoStartError },
      'auto-start registration failed — service will run for this login session only',
    );
  }

  const lines = [
    `Service installed.`,
    `  pid:        ${pid}`,
    `  port:       ${cfg.http.port}`,
    `  health:     http://${cfg.http.host}:${cfg.http.port}/healthz  (verified)`,
    `  state file: ${join(cfg.globalDir, 'service.json')}`,
  ];
  if (logPath) {
    lines.push(`  log file:   ${logPath}`);
  }
  if (autoStartInfo) {
    lines.push(`  auto-start: ${autoStartInfo.platform} (${autoStartInfo.path})`);
  } else if (autoStartError) {
    lines.push(`  auto-start: FAILED — ${autoStartError}`);
  }
  lines.push(``, `Stop with: clawdevbox stop  (or: npx clawdevbox stop)`);
  process.stdout.write(lines.join('\n') + '\n');

  // If a devtunnel is configured, poll the running service for the public
  // URL and print URL + QR. Best-effort — failures don't unwind the
  // already-installed service.
  if (cfg.tunnel.kind === 'devtunnel' && cfg.http.token) {
    const tunnel = await fetchTunnelStatus({
      host: cfg.http.host,
      port: cfg.http.port,
      token: cfg.http.token,
      timeoutMs: 30000,
      waitForUrl: true,
    });
    if (tunnel?.url) {
      const { renderTunnelInfo } = await import('./tunnel-display.ts');
      renderTunnelInfo({
        url: tunnel.url,
        token: cfg.http.token,
        inspectUrl: tunnel.inspect_url ?? null,
      });
    } else if (tunnel?.error) {
      process.stdout.write(`\nTunnel:     ${tunnel.error}\n`);
    } else {
      process.stdout.write(
        `\nTunnel:     URL not yet available — run \`clawdevbox status\` in a few seconds.\n`,
      );
    }
  }
}

/**
 * Best-effort resolution of how to re-launch this CLI in a detached child.
 * Returns the Node binary + script path so OS auto-start entries reference
 * absolute paths.
 */
function resolveExecForService(): { execPath: string; execArgs: string[] } {
  // The Node process running us provides both halves.
  const execPath = process.execPath;
  // Prefer argv[1] when it points at a readable file — that's the CLI
  // entry. When running under `node --import tsx`, argv[1] is still the
  // source `.ts` file, which tsx can re-load. When running the published
  // `clawdevbox` shim, argv[1] is the .js entry. Either way it's the right
  // thing to pass.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.argv[1],
    resolve(here, '..', '..', 'dist', 'cli.js'),
    resolve(here, '..', 'cli.js'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return { execPath, execArgs: [c] };
  }
  // Fall back to the first candidate even if it doesn't exist — the user
  // sees a clearer "ENOENT" from spawn than from us guessing.
  return { execPath, execArgs: [candidates[0] ?? ''] };
}

/** Read this package's version (for `service.json` and `status` output). */
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

/** Last N lines of a file (best-effort, returns '' on any error). */
function tailFile(path: string, lines: number): string {
  try {
    const raw = readFileSync(path, 'utf8');
    const all = raw.split(/\r?\n/);
    const tail = all.slice(-Math.max(1, lines));
    return tail.map((l) => `  | ${l}`).join('\n');
  } catch {
    return '';
  }
}


