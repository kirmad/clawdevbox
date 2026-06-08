/**
 * tools/inbox.ts
 *
 * inbox.list / read / upsert / set_state / snooze / archive — backed by the
 * file-based InboxStore (`<globalDir>/inbox.json`) with body bodies in a
 * sidecar (`<globalDir>/inbox-bodies/<safe-id>.<md|txt>`).
 *
 * `inbox.upsert` doubles as the "new mail" entry point: it can fire a
 * browser push notification on creation (or unconditionally, via the
 * `notify` flag) so phones light up the moment something lands. The SSE
 * 'inbox' topic always emits regardless of `notify`, so any open SPA tab
 * refreshes its list automatically.
 *
 * Update semantics for the patchable fields:
 *   - omitted          → unchanged
 *   - explicit `null`  → cleared (only for nullable fields)
 *   - empty array `[]` → cleared (attachments)
 *   - empty string `""` for description → body sidecar deleted
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadNotificationsConfig } from '../config.ts';
import {
  deleteInboxBody,
  readInboxBody,
  writeInboxBody,
} from '../inbox-persistence.ts';
import { sendNotification } from '../notifications.ts';
import { notFound, structuredError } from '../scope.ts';
import {
  inbox,
  mintInboxReplyId,
  threads,
  type InboxItem,
  type InboxReply,
  type InboxState,
} from '../store.ts';
import type { Workspace } from '../workspace.ts';
import { defineTool } from './registry.ts';
import { resolveAgentSessionId } from '../context-resolver.ts';

const inboxStateField = z.enum(['new', 'open', 'snoozed', 'archived', 'done']);
const agentToneField = z.enum(['info', 'warn', 'err', 'ok']);
const bodyFormatField = z.enum(['markdown', 'text']);

/** Matches artifact-store.ts ARTIFACT_ID_RE; duplicated to avoid cycle. */
const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const attachmentSchema = z.object({
  artifact_id: z
    .string()
    .regex(ARTIFACT_ID_RE, 'artifact_id must match /^[a-z0-9][a-z0-9._-]*$/i'),
  workspace_id: z.string().min(1).max(200).optional(),
  title: z.string().max(200).optional(),
  type: z.string().max(80).optional(),
});

const refSchema = z.object({
  id: z.string().min(1).max(200),
  workspace_id: z.string().min(1).max(200).optional(),
});

const PREVIEW_MAX = 500;
const DESCRIPTION_MAX = 256 * 1024;
const ATTACHMENTS_MAX = 20;
const LABELS_MAX = 10;
const LABEL_LEN_MAX = 40;
const PUSH_BODY_MAX = 120;

const labelSchema = z
  .string()
  .trim()
  .min(1, 'label cannot be empty')
  .max(LABEL_LEN_MAX, `label must be ≤${LABEL_LEN_MAX} chars`);

// ----------------------------------------------------------------------------
// Question + reply schemas
// ----------------------------------------------------------------------------

const QUESTION_OPTIONS_MAX = 20;
const REPLIES_MAX = 100;
const REPLY_TEXT_MAX = 16_000;
const PROMPT_MAX = 4_000;

const optionIdSchema = z
  .string()
  .trim()
  .min(1, 'option.id cannot be empty')
  .max(80, 'option.id must be ≤80 chars')
  .regex(/^[A-Za-z0-9._\-:]+$/, 'option.id may contain letters, digits, ._-:');

const questionOptionSchema = z.object({
  id: optionIdSchema,
  label: z.string().trim().min(1).max(200),
  value: z.string().max(2_000).optional(),
});

const questionDispatchSchema = z.object({
  session_id: z.string().min(1).max(200).optional(),
  provider: z.string().min(1).max(80).optional(),
  workspace_id: z.string().min(1).max(200).optional(),
  workspace_path: z.string().min(1).max(2_000).optional(),
  prompt_template: z.string().max(8_000).optional(),
});

