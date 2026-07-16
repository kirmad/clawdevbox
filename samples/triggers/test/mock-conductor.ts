#!/usr/bin/env tsx
/**
 * mock-clawdevbox.ts
 *
 * A local HTTP mock of the Clawdevbox sidecar's webhook + callback endpoints.
 * Used to prove that the trigger scripts (ado-comment-watcher.ts/.py) work
 * end-to-end against real Azure DevOps without needing a real Clawdevbox.
 *
 * Supports BOTH script protocol modes (spec §8.4):
 *
 *   Mode A — script writes a JSON response on stdout with an optional
 *            singular `callback: { body: ... }` object. After the subprocess
 *            exits 0, this mock delivers that one entry to the trigger's
 *            pre-bound callback URL (using the same internal capture path
 *            that Mode B uses). At most one Mode A delivery per run.
 *   Mode B — script POSTs to /callback/<...> directly while running. The
 *            catch-all /callback/* handler captures these in the same list.
 *
 * Mixed Mode A + Mode B in a single run is allowed and works correctly —
 * both paths feed the same captured-callbacks list.
 *
 * Endpoints
 * ---------
 *
 * Inbound (the trigger script's webhook fires here):
 *   POST /hooks/<trigger-id>
 *     Body: optional JSON.
 *     Side effect: spawns the configured trigger command as a subprocess,
 *                  pipes a JSON envelope to its stdin, captures stdout/stderr.
 *                  On exit 0, parses stdout as JSON; if it contains a
 *                  singular `callback` object, delivers that one entry to
 *                  the trigger's callback URL (Mode A).
 *     Returns: 200 { run_id, duration_ms, exit_code, stdout, stderr }
 *              500 if the script exits non-zero.
 *
 * Outbound (Mode B scripts POST to these directly — Mode A populates the
 * same list internally — these are what tests assert on):
 *   POST /callback/threads/<thread-id>/resume
 *   POST /callback/templates/<template>/run
 *   POST /callback/threads/<parent>/spawn-sub/<template>
 *   POST /callback/* (catch-all for any path/body)
 *     Body: { prompt, context? }
 *     Side effect: appends to the in-memory captured-callbacks list.
 *     Returns: 200 { ok: true }
 *
 * Test introspection:
 *   GET  /test/received-callbacks → captured list
 *   POST /test/reset → clears the captured list
 *   GET  /test/health → liveness ping
 *   POST /test/configure-trigger → register a trigger id → command mapping
 *
 * Auth
 * ----
 *
 * /hooks/* and /callback/* require Authorization: Bearer <secret>.
 * Secret is read from CLAWDEVBOX_MCP_SECRET env, or generated fresh per launch
 * and printed to stdout.
 *
 * Port
 * ----
 *
 * Picks a random free port at startup, prints it to stdout in a parseable
 * banner: "MOCK_CLAWDEVBOX_READY {port} {secret}".
 *
 * Usage
 * -----
 *
 *   tsx mock-clawdevbox.ts [--config path/to/config.json]
 *
 * Or imported as a module:
 *
 *   import { startMockClawdevbox } from './mock-clawdevbox.ts';
 *   const { port, secret, close, getCallbacks, resetCallbacks } = await startMockClawdevbox({...});
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve as pathResolve, join as pathJoin } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface TriggerConfig {
  /** Trigger id, e.g. "ado-comments-thr_TEST". Forms the path /hooks/<id>. */
  id: string;
  /** Argv to spawn. e.g. ["tsx", "/abs/path/ado-comment-watcher.ts"] or ["python", "/abs/path/ado-comment-watcher.py"]. */
  command: string[];
  /** State to inject into the envelope. */
  state: Record<string, unknown>;
  /** Optional subscriber thread id (for hot triggers). */
  subscriberThreadId?: string | null;
  /** Path the script should POST callbacks to (the routing-baked URL). */
  callbackPath: string;
  /** Optional cwd for the subprocess. */
  cwd?: string;
  /** Optional extra env to inject into the subprocess. */
  extraEnv?: Record<string, string>;
  /** Optional timeout in ms for the subprocess. Default 30s. */
  timeoutMs?: number;
  /**
   * Registry scope. `"project"` for triggers registered directly by the user
   * (default — matches the legacy registration path that scenarios A-F
   * exercise). `"plugin:<id>"` for triggers discovered from a plugin manifest
   * by `loadPlugin` / `POST /test/load-plugin`. Scenario G asserts on this.
   */
  scope?: string;
}

