/**
 * tests/live/probes.mjs — NON-MOCKED live probes for the three real local
 * trigger scripts, wired to the REAL configured resources on this box.
 *
 * Unlike tests/local-trigger-functional.test.mjs (which sandboxes everything
 * behind a loopback and throwaway temp dirs), these probes deliberately touch
 * the live system to prove end-to-end viability:
 *
 *   1. local.recipe-cron — the installed global script at
 *      ~/.clawdevbox/trigger-types/local.recipe-cron/trigger.ts, driven with a
 *      REAL recipe id that must independently resolve through the running MCP
 *      server's `recipe.template.list`, executed in EMPTY-spawn_url DRY-RUN so
 *      no agent is ever spawned.
 *   2. local.vault-test — the real team-vault script discovered from the vault
 *      chain in ~/.clawdevbox/config.json, its type confirmed present through
 *      the live MCP `trigger.type.list`, run with a Unicode state payload.
 *   3. memory-sync — the git-tracked script, pointed at the REAL vault chain,
 *      run with auto_push=false and a loopback callback recorder so the
 *      spawned agent is captured (prompt only) and never actually syncs/pushes.
 *      Verifies the memory-sync registration row + FK in the live DB and
 *      asserts NO git ref on any real vault moved before/after.
 *
 * SAFETY INVARIANTS (all enforced, none mocked away):
 *   - recipe-cron runs dry (empty spawn_url) → zero network, zero spawn.
 *   - vault-test only echoes stdin → zero side effects.
 *   - memory-sync's spawn_url is a loopback recorder that returns {ok:true};
 *     the "agent" is never a real agent, so no vault is committed/pulled/pushed.
 *   - Every real vault's HEAD + ref set is captured before and after and MUST
 *     be identical, or the memory-sync probe fails loudly.
 *
 * These are OPT-IN. Nothing here runs unless CDB_LIVE_PROBE=1 (the node:test
 * wrapper skips, and the scripts/live-local-probe.mjs runner refuses).
 */
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER_DIR = resolve(HERE, '..', '..');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// --------------------------------------------------------------------------
// Real global config / coordinates
// --------------------------------------------------------------------------

export function globalDir() {
  return process.env.CLAWDEVBOX_GLOBAL_DIR || join(homedir(), '.clawdevbox');
}

export function loadConfig() {
  const p = join(globalDir(), 'config.json');
  if (!existsSync(p)) throw new Error(`global config not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function recipeCronScript() {
  return (
    process.env.CDB_RECIPE_CRON_TRIGGER ||
    join(globalDir(), 'trigger-types', 'local.recipe-cron', 'trigger.ts')
  );
}

/** Resolve the team vault + its local.vault-test script from the real config. */
export function vaultTestScript(cfg) {
  if (process.env.CDB_VAULT_TEST_TRIGGER) return process.env.CDB_VAULT_TEST_TRIGGER;
  const team = (cfg.vaults ?? []).find((v) => v.kind === 'team' && v.path);
  if (!team) throw new Error('no team vault configured in config.json');
  return join(team.path, 'trigger-types', 'local.vault-test', 'trigger.ts');
}

export function memorySyncScript() {
  return resolve(MCP_SERVER_DIR, 'trigger-types', 'memory-sync', 'trigger.ts');
}

// --------------------------------------------------------------------------
// Sanitization — never leak private remote URLs into the report
// --------------------------------------------------------------------------

/**
 * Replace anything that looks like a git remote / URL with a stable,
 * non-reversible token so the report stays shareable. Keeps the scheme+host
 * class visible for humans but redacts org/project/repo path + any userinfo.
 */
export function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return url;
  const sha = createHash('sha256').update(url).digest('hex').slice(0, 8);
  try {
    const u = new URL(url);
    // Loopback / localhost URLs are not sensitive — keep them readable.
    if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) return url;
    return `${u.protocol}//<redacted-host>/<redacted-path>#${sha}`;
  } catch {
    return `<redacted-url>#${sha}`;
  }
}

export function sanitizeDeep(value) {
  if (typeof value === 'string') {
    // Redact anything with a scheme:// (URLs) but leave plain paths alone.
    return /[a-z]+:\/\//i.test(value) ? value.replace(/[a-z]+:\/\/\S+/gi, (m) => sanitizeUrl(m)) : value;
  }
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

// --------------------------------------------------------------------------
// Minimal live MCP client (Streamable HTTP JSON-RPC, run_tool wrapper)
// --------------------------------------------------------------------------

function parseSseOrJson(text) {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { /* fall through */ } }
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') { try { return JSON.parse(payload); } catch { /* keep scanning */ } }
    }
  }
  return null;
}

