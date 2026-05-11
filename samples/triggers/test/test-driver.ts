#!/usr/bin/env tsx
/**
 * test-driver.ts
 *
 * Runs end-to-end scenarios against real Azure DevOps using the trigger
 * scripts (ado-comment-watcher.ts/.py) and the local mock-conductor.
 *
 * Reads test-config.json (produced by setup-ado.sh) for the real PR id and
 * the test comment id we expect to see flow through the trigger.
 *
 * Scenarios
 * ---------
 *   A) Cron-fire / poll path (TS)        — real ADO list_pr_comments call
 *   B) External webhook path (TS)        — simulated ADO service-hook payload
 *   C) Idempotency (TS)                  — re-fire with state.lastCommentId at cutoff
 *   D) Cron-fire / poll path (Python)    — same as A using ado-comment-watcher.py
 *   E) Malformed envelope (TS)           — exit 2, server returns 5xx
 *   F) Mixed-mode pulse watcher (TS)     — Mode B live POSTs + Mode A on-exit summary
 *   G) Plugin discovery + trigger fire   — load fixtures/test-plugin, fire its trigger
 *
 * Usage:
 *   tsx test-driver.ts                # run all scenarios
 *   tsx test-driver.ts --help         # show this help and the scenario list
 *   tsx test-driver.ts --only A,B     # run a subset
 *   tsx test-driver.ts --skip-py      # skip Python scenario (if python3 not installed)
 */

import { test } from 'node:test';
import { ok, equal, deepStrictEqual } from 'node:assert';
import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockConductor, type MockServerHandle, type TriggerConfig } from './mock-conductor.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TRIGGER_DIR = resolve(__dirname, '..');
const TS_SCRIPT = resolve(TRIGGER_DIR, 'ado-comment-watcher.ts');
const PY_SCRIPT = resolve(TRIGGER_DIR, 'ado-comment-watcher.py');
const PULSE_SCRIPT = resolve(TRIGGER_DIR, 'ado-pr-pulse-watcher.ts');
const CONFIG_PATH = resolve(__dirname, 'test-config.json');

const TRIGGER_ID = 'ado-comments-thr_TEST';
const THREAD_ID = 'thr_TEST';
const CALLBACK_PATH = `/callback/threads/${THREAD_ID}/resume`;

const PULSE_TRIGGER_ID = 'pr-pulse-thr_TEST';
const PULSE_CALLBACK_PATH = `/callback/threads/${THREAD_ID}/resume`;

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------

interface Args {
  only: Set<string> | null;
  skipPy: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { only: null, skipPy: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--skip-py') args.skipPy = true;
    else if (a === '--only') {
      const next = argv[++i];
      if (!next) throw new Error('--only requires comma-separated list');
      args.only = new Set(next.split(',').map((s) => s.trim().toUpperCase()));
    } else if (a.startsWith('--only=')) {
      args.only = new Set(a.slice('--only='.length).split(',').map((s) => s.trim().toUpperCase()));
    }
  }
  return args;
}

const HELP_TEXT = `
Conductor trigger harness — test driver
========================================

Scenarios:
  A) Cron-fire / poll path (TS) — fires /hooks/<id> with empty body; trigger
     script polls real ADO and POSTs callbacks for new comments.
  B) External webhook path (TS) — POST a synthetic ADO service-hook payload
     to /hooks/<id>; trigger sees fired_by=external and uses the payload.
  C) Idempotency (TS) — re-fire cron with state.lastCommentId at cutoff;
     verifies no duplicate callback.
  D) Cron-fire / poll path (Python) — Scenario A using ado-comment-watcher.py.
  E) Malformed envelope (TS) — POST raw text; trigger exits 2; server 5xx.
  F) Mixed-mode pulse watcher (TS) — fires ado-pr-pulse-watcher.ts with a
     short maxRunSec; verifies Mode B live POSTs (during the run) AND Mode A
     summary delivery (on exit) end up in the captured-callbacks list with
     the right delivered_via markers.
  G) Plugin discovery + trigger fire — loads fixtures/test-plugin via
     POST /test/load-plugin, asserts GET /test/triggers reports the bundled
     trigger with scope="plugin:test-plugin", fires the trigger, and verifies
     the captured callback's prompt matches the script's emit.

Usage:
  tsx test-driver.ts                Run all scenarios
  tsx test-driver.ts --only A,B     Run a subset (case-insensitive)
  tsx test-driver.ts --skip-py      Skip Scenario D
  tsx test-driver.ts --help         Show this help

Prereqs:
  - test-config.json in this directory (created by setup-ado.sh)
  - ADO_ORG and ADO_PAT in env (the trigger script needs them)
  - tsx on PATH (the TS trigger spawn target)
  - python3 / python on PATH for Scenario D (or use --skip-py)
`.trim();

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface TestConfig {
  org: string;
  /**
   * The value to pass to the trigger as ADO_ORG. May be just the org slug
   * (e.g. "contoso") or "<org>/<urlencoded project>" when the PR repo must
   * be looked up by name and the project is required in the URL path.
   */
  trigger_ado_org?: string;
  project: string;
  repo: string;
  pr_id: number;
  test_comment_id: number;
  test_comment_text: string;
  az_user: string;
  /** AAD access token minted by setup via `az account get-access-token`. */
  ado_bearer_token?: string;
}

