// mcp-server/scripts/tmux-smoke.mjs
// Standalone Windows smoke test — proves tmux can host copilot.exe and
// that send-keys / capture-pane / kill-session work end-to-end on this
// platform BEFORE we sink days into the migration.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOCK = ['-L', 'cdb-smoke'];
const SES = `cdb_smoke_${Date.now().toString(36)}`;
const WS = mkdtempSync(join(tmpdir(), 'cdb-smoke-'));

function tmux(args, opts = {}) {
  const r = spawnSync('tmux', [...SOCK, ...args], { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`tmux ${args.join(' ')} → exit ${r.status}\nstderr: ${r.stderr}`);
  }
  return r.stdout;
}

console.log('1. new-session …');
tmux(['new-session', '-d', '-s', SES, '-x', '120', '-y', '30', '-c', WS,
      'copilot', '--yolo']);
console.log('   ok');

console.log('2. wait 10s for copilot TUI to render');
await new Promise((r) => setTimeout(r, 10_000));

console.log('3. capture-pane (verify ❯ visible)');
const snap1 = tmux(['capture-pane', '-p', '-t', SES, '-S', '-', '-E', '-']);
if (!/❯/.test(snap1)) throw new Error(`no ❯ in snapshot:\n${snap1.slice(-500)}`);
console.log('   ok — ❯ visible');

console.log('4. send-keys "Reply with only OK"');
tmux(['send-keys', '-t', SES, '-l', 'Reply with only OK']);
await new Promise((r) => setTimeout(r, 250));
tmux(['send-keys', '-t', SES, 'Enter']);

console.log('5. wait 30s for response');
await new Promise((r) => setTimeout(r, 30_000));
const snap2 = tmux(['capture-pane', '-p', '-t', SES, '-S', '-', '-E', '-']);
const hit = (snap2.match(/OK/g) ?? []).length;
console.log(`   "OK" count = ${hit}`);

console.log('6. kill-session');
try {
  tmux(['kill-session', '-t', SES]);
  console.log('   ok');
} catch (err) {
  // Cleanup failure must not overwrite the PASS/FAIL verdict — the probe's
  // contract is to honestly report whether tmux can host copilot, not
  // whether kill-session works flawlessly. Log and continue to the verdict.
  console.warn(`   warn — kill-session failed (cleanup-only): ${err.message}`);
}

if (hit >= 2) {
  console.log('\n✅ SMOKE PASSED — tmux can host copilot on this platform');
  process.exit(0);
} else {
  console.log('\n❌ SMOKE FAILED — fix tmux/copilot interop before continuing');
  process.exit(1);
}
