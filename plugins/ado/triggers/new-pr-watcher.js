// ado.new-pr-watcher trigger script
//
// Polls ADO for ACTIVE pull requests in a repo and dispatches NEW ones (not
// seen on a previous fire) to a fresh dev-buddy agent for a READ-ONLY review.
//
// Envelope contract (see the `authoring-triggers` skill and the sibling
// ado.assigned-items-watcher): the kernel spawns this script with ONE
// TriggerEnvelope JSON object on stdin. Trigger params seed `envelope.state`,
// which also carries the per-fire cursor (`seen_pr_ids`) and an `initialized`
// flag. Per-fire results are written to `envelope.output_dir`; dispatch
// happens by POSTing to `envelope.dispatch_url` (live subscriber pty,
// feature-detected) or `envelope.spawn_url` (always present) with a `Bearer`
// of CLAWDEVBOX_FIRE_SECRET. The script emits ONE JSON object `{state}` on
// stdout ONLY after a successful tick; the dispatcher JSON-parses stdout and
// merges `state` back into the trigger's persisted state, which is how the
// `seen_pr_ids` cursor advances between fires.
//
// Baseline semantics: the FIRST successful tick (state.initialized falsy)
// records every currently-active matching PR id into seen_pr_ids and
// dispatches NOTHING — otherwise registering the watcher against an existing
// repo would spam a review for every open PR. Subsequent ticks dispatch only
// ids absent from seen_pr_ids.
//
// Cursor safety: if ANY dispatch callback fails, the script exits non-zero
// WITHOUT emitting a state cursor, so the undispatched PR stays "new" and is
// retried on the next fire (never silently skipped).

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function writeObservation(outputDir, obj) {
  try {
    writeFileSync(join(outputDir, 'observation.json'), JSON.stringify(obj, null, 2));
  } catch { /* best-effort */ }
}

const env = JSON.parse(await readStdin());
const state = env.state ?? {};
const {
  org, project, repo,
  opened_by, assigned_to,
  include_drafts = false,
  worktree_path,
} = state;

if (!org || !project || !repo) {
  process.stderr.write('missing required params (org, project, repo) in trigger state\n');
  process.exit(1);
}

// `az` binary is overridable for tests (CLAWDEVBOX_AZ_BIN); defaults to `az`.
// Normally a bare name/path (`az`, or an explicit `…\wbin\az.cmd`) — on Windows
// the MSI installs `az` as a `.cmd` shim. Tests may instead set it to a JSON
// array `[binary, ...prefixArgs]` (e.g. `[node, stub.js]`): an already
// directly-launchable interpreter that is run AS-IS (never shimmed —
// node.exe/python.exe are real executables). `direct` records that distinction.
function resolveAz() {
  const raw = process.env.CLAWDEVBOX_AZ_BIN;
  if (!raw) return { bin: 'az', prefix: [], direct: false };
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0) {
        return { bin: String(arr[0]), prefix: arr.slice(1).map(String), direct: true };
      }
    } catch { /* not JSON — treat as a literal binary path below */ }
  }
  return { bin: raw, prefix: [], direct: false };
}
const azResolved = resolveAz();

