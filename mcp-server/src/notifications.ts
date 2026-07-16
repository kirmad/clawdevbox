/**
 * notifications.ts
 *
 * Browser push (Web Push + VAPID). Three responsibilities:
 *
 *   1. **VAPID setup** — `generateVapidKeys()` mints the P-256 keypair that
 *      `clawdevbox init` saves to `.clawdevbox/config.json`. The browser
 *      uses the public half in `pushManager.subscribe`; the server uses the
 *      private half (via `web-push`) to sign messages bound for the user's
 *      push service (FCM / Mozilla / APNs).
 *
 *   2. **Subscription store** — each browser device that opts in POSTs its
 *      `PushSubscription` (endpoint + p256dh + auth) to `/api/push/subscribe`.
 *      We persist the lot in `<projectDir>/.clawdevbox/push-subscriptions.json`
 *      so subscriptions survive restarts. Dead endpoints (HTTP 404/410 from
 *      the push service) are pruned automatically on the next send.
 *
 *   3. **Sending** — `sendNotification` encrypts + posts the payload to every
 *      subscription. Best-effort: per-endpoint failures don't fail the call.
 *
 * Auth note: `/api/push/*` is unauthenticated to match the rest of the home
 * page's API surface (which is loopback-only by design). When exposed over
 * the public devtunnel, anyone with the URL can subscribe their device.
 * That's the intended behavior — it's how YOU subscribe your phone after
 * installing the PWA off the tunnel.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { emitChange } from './event-bus.ts';
import { writeFileAtomic } from './fs-util.ts';
import { logger } from './logger.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushSubscriptionRecord {
  /** Endpoint URL — the push service the browser bound to. Unique within file. */
  endpoint: string;
  /** Crypto keys the push service uses to encrypt the payload. */
  keys: {
    p256dh: string;
    auth: string;
  };
  /** Optional client-supplied label for the UI ("Pixel 8 · Chrome"). */
  label?: string;
  /** Unix ms timestamps. `last_seen_at` updated on every successful send. */
  created_at: number;
  last_seen_at: number;
}

export interface NotifyPayload {
  /** Bold one-liner. Required. */
  title: string;
  /** Body text shown under the title. */
  body?: string;
  /** Path or URL the SW opens when the user taps the notification. */
  url?: string;
  /** Collapse key — newer notifications with same tag replace older ones. */
  tag?: string;
  /** Optional icon override (defaults to `/icon.svg`). */
  icon?: string;
  /** `true` to bypass the OS DND/quiet-time. Used sparingly. */
  require_interaction?: boolean;
}

// ---------------------------------------------------------------------------
// VAPID keypair
// ---------------------------------------------------------------------------

/** Used as a default `subject` when init doesn't ask the user. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:clawdevbox@localhost';

/** Generate a fresh VAPID keypair — base64url strings, 90+ char public key. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

// ---------------------------------------------------------------------------
// Subscription store (file-backed)
// ---------------------------------------------------------------------------
//
// Subscriptions live under `<globalDir>/push-subscriptions.json`. They are
// account-scoped, tied to the VAPID keypair that signs them (also global),
// so storing per-project would force every project to maintain its own
// subscription list — and a notification fired from project A could not
// reach a phone subscribed via project B.
//
// **Backwards compat**: an older clawdevbox stored subscriptions under
// `<projectDir>/.clawdevbox/push-subscriptions.json`. `listSubscriptions`
// returns the union of both files; the next write consolidates them in
// the global file and deletes the legacy one.

const SUBS_FILENAME = 'push-subscriptions.json';

export interface SubsLocation {
  /** Optional: account-wide location (preferred). */
  globalDir?: string;
  /** Optional: legacy project-scoped file (read for migration only). */
  projectDir?: string;
}

function globalSubsPath(globalDir: string): string {
  return join(globalDir, SUBS_FILENAME);
}

function legacyProjectSubsPath(projectDir: string): string {
  return join(projectDir, '.clawdevbox', SUBS_FILENAME);
}

function readSubsFromFile(path: string): PushSubscriptionRecord[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is PushSubscriptionRecord =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as PushSubscriptionRecord).endpoint === 'string' &&
        !!(s as PushSubscriptionRecord).keys &&
        typeof (s as PushSubscriptionRecord).keys.p256dh === 'string' &&
        typeof (s as PushSubscriptionRecord).keys.auth === 'string',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), path },
      'notifications: subscription file unreadable; treating as empty',
    );
    return [];
  }
}

/**
 * Read all subscriptions. Searches both the global file (preferred) and
 * the legacy project file, then de-duplicates by endpoint.
 */