const questionSchema = z.object({
  id: optionIdSchema
    .optional()
    .describe('Stable id for the question (e.g. "db", "auth"). Required when an item carries multiple questions so per-question answers can be correlated. Defaults to "q1" when omitted in a single-question item.'),
  prompt: z.string().min(1).max(PROMPT_MAX),
  title: z.string().min(1).max(200).optional().describe('Optional short header above the prompt (e.g. "Database choice"). Helpful when an item has multiple questions.'),
  mode: z.enum(['single', 'multi', 'text']).optional(),
  options: z.array(questionOptionSchema).max(QUESTION_OPTIONS_MAX).optional(),
  allow_freeform: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
  close_on_answer: z.boolean().optional(),
  closed: z.boolean().optional(),
  dispatch: questionDispatchSchema.optional(),
});

const questionsArraySchema = z.array(questionSchema).max(20);

const replyAttachmentSchema = attachmentSchema; // same shape as item attachments

const replyDispatchSchema = z.object({
  mode: z.enum(['spawn', 'dispatch', 'resume', 'noop', 'failed']),
  instance_id: z.string().optional(),
  session_id: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

const replyAnswerSchema = z.object({
  question_id: optionIdSchema,
  option_ids: z.array(optionIdSchema).max(QUESTION_OPTIONS_MAX).optional(),
  freeform: z.string().max(REPLY_TEXT_MAX).optional(),
  text: z.string().max(REPLY_TEXT_MAX).optional(),
});

const replySchema = z.object({
  id: z.string().min(1).max(80).optional(),
  author: z.enum(['user', 'agent']),
  text: z.string().min(1).max(REPLY_TEXT_MAX),
  option_ids: z.array(optionIdSchema).max(QUESTION_OPTIONS_MAX).optional(),
  freeform: z.string().max(REPLY_TEXT_MAX).optional(),
  answers: z.array(replyAnswerSchema).max(20).optional(),
  questions: questionsArraySchema
    .optional()
    .describe('Follow-up questions on an agent-authored reply. The SPA renders these below the reply bubble and the user answers them via POST /api/inbox/<id>/reply (the endpoint auto-targets the most recent open question batch — item-level OR latest agent reply). Use this for multi-turn batched Q&A.'),
  attachments: z.array(replyAttachmentSchema).max(ATTACHMENTS_MAX).optional(),
  created_at: z.number().int().positive().optional(),
  dispatch: replyDispatchSchema.optional(),
});

export function mintReplyId(): string {
  return mintInboxReplyId();
}

function normalizeReply(input: z.infer<typeof replySchema>): InboxReply {
  // Auto-id any questions on agent replies, mirroring the item-level
  // upsert logic. Reply-level question ids are unique per-reply, not
  // per-item, so q1, q2, ... is fine.
  let normalizedQuestions: InboxReply['questions'];
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    const seen = new Set<string>();
    normalizedQuestions = input.questions.map((q: z.infer<typeof questionSchema>, idx: number) => {
      const id = q.id ?? `q${idx + 1}`;
      if (seen.has(id)) {
        throw new Error(`reply.questions[${idx}]: duplicate id "${id}"`);
      }
      seen.add(id);
      return {
        ...q,
        id,
        mode: q.mode ?? (q.options && q.options.length > 0 ? 'single' : 'text'),
        close_on_answer: q.close_on_answer ?? true,
      };
    });
  }
  return {
    id: input.id ?? mintReplyId(),
    author: input.author,
    text: input.text,
    option_ids: input.option_ids,
    freeform: input.freeform,
    answers: input.answers as InboxReply['answers'],
    questions: normalizedQuestions,
    attachments: input.attachments,
    created_at: input.created_at ?? Date.now(),
    dispatch: input.dispatch,
  };
}

function clipForPush(s: string): string {
  const t = s.trim();
  if (t.length <= PUSH_BODY_MAX) return t;
  return t.slice(0, PUSH_BODY_MAX - 1) + '…';
}

export function registerInboxEntries(ws: Workspace): void {
  // -- inbox.list -----------------------------------------------------------
  defineTool({
    name: 'inbox.list',
    description:
      'List inbox items (metadata only — body content NOT included; fetch a single item with inbox.read for the full description). Optionally filtered by kind/state/label and paginated by cursor.',
    parameters: z.object({
      kind: z.string().min(1).optional(),
      state: inboxStateField.optional(),
      label: z
        .string()
        .min(1)
        .max(LABEL_LEN_MAX)
        .optional()
        .describe('Case-insensitive label match. Returns only items whose labels include this value.'),
      limit: z.number().int().positive().max(500).optional(),
      cursor: z.string().min(1).optional(),
    }),
    handler: async (args) => {
      const items = inbox.list({
        kind: args.kind,
        state: args.state,
        label: args.label,
        limit: args.limit,
        cursor: args.cursor,
      });
      return {
        content: [{ type: 'text', text: `Found ${items.length} inbox item(s).` }],
        structuredContent: { items, count: items.length },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- inbox.read -----------------------------------------------------------
  defineTool({
    name: 'inbox.read',
    description:
      'Read a single inbox item INCLUDING the full description body (if any). Pass `include_body: false` to skip the body when you only need metadata.',
    parameters: z.object({
      id: z.string().min(1),
      include_body: z.boolean().optional(),
    }),
    handler: async (args) => {
      const item = inbox.read(args.id);
      if (!item) return notFound('inbox_item', args.id);
      const includeBody = args.include_body !== false;
      let description: string | null = null;
      if (
        includeBody &&
        typeof item.description_size === 'number' &&
        item.description_size > 0 &&
        item.description_format
      ) {
        description = readInboxBody(ws.globalDir, item.id, item.description_format);
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `inbox ${item.id} [${item.kind}/${item.state}]` +
              (description ? ` · body ${description.length} bytes` : ''),
          },
        ],
        structuredContent: { item, description },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- inbox.upsert ---------------------------------------------------------
  defineTool({
    name: 'inbox.upsert',
    description:
      "Create or update an inbox item. Idempotent on `id`. Persisted to `<globalDir>/inbox.json` (metadata) and `<globalDir>/inbox-bodies/` (description bodies). SPA tabs auto-refresh via SSE; on creation (or when `notify: true`) a browser push fires. Supply `title`+`preview` for the card, `description`+`description_format` for the expanded body, `attachments` for clickable artifact chips, `labels` for free-form tag chips, and `recipe_instance`/`trigger_id` to link the item to spawned work. Update semantics: omitted = unchanged; `null` = cleared (for nullable fields); empty `attachments: []` or `labels: []` = cleared; empty `description: \"\"` = body deleted.",
    parameters: z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      source: z.string().min(1),
      title: z.string().max(500).optional(),
      preview: z
        .string()
        .max(PREVIEW_MAX)
        .optional()
        .describe(`Brief tldr shown on the inbox card. Max ${PREVIEW_MAX} chars.`),
      description: z
        .string()
        .max(DESCRIPTION_MAX)
        .optional()
        .describe(
          `Full body shown when the user expands the card. Max ${DESCRIPTION_MAX / 1024}KB. Stored in a sidecar; pass "" to delete an existing body.`,
        ),
      description_format: bodyFormatField
        .optional()
        .describe('Body format. Default: markdown.'),
      attachments: z
        .array(attachmentSchema)
        .max(ATTACHMENTS_MAX)
        .optional()
        .describe(
          'Artifact references — each becomes a clickable chip in the SPA detail view that opens the artifact as a tab. Pass `[]` to clear.',
        ),
      recipe_instance: refSchema
        .nullable()
        .optional()
        .describe(
          'Link to a recipe instance (e.g. from recipe.run output). Clicking jumps to the Recipes tab. Pass null to clear.',
        ),
      trigger_id: z
        .string()
        .min(1)
        .max(200)
        .nullable()
        .optional()
        .describe(
          'Link to a registered trigger (e.g. "ado.new-pr-watcher#auth-svc"). Pass null to clear.',
        ),
      labels: z
        .array(labelSchema)
        .max(LABELS_MAX)
        .optional()
        .describe(
          `Free-form labels/tags shown as chips on the card. Max ${LABELS_MAX} per item, each ≤${LABEL_LEN_MAX} chars. Pass \`[]\` to clear. Duplicates are removed (case-insensitive).`,
        ),
      question: questionSchema
        .nullable()
        .optional()
        .describe(
          'LEGACY: single question shorthand for a single-question item. New code should use `questions: [...]` for both single and multi-question items. Pass null to clear (sets `questions: []`).',
        ),
      questions: questionsArraySchema
        .nullable()
        .optional()
        .describe(
          'One or more clickable questions on this item. SPA renders ALL questions in one form with a single submit button (batch UX); user fills out every question then submits, the agent receives one consolidated reply. Each question MUST have a unique `id` (e.g. "db", "auth", "ui") so the answers can be correlated. The FIRST question with `dispatch.session_id` configured drives where the batched answer is dispatched. Pass null or [] to clear.',
        ),
      dispatch: questionDispatchSchema
        .nullable()
        .optional()
        .describe(
          'Item-level dispatch routing. Drives the always-on freeform reply box: the SPA renders a "Send a message to the agent" textarea on every item with a dispatch.session_id and routes the user\'s typed message back to your CLI session (wrapped with item context). Auto-populated from the X-Clawdevbox-Session-Id request header when not passed, so most agents don\'t need to set this explicitly. Pass null to clear.',
        ),
      session_id: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Convenience shorthand for `dispatch: { session_id }`. Useful when the only dispatch field you need is the session id. Setting both this and `dispatch.session_id` is a conflict (this value wins).',
        ),
      replies: z
        .array(replySchema)
        .max(REPLIES_MAX)
        .optional()
        .describe(
          'Reply chain (typically agent-authored follow-ups). Empty `[]` clears the chain. Most agents should use `inbox.reply` to append a single message instead of rewriting this array.',
        ),
      agent_message: z.string().optional(),
      agent_tone: agentToneField.optional(),
      notify: z
        .boolean()
        .optional()
        .describe(
          'Send a browser push to subscribed devices. Default: true on creation, false on update. Set explicitly to force.',
        ),
    }),
    handler: async (args, extra) => {
      // Auto-resolve cli session id from the request header. Used as the
      // default for `dispatch.session_id` when the caller doesn't set one.
      const headerSessionId = resolveAgentSessionId(
        extra as Parameters<typeof resolveAgentSessionId>[0],
      );

      // ---- handle the description body sidecar BEFORE upserting the item
      // so the description_size metadata is accurate.
      const format: 'markdown' | 'text' = args.description_format ?? 'markdown';
      let descriptionSize: number | undefined;
      if (args.description !== undefined) {
        if (args.description === '') {
          deleteInboxBody(ws.globalDir, args.id);
          descriptionSize = 0;
        } else {
          writeInboxBody(ws.globalDir, args.id, args.description, format);
          descriptionSize = Buffer.byteLength(args.description, 'utf8');
        }
      }

      // Build the patch — only include fields the caller actually sent so
      // update semantics ("omitted = unchanged") work via the spread merge
      // in InboxStore.upsert.
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.preview !== undefined) patch.preview = args.preview;
      if (args.description !== undefined) {
        patch.description_format = args.description === '' ? undefined : format;
        patch.description_size = descriptionSize;
      } else if (args.description_format !== undefined) {
        // Format change without body change. If a body of the OTHER format
        // exists, rewrite it in the new format so the metadata stays
        // truthful.
        const existing = inbox.read(args.id);
        if (existing && existing.description_format && existing.description_format !== args.description_format) {
          const oldBody = readInboxBody(ws.globalDir, args.id, existing.description_format);
          if (oldBody !== null) {
            writeInboxBody(ws.globalDir, args.id, oldBody, args.description_format);
            patch.description_format = args.description_format;
            patch.description_size = Buffer.byteLength(oldBody, 'utf8');
          } else {
            patch.description_format = args.description_format;
          }
        } else {
          patch.description_format = args.description_format;
        }
      }
      if (args.attachments !== undefined) patch.attachments = args.attachments;
      if (args.recipe_instance !== undefined) patch.recipe_instance = args.recipe_instance;
      if (args.trigger_id !== undefined) patch.trigger_id = args.trigger_id;
      if (args.labels !== undefined) {
        // De-duplicate case-insensitively while preserving first-seen casing.
        const seen = new Set<string>();
        const out: string[] = [];
        for (const raw of args.labels) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(trimmed);
        }
        patch.labels = out;
      }
      if (args.question !== undefined) {
        // LEGACY: single-question shorthand. Promote to questions[0].
        if (args.question === null) {
          patch.questions = [];
          patch.question = undefined;
        } else {
          const q = args.question;
          const promoted = {
            id: q.id ?? 'q1',
            prompt: q.prompt,
            title: q.title,
            mode: q.mode ?? (q.options && q.options.length > 0 ? 'single' : 'text'),
            options: q.options,
            allow_freeform: q.allow_freeform,
            placeholder: q.placeholder,
            close_on_answer: q.close_on_answer ?? true,
            closed: q.closed,
            dispatch: q.dispatch,
          };
          patch.questions = [promoted];
          patch.question = undefined;          // clear legacy field, questions[] wins
        }
      }
      if (args.questions !== undefined) {
        if (args.questions === null || args.questions.length === 0) {
          patch.questions = [];
          patch.question = undefined;
        } else {
          // Each question MUST have a unique id. Auto-generate "q<N>" for
          // entries where the caller omitted it, but warn if any duplicates
          // result. Defensive: callers are encouraged to set ids explicitly.
          const seenIds = new Set<string>();
          const normalized = args.questions.map((q: z.infer<typeof questionSchema>, idx: number) => {
            const id = q.id ?? `q${idx + 1}`;
            if (seenIds.has(id)) {
              throw new Error(`questions[${idx}]: duplicate id "${id}" — every question must have a unique id`);
            }
            seenIds.add(id);
            return {
              ...q,
              id,
              mode: q.mode ?? (q.options && q.options.length > 0 ? 'single' : 'text'),
              close_on_answer: q.close_on_answer ?? true,
            };
          });
          patch.questions = normalized;
          patch.question = undefined;          // questions[] wins over legacy
        }
      }
      if (args.replies !== undefined) {
        patch.replies = args.replies.map(normalizeReply);
      }
      if (args.agent_message !== undefined) patch.agent_message = args.agent_message;
      if (args.agent_tone !== undefined) patch.agent_tone = args.agent_tone;

      // ---- Resolve item-level dispatch routing -------------------------------
      // Precedence:
      //   1. Explicit `dispatch: {session_id, ...}` arg (whole object replaces).
      //   2. `session_id` shorthand arg merged onto whatever dispatch is set.
      //   3. X-Clawdevbox-Session-Id header auto-injection if neither set
      //      AND the agent didn't already configure any dispatch elsewhere.
      // Pass `dispatch: null` explicitly to clear.
      if (args.dispatch !== undefined || args.session_id !== undefined) {
        if (args.dispatch === null) {
          patch.dispatch = null;
        } else {
          const merged = { ...(args.dispatch ?? {}) };
          if (args.session_id) merged.session_id = args.session_id;
          patch.dispatch = merged;
        }
      } else if (headerSessionId) {
        // Auto-inject from header — only when the caller didn't set dispatch
        // explicitly. Skipped when the existing item already has dispatch.
        const existing = inbox.read(args.id);
        const existingDispatch = existing?.dispatch as { session_id?: string } | undefined;
        if (!existingDispatch?.session_id) {
          patch.dispatch = { session_id: headerSessionId };
        }
      }

      const { item, created } = inbox.upsert(args.id, args.kind, args.source, patch);

      // Default: push only on the first arrival. Caller can override either
      // way with an explicit `notify` flag.
      const shouldPush = args.notify === undefined ? created : args.notify;

      let push: {
        attempted: number;
        delivered: number;
        pruned: number;
        errors: string[];
      } | null = null;
      let pushErrorCode: string | null = null;

      if (shouldPush) {
        const notifications = loadNotificationsConfig({
          projectDir: ws.projectDir,
          globalDir: ws.globalDir,
        });
        if (!notifications.enabled || !notifications.vapid) {
          pushErrorCode = 'NOTIFICATIONS_DISABLED';
        } else {
          const pushTitle = item.title?.trim() || `New ${item.kind}`;
          // Privacy-conscious push body: prefer preview (clipped to a
          // lock-screen-safe length), fall back to legacy agent_message,
          // then a neutral source label. Never include recipe/trigger ids.
          const pushBody = clipForPush(
            item.preview?.trim() ||
              item.agent_message?.trim() ||
              `${item.source}${item.title ? '' : ` · ${item.id}`}`,
          );
          push = await sendNotification(
            { globalDir: ws.globalDir, projectDir: ws.projectDir },
            notifications.vapid,
            {
              title: pushTitle,
              body: pushBody,
              tag: `inbox:${item.id}`,
              url: '/',
            },
          );
        }
      }

      const lines: string[] = [
        created
          ? `Created inbox item ${item.id}.`
          : `Updated inbox item ${item.id}.`,
      ];
      if (descriptionSize !== undefined) {
        lines.push(
          descriptionSize === 0
            ? 'Body: cleared.'
            : `Body: ${descriptionSize} bytes (${format}).`,
        );
      }
      if (push) {
        lines.push(
          `Push: delivered ${push.delivered}/${push.attempted}` +
            (push.pruned ? `; pruned ${push.pruned}` : '') +
            (push.errors.length ? `; ${push.errors.length} error(s)` : ''),
        );
      } else if (shouldPush && pushErrorCode === 'NOTIFICATIONS_DISABLED') {
        lines.push(
          'Push: skipped — notifications.enabled=false or no VAPID keys (run `clawdevbox init`).',
        );
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          item: item as InboxItem,
          created,
          push,
          push_error_code: pushErrorCode,
        },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- inbox.reply ----------------------------------------------------------
  defineTool({
    name: 'inbox.reply',
    description:
      'Append a reply to an existing inbox item. Typically used by agents to: (1) follow up after a question is answered, (2) ASK A NEW BATCH OF QUESTIONS by passing `reply.questions: [...]` — the SPA renders those below the bubble and the user answers them via the same /api/inbox/<id>/reply endpoint (which auto-targets the most recent open question batch). For user answers, the SPA POSTs to `/api/inbox/<id>/reply` instead. Pass `author: "agent"` for agent-authored messages; `author: "user"` is reserved for the HTTP API but accepted for symmetry. Optionally pass `reopen: true` to flip every question.closed back to false.',
    parameters: z.object({
      id: z.string().min(1),
      reply: replySchema,
      session_id: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Optional cli session id for routing user follow-ups. If the item has no `dispatch` yet, this gets stamped onto the item as `dispatch: { session_id }` so subsequent user replies (freeform OR answers to this reply\'s questions) route back to your session. Auto-resolved from X-Clawdevbox-Session-Id header when not passed.',
        ),
      reopen: z
        .boolean()
        .optional()
        .describe(
          'If true and the item has questions, clear every question.closed so the user can answer again (e.g. agent asks a follow-up).',
        ),
      new_state: z
        .enum(['new', 'open', 'snoozed', 'archived', 'done'])
        .optional()
        .describe('Optionally bump the item state (e.g. "open" after an agent follow-up).'),
    }),
    handler: async (args, extra) => {
      const existing = inbox.read(args.id);
      if (!existing) return notFound('inbox_item', args.id);

      const reply = normalizeReply(args.reply);
      const closeQuestion = false; // explicit close happens via question.closed=true on upsert or via the HTTP /reply route
      const result = inbox.appendReply(args.id, reply, {
        closeQuestion,
        newState: args.new_state,
      });
      if (!result) return notFound('inbox_item', args.id);

      // Stamp item-level dispatch.session_id when:
      //   1. Caller passed `session_id` arg explicitly, OR
      //   2. X-Clawdevbox-Session-Id header is present
      // AND the item doesn't already have a dispatch configured. This means
      // ANY agent-authored reply makes the item replyable from the SPA
      // freeform box without the agent having to manage that explicitly.
      const explicitSid = args.session_id;
      const headerSid = resolveAgentSessionId(
        extra as Parameters<typeof resolveAgentSessionId>[0],
      );
      const sidToStamp = explicitSid ?? headerSid;
      const currentDispatch = result.item.dispatch as { session_id?: string } | undefined;
      if (sidToStamp && !currentDispatch?.session_id) {
        inbox.upsert(
          result.item.id,
          result.item.kind,
          result.item.source,
          { dispatch: { session_id: sidToStamp } },
        );
      }

      // Optional reopen: clear `closed` on every question so the user can answer again.
      if (args.reopen && Array.isArray(result.item.questions) && result.item.questions.length > 0) {
        const reopenedQs = result.item.questions.map((q) => ({ ...q, closed: false }));
        const reopened = inbox.upsert(
          result.item.id,
          result.item.kind,
          result.item.source,
          { questions: reopenedQs },
        );
        return {
          content: [{ type: 'text', text: `Appended reply ${reply.id} and reopened ${reopenedQs.length} question(s) on ${args.id}.` }],
          structuredContent: { item: reopened.item, reply },
        };
      }

      return {
        content: [{ type: 'text', text: `Appended reply ${reply.id} to ${args.id}.` }],
        structuredContent: { item: result.item, reply },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- inbox.set_state ------------------------------------------------------
  defineTool({
    name: 'inbox.set_state',
    description: 'Transition an inbox item to a new state; reason is recorded as a message attribution.',
    parameters: z.object({
      id: z.string().min(1),
      state: inboxStateField,
      reason: z.string().optional(),
    }),
    handler: async (args) => {
      const item = inbox.setState(args.id, args.state as InboxState);
      if (!item) return notFound('inbox_item', args.id);
      return {
        content: [{ type: 'text', text: `Set ${item.id} → ${item.state}.` }],
        structuredContent: { item },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- inbox.snooze ---------------------------------------------------------
  defineTool({
    name: 'inbox.snooze',
    description: 'Snooze an inbox item until a unix-ms timestamp.',
    parameters: z.object({
      id: z.string().min(1),
      until: z.number().int().positive(),
    }),
    handler: async (args) => {
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
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });

  // -- inbox.archive --------------------------------------------------------
  defineTool({
    name: 'inbox.archive',
    description: 'Archive an inbox item (sets state to "archived").',
    parameters: z.object({ id: z.string().min(1) }),
    handler: async (args) => {
      const item = inbox.archive(args.id);
      if (!item) return notFound('inbox_item', args.id);
      // Threads attached to an archived inbox item could cascade-terminate;
      // current build leaves them running and lets `thread.cancel` clean up
      // explicitly. Add cascade once the SQLite kernel lands.
      threads;
      return {
        content: [{ type: 'text', text: `Archived ${item.id}.` }],
        structuredContent: { item },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