export class LiveMcpClient {
  constructor(cfg) {
    const host = cfg?.http?.host ?? '127.0.0.1';
    const port = cfg?.http?.port ?? 5201;
    this.url = process.env.CDB_LIVE_MCP_URL || `http://${host}:${port}/mcp`;
    this.projectDir = process.env.CDB_LIVE_MCP_PROJECT_DIR || MCP_SERVER_DIR;
    this.bearer = process.env.CLAWDEVBOX_MCP_SECRET || null;
    this.sessionId = null;
    this.nextId = 1;
  }

  headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Clawdevbox-Project-Dir': this.projectDir,
    };
    if (this.bearer) h.Authorization = `Bearer ${this.bearer}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async rpc(method, params, notif = false) {
    const body = notif
      ? { jsonrpc: '2.0', method, params: params || {} }
      : { jsonrpc: '2.0', id: this.nextId++, method, params: params || {} };
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`HTTP ${res.status} on ${method}: ${text.slice(0, 300)}`);
    const sid = res.headers.get('mcp-session-id');
    if (sid && !this.sessionId) this.sessionId = sid;
    return parseSseOrJson(text);
  }

  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'live-local-probe', version: '1.0' },
    });
    if (!this.sessionId) throw new Error('initialize returned no mcp-session-id');
    await this.rpc('notifications/initialized', {}, true);
  }

  async callTool(tool, args) {
    const resp = await this.rpc('tools/call', { name: 'run_tool', arguments: { tool, args: args || {} } });
    if (resp && resp.error) throw new Error(`run_tool ${tool} error: ${JSON.stringify(resp.error)}`);
    const result = resp && resp.result;
    if (result && result.isError) {
      const t = result.content?.find((c) => c.type === 'text')?.text ?? '';
      throw new Error(`tool ${tool} isError: ${t}`);
    }
    return structured(result);
  }

  async close() {
    if (!this.sessionId) return;
    try { await fetch(this.url, { method: 'DELETE', headers: this.headers() }); } catch { /* best-effort */ }
  }
}

function structured(result) {
  if (result?.structuredContent) return result.structuredContent;
  const txt = result?.content?.find((c) => c.type === 'text')?.text;
  try { return JSON.parse(txt); } catch { return { _text: txt }; }
}

// --------------------------------------------------------------------------
// Script harness + loopback recorder
// --------------------------------------------------------------------------

/** Spawn a real trigger .ts through node+tsx with `envelope` on stdin. */
export function runScript(scriptPath, envelope, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: MCP_SERVER_DIR, // so tsx resolves from mcp-server/node_modules
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { /* blocking-error path */ }
      resolvePromise({ code, stdout, stderr, parsed });
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

/** A real loopback HTTP server standing in for spawn_url/callback_url. */
async function startRecorder() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      let json;
      try { json = body ? JSON.parse(body) : null; } catch { json = body; }
      calls.push({ method: req.method, url: req.url, body: json });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, session_id: 'loopback-recorder' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/spawn`, calls, stop: () => new Promise((r) => server.close(() => r())) };
}

function freshOutDir() {
  return mkdtempSync(join(tmpdir(), 'cdb-live-probe-out-'));
}
function cleanDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// --------------------------------------------------------------------------
// Git ref snapshotting (read-only) for the no-mutation invariant
// --------------------------------------------------------------------------

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
}

/** Full ref fingerprint for a repo: HEAD + branch + every ref sha + reflog top. */
export function refSnapshot(repoPath) {
  if (!existsSync(join(repoPath, '.git'))) return { git: false };
  return {
    git: true,
    head: git(repoPath, ['rev-parse', 'HEAD']),
    branch: git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    refs: git(repoPath, ['for-each-ref', '--format=%(refname) %(objectname)']),
    reflogTop: git(repoPath, ['reflog', '-n', '1', '--format=%H']),
    dirty: git(repoPath, ['status', '--porcelain']).length > 0,
  };
}

// --------------------------------------------------------------------------
// Check helpers — every probe returns { name, ok, checks[], evidence }
// --------------------------------------------------------------------------

function mkResult(name) {
  const checks = [];
  return {
    name,
    checks,
    evidence: {},
    check(label, ok, detail) { checks.push({ label, ok: !!ok, detail: detail ?? null }); return ok; },
    get ok() { return checks.length > 0 && checks.every((c) => c.ok); },
  };
}