async function loadConfig(): Promise<TestConfig> {
  try {
    await access(CONFIG_PATH);
  } catch {
    throw new Error(
      `test-config.json not found at ${CONFIG_PATH}.\n` +
        `Run: bash setup-ado.sh   (or pwsh setup-ado.ps1)\n` +
        `It will mint a bearer token from your az login session — no PAT required.`,
    );
  }
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw) as TestConfig;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, body };
}

interface FireResult {
  status: number;
  body: { run_id: string; exit_code?: number; stdout?: string; stderr?: string; duration_ms?: number; error?: string };
}

async function fireHook(handle: MockServerHandle, body: string | object | null): Promise<FireResult> {
  return fireHookFor(handle, TRIGGER_ID, body);
}

async function fireHookFor(
  handle: MockServerHandle,
  triggerId: string,
  body: string | object | null,
): Promise<FireResult> {
  const url = `${handle.url}/hooks/${triggerId}`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${handle.secret}`,
    },
    body: body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body),
  };
  const r = await fetchJson(url, init);
  return r as FireResult;
}

interface CallbackEntry {
  path: string;
  body: { prompt?: string; context?: Record<string, unknown> };
  rawBody: string;
  receivedAt: number;
  delivered_via: 'mode-b' | 'mode-a-stdout';
}

async function getCallbacks(handle: MockServerHandle): Promise<CallbackEntry[]> {
  const r = await fetchJson(`${handle.url}/test/received-callbacks`);
  if (r.status !== 200) throw new Error(`/test/received-callbacks → ${r.status}`);
  return (r.body as { callbacks: CallbackEntry[] }).callbacks;
}

async function resetCallbacks(handle: MockServerHandle): Promise<void> {
  const r = await fetchJson(`${handle.url}/test/reset`, { method: 'POST' });
  if (r.status !== 200) throw new Error(`/test/reset → ${r.status}`);
}

function parseTriggerStdout(stdout: string | undefined): { state?: { lastCommentId?: number; [k: string]: unknown }; systemMessage?: string } | null {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Build the env injected into the trigger subprocess. The trigger reads
 * ADO_ORG + (ADO_BEARER_TOKEN | ADO_PAT) directly from its environment.
 *
 * Resolution order for ADO_ORG:
 *   1. cfg.trigger_ado_org (preferred — written by setup-ado, may include
 *      "/<project>" suffix when the repo lookup needs a project in the URL)
 *   2. cfg.org (just the org slug)
 *
 * Resolution order for the auth token:
 *   1. cfg.ado_bearer_token (preferred — minted by setup-ado from az login)
 *   2. process.env.ADO_BEARER_TOKEN (escape hatch for ad-hoc runs)
 *   3. process.env.ADO_PAT (legacy basic-auth fallback)
 */
function buildTriggerEnv(cfg: TestConfig): Record<string, string> {
  const env: Record<string, string> = {
    ADO_ORG: cfg.trigger_ado_org ?? cfg.org,
  };
  if (cfg.ado_bearer_token) {
    env.ADO_BEARER_TOKEN = cfg.ado_bearer_token;
  } else if (process.env.ADO_BEARER_TOKEN) {
    env.ADO_BEARER_TOKEN = process.env.ADO_BEARER_TOKEN;
  } else if (process.env.ADO_PAT) {
    env.ADO_PAT = process.env.ADO_PAT;
  }
  return env;
}

function tsTrigger(state: Record<string, unknown>, cfg: TestConfig): TriggerConfig {
  return {
    id: TRIGGER_ID,
    command: ['tsx', TS_SCRIPT],
    state,
    subscriberThreadId: THREAD_ID,
    callbackPath: CALLBACK_PATH,
    cwd: TRIGGER_DIR,
    timeoutMs: 60_000,
    extraEnv: buildTriggerEnv(cfg),
  };
}

function pyTrigger(state: Record<string, unknown>, cfg: TestConfig): TriggerConfig {
  // Resolve python executable: prefer python3, fall back to python.
  // On Windows shims, spawning with shell:true (mock-conductor handles that)
  // means either name works if it's on PATH.
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  return {
    id: TRIGGER_ID,
    command: [pyCmd, PY_SCRIPT],
    state,
    subscriberThreadId: THREAD_ID,
    callbackPath: CALLBACK_PATH,
    cwd: TRIGGER_DIR,
    timeoutMs: 60_000,
    extraEnv: buildTriggerEnv(cfg),
  };
}

function pulseTrigger(state: Record<string, unknown>, cfg: TestConfig): TriggerConfig {
  return {
    id: PULSE_TRIGGER_ID,
    command: ['tsx', PULSE_SCRIPT],
    state,
    subscriberThreadId: THREAD_ID,
    callbackPath: PULSE_CALLBACK_PATH,
    cwd: TRIGGER_DIR,
    // The pulse watcher sleeps maxRunSec; give it enough headroom.
    timeoutMs: 120_000,
    extraEnv: buildTriggerEnv(cfg),
  };
}

function adoServiceHookPayload(prId: number, commentId: number, content: string, author: string): Record<string, unknown> {
  return {
    eventType: 'ms.vss-code.git-pullrequest-comment-event',
    resource: {
      pullRequest: { pullRequestId: prId },
      comment: {
        id: commentId,
        content,
        commentType: 'text',
        author: { uniqueName: author, displayName: author },
        publishedDate: new Date().toISOString(),
      },
    },
  };
}

function selfUser(cfg: TestConfig): string {
  // Trigger script skips comments by selfUser. We want our test comment
  // (posted by az_user) to NOT be skipped. Use a sentinel that won't match.
  return `__not_${cfg.az_user}__`;
}

// ----------------------------------------------------------------------------
// Pre-flight checks
// ----------------------------------------------------------------------------

async function preflight(): Promise<TestConfig> {
  const cfg = await loadConfig();
  // The trigger script reads ADO_ORG + (ADO_BEARER_TOKEN | ADO_PAT) from env.
  // We inject them into the spawned subprocess via TriggerConfig.extraEnv,
  // sourced from test-config.json (preferred) or process.env (fallback).
  const hasBearer = !!cfg.ado_bearer_token || !!process.env.ADO_BEARER_TOKEN;
  const hasPat = !!process.env.ADO_PAT;
  if (!hasBearer && !hasPat) {
    throw new Error(
      'No ADO auth available. Either:\n' +
        '  - run setup-ado.sh / setup-ado.ps1 (mints a bearer from az login), or\n' +
        '  - set ADO_BEARER_TOKEN / ADO_PAT in the environment.',
    );
  }
  return cfg;
}

// ----------------------------------------------------------------------------
// Scenario implementations
// ----------------------------------------------------------------------------

async function scenarioA_cronTS(handle: MockServerHandle, cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);
  handle.setTrigger(
    tsTrigger(
      {
        prId: cfg.pr_id,
        repo: cfg.repo,
        lastCommentId: 0,
        selfUser: selfUser(cfg),
      },
      cfg,
    ),
  );
  const result = await fireHook(handle, null); // empty body → cron path
  ok(result.status === 200, `webhook should return 200, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  equal(result.body.exit_code, 0, `trigger should exit 0, got ${result.body.exit_code}; stderr=${result.body.stderr}`);

  const out = parseTriggerStdout(result.body.stdout);
  ok(out, `trigger stdout should be JSON: ${result.body.stdout?.slice(0, 500)}`);
  ok(out!.state, 'trigger stdout should have state');
  ok(
    typeof out!.state!.lastCommentId === 'number' && out!.state!.lastCommentId >= cfg.test_comment_id,
    `state.lastCommentId (${out!.state!.lastCommentId}) should be >= test_comment_id (${cfg.test_comment_id})`,
  );
  // Mode B comment-watcher: stdout carries no `callback` field.
  equal(
    (out as Record<string, unknown>).callback,
    undefined,
    'comment-watcher (Mode B) should not return a `callback` on stdout',
  );

  const callbacks = await getCallbacks(handle);
  ok(callbacks.length >= 1, `should receive >=1 callback, got ${callbacks.length}`);

  const matching = callbacks.find((c) => {
    const ctx = (c.body.context ?? {}) as Record<string, unknown>;
    return ctx.comment_id === cfg.test_comment_id;
  });
  ok(
    matching,
    `should find a callback with context.comment_id=${cfg.test_comment_id}; got: ${JSON.stringify(callbacks.map((c) => c.body.context))}`,
  );
  equal(matching!.path, CALLBACK_PATH, 'callback path should match the resume URL');
  equal(
    matching!.delivered_via,
    'mode-b',
    'comment-watcher should deliver via Mode B (live POST)',
  );

  const ctx = matching!.body.context as Record<string, unknown>;
  equal(ctx.pr_id, cfg.pr_id, 'context.pr_id should match');
  equal(ctx.source, 'ado');
  equal(ctx.kind, 'pr.commented');

  ok(matching!.body.prompt, 'callback should have prompt');
  ok(
    matching!.body.prompt!.includes(cfg.test_comment_text),
    `prompt should contain test comment text\n  expected substring: ${cfg.test_comment_text}\n  got: ${matching!.body.prompt}`,
  );
}