/** Minimal shape of the per-trigger registry returned by `GET /test/triggers`. */
export interface TriggerRegistryEntry {
  id: string;
  scope: string;
  command: string[];
  callbackPath: string;
  subscriberThreadId: string | null;
  cron: string | null;
}

export interface CapturedCallback {
  path: string;
  body: unknown;
  rawBody: string;
  authHeader: string | null;
  receivedAt: number;
  /**
   * How the callback reached the captured list:
   *   - 'mode-b': the trigger script POSTed it directly to /callback/* during its run
   *   - 'mode-a-stdout': the script returned it as a singular `callback` on
   *                      stdout; the mock-clawdevbox delivered it internally
   *                      after the subprocess exited
   * Mixed-mode triggers (e.g. ado-pr-pulse-watcher.ts) emit both kinds in a
   * single run; tests that need to assert on the mode use this field.
   */
  delivered_via: 'mode-b' | 'mode-a-stdout';
}

export interface MockServerHandle {
  port: number;
  secret: string;
  url: string;
  /** Full URL prefix for callbacks (no trailing slash). Used by trigger scripts as callback_url base. */
  callbackBase: string;
  close: () => Promise<void>;
  getCallbacks: () => CapturedCallback[];
  resetCallbacks: () => void;
  setTrigger: (cfg: TriggerConfig) => void;
  removeTrigger: (id: string) => void;
  /**
   * Discover the plugin at `pluginDir`, parse its `plugin.yaml`, and register
   * each entry under `provides.triggers` as a TriggerConfig with
   * `scope: "plugin:<id>"`. Returns the registered trigger ids.
   *
   * The plugin's bundled `triggers.json` file (if present, alongside the .ts
   * files) is consulted to recover the resolved spawn command, but it is not
   * required — the manifest's `triggers[i].file` is the source of truth.
   *
   * Each trigger's callbackPath defaults to
   *   /callback/plugins/<plugin-id>/triggers/<trigger-id>/resume
   * which mirrors the routing-baked URL that real Clawdevbox would produce
   * when a plugin trigger fires (no subscriber thread → plugin-scope route).
   */
  loadPlugin: (pluginDir: string) => Promise<string[]>;
  /** Snapshot of every registered trigger and its scope. */
  getTriggers: () => TriggerRegistryEntry[];
}

