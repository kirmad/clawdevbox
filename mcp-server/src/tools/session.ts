/**
 * tools/session.ts
 *
 * MCP tool surface for the `session.*` namespace:
 *   - session.send: smart spawn-or-dispatch-or-resume
 *   - session.read: cursor-based scrollback (pty + tmux backends)
 *   - session.kill: terminate a live session
 *   - session.list: enumerate live + archived + foreign sessions
 *
 * Thin wrappers over `session-helpers.ts`. The helpers are shared with the
 * HTTP routes in `cron-api.ts` so the two protocols can't drift.
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { structuredError } from '../scope.ts';
import type { Workspace } from '../workspace.ts';
import {
  spawnDispatchOrResume,
  readScrollbackHelper,
  killSession,
  listSessions,
  type SessionHelperCtx,
} from '../session-helpers.ts';

export function registerSessionEntries(ws: Workspace): void {
  // Build ctx lazily — the dispatcher and cfg are owned by start.ts.
  // We can't access them from this module at register time, so we look them
  // up via globals/late-bound getters provided by start.ts (see Step 4
  // below for how this is wired).
  const buildCtx = (): SessionHelperCtx => {
    const ctx = (globalThis as any).__clawdevboxSessionHelperCtx as SessionHelperCtx | undefined;
    if (!ctx) {
      throw new Error('session-helper context not initialized (only available inside `clawdevbox start`)');
    }
    return ctx;
  };

  // --- session.send ---------------------------------------------------------
  defineTool({
    name: 'session.send',
    description:
      'Spawn a new agent CLI session OR send a follow-up prompt to an existing one. Smart-routed via `session_id`: live → dispatch (queued FIFO); archived + provider supports resume → resume from saved jsonl + dispatch; otherwise → fresh spawn. Returns immediately; the prompt may not have been typed yet — poll `session.read`. WARNING: this can spawn unbounded sub-agents (each ~50-200 MB). Foreign tmux sessions (not spawned by clawdevbox) are read-only via this tool.',
    parameters: z.object({
      prompt: z.string().min(1).describe('The user-style message handed to the spawned/dispatched agent.'),
      session_id: z.string().min(1).optional().describe(
        "Alias or canonical GUID. If a live pty exists for this id, the prompt is dispatched to it (mode='dispatch'). If an archived agent_sessions row exists and the provider supports --resume, the session is resumed (mode='resume'). Otherwise a fresh session is spawned with this GUID (mode='spawn'). Omit to always spawn fresh with a generated GUID.",
      ),
      provider: z.string().min(1).optional().describe(
        'Agent CLI provider id (copilot, claude, agency, echo-stub). Defaults to cfg.defaultAgentCli.',
      ),
      agent: z.string().min(1).optional().describe(
        "Persona name passed as --agent to the CLI (e.g. 'dev-buddy:dev-buddy').",
      ),
      model: z.string().min(1).optional().describe('LLM model override passed as --model.'),
      workspace_id: z.string().min(1).optional().describe('Existing workspace id to run in.'),
      workspace_path: z.string().min(1).optional().describe(
        "Absolute path. If the workspace doesn't exist yet, it's created. When omitted, an auto-managed workspace under `cfg.workspacesRoot/ws_<id>/` is created on first spawn and reused for any subsequent send/resume to the same `session_id`.",
      ),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const result = await spawnDispatchOrResume(ctx, {
        prompt: args.prompt,
        session_id: args.session_id ?? null,
        provider: args.provider ?? null,
        agent: args.agent ?? null,
        model: args.model ?? null,
        workspace_id: args.workspace_id ?? null,
        workspace_path: args.workspace_path ?? null,
      });
      if (!result.ok) return structuredError(result.code, result.message, result.details ?? {});
      const verb = result.mode === 'spawn' ? 'Spawned' : result.mode === 'resume' ? 'Resumed' : 'Dispatched to';
      const wsBit = result.workspace_path ? ` in ${result.workspace_path}` : '';
      return {
        content: [{
          type: 'text',
          text: `${verb} ${result.instance_id} (session ${result.session_id}${result.session_alias ? `, alias ${result.session_alias}` : ''})${wsBit}`,
        }],
        structuredContent: result,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- session.read ---------------------------------------------------------
  defineTool({
    name: 'session.read',
    description:
      "Read terminal scrollback for a session. Pass a `cursor` from a prior call as `since` to get only new content (backend='pty' supports true incremental reads; backend='tmux' returns a snapshot each call — supports_incremental=false). ANSI/TUI escape sequences are stripped by default; pass `raw: true` to preserve them. Default returns the last ~32 KB; pass `full: true` for the whole buffer.",
    parameters: z.object({
      instance_id: z.string().min(1).optional().describe(
        'Pty/tmux instance id. EITHER this OR session_id is required.',
      ),
      session_id: z.string().min(1).optional().describe(
        'Alias/GUID resolved to the current live instance.',
      ),
      since: z.string().min(1).optional().describe(
        'Opaque cursor from a prior call. Use to get only new content. Default: read from current position.',
      ),
      full: z.boolean().optional().describe(
        'When true, return the entire buffer (capped by backend). Default: last ~32 KB tail.',
      ),
      raw: z.boolean().optional().describe(
        'When true, preserve raw ANSI/TUI escape sequences. Default: strip via stripTuiNoise.',
      ),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const r = await readScrollbackHelper(ctx, {
        instance_id: args.instance_id ?? null,
        session_id: args.session_id ?? null,
        since: args.since ?? null,
        full: !!args.full,
        raw: !!args.raw,
      });
      if (!r.ok) return structuredError(r.code, r.message);
      return {
        content: [{ type: 'text', text: r.result.content || '(empty)' }],
        structuredContent: r.result,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- session.kill ---------------------------------------------------------
  defineTool({
    name: 'session.kill',
    description:
      'Terminate a live session. Tries (in order): legacy pty, clawdevbox-owned tmux, foreign tmux. Returns `{ kind, killed }`. Idempotent: a session that was already dead returns `kind: "not_live"`.',
    parameters: z.object({
      instance_id: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
    }).refine(
      (v) => !!(v.instance_id || v.session_id),
      { message: 'one of instance_id or session_id is required' },
    ),
    handler: async (args) => {
      const ctx = buildCtx();
      const key = args.instance_id ?? args.session_id!;
      const r = await killSession(ctx, key);
      return {
        content: [{
          type: 'text',
          text: r.kind === 'not_live'
            ? `Session ${key} was not live.`
            : `Killed ${key} (${r.kind}).`,
        }],
        structuredContent: r,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // --- session.list ---------------------------------------------------------
  defineTool({
    name: 'session.list',
    description:
      'Enumerate sessions: live (clawdevbox-owned), archived (from agent_sessions), and foreign tmux (set include_foreign=false to exclude). Returns the same shape as GET /api/sessions.',
    parameters: z.object({
      status: z.enum(['all', 'active', 'archived']).optional().describe("Default: 'active'."),
      include_foreign: z.boolean().optional().describe(
        'Include foreign tmux sessions (user-spawned, not by clawdevbox). Default: true.',
      ),
      since: z.number().int().nonnegative().optional().describe('Epoch ms for archived pagination.'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50, max 200.'),
    }),
    handler: async (args) => {
      const ctx = buildCtx();
      const r = await listSessions(ctx, {
        status: args.status ?? 'active',
        include_foreign: args.include_foreign ?? true,
        since: args.since,
        limit: args.limit,
      });
      return {
        content: [{ type: 'text', text: `Found ${r.items.length} session(s).` }],
        structuredContent: r,
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
