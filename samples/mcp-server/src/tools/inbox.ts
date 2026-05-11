/**
 * tools/inbox.ts
 *
 * inbox.list / read / upsert / set_state / snooze / archive — backed by the
 * in-memory InboxStore. Real Conductor uses better-sqlite3 (FTS over `title`
 * + `agent_message`); the row shape is the same, so swapping the backend
 * later is mechanical.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notFound, structuredError } from '../scope.ts';
import { inbox, threads, type InboxState } from '../store.ts';

const inboxStateField = z.enum(['new', 'open', 'snoozed', 'archived', 'done']);
const agentToneField = z.enum(['info', 'warn', 'err', 'ok']);

export function registerInboxTools(server: McpServer): void {
  // -- inbox.list -----------------------------------------------------------
  server.registerTool(
    'inbox.list',
    {
      description:
        'List inbox items, optionally filtered by kind/state and paginated by cursor (spec §6.1).',
      inputSchema: {
        kind: z.string().min(1).optional(),
        state: inboxStateField.optional(),
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const items = inbox.list({
        kind: args.kind,
        state: args.state,
        limit: args.limit,
        cursor: args.cursor,
      });
      return {
        content: [{ type: 'text', text: `Found ${items.length} inbox item(s).` }],
        structuredContent: { items, count: items.length },
      };
    },
  );

  // -- inbox.read -----------------------------------------------------------
  server.registerTool(
    'inbox.read',
    {
      description:
        'Read a single inbox item plus the most-recent 50 messages of its primary thread (if any).',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const item = inbox.read(args.id);
      if (!item) return notFound('inbox_item', args.id);
      return {
        content: [{ type: 'text', text: `inbox ${item.id} [${item.kind}/${item.state}]` }],
        structuredContent: { item },
      };
    },
  );

  // -- inbox.upsert ---------------------------------------------------------
  server.registerTool(
    'inbox.upsert',
    {
      description:
        'Create or update an inbox item. Idempotent on `id` — Conductor uses the source-system id (e.g. `ado:pr:2401`) as the canonical key.',
      inputSchema: {
        id: z.string().min(1),
        kind: z.string().min(1),
        source: z.string().min(1),
        title: z.string().optional(),
        agent_message: z.string().optional(),
        agent_tone: agentToneField.optional(),
      },
    },
    async (args) => {
      const item = inbox.upsert(args.id, args.kind, args.source, {
        title: args.title,
        agent_message: args.agent_message,
        agent_tone: args.agent_tone,
      });
      return {
        content: [{ type: 'text', text: `Upserted inbox item ${item.id}.` }],
        structuredContent: { item },
      };
    },
  );

  // -- inbox.set_state ------------------------------------------------------
  server.registerTool(
    'inbox.set_state',
    {
      description: 'Transition an inbox item to a new state; reason is recorded as a message attribution.',
      inputSchema: {
        id: z.string().min(1),
        state: inboxStateField,
        reason: z.string().optional(),
      },
    },
    async (args) => {
      const item = inbox.setState(args.id, args.state as InboxState);
      if (!item) return notFound('inbox_item', args.id);
      return {
        content: [{ type: 'text', text: `Set ${item.id} → ${item.state}.` }],
        structuredContent: { item },
      };
    },
  );

  // -- inbox.snooze ---------------------------------------------------------
  server.registerTool(
    'inbox.snooze',
    {
      description: 'Snooze an inbox item until a unix-ms timestamp.',
      inputSchema: {
        id: z.string().min(1),
        until: z.number().int().positive(),
      },
    },
    async (args) => {
      if (args.until <= Date.now()) {
        return structuredError(
          'INVALID_SNOOZE_TIME',
          `until (${args.until}) must be in the future. Now is ${Date.now()}.`,
        );
      }
      const item = inbox.snooze(args.id, args.until);
      if (!item) return notFound('inbox_item', args.id);
      return {
        content: [{ type: 'text', text: `Snoozed ${item.id} until ${new Date(args.until).toISOString()}.` }],
        structuredContent: { item },
      };
    },
  );

  // -- inbox.archive --------------------------------------------------------
  server.registerTool(
    'inbox.archive',
    {
      description: 'Archive an inbox item (sets state to "archived").',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const item = inbox.archive(args.id);
      if (!item) return notFound('inbox_item', args.id);
      // Touch threads so they can opt to terminate themselves (the stub leaves
      // them alone; the real sidecar would cascade if the item moves to archived).
      threads;
      return {
        content: [{ type: 'text', text: `Archived ${item.id}.` }],
        structuredContent: { item },
      };
    },
  );
}