export interface StartOptions {
  /** Override secret. Defaults to CLAWDEVBOX_MCP_SECRET env or random. */
  secret?: string;
  /** Initial trigger registrations. */
  triggers?: TriggerConfig[];
  /** Port to bind. 0 (default) picks a free port. */
  port?: number;
  /** Inherit subprocess stderr to parent (default true so failures are visible). */
  inheritStderr?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function generateSecret(): string {
  return randomBytes(24).toString('base64url');
}

function generateRunId(): string {
  return `run_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function checkAuth(req: IncomingMessage, secret: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const expected = `Bearer ${secret}`;
  // Constant-time compare not strictly required for a test harness, but cheap to do safely
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ============================================================================
// Trigger subprocess runner
// ============================================================================

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function runTrigger(
  cfg: TriggerConfig,
  envelope: Record<string, unknown>,
  baseEnv: Record<string, string>,
  inheritStderr: boolean,
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const start = Date.now();
    const [cmd, ...args] = cfg.command;
    const child = spawn(cmd, args, {
      cwd: cfg.cwd,
      env: { ...process.env, ...baseEnv, ...(cfg.extraEnv ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, .cmd shims (like tsx) require a shell.
      shell: process.platform === 'win32',
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      if (inheritStderr) process.stderr.write(`[trigger:${cfg.id}] ${chunk}`);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, cfg.timeoutMs ?? 30_000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode: -1,
        stdout: stdoutBuf,
        stderr: stderrBuf + `\nspawn error: ${err.message}`,
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveRun({
        exitCode: code ?? -1,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        durationMs: Date.now() - start,
        timedOut,
      });
    });

    // Write envelope to stdin
    try {
      child.stdin.write(JSON.stringify(envelope));
      child.stdin.end();
    } catch (err) {
      // ignore — child may have already crashed
    }
  });
}

// ============================================================================
// Plugin manifest parsing
//
// Real Clawdevbox uses a proper YAML parser. The test harness has a zero-deps
// constraint (Node built-ins only), so we hand-roll a tiny parser that
// understands the subset of YAML the plugin manifests actually use:
//   - scalar key: value pairs
//   - block-style list items (`- key: val` / `- { id: x, file: y }`)
//   - inline-flow objects (`{ key: val, key: val }`)
//   - simple block-scalar `>` folded strings
//   - `#` comments
//   - quoted strings ("...") on values
//
// This is intentionally minimal — it parses every fixture we ship. If a
// future plugin manifest grows complexity beyond this shape, callers should
// pre-process the manifest to JSON or vendor in a YAML lib.
// ============================================================================

interface PluginManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  provides?: {
    triggers?: Array<{ id: string; file: string; cron?: string }>;
    recipes?: Array<{ id: string; file: string }>;
    skills?: Array<{ id: string; file: string }>;
    mcp_servers?: Array<{ id: string; file: string }>;
  };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineObject(src: string): Record<string, string> {
  // `{ id: x, file: y, cron: "..." }` → { id: 'x', file: 'y', cron: '...' }
  const inner = src.trim().replace(/^\{/, '').replace(/\}$/, '');
  const out: Record<string, string> = {};
  // Split on commas not inside quotes.
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  let inQuote: string | null = null;
  for (const ch of inner) {
    if (inQuote) {
      buf += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inQuote = ch; buf += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const colonIdx = p.indexOf(':');
    if (colonIdx < 0) continue;
    const k = p.slice(0, colonIdx).trim();
    const v = stripQuotes(p.slice(colonIdx + 1).trim());
    out[k] = v;
  }
  return out;
}

interface YamlLine {
  raw: string;
  indent: number;
  text: string;
  isComment: boolean;
}

function tokenize(src: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const stripped = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (stripped.trim().length === 0) continue;
    let indent = 0;
    while (indent < stripped.length && stripped[indent] === ' ') indent++;
    out.push({ raw, indent, text: stripped.slice(indent), isComment: false });
  }
  return out;
}

function parsePluginYaml(src: string): PluginManifest {
  const lines = tokenize(src);
  const manifest: PluginManifest = { id: '' };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== 0) { i++; continue; }
    const colonIdx = line.text.indexOf(':');
    if (colonIdx < 0) { i++; continue; }
    const key = line.text.slice(0, colonIdx).trim();
    const rawValue = line.text.slice(colonIdx + 1).trim();

    if (key === 'provides') {
      const provides: NonNullable<PluginManifest['provides']> = {};
      i++;
      while (i < lines.length && lines[i].indent > 0) {
        const sub = lines[i];
        if (sub.indent === 2) {
          // sub-key like `triggers:` / `recipes:` etc.
          const subColon = sub.text.indexOf(':');
          if (subColon < 0) { i++; continue; }
          const subKey = sub.text.slice(0, subColon).trim();
          i++;
          // Collect list items at indent > 2 until next sub-key.
          const items: Array<Record<string, string>> = [];
          while (i < lines.length && lines[i].indent > 2) {
            const item = lines[i];
            if (item.text.startsWith('- ')) {
              const afterDash = item.text.slice(2).trim();
              if (afterDash.startsWith('{')) {
                items.push(parseInlineObject(afterDash));
                i++;
              } else {
                // block-style item: `- id: foo` then deeper indented `file: bar` / `cron: ...`
                const itemFields: Record<string, string> = {};
                const firstColon = afterDash.indexOf(':');
                if (firstColon >= 0) {
                  itemFields[afterDash.slice(0, firstColon).trim()] = stripQuotes(afterDash.slice(firstColon + 1).trim());
                }
                const itemIndent = item.indent;
                i++;
                while (i < lines.length && lines[i].indent > itemIndent) {
                  const fieldLine = lines[i];
                  if (fieldLine.text.startsWith('- ')) break; // next sibling
                  const fc = fieldLine.text.indexOf(':');
                  if (fc >= 0) {
                    itemFields[fieldLine.text.slice(0, fc).trim()] =
                      stripQuotes(fieldLine.text.slice(fc + 1).trim());
                  }
                  i++;
                }
                items.push(itemFields);
              }
            } else {
              i++; // unexpected — skip
            }
          }
          // Map collected items into the manifest shape.
          if (subKey === 'triggers') {
            provides.triggers = items
              .filter((it) => it.id && it.file)
              .map((it) => ({ id: it.id, file: it.file, cron: it.cron }));
          } else if (subKey === 'recipes') {
            provides.recipes = items
              .filter((it) => it.id && it.file)
              .map((it) => ({ id: it.id, file: it.file }));
          } else if (subKey === 'skills') {
            provides.skills = items
              .filter((it) => it.id && it.file)
              .map((it) => ({ id: it.id, file: it.file }));
          } else if (subKey === 'mcp_servers') {
            provides.mcp_servers = items
              .filter((it) => it.id && it.file)
              .map((it) => ({ id: it.id, file: it.file }));
          }
        } else {
          i++;
        }
      }
      manifest.provides = provides;
      continue;
    }

    // Folded scalar (`description: >` / `description: |`)
    if (rawValue === '>' || rawValue === '|') {
      i++;
      const folded: string[] = [];
      const blockIndent = (lines[i]?.indent ?? 0);
      while (i < lines.length && lines[i].indent >= blockIndent && blockIndent > 0) {
        folded.push(lines[i].text);
        i++;
      }
      (manifest as unknown as Record<string, unknown>)[key] = folded.join(' ');
      continue;
    }

    // Scalar
    (manifest as unknown as Record<string, unknown>)[key] = stripQuotes(rawValue);
    i++;
  }

