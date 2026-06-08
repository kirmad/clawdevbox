/**
 * inbox-unread.test.mjs
 *
 * Coverage for the unread flag:
 *   - New items default to unread=true
 *   - Content-changing inbox.upsert (replies/questions/body/preview/title)
 *     sets unread=true
 *   - Metadata-only inbox.upsert (dispatch/labels/recipe_instance) does NOT
 *     toggle unread
 *   - Agent reply (inbox.reply with author='agent') sets unread=true
 *   - User reply (POST /api/inbox/<id>/reply via author=user) does NOT
 *     set unread (the user is the one replying)
 *   - inbox.mark_read MCP tool clears unread; idempotent for already-read
 *   - HTTP POST /api/inbox/<id>/mark-read clears unread (tested via the
 *     store helper since wiring needs a full http server)
 *   - Explicit `unread: false` on upsert suppresses default unread
 *   - Explicit `unread: true` on upsert forces unread on metadata-only update
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxStore } from '../src/store.ts';

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
// Default unread on creation
// ---------------------------------------------------------------------------

test('inbox.upsert: brand-new items are marked unread=true by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-1-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'u-1', kind: 'feature', source: 'agent', notify: false, title: 'fresh item',
    });
    assert.equal(inbox.read('u-1')?.unread, true, 'new item should be unread');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: explicit unread:false suppresses default-unread on creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-2-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', {
      id: 'u-2', kind: 'feature', source: 'agent', notify: false, title: 'silent refresh',
      unread: false,
    });
    assert.equal(inbox.read('u-2')?.unread, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Content-changing vs metadata-only updates
// ---------------------------------------------------------------------------

test('inbox.upsert: title update re-marks read item as unread (content changed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-3-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-3', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-3');
    assert.equal(inbox.read('u-3')?.unread, false);

    // Title change = new content → unread.
    await callRegisteredTool('inbox.upsert', {
      id: 'u-3', kind: 'feature', source: 'agent', notify: false, title: 'now with title',
    });
    assert.equal(inbox.read('u-3')?.unread, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: preview update marks unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-4-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-4', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-4');
    await callRegisteredTool('inbox.upsert', {
      id: 'u-4', kind: 'feature', source: 'agent', notify: false, preview: 'updated preview',
    });
    assert.equal(inbox.read('u-4')?.unread, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: questions update marks unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-5-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-5', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-5');
    await callRegisteredTool('inbox.upsert', {
      id: 'u-5', kind: 'feature', source: 'agent', notify: false,
      questions: [{ prompt: 'now answering?' }],
    });
    assert.equal(inbox.read('u-5')?.unread, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: metadata-only update (dispatch) does NOT toggle unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-6-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-6', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-6');
    assert.equal(inbox.read('u-6')?.unread, false);
    // Metadata-only: just adding dispatch.session_id, no content change.
    await callRegisteredTool('inbox.upsert', {
      id: 'u-6', kind: 'feature', source: 'agent', notify: false,
      session_id: 'sess_meta',
    });
    assert.equal(inbox.read('u-6')?.unread, false, 'metadata-only update should NOT mark unread');
    assert.equal(inbox.read('u-6')?.dispatch?.session_id, 'sess_meta');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: metadata-only update (labels) does NOT toggle unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-7-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-7', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-7');
    await callRegisteredTool('inbox.upsert', {
      id: 'u-7', kind: 'feature', source: 'agent', notify: false,
      labels: ['urgent', 'review'],
    });
    assert.equal(inbox.read('u-7')?.unread, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.upsert: explicit unread:true forces unread on metadata-only update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-8-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-8', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-8');
    await callRegisteredTool('inbox.upsert', {
      id: 'u-8', kind: 'feature', source: 'agent', notify: false,
      labels: ['urgent'],
      unread: true,    // explicit override
    });
    assert.equal(inbox.read('u-8')?.unread, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inbox.reply: agent reply sets unread; user reply does not
// ---------------------------------------------------------------------------

test('inbox.reply: agent reply re-marks read item as unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-9-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-9', kind: 'info', source: 'agent', notify: false });
    inbox.markRead('u-9');
    assert.equal(inbox.read('u-9')?.unread, false);

    await callRegisteredTool('inbox.reply', {
      id: 'u-9', reply: { author: 'agent', text: 'follow-up' },
    });
    assert.equal(inbox.read('u-9')?.unread, true, 'agent reply must mark item unread');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('InboxStore.appendReply: user-authored reply does NOT set unread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-10-'));
  try {
    const store = new InboxStore();
    store.bind(dir);
    store.upsert('u-10', 'feature', 'agent', { title: 't' });
    store.markRead('u-10');
    store.appendReply('u-10', {
      id: 'rep_test', author: 'user', text: 'I am the user', created_at: Date.now(),
    });
    assert.notEqual(store.read('u-10')?.unread, true, 'user reply must NOT mark unread');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// inbox.mark_read MCP tool
// ---------------------------------------------------------------------------

test('inbox.mark_read: clears unread on unread item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-11-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-11', kind: 'feature', source: 'agent', notify: false });
    assert.equal(inbox.read('u-11')?.unread, true);
    const r = await callRegisteredTool('inbox.mark_read', { id: 'u-11' });
    assert.equal(r.structuredContent.item.unread, false);
    assert.equal(inbox.read('u-11')?.unread, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.mark_read: idempotent on already-read item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-12-'));
  try {
    const { inbox } = await setupMcp(dir);
    await callRegisteredTool('inbox.upsert', { id: 'u-12', kind: 'feature', source: 'agent', notify: false });
    inbox.markRead('u-12');
    // Second mark-read should be no-op.
    const r = await callRegisteredTool('inbox.mark_read', { id: 'u-12' });
    assert.equal(r.structuredContent.item.unread, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inbox.mark_read: returns notFound for missing item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unread-13-'));
  try {
    await setupMcp(dir);
    const r = await callRegisteredTool('inbox.mark_read', { id: 'does-not-exist' });
    assert.ok(
      (r.structuredContent && r.structuredContent.code === 'NOT_FOUND') ||
      (r.content?.[0]?.text || '').includes('not found'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
