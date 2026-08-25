#!/usr/bin/env node
/**
 * clawdevbox-bootstrap.mjs — first-logon bootstrapper for Microsoft Dev Box.
 *
 * WHY THIS EXISTS
 * ClawDevbox ships from an *internal* GitHub repository. Dev Box provisioning
 * runs as SYSTEM with nobody signed in, so it cannot authenticate to GitHub and
 * therefore cannot install ClawDevbox. Bundling a prebuilt tarball in the
 * catalog would work but goes stale the moment it is committed.
 *
 * So provisioning installs only credential-free things (Node, git, gh, Herdr)
 * and drops this file on the box. At first logon — when a human is present and
 * a browser can open — this wrapper:
 *
 *   1. checks the environment,
 *   2. signs the developer in to GitHub (device-code flow, rendered properly
 *      instead of hidden behind a terminal prompt),
 *   3. installs ClawDevbox using that credential,
 *   4. hands off to `clawdevbox welcome`, the product's own setup wizard.
 *
 * The sign-in is not extra friction: the developer must authenticate to GitHub
 * anyway for Copilot CLI. We just make it a designed moment and reuse the token.
 *
 * Deliberate constraints:
 *   - ZERO npm dependencies (node: builtins only). There is no package to
 *     install before this runs.
 *   - Everything is appended to one log file, so a failed unattended setup can
 *     be diagnosed from a single attachment.
 *
 * Usage:
 *   node clawdevbox-bootstrap.mjs [--kiosk|--app|--tab] [--no-open]
 *                                 [--port <n>] [--log-dir <path>]
 *                                 [--repo <git-url>] [--if-needed] [--force]
 */

import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// No default: the repository is supplied by --repo so this public file
// carries no internal identifiers.
const DEFAULT_REPO = '';

// ----------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const flags = parseArgs(process.argv.slice(2));
const REPO = typeof flags.repo === 'string' ? flags.repo : DEFAULT_REPO;
// Some managed networks block registry.npmjs.org outright (TLS alert 40 on the
// tarball fetch), so the caller can supply the registry that actually works
// there. Kept as a parameter so no environment-specific host is published here.
const NPM_REGISTRY = typeof flags['npm-registry'] === 'string' ? flags['npm-registry'] : '';
const LOG_DIR = typeof flags['log-dir'] === 'string'
  ? flags['log-dir']
  : join(process.env.LOCALAPPDATA ?? join(homedir(), '.local'), 'ClawDevbox', 'logs');
const STATE_FILE = join(dirname(LOG_DIR), 'first-run.json');
const LOG_FILE = join(LOG_DIR, 'bootstrap.log');
const WELCOME_PORT = flags['welcome-port'] ? Number(flags['welcome-port']) : 5321;

// ------------------------------------------------------------------- logging

mkdirSync(LOG_DIR, { recursive: true });

const sseClients = new Set();
const redactions = [];

function redact(text) {
  let out = String(text);
  for (const secret of redactions) {
    if (secret && secret.length > 6) out = out.split(secret).join('***');
  }
  return out.replace(/(x-access-token:)[^@]+@/g, '$1***@');
}

// Strip ANSI colour/spinner escapes: noise in a log, garbage in the browser.
const ANSI = /\u001B\[[0-9;]*[A-Za-z]|\u001B\][^\u0007]*\u0007/g;
function clean(text) {
  return redact(text).replace(ANSI, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trimEnd();
}

function log(level, text) {
  const line = clean(text);
  if (!line) return;
  const stamp = new Date().toISOString().slice(11, 19);
  try { appendFileSync(LOG_FILE, `[${stamp}] ${level.toUpperCase().padEnd(5)} ${line}\n`, 'utf8'); } catch { /* never throw */ }
  process.stdout.write(`${line}\n`);
  emit('log', { level, text: line });
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { /* client gone */ } }
}

try {
  appendFileSync(LOG_FILE,
    `\n${'='.repeat(78)}\nclawdevbox bootstrap — ${new Date().toISOString()}\n` +
    `user=${process.env.USERNAME ?? process.env.USER ?? '?'} host=${process.env.COMPUTERNAME ?? '?'} ` +
    `node=${process.version} repo=${REPO}\n${'='.repeat(78)}\n`, 'utf8');
} catch { /* ignore */ }

// ------------------------------------------------------------------ processes

