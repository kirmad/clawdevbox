/**
 * fs-util.ts
 *
 * Tiny shared filesystem helpers used by the file-backed tool families
 * (recipe, skill, trigger, plugin). The two important ones:
 *
 *   - writeFileAtomic: write to a tempfile in the same directory, then
 *     `fs.rename` into place. On POSIX this is atomic; on Windows
 *     `fs.rename` is best-effort-atomic but at minimum partial writes
 *     are not visible to readers.
 *
 *   - ensureDirSync: mkdir -p
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeFileAtomic(target: string, contents: string): void {
  ensureDirSync(dirname(target));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    // Cleanup on failure
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function writeFileAtomicAsync(target: string, contents: Buffer | string): Promise<void> {
  const rand = randomBytes(4).toString('hex');
  const tmp = `${target}.${process.pid}.${Date.now()}.${rand}.tmp`;
  await writeFile(tmp, contents);
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