  if (!manifest.id) {
    throw new Error('plugin manifest is missing required `id` field');
  }
  return manifest;
}

async function loadPluginManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = pathJoin(pluginDir, 'plugin.yaml');
  try {
    await stat(manifestPath);
  } catch {
    throw new Error(`plugin.yaml not found at ${manifestPath}`);
  }
  const src = await readFile(manifestPath, 'utf8');
  return parsePluginYaml(src);
}

// ============================================================================
// Server
// ============================================================================

export async function startMockClawdevbox(opts: StartOptions = {}): Promise<MockServerHandle> {
  const secret = opts.secret ?? process.env.CLAWDEVBOX_MCP_SECRET ?? generateSecret();
  const inheritStderr = opts.inheritStderr ?? true;
  const callbacks: CapturedCallback[] = [];
  const triggers = new Map<string, TriggerConfig>();
  /** Per-trigger cron expression captured at registration time (plugin discovery only — manual setTrigger does not set this). */
  const triggerCron = new Map<string, string>();
  for (const t of opts.triggers ?? []) triggers.set(t.id, t);

  // We need a forward declaration for the URL base — populated after listen.
  let baseUrl = '';

  /**
   * Discover a plugin: parse its manifest, register each declared trigger as
   * a TriggerConfig with `scope: "plugin:<id>"`. Returns the trigger ids
   * registered (in declaration order).
   *
   * The function is hoisted into the handle below; defined here so the
   * /test/load-plugin endpoint can share the implementation.
   */
  async function loadPluginImpl(pluginDir: string): Promise<string[]> {
    const absDir = isAbsolute(pluginDir) ? pluginDir : pathResolve(process.cwd(), pluginDir);
    const manifest = await loadPluginManifest(absDir);
    const registered: string[] = [];
    for (const t of manifest.provides?.triggers ?? []) {
      const scriptPath = pathResolve(absDir, t.file);
      // Pick a runner from the file extension. .ts → tsx, .py → python(3),
      // anything else → node. Mirrors how plugins/<id>/triggers/triggers.json
      // composes commands in the real Clawdevbox.
      let command: string[];
      if (t.file.endsWith('.ts') || t.file.endsWith('.tsx')) {
        command = ['tsx', scriptPath];
      } else if (t.file.endsWith('.py')) {
        command = [process.platform === 'win32' ? 'python' : 'python3', scriptPath];
      } else {
        command = ['node', scriptPath];
      }

      // Plugin-scoped routing-baked callback path. Real Clawdevbox would derive
      // this from the registry entry's binding (subscriber thread / plugin
      // global / etc.); we use a deterministic pattern the test can assert on.
      const callbackPath = `/callback/plugins/${manifest.id}/triggers/${t.id}/resume`;

      const cfg: TriggerConfig = {
        id: t.id,
        command,
        state: {},
        callbackPath,
        cwd: absDir,
        subscriberThreadId: null,
        scope: `plugin:${manifest.id}`,
      };
      triggers.set(t.id, cfg);
      if (t.cron) triggerCron.set(t.id, t.cron);
      registered.push(t.id);
    }
    return registered;
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', baseUrl || 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // --- Test introspection (no auth — local-only) ---
      if (method === 'GET' && path === '/test/health') {
        return send(res, 200, { ok: true, callbackCount: callbacks.length, triggerIds: [...triggers.keys()] });
      }
      if (method === 'GET' && path === '/test/received-callbacks') {
        return send(res, 200, { callbacks });
      }
      if (method === 'POST' && path === '/test/reset') {
        callbacks.length = 0;
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/test/configure-trigger') {
        const raw = await readBody(req);
        let cfg: TriggerConfig;
        try {
          cfg = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        if (!cfg.id || !Array.isArray(cfg.command) || cfg.command.length === 0) {
          return send(res, 400, { error: 'cfg.id and cfg.command[] required' });
        }
        triggers.set(cfg.id, cfg);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/test/load-plugin') {
        const raw = await readBody(req);
        let body: { pluginDir?: string };
        try {
          body = JSON.parse(raw) as { pluginDir?: string };
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        if (!body.pluginDir || typeof body.pluginDir !== 'string') {
          return send(res, 400, { error: '`pluginDir` (string) required' });
        }
        try {
          const ids = await loadPluginImpl(body.pluginDir);
          return send(res, 200, { ok: true, registered: ids });
        } catch (err) {
          return send(res, 500, { error: 'plugin load failed', detail: err instanceof Error ? err.message : String(err) });
        }
      }
      if (method === 'GET' && path === '/test/triggers') {
        const list: TriggerRegistryEntry[] = [...triggers.values()].map((t) => ({
          id: t.id,
          scope: t.scope ?? 'project',
          command: t.command,
          callbackPath: t.callbackPath,
          subscriberThreadId: t.subscriberThreadId ?? null,
          cron: triggerCron.get(t.id) ?? null,
        }));
        return send(res, 200, { triggers: list });
      }

      // --- Webhook fire (auth required) ---
      if (method === 'POST' && path.startsWith('/hooks/')) {
        if (!checkAuth(req, secret)) return send(res, 401, { error: 'unauthorized' });

        const triggerId = decodeURIComponent(path.slice('/hooks/'.length));
        const cfg = triggers.get(triggerId);
        if (!cfg) return send(res, 404, { error: `unknown trigger id: ${triggerId}` });

        const rawBody = await readBody(req);
        let payload: unknown = null;
        if (rawBody.trim().length > 0) {
          try {
            payload = JSON.parse(rawBody);
          } catch {
            // Per the trigger protocol, payload is whatever the caller sent.
            // ADO sends JSON, so we capture parse errors specifically.
            return send(res, 400, { error: 'invalid JSON body' });
          }
        }

        const runId = generateRunId();
        const firedBy: 'external' | 'cron' | 'manual' | 'agent' =
          payload === null ? 'cron' : 'external';

        // Build the envelope per spec §8.4
        const callbackUrl = `${baseUrl}${cfg.callbackPath}`;
        const cwd = cfg.cwd ?? process.cwd();
        const envelope = {
          trigger_event_name: 'TriggerFired' as const,
          trigger_id: cfg.id,
          run_id: runId,
          fired_by: firedBy,
          fired_at: Date.now(),
          cwd,
          project_dir: cwd,
          trigger_data_dir: `${cwd}/.clawdevbox/triggers/${cfg.id}/data`,
          subscriber_thread_id: cfg.subscriberThreadId ?? null,
          callback_url: callbackUrl,
          state: cfg.state,
          payload,
        };

        const baseEnv: Record<string, string> = {
          CLAWDEVBOX_PROJECT_DIR: cwd,
          CLAWDEVBOX_MCP_URL: `${baseUrl}/mcp`,
          CLAWDEVBOX_MCP_SECRET: secret,
          CLAWDEVBOX_TRIGGER_ID: cfg.id,
          CLAWDEVBOX_TRIGGER_RUN_ID: runId,
          CLAWDEVBOX_TRIGGER_FIRED_BY: firedBy,
        };
        if (cfg.subscriberThreadId) baseEnv.CLAWDEVBOX_THREAD_ID = cfg.subscriberThreadId;

        const result = await runTrigger(cfg, envelope, baseEnv, inheritStderr);

        // Mirror the spec semantics: exit 0 → 200, exit 2 → 500 (blocking),
        // other non-zero → 500. Timeouts → 504.
        if (result.timedOut) {
          return send(res, 504, {
            run_id: runId,
            duration_ms: result.durationMs,
            error: 'timeout',
            stderr: result.stderr,
          });
        }

        // Mode A: if the script exited 0 with a JSON stdout containing a
        // singular `callback` object, deliver it as if the script had POSTed
        // to its trigger callback URL. Persist returned `state` in memory.
        // Strictly singular — `callbacks: []` (plural) is no longer supported.
        let modeAError: string | null = null;
        let modeADelivered = 0;
        if (result.exitCode === 0 && result.stdout.trim().length > 0) {
          try {
            const parsed = JSON.parse(result.stdout) as {
              state?: Record<string, unknown>;
              callback?: { body: unknown };
            };
            if (parsed && typeof parsed === 'object') {
              if (parsed.callback !== undefined) {
                const entry = parsed.callback;
                if (
                  !entry ||
                  typeof entry !== 'object' ||
                  Array.isArray(entry) ||
                  !('body' in entry)
                ) {
                  modeAError = `callback must be an object with a 'body' field`;
                } else {
                  const rawBody = JSON.stringify(entry.body);
                  callbacks.push({
                    path: cfg.callbackPath,
                    body: entry.body,
                    rawBody,
                    authHeader: `Bearer ${secret}`,
                    receivedAt: Date.now(),
                    delivered_via: 'mode-a-stdout',
                  });
                  modeADelivered++;
                }
              }
              if (parsed.state && typeof parsed.state === 'object' && !Array.isArray(parsed.state)) {
                // Persist returned state in memory (test-only).
                cfg.state = parsed.state as Record<string, unknown>;
                triggers.set(cfg.id, cfg);
              }
            }
          } catch {
            // Not JSON → treat as plain-text log (Claude-Code-style fallback).
          }
        }

        const status = result.exitCode === 0 && !modeAError ? 200 : 500;
        return send(res, status, {
          run_id: runId,
          duration_ms: result.durationMs,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          mode_a_delivered: modeADelivered,
          ...(modeAError ? { mode_a_error: modeAError } : {}),
        });
      }

      // --- Callback (auth required) — catch-all ---
      if (method === 'POST' && path.startsWith('/callback/')) {
        if (!checkAuth(req, secret)) return send(res, 401, { error: 'unauthorized' });
        const rawBody = await readBody(req);
        let parsed: unknown = null;
        if (rawBody.length > 0) {
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            parsed = rawBody;
          }
        }
        callbacks.push({
          path,
          body: parsed,
          rawBody,
          authHeader: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
          receivedAt: Date.now(),
          delivered_via: 'mode-b',
        });
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'not found', path, method });
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      return send(res, 500, { error: 'internal', detail: msg });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolveListen());
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    secret,
    url: baseUrl,
    callbackBase: `${baseUrl}/callback`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
    getCallbacks: () => callbacks.slice(),
    resetCallbacks: () => {
      callbacks.length = 0;
    },
    setTrigger: (cfg) => triggers.set(cfg.id, cfg),
    removeTrigger: (id) => {
      triggers.delete(id);
      triggerCron.delete(id);
    },
    loadPlugin: (pluginDir) => loadPluginImpl(pluginDir),
    getTriggers: () =>
      [...triggers.values()].map((t) => ({
        id: t.id,
        scope: t.scope ?? 'project',
        command: t.command,
        callbackPath: t.callbackPath,
        subscriberThreadId: t.subscriberThreadId ?? null,
        cron: triggerCron.get(t.id) ?? null,
      })),
  };
}

