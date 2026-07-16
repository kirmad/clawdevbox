// ado.assigned-items-watcher trigger script
//
// Polls ADO for work items assigned to a user and dispatches NEW items
// (not seen on the previous fire) to a fresh agent.
//
// Envelope contract (see the `authoring-triggers` skill): the kernel spawns
// this script with ONE TriggerEnvelope JSON object on stdin. Trigger params
// seed `envelope.state`, which also carries the per-fire cursor (`seen_ids`).
// Per-fire results are written to `envelope.output_dir`; dispatch happens by
// POSTing to `envelope.dispatch_url` (live subscriber pty, feature-detected)
// or `envelope.spawn_url` (always present) with a `Bearer` of
// CLAWDEVBOX_FIRE_SECRET. The script emits ONE JSON object `{state}` on stdout;
// the dispatcher JSON-parses stdout and merges `state` back into the trigger's
// persisted state, which is how the `seen_ids` cursor advances between fires.

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Build the ADO WIQL query from the assigned-to identity and an optional
// caller-supplied WHERE fragment. Exported for focused tests.
export function buildWiql(assignedTo, extraWhere) {
  const whereClauses = [
    `[System.AssignedTo] = '${assignedTo}'`,
    extraWhere ?? "[System.State] NOT IN ('Closed', 'Removed')",
  ].filter(Boolean).join(' AND ');
  return `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.ChangedDate] FROM workitems WHERE ${whereClauses} ORDER BY [System.ChangedDate] DESC`;
}

// Resolve a bare command name (e.g. `az`) to an absolute path by scanning PATH
// with PATHEXT (Windows) — Node's spawn does NOT do PATHEXT resolution without
// `shell: true`, which we are deliberately avoiding. Returns null if not found.
export function resolveOnPath(name) {
  const pathVar = process.env.PATH ?? '';
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    // Prefer known executable extensions before a bare (extension-less) name so
    // `az.cmd`/`az.exe` win over a POSIX-style `az` shell script on Windows.
    for (const ext of isWin ? [...exts, ''] : ['']) {
      const candidate = join(dir, name + ext);
      try { if (existsSync(candidate)) return candidate; } catch { /* ignore */ }
    }
  }
  return null;
}

// Resolve HOW to invoke the Azure CLI as a discrete executable + argv vector —
// NEVER through a shell. Returns { file, args } for spawnSync.
//
// Three seams:
//   1. JSON array — CLAWDEVBOX_AZ_BIN = '["<file>", ...prefixArgs]' is used as a
//      literal argv prefix, invoked directly. Cross-platform test/advanced seam.
//   2. Windows MSI shim — the MSI Azure CLI ships as `…\wbin\az.cmd`, a batch
//      file that execs `%~dp0\..\python.exe -IBm azure.cli %*`. Running the
//      .cmd via `cmd.exe /d /s /c az.cmd <args>` makes cmd.exe RE-PARSE our
//      argv, so a space-free metacharacter payload in a flag value both
//      truncates the argument (at `&`/`|`) and injects a command. Instead we
//      resolve to that sibling python.exe and call it directly, byte-for-byte.
//      An unsupported custom `.cmd`/`.bat` (no sibling python.exe) is REFUSED
//      rather than shelled out.
//   3. Direct executable — POSIX `az`, or an explicit `python.exe`/`az.exe`
//      path — spawned directly.
export function resolveAzInvocation(azBin, args) {
  const trimmed = String(azBin).trim();

  // (1) JSON-array argv seam.
  if (trimmed.startsWith('[')) {
    const prefix = JSON.parse(trimmed);
    if (!Array.isArray(prefix) || prefix.length === 0 || typeof prefix[0] !== 'string') {
      throw new Error('CLAWDEVBOX_AZ_BIN JSON array must be a non-empty ["<file>", ...args] of strings');
    }
    return { file: prefix[0], args: [...prefix.slice(1), ...args] };
  }

  if (process.platform !== 'win32') {
    // POSIX: `az` (or an absolute path) is a normal executable; spawn directly.
    return { file: azBin, args };
  }

  // Windows: resolve a bare command name to its absolute shim on PATH.
  let binPath = azBin;
  if (!azBin.includes('\\') && !azBin.includes('/')) {
    binPath = resolveOnPath(azBin) ?? azBin;
  }

  const lower = binPath.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // MSI layout: `…\wbin\az.cmd` execs `%~dp0\..\python.exe -IBm azure.cli %*`.
    const python = resolve(dirname(binPath), '..', 'python.exe');
    if (!existsSync(python)) {
      throw new Error(
        `refusing to run Azure CLI shim '${binPath}' through a shell: no sibling MSI python.exe at '${python}'. `
        + 'Set CLAWDEVBOX_AZ_BIN to the MSI az.cmd, a python.exe, or a JSON ["<file>", ...args] argv.',
      );
    }
    return { file: python, args: ['-IBm', 'azure.cli', ...args] };
  }

  // A concrete .exe (python.exe, az.exe) — spawn directly, no shell.
  return { file: binPath, args };
}

