/**
 * inbox-questions.test.mjs
 *
 * Covers the new question + reply chain feature:
 *
 *   1. InboxStore.appendReply / updateReply persistence (no DB)
 *   2. validateAnswer rules (single / multi / text + allow_freeform)
 *   3. compileAnswer prompt-template substitutions
 *   4. inbox.upsert + inbox.reply MCP tools accept the new fields
 *
 * No HTTP server — `/api/inbox/<id>/reply` is a thin wrapper over these
 * pieces + spawnDispatchOrResume (separately tested).
 *
 *   node --test tests/inbox-questions.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InboxStore, mintInboxReplyId } from '../src/store.ts';
import { validateAnswer, compileAnswer, effectiveMode } from '../src/inbox-reply.ts';

// ────────────────────────────────────────────────────────────────────────────
// InboxStore: appendReply + updateReply
// ────────────────────────────────────────────────────────────────────────────

test('InboxStore.appendReply: appends and persists across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-q-'));
  try {
    const a = new InboxStore();
    a.bind(dir);
    a.upsert('q:1', 'question', 'agent', {
      title: 'Pick one',
      question: {
        prompt: 'Yes or no?',
        mode: 'single',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        close_on_answer: true,
      },
    });

    const reply = {
      id: mintInboxReplyId(),
      author: 'user',
      text: 'Yes',
      option_ids: ['yes'],
      created_at: Date.now(),
    };
    const out = a.appendReply('q:1', reply, { closeQuestion: true, newState: 'open' });
    assert.ok(out);
    assert.equal(out.item.replies?.length, 1);
    assert.equal(out.item.replies?.[0]?.id, reply.id);
    assert.equal(out.item.question?.closed, true);
    assert.equal(out.item.state, 'open');

    // A fresh store sees the same chain.
    const b = new InboxStore();
    b.bind(dir);
    const reread = b.read('q:1');
    assert.equal(reread?.replies?.length, 1);
    assert.equal(reread?.replies?.[0]?.author, 'user');
    assert.equal(reread?.question?.closed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('InboxStore.appendReply: returns undefined for unknown id', () => {
  const store = new InboxStore();
  const out = store.appendReply('missing', {
    id: 'rep_x',
    author: 'agent',
    text: 'hi',
    created_at: Date.now(),
  });
  assert.equal(out, undefined);
});

test('InboxStore.updateReply: patches an existing reply in place', () => {
  const store = new InboxStore();
  store.upsert('q:2', 'question', 'agent', {
    question: { prompt: 'OK?' },
  });
  const reply = { id: 'rep_1', author: 'user', text: 'yes', created_at: 1 };
  store.appendReply('q:2', reply);

  const patched = store.updateReply('q:2', 'rep_1', {
    dispatch: { mode: 'dispatch', instance_id: 'ri_1', session_id: 'sess_1' },
  });
  assert.ok(patched);
  assert.equal(patched.reply.dispatch?.mode, 'dispatch');
  assert.equal(patched.item.replies?.[0]?.dispatch?.instance_id, 'ri_1');

  // Other fields preserved.
  assert.equal(patched.reply.text, 'yes');
});

test('InboxStore.updateReply: returns undefined for missing reply', () => {
  const store = new InboxStore();
  store.upsert('q:3', 'question', 'agent', { question: { prompt: '?' } });
  store.appendReply('q:3', { id: 'rep_a', author: 'user', text: 'x', created_at: 0 });
  assert.equal(store.updateReply('q:3', 'rep_nope', { text: 'y' }), undefined);
  assert.equal(store.updateReply('missing', 'rep_a', { text: 'y' }), undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// validateAnswer + compileAnswer
// ────────────────────────────────────────────────────────────────────────────

test('effectiveMode: defaults to single when options exist, else text', () => {
  assert.equal(effectiveMode({ prompt: 'q', options: [{ id: 'a', label: 'A' }] }), 'single');
  assert.equal(effectiveMode({ prompt: 'q' }), 'text');
  assert.equal(effectiveMode({ prompt: 'q', mode: 'multi', options: [{ id: 'a', label: 'A' }] }), 'multi');
  assert.equal(effectiveMode({ prompt: 'q', mode: 'text' }), 'text');
});

test('validateAnswer: single mode requires exactly one option', () => {
  const q = { prompt: 'q', mode: 'single', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const ok = validateAnswer(q, { option_ids: ['a'] });
  assert.equal(ok.ok, true);

  const tooMany = validateAnswer(q, { option_ids: ['a', 'b'] });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error.code, 'EXPECTED_ONE_OPTION');

  const none = validateAnswer(q, {});
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'EXPECTED_ONE_OPTION');
});

test('validateAnswer: single mode + allow_freeform accepts text-only', () => {
  const q = {
    prompt: 'q',
    mode: 'single',
    options: [{ id: 'a', label: 'A' }],
    allow_freeform: true,
  };
  const out = validateAnswer(q, { text: 'something custom' });
  assert.equal(out.ok, true);
  assert.equal(out.value.option_ids.length, 0);
  assert.equal(out.value.freeform, 'something custom');
});

test('validateAnswer: multi mode allows 1+ options', () => {
  const q = {
    prompt: 'q',
    mode: 'multi',
    options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }, { id: 'z', label: 'Z' }],
  };
  const ok = validateAnswer(q, { option_ids: ['x', 'z'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.option_ids, ['x', 'z']);

  const empty = validateAnswer(q, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'EXPECTED_OPTIONS');
});

test('validateAnswer: text mode requires text', () => {
  const q = { prompt: 'q', mode: 'text' };
  const empty = validateAnswer(q, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'TEXT_REQUIRED');

  const whitespace = validateAnswer(q, { text: '   ' });
  assert.equal(whitespace.ok, false);
  assert.equal(whitespace.error.code, 'TEXT_REQUIRED');

  const ok = validateAnswer(q, { text: '  hi  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.freeform, 'hi'); // trimmed
});

test('validateAnswer: rejects unknown option ids', () => {
  const q = { prompt: 'q', mode: 'single', options: [{ id: 'a', label: 'A' }] };
  const out = validateAnswer(q, { option_ids: ['nope'] });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'UNKNOWN_OPTION');
  assert.deepEqual(out.error.valid_ids, ['a']);
});

test('validateAnswer: deduplicates option ids preserving order', () => {
  const q = {
    prompt: 'q',
    mode: 'multi',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  };
  const out = validateAnswer(q, { option_ids: ['a', 'b', 'a'] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.value.option_ids, ['a', 'b']);
});

test('compileAnswer: defaults to {answer} = joined values, fallback to labels', () => {
  const q = {
    prompt: 'q',
    mode: 'single',
    options: [{ id: 'yes', label: 'Yes', value: 'YES_SIR' }, { id: 'no', label: 'No' }],
  };
  const v1 = validateAnswer(q, { option_ids: ['yes'] });
  assert.equal(v1.ok, true);
  const c1 = compileAnswer(q, v1.value);
  assert.equal(c1.answer_text, 'Yes');
  assert.equal(c1.dispatch_prompt, 'YES_SIR');

  // value defaults to label
  const v2 = validateAnswer(q, { option_ids: ['no'] });
  assert.equal(v2.ok, true);
  const c2 = compileAnswer(q, v2.value);
  assert.equal(c2.answer_text, 'No');
  assert.equal(c2.dispatch_prompt, 'No');
});

test('compileAnswer: prompt_template substitutes {answer} {option_ids} {freeform}', () => {
  const q = {
    prompt: 'q',
    mode: 'single',
    options: [{ id: 'yes', label: 'Yes' }],
    allow_freeform: true,
    dispatch: {
      prompt_template: 'User picked [{option_ids}] (={answer}). Extra: {freeform}',
    },
  };
  const v = validateAnswer(q, { option_ids: ['yes'], text: 'with caveats' });
  assert.equal(v.ok, true);
  const c = compileAnswer(q, v.value);
  assert.equal(c.dispatch_prompt, 'User picked [yes] (=Yes). Extra: with caveats');
  // Bubble text combines label + freeform with em-dash.
  assert.equal(c.answer_text, 'Yes — with caveats');
});

test('compileAnswer: text-only answer fills {answer} with freeform', () => {
  const q = { prompt: 'q', mode: 'text', dispatch: { prompt_template: 'They said: {answer}' } };
  const v = validateAnswer(q, { text: 'go for it' });
  assert.equal(v.ok, true);
  const c = compileAnswer(q, v.value);
  assert.equal(c.answer_text, 'go for it');
  assert.equal(c.dispatch_prompt, 'They said: go for it');
});

// ────────────────────────────────────────────────────────────────────────────
// MCP tool surface — inbox.upsert + inbox.reply
// ────────────────────────────────────────────────────────────────────────────

/** Helper: directly call a tool's handler via the registry (no MCP envelope). */
async function callRegisteredTool(name, args) {
  const { getRegistry } = await import('../src/tools/registry.ts');
  const entry = getRegistry().get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  const parsed = entry.parameters.parse(args);
  return entry.handler(parsed);
}