// SHELL-FREE Azure CLI resolution.
//
// On Windows the MSI installs `az` as `…\wbin\az.cmd` — NOT a standalone .exe
// (Get-Command az → …\Azure\CLI2\wbin\az.cmd). Node's post-CVE child_process
// refuses to launch a .cmd/.bat without a shell (bare `az` → ENOENT; explicit
// `az.cmd` → EINVAL/EFTYPE). The previous fix routed through
// `cmd.exe /d /s /c <bin> …`, relying on Node's cmd-aware quoting to keep
// operator values (org/project/repo) literal. But that quoting only wraps
// arguments containing WHITESPACE: a SPACE-FREE value such as
// `repo&echo x>marker` is handed to cmd.exe UNQUOTED, so cmd splits on the
// metacharacter and executes the injected command (a proven, reproducible
// bypass). No amount of quoting or ADO-name validation closes that hole — the
// only durable fix is to remove the shell entirely.
//
// az.cmd is itself a trivial shim that execs the bundled CPython:
//   @IF EXIST "%~dp0\..\python.exe" ( "%~dp0\..\python.exe" -IBm azure.cli %* )
// So we resolve az.cmd, derive its sibling `..\python.exe`, verify it exists,
// and invoke that interpreter DIRECTLY via spawnSync (a real .exe →
// CreateProcess argv, no shell) — every value stays ONE literal argv element
// regardless of content. For a custom .cmd layout WITHOUT a sibling python.exe
// we FAIL SAFELY with a clear error instead of falling back to cmd.exe (which
// would reintroduce the injection). Resolution is cached for this process.
//
// Do NOT reintroduce a shell here (no execSync / no shell:true / no cmd.exe).
let cachedWinAzPython;
function resolveAzCmdPath(bin) {
  // Explicit path to a .cmd shim.
  if (/\.cmd$/i.test(bin)) {
    if (existsSync(bin)) return bin;
    throw new Error(`az shim not found at ${bin}`);
  }
  // Explicit path (contains a separator) but no extension — look for `<bin>.cmd`.
  if (bin.includes('\\') || bin.includes('/')) {
    const withCmd = `${bin}.cmd`;
    if (existsSync(withCmd)) return withCmd;
    throw new Error(`az shim not found at ${withCmd}`);
  }
  // Bare name (production default `az`): resolve `<bin>.cmd` off PATH via
  // where.exe — itself a real .exe, launched shell-free with a discrete argv.
  const res = spawnSync('where.exe', [`${bin}.cmd`], { encoding: 'utf8', windowsHide: true });
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  }
  throw new Error(
    `could not resolve ${bin}.cmd via where.exe (status ${res.status}): ${(res.stderr || '').trim()}`,
  );
}
function resolveWinAzPython(bin) {
  if (cachedWinAzPython) return cachedWinAzPython;
  const azCmd = resolveAzCmdPath(bin);
  const pythonExe = resolve(dirname(azCmd), '..', 'python.exe');
  if (!existsSync(pythonExe)) {
    throw new Error(
      `unsupported az layout: no bundled python.exe beside ${azCmd} (expected ${pythonExe}); ` +
      `refusing cmd.exe fallback to keep the az launch shell-free`,
    );
  }
  cachedWinAzPython = pythonExe;
  return pythonExe;
}

// Resolve the az query to a SHELL-FREE { file, args } launch spec. Every element
// is a discrete argv token launched via spawnSync(shell:false), so operator
// values can never be re-parsed and executed on the host.
function azInvocation(azArgs) {
  const { bin, prefix, direct } = azResolved;
  // The JSON-array interpreter seam and every non-Windows platform launch a
  // real executable directly — no shim, no shell.
  if (direct || process.platform !== 'win32') {
    return { file: bin, args: [...prefix, ...azArgs] };
  }
  // Windows, non-direct: run the bundled interpreter (az.cmd's own target)
  // directly, bypassing the .cmd shim and cmd.exe entirely.
  const pythonExe = resolveWinAzPython(bin);
  return { file: pythonExe, args: ['-IBm', 'azure.cli', ...azArgs] };
}