// Backward-compatible resolution of the "previously-seen" baseline from trigger
// state. A pre-`seen_ids` registration persisted its cursor as a `seenWorkItems`
// MAP — `{ "<id>": { state, changedDate } }` — with NO `seen_ids` array. Because
// the fire logic reads only `state.seen_ids`, a byte-identical restore of that
// legacy state yielded an EMPTY previous set, so every assigned item looked
// "new" and the watcher mass-dispatched (prod incident: 232 items → one mass
// triage agent). Resolve the baseline defensively, by mode:
//   - 'cursor'   : an explicit seen_ids array is authoritative — it WINS over a
//                  legacy map (the map may be stale once seen_ids exists).
//   - 'migrate'  : no seen_ids, but a well-formed legacy seenWorkItems map whose
//                  keys are ALL canonical ADO ids — derive the previous ids from
//                  its keys.
//   - 'failsafe' : a legacy marker is present but unusable — not a NON-EMPTY
//                  id→meta object, OR a non-empty object with ANY key that is
//                  not a canonical ADO id (non-numeric, decimal, negative,
//                  whitespace, leading-zero, etc.). Non-numeric keys can never
//                  intersect the numeric current ids, so migrating from them
//                  would treat every item as new — the same mass-dispatch bug.
//                  A single invalid key fails the WHOLE map safe (no partial
//                  migration): never dispatch uncertain items. Never fall back
//                  to an empty set; the caller baselines everything as seen.
//   - 'fresh'    : neither present — a genuinely new registration (dispatch-all,
//                  the intended cold-start behavior).
// Exported for focused tests.

// A canonical ADO work-item id key: a positive integer string with no sign,
// decimal point, whitespace, leading zero, or other junk (e.g. "1", "42",
// "999999"). Rejects "", "0", "01", "-5", "3.5", " 5", "5abc", "0x10", "+5",
// "1e3", "1_000". Leading zeros are rejected as non-canonical (fail-safe).
function isCanonicalAdoId(key) {
  return /^[1-9][0-9]*$/.test(key);
}

export function deriveSeenBaseline(state) {
  const s = state ?? {};
  if (Array.isArray(s.seen_ids)) {
    return { mode: 'cursor', ids: s.seen_ids.map(String) };
  }
  if ('seenWorkItems' in s) {
    const map = s.seenWorkItems;
    const isPlainObject = map !== null && typeof map === 'object' && !Array.isArray(map);
    const keys = isPlainObject ? Object.keys(map) : [];
    // Only migrate a NON-EMPTY map whose keys are ALL canonical ADO ids. Any
    // invalid key makes the entire map fail-safe — do not partially migrate and
    // dispatch uncertain items.
    if (isPlainObject && keys.length > 0 && keys.every(isCanonicalAdoId)) {
      return { mode: 'migrate', ids: keys.map(String) };
    }
    return { mode: 'failsafe', ids: [] };
  }
  return { mode: 'fresh', ids: [] };
}

async function main() {
  const env = JSON.parse(await readStdin());
  const state = env.state ?? {};
  const { org, project, assigned_to, extra_where, worktree_path } = state;

  if (!org || !project || !assigned_to) {
    process.stderr.write('missing required params (org, project, assigned_to) in trigger state\n');
    process.exit(1);
  }

  // Build WIQL query.
  const wiql = buildWiql(assigned_to, extra_where);

  // `az` binary is overridable for tests (CLAWDEVBOX_AZ_BIN); defaults to `az`.
  const azBin = process.env.CLAWDEVBOX_AZ_BIN ?? 'az';

  const azArgs = [
  'boards', 'query',
  '--wiql', wiql,
  '--org', `https://${org}.visualstudio.com`,
  '--project', project,
  '-o', 'json',
];

let items;
try {
  const { file, args } = resolveAzInvocation(azBin, azArgs);
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env },
  });
  // spawnSync does not throw on spawn/exec failure or non-zero exit; observe
  // both explicitly so the catch block below records an error observation and
  // the cursor is NOT advanced (no state emitted on stdout).
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`az exited ${res.status}: ${(res.stderr || '').trim()}`);
  }
  const raw = res.stdout ?? '';
  // Strip any WARNING lines before the JSON array.
  const jsonStart = raw.indexOf('[');
  items = JSON.parse(jsonStart >= 0 ? raw.slice(jsonStart) : raw);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write(`az boards query failed: ${message}\n`);
  writeFileSync(
    join(env.output_dir, 'observation.json'),
    JSON.stringify({ status: 'error', error: message, observed_at: Date.now() }, null, 2),
  );
  process.exit(1);
}