async function scenarioB_externalTS(handle: MockServerHandle, cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);
  handle.setTrigger(
    tsTrigger(
      {
        prId: cfg.pr_id,
        repo: cfg.repo,
        lastCommentId: 0,
        selfUser: selfUser(cfg),
      },
      cfg,
    ),
  );

  // Use a synthetic comment id distinct from the real one to prove the
  // external path uses the body, not a poll. (We use real comment id here
  // anyway because the trigger does not call ADO on the external path.)
  const synthCommentId = cfg.test_comment_id + 1_000_000;
  const synthText = 'Synthetic external webhook payload';
  const payload = adoServiceHookPayload(cfg.pr_id, synthCommentId, synthText, 'someone-else@example.com');

  const result = await fireHook(handle, payload);
  ok(result.status === 200, `webhook should return 200, got ${result.status}`);
  equal(result.body.exit_code, 0, `trigger should exit 0; stderr=${result.body.stderr}`);

  const out = parseTriggerStdout(result.body.stdout);
  ok(out, 'trigger stdout should be JSON');
  // Mode B: no `callback` on stdout.
  equal(
    (out as Record<string, unknown>).callback,
    undefined,
    'comment-watcher (Mode B) should not return a `callback` on stdout',
  );

  const callbacks = await getCallbacks(handle);
  equal(callbacks.length, 1, `external path should produce exactly 1 callback, got ${callbacks.length}`);

  const cb = callbacks[0];
  equal(cb.path, CALLBACK_PATH);
  equal(cb.delivered_via, 'mode-b', 'external callback should be delivered via Mode B (live POST)');
  const ctx = cb.body.context as Record<string, unknown>;
  equal(ctx.comment_id, synthCommentId, 'external callback context.comment_id should match payload');
  equal(ctx.pr_id, cfg.pr_id);
  ok(cb.body.prompt!.includes(synthText), 'prompt should include synthetic comment content');
}

