#!/usr/bin/env node
/**
 * cdb — clawdevbox API test tool
 *
 * Hand-rolled CLI for poking the live clawdevbox at http://127.0.0.1:5201
 * without writing a one-off curl every time. All subcommands hit the REAL
 * server with REAL agent CLIs — no mocks, no subprocess kernels.
 *
 * Usage:
 *   node tools/cdb.mjs <command> [args] [--flags]
 *
 * Commands:
 *   list                          List all active sessions
 *   spawn <prompt>                Spawn or dispatch (smart routing)
 *   dispatch <prompt>             Send follow-up to a specific instance
 *   kill <instance>               Tree-kill the pty
 *   tail <instance>               Stream xterm scrollback (Ctrl+C to stop)
 *   wait <instance> <text>        Wait until <text> appears in scrollback
 *   resume <alias|guid>           Spawn with a session id (alias or GUID)
 *   scenarios                     List built-in test scenarios
 *   scenario <name>               Run a built-in scenario end-to-end
 *
 * Common flags (subcommand-aware — see --help on each):
 *   --base <url>            BASE url (default $CDB_URL or http://127.0.0.1:5201)
 *   --provider <id>         copilot | claude | agency  (default: copilot)
 *   --workspace <path>      Workspace path (default: cwd)
 *   --workspace-id <id>     Stable workspace id (created if path also given)
 *   --instance <id>         Target instance_id for dispatch/kill/tail/wait
 *   --alias <name>          Friendly session_id alias
 *   --session-id <guid>     Explicit session GUID (passes through unchanged)
 *   --agent <name>          Agent persona (passed to --agent)
 *   --model <name>          AI model (passed to --model)
 *   --no-wait               Don't wait for canary after spawn
 *   --timeout <sec>         Wait timeout in seconds (default: 90)
 *   --json                  Output raw JSON instead of pretty text
 *   --quiet                 Suppress progress logs
 *   -h, --help              This help (or per-command help)
 */

import WebSocket from 'ws';
import { resolve as resolvePath } from 'node:path';

