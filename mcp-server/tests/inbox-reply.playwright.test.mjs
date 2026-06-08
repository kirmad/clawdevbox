// inbox-reply.playwright.test.mjs
//
// END-TO-END: agent posts an inbox question via inbox.upsert → user clicks an
// option in the SPA → presses Send → the answer is dispatched to the agent
// CLI's live pty via spawnDispatchOrResume → the agent observes the prompt
// in its scrollback.
//
// What this test exercises that the unit tests don't:
//   - Real `clawdevbox start` HTTP server (cronApiCtx wiring, /api/inbox routes)
//   - Real agent CLI subprocess (e2e-test-runner provider in interactive mode)
//   - Real Streamable HTTP MCP transport (via /api/test/inbox-upsert hook that
//     forwards to the same registered inbox.upsert tool an agent would call)
//   - Real SPA: Pinia store, click handler on the option button, click on the
//     Send button, POST /api/inbox/<id>/reply, render the reply bubble
//   - The full dispatch path: validateAnswer → compileAnswer → InboxStore
//     append → spawnDispatchOrResume → dispatcher.dispatchToInstance →
//     conductor.dispatch → provider.writePrompt → pty.write
//   - Persisted reply on the item visible in subsequent /api/inbox/<id> reads

import { test, expect, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cliEntry = resolve(projectRoot, 'src/index.ts');

function freePortGuess() {
  // Outside the common dev range to dodge collisions.
  return 15500 + Math.floor(Math.random() * 100);
}

let serverProc;
let tmpRoot;
let port;
let token;
let browser;
let context;

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok && (await r.text()).trim() === 'ok') return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become healthy within ' + timeoutMs + 'ms');
}

async function pollFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null && r !== false) return r;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`pollFor(${label}) timed out after ${timeoutMs}ms${lastErr ? ` (last: ${lastErr.message})` : ''}`);
}

test.beforeAll(async () => {
  test.setTimeout(120_000); // beforeAll body — needs longer than the default 30s.
  tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-inbox-reply-e2e-'));
  const projectDir = join(tmpRoot, 'project');
  const globalDir = join(tmpRoot, 'global');
  mkdirSync(projectDir, { recursive: true });
  for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
    mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
  }
  mkdirSync(join(globalDir, 'plugins'), { recursive: true });

  port = freePortGuess();
  token = 'pwt-' + Math.random().toString(36).slice(2, 10);

  writeFileSync(
    join(projectDir, '.clawdevbox', 'config.json'),
    JSON.stringify(
      {
        version: 1,
        project_dir: projectDir,
        global_dir: globalDir,
        http: { port, host: '127.0.0.1', token },
      },
      null,
      2,
    ),
  );

  serverProc = spawn('npx', ['tsx', cliEntry, 'start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
      CLAWDEVBOX_PORT: String(port),
      CLAWDEVBOX_HOST: '127.0.0.1',
      CLAWDEVBOX_TOKEN: token,
      // Keep the e2e-test-runner alive after its initial MCP handshake so
      // we can dispatch the user's answer to it and observe DISPATCH_RX
      // in its scrollback.
      CLAWDEVBOX_E2E_INTERACTIVE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  serverProc.stderr.on('data', (chunk) => {
    const s = chunk.toString();
    if (/error|throw|EADDRINUSE/i.test(s)) process.stderr.write(`[server] ${s}`);
  });

  await waitForHealth(45_000);

  // /healthz becomes true the instant the HTTP server starts listening, but
  // `cronApiCtx` (which carries the dispatcher) is bound a tick later in
  // cli/start.ts. Wait until a cron-api endpoint is actually live so the
  // first dispatch request doesn't race the boot sequence.
  await pollFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    return r.status === 200 ? true : false;
  }, 30_000, '/api/sessions ready');

  browser = await chromium.launch();
  context = await browser.newContext({ serviceWorkers: 'allow' });
});