async function scenarioC_idempotencyTS(handle: MockServerHandle, cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);
  // Set state.lastCommentId to >= test_comment_id; cron poll should produce zero callbacks
  // (assuming no NEWER comments were posted to the PR between setup and now).
  handle.setTrigger(
    tsTrigger(
      {
        prId: cfg.pr_id,
        repo: cfg.repo,
        lastCommentId: cfg.test_comment_id,
        selfUser: selfUser(cfg),
      },
      cfg,
    ),
  );
  const result = await fireHook(handle, null);
  equal(result.status, 200);
  equal(result.body.exit_code, 0, `stderr=${result.body.stderr}`);

  const callbacks = await getCallbacks(handle);
  // The strict check is "no callback with comment_id <= test_comment_id".
  // If a newer comment landed on the PR between setup and now, callbacks for
  // those are valid — flag it but don't fail.
  const reEmitted = callbacks.filter((c) => {
    const ctx = (c.body.context ?? {}) as Record<string, unknown>;
    return typeof ctx.comment_id === 'number' && (ctx.comment_id as number) <= cfg.test_comment_id;
  });
  equal(reEmitted.length, 0, `idempotency: comments at or below cutoff should not re-emit; saw ${reEmitted.length}`);
  if (callbacks.length > 0) {
    process.stderr.write(
      `[scenario C info] saw ${callbacks.length} callback(s) for comments newer than test_comment_id (${cfg.test_comment_id}). ` +
        `Likely someone posted to the PR after setup; not a failure.\n`,
    );
  }
}

