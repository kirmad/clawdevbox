import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectObservations } from '../src/trigger-runner.ts';

function tmp() { return mkdtempSync(join(tmpdir(), 'cdb-obs-')); }

test('collectObservations returns empty for a missing dir', () => {
  const r = collectObservations(join(tmpdir(), 'cdb-obs-does-not-exist-xyz-123'));
  assert.deepEqual(r.observations, []);
  assert.equal(r.truncated, false);
});

test('collectObservations captures nested files in deterministic sorted order', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'nested'), { recursive: true });
    writeFileSync(join(d, 'observation.json'), JSON.stringify({ hello: 'world' }));
    writeFileSync(join(d, 'nested', 'note.txt'), 'deep');
    writeFileSync(join(d, 'a.txt'), 'alpha');
    const r = collectObservations(d);
    // Deterministic, sorted, forward-slash relative paths.
    assert.deepEqual(r.observations.map((o) => o.path), ['a.txt', 'nested/note.txt', 'observation.json']);
    const top = r.observations.find((o) => o.path === 'observation.json');
    assert.equal(top.encoding, 'utf8');
    assert.equal(top.truncated, false);
    assert.equal(top.bytes, Buffer.byteLength(JSON.stringify({ hello: 'world' })));
    assert.equal(JSON.parse(top.content).hello, 'world');
    assert.equal(r.truncated, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('collectObservations base64-encodes binary files', () => {
  const d = tmp();
  try {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    writeFileSync(join(d, 'blob.bin'), bin);
    const r = collectObservations(d);
    const e = r.observations[0];
    assert.equal(e.encoding, 'base64');
    assert.equal(Buffer.from(e.content, 'base64').equals(bin), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('collectObservations truncates oversized files and flags truncated', () => {
  const d = tmp();
  try {
    const big = 'x'.repeat(200 * 1024);
    writeFileSync(join(d, 'big.txt'), big);
    const r = collectObservations(d, { maxFileBytes: 1024 });
    const e = r.observations[0];
    assert.equal(e.truncated, true);
    assert.equal(e.bytes, 200 * 1024);
    assert.ok(Buffer.byteLength(e.content, 'utf8') <= 1024);
    assert.equal(r.truncated, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('collectObservations does NOT follow symlinks (path-traversal safe)', () => {
  const d = tmp();
  const outside = tmp();
  try {
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    writeFileSync(join(d, 'real.txt'), 'ok');
    let linked = false;
    try { symlinkSync(join(outside, 'secret.txt'), join(d, 'link.txt')); linked = true; }
    catch { /* symlink creation may require privilege on Windows; skip link assertions */ }
    const r = collectObservations(d);
    const paths = r.observations.map((o) => o.path);
    assert.ok(paths.includes('real.txt'));
    // The secret behind the symlink must never be read.
    assert.equal(r.observations.some((o) => o.content === 'SECRET'), false);
    if (linked) {
      assert.equal(paths.includes('link.txt'), false, 'symlink must not be captured');
      assert.equal(r.truncated, true);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('collectObservations caps the number of files and flags truncated', () => {
  const d = tmp();
  try {
    for (let i = 0; i < 10; i++) writeFileSync(join(d, `f${i}.txt`), String(i));
    const r = collectObservations(d, { maxFiles: 3 });
    assert.equal(r.observations.length, 3);
    assert.equal(r.truncated, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