function finalize(r) {
  return { name: r.name, ok: r.ok, checks: r.checks, evidence: r.evidence };
}

const TODAY = () => new Date().toISOString().slice(0, 10);

// ==========================================================================
// PROBE 1 — local.recipe-cron (dry-run against a REAL recipe id)
// ==========================================================================
export async function probeRecipeCron(cfg, mcp) {
  const r = mkResult('local.recipe-cron');
  const script = recipeCronScript();
  r.evidence.script = script;
  if (!r.check('installed script present', existsSync(script), script)) return finalize(r);

  // Pick a REAL recipe id from a registered local.recipe-cron instance if we
  // can read the DB, else fall back to a known template; either way it MUST
  // independently resolve through the live MCP recipe.template.list.
  let recipeId = process.env.CDB_LIVE_RECIPE_ID || 'forge-bug-triage-sweep';
  let recipeInputs = { repo: 'clawdevbox', severity: 'high' };
  try {
    const row = readRegisteredRecipeCron();
    if (row) {
      recipeId = row.recipe_id ?? recipeId;
      recipeInputs = row.recipe_inputs ?? recipeInputs;
      r.evidence.registered_instance = row.id;
    }
  } catch { /* DB optional; template fallback stands */ }
  r.evidence.recipe_id = recipeId;

  // (a) Independent resolution through the LIVE MCP.
  try {
    const list = await mcp.callTool('recipe.template.list', { search: recipeId });
    const match = (list.recipes ?? []).find((x) => x.id === recipeId);
    r.check('recipe id resolves via live MCP recipe.template.list', !!match,
      match ? `scope=${match.scope} steps=${match.step_count}` : `not found (count=${list.count})`);
    if (match) r.evidence.resolved = { scope: match.scope, step_count: match.step_count, name: match.name };
  } catch (e) {
    r.check('recipe id resolves via live MCP recipe.template.list', false, String(e.message || e));
  }

  // (b) Execute the real script in DRY-RUN (empty spawn_url).
  const outDir = freshOutDir();
  try {
    const { code, parsed, stderr } = await runScript(script, {
      trigger_event_name: 'TriggerFired',
      trigger_id: 'live-probe-recipe-cron',
      run_id: 'live_dry',
      output_dir: outDir,
      spawn_url: '', // dry-run: no agent spawn, no network
      fired_by: 'manual',
      state: {
        recipe_id: recipeId,
        recipe_inputs: recipeInputs,
        session_id_prefix: 'live-probe',
        provider: 'copilot',
      },
      payload: null,
    });

    r.check('dry-run exits 0', code === 0, `code=${code} stderr=${stderr.slice(0, 200)}`);
    r.check('stdout flags dry_run=true', parsed?.dry_run === true, JSON.stringify(parsed?.dry_run));
    r.check('emits planned observation', !!parsed?.planned, parsed?.planned ? 'present' : 'missing');
    r.check('planned prompt references recipe.instance.begin with the real id',
      typeof parsed?.planned?.prompt === 'string' &&
      parsed.planned.prompt.includes(`recipe.instance.begin({ template_id: "${recipeId}"`),
      'prompt template check');
    r.check('state.lastPlannedAt is ISO', ISO_RE.test(parsed?.state?.lastPlannedAt ?? ''), parsed?.state?.lastPlannedAt);
    r.check('dry-run must NOT set lastFiredAt', parsed?.state?.lastFiredAt === undefined, String(parsed?.state?.lastFiredAt));

    const obsPath = join(outDir, 'recipe-cron.json');
    const obs = existsSync(obsPath) ? JSON.parse(readFileSync(obsPath, 'utf8')) : null;
    r.check('observation file written', !!obs, obsPath);
    r.check('observation.will_post=false in dry-run', obs?.will_post === false, String(obs?.will_post));
    r.check('observation.recipe_id matches', obs?.recipe_id === recipeId, obs?.recipe_id);
    r.evidence.session_id = obs?.session_id;
    r.evidence.observation_will_post = obs?.will_post;
  } finally {
    cleanDir(outDir);
  }
  return finalize(r);
}

