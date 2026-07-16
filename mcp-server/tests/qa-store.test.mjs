/**
 * qa-store.test.mjs — unit tests for per-artifact Q&A persistence.
 *
 * Each PR-walkthrough step owns a thread file at
 * <artifactDir>/qa/step-<N>.json. The API writes questions; agents write
 * answers via the pr-walkthrough.answer MCP tool. readThread tolerates
 * missing/malformed files by returning []; appendAnswer rejects unknown
 * question ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendQuestion, appendAnswer, readThread } from '../src/qa-store.ts';

function freshArtifact() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  mkdirSync(join(dir, 'qa'), { recursive: true });
  return dir;
}

test('appendQuestion writes a question with id + timestamp', async () => {
  const dir = freshArtifact();
  try {
    const entry = await appendQuestion({ artifactDir: dir, stepN: 1, text: 'why?' });
    assert.equal(typeof entry.id, 'string');
    assert.match(entry.id, /^q_/);
    assert.equal(entry.q, 'why?');
    assert.equal(typeof entry.askedAt, 'string');
    assert.doesNotThrow(() => new Date(entry.askedAt).toISOString());
    // A plain question carries no kind/anchor (backward compatible on disk).
    assert.equal(entry.kind, undefined);
    assert.equal(entry.anchor, undefined);
    const thread = await readThread({ artifactDir: dir, stepN: 1 });
    assert.equal(thread.length, 1);
    assert.deepEqual(thread[0], entry);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendQuestion persists a line-anchored comment (kind + anchor)', async () => {
  const dir = freshArtifact();
  try {
    const entry = await appendQuestion({
      artifactDir: dir, stepN: 3, text: 'nit: rename this',
      kind: 'comment', anchor: { file: 'src/a.ts', line: 42, side: 'add' },
    });
    assert.equal(entry.kind, 'comment');
    assert.deepEqual(entry.anchor, { file: 'src/a.ts', line: 42, side: 'add' });
    const thread = await readThread({ artifactDir: dir, stepN: 3 });
    assert.equal(thread.length, 1);
    assert.equal(thread[0].kind, 'comment');
    assert.equal(thread[0].anchor.line, 42);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAnswer works for a comment entry (same tool answers both)', async () => {
  const dir = freshArtifact();
  try {
    const c = await appendQuestion({
      artifactDir: dir, stepN: 2, text: 'is this safe?',
      kind: 'comment', anchor: { file: 'x.ts', line: 1, side: 'del' },
    });
    await appendAnswer({ artifactDir: dir, stepN: 2, questionId: c.id, text: 'yes — guarded.' });
    const thread = await readThread({ artifactDir: dir, stepN: 2 });
    assert.equal(thread[0].a, 'yes — guarded.');
    assert.equal(thread[0].kind, 'comment', 'answering must not drop the comment kind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAnswer attaches answer to existing question', async () => {
  const dir = freshArtifact();
  try {
    const q = await appendQuestion({ artifactDir: dir, stepN: 2, text: 'how?' });
    await appendAnswer({ artifactDir: dir, stepN: 2, questionId: q.id, text: 'like this' });
    const thread = await readThread({ artifactDir: dir, stepN: 2 });
    assert.equal(thread.length, 1);
    assert.equal(thread[0].id, q.id);
    assert.equal(thread[0].a, 'like this');
    assert.equal(typeof thread[0].ts, 'string');
    assert.doesNotThrow(() => new Date(thread[0].ts).toISOString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readThread returns [] when file does not exist', async () => {
  const dir = freshArtifact();
  try {
    const thread = await readThread({ artifactDir: dir, stepN: 99 });
    assert.deepEqual(thread, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendAnswer throws on missing question id', async () => {
  const dir = freshArtifact();
  try {
    await appendQuestion({ artifactDir: dir, stepN: 3, text: 'q' });
    await assert.rejects(
      () => appendAnswer({ artifactDir: dir, stepN: 3, questionId: 'q_does_not_exist', text: 'a' }),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two questions on same step preserve order', async () => {
  const dir = freshArtifact();
  try {
    const q1 = await appendQuestion({ artifactDir: dir, stepN: 4, text: 'first' });
    const q2 = await appendQuestion({ artifactDir: dir, stepN: 4, text: 'second' });
    const thread = await readThread({ artifactDir: dir, stepN: 4 });
    assert.equal(thread.length, 2);
    assert.equal(thread[0].id, q1.id);
    assert.equal(thread[0].q, 'first');
    assert.equal(thread[1].id, q2.id);
    assert.equal(thread[1].q, 'second');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent appendQuestion calls do not lose entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-'));
  mkdirSync(join(dir, 'qa'), { recursive: true });
  try {
    await Promise.all([
      appendQuestion({ artifactDir: dir, stepN: 1, text: 'q1' }),
      appendQuestion({ artifactDir: dir, stepN: 1, text: 'q2' }),
      appendQuestion({ artifactDir: dir, stepN: 1, text: 'q3' }),
    ]);
    const thread = await readThread({ artifactDir: dir, stepN: 1 });
    assert.equal(thread.length, 3);
    const texts = thread.map(e => e.q).sort();
    assert.deepEqual(texts, ['q1', 'q2', 'q3']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