/** Shell only for bare command names; paths with spaces must not be re-parsed. */
const shellFor = (cmd) => (/[\\/]/.test(cmd) ? false : process.platform === 'win32');

function run(cmd, args, { label, onLine, stdin, cwd } = {}) {
  return new Promise((resolve) => {
    log('info', `> ${label ?? [cmd, ...args].join(' ')}`);
    const child = spawn(cmd, args, {
      shell: shellFor(cmd),
      windowsHide: true,
      cwd,
      // stdin is a pipe only when we intend to answer a prompt; otherwise it is
      // closed so a stray prompt returns EOF instead of hanging forever.
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const feed = (buf) => {
      for (const raw of buf.toString().split(/\r?\n/)) {
        const line = clean(raw);
        if (!line) continue;
        log('info', `    ${line}`);
        if (onLine) { try { onLine(line, child); } catch { /* a handler must not kill the run */ } }
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (err) => { log('error', `    spawn failed: ${err.message}`); resolve(-1); });
    child.on('close', (code) => resolve(code ?? -1));
  });
}

function capture(cmd, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: shellFor(cmd), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const finish = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    child.stdout?.on('data', (b) => { out += b; });
    child.stderr?.on('data', (b) => { out += b; });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out.trim() : null));
  });
}

async function detect(cmd, args = ['--version'], label = cmd) {
  const t0 = Date.now();
  const out = await capture(cmd, args);
  const ms = Date.now() - t0;
  if (out === null) { log('info', `detect ${label}: not found (${ms}ms)`); return { ok: false, version: null }; }
  const version = (out.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 60);
  log('info', `detect ${label}: ${version} (${ms}ms)`);
  return { ok: true, version };
}

