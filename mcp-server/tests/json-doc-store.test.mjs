import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDoc, putDoc, deleteDoc, listDocs, isValidId,
  JSON_DOC_MAX_BYTES, BLOB_DOC_MAX_BYTES,
} from '../src/json-doc-store.ts';

function ws() {
  return mkdtempSync(join(tmpdir(), 'cdb-jds-'));
}

test('isValidId accepts safe names', () => {
  for (const ok of ['a', 'art_abc', 'Hello.World-1_2', 'a.b.c', 'A'.repeat(128)]) {
    assert.equal(isValidId(ok), true, ok);
  }
});

test('isValidId rejects path-unsafe names', () => {
  for (const bad of ['', '.', '.hidden', 'trailing.', '..', 'a..b', 'with/slash', 'with\\back', 'a'.repeat(129), '*star', 'one two']) {
    assert.equal(isValidId(bad), false, JSON.stringify(bad));
  }
});

test('put/get round-trip — JSON', async () => {
  const dir = ws();
  try {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    const r = await putDoc(dir, 'col_a', 'doc_1', body, 'application/json', undefined);
    assert.ok('etag' in r, 'put should succeed');
    const got = await getDoc(dir, 'col_a', 'doc_1');
    assert.ok(got);
    assert.equal(got.contentType, 'application/json');
    assert.equal(got.body.toString('utf8'), body.toString('utf8'));
    assert.equal(got.etag, r.etag);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put/get round-trip — binary (PNG)', async () => {
  const dir = ws();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const r = await putDoc(dir, 'attachments', 'att_1', png, 'image/png', undefined);
    assert.ok('etag' in r);
    const got = await getDoc(dir, 'attachments', 'att_1');
    assert.ok(got);
    assert.equal(got.contentType, 'image/png');
    assert.deepEqual(got.body, png);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put rejects invalid JSON when content-type is application/json', async () => {
  const dir = ws();
  try {
    const r = await putDoc(dir, 'col_a', 'd', Buffer.from('{not json'), 'application/json', undefined);
    assert.ok('kind' in r);
    assert.equal(r.kind, 'invalid_json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put normalizes mixed-case JSON content-type and applies JSON cap + validation', async () => {
  const dir = ws();
  try {
    // Mixed-case Content-Type must still trigger JSON validation + 256 KB cap
    const r1 = await putDoc(dir, 'col_a', 'd', Buffer.from('{not json'), 'Application/JSON', undefined);
    assert.equal(r1.kind, 'invalid_json', 'Mixed-case JSON must still parse-validate');

    const huge = Buffer.from(JSON.stringify({ pad: 'x'.repeat(JSON_DOC_MAX_BYTES + 100) }), 'utf8');
    const r2 = await putDoc(dir, 'col_a', 'd2', huge, 'APPLICATION/JSON', undefined);
    assert.equal(r2.kind, 'too_large', 'Upper-case JSON must use the JSON cap');
    assert.equal(r2.cap, JSON_DOC_MAX_BYTES);

    // And the persisted content_type sidecar must be lowercased
    const r3 = await putDoc(dir, 'col_a', 'd3', Buffer.from('{"v":1}'), 'Application/JSON', undefined);
    assert.ok('etag' in r3);
    const got = await getDoc(dir, 'col_a', 'd3');
    assert.equal(got.contentType, 'application/json', 'stored content-type must be canonical lowercase');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put enforces size caps', async () => {
  const dir = ws();
  try {
    const huge = Buffer.from(JSON.stringify({ pad: 'x'.repeat(JSON_DOC_MAX_BYTES + 100) }), 'utf8');
    const r = await putDoc(dir, 'col_a', 'd', huge, 'application/json', undefined);
    assert.ok('kind' in r);
    assert.equal(r.kind, 'too_large');
    assert.equal(r.cap, JSON_DOC_MAX_BYTES);

    const bigBlob = Buffer.alloc(BLOB_DOC_MAX_BYTES + 1, 0);
    const r2 = await putDoc(dir, 'attachments', 'd', bigBlob, 'image/png', undefined);
    assert.ok('kind' in r2);
    assert.equal(r2.kind, 'too_large');
    assert.equal(r2.cap, BLOB_DOC_MAX_BYTES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put honors If-Match (optimistic concurrency)', async () => {
  const dir = ws();
  try {
    const r1 = await putDoc(dir, 'col_a', 'd', Buffer.from('{"v":1}'), 'application/json', undefined);
    assert.ok('etag' in r1);
    const bad = await putDoc(dir, 'col_a', 'd', Buffer.from('{"v":2}'), 'application/json', '"sha1:deadbeef"');
    assert.equal(bad.kind, 'etag_mismatch');
    const ok = await putDoc(dir, 'col_a', 'd', Buffer.from('{"v":2}'), 'application/json', r1.etag);
    assert.ok('etag' in ok);
    assert.notEqual(ok.etag, r1.etag);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put rejects If-Match on missing doc (RFC 7232)', async () => {
  const dir = ws();
  try {
    const r = await putDoc(dir, 'col_a', 'never_existed', Buffer.from('{}'), 'application/json', '"sha1:any"');
    assert.ok('kind' in r);
    assert.equal(r.kind, 'etag_mismatch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('put with different content-type cleans up the old body file', async () => {
  const dir = ws();
  try {
    await putDoc(dir, 'mixed', 'k', Buffer.from('{}'), 'application/json', undefined);
    const oldBody = join(dir, '.clawdevbox', 'store', 'mixed', 'k.json');
    assert.equal(existsSync(oldBody), true, 'old JSON body should exist after first put');
    await putDoc(dir, 'mixed', 'k', Buffer.from([1, 2, 3]), 'image/png', undefined);
    assert.equal(existsSync(oldBody), false, 'old JSON body should be removed after content-type change');
    const ids = await listDocs(dir, 'mixed');
    assert.deepEqual(ids, ['k']);
    const got = await getDoc(dir, 'mixed', 'k');
    assert.equal(got.contentType, 'image/png');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('delete removes both body and meta', async () => {
  const dir = ws();
  try {
    await putDoc(dir, 'col_a', 'd', Buffer.from('{}'), 'application/json', undefined);
    const ok = await deleteDoc(dir, 'col_a', 'd');
    assert.equal(ok, true);
    const got = await getDoc(dir, 'col_a', 'd');
    assert.equal(got, null);
    const ids = await listDocs(dir, 'col_a');
    assert.deepEqual(ids, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('list returns sorted ids; empty/missing collection returns []', async () => {
  const dir = ws();
  try {
    assert.deepEqual(await listDocs(dir, 'fresh'), []);
    await putDoc(dir, 'fresh', 'c', Buffer.from('{}'), 'application/json', undefined);
    await putDoc(dir, 'fresh', 'a', Buffer.from('{}'), 'application/json', undefined);
    await putDoc(dir, 'fresh', 'b', Buffer.from('{}'), 'application/json', undefined);
    assert.deepEqual(await listDocs(dir, 'fresh'), ['a', 'b', 'c']);
    assert.equal(await listDocs(dir, '..'), null);  // invalid collection
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects invalid ids', async () => {
  const dir = ws();
  try {
    const r = await putDoc(dir, '..bad', 'd', Buffer.from('{}'), 'application/json', undefined);
    assert.equal(r.kind, 'invalid_id');
    const g = await getDoc(dir, 'col', 'with/slash');
    assert.equal(g, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
