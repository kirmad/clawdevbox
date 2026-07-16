/**
 * cli/llm-api.ts
 *
 * HTTP route for the lightweight LLM inference API:
 *
 *   POST /api/llm/ask         — single-turn LLM call
 *   GET  /api/llm/providers   — list available providers
 *
 * Designed for fast, non-interactive LLM tasks: classifying memories,
 * scoring relevance, extracting structured data — anywhere you need
 * LLM intelligence without spinning up a full agent CLI session.
 *
 * Auth: Bearer token (same as other /api/* routes).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ask, listProviders, executeWithTools } from '../llm/index.ts';
import { getMcpToolsForLlm } from '../llm/mcp-tools-bridge.ts';
import type { LlmAskRequest } from '../llm/types.ts';

export interface LlmApiContext {
  expectedToken: string | null;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function checkAuth(req: IncomingMessage, ctx: LlmApiContext): boolean {
  if (!ctx.expectedToken) return true; // loopback-only, no auth required
  const tok = bearer(req);
  return tok !== null && constantTimeEquals(tok, ctx.expectedToken);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Handle an HTTP request if it matches an LLM API route.
 * Returns `true` if handled, `false` if the route didn't match.
 */
export async function handleLlmApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: LlmApiContext,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // --- GET /api/llm/providers ---
  if (url.pathname === '/api/llm/providers' && method === 'GET') {
    if (!checkAuth(req, ctx)) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    const providers = await listProviders();
    json(res, 200, { providers });
    return true;
  }

  // --- POST /api/llm/ask ---
  if (url.pathname === '/api/llm/ask' && method === 'POST') {
    if (!checkAuth(req, ctx)) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    let body: unknown;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'invalid JSON body' });
      return true;
    }

    // Validate minimal shape
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      json(res, 400, { error: '`messages` array is required and must be non-empty' });
      return true;
    }

    const request: LlmAskRequest = {
      messages: b.messages as LlmAskRequest['messages'],
      model: typeof b.model === 'string' ? b.model : undefined,
      temperature: typeof b.temperature === 'number' ? b.temperature : undefined,
      max_tokens: typeof b.max_tokens === 'number' ? b.max_tokens : undefined,
      provider: typeof b.provider === 'string' ? b.provider : undefined,
      tools: Array.isArray(b.tools) ? b.tools as LlmAskRequest['tools'] : undefined,
      tool_choice: b.tool_choice as LlmAskRequest['tool_choice'],
    };

    // If mcp_tools is specified, inject real MCP tools with handlers
    if (Array.isArray(b.mcp_tools)) {
      const mcpTools = getMcpToolsForLlm(b.mcp_tools as string[]);
      request.tools = [...(request.tools ?? []), ...mcpTools];
    }

    try {
      // Use executeWithTools when tools have handlers (mcp_tools),
      // plain ask() otherwise (for declaration-only tools)
      const hasHandlers = request.tools?.some((t) => t._handler);
      const maxSteps = typeof b.max_steps === 'number' ? b.max_steps : undefined;
      const result = hasHandlers
        ? await executeWithTools({ ...request, maxSteps })
        : await ask(request);
      json(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 502, { error: message });
    }
    return true;
  }

  return false;
}