async function refreshPath() {
  if (process.platform !== 'win32') return;
  const out = await capture('powershell.exe', ['-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
  if (!out) { log('warn', 'Could not refresh PATH from the registry.'); return; }
  const merged = out.split(/\r?\n/).join('').trim();
  if (merged) {
    process.env.Path = merged;
    process.env.PATH = merged;
    log('info', `Refreshed PATH from the registry (${merged.split(';').filter(Boolean).length} entries).`);
  }
}

function ping(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: '/', method: 'GET', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// --------------------------------------------------------------- the workflow

let ghToken = null;
let signInBusy = false;
let installBusy = false;
let welcomeUrl = null;

/**
 * Drive `gh auth login` and surface its device code to the UI.
 *
 * gh prints "First copy your one-time code: XXXX-XXXX" and then waits for the
 * user to press Enter before opening a browser. Left alone in an unattended
 * context that is an invisible hang, so we give it a stdin pipe, scrape the
 * code, show it in the wizard, and press Enter on the user's behalf.
 */
async function signIn() {
  if (signInBusy) return;
  signInBusy = true;

  const existing = await capture('gh', ['auth', 'token'], 10000);
  if (existing) {
    ghToken = existing.trim();
    redactions.push(ghToken);
    log('info', 'Already signed in to GitHub — reusing the existing credential.');
    emit('signin', { state: 'done' });
    signInBusy = false;
    return;
  }

  log('step', 'Starting GitHub sign-in (device code)');
  let sawCode = false;
  const exitCode = await run('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], {
    stdin: true,
    onLine: (line, child) => {
      const m = /one-time code:\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(line);
      if (m && !sawCode) {
        sawCode = true;
        log('step', `GitHub one-time code: ${m[1]}`);
        emit('signin', { state: 'code', code: m[1] });
        // Press Enter so gh opens github.com/login/device itself.
        try { child.stdin.write('\n'); } catch { /* already closed */ }
      }
    },
  });

  if (exitCode === 0) {
    const tok = await capture('gh', ['auth', 'token'], 10000);
    ghToken = tok ? tok.trim() : null;
    if (ghToken) redactions.push(ghToken);
    log('step', ghToken ? 'GitHub sign-in complete.' : 'gh reported success but returned no token.');
    emit('signin', { state: ghToken ? 'done' : 'failed', error: ghToken ? null : 'no token returned' });
  } else {
    log('error', `gh auth login exited ${exitCode}.`);
    emit('signin', { state: 'failed', error: `gh auth login exited ${exitCode}` });
  }
  signInBusy = false;
}

async function installClawdevbox() {
  if (installBusy) return;
  installBusy = true;
  emit('phase', { label: 'installing ClawDevbox', percent: 20 });

  const already = await detect('clawdevbox', ['--version'], 'clawdevbox');
  if (!already.ok) {
    if (!ghToken) {
      log('error', 'No GitHub credential — cannot install ClawDevbox.');
      emit('finish', { ok: false, error: 'Not signed in to GitHub.' });
      installBusy = false;
      return;
    }
    const authUrl = REPO.replace(/^https:\/\//, `https://x-access-token:${ghToken}@`);

    // Prepare npm before installing. Two things bite on a managed dev box:
    //
    //  1. registry.npmjs.org can be blocked by the TLS-inspecting proxy, which
    //     surfaces as ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE while fetching a
    //     tarball - after the git clone itself succeeded, which is confusing.
    //  2. npm >= 11.7 ignores `--allow-scripts=<pkg>` as an install flag and
    //     warns instead, so the package's `prepare` never runs and the global
    //     bin is left pointing at a file that was never materialised. The
    //     warning itself recommends the config form used here.
    if (NPM_REGISTRY) {
      await run('npm', ['config', 'set', 'registry', NPM_REGISTRY, '--location=user'], {
        label: `npm config set registry ${NPM_REGISTRY}`,
      });
    }
    await run('npm', ['config', 'set', 'allow-scripts=clawdevbox-ms', '--location=user'], {
      label: 'npm config set allow-scripts=clawdevbox-ms',
    });

    let code = -1;
    for (let attempt = 1; attempt <= 2 && code !== 0; attempt++) {
      if (attempt > 1) { log('warn', `npm install failed — retry ${attempt}/2`); await new Promise((r) => setTimeout(r, 8000)); }
      // Deliberately NO --allow-scripts flag here. npm says it plainly:
      //   "npm warn allow-scripts .npmrc allow-scripts setting is being ignored
      //    because --allow-scripts was passed on the command line"
      // and the command-line form is the one npm >= 11.7 then declines to
      // honour, so passing it actively disables the config set above.
      code = await run('npm', ['install', '--global', `git+${authUrl}`], {
        label: `npm install --global git+${REPO}`,
      });
    }
    await refreshPath();
    let now = await detect('clawdevbox', ['--version'], 'clawdevbox');

    // npm can report success on a git package while leaving the install
    // incomplete: on Windows it links the global package at a cache temp clone
    // that it later garbage-collects, so the directory ends up without
    // scripts/ or bin/ at all. Inspect what actually landed before deciding.
    const root = (await capture('npm', ['root', '-g'], 30000) || '').trim();
    const pkgDir = root ? join(root, 'clawdevbox-ms') : null;
    if (!now.ok && pkgDir) {
      const listing = existsSync(pkgDir)
        ? readdirSync(pkgDir).join(', ')
        : '(directory does not exist)';
      log('info', `package dir ${pkgDir}: ${listing}`);

      if (existsSync(join(pkgDir, 'scripts', 'prepare.mjs'))) {
        log('step', 'running the package prepare step by hand');
        await run(process.execPath, [join(pkgDir, 'scripts', 'prepare.mjs')], {
          label: 'node scripts/prepare.mjs', cwd: pkgDir,
        });
        await refreshPath();
        now = await detect('clawdevbox', ['--version'], 'clawdevbox');
      }
    }

    // Last resort, and the approach that reliably produces a self-contained
    // install: clone the repo ourselves, `npm pack` it (which runs prepare in a
    // normal working directory and honours the package's files list), install
    // the resulting tarball, then run prepare again because tarball installs
    // skip it.
    if (!now.ok) {
      log('step', 'Falling back to a packed install (clone -> npm pack -> install).');
      const src = join(tmpdir(), 'clawdevbox-src');
      try { rmSync(src, { recursive: true, force: true }); } catch { /* nothing to remove */ }

      const cloneCode = await run('git', ['clone', '--depth', '1', authUrl, src], {
        label: `git clone --depth 1 ${REPO} ${src}`,
      });
      if (cloneCode === 0) {
        await run('npm', ['pack'], { label: 'npm pack', cwd: src });
        const tgz = existsSync(src)
          ? readdirSync(src).filter((f) => f.endsWith('.tgz')).sort().pop()
          : null;
        if (tgz) {
          log('info', `packed ${tgz}`);
          await run('npm', ['install', '--global', join(src, tgz)], {
            label: `npm install --global ${tgz}`,
          });
          await refreshPath();
          now = await detect('clawdevbox', ['--version'], 'clawdevbox');

          if (!now.ok && pkgDir && existsSync(join(pkgDir, 'scripts', 'prepare.mjs'))) {
            log('step', 'running prepare for the packed install');
            await run(process.execPath, [join(pkgDir, 'scripts', 'prepare.mjs')], {
              label: 'node scripts/prepare.mjs', cwd: pkgDir,
            });
            await refreshPath();
            now = await detect('clawdevbox', ['--version'], 'clawdevbox');
          }
        } else {
          log('error', 'npm pack produced no tarball.');
        }
      }
    }

    if (!now.ok) {
      log('error', 'ClawDevbox could not be installed. The log above names the failing step.');
      emit('finish', { ok: false, error: 'ClawDevbox did not install. See the log.' });
      installBusy = false;
      return;
    }
    log('step', `ClawDevbox installed (${now.version}).`);
  } else {
    log('info', `ClawDevbox already installed (${already.version}).`);
  }

  // Hand the developer to the product's own wizard. It ships with the version
  // just installed, so it can never drift from what is on the box.
  emit('phase', { label: 'starting the setup wizard', percent: 70 });
  const args = ['welcome', '--no-open', '--port', String(WELCOME_PORT), '--log-dir', LOG_DIR];
  log('step', `Handing off to: clawdevbox ${args.join(' ')}`);
  const child = spawn('clawdevbox', args, {
    shell: process.platform === 'win32',
    detached: true,
    // Pipe rather than ignore: if the handoff fails (an old build without the
    // `welcome` command, a crash on boot) the reason has to reach the log,
    // otherwise all we can report is a useless "did not start in time".
    stdio: ['ignore', 'pipe', 'pipe'],
    // Pass the credential along so Copilot CLI does not ask for a second login.
    env: { ...process.env, ...(ghToken ? { GH_TOKEN: ghToken } : {}) },
  });
  let childSaidUnknown = false;
  const relay = (buf) => {
    for (const raw of buf.toString().split(/\r?\n/)) {
      const line = clean(raw);
      if (!line) continue;
      if (/unknown command/i.test(line)) childSaidUnknown = true;
      log('info', `    [welcome] ${line}`);
    }
  };
  child.stdout?.on('data', relay);
  child.stderr?.on('data', relay);
  child.unref();

  const target = `http://127.0.0.1:${WELCOME_PORT}/`;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await ping(target)) {
      welcomeUrl = target;
      log('step', `Setup wizard is up at ${target} — handing off.`);
      emit('phase', { label: 'ready', percent: 100 });
      emit('handoff', { url: target });
      installBusy = false;
      return;
    }
    if (childSaidUnknown) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  const hint = childSaidUnknown
    ? 'The installed ClawDevbox is too old — it has no `welcome` command. Update it with: clawdevbox update'
    : 'ClawDevbox installed, but its setup wizard did not start. Run `clawdevbox welcome` from a terminal.';
  log('error', hint);
  emit('finish', { ok: false, error: hint });
  installBusy = false;
}

function markComplete() {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ bootstrapped: true, at: new Date().toISOString() }, null, 2), 'utf8');
    log('info', `Marked bootstrap complete (${STATE_FILE}).`);
  } catch (err) { log('warn', `Could not write ${STATE_FILE}: ${err.message}`); }

  // Disarm both mechanisms provisioning may have used. --if-needed already
  // makes a re-run a no-op, but leaving a logon entry behind that spawns a
  // process on every sign-in is untidy and looks like malware.
  //
  // The task name contains spaces and `shell: true` joins argv without
  // quoting, so it must be quoted here or schtasks sees three arguments.
  if (process.platform !== 'win32') return;
  spawn('schtasks', ['/Delete', '/TN', '"ClawDevbox First-Run Setup"', '/F'],
    { shell: true, windowsHide: true, stdio: 'ignore' }).on('error', () => { /* not registered */ });
  spawn('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'ClawDevboxFirstRun', '/f'],
    { shell: true, windowsHide: true, stdio: 'ignore' }).on('error', () => { /* not present */ });
  log('info', 'Disarmed the first-run logon entries.');
}

