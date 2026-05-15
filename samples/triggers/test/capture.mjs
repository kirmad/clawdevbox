// capture.mjs — full end-to-end demo of the Mode B comment-watcher trigger
// against real ADO. Spins up mock-clawdevbox locally so the script has a real
// /callback/* endpoint to POST to during the run, then prints:
//   1. the STDIN envelope piped to the script
//   2. the script's STDOUT and STDERR
//   3. its exit code
//   4. the live Mode B callbacks that mock-clawdevbox captured during the run
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'test-config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 1. Boot mock-clawdevbox and wait for its READY banner.
// ---------------------------------------------------------------------------

const mockPath = join(here, 'mock-clawdevbox.ts');
const mock = spawn('npx', ['--yes', 'tsx', mockPath], {
  cwd: here,
  env: { ...process.env },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let mockStdoutBuf = '';
let mockStderrBuf = '';
mock.stdout.on('data', (chunk) => { mockStdoutBuf += chunk.toString('utf8'); });
mock.stderr.on('data', (chunk) => { mockStderrBuf += chunk.toString('utf8'); });

let killed = false;
function killMock() {
  if (killed) return;
  killed = true;
  try {
    if (process.platform === 'win32') {
      // Use taskkill to terminate the whole tree (npx → tsx → node).
      spawnSync('taskkill', ['/PID', String(mock.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      mock.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }
}
process.on('exit', killMock);
process.on('SIGINT', () => { killMock(); process.exit(130); });
process.on('SIGTERM', () => { killMock(); process.exit(143); });

// Wait up to 30s for "MOCK_CLAWDEVBOX_READY <port> <secret>" on stdout.
const readyDeadline = Date.now() + 30_000;
let port = '';
let secret = '';
while (Date.now() < readyDeadline) {
  const m = mockStdoutBuf.match(/MOCK_CLAWDEVBOX_READY (\d+) (\S+)/);
  if (m) {
    port = m[1];
    secret = m[2];
    break;
  }
  if (mock.exitCode !== null) {
    console.error('mock-clawdevbox exited before ready:');
    console.error(mockStdoutBuf);
    console.error(mockStderrBuf);
    process.exit(1);
  }
  await delay(100);
}
if (!port || !secret) {
  console.error('Timed out waiting for mock-clawdevbox READY banner.');
  console.error('mock stdout:\n' + mockStdoutBuf);
  console.error('mock stderr:\n' + mockStderrBuf);
  killMock();
  process.exit(1);
}

const baseUrl = `http://127.0.0.1:${port}`;
const callbackPath = '/callback/threads/thr_DEMO/resume';
const callbackUrl = `${baseUrl}${callbackPath}`;

// ---------------------------------------------------------------------------
// 2. Build envelope and run the trigger.
// ---------------------------------------------------------------------------

const envelope = {
  trigger_event_name: 'TriggerFired',
  trigger_id: 'demo-capture',
  run_id: `capture-${Date.now()}`,
  fired_by: 'cron',
  fired_at: Date.now(),
  cwd: here,
  project_dir: here,
  trigger_data_dir: join(here, '.clawdevbox/triggers/demo-capture/data'),
  subscriber_thread_id: 'thr_DEMO',
  callback_url: callbackUrl,
  state: {
    prId: cfg.pr_id,
    repo: cfg.repo,
    lastCommentId: 0,
    selfUser: '',  // empty so the comment we posted as kirmadi@microsoft.com is NOT skipped as self
  },
  payload: null,
};

console.log('================ STDIN (envelope piped to script) ================');
console.log(JSON.stringify(envelope, null, 2));
console.log('');

const triggerScript = resolve(here, '..', 'ado-comment-watcher.ts');

const result = spawnSync('npx', ['--yes', 'tsx', triggerScript], {
  input: JSON.stringify(envelope),
  encoding: 'utf8',
  env: {
    ...process.env,
    ADO_ORG: cfg.trigger_ado_org,
    ADO_BEARER_TOKEN: cfg.ado_bearer_token,
    CLAWDEVBOX_MCP_URL: `${baseUrl}/mcp`,
    CLAWDEVBOX_MCP_SECRET: secret,
  },
  shell: true,
});

console.log('================ STDOUT (response from script) ================');
if (result.stdout) {
  try {
    const parsed = JSON.parse(result.stdout);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log('(not valid JSON)');
    console.log(result.stdout);
  }
} else {
  console.log('(empty)');
}

console.log('');
console.log('================ STDERR ================');
console.log(result.stderr || '(empty)');

console.log('');
console.log('================ Exit code ================');
console.log(result.status);

// ---------------------------------------------------------------------------
// 3. Fetch /test/received-callbacks to show the live Mode B POSTs.
// ---------------------------------------------------------------------------

console.log('');
console.log('================ Mode B live POSTs captured by mock-clawdevbox ================');
try {
  const res = await fetch(`${baseUrl}/test/received-callbacks`);
  if (!res.ok) {
    console.log(`(fetch failed: HTTP ${res.status})`);
  } else {
    const { callbacks } = await res.json();
    if (!Array.isArray(callbacks) || callbacks.length === 0) {
      console.log('(none — script returned no callbacks)');
    } else {
      console.log(`Captured ${callbacks.length} callback(s):`);
      const t0 = callbacks[0].receivedAt;
      for (const cb of callbacks) {
        const dt = ((cb.receivedAt - t0) / 1000).toFixed(2);
        const ctx = cb.body?.context ?? {};
        console.log(
          `  +${dt.padStart(5, ' ')}s  [${cb.delivered_via}]  path=${cb.path}  ` +
            `kind=${ctx.kind ?? '?'}  comment_id=${ctx.comment_id ?? '?'}`,
        );
      }
      console.log('');
      console.log('First callback body (full):');
      console.log(JSON.stringify(callbacks[0].body, null, 2));
    }
  }
} catch (err) {
  console.log(`(fetch error: ${err?.message ?? err})`);
}

// ---------------------------------------------------------------------------
// 4. Tear down mock-clawdevbox.
// ---------------------------------------------------------------------------
killMock();
process.exit(result.status ?? 0);
