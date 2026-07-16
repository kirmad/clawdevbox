import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  registerPty,
  readScrollback,
  killPty,
  _resetForTests,
} from '../src/pty-registry.ts';

function makeFakeIPty() {
  const ee = new EventEmitter();
  return {
    pid: 12345, cols: 80, rows: 24, process: 'fake',
    onData: (cb) => { ee.on('data', cb); return { dispose: () => ee.off('data', cb) }; },
    onExit: (cb) => { ee.on('exit', cb); return { dispose: () => ee.off('exit', cb) }; },
    write: () => {}, resize: () => {}, kill: () => { ee.emit('exit', { exitCode: 0 }); },
    clear: () => {}, pause: () => {}, resume: () => {},
    _emit: (chunk) => ee.emit('data', chunk),
    _emitExit: (code) => ee.emit('exit', { exitCode: code }),
  };
}

test('readScrollback: returns full buffer + monotonic offset', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  ipty._emit('hello');
  ipty._emit(' world');
  const r = readScrollback('i1', { since: 0 });
  assert.equal(r.content, 'hello world');
  assert.equal(r.totalOffset, 11);
  assert.equal(r.headOffset, 0);
  assert.equal(r.exited, false);
});

test('readScrollback: incremental read with cursor', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  ipty._emit('AAA');
  const r1 = readScrollback('i1', { since: 0 });
  assert.equal(r1.totalOffset, 3);
  ipty._emit('BBB');
  const r2 = readScrollback('i1', { since: r1.totalOffset });
  assert.equal(r2.content, 'BBB');
  assert.equal(r2.totalOffset, 6);
});

test('readScrollback: since below head_offset reports head advance', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 5; i++) ipty._emit(chunk);
  const r = readScrollback('i1', { since: 0 });
  assert.ok(r.headOffset > 0, `expected headOffset > 0, got ${r.headOffset}`);
  assert.equal(r.totalOffset, 5 * 64 * 1024);
  assert.equal(r.content.length, r.totalOffset - r.headOffset);
});

test('readScrollback: spawnTs differs after kill + re-register', async () => {
  _resetForTests();
  const ipty1 = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty: ipty1 });
  const meta1 = readScrollback('i1', { since: 0 });
  ipty1._emitExit(0);
  _resetForTests();
  await new Promise((r) => setTimeout(r, 5));
  const ipty2 = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty: ipty2 });
  const meta2 = readScrollback('i1', { since: 0 });
  assert.notEqual(meta2.spawnTs, meta1.spawnTs);
});

test('readScrollback: returns null for unknown instance', () => {
  _resetForTests();
  assert.equal(readScrollback('nope', { since: 0 }), null);
});

test('readScrollback: reports exited + exitCode', () => {
  _resetForTests();
  const ipty = makeFakeIPty();
  registerPty({ instanceId: 'i1', workspaceId: 'w1', cols: 80, rows: 24, ipty });
  ipty._emit('done');
  ipty._emitExit(42);
  const r = readScrollback('i1', { since: 0 });
  assert.equal(r.exited, true);
  assert.equal(r.exitCode, 42);
  assert.equal(r.content, 'done');
});
