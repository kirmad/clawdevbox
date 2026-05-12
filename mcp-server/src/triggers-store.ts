/**
 * triggers-store.ts
 *
 * Storage layer for REGISTERED triggers (spec §8.3). Distinct from the
 * trigger-TYPES registry built at boot in workspace.ts.
 *
 * Disk shape (`<project_dir>/.conductor/triggers.json`):
 *
 *   {
 *     "registered": [
 *       {
 *         "id": "ado.new-pr-watcher#auth-svc",
 *         "type": "ado.new-pr-watcher",
 *         "params": { "repo": "auth-svc" },
 *         "cron": null,                    // null=inherit, "<expr>"=override, false=disable
 *         "enabled": true,
 *         "subscriber_thread_id": null,
 *         "expires_at": null,
 *         "once": false,
 *         "registered_at": 1715380000000,
 *         "state": {},
 *         "last_run_at": null,
 *         "last_run_status": null,
 *         "last_run_error": null
 *       }
 *     ]
 *   }
 *
 * Atomic writes — tempfile + rename (matches recipes' pattern). Reads tolerate
 * partial corruption (return an empty `registered[]` rather than throwing).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';

// ============================================================================
// Disk shape
// ============================================================================

/**
 * A registered trigger instance. `cron` semantics:
 *   - string                       → override the type's default_cron
 *   - null / undefined             → inherit the type's default_cron
 *   - false / "" (stored as false) → cron disabled (webhook/manual only)
 */
export interface RegisteredTrigger {
  id: string;
  type: string;
  params: Record<string, unknown>;
  cron: string | null | false;
  enabled: boolean;
  subscriber_thread_id: string | null;
  expires_at: number | null;
  once: boolean;
  registered_at: number;
  state: Record<string, unknown>;
  last_run_at: number | null;
  last_run_status: 'ok' | 'error' | null;
  last_run_error: string | null;
}

interface TriggersFile {
  registered: RegisteredTrigger[];
}

// ============================================================================
// Read / write
// ============================================================================

export function readTriggersFile(path: string): TriggersFile {
  if (!existsSync(path)) return { registered: [] };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TriggersFile>;
    return {
      registered: Array.isArray(parsed.registered) ? parsed.registered as RegisteredTrigger[] : [],
    };
  } catch {
    return { registered: [] };
  }
}

export function writeTriggersFile(path: string, file: TriggersFile): void {
  writeFileAtomic(path, JSON.stringify(file, null, 2) + '\n');
}

// ============================================================================
// Id minting (spec §8.3)
// ============================================================================

/**
 * Mint a registered-trigger id.
 *
 *   - If `identityParam` is set and the params object carries it, the id is
 *     `<type_id>#<param[identityParam]>` (e.g. `ado.new-pr-watcher#auth-svc`).
 *     We URL-encode the param value to keep ids file-safe.
 *
 *   - Otherwise, deterministically hash all params and use the first 8 hex
 *     chars: `<type_id>#<hash8>`.
 *
 * Deterministic stable hashing requires canonical key ordering — we sort the
 * top-level keys before stringifying. Nested objects/arrays use their natural
 * JSON.stringify order; canonical-json (RFC 8785) is a future upgrade if
 * deeper nesting starts producing collisions.
 */
export function mintRegisteredId(
  typeId: string,
  params: Record<string, unknown>,
  identityParam?: string,
): string {
  if (identityParam && Object.prototype.hasOwnProperty.call(params, identityParam)) {
    const raw = params[identityParam];
    if (raw === null || raw === undefined || raw === '') {
      // Fall through to hash if the identity value is empty.
    } else {
      return `${typeId}#${encodeURIComponent(String(raw))}`;
    }
  }
  const sortedKeys = Object.keys(params).sort();
  const canonical = sortedKeys.map((k) => [k, params[k]] as const);
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 8);
  return `${typeId}#${hash}`;
}