test('MCP inbox.upsert: accepts question + replies fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-q-mcp-'));
  try {
    const { inbox } = await import('../src/store.ts');
    inbox.bind(dir);
    const { registerInboxEntries } = await import('../src/tools/inbox.ts');
    const { clearRegistry, getRegistry } = await import('../src/tools/registry.ts');
    clearRegistry();
    registerInboxEntries({ projectDir: dir, globalDir: dir });

    const tools = [...getRegistry().keys()];
    assert.ok(tools.includes('inbox.upsert'));
    assert.ok(tools.includes('inbox.reply'));

    const upsertResult = await callRegisteredTool('inbox.upsert', {
      id: 'q-mcp-1',
      kind: 'question',
      source: 'agent',
      title: 'Approve?',
      notify: false, // skip push side-effect in tests
      question: {
        prompt: 'Approve the PR?',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        dispatch: { session_id: 'sess_abc', prompt_template: 'User says {answer}' },
      },
    });
    assert.equal(upsertResult.structuredContent.created, true);
    const item = upsertResult.structuredContent.item;
    assert.equal(item.question?.prompt, 'Approve the PR?');
    assert.equal(item.question?.options?.length, 2);
    assert.equal(item.question?.close_on_answer, true, 'close_on_answer defaults to true');
    assert.equal(item.question?.mode, 'single', 'mode defaults to single with options');

    // inbox.reply appends an agent follow-up.
    const replyResult = await callRegisteredTool('inbox.reply', {
      id: 'q-mcp-1',
      reply: { author: 'agent', text: 'Got it, working on it.' },
    });
    assert.equal(replyResult.structuredContent.reply.author, 'agent');
    assert.match(replyResult.structuredContent.reply.id, /^rep_/);
    assert.equal(replyResult.structuredContent.item.replies.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.upsert: question=null clears the question field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-q-clear-'));
  try {
    const { inbox } = await import('../src/store.ts');
    inbox.bind(dir);
    const { registerInboxEntries } = await import('../src/tools/inbox.ts');
    const { clearRegistry } = await import('../src/tools/registry.ts');
    clearRegistry();
    registerInboxEntries({ projectDir: dir, globalDir: dir });

    await callRegisteredTool('inbox.upsert', {
      id: 'q-clear',
      kind: 'question',
      source: 'agent',
      notify: false,
      question: { prompt: 'x?' },
    });
    assert.ok(inbox.read('q-clear')?.question);

    await callRegisteredTool('inbox.upsert', {
      id: 'q-clear',
      kind: 'question',
      source: 'agent',
      notify: false,
      question: null,
    });
    assert.equal(inbox.read('q-clear')?.question, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.reply: returns notFound for missing item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-q-miss-'));
  try {
    const { inbox } = await import('../src/store.ts');
    inbox.bind(dir);
    const { registerInboxEntries } = await import('../src/tools/inbox.ts');
    const { clearRegistry } = await import('../src/tools/registry.ts');
    clearRegistry();
    registerInboxEntries({ projectDir: dir, globalDir: dir });

    const out = await callRegisteredTool('inbox.reply', {
      id: 'nope',
      reply: { author: 'agent', text: 'x' },
    });
    // notFound returns isError: true with a structured error payload.
    assert.ok(out.isError || (out.structuredContent && out.structuredContent.error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
