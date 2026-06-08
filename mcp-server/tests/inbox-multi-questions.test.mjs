/**
 * inbox-multi-questions.test.mjs
 *
 * Tests for the multi-question inbox feature:
 *   - inbox.upsert accepts a `questions: InboxQuestion[]` array
 *   - each question gets an auto-id (q1, q2, ...) when caller omits one
 *   - duplicate ids are rejected
 *   - validateBatchAnswer requires every question to have an answer
 *   - validateBatchAnswer validates per-question (mode + options + freeform)
 *   - compileBatchAnswer produces a multi-line bubble + dispatch prompt
 *   - pickDispatchRouter picks the first question with a dispatch.session_id
 *   - InboxStore.appendReply with closeQuestion=true closes ALL questions
 *   - legacy single-question shape auto-migrates to questions[0] on read
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateBatchAnswer,
  compileBatchAnswer,
  pickDispatchRouter,
} from '../src/inbox-reply.ts';
import { InboxStore } from '../src/store.ts';

async function callRegisteredTool(name, args) {
  const { getRegistry } = await import('../src/tools/registry.ts');
  const entry = getRegistry().get(name);
  if (!entry) throw new Error(`tool ${name} not registered`);
  return await entry.handler(args, {});
}

async function setupMcp(dir) {
  const { inbox } = await import('../src/store.ts');
  inbox.bind(dir);
  const { registerInboxEntries } = await import('../src/tools/inbox.ts');
  const { clearRegistry } = await import('../src/tools/registry.ts');
  clearRegistry();
  registerInboxEntries({ projectDir: dir, globalDir: dir });
  return { inbox };
}

// ---------------------------------------------------------------------------
// MCP inbox.upsert: questions array
// ---------------------------------------------------------------------------

test('inbox.upsert: accepts questions array; auto-ids when omitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-'));
  try {
    await setupMcp(dir);
    const r = await callRegisteredTool('inbox.upsert', {
      id: 'wi-100',
      kind: 'feature',
      source: 'agent',
      notify: false,
      questions: [
        { prompt: 'Database?',  options: [{id:'pg', label:'Postgres'}, {id:'my', label:'MySQL'}] },
        { prompt: 'Auth?',      options: [{id:'jwt', label:'JWT'}, {id:'sess', label:'Sessions'}] },
        { prompt: 'Notes',      mode: 'text' },
      ],
    });
    const qs = r.structuredContent.item.questions;
    assert.equal(qs.length, 3);
    assert.equal(qs[0].id, 'q1');
    assert.equal(qs[1].id, 'q2');
    assert.equal(qs[2].id, 'q3');
    assert.equal(qs[0].mode, 'single');     // defaults from options
    assert.equal(qs[2].mode, 'text');
    assert.equal(qs[0].close_on_answer, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: rejects duplicate question ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-dup-'));
  try {
    await setupMcp(dir);
    await assert.rejects(
      () => callRegisteredTool('inbox.upsert', {
        id: 'dup-1',
        kind: 'feature',
        source: 'agent',
        notify: false,
        questions: [
          { id: 'x', prompt: 'first?' },
          { id: 'x', prompt: 'second?' },
        ],
      }),
      /duplicate id "x"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: legacy `question` shorthand promotes to questions[0] with id="q1"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-legacy-'));
  try {
    await setupMcp(dir);
    const r = await callRegisteredTool('inbox.upsert', {
      id: 'legacy-1',
      kind: 'question',
      source: 'agent',
      notify: false,
      question: { prompt: 'Approve?', options: [{id:'y', label:'Yes'}] },
    });
    const qs = r.structuredContent.item.questions;
    assert.equal(qs.length, 1);
    assert.equal(qs[0].id, 'q1');
    assert.equal(qs[0].prompt, 'Approve?');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: questions=[] clears all questions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-clear-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'c1', kind: 'question', source: 'agent', notify: false,
      questions: [{ prompt: 'A?' }, { prompt: 'B?' }],
    });
    assert.equal(inbox.read('c1')?.questions?.length, 2);
    await callRegisteredTool('inbox.upsert', {
      id: 'c1', kind: 'question', source: 'agent', notify: false,
      questions: [],
    });
    assert.equal((inbox.read('c1')?.questions ?? []).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// validateBatchAnswer
// ---------------------------------------------------------------------------

test('validateBatchAnswer: requires every question to have an answer', () => {
  const questions = [
    { id: 'db', prompt: 'Database?', options: [{id:'pg', label:'PG'}], mode: 'single' },
    { id: 'auth', prompt: 'Auth?', options: [{id:'jwt', label:'JWT'}], mode: 'single' },
  ];
  const r = validateBatchAnswer(questions, [
    { question_id: 'db', option_ids: ['pg'] },
    // 'auth' missing
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ANSWER');
  assert.equal(r.error.question_id, 'auth');
});

test('validateBatchAnswer: rejects answer for unknown question_id', () => {
  const questions = [{ id: 'db', prompt: 'Database?', options: [{id:'pg', label:'PG'}] }];
  const r = validateBatchAnswer(questions, [{ question_id: 'unknown', option_ids: ['pg'] }]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_QUESTION');
});

test('validateBatchAnswer: validates per-question (each question keeps its own mode)', () => {
  const questions = [
    { id: 'db', prompt: 'Database?', options: [{id:'pg', label:'PG'}], mode: 'single' },
    { id: 'notes', prompt: 'Notes', mode: 'text' },
  ];
  // Missing text for the text-mode question
  const r = validateBatchAnswer(questions, [
    { question_id: 'db', option_ids: ['pg'] },
    { question_id: 'notes' },  // no text
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TEXT_REQUIRED');
  assert.equal(r.error.question_id, 'notes');
});

test('validateBatchAnswer: legacy single-RawAnswer shorthand works for 1-question items', () => {
  const questions = [{ id: 'q1', prompt: 'Approve?', options: [{id:'y', label:'Yes'}] }];
  // Pass a single RawAnswer (not an array) — should be treated as q1's answer.
  const r = validateBatchAnswer(questions, { option_ids: ['y'] });
  assert.equal(r.ok, true);
  assert.equal(r.value.length, 1);
  assert.equal(r.value[0].option_ids[0], 'y');
});

test('validateBatchAnswer: legacy single-RawAnswer shorthand rejected for multi-question items', () => {
  const questions = [
    { id: 'q1', prompt: 'A?', options: [{id:'a', label:'A'}] },
    { id: 'q2', prompt: 'B?', options: [{id:'b', label:'B'}] },
  ];
  const r = validateBatchAnswer(questions, { option_ids: ['a'] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_ANSWER');
});

// ---------------------------------------------------------------------------
// compileBatchAnswer
// ---------------------------------------------------------------------------

test('compileBatchAnswer: per-question lines in bubble + dispatch prompt', () => {
  const questions = [
    { id: 'db', prompt: 'Database?', title: 'DB choice', options: [{id:'pg', label:'Postgres', value:'postgres'}] },
    { id: 'notes', prompt: 'Notes', mode: 'text' },
  ];
  const validated = validateBatchAnswer(questions, [
    { question_id: 'db', option_ids: ['pg'] },
    { question_id: 'notes', text: 'use sentinel mode' },
  ]);
  assert.ok(validated.ok);
  const compiled = compileBatchAnswer(validated.value);
  assert.equal(compiled.entries.length, 2);
  assert.equal(compiled.entries[0].question_id, 'db');
  assert.equal(compiled.entries[0].answer_text, 'Postgres');
  assert.equal(compiled.entries[1].question_id, 'notes');
  assert.equal(compiled.entries[1].answer_text, 'use sentinel mode');
  // Bubble text contains both questions
  assert.match(compiled.answer_text, /DB choice/);
  assert.match(compiled.answer_text, /Postgres/);
  assert.match(compiled.answer_text, /use sentinel mode/);
  // Dispatch prompt is structured
  assert.match(compiled.dispatch_prompt, /Q \(db\)/);
  assert.match(compiled.dispatch_prompt, /Q \(notes\)/);
});

// ---------------------------------------------------------------------------
// pickDispatchRouter
// ---------------------------------------------------------------------------

test('pickDispatchRouter: returns first question with dispatch.session_id; null if none', () => {
  assert.equal(pickDispatchRouter([]), null);
  assert.equal(pickDispatchRouter([{ id: 'a', prompt: 'a' }]), null);
  const router = pickDispatchRouter([
    { id: 'a', prompt: 'a' },
    { id: 'b', prompt: 'b', dispatch: { session_id: 'sess_1' } },
    { id: 'c', prompt: 'c', dispatch: { session_id: 'sess_2' } },
  ]);
  assert.equal(router?.id, 'b');
});

// ---------------------------------------------------------------------------
// InboxStore.appendReply: batch-close all questions
// ---------------------------------------------------------------------------

test('InboxStore.appendReply: closeQuestion=true closes ALL questions in the batch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-close-'));
  try {
    const store = new InboxStore();
    store.bind(dir);
    store.upsert('mc:1', 'feature', 'agent', {
      questions: [
        { id: 'q1', prompt: 'A?' },
        { id: 'q2', prompt: 'B?' },
        { id: 'q3', prompt: 'C?' },
      ],
    });
    const result = store.appendReply('mc:1', {
      id: 'rep_test', author: 'user', text: 'all done', created_at: Date.now(),
    }, { closeQuestion: true });
    assert.ok(result);
    const qs = result.item.questions;
    assert.equal(qs.length, 3);
    for (const q of qs) {
      assert.equal(q.closed, true, `expected ${q.id} to be closed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Read-time migration of legacy single-question items
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-turn: agent reply with NEW batch of questions
// ---------------------------------------------------------------------------

test('inbox.reply: agent reply with questions[] auto-ids and persists for follow-up Q&A', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-replyq-'));
  try {
    const { inbox } = await setupMcp(dir);
    // Seed an item.
    await callRegisteredTool('inbox.upsert', {
      id: 'mt:1', kind: 'feature', source: 'agent', notify: false,
      questions: [{ prompt: 'Initial Q?' }],
    });
    // Agent appends a reply with TWO new questions.
    const replyResult = await callRegisteredTool('inbox.reply', {
      id: 'mt:1',
      reply: {
        author: 'agent',
        text: 'Got it; two follow-ups:',
        questions: [
          { prompt: 'Follow-up 1?', mode: 'text' },
          { prompt: 'Follow-up 2?', options: [{id:'y', label:'Yes'}, {id:'n', label:'No'}] },
        ],
      },
    });
    assert.equal(replyResult.structuredContent.reply.author, 'agent');
    const persisted = inbox.read('mt:1');
    const agentReply = persisted?.replies?.[0];
    assert.ok(agentReply);
    assert.equal(agentReply.questions?.length, 2);
    assert.equal(agentReply.questions[0].id, 'q1');
    assert.equal(agentReply.questions[1].id, 'q2');
    assert.equal(agentReply.questions[0].mode, 'text');
    assert.equal(agentReply.questions[1].mode, 'single');
    assert.equal(agentReply.questions[0].close_on_answer, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

test('migration: legacy single `question` field auto-promotes to questions[0] with id=q1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-mq-migrate-'));
  try {
    const store = new InboxStore();
    store.bind(dir);
    store.upsert('legacy:1', 'question', 'agent', {
      question: { prompt: 'old format?', options: [{id:'y', label:'Yes'}] },
    });
    const reread = store.read('legacy:1');
    assert.ok(Array.isArray(reread?.questions));
    assert.equal(reread.questions.length, 1);
    assert.equal(reread.questions[0].id, 'q1');
    assert.equal(reread.questions[0].prompt, 'old format?');
    assert.equal(reread.questions[0].options[0].id, 'y');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// Item-level dispatch + session_id shorthand + header auto-inject
// ---------------------------------------------------------------------------

test('inbox.upsert: session_id shorthand maps to dispatch.session_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-disp-sid-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'd1', kind: 'feature', source: 'agent', notify: false,
      session_id: 'sess_xyz_123',
    });
    const item = inbox.read('d1');
    assert.equal(item?.dispatch?.session_id, 'sess_xyz_123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: explicit dispatch object wins over session_id shorthand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-disp-explicit-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'd2', kind: 'feature', source: 'agent', notify: false,
      session_id: 'sess_short',
      dispatch: { session_id: 'sess_explicit', provider: 'copilot', prompt_template: 'User said: {answer}' },
    });
    const item = inbox.read('d2');
    // session_id shorthand merges onto explicit dispatch; shorthand wins for session_id
    assert.equal(item?.dispatch?.session_id, 'sess_short');
    assert.equal(item?.dispatch?.provider, 'copilot');
    assert.equal(item?.dispatch?.prompt_template, 'User said: {answer}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: dispatch=null clears the item-level dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-disp-clear-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'd3', kind: 'feature', source: 'agent', notify: false,
      session_id: 'sess_initial',
    });
    assert.equal(inbox.read('d3')?.dispatch?.session_id, 'sess_initial');
    await callRegisteredTool('inbox.upsert', {
      id: 'd3', kind: 'feature', source: 'agent', notify: false,
      dispatch: null,
    });
    assert.equal(inbox.read('d3')?.dispatch, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: auto-injects dispatch.session_id from X-Clawdevbox-Session-Id header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-disp-hdr-'));
  try {
    const { inbox } = await setupMcp(dir);
    // Call with the header in `extra.requestInfo.headers`
    const { getRegistry } = await import('../src/tools/registry.ts');
    const entry = getRegistry().get('inbox.upsert');
    await entry.handler(
      { id: 'd-hdr', kind: 'feature', source: 'agent', notify: false },
      { requestInfo: { headers: { 'x-clawdevbox-session-id': 'sess_from_header' } } },
    );
    const item = inbox.read('d-hdr');
    assert.equal(item?.dispatch?.session_id, 'sess_from_header');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: header auto-inject is skipped when item already has dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-disp-noOver-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'd-no', kind: 'feature', source: 'agent', notify: false,
      session_id: 'sess_original',
    });
    // Update without dispatch arg but with header — shouldn't override existing.
    const { getRegistry } = await import('../src/tools/registry.ts');
    const entry = getRegistry().get('inbox.upsert');
    await entry.handler(
      { id: 'd-no', kind: 'feature', source: 'agent', notify: false, title: 'updated title' },
      { requestInfo: { headers: { 'x-clawdevbox-session-id': 'sess_should_be_ignored' } } },
    );
    assert.equal(inbox.read('d-no')?.dispatch?.session_id, 'sess_original');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.reply: agent reply with session_id stamps dispatch on the item if missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-reply-sid-'));
  try {
    const { inbox } = await setupMcp(dir);
    // Item without dispatch.
    await callRegisteredTool('inbox.upsert', {
      id: 'r1', kind: 'feature', source: 'agent', notify: false,
    });
    assert.equal(inbox.read('r1')?.dispatch, undefined);
    // Agent posts reply with session_id arg.
    await callRegisteredTool('inbox.reply', {
      id: 'r1',
      session_id: 'sess_from_reply',
      reply: { author: 'agent', text: 'I am working on it' },
    });
    assert.equal(inbox.read('r1')?.dispatch?.session_id, 'sess_from_reply');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});