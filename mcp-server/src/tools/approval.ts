/**
 * tools/approval.ts
 *
 * approval.request / resolve / list_pending — backed by the in-process
 * ApprovalStore. UI hosts (the Clawdevbox desktop app) surface these as
 * askUser modals; programmatic callers resolve them via `approval.resolve`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { notFound, structuredError } from '../scope.ts';
import { approvals, threads } from '../store.ts';

const optionSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export function registerApprovalTools(server: McpServer): void {
  // -- approval.request -----------------------------------------------------
  server.registerTool(
    'approval.request',
    {
      description:
        'Ask the user a question with a fixed set of options (optionally free-text). Suspends the caller until approval.resolve fires (spec §6.1).',
      inputSchema: {
        thread_id: z.string().min(1),
        question: z.string().min(1),
        options: z.array(optionSchema).min(1),
        allow_freetext: z.boolean().optional(),
        default_view: z.string().optional().describe('Optional view_id to render the question with.'),
      },
    },
    async (args) => {
      const t = threads.read(args.thread_id);
      if (!t) return notFound('thread', args.thread_id);
      const approval = approvals.request({
        thread_id: args.thread_id,
        question: args.question,
        options: args.options,
        allow_freetext: args.allow_freetext,
        default_view: args.default_view,
      });
      threads.appendMessage(
        args.thread_id,
        'approval_request',
        { approval_id: approval.id, question: approval.question, options: approval.options },
        'agent',
      );
      threads.setState(args.thread_id, 'awaiting_user');
      return {
        content: [{ type: 'text', text: `Approval requested (${approval.id}).` }],
        structuredContent: { approval },
      };
    },
  );

  // -- approval.resolve -----------------------------------------------------
  server.registerTool(
    'approval.resolve',
    {
      description: 'Resolve a pending approval with the user\'s answer (one of the options.value, or freetext).',
      inputSchema: {
        approval_id: z.string().min(1),
        answer: z.unknown(),
      },
    },
    async (args) => {
      const before = approvals.listPending().find((a) => a.id === args.approval_id);
      const a = approvals.resolve(args.approval_id, args.answer);
      if (!a) return notFound('approval', args.approval_id);
      if (!before) {
        return structuredError(
          'ALREADY_RESOLVED',
          `Approval ${args.approval_id} was not in pending state.`,
        );
      }
      threads.appendMessage(
        a.thread_id,
        'approval_resolved',
        { approval_id: a.id, answer: args.answer },
        'user',
      );
      threads.setState(a.thread_id, 'running');
      return {
        content: [{ type: 'text', text: `Resolved approval ${a.id}.` }],
        structuredContent: { approval: a },
      };
    },
  );

  // -- approval.list_pending ------------------------------------------------
  server.registerTool(
    'approval.list_pending',
    {
      description: 'List approvals still awaiting an answer, optionally scoped to a thread.',
      inputSchema: { thread_id: z.string().min(1).optional() },
    },
    async (args) => {
      const pending = approvals.listPending(args.thread_id);
      return {
        content: [{ type: 'text', text: `Found ${pending.length} pending approval(s).` }],
        structuredContent: { approvals: pending, count: pending.length },
      };
    },
  );
}