let prs;
try {
  // Every value (repo/org/project) is a discrete argv element — never
  // concatenated into a shell string — so metacharacters can never be
  // re-parsed and executed on the host.
  const azArgs = [
    'repos', 'pr', 'list',
    '--repository', repo,
    '--status', 'active',
    '--org', `https://dev.azure.com/${org}`,
    '--project', project,
    '-o', 'json',
  ];
  const { file, args } = azInvocation(azArgs);
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env },
  });
  // spawnSync does not throw on spawn/exec failure or non-zero exit; observe
  // both explicitly so the catch block records an error observation and the
  // cursor is NOT advanced (no state emitted on stdout).
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`az exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  const raw = res.stdout ?? '';
  // Strip any WARNING lines before the JSON array.
  const jsonStart = raw.indexOf('[');
  prs = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`az repos pr list failed: ${message}\n`);
  writeObservation(env.output_dir, { status: 'error', error: message, observed_at: Date.now() });
  process.exit(1);
}

// Apply client-side filters (the az stub in tests ignores CLI args, and
// filtering here keeps the query stable regardless of az version).
const matching = prs.filter((p) => {
  if (!include_drafts && p.isDraft === true) return false;
  if (opened_by && p.createdBy?.uniqueName !== opened_by) return false;
  if (assigned_to && !(p.reviewers ?? []).some((r) => r.uniqueName === assigned_to)) return false;
  return true;
});

const matchingIds = matching.map((p) => String(p.pullRequestId));

// First successful tick baselines every currently-active matching PR and
// dispatches nothing.
if (!state.initialized) {
  writeObservation(env.output_dir, {
    status: 'ok',
    observed_at: Date.now(),
    baseline: true,
    total: matching.length,
    new_count: 0,
    new_ids: [],
    current_ids: matchingIds,
    dispatched: false,
  });
  process.stdout.write(JSON.stringify({ state: { initialized: true, seen_pr_ids: matchingIds } }));
  process.exit(0);
}

// Subsequent ticks: diff against the ids seen on a previous fire.
const previousIds = new Set((state.seen_pr_ids ?? []).map(String));
const newPrs = matching.filter((p) => !previousIds.has(String(p.pullRequestId)));

const url = env.dispatch_url ?? env.spawn_url;
if (!url) {
  process.stderr.write('no dispatch_url or spawn_url in envelope; cannot dispatch\n');
  process.exit(1);
}

const headers = { 'Content-Type': 'application/json' };
if (process.env.CLAWDEVBOX_FIRE_SECRET) {
  headers.Authorization = `Bearer ${process.env.CLAWDEVBOX_FIRE_SECRET}`;
}

let dispatched = false;
// At-least-once delivery: if an EARLIER PR in this loop dispatched successfully
// but a LATER one fails, we exit non-zero WITHOUT emitting a state cursor (see
// below), so the whole batch — including the already-dispatched ids — is
// replayed on the next fire. That can re-review a PR that was dispatched just
// before the failure. Duplicate reviews are read-only and harmless, and this
// is deliberately preferred over ever advancing the cursor past an
// undispatched PR (which would silently drop it).
for (const p of newPrs) {
  const id = String(p.pullRequestId);
  const title = p.title ?? '(no title)';
  const author = p.createdBy?.uniqueName ?? p.createdBy?.displayName ?? 'unknown';
  const prompt = [
    `New active pull request in ${org}/${project}/${repo}:`,
    '',
    `- PR !${id}: ${title} (opened by ${author})`,
    '',
    `Fetch and review pull request !${id} READ-ONLY. Do NOT post comments, votes, or`,
    `approvals unless the user explicitly approves posting. Use the ADO tools`,
    `(org: '${org}', project: '${project}', repo: '${repo}') to inspect the PR and its diff.`,
  ].join('\n');

  const body = { prompt };
  // spawn_url resolves a filesystem working directory from `workspace_path`
  // and can route to a named agent; dispatch_url takes a prompt only.
  if (!env.dispatch_url) {
    body.agent = 'dev-buddy:dev-buddy';
    if (worktree_path) body.workspace_path = worktree_path;
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    process.stderr.write(`dispatch POST failed for PR ${id}: ${message}\n`);
    writeObservation(env.output_dir, {
      status: 'error', error: message, observed_at: Date.now(), failed_pr_id: id, dispatched,
    });
    // Do NOT emit a state cursor — the undispatched PR must stay new.
    process.exit(1);
  }
  if (!res.ok) {
    process.stderr.write(`dispatch POST failed for PR ${id}: ${res.status}\n`);
    writeObservation(env.output_dir, {
      status: 'error', error: `dispatch returned ${res.status}`, observed_at: Date.now(),
      failed_pr_id: id, dispatched,
    });
    process.exit(1);
  }
  dispatched = true;
}

// All dispatches (if any) succeeded — persist the observation and advance the
// cursor to every currently-observed matching id.
writeObservation(env.output_dir, {
  status: 'ok',
  observed_at: Date.now(),
  baseline: false,
  total: matching.length,
  new_count: newPrs.length,
  new_ids: newPrs.map((p) => String(p.pullRequestId)),
  current_ids: matchingIds,
  dispatched,
});

process.stdout.write(JSON.stringify({ state: { initialized: true, seen_pr_ids: matchingIds } }));
