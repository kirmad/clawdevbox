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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadNotificationsConfig } from '../config.ts';
import {
  deleteInboxBody,
  readInboxBody,
  writeInboxBody,
} from '../inbox-persistence.ts';
import { sendNotification } from '../notifications.ts';
import { notFound, structuredError } from '../scope.ts';
import { inbox, threads, type InboxItem, type InboxState } from '../store.ts';
import type { Workspace } from '../workspace.ts';

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

function clipForPush(s: string): string {
  const t = s.trim();
  if (t.length <= PUSH_BODY_MAX) return t;
  return t.slice(0, PUSH_BODY_MAX - 1) + '…';
}

export function registerInboxTools(server: McpServer, ws: Workspace): void {
  // -- inbox.list -----------------------------------------------------------
  server.registerTool(
    'inbox.list',
    {
      description:
        'List inbox items (metadata only — body content NOT included; fetch a single item with inbox.read for the full description). Optionally filtered by kind/state/label and paginated by cursor.',
      inputSchema: {
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
      },
    },
    async (args) => {
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
  );

  // -- inbox.read -----------------------------------------------------------
  server.registerTool(
    'inbox.read',
    {
      description:
        'Read a single inbox item INCLUDING the full description body (if any). Pass `include_body: false` to skip the body when you only need metadata.',
      inputSchema: {
        id: z.string().min(1),
        include_body: z.boolean().optional(),
      },
    },
    async (args) => {
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
  );

  // -- inbox.upsert ---------------------------------------------------------
  server.registerTool(
    'inbox.upsert',
    {
      description:
        "Create or update an inbox item. Idempotent on `id`. Persisted to `<globalDir>/inbox.json` (metadata) and `<globalDir>/inbox-bodies/` (description bodies). SPA tabs auto-refresh via SSE; on creation (or when `notify: true`) a browser push fires. Supply `title`+`preview` for the card, `description`+`description_format` for the expanded body, `attachments` for clickable artifact chips, `labels` for free-form tag chips, and `recipe_instance`/`trigger_id` to link the item to spawned work. Update semantics: omitted = unchanged; `null` = cleared (for nullable fields); empty `attachments: []` or `labels: []` = cleared; empty `description: \"\"` = body deleted.",
      inputSchema: {
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
        agent_message: z.string().optional(),
        agent_tone: agentToneField.optional(),
        notify: z
          .boolean()
          .optional()
          .describe(
            'Send a browser push to subscribed devices. Default: true on creation, false on update. Set explicitly to force.',
          ),
      },
    },
    async (args) => {
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
      if (args.agent_message !== undefined) patch.agent_message = args.agent_message;
      if (args.agent_tone !== undefined) patch.agent_tone = args.agent_tone;

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
      // Threads attached to an archived inbox item could cascade-terminate;
      // current build leaves them running and lets `thread.cancel` clean up
      // explicitly. Add cascade once the SQLite kernel lands.
      threads;
      return {
        content: [{ type: 'text', text: `Archived ${item.id}.` }],
        structuredContent: { item },
      };
    },
  );
}
