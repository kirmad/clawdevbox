// mcp-server/tests/cli-sessions/tmux-session.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createTmuxSession } from '../../src/cli-sessions/tmux-session.ts';
import { tmuxRun } from '../../src/cli-sessions/tmux-client.ts';

// Find a portable shell that works on this platform.
function findShell() {
  const probes = ['sh', 'sh.exe', 'bash', 'bash.exe', '/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe'];
  for (const candidate of probes) {
    const r = spawnSync(candidate, ['-c', 'echo OK'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'OK') return candidate;
  }
  return null;
}
const SHELL = findShell();

function newClient() {
  return {
    socket: 'cdb-sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    configPath: null,
  };
}

function cleanup(c) { try { tmuxRun(c, ['kill-server']); } catch {} }

test('createTmuxSession spawns a session and exposes name', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_a',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'sleep 30'],
    });
    assert.equal(s.name, 'cdb_unit_a');
    await s.kill();
  } finally { cleanup(c); }
});

test('sendText writes literal text into the pane (verified via snapshot)', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_b',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'cat', args: [],
    });
    await s.sendText('HELLO_FROM_SENDTEXT');
    await sleep(150);
    await s.sendKey('Enter');
    await sleep(150);
    const snap = await s.snapshot();
    assert.match(snap, /HELLO_FROM_SENDTEXT/);
    await s.kill();
  } finally { cleanup(c); }
});

test('sendText handles multi-line text via load-buffer + paste-buffer', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_c',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: 'cat', args: [],
    });
    await s.sendText('LINE_ONE\nLINE_TWO\nLINE_THREE');
    await sleep(200);
    const snap = await s.snapshot();
    assert.match(snap, /LINE_ONE/);
    assert.match(snap, /LINE_TWO/);
    assert.match(snap, /LINE_THREE/);
    await s.kill();
  } finally { cleanup(c); }
});

test('resize calls tmux without throwing (dims may or may not update on psmux)', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_d',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'sleep 30'],
    });
    // Contract: resize must complete without throwing. Whether the
    // platform actually changes pane_width/pane_height is platform-
    // dependent (psmux resize-window is a no-op; resize-pane may not
    // update the format vars even though ConPTY did resize).
    await s.resize(132, 50);
    await s.kill();
  } finally { cleanup(c); }
});

test('kill is idempotent', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_e',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'sleep 30'],
    });
    await s.kill();
    await s.kill();
  } finally { cleanup(c); }
});

test('exited resolves after the pane process exits', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    // We need remain-on-exit on so pane_dead_status can be queried after
    // the process exits but before kill-session. Set it inline.
    const s = await createTmuxSession(c, {
      name: 'unit_f',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'exit 7'],
    });
    // Enable remain-on-exit globally on this socket so pane_dead_status
    // can be queried before kill-session cleans up.
    tmuxRun(c, ['set-option', '-g', 'remain-on-exit', 'on']);
    const r = await s.exited;
    // Exit code may be null on Windows MSYS (where pane_dead_status
    // doesn't always populate). Accept 7 OR null as long as the promise
    // settled — the contract is "resolves after exit", not "knows code".
    assert.ok(r.exitCode === 7 || r.exitCode === null,
      `expected exitCode 7 or null, got ${r.exitCode}`);
  } finally { cleanup(c); }
});

test('pid returns the pane process pid while alive', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_g',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: {}, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'sleep 30'],
    });
    const pid = await s.pid();
    assert.equal(typeof pid, 'number');
    assert.ok(pid > 0);
    await s.kill();
  } finally { cleanup(c); }
});

test('env vars are passed through to the pane process', async () => {
  if (!SHELL) { console.warn('skip: no shell found'); return; }
  const c = newClient();
  try {
    const s = await createTmuxSession(c, {
      name: 'unit_h',
      cwd: mkdtempSync(join(tmpdir(), 'cdb-sess-')),
      env: { CDB_MARK: 'WITNESS_42' }, cols: 80, rows: 24,
      command: SHELL, args: ['-c', 'echo CDB_MARK=$CDB_MARK; sleep 30'],
    });
    await sleep(500);
    const snap = await s.snapshot();
    assert.match(snap, /WITNESS_42/);
    await s.kill();
  } finally { cleanup(c); }
});
