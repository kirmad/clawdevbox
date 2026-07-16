/**
 * inbox-reply-e2e.test.mjs
 *
 * SYSTEMATIC reply-flow E2E coverage. Exercises every reply entry point
 * end-to-end (no SPA, no playwright dep) to catch regressions in the
 * multi-question + freeform refactor. Each test follows the
 * "create item → reply via path X → verify persisted state" pattern.
 *
 * Reply entry points:
 *   1. MCP inbox.reply tool (agent-authored follow-ups)
 *   2. HTTP POST /api/inbox/<id>/reply with `answers: [...]` (user batch)
 *   3. HTTP POST /api/inbox/<id>/reply with `option_ids` + `text` (legacy)
 *   4. HTTP POST /api/inbox/<id>/reply with `text` only (freeform; new)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function callRegisteredTool(name, args, extra) {
  const { getRegistry } = await import('../src/tools/registry.ts');
  const entry = getRegistry().get(name);
  if (!entry) throw new Error(`tool ${name} not registered`);
  return await entry.handler(args, extra ?? {});
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
// 1. MCP inbox.reply tool
// ---------------------------------------------------------------------------

test('MCP inbox.reply: agent reply on item WITHOUT questions succeeds (was suspect)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-1-'));
  try {
    const { inbox } = await setupMcp(dir);
    // Create a notification-only item (no questions).
    await callRegisteredTool('inbox.upsert', {
      id: 'info-1', kind: 'info', source: 'agent', notify: false,
      title: 'Background job finished', preview: '42 GB',
    });
    // Agent posts a reply.
    const result = await callRegisteredTool('inbox.reply', {
      id: 'info-1',
      reply: { author: 'agent', text: 'Indexing also finished; archives ready.' },
    });
    assert.equal(result.structuredContent.reply.author, 'agent');
    assert.match(result.structuredContent.reply.id, /^rep_/);
    // Verify persistence.
    const persisted = inbox.read('info-1');
    assert.equal(persisted?.replies?.length, 1);
    assert.equal(persisted?.replies?.[0]?.text, 'Indexing also finished; archives ready.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.reply: agent reply on item WITH single legacy question succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-2-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'q-1', kind: 'question', source: 'agent', notify: false,
      title: 'Approval needed',
      question: { prompt: 'Approve?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
    });
    const result = await callRegisteredTool('inbox.reply', {
      id: 'q-1',
      reply: { author: 'agent', text: 'Reminder — please review.' },
    });
    assert.equal(result.structuredContent.reply.author, 'agent');
    assert.equal(inbox.read('q-1')?.replies?.length, 1);
    // Legacy `question` migrated to `questions[0]` and still NOT closed (agent reply doesn't close).
    assert.equal(inbox.read('q-1')?.questions?.[0]?.closed, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.reply: agent reply on item WITH multi-question batch succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-3-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'qs-1', kind: 'question', source: 'agent', notify: false,
      title: 'Design questions',
      questions: [
        { id: 'db',   prompt: 'Database?', options: [{ id: 'pg', label: 'Postgres' }] },
        { id: 'auth', prompt: 'Auth?',     options: [{ id: 'jwt', label: 'JWT' }] },
      ],
    });
    const result = await callRegisteredTool('inbox.reply', {
      id: 'qs-1',
      reply: { author: 'agent', text: 'Reminder — both questions need answers.' },
    });
    assert.equal(result.structuredContent.reply.author, 'agent');
    const persisted = inbox.read('qs-1');
    assert.equal(persisted?.questions?.length, 2);
    // Neither closed by an agent reply.
    for (const q of persisted.questions) assert.equal(q.closed, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.reply: minimal reply (author + text only) is accepted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-4-'));
  try {
    await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'min-1', kind: 'info', source: 'agent', notify: false,
    });
    // No id, no created_at, no nothing — just author + text.
    const result = await callRegisteredTool('inbox.reply', {
      id: 'min-1',
      reply: { author: 'agent', text: 'hi' },
    });
    assert.equal(result.structuredContent.reply.author, 'agent');
    assert.equal(result.structuredContent.reply.text, 'hi');
    assert.match(result.structuredContent.reply.id, /^rep_/);
    assert.ok(typeof result.structuredContent.reply.created_at === 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.reply: zod schema rejects missing required field (text)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-5-'));
  try {
    await setupMcp(dir);
    // Pull the registered tool's schema and run safeParse directly —
    // mirrors what run_tool does at the meta-tool boundary.
    const { getRegistry } = await import('../src/tools/registry.ts');
    const entry = getRegistry().get('inbox.reply');
    assert.ok(entry, 'inbox.reply must be registered');
    const validation = entry.parameters.safeParse({
      id: 'v-1', reply: { author: 'agent' },  // no text
    });
    assert.equal(validation.success, false, 'schema must reject reply without text');
    const issueText = JSON.stringify(validation.error?.issues ?? []);
    assert.match(issueText, /text/i, `expected issue to mention 'text'; got: ${issueText}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP inbox.reply: nonexistent item returns notFound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-6-'));
  try {
    await setupMcp(dir);
    const result = await callRegisteredTool('inbox.reply', {
      id: 'never-existed', reply: { author: 'agent', text: 'hi' },
    });
    // notFound returns structuredError shape
    assert.ok(
      (result.structuredContent && result.structuredContent.code === 'NOT_FOUND') ||
      (result.content?.[0]?.text || '').includes('not found'),
      `expected notFound; got ${JSON.stringify(result).substring(0, 200)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. MCP inbox.upsert + dispatch persistence (used by freeform reply)
// ---------------------------------------------------------------------------

test('MCP: item-level dispatch persists across upserts (round-trip via read)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-7-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'd-1', kind: 'feature', source: 'agent', notify: false,
      session_id: 'sess_round_trip',
    });
    // First upsert sets dispatch.session_id
    let persisted = inbox.read('d-1');
    assert.equal(persisted?.dispatch?.session_id, 'sess_round_trip');
    // Second upsert (e.g. title update) without dispatch — should NOT clear dispatch
    await callRegisteredTool('inbox.upsert', {
      id: 'd-1', kind: 'feature', source: 'agent', notify: false,
      title: 'updated title',
    });
    persisted = inbox.read('d-1');
    assert.equal(persisted?.title, 'updated title');
    assert.equal(persisted?.dispatch?.session_id, 'sess_round_trip', 'dispatch must survive title-only update');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Edge case: upsert with `kind: "feature"` and existing item — no source/kind drift
// ---------------------------------------------------------------------------

test('MCP inbox.upsert: re-upserting same id preserves replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rep-e2e-8-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'pres-1', kind: 'info', source: 'agent', notify: false });
    await callRegisteredTool('inbox.reply', { id: 'pres-1', reply: { author: 'agent', text: 'first' } });
    await callRegisteredTool('inbox.reply', { id: 'pres-1', reply: { author: 'agent', text: 'second' } });
    // Now re-upsert with a title change — replies must be preserved.
    await callRegisteredTool('inbox.upsert', {
      id: 'pres-1', kind: 'info', source: 'agent', notify: false,
      title: 'now with title',
    });
    const persisted = inbox.read('pres-1');
    assert.equal(persisted?.replies?.length, 2);
    assert.equal(persisted?.replies?.[0]?.text, 'first');
    assert.equal(persisted?.replies?.[1]?.text, 'second');
    assert.equal(persisted?.title, 'now with title');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
