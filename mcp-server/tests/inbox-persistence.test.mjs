/**
 * inbox-persistence.test.mjs
 *
 * Direct unit tests for the file-backed InboxStore. These exercise the
 * persistence layer without spinning up the full MCP server, so they catch
 * regressions cheaply (~100ms total). The smoke test covers the MCP-level
 * wiring.
 *
 *   node --test tests/inbox-persistence.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// tsx must be available — package.json sets the test script to use it.
import { InboxStore } from '../src/store.ts';
import { inboxFilePath } from '../src/inbox-persistence.ts';

test('InboxStore: in-memory mode (unbound) does not touch disk', () => {
  const store = new InboxStore();
  const { item, created } = store.upsert('mem:1', 'note', 'manual', { title: 'hi' });
  assert.equal(created, true);
  assert.equal(item.id, 'mem:1');
  assert.equal(item.state, 'new');
  assert.equal(store.list().length, 1);
});

test('InboxStore: persists to <globalDir>/inbox.json and reloads across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-test-'));
  try {
    const a = new InboxStore();
    a.bind(dir);
    const r1 = a.upsert('ado:pr:42', 'pr_review', 'ado', { title: 'Fix auth' });
    assert.equal(r1.created, true);
    const r2 = a.upsert('ado:pr:42', 'pr_review', 'ado', { title: 'Fix auth (v2)' });
    assert.equal(r2.created, false);
    assert.equal(r2.item.title, 'Fix auth (v2)');

    // File should exist with both writes reflected.
    const path = inboxFilePath(dir);
    assert.ok(existsSync(path), `expected ${path} to exist`);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].title, 'Fix auth (v2)');

    // A fresh store bound to the same dir sees the previously-saved item.
    const b = new InboxStore();
    b.bind(dir);
    const list = b.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'ado:pr:42');
    assert.equal(list[0].title, 'Fix auth (v2)');

    // setState through the second instance is also persisted.
    b.setState('ado:pr:42', 'archived');
    const c = new InboxStore();
    c.bind(dir);
    assert.equal(c.read('ado:pr:42')?.state, 'archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('InboxStore: load() tolerates a missing file and a corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-test-'));
  try {
    // No file yet — list returns empty.
    const a = new InboxStore();
    a.bind(dir);
    assert.equal(a.list().length, 0);

    // Write garbage and confirm we don't crash.
    writeFileSync(inboxFilePath(dir), 'not json {{{');
    const b = new InboxStore();
    b.bind(dir);
    assert.equal(b.list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('InboxStore: snooze, setState, archive are persisted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-test-'));
  try {
    const store = new InboxStore();
    store.bind(dir);
    store.upsert('item-1', 'note', 'manual');
    const until = Date.now() + 60_000;
    store.snooze('item-1', until);
    const reread = new InboxStore();
    reread.bind(dir);
    const got = reread.read('item-1');
    assert.equal(got?.state, 'snoozed');
    assert.equal(got?.snoozed_until, until);

    reread.archive('item-1');
    const final = new InboxStore();
    final.bind(dir);
    assert.equal(final.read('item-1')?.state, 'archived');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