// ───────────────────────── ANSI + helpers ─────────────────────────
const TTY = process.stdout.isTTY;
const C = {
  reset: TTY ? '\x1b[0m' : '',
  dim: TTY ? '\x1b[2m' : '',
  bold: TTY ? '\x1b[1m' : '',
  red: TTY ? '\x1b[31m' : '',
  green: TTY ? '\x1b[32m' : '',
  yellow: TTY ? '\x1b[33m' : '',
  blue: TTY ? '\x1b[34m' : '',
  magenta: TTY ? '\x1b[35m' : '',
  cyan: TTY ? '\x1b[36m' : '',
  gray: TTY ? '\x1b[90m' : '',
};
const die = (msg, code = 1) => { console.error(`${C.red}error:${C.reset} ${msg}`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── arg parsing ─────────────────────────
const ARGV = process.argv.slice(2);
function takeFlag(name, hasValue = true) {
  for (let i = 0; i < ARGV.length; i++) {
    if (ARGV[i] === name) {
      if (!hasValue) { ARGV.splice(i, 1); return true; }
      const v = ARGV[i + 1];
      ARGV.splice(i, 2);
      return v;
    }
  }
  return undefined;
}
function flagOrEnv(flag, env, fallback) {
  const v = takeFlag(flag);
  if (v !== undefined) return v;
  if (env && process.env[env]) return process.env[env];
  return fallback;
}

// Globals from common flags
const BASE = flagOrEnv('--base', 'CDB_URL', 'http://127.0.0.1:5201');
const JSON_OUT = takeFlag('--json', false);
const QUIET = takeFlag('--quiet', false);
const SHOW_HELP = takeFlag('-h', false) || takeFlag('--help', false);
const log = (...a) => { if (!QUIET) console.error(...a); };

// ───────────────────────── API helpers ─────────────────────────
async function api(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let r, text;
  try {
    r = await fetch(`${BASE}${path}`, init);
    text = await r.text();
  } catch (err) {
    die(`network: ${err.message} (${BASE}${path}) — is clawdevbox running on ${BASE}?`);
  }
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json ?? text, raw: text, ok: r.status >= 200 && r.status < 300 };
}

const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const del = (p) => api('DELETE', p);

async function readScrollback(instanceId, durationMs = 3000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/terminal/${instanceId}/ws`);
    let buf = '';
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(buf); }, durationMs);
    ws.on('message', (m) => {
      try {
        const o = JSON.parse(m.toString());
        if (o.type === 'snapshot') buf += o.content ?? '';
        else if (o.type === 'data') buf += o.chunk ?? '';
      } catch {}
    });
    ws.once('error', () => { clearTimeout(timer); resolve(buf); });
  });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
}

async function waitForCanary(instanceId, text, maxSec = 90) {
  log(`${C.dim}  waiting for "${text}" (up to ${maxSec}s)...${C.reset}`);
  for (let i = 0; i < maxSec; i += 2) {
    const buf = stripAnsi(await readScrollback(instanceId, 1500));
    if (buf.includes(text)) return buf;
    await sleep(500);
  }
  return null;
}

function printJson(o) { console.log(JSON.stringify(o, null, 2)); }
function row(label, value, color = C.cyan) {
  return `${color}${label.padEnd(14)}${C.reset} ${value}`;
}

// ───────────────────────── subcommands ─────────────────────────
const COMMANDS = {};

// ── list ────────────────────────────────────────────────────────
COMMANDS.list = {
  help: 'List all active sessions (live ptys).',
  async run() {
    const r = await get('/api/sessions?status=active&limit=200');
    if (JSON_OUT) return printJson(r.body);
    const items = r.body?.items ?? [];
    if (items.length === 0) {
      console.log(`${C.dim}(no active sessions)${C.reset}`);
      return;
    }
    console.log(`${C.bold}${items.length} active session(s):${C.reset}\n`);
    for (const s of items) {
      const stateColor = s.state === 'idle' ? C.green : s.state === 'busy' ? C.yellow : C.dim;
      console.log(`${C.bold}${s.instance_id}${C.reset}`);
      console.log(`  ${row('label', s.label ?? '(no label)')}`);
      console.log(`  ${row('state', `${stateColor}${s.state}${C.reset}  queue=${s.queue_depth}`)}`);
      console.log(`  ${row('provider', s.provider_id ?? '(main)')}`);
      console.log(`  ${row('workspace', s.workspace_id)}`);
      if (s.cli_session_id) console.log(`  ${row('cli_session', s.cli_session_id)}`);
      console.log();
    }
  },
};

// ── spawn ───────────────────────────────────────────────────────
COMMANDS.spawn = {
  help: 'Spawn a session (or dispatch if session_id is already live). Smart routing.',
  async run() {
    const prompt = ARGV.shift();
    if (!prompt) die('usage: cdb spawn <prompt> [--provider X] [--workspace P] [--alias A] [--model M]');
    const body = {
      prompt,
      provider: flagOrEnv('--provider', 'CDB_PROVIDER', 'copilot'),
      workspace_path: resolvePath(flagOrEnv('--workspace', null, process.cwd())),
    };
    const wsId = takeFlag('--workspace-id');
    if (wsId) body.workspace_id = wsId;
    const alias = takeFlag('--alias');
    const sessionId = takeFlag('--session-id');
    if (alias) body.session_id = alias;
    else if (sessionId) body.session_id = sessionId;
    const agent = takeFlag('--agent');
    if (agent) body.agent = agent;
    const model = takeFlag('--model');
    if (model) body.model = model;
    const fireId = takeFlag('--fire-id');
    const noWait = takeFlag('--no-wait', false);
    const timeout = Number(takeFlag('--timeout') ?? 90);

    log(`${C.magenta}POST /spawn${C.reset} ${JSON.stringify(body)}`);
    const r = await post(fireId ? `/spawn?fire_id=${encodeURIComponent(fireId)}` : '/spawn', body);
    if (!r.ok) {
      if (JSON_OUT) printJson(r.body);
      die(`spawn failed: HTTP ${r.status} ${r.raw}`);
    }
    if (JSON_OUT) return printJson(r.body);

    const modeColor = r.body.mode === 'spawn' ? C.green : C.blue;
    console.log(`${modeColor}${r.body.mode.toUpperCase()}${C.reset}  instance=${C.bold}${r.body.instance_id}${C.reset}`);
    console.log(`  ${row('session_id', r.body.session_id)}`);
    if (r.body.session_alias) console.log(`  ${row('alias', r.body.session_alias)}`);
    if (r.body.state) console.log(`  ${row('state', r.body.state)}`);

    if (!noWait) {
      const canary = (prompt.match(/[A-Z_][A-Z0-9_]{4,}/) ?? [])[0];
      if (canary) {
        const buf = await waitForCanary(r.body.instance_id, canary, timeout);
        if (buf) {
          console.log(`${C.green}✓${C.reset} canary "${canary}" arrived`);
        } else {
          console.log(`${C.yellow}!${C.reset} canary "${canary}" not seen in ${timeout}s (response may still be in flight)`);
        }
      }
    }
  },
};

// ── dispatch ────────────────────────────────────────────────────
COMMANDS.dispatch = {
  help: 'Send a follow-up prompt to an existing instance (or via fire_id).',
  async run() {
    const prompt = ARGV.shift();
    if (!prompt) die('usage: cdb dispatch <prompt> --instance <id>  OR  --fire-id <id>');
    const instance = takeFlag('--instance');
    const fireId = takeFlag('--fire-id');
    if (!instance && !fireId) die('--instance or --fire-id required');
    const body = { prompt };
    if (instance) body.instance_id = instance;
    if (fireId) body.fire_id = fireId;

    log(`${C.magenta}POST /dispatch${C.reset} ${JSON.stringify(body)}`);
    const r = await post('/dispatch', body);
    if (JSON_OUT) return printJson(r.body);
    if (!r.ok) die(`dispatch failed: HTTP ${r.status} ${r.raw}`);
    console.log(`${C.green}OK${C.reset} state=${r.body.state} queued_at=${r.body.queued_at}`);
  },
};

// ── kill ────────────────────────────────────────────────────────
COMMANDS.kill = {
  help: 'Tree-kill the pty (DELETE /api/sessions/<id>).',
  async run() {
    const id = ARGV.shift();
    if (!id) die('usage: cdb kill <instance_id>');
    const r = await del(`/api/sessions/${encodeURIComponent(id)}`);
    if (JSON_OUT) return printJson(r.body);
    if (!r.ok) die(`kill failed: HTTP ${r.status} ${r.raw}`);
    if (r.body.killed) console.log(`${C.green}✓${C.reset} killed ${id}`);
    else console.log(`${C.dim}- ${id} was not live (${r.body.reason ?? 'gone'})${C.reset}`);
  },
};

// ── tail ────────────────────────────────────────────────────────
COMMANDS.tail = {
  help: 'Stream xterm scrollback (Ctrl+C to stop).',
  async run() {
    const id = ARGV.shift();
    if (!id) die('usage: cdb tail <instance_id>');
    const stripped = takeFlag('--no-ansi', false);
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/terminal/${id}/ws`);
    let firstSnapshot = true;
    ws.on('message', (m) => {
      try {
        const o = JSON.parse(m.toString());
        if (o.type === 'snapshot') {
          process.stdout.write(stripped ? stripAnsi(o.content ?? '') : (o.content ?? ''));
          if (firstSnapshot) {
            firstSnapshot = false;
            console.error(`${C.dim}\n--- live stream from ${id} (Ctrl+C to stop) ---${C.reset}`);
          }
        } else if (o.type === 'data') {
          process.stdout.write(stripped ? stripAnsi(o.chunk ?? '') : (o.chunk ?? ''));
        } else if (o.type === 'exit') {
          console.error(`\n${C.yellow}--- session exited (code=${o.exitCode}) ---${C.reset}`);
          ws.close();
          process.exit(0);
        }
      } catch {}
    });
    ws.once('error', (err) => { die(`ws error: ${err.message}`); });
    process.on('SIGINT', () => { ws.close(); process.exit(0); });
  },
};