// ==========================================================================
// PROBE 2 — local.vault-test (real team-vault script + Unicode state)
// ==========================================================================
export async function probeVaultTest(cfg, mcp) {
  const r = mkResult('local.vault-test');
  const script = vaultTestScript(cfg);
  r.evidence.script = script;
  const team = (cfg.vaults ?? []).find((v) => v.kind === 'team' && v.path);
  r.evidence.team_vault = team ? { id: team.id, path: team.path } : null;
  if (!r.check('team-vault script present', existsSync(script), script)) return finalize(r);

  // (a) Type discovery through the LIVE MCP.
  try {
    const types = await mcp.callTool('trigger.type.list', {});
    const ids = (types.trigger_types ?? []).map((t) => t.id);
    r.check('local.vault-test discovered via live MCP trigger.type.list', ids.includes('local.vault-test'),
      `types=[${ids.join(', ')}]`);
    r.check('trigger type catalog has no load errors', (types.load_errors ?? []).length === 0,
      JSON.stringify(types.load_errors ?? []));
    r.evidence.discovered_types = ids;
  } catch (e) {
    r.check('local.vault-test discovered via live MCP trigger.type.list', false, String(e.message || e));
  }

  // (b) Execute the real script with a Unicode state payload.
  const unicodeState = { greeting: 'héllo 🌍 日本語', 'ключ': 'значение', emoji: '✅⚠️🚀' };
  const { code, parsed, stderr } = await runScript(script, {
    trigger_event_name: 'TriggerFired',
    trigger_id: 'live-probe-vault-test',
    run_id: 'live_unicode',
    output_dir: freshOutDir(),
    spawn_url: '',
    fired_by: 'manual',
    state: unicodeState,
    payload: null,
  });
  r.check('vault-test exits 0', code === 0, `code=${code} stderr=${stderr.slice(0, 200)}`);
  r.check('stdout echoes Unicode state byte-for-byte',
    parsed && JSON.stringify(parsed.state) === JSON.stringify(unicodeState),
    JSON.stringify(parsed?.state));
  r.check('systemMessage present', typeof parsed?.systemMessage === 'string' && parsed.systemMessage.length > 0,
    parsed?.systemMessage);
  r.evidence.echoed_state = parsed?.state;
  return finalize(r);
}

// ==========================================================================
// PROBE 3 — memory-sync (real vault chain, auto_push=false, no mutation)
// ==========================================================================
export async function probeMemorySync(cfg, mcp) {
  const r = mkResult('memory-sync');
  const script = memorySyncScript();
  r.evidence.script = script;
  if (!r.check('memory-sync script present', existsSync(script), script)) return finalize(r);

  // (a) Inspect the REAL vault chain (paths + remotes + branch), sanitized.
  const vaults = (cfg.vaults ?? []).map((v) => ({
    id: v.id, kind: v.kind, path: v.path,
    remote: v.remote ? sanitizeUrl(v.remote) : null,
    branch: v.branch ?? null,
  }));
  r.evidence.vault_chain = vaults;
  r.check('config declares a vault chain', vaults.length > 0, `count=${vaults.length}`);

  // (b) Verify the memory-sync registration row + FK integrity in the live DB.
  try {
    const reg = readMemorySyncRegistration();
    r.evidence.registration = reg.rows;
    r.check('memory-sync trigger registered in live DB', reg.rows.length > 0, `rows=${reg.rows.length}`);
    r.check('every memory-sync row FK -> existing workspace', reg.fkOk,
      reg.fkOk ? 'all workspace_id references resolve' : `dangling: ${reg.dangling.join(', ')}`);
    r.check('registration state_json seeds vault_scope+auto_push', reg.stateSeeded,
      JSON.stringify(reg.stateSample));
  } catch (e) {
    r.check('memory-sync registration inspected via live DB', false, String(e.message || e));
  }

  // (c) Snapshot every real vault's git refs BEFORE.
  const before = {};
  for (const v of cfg.vaults ?? []) before[v.id] = refSnapshot(v.path);
  r.evidence.refs_before = before;

  // (d) Run the real script with auto_push=false + loopback recorder.
  const recorder = await startRecorder();
  try {
    const { code, parsed, stderr } = await runScript(script, {
      trigger_id: 'live-probe-memory-sync',
      run_id: 'live_dry',
      output_dir: freshOutDir(),
      spawn_url: recorder.url,     // loopback recorder — NOT a real agent
      callback_url: recorder.url,
      fired_by: 'manual',
      state: { vault_scope: 'all', auto_push: false },
      payload: null,
    });
    r.check('memory-sync exits 0', code === 0, `code=${code} stderr=${stderr.slice(0, 200)}`);
    r.check('exactly one spawn POST captured by recorder', recorder.calls.length === 1, `calls=${recorder.calls.length}`);
    const call = recorder.calls[0];
    r.check('POST method', call?.method === 'POST', call?.method);
    r.check('prompt honors auto_push=false ("Auto-push: no")',
      typeof call?.body?.prompt === 'string' && /Auto-push:\s*no/i.test(call.body.prompt), 'prompt check');
    r.check('prompt selects personal + team vaults',
      typeof call?.body?.prompt === 'string' && /personal,\s*team/i.test(call.body.prompt), 'vault selection');
    r.check('context.vault_scope=all', call?.body?.context?.vault_scope === 'all', call?.body?.context?.vault_scope);
    r.check('session_id = memory-sync-<today>', call?.body?.session_id === `memory-sync-${TODAY()}`, call?.body?.session_id);
    r.check('state.lastFiredAt is ISO', ISO_RE.test(parsed?.state?.lastFiredAt ?? ''), parsed?.state?.lastFiredAt);
    r.check('state.auto_push stays false', parsed?.state?.auto_push === false, String(parsed?.state?.auto_push));
    r.evidence.recorded_prompt = call?.body?.prompt;
  } finally {
    await recorder.stop();
  }

  // (e) Snapshot AFTER — assert NOTHING moved on any real vault.
  const after = {};
  for (const v of cfg.vaults ?? []) after[v.id] = refSnapshot(v.path);
  r.evidence.refs_after = after;
  let unchanged = true;
  const moved = [];
  for (const v of cfg.vaults ?? []) {
    const b = before[v.id]; const a = after[v.id];
    if (JSON.stringify(b) !== JSON.stringify(a)) { unchanged = false; moved.push(v.id); }
  }
  r.check('no git ref changed on any real vault (no commit/pull/push happened)', unchanged,
    moved.length ? `moved: ${moved.join(', ')}` : 'all vault refs identical before/after');

  return finalize(r);
}

