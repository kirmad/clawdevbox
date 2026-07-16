/**
 * qa-store.ts
 *
 * Per-artifact Q&A thread persistence for the PR-walkthrough renderer.
 *
 * Layout (per artifact):
 *   <artifactDir>/qa/step-<N>.json   — append-only array of QaEntry
 *
 * Writers:
 *   - The HTTP route POST /artifact/<id>/qa/step-<N>.json appends questions
 *     (browser → server). See terminal-server.ts.
 *   - The pr-walkthrough.answer MCP tool appends answers (agent → server),
 *     wired up in Task 8 — not part of this module's surface.
 *
 * Both writers go through writeFileAtomicAsync, so concurrent readers
 * never observe a partially-written thread.
 */

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { ensureDirSync, writeFileAtomicAsync } from './fs-util.ts';
import { withKeyedLock } from './async-mutex.ts';
import { emitQaChange } from './event-bus.ts';

export interface QaAnchor {
  file?: string;
  line?: number;
  side?: string;
}

export interface QaEntry {
  id: string;
  q: string;
  askedAt: string;
  a?: string;
  ts?: string;
  /** Display name of the asker (shared-mode viewers). Absent = owner ("You"). */
  askedBy?: string;
  /** 'question' (default) for Q&A tab, 'comment' for a line-anchored review comment. */
  kind?: 'question' | 'comment';
  /** For kind==='comment': the diff line the comment is anchored to. */
  anchor?: QaAnchor;
}

function threadPath(artifactDir: string, stepN: number): string {
  return join(artifactDir, 'qa', `step-${stepN}.json`);
}

function lockKey(artifactDir: string, stepN: number): string {
  return `qa-store:${artifactDir}:${stepN}`;
}

function mintQuestionId(): string {
  const rand = randomBytes(4).toString('hex').slice(0, 8);
  const time = Date.now().toString(36).slice(-4);
  return `q_${rand}${time}`;
}

export async function readThread(args: {
  artifactDir: string;
  stepN: number;
}): Promise<QaEntry[]> {
  const file = threadPath(args.artifactDir, args.stepN);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as QaEntry[];
  } catch {
    return [];
  }
}

export async function appendQuestion(args: {
  artifactDir: string;
  stepN: number;
  text: string;
  kind?: 'question' | 'comment';
  anchor?: QaAnchor;
  askedBy?: string;
}): Promise<QaEntry> {
  const file = threadPath(args.artifactDir, args.stepN);
  ensureDirSync(join(args.artifactDir, 'qa'));
  return withKeyedLock(lockKey(args.artifactDir, args.stepN), async () => {
    const thread = await readThread({ artifactDir: args.artifactDir, stepN: args.stepN });
    const entry: QaEntry = {
      id: mintQuestionId(),
      q: args.text,
      askedAt: new Date().toISOString(),
    };
    // Attribute shared-mode questions to the name the viewer entered; owner
    // (main-server) questions carry no name and render as "You".
    if (typeof args.askedBy === 'string' && args.askedBy.trim()) {
      entry.askedBy = args.askedBy.trim().slice(0, 80);
    }
    // Only persist the discriminator/anchor for comments, so existing Q&A
    // entries stay byte-for-byte identical (kind defaults to 'question').
    if (args.kind === 'comment') {
      entry.kind = 'comment';
      if (args.anchor) entry.anchor = args.anchor;
    }
    thread.push(entry);
    await writeFileAtomicAsync(file, JSON.stringify(thread, null, 2));
    // Notify live SSE viewers of this artifact (basename(artifactDir) is the
    // artifact id per the `<ws>/artifacts/<id>/` layout).
    emitQaChange(basename(args.artifactDir));
    return entry;
  });
}

export async function appendAnswer(args: {
  artifactDir: string;
  stepN: number;
  questionId: string;
  text: string;
}): Promise<void> {
  const file = threadPath(args.artifactDir, args.stepN);
  await withKeyedLock(lockKey(args.artifactDir, args.stepN), async () => {
    const thread = await readThread({ artifactDir: args.artifactDir, stepN: args.stepN });
    const idx = thread.findIndex((e) => e.id === args.questionId);
    if (idx < 0) {
      throw new Error(`question not found: ${args.questionId}`);
    }
    thread[idx] = { ...thread[idx], a: args.text, ts: new Date().toISOString() };
    await writeFileAtomicAsync(file, JSON.stringify(thread, null, 2));
    emitQaChange(basename(args.artifactDir));
  });
}