// -------------------------------------------------------------------- the UI

function page() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Set up your dev box</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{--bg:#0b0d12;--elev:#12151d;--elev2:#171b25;--line:#232838;--text:#e7eaf3;--muted:#97a0b5;--dim:#6b7488;--accent:#6d8cff;--accent2:#9d7bff;--ok:#3ecf8e;--err:#ff6b6b}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 500px at 15% -10%,rgba(109,140,255,.17),transparent 60%),radial-gradient(700px 420px at 100% 0,rgba(157,123,255,.13),transparent 55%)}
.wrap{position:relative;min-height:100vh;display:grid;place-items:center;padding:40px 24px}
.card{width:100%;max-width:700px;text-align:center}
.mark{width:56px;height:56px;border-radius:16px;margin:0 auto 22px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;font-size:27px;box-shadow:0 12px 40px rgba(109,140,255,.4)}
h1{font-size:32px;margin:0 0 10px;letter-spacing:-.4px}
p.lede{color:var(--muted);font-size:15px;margin:0 auto 30px;max-width:540px}
.pane{display:none;animation:rise .3s ease both}.pane.show{display:block}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.checks{display:inline-grid;gap:9px;text-align:left;background:var(--elev);border:1px solid var(--line);border-radius:14px;padding:18px 22px;margin-bottom:26px;min-width:400px}
.check{display:flex;align-items:center;gap:11px;font-size:13.5px}
.check .s{width:16px}.check .n{min-width:130px}.check .v{color:var(--dim);font-size:12.5px}
button{font:inherit;font-weight:600;font-size:14px;padding:12px 26px;border-radius:11px;border:1px solid var(--line);background:var(--elev2);color:var(--text);cursor:pointer;transition:filter .15s,transform .08s}
button:hover:not(:disabled){filter:brightness(1.15)}button:active:not(:disabled){transform:translateY(1px)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));border-color:transparent;color:#fff;box-shadow:0 10px 30px rgba(109,140,255,.3)}
.code{font:600 42px/1.2 ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:8px;background:var(--elev);border:1px solid var(--line);border-radius:14px;padding:22px 30px;margin:0 auto 10px;display:inline-block;color:#fff}
.copy{background:none;border:none;color:var(--accent);font-size:12.5px;cursor:pointer;padding:4px}
.steps{text-align:left;max-width:440px;margin:22px auto 0;color:var(--muted);font-size:13.5px;display:grid;gap:9px;padding-left:18px}
.console{height:240px;overflow:auto;padding:12px 14px;margin:22px 0 0;text-align:left;background:#07090d;border:1px solid var(--line);border-radius:13px;font:12px/1.6 ui-monospace,Consolas,monospace;color:#b9c2d6;white-space:pre-wrap;word-break:break-word}
.console .e{color:var(--err)}.console .step{color:var(--accent);font-weight:600}
.prog{height:3px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:22px}.prog>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .4s}
.banner{padding:12px 16px;border-radius:11px;font-size:13.5px;margin-top:18px;border:1px solid;text-align:left}
.banner.err{background:rgba(255,107,107,.09);border-color:rgba(255,107,107,.35);color:#ffc2c2}
.foot{margin-top:26px;color:var(--dim);font-size:11.5px}.foot code{color:var(--muted)}
.spinner{width:15px;height:15px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;display:inline-block;vertical-align:-3px;margin-right:7px}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
<div class="wrap"><div class="card">
  <div class="mark">&#128062;</div>

  <section class="pane show" data-p="0">
    <h1>Welcome to your dev box</h1>
    <p class="lede">This machine comes with ClawDevbox &mdash; AI coding agents that run headlessly, on a schedule, with memory that compounds. Setup takes a couple of minutes.</p>
    <div class="checks" id="checks"><div class="check"><span class="spinner"></span>Checking this machine&hellip;</div></div>
    <div><button class="primary" id="go" disabled>Get started</button></div>
    <div id="envbanner"></div>
  </section>

  <section class="pane" data-p="1">
    <h1>Sign in to GitHub</h1>
    <p class="lede">One sign-in unlocks everything: it installs ClawDevbox and signs you in to GitHub Copilot CLI. Enter this code on the GitHub page that opens.</p>
    <div id="codebox"><div class="check"><span class="spinner"></span>Requesting a sign-in code&hellip;</div></div>
    <ol class="steps">
      <li>A GitHub tab opens automatically &mdash; if it doesn't, go to <b>github.com/login/device</b></li>
      <li>Enter the code above and approve access</li>
      <li>Come back here; this page continues on its own</li>
    </ol>
    <div id="signinbanner"></div>
  </section>

  <section class="pane" data-p="2">
    <h1>Installing ClawDevbox</h1>
    <p class="lede">Pulling the latest build, then opening the setup wizard.</p>
    <div class="prog"><i id="bar"></i></div>
    <pre class="console" id="log"></pre>
    <div id="instbanner"></div>
  </section>

  <div class="foot">Everything is logged to <code id="logpath"></code></div>
</div></div>

<script>
(function(){
  var $=function(i){return document.getElementById(i)};
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]})}
  function show(n){var p=document.querySelectorAll('.pane');for(var i=0;i<p.length;i++)p[i].classList.toggle('show',Number(p[i].dataset.p)===n)}
  var logEl=$('log');
  function line(t,c){var s=document.createElement('span');s.className=c||'';s.textContent=t+'\\n';logEl.appendChild(s);logEl.scrollTop=logEl.scrollHeight}

  var es=new EventSource('/api/stream');
  es.addEventListener('log',function(e){var d=JSON.parse(e.data);line(d.text,d.level==='error'?'e':d.level==='step'?'step':'')});
  es.addEventListener('phase',function(e){$('bar').style.width=JSON.parse(e.data).percent+'%'});
  es.addEventListener('signin',function(e){
    var d=JSON.parse(e.data);
    if(d.state==='code'){
      $('codebox').innerHTML='<div class="code">'+esc(d.code)+'</div><div><button class="copy" id="cp">Copy code</button></div>';
      $('cp').addEventListener('click',function(){navigator.clipboard.writeText(d.code);$('cp').textContent='Copied'});
    } else if(d.state==='done'){
      show(2);fetch('/api/install',{method:'POST'});
    } else if(d.state==='failed'){
      $('signinbanner').innerHTML='<div class="banner err">Sign-in failed: '+esc(d.error||'')+'. <button class="copy" onclick="location.reload()">Try again</button></div>';
    }
  });
  es.addEventListener('handoff',function(e){var d=JSON.parse(e.data);setTimeout(function(){location.href=d.url},900)});
  es.addEventListener('finish',function(e){
    var d=JSON.parse(e.data);
    if(!d.ok)$('instbanner').innerHTML='<div class="banner err">'+esc(d.error||'Setup failed.')+' Send the log file shown below.</div>';
  });

  fetch('/api/env').then(function(r){return r.json()}).then(function(env){
    $('logpath').textContent=env.logFile;
    var rows=[['Node.js',env.node.ok,env.node.version||'not found'],['Git',env.git.ok,env.git.version||'not found'],
              ['GitHub CLI',env.gh.ok,env.gh.version||'not found'],['Herdr',env.herdr.ok,env.herdr.version||'not installed'],
              ['ClawDevbox',env.clawdevbox.ok,env.clawdevbox.version||'installs next']];
    var h='';
    for(var i=0;i<rows.length;i++){
      var sym=rows[i][1]?'<span style="color:var(--ok)">&#9679;</span>':'<span style="color:var(--dim)">&#9675;</span>';
      h+='<div class="check"><span class="s">'+sym+'</span><span class="n">'+esc(rows[i][0])+'</span><span class="v">'+esc(rows[i][2])+'</span></div>';
    }
    $('checks').innerHTML=h;
    if(!env.node.ok||!env.gh.ok){
      $('envbanner').innerHTML='<div class="banner err">Node.js and the GitHub CLI should have been installed during provisioning but are missing. Send the log below.</div>';
    } else { $('go').disabled=false; }
    if(env.signedIn)$('go').textContent='Continue';
  }).catch(function(e){
    $('checks').innerHTML='<div class="banner err">Could not reach the setup service: '+esc(String(e))+'</div>';
  });

  $('go').addEventListener('click',function(){show(1);fetch('/api/signin',{method:'POST'})});
})();
</script></body></html>`;
}

// ---------------------------------------------------------------- the server

async function main() {
  if (flags['if-needed'] && flags.force !== true) {
    try {
      if (JSON.parse(readFileSync(STATE_FILE, 'utf8')).bootstrapped === true) {
        log('info', 'Bootstrap already completed — nothing to do.');
        return;
      }
    } catch { /* not completed yet */ }
  }

  await refreshPath();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (code, body) => {
      const s = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page());
      return;
    }
    if (url.pathname === '/api/env') {
      const [node, git, gh, herdr, claw] = await Promise.all([
        detect(process.execPath, ['--version'], 'node'),
        detect('git', ['--version'], 'git'),
        detect('gh', ['--version'], 'gh'),
        detect('herdr', ['--version'], 'herdr'),
        detect('clawdevbox', ['--version'], 'clawdevbox'),
      ]);
      const token = await capture('gh', ['auth', 'token'], 8000);
      json(200, { logFile: LOG_FILE, node, git, gh, herdr, clawdevbox: claw, signedIn: Boolean(token) });
      return;
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.pathname === '/api/signin' && req.method === 'POST') { json(202, { started: true }); void signIn(); return; }
    if (url.pathname === '/api/install' && req.method === 'POST') {
      json(202, { started: true });
      void installClawdevbox().then(() => { if (welcomeUrl) markComplete(); });
      return;
    }
    if (url.pathname === '/api/logfile') {
      let body = '';
      try { body = readFileSync(LOG_FILE, 'utf8'); } catch { body = 'log unavailable'; }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wanted = flags.port ? Number(flags.port) : 5320;
  await listenResilient(server, wanted);
  const target = `http://127.0.0.1:${server.address().port}/`;
  log('step', `Bootstrap ready at ${target}`);
  log('info', `Log file: ${LOG_FILE}`);

  if (flags['no-open'] !== true) openBrowser(target, flags.kiosk ? 'kiosk' : flags.tab ? 'tab' : 'app');
  else log('info', 'Not opening a browser (--no-open).');
}