// ── wait ────────────────────────────────────────────────────────
COMMANDS.wait = {
  help: 'Wait until <text> appears in scrollback (or timeout).',
  async run() {
    const id = ARGV.shift();
    const needle = ARGV.shift();
    if (!id || !needle) die('usage: cdb wait <instance_id> <text> [--timeout <sec>]');
    const timeout = Number(takeFlag('--timeout') ?? 90);
    const buf = await waitForCanary(id, needle, timeout);
    if (buf) {
      console.log(`${C.green}✓${C.reset} "${needle}" found`);
      process.exit(0);
    } else {
      console.log(`${C.red}✗${C.reset} "${needle}" not seen in ${timeout}s`);
      process.exit(2);
    }
  },
};

// ── resume ──────────────────────────────────────────────────────
COMMANDS.resume = {
  help: 'Spawn with a specific session_id (alias or GUID) — convenience wrapper.',
  async run() {
    const aliasOrGuid = ARGV.shift();
    const prompt = ARGV.shift();
    if (!aliasOrGuid || !prompt) die('usage: cdb resume <alias|guid> <prompt> [--provider X] [--workspace P]');
    ARGV.unshift(prompt);
    ARGV.push('--alias', aliasOrGuid);
    await COMMANDS.spawn.run();
  },
};