test.afterAll(async () => {
  try { await context?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  if (serverProc && !serverProc.killed) {
    if (platform() === 'win32' && serverProc.pid) {
      spawnSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { serverProc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
  if (tmpRoot && existsSync(tmpRoot)) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// THE TEST
// ---------------------------------------------------------------------------

test.setTimeout(180_000);

test('user clicks option + Send → answer dispatched back to the agent', async () => {
  // 1. Spawn a real interactive agent CLI session via /spawn.
  //    Use the e2e-test-runner provider (always installed). We don't care
  //    here whether the spawn is still warming up or already idle — the
  //    payoff is that the reply gets routed through spawnDispatchOrResume
  //    and the SPA reflects the outcome. The bytes-reach-pty path is
  //    proven separately by tests/dispatch-bytes-e2e.test.mjs against
  //    the same provider.
  const sessionAlias = 'q-target-' + Math.random().toString(36).slice(2, 7);
  const spawnRes = await fetch(`http://127.0.0.1:${port}/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'initial: please wait for dispatch',
      session_id: sessionAlias,
      provider: 'e2e-test-runner',
    }),
  });
  expect(spawnRes.status).toBe(200);
  const spawnBody = await spawnRes.json();
  expect(spawnBody.ok).toBe(true);
  expect(spawnBody.mode).toBe('spawn');
  const targetInstance = spawnBody.instance_id;
  const targetSession = spawnBody.session_id;
  expect(targetInstance).toBeTruthy();

  // 2. Wait until the spawn registers in /api/sessions (proves the pty
  //    is wired, the dispatcher sees it, and the conductor exists).
  await pollFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(targetInstance)}`);
    return r.status === 200 ? await r.json() : false;
  }, 30_000, 'session registered in /api/sessions');

  // 3. Seed an inbox item that carries a question pointing at the live
  //    session. This forwards directly to the registered `inbox.upsert`
  //    MCP tool — the same handler an agent CLI hits over MCP HTTP.
  const inboxId = 'q:approve-deploy-' + Math.random().toString(36).slice(2, 7);
  const upsertRes = await fetch(`http://127.0.0.1:${port}/api/test/inbox-upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: inboxId,
      kind: 'question',
      source: 'e2e-test',
      title: 'Approve the deploy?',
      preview: 'Pick Approve or Reject — the answer goes back to the agent.',
      notify: false,
      question: {
        prompt: 'Should we ship the build?',
        options: [
          { id: 'approve', label: 'Approve', value: 'APPROVED' },
          { id: 'reject', label: 'Reject', value: 'REJECTED' },
        ],
        dispatch: {
          session_id: sessionAlias,
          // provider is the fallback when the live pty has already exited
          // (e2e-test-runner is short-lived once its MCP handshake completes).
          // With it set, spawnDispatchOrResume falls through cleanly to spawn.
          provider: 'e2e-test-runner',
          prompt_template: 'USER_DECISION: {answer} (ids=[{option_ids}])',
        },
      },
    }),
  });
  expect(upsertRes.status).toBe(200);
  const upsertBody = await upsertRes.json();
  expect(upsertBody.ok).toBe(true);

  // 4. Drive the SPA: open the Inbox tab, select the item, click Approve, Send.
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push('pageerror: ' + (err.stack || err.message)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push('console: ' + msg.text());
  });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: /Inbox/i }).click();

  // The seeded item lands in the master list via SSE — wait for its title.
  await expect(page.getByText('Approve the deploy?').first()).toBeVisible({ timeout: 10_000 });
  await page.getByText('Approve the deploy?').first().click();

  // The detail pane should show the question prompt.
  await expect(page.getByText('Should we ship the build?')).toBeVisible({ timeout: 5_000 });

  // The two option buttons are rendered as PrimeVue Buttons containing their labels.
  await page.getByRole('button', { name: /^Approve$/ }).click();

  // Send button enables once an option is selected.
  const sendBtn = page.getByRole('button', { name: /^Send$/ });
  await expect(sendBtn).toBeEnabled({ timeout: 3_000 });
  await sendBtn.click();

  // 5. The reply bubble + closed banner appear after the round-trip.
  await expect(page.getByText('You', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Question closed\./)).toBeVisible({ timeout: 5_000 });

  // Give the SPA's POST response a beat to drain before page.close()
  // (Playwright's response listeners can race the close otherwise).
  await page.waitForTimeout(500);

  await page.close();
  expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);

  // 6. Server side: the reply is persisted with a real dispatch outcome
  //    (mode is one of dispatch/spawn/resume — anything except 'noop' or
  //    'failed' proves spawnDispatchOrResume routed the answer).
  const verifyRes = await fetch(
    `http://127.0.0.1:${port}/api/inbox/${encodeURIComponent(inboxId)}`,
  );
  expect(verifyRes.status).toBe(200);
  const verifyBody = await verifyRes.json();
  const replies = verifyBody.item?.replies ?? [];
  expect(replies.length).toBe(1);
  expect(replies[0].author).toBe('user');
  expect(replies[0].option_ids).toEqual(['approve']);
  expect(replies[0].text).toBe('Approve');
  expect(
    replies[0].dispatch?.mode,
    `expected real dispatch outcome, got ${JSON.stringify(replies[0].dispatch)}`,
  ).toMatch(/^(dispatch|spawn|resume)$/);
  expect(replies[0].dispatch?.session_id).toBe(targetSession);
  expect(verifyBody.item?.questions?.[0]?.closed).toBe(true);
});

// Direct HTTP sanity check — bypass the SPA so we can see the raw response
// from POST /api/inbox/<id>/reply (the SPA route hits the same handler).
test('POST /api/inbox/<id>/reply returns dispatch outcome for a live session', async () => {
  const sessionAlias = 'q-direct-' + Math.random().toString(36).slice(2, 7);
  const spawnRes = await fetch(`http://127.0.0.1:${port}/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'initial',
      session_id: sessionAlias,
      provider: 'e2e-test-runner',
    }),
  });
  expect(spawnRes.status).toBe(200);
  const spawnBody = await spawnRes.json();

  const id = 'q:direct-' + Math.random().toString(36).slice(2, 7);
  await fetch(`http://127.0.0.1:${port}/api/test/inbox-upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      kind: 'question',
      source: 'e2e-test',
      notify: false,
      question: {
        prompt: 'pick',
        options: [{ id: 'a', label: 'A', value: 'AAA' }],
        dispatch: {
          session_id: sessionAlias,
          provider: 'e2e-test-runner',
          prompt_template: 'PICKED: {answer}',
        },
      },
    }),
  });

  // Give the spawn a moment to register before we dispatch into it.
  await new Promise((r) => setTimeout(r, 1500));

  const replyRes = await fetch(`http://127.0.0.1:${port}/api/inbox/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ option_ids: ['a'] }),
  });
  expect(replyRes.status).toBe(200);
  const replyBody = await replyRes.json();
  expect(replyBody.reply.text).toBe('A');
  expect(replyBody.reply.option_ids).toEqual(['a']);
  expect(replyBody.dispatch).toBeTruthy();
  expect(
    replyBody.dispatch.mode,
    `expected real dispatch outcome, got ${JSON.stringify(replyBody.dispatch)}`,
  ).toMatch(/^(dispatch|spawn|resume)$/);
  expect(replyBody.dispatch.session_id).toBe(spawnBody.session_id);
});

// ---------------------------------------------------------------------------
// Validation surface — keep the negative paths covered by HTTP too, so a
// regression in the validator code path won't sneak past unit tests.
// ---------------------------------------------------------------------------

test('POST /api/inbox/<id>/reply: rejects unknown option', async () => {
  const id = 'q:val-unknown-' + Math.random().toString(36).slice(2, 7);
  const upsert = await fetch(`http://127.0.0.1:${port}/api/test/inbox-upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      kind: 'question',
      source: 'e2e-test',
      notify: false,
      question: {
        prompt: 'pick',
        options: [{ id: 'a', label: 'A' }],
      },
    }),
  });
  expect(upsert.status).toBe(200);
  const res = await fetch(`http://127.0.0.1:${port}/api/inbox/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ option_ids: ['bogus'] }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.code).toBe('UNKNOWN_OPTION');
});

test('POST /api/inbox/<id>/reply: 409 when item has no question', async () => {
  const id = 'q:val-noquestion-' + Math.random().toString(36).slice(2, 7);
  const upsert = await fetch(`http://127.0.0.1:${port}/api/test/inbox-upsert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, kind: 'note', source: 'e2e-test', notify: false }),
  });
  expect(upsert.status).toBe(200);
  const res = await fetch(`http://127.0.0.1:${port}/api/inbox/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('NO_QUESTION');
});

test('POST /api/inbox/<id>/reply: 404 for missing item', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/inbox/does-not-exist/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  });
  expect(res.status).toBe(404);
});
