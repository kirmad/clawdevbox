/**
 * trust-workspace.ts
 *
 * Add a workspace path to copilot's trustedFolders list in
 * ~/.copilot/config.json BEFORE spawning copilot in that workspace.
 *
 * Background: copilot CLI (1.0.57+) shows a "Do you trust the files in this
 * folder?" modal on first interactive launch in an unrecognized directory.
 * That modal blocks any seed/dispatched prompt because there's no human at
 * the terminal to answer. --yolo does NOT bypass the trust modal — it
 * only enables tool permissions.
 *
 * Solution: pre-populate copilot's trustedFolders so the modal never appears.
 * This mirrors what copilot does itself when the user answers "1. Yes, trust"
 * at the modal — we just do it programmatically before launch.
 *
 * ~/.copilot/config.json is JSON-with-comments (the first two lines are
 * // User settings ...). We strip line-comments before parsing, then
 * serialize back as plain JSON with a regenerated 2-line header to preserve
 * the original look.
 *
 * Concurrency: write atomically (writeFileAtomic) to survive races with
 * copilot's own background writes. We always re-read + merge before write,
 * so we never clobber other fields.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { writeFileAtomic } from './fs-util.ts';
import { logger } from './logger.ts';

const HEADER = '// User settings belong in settings.json.\n// This file is managed automatically.\n';

function copilotConfigPath(): string {
  return join(os.homedir(), '.copilot', 'config.json');
}

/**
 * Strip // line comments from JSONC text so JSON.parse can handle it.
 * Naive but sufficient for copilot's config.json which only uses //
 * at the start of lines (no inline // inside string values, no block
 * comments).
 */
function stripLineComments(jsonc: string): string {
  return jsonc.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Returns true if targetPath would already be trusted by copilot per its
 * trustedFolders list, accounting for folder prefix matches. Copilot trusts
 * a folder if it equals OR is a descendant of any trustedFolders entry.
 *
 * Comparison is case-insensitive on Windows. Both inputs are normalized to
 * lowercase with backslashes before comparison.
 */
function isAlreadyTrusted(targetPath: string, trustedFolders: string[]): boolean {
  const norm = (s: string) => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const target = norm(targetPath);
  for (const entry of trustedFolders) {
    if (typeof entry !== 'string') continue;
    const t = norm(entry);
    if (target === t) return true;
    if (target.startsWith(t + '\\')) return true;
  }
  return false;
}

/**
 * Add workspacePath to copilot's trustedFolders if it isn't already
 * covered (directly or by a parent in the list). Returns true if the file
 * was modified, false if no change was needed.
 *
 * Always returns; never throws. Errors are logged but don't fail the spawn
 * because the user can still manually accept the trust modal at worst.
 */
export function trustCopilotWorkspace(workspacePath: string): boolean {
  if (!workspacePath || typeof workspacePath !== 'string') return false;
  const cfgPath = copilotConfigPath();
  if (!existsSync(cfgPath)) {
    // No config yet (copilot never been run). Don't try to create it —
    // copilot's first run will set up the schema for us.
    return false;
  }

  let raw: string;
  try {
    raw = readFileSync(cfgPath, 'utf8');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'trust-workspace: read failed');
    return false;
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(stripLineComments(raw));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'trust-workspace: JSON parse failed');
    return false;
  }

  const trusted = Array.isArray(cfg.trustedFolders) ? (cfg.trustedFolders as string[]) : [];
  if (isAlreadyTrusted(workspacePath, trusted)) {
    return false;
  }

  // Normalize the path to copilot's canonical form (backslashes, no
  // trailing slash) so dedup works on subsequent calls.
  const canonical = workspacePath.replace(/\//g, '\\').replace(/\\+$/, '');
  trusted.push(canonical);
  cfg.trustedFolders = trusted;

  try {
    const body = HEADER + JSON.stringify(cfg, null, 2) + '\n';
    writeFileAtomic(cfgPath, body);
    logger.info({ workspacePath: canonical }, 'trust-workspace: added to copilot trustedFolders');
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'trust-workspace: write failed');
    return false;
  }
}