// ── scenarios + scenario ────────────────────────────────────────
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const SCENARIOS = {
  'smart-alias': {
    description: 'Spawn with alias, dispatch same alias → mode=dispatch, kill, spawn again → resume.',
    async run() {
      const provider = flagOrEnv('--provider', 'CDB_PROVIDER', 'copilot');
      const ws = resolvePath(flagOrEnv('--workspace', null, process.cwd()));
      const alias = 'cdb-scenario-' + Math.random().toString(36).slice(2, 8);
      console.log(`${C.bold}Scenario: smart-alias${C.reset}  provider=${provider}  alias=${alias}\n`);

      console.log(`${C.cyan}1.${C.reset} Initial spawn (alias new) — expect mode=spawn`);
      const r1 = await post('/spawn', { prompt: 'Reply with only: HELLO_1', session_id: alias, provider, workspace_path: ws });
      console.log(`   → ${r1.body.mode} instance=${r1.body.instance_id} session=${r1.body.session_id}`);
      assert(r1.body.mode === 'spawn', `expected mode=spawn, got ${r1.body.mode}`);
      await waitForCanary(r1.body.instance_id, 'HELLO_1', 120);
      console.log(`${C.green}   ✓ HELLO_1 arrived${C.reset}`);

      console.log(`\n${C.cyan}2.${C.reset} Repeat spawn (same alias, live) — expect mode=dispatch`);
      const r2 = await post('/spawn', { prompt: 'Reply with only: HELLO_2', session_id: alias, provider, workspace_path: ws });
      console.log(`   → ${r2.body.mode} instance=${r2.body.instance_id} session=${r2.body.session_id}`);
      assert(r2.body.mode === 'dispatch', `expected mode=dispatch, got ${r2.body.mode}`);
      assert(r2.body.session_id === r1.body.session_id, 'GUID must persist');
      await waitForCanary(r1.body.instance_id, 'HELLO_2', 60);
      console.log(`${C.green}   ✓ HELLO_2 arrived${C.reset}`);

      console.log(`\n${C.cyan}3.${C.reset} Kill the pty`);
      const k = await del(`/api/sessions/${r1.body.instance_id}`);
      assert(k.body.killed === true, 'kill must succeed');
      console.log(`${C.green}   ✓ killed${C.reset}`);
      await sleep(4000);

      console.log(`\n${C.cyan}4.${C.reset} Spawn with same alias (no live pty) — expect mode=spawn, GUID preserved`);
      const r3 = await post('/spawn', { prompt: 'Reply with only: HELLO_3', session_id: alias, provider, workspace_path: ws });
      console.log(`   → ${r3.body.mode} instance=${r3.body.instance_id} session=${r3.body.session_id}`);
      assert(r3.body.mode === 'spawn', `expected mode=spawn, got ${r3.body.mode}`);
      assert(r3.body.session_id === r1.body.session_id, 'GUID must persist across kill');
      await waitForCanary(r3.body.instance_id, 'HELLO_3', 120);
      console.log(`${C.green}   ✓ HELLO_3 arrived (copilot resumed from jsonl)${C.reset}`);

      console.log(`\n${C.cyan}cleanup:${C.reset}`);
      await del(`/api/sessions/${r3.body.instance_id}`);
      console.log(`${C.green}\n🎯 smart-alias scenario PASS${C.reset}`);
    },
  },
  'model-switch': {
    description: 'Spawn with two different --model values, verify each appears in status bar.',
    async run() {
      const provider = flagOrEnv('--provider', 'CDB_PROVIDER', 'copilot');
      const ws = resolvePath(flagOrEnv('--workspace', null, process.cwd()));
      const cases = [
        { model: 'claude-opus-4.7-1m-internal', expectInBar: /Opus 4\.7/i },
        { model: 'gpt-5.2', expectInBar: /GPT[\s-]*5\.2/i },
      ];
      console.log(`${C.bold}Scenario: model-switch${C.reset}  provider=${provider}\n`);
      for (const c of cases) {
        const alias = 'cdb-model-' + Math.random().toString(36).slice(2, 6);
        const canary = 'MODEL_OK_' + c.model.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 10);
        console.log(`${C.cyan}→${C.reset} model=${c.model}`);
        const r = await post('/spawn', { prompt: `Reply with only: ${canary}`, session_id: alias, provider, workspace_path: ws, model: c.model });
        await waitForCanary(r.body.instance_id, canary, 120);
        const snap = stripAnsi(await readScrollback(r.body.instance_id, 2000));
        assert(c.expectInBar.test(snap), `expected ${c.expectInBar} in status bar`);
        console.log(`${C.green}   ✓ ${c.expectInBar} matched in status bar${C.reset}`);
        await del(`/api/sessions/${r.body.instance_id}`);
      }
      console.log(`${C.green}\n🎯 model-switch scenario PASS${C.reset}`);
    },
  },
  'stress': {
    description: 'N concurrent aliases × 2 turns each (default N=5; override with --n).',
    async run() {
      const n = Number(takeFlag('--n') ?? 5);
      const provider = flagOrEnv('--provider', 'CDB_PROVIDER', 'copilot');
      const ws = resolvePath(flagOrEnv('--workspace', null, process.cwd()));
      console.log(`${C.bold}Scenario: stress${C.reset}  provider=${provider}  n=${n}\n`);

      const aliases = [];
      for (let i = 0; i < n; i++) {
        aliases.push({ alias: 'cdb-stress-' + i + '-' + Math.random().toString(36).slice(2, 6), canaries: [] });
      }

      console.log(`${C.cyan}phase 1:${C.reset} ${n} parallel spawns`);
      const phase1 = await Promise.all(aliases.map((a) => {
        const c = 'STR_S' + a.alias.slice(-6).toUpperCase();
        a.canaries.push(c);
        return post('/spawn', { prompt: `Reply with only: ${c}`, session_id: a.alias, provider, workspace_path: ws })
          .then((r) => ({ ...a, instance: r.body.instance_id, guid: r.body.session_id, mode: r.body.mode }));
      }));
      for (const r of phase1) assert(r.mode === 'spawn', `${r.alias}: expected mode=spawn`);
      console.log(`${C.green}   ✓ ${n} spawned${C.reset}`);

      await Promise.all(phase1.map((r) => waitForCanary(r.instance, r.canaries[0], 180)));
      console.log(`${C.green}   ✓ initial canaries arrived${C.reset}`);

      console.log(`\n${C.cyan}phase 2:${C.reset} parallel dispatch follow-ups`);
      await Promise.all(phase1.map(async (r) => {
        const c = 'STR_D' + r.alias.slice(-6).toUpperCase();
        r.canaries.push(c);
        const r2 = await post('/spawn', { prompt: `Reply with only: ${c}`, session_id: r.alias, provider, workspace_path: ws });
        assert(r2.body.mode === 'dispatch', `${r.alias}: expected mode=dispatch`);
        assert(r2.body.instance_id === r.instance, `${r.alias}: instance must match`);
      }));
      await Promise.all(phase1.map(async (r) => {
        for (const c of r.canaries) {
          const buf = await waitForCanary(r.instance, c, 90);
          assert(buf, `${r.alias} missing canary ${c}`);
        }
      }));
      console.log(`${C.green}   ✓ all ${n * 2} canaries delivered${C.reset}`);

      console.log(`\n${C.cyan}cleanup:${C.reset} killing all ${n} sessions`);
      await Promise.all(phase1.map((r) => del(`/api/sessions/${r.instance}`)));
      console.log(`${C.green}\n🎯 stress scenario PASS (${n} sessions × 2 turns = ${n * 2} canaries)${C.reset}`);
    },
  },
};