// --------------------------------------------------------------------------
// Live DB readers (read-only)
// --------------------------------------------------------------------------

function openDbReadonly() {
  // Resolve better-sqlite3 from mcp-server/node_modules regardless of caller cwd.
  const Database = nodeRequire('better-sqlite3');
  const dbPath = join(globalDir(), 'clawdevbox.db');
  if (!existsSync(dbPath)) throw new Error(`live DB not found: ${dbPath}`);
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function readRegisteredRecipeCron() {
  const db = openDbReadonly();
  try {
    const rows = db.prepare("SELECT id, state_json FROM triggers WHERE type='local.recipe-cron' AND enabled IN (0,1) ORDER BY id").all();
    if (!rows.length) return null;
    const row = rows[0];
    const st = JSON.parse(row.state_json || '{}');
    return { id: row.id, recipe_id: st.recipe_id, recipe_inputs: st.recipe_inputs };
  } finally { db.close(); }
}

function readMemorySyncRegistration() {
  const db = openDbReadonly();
  try {
    const rows = db.prepare("SELECT id, workspace_id, type, state_json, params_json FROM triggers WHERE type='memory-sync'").all();
    const dangling = [];
    for (const row of rows) {
      const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(row.workspace_id);
      if (!ws) dangling.push(row.id);
    }
    let stateSeeded = rows.length > 0;
    let stateSample = null;
    for (const row of rows) {
      const st = JSON.parse(row.state_json || '{}');
      if (row === rows[0]) stateSample = { vault_scope: st.vault_scope, auto_push: st.auto_push };
      if (st.vault_scope === undefined || st.auto_push === undefined) stateSeeded = false;
    }
    return {
      rows: rows.map((x) => ({ id: x.id, workspace_id: x.workspace_id })),
      fkOk: dangling.length === 0,
      dangling,
      stateSeeded,
      stateSample,
    };
  } finally { db.close(); }
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------

export async function runAllProbes() {
  const cfg = loadConfig();
  const mcp = new LiveMcpClient(cfg);
  let mcpOk = true;
  let mcpErr = null;
  try { await mcp.init(); } catch (e) { mcpOk = false; mcpErr = String(e.message || e); }

  const results = [];
  results.push(await probeRecipeCron(cfg, mcp));
  results.push(await probeVaultTest(cfg, mcp));
  results.push(await probeMemorySync(cfg, mcp));
  await mcp.close();

  const report = {
    schema: 'cdb.live-local-probe/v1',
    generated_at: new Date().toISOString(),
    host: { global_dir: globalDir(), mcp_url: mcp.url, mcp_reachable: mcpOk, mcp_error: mcpErr },
    probes: results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).map((r) => r.name),
    },
    ok: results.every((r) => r.ok),
  };
  return sanitizeDeep(report);
}
