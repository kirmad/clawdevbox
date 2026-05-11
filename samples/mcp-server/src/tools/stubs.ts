/**
 * tools/stubs.ts
 *
 * artifact.write / view.emit / search.memory / signal.emit / signal.list —
 * all return NOT_IMPLEMENTED_IN_STUB. They're declared so `tools/list` shows
 * the full Conductor catalog (spec §6.1) and agents can plan against the
 * eventual surface; the real sidecar implements them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notImplementedStub } from '../scope.ts';

export function registerStubTools(server: McpServer): void {
  server.registerTool(
    'artifact.write',
    {
      description:
        '(Stub) Register a path the agent just wrote. Real implementation tracks artifact rows + hashes.',
      inputSchema: {
        thread_id: z.string().min(1),
        kind: z.string().min(1),
        path: z.string().min(1),
        meta: z.unknown().optional(),
      },
    },
    async () => notImplementedStub('artifact.write'),
  );

  server.registerTool(
    'view.emit',
    {
      description:
        '(Stub) Append a `view_emitted` message; the renderer subscribes for live updates. Real implementation routes to ViewRenderer registry (spec §11).',
      inputSchema: {
        thread_id: z.string().min(1),
        view_id: z.string().min(1),
        type: z.string().min(1),
        payload: z.unknown(),
      },
    },
    async () => notImplementedStub('view.emit'),
  );

  server.registerTool(
    'search.memory',
    {
      description:
        '(Stub) Lexical FTS5 over `messages`. Real implementation hits SQLite\'s FTS5 virtual table.',
      inputSchema: {
        query: z.string().min(1),
        kind: z.string().min(1).optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async () => notImplementedStub('search.memory'),
  );

  server.registerTool(
    'signal.emit',
    {
      description:
        '(Stub) Emit a structured signal for trigger fan-out. Real implementation persists to the signals table.',
      inputSchema: {
        kind: z.string().min(1),
        payload: z.unknown(),
      },
    },
    async () => notImplementedStub('signal.emit'),
  );

  server.registerTool(
    'signal.list',
    {
      description: '(Stub) List recently emitted signals.',
      inputSchema: {
        kind: z.string().min(1).optional(),
        since: z.number().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async () => notImplementedStub('signal.list'),
  );
}