/**
 * Bind `wanted`, falling back to an ephemeral port if it is taken.
 *
 * Without this, a single stale bootstrapper holding 5320 breaks first-run
 * FOREVER: `server.listen()` emits an unhandled 'error' on EADDRINUSE, which
 * kills the process before it can log anything or open a browser. That is
 * easy to hit because a Dev Box customization task runs in session 0 and its
 * orphaned server outlives every later sign-in.
 *
 * We do not try to reuse the squatter: it may be serving into an invisible
 * session, so the user still needs a window of their own.
 */
function listenResilient(server, wanted) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code !== 'EADDRINUSE') { reject(err); return; }
      log('warn', `Port ${wanted} is already in use — starting on a free port instead.`);
      server.removeListener('error', onError);
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    };
    server.once('error', onError);
    server.listen(wanted, '127.0.0.1', () => {
      server.removeListener('error', onError);
      server.once('error', (e) => log('warn', `HTTP server error: ${e.message}`));
      resolve();
    });
  });
}

/**
 * Record the setup window we just opened.
 *
 * We open the kiosk window here, but the developer finishes setup in
 * `clawdevbox welcome`, which we navigate this SAME window to. That process is
 * therefore not our child and has no other way to find it. Leaving the pid on
 * disk lets whoever finishes the flow close the window, instead of stranding a
 * kiosk window that has no tab strip and no close button.
 */
