/**
 * cli/agent-clis-api.ts
 *
 * `GET /api/agent-clis` — list registered agent-CLI providers with
 * per-provider detect results. Bearer-protected (loopback HTTP server's
 * standard auth).
 *
 * Query params:
 *   include_internal=true  Include internal/hidden providers (e.g. echo-stub).
 *                          Default: false.
 *
 * Response shape:
 *   {
 *     "configured": "copilot" | null,
 *     "providers": [
 *       { id, display_name, description, source, internal, detect: DetectResult }
 *     ],
 *     "errors": AgentCliProviderError[]
 *   }
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Workspace } from '../workspace.ts';
import type { ResolvedConfig } from '../config.ts';
import type { DetectResult } from '../agent-clis/types.ts';
import { buildProviderCtx } from '../agent-clis/shared.ts';

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

function reject401(res: ServerResponse, msg: string): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer realm="clawdevbox"',
  });
  res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: msg } }));
}

const DETECT_TIMEOUT_MS = 5000;

/**
 * Returns true if the request was handled (response sent), false otherwise.
 */
export async function handleAgentCliApi(
  req: IncomingMessage,
  res: ServerResponse,
  ws: Workspace,
  cfg: ResolvedConfig,
  expectedToken: string | null,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== '/api/agent-clis') return false;

  const presented = bearer(req);
  if (!presented) {
    reject401(res, 'missing bearer token');
    return true;
  }
  if (!expectedToken || !constantTimeEquals(presented, expectedToken)) {
    reject401(res, 'invalid bearer token');
    return true;
  }

  const includeInternal = url.searchParams.get('include_internal') === 'true';
  const providers = [...ws.agentCliProviders.values()].filter(
    (p) => includeInternal || !p.internal,
  );
  const ctx = buildProviderCtx(ws, cfg);

  const detectResults = await Promise.all(
    providers.map(async (p) => {
      let detect: DetectResult;
      if (p.detect) {
        try {
          detect = (await Promise.race([
            p.detect(ctx),
            new Promise<DetectResult>((r) =>
              setTimeout(
                () => r({ available: false, reason: 'detect timed out' }),
                DETECT_TIMEOUT_MS,
              ),
            ),
          ])) as DetectResult;
        } catch (err) {
          detect = {
            available: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      } else {
        detect = { available: true };
      }
      return {
        id: p.id,
        display_name: p.displayName,
        description: p.description,
        source: p.source,
        internal: !!p.internal,
        detect,
      };
    }),
  );

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      configured: cfg.defaultAgentCli,
      providers: detectResults,
      errors: ws.agentCliProviderErrors,
    }),
  );
  return true;
}