async function scenarioD_cronPython(handle: MockServerHandle, cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);
  handle.setTrigger(
    pyTrigger(
      {
        prId: cfg.pr_id,
        repo: cfg.repo,
        lastCommentId: 0,
        selfUser: selfUser(cfg),
      },
      cfg,
    ),
  );
  const result = await fireHook(handle, null);
  ok(result.status === 200, `webhook should return 200, got ${result.status}: stderr=${result.body.stderr}`);
  equal(result.body.exit_code, 0, `python trigger should exit 0; stderr=${result.body.stderr}`);

  const callbacks = await getCallbacks(handle);
  const matching = callbacks.find((c) => {
    const ctx = (c.body.context ?? {}) as Record<string, unknown>;
    return ctx.comment_id === cfg.test_comment_id;
  });
  ok(matching, `python trigger should find test_comment_id=${cfg.test_comment_id}; saw ${JSON.stringify(callbacks.map((c) => c.body.context))}`);
  ok(matching!.body.prompt!.includes(cfg.test_comment_text), 'python prompt should contain comment text');
  equal(
    matching!.delivered_via,
    'mode-b',
    'python comment-watcher should deliver via Mode B (live POST)',
  );

  const out = parseTriggerStdout(result.body.stdout);
  ok(out, 'python trigger stdout should be JSON');
  equal(
    (out as Record<string, unknown>).callback,
    undefined,
    'python comment-watcher (Mode B) should not return a `callback` on stdout',
  );
}

async function scenarioE_malformedEnvelope(handle: MockServerHandle, cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);
  handle.setTrigger(
    tsTrigger(
      {
        prId: 0, // doesn't matter — we expect a parse failure first
        repo: '',
        lastCommentId: 0,
        selfUser: '',
      },
      cfg,
    ),
  );

  // Send raw text. mock-conductor's /hooks handler validates JSON before
  // spawning the script, so we'll get a 400 here. To exercise the script's
  // own malformed-envelope path (exit 2 → 500), we need to bypass the
  // server's body parse — the cleanest way is to spawn the script directly.
  // But the spec says the test is "POST raw text to the script via /hooks/...";
  // we honor that by bypassing the JSON parse: use a body that passes JSON
  // but is structurally invalid (forces the script's blocking_error path).
  //
  // Specifically: send a JSON STRING (not an object). The script reads
  // env.state.prId — undefined on a string envelope — and calls
  // blocking_error("state.prId and state.repo must be set..."), exit 2.
  //
  // This proves the exit-2 / 500 contract end-to-end through the server.
  //
  // (We still have a separate guard below that POSTing literal raw text
  // returns 400 before spawn, which is also correct behavior.)

  // First: confirm raw-text → 400 from the server (pre-spawn JSON guard).
  const rawTextResult = await fetchJson(`${handle.url}/hooks/${TRIGGER_ID}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${handle.secret}`,
    },
    body: 'this is not json at all',
  });
  ok(rawTextResult.status >= 400 && rawTextResult.status < 500, `raw text body should be rejected as 4xx, got ${rawTextResult.status}`);

  // Second: confirm structurally-invalid JSON envelope hits the script's
  // exit-2 path and the server returns 5xx with stderr captured.
  // Override the trigger to a state-less config that the script cannot satisfy.
  // The mock-conductor builds the envelope from cfg.state. We set state to
  // {} (no prId/repo) — script must then exit 2 with the
  // "state.prId and state.repo must be set" message.
  handle.setTrigger({
    ...tsTrigger({}, cfg),
  });
  const blockingResult = await fireHook(handle, null);
  ok(blockingResult.status >= 500, `blocking error should return 5xx, got ${blockingResult.status}`);
  equal(blockingResult.body.exit_code, 2, `blocking error should exit 2; stderr=${blockingResult.body.stderr}`);
  ok(
    typeof blockingResult.body.stderr === 'string' && blockingResult.body.stderr.includes('state.prId'),
    `stderr should mention the missing-state condition: ${blockingResult.body.stderr}`,
  );
}

