/**
 * tools.ts
 *
 * MCP tool registrations for the @conductor/mcp-ado server. Each tool wraps a
 * single ADO REST operation from `ado-client.ts` and emits a structured
 * `CallToolResult` containing both human-readable text and a machine-readable
 * `structuredContent` payload.
 *
 * Tools exposed (advertised to MCP clients as `ado.*`):
 *
 *   - ado.get_pr            — PR metadata (title, description, state, …)
 *   - ado.list_pr_comments  — user-authored comments, optionally since an id
 *   - ado.comment_pr        — post a comment (new thread or reply)
 *   - ado.list_iterations   — iteration summaries
 *   - ado.get_pr_status     — derived status + vote roll-up
 *
 * Naming note: MCP tool names are flat strings — we use a dotted prefix
 * (`ado.*`) which is what the recipes in plugins/ado/recipes/*.yaml expect.
 *
 * Input validation: zod schemas declared inline. Failures surface as
 * `isError: true` results so the agent sees the precise issue without the
 * server crashing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AdoConfigError,
  AdoHttpError,
  commentOnPr,
  getPrStatus,
  getPullRequest,
  listIterations,
  listPrComments,
  type AdoScope,
} from './ado-client.ts';

// ============================================================================
// Common input shapes
// ============================================================================

const orgField = z
  .string()
  .min(1)
  .optional()
  .describe(
    'ADO organization slug, e.g. "msasg". May also be a composite "<org>/<urlencoded project>" when project disambiguation is required. Defaults to env ADO_ORG.',
  );

const projectField = z
  .string()
  .min(1)
  .optional()
  .describe('ADO project name. Defaults to env ADO_PROJECT.');

const repoField = z
  .string()
  .min(1)
  .describe('ADO repository name (the human-readable repo slug, not the GUID).');

const prIdField = z
  .number()
  .int()
  .positive()
  .describe('Pull request id (the numeric `pullRequestId`).');

// ============================================================================
// Helpers
// ============================================================================

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function toolSuccess(text: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

function handleError(toolName: string, err: unknown): CallToolResult {
  if (err instanceof AdoConfigError) {
    return toolError(`${toolName}: config error — ${err.message}`);
  }
  if (err instanceof AdoHttpError) {
    return toolError(
      `${toolName}: ADO HTTP ${err.status} on ${err.url}\n${err.responseBody.slice(0, 2000)}`,
    );
  }
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return toolError(`${toolName}: ${msg}`);
}

function scopeFrom(args: { org?: string; project?: string; repo: string }): AdoScope {
  return { org: args.org, project: args.project, repo: args.repo };
}

// ============================================================================
// Registration
// ============================================================================

export function registerTools(server: McpServer): void {
  // -- ado.get_pr -------------------------------------------------------------
  server.registerTool(
    'ado.get_pr',
    {
      description:
        'Get pull-request metadata (title, description, state, createdBy, repository, …) for a single PR id.',
      inputSchema: {
        org: orgField,
        project: projectField,
        repo: repoField,
        pr_id: prIdField,
      },
    },
    async (args) => {
      try {
        const pr = await getPullRequest(scopeFrom(args), args.pr_id);
        const headline = `PR ${pr.pullRequestId} — ${pr.title} [${pr.status}] by ${pr.createdBy.displayName} in ${pr.repository.project.name}/${pr.repository.name}`;
        return toolSuccess(headline, { pullRequest: pr });
      } catch (err) {
        return handleError('ado.get_pr', err);
      }
    },
  );

  // -- ado.list_pr_comments ---------------------------------------------------
  server.registerTool(
    'ado.list_pr_comments',
    {
      description:
        'List user-authored comments on a PR. Skips ADO system comments. Optionally filter to id > since_id (use for polling).',
      inputSchema: {
        org: orgField,
        project: projectField,
        repo: repoField,
        pr_id: prIdField,
        since_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('Return only comments with id > since_id. Omit or 0 to return all.'),
      },
    },
    async (args) => {
      try {
        const comments = await listPrComments(scopeFrom(args), args.pr_id, args.since_id);
        const text =
          comments.length === 0
            ? `No comments on PR ${args.pr_id}${args.since_id ? ` since id ${args.since_id}` : ''}.`
            : `Found ${comments.length} comment(s) on PR ${args.pr_id}${args.since_id ? ` since id ${args.since_id}` : ''}. Latest id=${comments[comments.length - 1].id}.`;
        return toolSuccess(text, { comments, count: comments.length });
      } catch (err) {
        return handleError('ado.list_pr_comments', err);
      }
    },
  );

  // -- ado.comment_pr ---------------------------------------------------------
  server.registerTool(
    'ado.comment_pr',
    {
      description:
        'Post a comment on a PR. If `in_reply_to_thread_id` is set, the comment is appended to that thread; otherwise a new top-level thread is created.',
      inputSchema: {
        org: orgField,
        project: projectField,
        repo: repoField,
        pr_id: prIdField,
        content: z
          .string()
          .min(1)
          .describe('Comment body (markdown is supported by the ADO UI).'),
        in_reply_to_thread_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('When set, append the comment to this existing thread instead of starting a new one.'),
      },
    },
    async (args) => {
      try {
        const result = await commentOnPr(
          scopeFrom(args),
          args.pr_id,
          args.content,
          args.in_reply_to_thread_id,
        );
        const text =
          args.in_reply_to_thread_id !== undefined
            ? `Replied on thread ${result.threadId} of PR ${args.pr_id} (comment id ${result.commentId}).`
            : `Posted new comment thread ${result.threadId} on PR ${args.pr_id} (comment id ${result.commentId}).`;
        return toolSuccess(text, { commentId: result.commentId, threadId: result.threadId });
      } catch (err) {
        return handleError('ado.comment_pr', err);
      }
    },
  );

  // -- ado.list_iterations ----------------------------------------------------
  server.registerTool(
    'ado.list_iterations',
    {
      description:
        'List the iterations (pushed-update snapshots) of a PR, oldest → newest. Each entry carries id, createdDate, and source/target commit hashes.',
      inputSchema: {
        org: orgField,
        project: projectField,
        repo: repoField,
        pr_id: prIdField,
      },
    },
    async (args) => {
      try {
        const iterations = await listIterations(scopeFrom(args), args.pr_id);
        const text =
          iterations.length === 0
            ? `No iterations found for PR ${args.pr_id}.`
            : `Found ${iterations.length} iteration(s) on PR ${args.pr_id}. Latest id=${iterations[iterations.length - 1].id}.`;
        return toolSuccess(text, { iterations, count: iterations.length });
      } catch (err) {
        return handleError('ado.list_iterations', err);
      }
    },
  );

  // -- ado.get_pr_status ------------------------------------------------------
  server.registerTool(
    'ado.get_pr_status',
    {
      description:
        'Derived PR status: PR.status, mergeStatus, and the per-reviewer vote roll-up (vote int + label).',
      inputSchema: {
        org: orgField,
        project: projectField,
        repo: repoField,
        pr_id: prIdField,
      },
    },
    async (args) => {
      try {
        const status = await getPrStatus(scopeFrom(args), args.pr_id);
        const approved = status.votes.filter((v) => v.vote >= 5).length;
        const rejected = status.votes.filter((v) => v.vote < 0).length;
        const text = `PR ${args.pr_id} status=${status.status} merge=${status.mergeStatus ?? 'n/a'} — ${status.votes.length} reviewer(s): ${approved} approved, ${rejected} blocking.`;
        return toolSuccess(text, status as unknown as Record<string, unknown>);
      } catch (err) {
        return handleError('ado.get_pr_status', err);
      }
    },
  );
}
