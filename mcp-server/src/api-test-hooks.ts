/**
 * api-test-hooks.ts
 *
 * Loopback-only HTTP endpoints that let you fire recipes and triggers against
 * the LIVE clawdevbox server. Useful for:
 *
 *   • One-off demos: `curl -X POST http://127.0.0.1:5201/api/test/run-e2e`
 *     produces a real recipe-instance + inbox item visible in the home UI.
 *   • Integration tests that hit the running server instead of spinning up a
 *     hermetic child (complementing `tests/recipe-real-e2e.test.mjs`).
 *
 * Routes
 *   POST /api/test/recipe-run    — forwards to the `recipe.run` MCP tool.
 *   POST /api/test/trigger-fire  — forwards to the `trigger.fire` MCP tool.
 *   POST /api/test/run-e2e       — zero-arg shortcut: runs an inline recipe
 *                                  driven by the e2e-test-runner provider.
 *   GET  /api/test/agent-clis    — lists registered providers (incl. internal).
 *
 * Security: every route refuses non-loopback callers (403). They are NOT
 * bearer-gated — same posture as `/api/inbox` / `/api/recipes` — because
 * loopback is the trust boundary on these surfaces.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResolvedConfig } from './config.ts';
import type { Workspace } from './workspace.ts';
import { getRegistry } from './tools/registry.ts';
import { logger } from './logger.ts';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return LOOPBACK_ADDRS.has(addr);
}

async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  const MAX = 256 * 1024;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: `body exceeds ${MAX} bytes` } }));
      return null;
    }
    chunks.push(buf);
  }
  if (total === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: (err as Error).message } }));
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function refuseRemote(res: ServerResponse): void {
  sendJson(res, 403, {
    error: {
      code: 'LOOPBACK_ONLY',
      message: '/api/test/* is loopback-only. Connect from 127.0.0.1 / ::1.',
    },
  });
}

/**
 * Look up a registered MCP tool and invoke its handler with the given args.
 * Surfaces structured errors as HTTP 422 so test clients can react.
 */
async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const entry = getRegistry().get(toolName);
  if (!entry) {
    sendJson(res, 500, {
      error: { code: 'TOOL_NOT_REGISTERED', message: `'${toolName}' is not in the tool registry` },
    });
    return;
  }
  try {
    const result = (await entry.handler(args, { source: 'api-test-hook' })) as {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    };
    if (result?.isError) {
      sendJson(res, 422, {
        ok: false,
        tool: toolName,
        structuredContent: result.structuredContent ?? null,
        content: result.content ?? null,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      tool: toolName,
      structuredContent: result?.structuredContent ?? null,
      content: result?.content ?? null,
    });
  } catch (err) {
    logger.error({ tool: toolName, err: (err as Error).message }, 'api-test-hook tool invocation failed');
    sendJson(res, 500, {
      error: { code: 'TOOL_THREW', tool: toolName, message: (err as Error).message },
    });
  }
}

/**
 * Inline recipe used by `/api/test/run-e2e`. Drives the `e2e-test-runner`
 * provider that ships in BUILTIN_PROVIDERS, so no plugins / config / fixtures
 * are needed.
 */
const INLINE_E2E_RECIPE_YAML = [
  'id: e2e-live-test',
  'name: E2E Live Test',
  'description: Drive the e2e-test-runner provider against the live server.',
  'agent_cli: e2e-test-runner',
  'steps: []',
  '',
].join('\n');

export interface TestHookCtx {
  cfg: ResolvedConfig;
  ws: Workspace;
}

/**
 * Dispatcher. Returns `true` if the request matched a /api/test/* route
 * (response is already written), `false` if the URL didn't match anything.
 */
export async function handleTestHook(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: TestHookCtx,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith('/api/test/')) return false;

  if (!isLoopback(req)) {
    refuseRemote(res);
    return true;
  }

  // ── GET /api/test/agent-clis ──────────────────────────────────────────
  if (path === '/api/test/agent-clis' && req.method === 'GET') {
    const ws = _ctx.ws;
    const items = [...ws.agentCliProviders.entries()].map(([id, p]) => ({
      id,
      display_name: p.displayName,
      source: p.source,
      internal: !!p.internal,
    }));
    sendJson(res, 200, { items });
    return true;
  }

  // ── POST /api/test/recipe-run ─────────────────────────────────────────
  if (path === '/api/test/recipe-run' && req.method === 'POST') {
    const body = (await readJsonBody<Record<string, unknown>>(req, res)) ?? null;
    if (body == null) return true;
    if (!body.id && !body.source) {
      sendJson(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'either `id` or `source` is required' },
      });
      return true;
    }
    await invokeTool('recipe.run', body, res);
    return true;
  }

  // ── POST /api/test/trigger-fire ───────────────────────────────────────
  if (path === '/api/test/trigger-fire' && req.method === 'POST') {
    const body = (await readJsonBody<Record<string, unknown>>(req, res)) ?? null;
    if (body == null) return true;
    if (!body.id) {
      sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: '`id` is required' } });
      return true;
    }
    await invokeTool('trigger.fire', body, res);
    return true;
  }

  // ── POST /api/test/run-e2e ────────────────────────────────────────────
  if (path === '/api/test/run-e2e' && req.method === 'POST') {
    const body = ((await readJsonBody<{ prompt?: string }>(req, res)) ?? {}) as { prompt?: string };
    await invokeTool(
      'recipe.run',
      {
        source: INLINE_E2E_RECIPE_YAML,
        prompt: body.prompt ?? 'run e2e test (live)',
        agent_cli: 'e2e-test-runner',
      },
      res,
    );
    return true;
  }

  // Path was under /api/test/ but didn't match anything.
  sendJson(res, 404, {
    error: { code: 'UNKNOWN_TEST_HOOK', message: `no handler for ${req.method} ${path}` },
  });
  return true;
}