// ============================================================================
// CLI entrypoint
// ============================================================================

async function mainCli(): Promise<void> {
  const handle = await startMockClawdevbox();
  // Parseable banner so the test driver / shell scripts can capture port + secret.
  process.stdout.write(`MOCK_CLAWDEVBOX_READY ${handle.port} ${handle.secret}\n`);
  process.stdout.write(`URL: ${handle.url}\n`);
  process.stdout.write(`Endpoints:\n`);
  process.stdout.write(`  POST ${handle.url}/hooks/<trigger-id>\n`);
  process.stdout.write(`  POST ${handle.url}/callback/* (catch-all)\n`);
  process.stdout.write(`  GET  ${handle.url}/test/received-callbacks\n`);
  process.stdout.write(`  POST ${handle.url}/test/reset\n`);
  process.stdout.write(`  POST ${handle.url}/test/configure-trigger\n`);
  process.stdout.write(`  POST ${handle.url}/test/load-plugin\n`);
  process.stdout.write(`  GET  ${handle.url}/test/triggers\n`);
  process.stdout.write(`(press Ctrl-C to stop)\n`);

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ESM-friendly "if this is the entry point" check
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const invokedAs = process.argv[1] ? pathResolve(process.argv[1]) : '';
if (invokedAs === __filename || invokedAs.endsWith('mock-clawdevbox.ts') || invokedAs.endsWith('mock-clawdevbox.js')) {
  mainCli().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

// Suppress unused-warning for __dirname in ESM
void __dirname;