async function scenarioF_mixedModePulse(handle: MockServerHandle, cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);

  // Short maxRunSec so the test finishes quickly. pollIntervalSec=3 ensures
  // at least a couple of ticks fire (one immediately on entry, one after
  // ~3s, then ~6s) before the 8s deadline.
  const initialState = {
    prId: cfg.pr_id,
    repo: cfg.repo,
    selfUser: selfUser(cfg),
    lastCommentId: 0,
    lastIterationId: 0,
    pollIntervalSec: 3,
    maxRunSec: 8,
  };

  handle.setTrigger(pulseTrigger(initialState, cfg));

  // Fire the hook for the pulse trigger specifically (not the comment-watcher).
  // This call blocks until the script exits — i.e. ~maxRunSec later.
  const t0 = Date.now();
  const result = await fireHookFor(handle, PULSE_TRIGGER_ID, null);
  const elapsedMs = Date.now() - t0;

  ok(result.status === 200, `pulse webhook should return 200, got ${result.status}: ${JSON.stringify(result.body).slice(0, 500)}`);
  equal(result.body.exit_code, 0, `pulse trigger should exit 0; stderr=${result.body.stderr}`);
  ok(elapsedMs >= 7_000, `pulse run should consume the ~8s budget; elapsed=${elapsedMs}ms`);

  // Stdout must parse as JSON with exactly one singular `callback` (the on-exit summary).
  const out = parseTriggerStdout(result.body.stdout);
  ok(out, `pulse stdout should be JSON: ${result.body.stdout?.slice(0, 500)}`);
  const stdoutBlock = out as {
    state?: Record<string, unknown>;
    callback?: { body?: { prompt?: string; context?: Record<string, unknown> } };
  };
  ok(
    stdoutBlock.callback && typeof stdoutBlock.callback === 'object' && !Array.isArray(stdoutBlock.callback),
    `stdout should have a singular \`callback\` object, got ${JSON.stringify(stdoutBlock.callback)}`,
  );
  ok(stdoutBlock.callback!.body, '`callback.body` should be present');

  // State must show that the script polled real ADO (lastCommentId > 0 because
  // the existing test comment on the PR is visible to the pulse watcher).
  ok(stdoutBlock.state, 'stdout should have state');
  const finalState = stdoutBlock.state as { lastCommentId?: number };
  ok(
    typeof finalState.lastCommentId === 'number' && finalState.lastCommentId > 0,
    `state.lastCommentId should be > 0 (proves real ADO poll); got ${finalState.lastCommentId}`,
  );

  // Now inspect the captured-callbacks list.
  const callbacks = await getCallbacks(handle);
  const modeB = callbacks.filter((c) => c.delivered_via === 'mode-b');
  const modeA = callbacks.filter((c) => c.delivered_via === 'mode-a-stdout');

  ok(modeB.length >= 1, `should receive >=1 Mode B callback (live event during run); got ${modeB.length}`);
  ok(modeA.length >= 1, `should receive >=1 Mode A callback (on-exit summary); got ${modeA.length}`);
  equal(modeA.length, 1, `should receive exactly 1 Mode A callback (the summary); got ${modeA.length}`);

  // Ordering: every Mode B callback should arrive BEFORE every Mode A callback.
  const lastModeB = Math.max(...modeB.map((c) => c.receivedAt));
  const firstModeA = Math.min(...modeA.map((c) => c.receivedAt));
  ok(
    lastModeB <= firstModeA,
    `Mode B callbacks should arrive before Mode A; lastModeB=${lastModeB} firstModeA=${firstModeA}`,
  );

  // Verify the Mode B live event matches the existing test comment.
  const liveCommentCb = modeB.find((c) => {
    const ctx = (c.body.context ?? {}) as Record<string, unknown>;
    return ctx.kind === 'pr.commented' && ctx.comment_id === cfg.test_comment_id;
  });
  ok(
    liveCommentCb,
    `should find a Mode B callback for test comment id=${cfg.test_comment_id}; got: ${JSON.stringify(modeB.map((c) => c.body.context))}`,
  );
  const liveCtx = liveCommentCb!.body.context as Record<string, unknown>;
  equal(liveCtx.delivery, 'live', 'Mode B callback context.delivery should be "live"');
  equal(liveCtx.source, 'ado');
  ok(
    liveCommentCb!.body.prompt!.includes(cfg.test_comment_text),
    `Mode B prompt should contain test comment text; got: ${liveCommentCb!.body.prompt}`,
  );
  equal(liveCommentCb!.path, PULSE_CALLBACK_PATH, 'Mode B callback should hit the pulse callback path');

  // Verify the Mode A summary entry.
  const summaryCb = modeA[0];
  const summaryCtx = (summaryCb.body.context ?? {}) as Record<string, unknown>;
  equal(summaryCtx.kind, 'pr.pulse_summary', 'Mode A callback should be the pulse summary');
  equal(summaryCtx.delivery, 'on_exit', 'Mode A callback context.delivery should be "on_exit"');
  ok(
    summaryCtx.exit_reason === 'time_budget_reached' || summaryCtx.exit_reason === 'pr_closed',
    `Mode A callback exit_reason should be set; got ${summaryCtx.exit_reason}`,
  );
  equal(summaryCb.path, PULSE_CALLBACK_PATH, 'Mode A callback should hit the pulse callback path');

  // Print the timeline so reviewers can eyeball the proof.
  process.stdout.write('\n  --- Scenario F captured-callbacks timeline ---\n');
  const ordered = [...callbacks].sort((a, b) => a.receivedAt - b.receivedAt);
  const t0Captured = ordered.length > 0 ? ordered[0].receivedAt : Date.now();
  for (const cb of ordered) {
    const ctx = (cb.body.context ?? {}) as Record<string, unknown>;
    const dt = ((cb.receivedAt - t0Captured) / 1000).toFixed(2);
    const tag = cb.delivered_via === 'mode-b' ? '[Mode B  live]' : '[Mode A  exit]';
    process.stdout.write(
      `  +${dt.padStart(5, ' ')}s ${tag} kind=${ctx.kind} ` +
        `${ctx.kind === 'pr.commented' ? `comment_id=${ctx.comment_id}` : ''}` +
        `${ctx.kind === 'pr.iteration_pushed' ? `iteration_id=${ctx.iteration_id}` : ''}` +
        `${ctx.kind === 'pr.pulse_summary' ? `exit_reason=${ctx.exit_reason} live=${ctx.live_comments_posted}c/${ctx.live_iterations_posted}i` : ''}\n`,
    );
  }
  process.stdout.write('  --- end timeline ---\n  ');
}

