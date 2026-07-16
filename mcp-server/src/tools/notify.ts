/**
 * tools/notify.ts
 *
 * `notify.send` — push a notification to every browser device that
 * subscribed via the home page. Reads VAPID keys from
 * `<projectDir>/.clawdevbox/config.json`; refuses to send when notifications
 * are disabled in config.
 *
 * Designed for the dev-buddy agent: "you've got a Sev3 incident, ping the
 * user's phone" → `notify.send({ title, body, url, tag })`.
 */

import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool } from './registry.ts';
import { loadNotificationsConfig } from '../config.ts';
import { sendNotification } from '../notifications.ts';
import type { Workspace } from '../workspace.ts';

export function registerNotifyEntries(ws: Workspace): void {
  defineTool({
    name: 'notify.send',
    description:
      "Send a browser push notification to every device that subscribed via the clawdevbox home page. Requires `notifications.enabled` + a VAPID keypair in the workspace's config.json (`clawdevbox init` mints these). Returns delivery counts. Dead endpoints (404/410) are pruned automatically.",
    parameters: z.object({
      title: z
        .string()
        .min(1)
        .max(120)
        .describe('Bold one-liner shown as the notification title.'),
      body: z
        .string()
        .max(400)
        .optional()
        .describe('Optional body text shown under the title.'),
      url: z
        .string()
        .optional()
        .describe(
          'Path (e.g. `/`) or absolute URL the SW opens when the user taps the notification. Defaults to `/`.',
        ),
      tag: z
        .string()
        .max(80)
        .optional()
        .describe(
          'Collapse key — newer notifications with the same tag replace older ones (avoids notification spam). Default: `clawdevbox`.',
        ),
      icon: z
        .string()
        .optional()
        .describe('Path/URL of an icon override. Default: `/icon.svg`.'),
      require_interaction: z
        .boolean()
        .optional()
        .describe(
          'When true, the notification persists until the user dismisses it. Use sparingly — only for genuinely urgent prompts.',
        ),
    }),
    handler: async (args) => {
      // Read the merged project+global notifications config so the MCP
      // tool sees the same `enabled` + VAPID keys the HTTP server does.
      const notifications = loadNotificationsConfig({
        projectDir: ws.projectDir,
        globalDir: ws.globalDir,
      });
      if (!notifications.enabled || !notifications.vapid) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                'Push notifications are not enabled. Re-run `clawdevbox init` and answer "yes" to the notifications question, then ask subscribers to re-enable on their devices.',
            },
          ],
          structuredContent: { code: 'NOTIFICATIONS_DISABLED' },
        };
      }

      const result = await sendNotification(
        { globalDir: ws.globalDir, projectDir: ws.projectDir },
        notifications.vapid,
        {
          title: args.title,
          body: args.body,
          url: args.url,
          tag: args.tag,
          icon: args.icon,
          require_interaction: args.require_interaction,
        },
      );

      const summary =
        result.attempted === 0
          ? 'No devices subscribed yet. Ask the user to open the clawdevbox home page on their phone and tap Enable notifications.'
          : `Delivered ${result.delivered}/${result.attempted}` +
            (result.pruned ? `; pruned ${result.pruned} dead endpoint(s)` : '') +
            (result.errors.length ? `; ${result.errors.length} error(s)` : '');

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: { ...result },
      };
    },
    source: 'builtin',
    sourceFile: fileURLToPath(import.meta.url),
  });
}
