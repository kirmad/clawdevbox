// mcp-server/tests/cli-sessions/tmux-session-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTmuxSessionRuntime } from '../../src/cli-sessions/tmux-session-runtime.ts';
import { tmuxRun } from '../../src/cli-sessions/tmux-client.ts';

function findShell() {
  const probes = ['sh', 'sh.exe', 'bash', 'bash.exe', '/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe'];
  for (const c of probes) {
    const r = spawnSync(c, ['-c', 'echo OK'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'OK') return c;
  }
  return null;
}
const SHELL = findShell();

function makeRuntime() {
  const c = { socket: 'cdb-rt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), configPath: null };
  return { client: c, runtime: createTmuxSessionRuntime(c) };
}

function cleanup(c) { try { tmuxRun(c, ['kill-server']); } catch {} }

test('spawn creates a session and list returns it', async () => {
  if (!SHELL) { console.warn('skip: no shell'); return; }
  const { client, runtime } = makeRuntime();
  try {
    const s = await runtime.spawn({
      name: 'rt_a',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-rt-')),
      env: {}, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'sleep 30'],
    });
    const items = await runtime.list();
    assert.ok(items.find((x) => x.name === 'cdb_rt_a' && x.alive),
      `expected cdb_rt_a in list, got ${JSON.stringify(items)}`);
    await s.kill();
  } finally { cleanup(client); }
});

test('attach returns null for a missing session', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const s = await runtime.attach('nonexistent_session_xyz');
    assert.equal(s, null);
  } finally { cleanup(client); }
});

test('attach returns a working CliSession for an existing session', async () => {
  if (!SHELL) { console.warn('skip: no shell'); return; }
  const { client, runtime } = makeRuntime();
  try {
    const original = await runtime.spawn({
      name: 'rt_b',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-rt-')),
      env: {}, cols: 80, rows: 24,
      command: 'cat', args: [],
    });
    const adopted = await runtime.attach('rt_b');
    assert.ok(adopted, 'expected non-null adopted session');
    assert.equal(adopted.name, 'cdb_rt_b');
    await adopted.sendText('FROM_ADOPTED');
    await new Promise((r) => setTimeout(r, 200));
    const snap = await adopted.snapshot();
    assert.match(snap, /FROM_ADOPTED/);
    await original.kill();
  } finally { cleanup(client); }
});

test('list returns empty array on a fresh server', async () => {
  const { client, runtime } = makeRuntime();
  try {
    const items = await runtime.list();
    // Either no entries OR entries but none with cdb_ prefix (server may not exist yet at all)
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 0);
  } finally { cleanup(client); }
});
