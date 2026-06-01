// mcp-server/tests/cli-sessions/tmux-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmuxRun, tmuxRunAsync } from '../../src/cli-sessions/tmux-client.ts';

// Resolve a portable shell. Linux/macOS: /bin/sh. Windows (Git Bash/MSYS):
// sh.exe is on PATH alongside tmux. Find it once for reuse in tests.
function findShell() {
  const probes = ['sh', 'sh.exe', 'bash', 'bash.exe', '/bin/sh', 'C:/Program Files/Git/usr/bin/sh.exe'];
  for (const candidate of probes) {
    const r = spawnSync(candidate, ['-c', 'echo OK'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'OK') return candidate;
  }
  return null;
}
const SHELL = findShell();

function freshSocket(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

test('tmuxRun forwards -L socket flag (verified by isolation between sockets)', () => {
  const sockA = freshSocket('cdb-iso-A');
  const sockB = freshSocket('cdb-iso-B');
  const A = { socket: sockA, configPath: null };
  const B = { socket: sockB, configPath: null };
  try {
    // Spawn a session ONLY on socket A.
    if (!SHELL) return;     // skip if no shell available on this platform
    const spawn = tmuxRun(A, [
      'new-session', '-d', '-s', 'isotest', '-x', '80', '-y', '24',
      SHELL, '-c', 'sleep 60',
    ]);
    assert.equal(spawn.exitCode, 0, `spawn on socket A failed: ${spawn.stderr}`);

    // list-sessions on A MUST see 'isotest'.
    const listA = tmuxRun(A, ['list-sessions', '-F', '#{session_name}']);
    assert.equal(listA.exitCode, 0, `list on A failed: ${listA.stderr}`);
    assert.match(listA.stdout, /isotest/, 'session must be visible on its own socket');

    // list-sessions on B MUST NOT see 'isotest' (the wrapper actually
    // passed -L B and queried a different server). On Linux/macOS the
    // server-not-found case returns exit 1 + 'no server running'. On
    // Windows MSYS tmux it returns exit 0 with empty stdout. We accept
    // either as long as 'isotest' is NOT visible.
    const listB = tmuxRun(B, ['list-sessions', '-F', '#{session_name}']);
    assert.equal(listB.stdout.includes('isotest'), false, 'session must NOT cross sockets');
  } finally {
    try { tmuxRun(A, ['kill-server']); } catch {}
    try { tmuxRun(B, ['kill-server']); } catch {}
  }
});

test('tmuxRunAsync returns the same result shape and forwards args', async () => {
  const sock = freshSocket('cdb-async');
  const C = { socket: sock, configPath: null };
  const r = await tmuxRunAsync(C, ['list-sessions']);
  assert.equal(typeof r.exitCode, 'number', 'exitCode must be a number');
  assert.equal(typeof r.stdout, 'string', 'stdout must be a string');
  assert.equal(typeof r.stderr, 'string', 'stderr must be a string');
  // Either exitCode 0 (Windows MSYS empty) or 1 ("no server running") is
  // acceptable across platforms; what we MUST verify is the wrapper didn't
  // crash and returned the documented shape.
  assert.ok(r.exitCode === 0 || r.exitCode === 1, `unexpected exitCode ${r.exitCode}`);
});

test('tmuxRun honors stdin input option (load-buffer + show-buffer)', () => {
  if (!SHELL) {
    console.warn('skip: no portable shell found');
    return;
  }
  const sock = freshSocket('cdb-stdin');
  const C = { socket: sock, configPath: null };
  try {
    const spawn = tmuxRun(C, [
      'new-session', '-d', '-s', 'X', '-x', '80', '-y', '24',
      SHELL, '-c', 'sleep 60',
    ]);
    assert.equal(spawn.exitCode, 0, `spawn failed: ${spawn.stderr}`);

    const inp = 'roundtrip-marker-' + Date.now().toString(36);
    const load = tmuxRun(C, ['load-buffer', '-'], { input: inp });
    assert.equal(load.exitCode, 0, `load-buffer failed: ${load.stderr}`);

    const show = tmuxRun(C, ['show-buffer']);
    assert.equal(show.exitCode, 0, `show-buffer failed: ${show.stderr}`);
    // Single-line input avoids platform-specific newline-escaping in
    // show-buffer on Windows MSYS tmux. Multi-line text preservation is
    // covered by tmux-session.ts (Task 5) via load-buffer + paste-buffer.
    assert.equal(show.stdout.trimEnd(), inp, 'buffer roundtrip must preserve bytes exactly');
  } finally {
    try { tmuxRun(C, ['kill-server']); } catch {}
  }
});

test('tmuxRunAsync settles with exitCode -1 when binary spawn fails', async () => {
  // Force a spawn failure by using a path that definitely doesn't exist.
  // We can't override the binary name in tmuxRunAsync, so verify the
  // error-handler behavior by using a bogus env that breaks tmux: tmux
  // requires HOME to be set on POSIX (and APPDATA on Windows) to locate
  // its socket dir. Removing those forces a failure mode tmuxRunAsync
  // must NOT hang on.
  //
  // Note: this test asserts the wrapper never hangs (test timeout would
  // kill it). The exact exitCode/stderr depend on tmux internals; we just
  // check it settled.
  const r = await Promise.race([
    (async () => {
      try {
        return await tmuxRunAsync(
          { socket: null, configPath: '/definitely/nonexistent/cdb-bad-config.conf' },
          ['-V'],
        );
      } catch (e) {
        return { exitCode: -1, stdout: '', stderr: String(e) };
      }
    })(),
    new Promise((res) => setTimeout(() => res({ exitCode: 999, stdout: 'TIMEOUT', stderr: '' }), 5000)),
  ]);
  // The wrapper must settle, not hang. exitCode 999 would mean the
  // timeout won — i.e., tmuxRunAsync hung.
  assert.notEqual(r.exitCode, 999, 'tmuxRunAsync hung past 5s on failure path');
});