COMMANDS.scenarios = {
  help: 'List built-in test scenarios.',
  async run() {
    console.log(`${C.bold}Built-in scenarios:${C.reset}\n`);
    for (const [name, s] of Object.entries(SCENARIOS)) {
      console.log(`  ${C.cyan}${name.padEnd(16)}${C.reset} ${s.description}`);
    }
    console.log(`\n${C.dim}Run with:${C.reset} cdb scenario <name> [--provider X] [--workspace P]`);
  },
};

COMMANDS.scenario = {
  help: 'Run a built-in scenario end-to-end.',
  async run() {
    const name = ARGV.shift();
    if (!name) die('usage: cdb scenario <name>  (see: cdb scenarios)');
    const s = SCENARIOS[name];
    if (!s) die(`unknown scenario "${name}". See: cdb scenarios`);
    try { await s.run(); }
    catch (err) { die(`scenario failed: ${err.message}`, 2); }
  },
};

// ───────────────────────── help ─────────────────────────
function printHelp() {
  console.log(`${C.bold}cdb${C.reset} — clawdevbox API test tool

${C.bold}USAGE${C.reset}
  node tools/cdb.mjs <command> [args] [--flags]

${C.bold}COMMANDS${C.reset}`);
  for (const [name, c] of Object.entries(COMMANDS)) {
    console.log(`  ${C.cyan}${name.padEnd(12)}${C.reset} ${c.help}`);
  }
  console.log(`
${C.bold}GLOBAL FLAGS${C.reset}
  --base <url>          BASE url (default: $CDB_URL or http://127.0.0.1:5201)
  --provider <id>       copilot | claude | agency  (default: $CDB_PROVIDER or copilot)
  --workspace <path>    Workspace path (default: cwd)
  --json                Raw JSON output
  --quiet               Suppress progress logs
  -h, --help            Show this help

${C.bold}EXAMPLES${C.reset}
  ${C.dim}# Spawn a fresh copilot in cwd with a friendly alias${C.reset}
  node tools/cdb.mjs spawn "Reply with only: HELLO" --alias my-feature

  ${C.dim}# Same alias again — auto-dispatches as follow-up${C.reset}
  node tools/cdb.mjs spawn "And now reply: WORLD" --alias my-feature

  ${C.dim}# Switch models${C.reset}
  node tools/cdb.mjs spawn "test" --model gpt-5.2
  node tools/cdb.mjs spawn "test" --model claude-opus-4.7-1m-internal

  ${C.dim}# List + kill${C.reset}
  node tools/cdb.mjs list
  node tools/cdb.mjs kill ri_mpt2j5p3_861f

  ${C.dim}# Tail a session live${C.reset}
  node tools/cdb.mjs tail ri_mpt2j5p3_861f --no-ansi

  ${C.dim}# Run a built-in scenario${C.reset}
  node tools/cdb.mjs scenarios
  node tools/cdb.mjs scenario smart-alias
  node tools/cdb.mjs scenario stress --n 3
`);
}

// ───────────────────────── main ─────────────────────────
async function main() {
  const cmd = ARGV.shift();
  if (!cmd || cmd === 'help' || SHOW_HELP) {
    printHelp();
    return;
  }
  const handler = COMMANDS[cmd];
  if (!handler) die(`unknown command "${cmd}". Run: cdb --help`);
  await handler.run();
}

main().catch((err) => die(err.stack ?? err.message));