// Resolve the "previously seen" baseline defensively so a legacy (pre-seen_ids)
// registration that persisted a `seenWorkItems` map cannot be misread as an
// empty cursor and mass-dispatch. See deriveSeenBaseline for the modes.
const currentIds = items.map((i) => String(i.id));
const baseline = deriveSeenBaseline(state);
if (baseline.mode !== 'cursor' && baseline.mode !== 'fresh') {
  process.stderr.write(`assigned-items-watcher: seen-baseline mode=${baseline.mode} (legacy state migration)\n`);
}
// Fail-safe: an unusable legacy marker must NEVER mass-dispatch — baseline every
// currently-observed item as already seen so nothing fires this fire; the
// emitted seen_ids cursor (below) then makes subsequent fires precise.
const previousIds = baseline.mode === 'failsafe'
  ? new Set(currentIds)
  : new Set(baseline.ids);
const newItems = items.filter((i) => !previousIds.has(String(i.id)));

let dispatched = false;
if (newItems.length > 0) {
  const summary = newItems.map((i) => {
    const f = i.fields ?? {};
    return `- #${i.id} [${f['System.WorkItemType'] ?? '?'}] ${f['System.State'] ?? '?'}: ${f['System.Title'] ?? '(no title)'}`;
  }).join('\n');

  const prompt = [
    `New work items assigned to ${assigned_to} in ${org}/${project}:`,
    '',
    summary,
    '',
    'Review these items. For each, decide: triage (add labels/priority), implement (use implement-work-item recipe), or defer.',
    `Use ADO tools (org: '${org}', project: '${project}') for any updates.`,
  ].join('\n');

  // Prefer the live subscriber pty when present; otherwise spawn a fresh agent.
  const url = env.dispatch_url ?? env.spawn_url;
  if (!url) {
    process.stderr.write('no dispatch_url or spawn_url in envelope; cannot dispatch\n');
    process.exit(1);
  }
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.CLAWDEVBOX_FIRE_SECRET) {
    headers.Authorization = `Bearer ${process.env.CLAWDEVBOX_FIRE_SECRET}`;
  }
  const body = { prompt };
  // spawn_url resolves a filesystem working directory from `workspace_path`
  // (an opaque `workspace_id` lookup would ignore a path); dispatch_url takes
  // prompt only.
  if (!env.dispatch_url && worktree_path) {
    body.workspace_path = worktree_path;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    process.stderr.write(`dispatch POST failed: ${res.status}\n`);
    process.exit(1);
  }
  dispatched = true;
}

// Persist an observation file for the operator (kernel keeps it under
// <ws>/.clawdevbox/fires/<fire_id>/attempt-N/).
writeFileSync(
  join(env.output_dir, 'observation.json'),
  JSON.stringify({
    status: 'ok',
    observed_at: Date.now(),
    total: items.length,
    new_count: newItems.length,
    new_ids: newItems.map((i) => String(i.id)),
    current_ids: currentIds,
    dispatched,
  }, null, 2),
);

// Emit the per-fire cursor on stdout. The dispatcher JSON-parses the whole
// stdout and merges `state` into the trigger's persisted state, so advancing
// `seen_ids` to every currently-observed id is what stops already-seen items
// from re-dispatching on the next fire. stdout MUST stay a single JSON object.
process.stdout.write(JSON.stringify({ state: { seen_ids: currentIds } }));
}

// Run as a script only when executed as the entrypoint. When imported by tests
// (to unit-test resolveAzInvocation/buildWiql) this guard keeps main() — which
// reads the TriggerEnvelope from stdin — from running.
function isEntrypoint() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await main();
}
