/**
 * tools/ui.ts
 *
 * `ui.notify` — a single MCP tool that lets any plugin or agent ping the
 * Clawdevbox UI to refresh AND (optionally) push a notification to the
 * user's subscribed devices.
 *
 * Why one tool: from the plugin author's perspective there's one verb —
 * "tell the user something happened". They shouldn't have to know about
 * the SSE bus or the VAPID subsystem. Pass `topic` for an in-app refresh,
 * `push` for a phone buzz, or both.
 *
 * Topics map 1:1 to the SSE `ChangeTopic` union (see event-bus.ts) so the
 * SPA's existing subscribers pick them up unchanged. We accept `'custom'`
 * as an escape hatch — plugins that invent their own panel can still
 * trigger a fan-out (the SPA refreshes everything it knows about on a
 * `custom` topic, similar to a manual reload).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadNotificationsConfig } from '../config.ts';
import { emitChange, type ChangeTopic } from '../event-bus.ts';
import { sendNotification } from '../notifications.ts';
import type { Workspace } from '../workspace.ts';

const KNOWN_TOPICS = [
  'inbox',
  'recipes',
  'agent',
  'tunnel',
  'notifications',
  'triggers',
  'approvals',
  'custom',
] as const;

export function registerUiTools(server: McpServer, ws: Workspace): void {
  server.registerTool(
    'ui.notify',
    {
      description:
        "Tell the Clawdevbox UI something changed. Fires an SSE 'change' event for the given `topic` (every connected SPA tab refreshes its data for that topic) and OPTIONALLY also fires a browser push notification to subscribed devices. Use this whenever a plugin or trigger script wants the user to notice an event — e.g. a comment landed, an incident fired, an artifact is ready to view. Either `topic` or `push` must be supplied (usually both).",
      inputSchema: {
        topic: z
          .enum(KNOWN_TOPICS)
          .optional()
          .describe(
            'SSE topic the SPA should refresh. Standard topics: inbox, recipes, agent, tunnel, notifications, triggers, approvals. Pass `custom` to fan out a refresh to every panel.',
          ),
        push: z
          .object({
            title: z.string().min(1).max(120),
            body: z.string().max(400).optional(),
            url: z
              .string()
              .optional()
              .describe('Path or absolute URL the SW opens on tap. Defaults to `/`.'),
            tag: z
              .string()
              .max(80)
              .optional()
              .describe(
                'Collapse key — newer notifications with the same tag replace older ones. Default: `clawdevbox`.',
              ),
            icon: z.string().optional(),
            require_interaction: z.boolean().optional(),
          })
          .optional()
          .describe(
            'When present, also fires a browser push notification to every device subscribed via the home page. Requires `notifications.enabled` + VAPID keys in config.json.',
          ),
      },
    },
    async (args) => {
      if (!args.topic && !args.push) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'ui.notify requires at least one of `topic` or `push`.',
            },
          ],
          structuredContent: { code: 'NO_EFFECT' },
        };
      }

      let emitted: ChangeTopic | null = null;
      if (args.topic) {
        // 'custom' isn't part of ChangeTopic but the SPA listens for any
        // event on the bus; emitting 'notifications' is a safe fan-out
        // because the SPA reacts to that by refreshing the push pill and
        // the visible badge counts. For the typed bus we treat 'custom'
        // as 'notifications'.
        const topic = (args.topic === 'custom' ? 'notifications' : args.topic) as ChangeTopic;
        emitChange(topic);
        emitted = topic;
      }

      let push: {
        attempted: number;
        delivered: number;
        pruned: number;
        errors: string[];
      } | null = null;
      let pushErrorCode: string | null = null;
      if (args.push) {
        // Read the merged project+global notifications config, so the
        // MCP tool sees the same `enabled` + VAPID keys the HTTP server
        // does. Without this, a global-scope install (token + VAPID in
        // <globalDir>/config.json, no per-project config) would always
        // report NOTIFICATIONS_DISABLED from MCP-issued calls.
        const notifications = loadNotificationsConfig({
          projectDir: ws.projectDir,
          globalDir: ws.globalDir,
        });
        if (!notifications.enabled || !notifications.vapid) {
          pushErrorCode = 'NOTIFICATIONS_DISABLED';
        } else {
          push = await sendNotification(
            { globalDir: ws.globalDir, projectDir: ws.projectDir },
            notifications.vapid,
            args.push,
          );
        }
      }

      const lines: string[] = [];
      if (emitted) lines.push(`UI refresh: topic=${emitted}`);
      if (push) {
        lines.push(
          `Push: delivered ${push.delivered}/${push.attempted}` +
            (push.pruned ? `; pruned ${push.pruned}` : '') +
            (push.errors.length ? `; ${push.errors.length} error(s)` : ''),
        );
      } else if (args.push && pushErrorCode === 'NOTIFICATIONS_DISABLED') {
        lines.push(
          'Push: skipped — notifications.enabled=false or no VAPID keys (run `clawdevbox init`).',
        );
      }
      if (lines.length === 0) lines.push('ui.notify: nothing to do.');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          topic: emitted,
          push,
          push_error_code: pushErrorCode,
        },
      };
    },
  );
}
