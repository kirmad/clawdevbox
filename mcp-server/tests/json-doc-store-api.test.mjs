/**
 * json-doc-store-api.test.mjs — HTTP integration tests for /api/store/* routes
 * exposed by terminal-server.ts. Exercises the real handleHttpRequest dispatcher
 * via the in-process startTerminalServer() handle on an ephemeral port.
 *
 * The store routes need a workspace; we point them at a tmp dir via
 * CLAWDEVBOX_PROJECT_DIR (the env-var fallback in resolveStoreWorkspace).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTerminalServer } from '../src/terminal-server.ts';

let baseUrl;
let serverHandle;
let projectDir;
let prevProjectDir;

test.before(async () => {
  prevProjectDir = process.env.CLAWDEVBOX_PROJECT_DIR;
  projectDir = mkdtempSync(join(tmpdir(), 'cdb-jds-api-'));
  process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
  serverHandle = await startTerminalServer({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${serverHandle.port()}`;
});

test.after(async () => {
  await serverHandle?.close();
  rmSync(projectDir, { recursive: true, force: true });
  if (prevProjectDir === undefined) {
    delete process.env.CLAWDEVBOX_PROJECT_DIR;
  } else {
    process.env.CLAWDEVBOX_PROJECT_DIR = prevProjectDir;
  }
});

test('PUT then GET round-trip — JSON', async () => {
  const body = JSON.stringify({ hello: 'world' });
  const put = await fetch(`${baseUrl}/api/store/col_a/d1`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body,
  });
  assert.equal(put.status, 204);
  const etag = put.headers.get('etag');
  assert.ok(etag?.startsWith('"sha1:'), 'etag set');

  const get = await fetch(`${baseUrl}/api/store/col_a/d1`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'application/json');
  assert.equal(get.headers.get('etag'), etag);
  assert.equal(await get.text(), body);
});

test('PUT then GET round-trip — binary PNG', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const put = await fetch(`${baseUrl}/api/store/attach/png1`, {
    method: 'PUT', headers: { 'content-type': 'image/png' }, body: png,
  });
  assert.equal(put.status, 204);
  const get = await fetch(`${baseUrl}/api/store/attach/png1`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/png');
  const buf = new Uint8Array(await get.arrayBuffer());
  assert.deepEqual(buf, png);
});

test('GET returns 404 for missing doc', async () => {
  const r = await fetch(`${baseUrl}/api/store/col_a/missing`);
  assert.equal(r.status, 404);
});

test('PUT bad JSON returns 400', async () => {
  const r = await fetch(`${baseUrl}/api/store/col_a/bad`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.equal(r.status, 400);
});

test('PUT with invalid collection returns 400', async () => {
  const r = await fetch(`${baseUrl}/api/store/bad..name/d`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 400);
});

test('If-Match mismatch returns 412', async () => {
  await fetch(`${baseUrl}/api/store/col_b/d`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"v":1}',
  });
  const r = await fetch(`${baseUrl}/api/store/col_b/d`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': '"sha1:deadbeef"' },
    body: '{"v":2}',
  });
  assert.equal(r.status, 412);
});

test('If-Match on missing doc returns 412 (RFC 7232)', async () => {
  const r = await fetch(`${baseUrl}/api/store/col_b2/never_existed`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': '"sha1:any"' },
    body: '{}',
  });
  assert.equal(r.status, 412);
});

test('LIST returns ids', async () => {
  await fetch(`${baseUrl}/api/store/col_c/a`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  await fetch(`${baseUrl}/api/store/col_c/b`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  const r = await fetch(`${baseUrl}/api/store/col_c`);
  assert.equal(r.status, 200);
  const { ids } = await r.json();
  assert.deepEqual(ids, ['a', 'b']);
});

test('DELETE round-trip', async () => {
  await fetch(`${baseUrl}/api/store/col_d/x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  const del = await fetch(`${baseUrl}/api/store/col_d/x`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  const get = await fetch(`${baseUrl}/api/store/col_d/x`);
  assert.equal(get.status, 404);
});

test('PUT > size cap returns 413', async () => {
  const huge = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
  const r = await fetch(`${baseUrl}/api/store/col_e/big`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: huge,
  });
  assert.equal(r.status, 413);
});

test('PUT > JSON cap (inside readBody slack) hits putDoc TOO_LARGE branch', async () => {
  // JSON_DOC_MAX_BYTES = 256 KB. Build a body that is ~262200 bytes:
  // - cap = 262144
  // - cap + 1024 slack = 263168
  // - aim for cap + 100 bytes inside the window
  const padLen = 256 * 1024;  // 262144 chars of 'x' (~262144 bytes JSON-side)
  const huge = JSON.stringify({ pad: 'x'.repeat(padLen) });
  // huge.length is now padLen + 10 (the JSON wrapping bytes), which is cap + 10 — inside readBody's cap+1024 slack window.
  const r = await fetch(`${baseUrl}/api/store/col_f/big2`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: huge,
  });
  assert.equal(r.status, 413);
  const errJson = await r.json();
  assert.equal(errJson.error, 'TOO_LARGE', 'must reach putDoc cap branch (not readBody slack)');
});