function recordBrowser(pid) {
  if (!pid) return;
  try {
    const p = join(dirname(LOG_DIR), 'browser.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch { /* best effort */ }
}

function openBrowser(url, mode) {  if (mode !== 'tab' && process.platform === 'win32') {
    const candidates = [
      `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    const exe = candidates.find((p) => existsSync(p));
    if (exe) {
      // Deliberately NOT a separate --user-data-dir. On a managed machine a
      // fresh profile triggers force-installed enterprise extensions, whose
      // onboarding pages open on top of (or instead of) the setup window.
      // Using the default profile keeps the app window in front, and
      // --disable-extensions keeps it clean either way.
      const args = mode === 'kiosk'
        ? ['--kiosk', url, '--edge-kiosk-type=fullscreen', '--no-first-run',
           '--no-default-browser-check', '--disable-extensions', '--disable-features=msEdgeIdentityFre']
        : [`--app=${url}`, '--start-maximized', '--no-first-run',
           '--no-default-browser-check', '--disable-extensions', '--disable-features=msEdgeIdentityFre'];
      try {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
        recordBrowser(child.pid);
        child.unref();
        log('info', `Opened the setup experience full-screen (${mode} mode).`);
        return;
      } catch (err) { log('warn', `Could not launch ${exe}: ${err.message}`); }
    } else {
      log('info', 'Edge/Chrome not found — falling back to the default browser.');
    }
  }
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '""', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log('info', `Opened ${url} in the default browser.`);
  } catch (err) { log('warn', `Could not open a browser: ${err.message}. Open ${url} manually.`); }
}

main().catch((err) => { log('error', `Bootstrap failed: ${err.stack ?? err.message}`); process.exitCode = 1; });