export function listSubscriptions(loc: SubsLocation): PushSubscriptionRecord[] {
  const fromGlobal = loc.globalDir ? readSubsFromFile(globalSubsPath(loc.globalDir)) : [];
  const fromProject = loc.projectDir ? readSubsFromFile(legacyProjectSubsPath(loc.projectDir)) : [];
  // De-duplicate by endpoint; project entries fill gaps the global file
  // doesn't already cover.
  const byEndpoint = new Map<string, PushSubscriptionRecord>();
  for (const s of fromGlobal) byEndpoint.set(s.endpoint, s);
  for (const s of fromProject) if (!byEndpoint.has(s.endpoint)) byEndpoint.set(s.endpoint, s);
  return [...byEndpoint.values()];
}

function writeSubscriptions(loc: SubsLocation, list: PushSubscriptionRecord[]): void {
  if (!loc.globalDir) {
    throw new Error('writeSubscriptions: globalDir is required (subscriptions live globally).');
  }
  writeFileAtomic(globalSubsPath(loc.globalDir), JSON.stringify(list, null, 2) + '\n');
  // Migration: remove the legacy project file so we have a single source
  // of truth going forward.
  if (loc.projectDir) {
    const legacy = legacyProjectSubsPath(loc.projectDir);
    if (existsSync(legacy)) {
      try {
        // Use sync unlink; failure is non-fatal — next write retries.
        const { unlinkSync } = require('node:fs');
        unlinkSync(legacy);
        logger.info({ path: legacy }, 'notifications: migrated legacy project-scope subscription file → global');
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), path: legacy },
          'notifications: failed to remove legacy project subscription file (will retry on next write)',
        );
      }
    }
  }
}

/** Idempotent insert keyed by endpoint. Updates label + last_seen_at on collision. */
export function addSubscription(
  loc: SubsLocation,
  sub: Omit<PushSubscriptionRecord, 'created_at' | 'last_seen_at'> & Partial<Pick<PushSubscriptionRecord, 'created_at' | 'last_seen_at'>>,
): PushSubscriptionRecord {
  const list = listSubscriptions(loc);
  const now = Date.now();
  const idx = list.findIndex((s) => s.endpoint === sub.endpoint);
  const record: PushSubscriptionRecord = {
    endpoint: sub.endpoint,
    keys: sub.keys,
    label: sub.label,
    created_at: idx >= 0 ? list[idx]!.created_at : now,
    last_seen_at: now,
  };
  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.push(record);
  }
  writeSubscriptions(loc, list);
  emitChange('notifications');
  return record;
}

/** Remove by endpoint. Returns true if anything was removed. */
export function removeSubscription(loc: SubsLocation, endpoint: string): boolean {
  const list = listSubscriptions(loc);
  const next = list.filter((s) => s.endpoint !== endpoint);
  if (next.length === list.length) return false;
  writeSubscriptions(loc, next);
  emitChange('notifications');
  return true;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface NotifyResult {
  attempted: number;
  delivered: number;
  pruned: number;
  errors: string[];
}

/**
 * Send a notification to every subscribed device. Returns counts so the
 * caller (MCP tool / test endpoint) can report what actually happened.
 *
 * Failed endpoints with status 404 (Gone) or 410 (Forbidden — subscription
 * revoked) are silently pruned. Other failures are reported but kept so a
 * transient push-service outage doesn't lose subscriptions.
 */
export async function sendNotification(
  loc: SubsLocation,
  vapid: { publicKey: string; privateKey: string; subject: string },
  payload: NotifyPayload,
): Promise<NotifyResult> {
  const list = listSubscriptions(loc);
  const result: NotifyResult = {
    attempted: list.length,
    delivered: 0,
    pruned: 0,
    errors: [],
  };
  if (list.length === 0) return result;

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body ?? '',
    url: payload.url ?? '/',
    icon: payload.icon ?? '/icon.svg',
    tag: payload.tag ?? 'clawdevbox',
    require_interaction: !!payload.require_interaction,
  });

  const dead: string[] = [];
  await Promise.all(
    list.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          body,
          { TTL: 60 * 60 },
        );
        result.delivered += 1;
        s.last_seen_at = Date.now();
      } catch (err: unknown) {
        const status =
          typeof err === 'object' && err && 'statusCode' in err
            ? (err as { statusCode: number }).statusCode
            : 0;
        if (status === 404 || status === 410) {
          dead.push(s.endpoint);
          result.pruned += 1;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`${truncEndpoint(s.endpoint)}: ${msg}`);
          logger.warn({ endpoint: truncEndpoint(s.endpoint), status, err: msg }, 'notifications: send failed');
        }
      }
    }),
  );

  if (dead.length > 0) {
    const remaining = list.filter((s) => !dead.includes(s.endpoint));
    writeSubscriptions(loc, remaining);
    emitChange('notifications');
  } else {
    // Re-write to refresh last_seen_at timestamps and migrate from legacy.
    writeSubscriptions(loc, list);
  }
  return result;
}

function truncEndpoint(e: string): string {
  if (e.length <= 60) return e;
  return e.slice(0, 30) + '…' + e.slice(-25);
}