async function scenarioG_pluginDiscovery(handle: MockServerHandle, _cfg: TestConfig): Promise<void> {
  await resetCallbacks(handle);

  // 1. Discover the synthetic test-plugin. The fixture lives alongside this
  //    file under ./fixtures/test-plugin/; we resolve it absolutely so the
  //    test passes regardless of cwd. We hit the HTTP endpoint (rather than
  //    calling handle.loadPlugin directly) to prove the wire-level
  //    introspection contract from end-to-end.
  const pluginDir = resolve(__dirname, 'fixtures', 'test-plugin');
  const loadResult = await fetchJson(`${handle.url}/test/load-plugin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pluginDir }),
  });
  ok(loadResult.status === 200, `/test/load-plugin should return 200, got ${loadResult.status}: ${JSON.stringify(loadResult.body)}`);
  const loadBody = loadResult.body as { ok?: boolean; registered?: string[] };
  ok(loadBody.ok === true, '/test/load-plugin should return ok=true');
  deepStrictEqual(loadBody.registered, ['heartbeat'], 'should register exactly the heartbeat trigger');

  // 2. Verify the trigger appears in the registry with the right scope.
  const trigList = await fetchJson(`${handle.url}/test/triggers`);
  ok(trigList.status === 200, `/test/triggers → ${trigList.status}`);
  const registry = (trigList.body as { triggers: Array<{ id: string; scope: string; cron: string | null; callbackPath: string }> }).triggers;
  const entry = registry.find((t) => t.id === 'heartbeat');
  ok(entry, `registry should contain 'heartbeat'; saw ids: ${registry.map((t) => t.id).join(', ')}`);
  equal(entry!.scope, 'plugin:test-plugin', `heartbeat trigger should have scope='plugin:test-plugin'; got '${entry!.scope}'`);
  equal(entry!.cron, '*/30 * * * * *', `cron should be preserved from plugin.yaml; got '${entry!.cron}'`);
  equal(
    entry!.callbackPath,
    '/callback/plugins/test-plugin/triggers/heartbeat/resume',
    'plugin-scope callback path should follow the deterministic /callback/plugins/<id>/triggers/<id>/resume pattern',
  );

  // 3. Fire the trigger via /hooks/heartbeat with an empty body. The
  //    fireHookFor helper requires the same auth headers all hook fires use.
  const fireRes = await fireHookFor(handle, 'heartbeat', null);
  ok(fireRes.status === 200, `firing heartbeat should return 200, got ${fireRes.status}: ${JSON.stringify(fireRes.body).slice(0, 500)}`);
  equal(fireRes.body.exit_code, 0, `heartbeat trigger should exit 0; stderr=${fireRes.body.stderr}`);

  // The heartbeat script returns { state: { tickCount: N }, systemMessage }
  // on stdout — proves the envelope round-trip and state update path works
  // identically for plugin-scope triggers.
  const out = parseTriggerStdout(fireRes.body.stdout);
  ok(out, `heartbeat stdout should be JSON: ${fireRes.body.stdout?.slice(0, 500)}`);
  ok(out!.state, 'heartbeat stdout should have state');
  const finalState = out!.state as { tickCount?: number };
  equal(finalState.tickCount, 1, `first fire should produce tickCount=1, got ${finalState.tickCount}`);

  // 4. Inspect the captured callback.
  const callbacks = await getCallbacks(handle);
  equal(callbacks.length, 1, `plugin heartbeat fire should produce exactly 1 callback, got ${callbacks.length}`);
  const cb = callbacks[0];
  equal(
    cb.path,
    '/callback/plugins/test-plugin/triggers/heartbeat/resume',
    'plugin callback should hit the plugin-scope route',
  );
  equal(cb.delivered_via, 'mode-b', 'heartbeat trigger should deliver via Mode B (live POST)');
  equal(cb.body.prompt, 'plugin heartbeat tick', 'callback prompt should be the literal heartbeat string');
  const ctx = (cb.body.context ?? {}) as Record<string, unknown>;
  equal(ctx.source, 'test-plugin', 'callback context.source should identify the plugin');
  equal(ctx.kind, 'heartbeat', 'callback context.kind should be heartbeat');
  equal(ctx.tick, 1, 'callback context.tick should be 1 on first fire');
  equal(ctx.trigger_id, 'heartbeat', 'callback context.trigger_id should match the registered id');
}

// ----------------------------------------------------------------------------
// Driver
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT + '\n');
    return;
  }

  const cfg = await preflight();
  const handle = await startMockConductor({ inheritStderr: false });
  process.stdout.write(`mock-conductor on ${handle.url}\n`);
  process.stdout.write(`PR=${cfg.org}/${cfg.repo} #${cfg.pr_id}, test_comment_id=${cfg.test_comment_id}\n\n`);

  type Scenario = { id: string; name: string; fn: (h: MockServerHandle, c: TestConfig) => Promise<void> };
  const scenarios: Scenario[] = [
    { id: 'A', name: 'Cron-fire / poll path (TS)', fn: scenarioA_cronTS },
    { id: 'B', name: 'External webhook path (TS)', fn: scenarioB_externalTS },
    { id: 'C', name: 'Idempotency (TS)', fn: scenarioC_idempotencyTS },
    { id: 'D', name: 'Cron-fire / poll path (Python)', fn: scenarioD_cronPython },
    { id: 'E', name: 'Malformed envelope (TS)', fn: scenarioE_malformedEnvelope },
    { id: 'F', name: 'Mixed-mode pulse watcher (TS)', fn: scenarioF_mixedModePulse },
    { id: 'G', name: 'Plugin discovery + trigger fire', fn: scenarioG_pluginDiscovery },
  ];

  const results: Array<{ id: string; name: string; status: 'pass' | 'fail' | 'skip'; error?: string }> = [];

  for (const s of scenarios) {
    if (args.only && !args.only.has(s.id)) continue;
    if (args.skipPy && s.id === 'D') {
      results.push({ id: s.id, name: s.name, status: 'skip' });
      continue;
    }
    process.stdout.write(`[${s.id}] ${s.name} ... `);
    try {
      await s.fn(handle, cfg);
      results.push({ id: s.id, name: s.name, status: 'pass' });
      process.stdout.write('PASS\n');
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      results.push({ id: s.id, name: s.name, status: 'fail', error: msg });
      process.stdout.write('FAIL\n');
      process.stderr.write(`\n--- Scenario ${s.id} failure ---\n${msg}\n---\n\n`);
    }
  }

  await handle.close();

  process.stdout.write('\n=== Summary ===\n');
  let failures = 0;
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    process.stdout.write(`  [${r.id}] ${tag}  ${r.name}\n`);
    if (r.status === 'fail') failures++;
  }
  process.stdout.write(`\n${results.length} scenario(s); ${failures} failure(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// `test` from node:test is imported for parity with the node test runner but
// this driver uses its own scenario harness directly. Suppress the unused-warning.
void test;

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
