# Agent-Authored Trigger Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents create reusable trigger TYPEs at runtime, register one-off triggers from inline scripts, and dry-run any trigger script with a synthesized envelope — without needing to author a plugin.

**Architecture:** Three layers: (1) a `trigger-runner.ts` primitive that spawns a script with a `TriggerEnvelope` on stdin and captures Mode A (stdout) + Mode B (HTTP) callbacks via an ephemeral 127.0.0.1 receiver; (2) a `template-store.ts` that stores agent-authored TYPEs as `template.yaml` + script-file pairs under `.clawdevbox/trigger-types/<id>/` (project) or `<globalDir>/trigger-types/<id>/` (global), merged into `ws.triggerTypes` with precedence project > global > plugin; (3) MCP tools `trigger.create_template`, `update_template`, `delete_template`, `list_templates`, `test`, plus `trigger.register` extended with XOR(`type_id` | `script` | `script_file`).

**Tech Stack:** TypeScript (mcp-server), node:test, MCP SDK (@modelcontextprotocol/sdk), js-yaml, node:http, child_process.

**Spec:** `docs/specs/2026-05-14-agent-authored-trigger-templates-design.md`

---

## File Structure

**New files:**
- `mcp-server/src/template-store.ts` — disk I/O for agent-authored templates and one-off auto-templates. Atomic writes; recursive deletes via temp-rename pattern.
- `mcp-server/src/trigger-runner.ts` — spawn-script-and-capture primitive. Reused by `trigger.test` today and the future cron daemon.
- `mcp-server/tests/trigger-runner.test.mjs` — unit tests for the runner with fixture scripts.
- `mcp-server/tests/trigger-templates.test.mjs` — integration tests for create_template/update_template/delete_template/list_templates + register XOR + trigger.test.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-b.ts` — POSTs once to callback_url, exits 0.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-a.ts` — writes `{ callback: { body } }` to stdout, exits 0.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-ab.ts` — both Mode A and Mode B in one script.
- `mcp-server/tests/fixtures/trigger-runner/sleep-forever.ts` — sleeps past timeout to test the kill path.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat-bad-auth.ts` — POSTs without the bearer header to verify 401.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat.js` — node runtime.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat.py` — python runtime.
- `mcp-server/tests/fixtures/trigger-runner/heartbeat.sh` — bash runtime.

**Modified files:**
- `mcp-server/src/workspace.ts` — add `runtime` field to `PluginTriggerType` and `RegisteredTriggerType`; add path helpers `projectTriggerTypesDir`, `globalTriggerTypesDir`, `oneoffTemplatesDir`; rename `reloadPluginRegistry` to `reloadTypeRegistries` (keep alias export); add `loadAgentAuthoredTemplates` helper called inside the rename; add `loadOneOffTemplate` for lazy oneoff lookup.
- `mcp-server/src/validators.ts` — add `validateRuntime`, `validateLocalTriggerTypeId`, `validateAgentAuthoredTemplate` (full template manifest validator including the new runtime field). Extend `validateTriggerTypeEntry` to accept the optional `runtime` field for plugin manifests too.
- `mcp-server/src/tools/trigger.ts` — extend `trigger.register` with XOR(`type_id` | `script` | `script_file`); add 5 new tools (`create_template`, `update_template`, `delete_template`, `list_templates`, `test`); update `unregister` to drop oneoff template dirs.
- `docs/tools/trigger.md` — document the new tools and the XOR extension.
- `docs/scripts/compose_master_doc.py` — none, but rerun afterwards to refresh `MCP-TOOLS-REFERENCE.md`.

---

## Phase 0 — Foundations

### Task 0.1: Add `runtime` field and path helpers to workspace.ts

**Files:**
- Modify: `mcp-server/src/workspace.ts`

- [ ] **Step 1: Add `runtime` to `PluginTriggerType`**

In `mcp-server/src/workspace.ts`, inside the `PluginTriggerType` interface (around line 62-93), add:

```ts
  /** Script runtime — drives the spawn command. Plugin-shipped types omit this and default to 'tsx' for backward compatibility. Required on agent-authored templates. */
  runtime?: 'node' | 'tsx' | 'python' | 'bash';
```

- [ ] **Step 2: Add path helpers below `triggersJsonPath`**

In `mcp-server/src/workspace.ts`, after `triggersJsonPath` (~line 263), add:

```ts
/** Where project-scope agent-authored trigger TYPES live. */
export function projectTriggerTypesDir(ws: Workspace): string {
  return join(ws.projectDir, '.clawdevbox', 'trigger-types');
}

/** Where global-scope agent-authored trigger TYPES live. */
export function globalTriggerTypesDir(ws: Workspace): string {
  return join(ws.globalDir, 'trigger-types');
}

/** Reserved subdirectory for one-off auto-templates created by trigger.register. */
export function oneoffTemplatesDir(ws: Workspace): string {
  return join(projectTriggerTypesDir(ws), '_oneoff');
}
```

- [ ] **Step 3: Build to verify**

Run: `npm --prefix mcp-server run build`
Expected: PASS (no type errors)

- [ ] **Step 4: Commit**

```
git add mcp-server/src/workspace.ts
git commit -m "feat(triggers): add runtime field + agent-authored template path helpers"
```

---

### Task 0.2: Add new validators

**Files:**
- Modify: `mcp-server/src/validators.ts`
- Test: `mcp-server/tests/validators.test.mjs` (new — small focused suite)

- [ ] **Step 1: Write the failing tests**

Create `mcp-server/tests/validators.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRuntime,
  validateLocalTriggerTypeId,
  validateAgentAuthoredTemplate,
} from '../src/validators.ts';

test('validateRuntime accepts the four allowed values', () => {
  for (const r of ['node', 'tsx', 'python', 'bash']) {
    const res = validateRuntime(r);
    assert.equal(res.ok, true, `${r} should be ok`);
    if (res.ok) assert.equal(res.runtime, r);
  }
});

test('validateRuntime rejects unknown values', () => {
  const res = validateRuntime('go');
  assert.equal(res.ok, false);
});

test('validateLocalTriggerTypeId requires local. prefix', () => {
  assert.equal(validateLocalTriggerTypeId('local.my-trigger').ok, true);
  assert.equal(validateLocalTriggerTypeId('local.my.nested-trigger').ok, true);
  assert.equal(validateLocalTriggerTypeId('ado.new-pr-watcher').ok, false);
  assert.equal(validateLocalTriggerTypeId('My-Trigger').ok, false);
  assert.equal(validateLocalTriggerTypeId('local.').ok, false);
});

test('validateAgentAuthoredTemplate happy path', () => {
  const res = validateAgentAuthoredTemplate({
    id: 'local.my-trigger',
    file: 'trigger.ts',
    runtime: 'tsx',
    description: 'A test trigger.',
    parameters: [{ name: 'repo', type: 'string', required: true }],
  });
  assert.equal(res.ok, true);
});

test('validateAgentAuthoredTemplate rejects missing runtime', () => {
  const res = validateAgentAuthoredTemplate({
    id: 'local.my-trigger',
    file: 'trigger.ts',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path === 'runtime'));
  }
});

test('validateAgentAuthoredTemplate rejects non-local id', () => {
  const res = validateAgentAuthoredTemplate({
    id: 'ado.new-pr-watcher',
    file: 'trigger.ts',
    runtime: 'tsx',
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.ok(res.errors.some((e) => e.path === 'id'));
  }
});
```

- [ ] **Step 2: Run tests — expected to FAIL**

Run: `node --test --import tsx mcp-server/tests/validators.test.mjs`
Expected: FAIL — validators don't exist yet.

- [ ] **Step 3: Implement validators**

In `mcp-server/src/validators.ts`, after `validateTriggerTypeEntry` (~line 430+), add:

```ts
const RUNTIMES = new Set(['node', 'tsx', 'python', 'bash']);
const LOCAL_TRIGGER_ID_PATTERN = /^local\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export type TriggerRuntime = 'node' | 'tsx' | 'python' | 'bash';

export function validateRuntime(
  value: unknown,
): { ok: true; runtime: TriggerRuntime } | { ok: false; message: string } {
  if (typeof value !== 'string' || !RUNTIMES.has(value)) {
    return { ok: false, message: `runtime must be one of: ${[...RUNTIMES].join(', ')}` };
  }
  return { ok: true, runtime: value as TriggerRuntime };
}

export function validateLocalTriggerTypeId(
  id: string,
): { ok: true } | { ok: false; message: string } {
  if (typeof id !== 'string' || !LOCAL_TRIGGER_ID_PATTERN.test(id)) {
    return { ok: false, message: `id must match ${LOCAL_TRIGGER_ID_PATTERN} (start with 'local.')` };
  }
  return { ok: true };
}

/**
 * Full-shape validator for an agent-authored template manifest. Reuses the
 * plugin-side validateTriggerTypeEntry but layers on the local. id requirement
 * and the required runtime field.
 */
export function validateAgentAuthoredTemplate(parsed: unknown): ValidationResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: [{ path: '$', code: 'NOT_OBJECT', message: 'template must be a YAML map.' }] };
  }
  const errors: ValidationError[] = [];
  const e = parsed as Record<string, unknown>;

  if (typeof e.id === 'string') {
    const idCheck = validateLocalTriggerTypeId(e.id);
    if (!idCheck.ok) {
      errors.push({ path: 'id', code: 'PATTERN', message: idCheck.message });
    }
  } else {
    errors.push({ path: 'id', code: 'REQUIRED', message: 'id is required.' });
  }

  if (e.runtime === undefined) {
    errors.push({ path: 'runtime', code: 'REQUIRED', message: 'runtime is required for agent-authored templates.' });
  } else {
    const runtimeCheck = validateRuntime(e.runtime);
    if (!runtimeCheck.ok) {
      errors.push({ path: 'runtime', code: 'ENUM', message: runtimeCheck.message });
    }
  }

  // Reuse the plugin-side per-entry validator for everything else (file, parameters,
  // cron, binding XOR, identity_param, accepts_webhook). We pass the same parsed
  // object — it only reads fields it knows about and ignores 'runtime'.
  const reused = validateTriggerTypeEntry(parsed, '$');
  // Drop the duplicate id error we already produced above, but keep all others.
  for (const err of reused) {
    if (err.path === '$.id') continue;
    errors.push({ ...err, path: err.path.startsWith('$.') ? err.path.slice(2) : err.path });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
```

- [ ] **Step 4: Run tests — expected to PASS**

Run: `node --test --import tsx mcp-server/tests/validators.test.mjs`
Expected: PASS (5/5)

- [ ] **Step 5: Allow optional runtime on plugin-shipped trigger entries**

In `mcp-server/src/validators.ts`, inside `validateTriggerTypeEntry`, before the closing return, add a runtime guard:

```ts
  // runtime (optional on plugin-shipped types — defaults to 'tsx')
  if (e.runtime !== undefined) {
    const r = validateRuntime(e.runtime);
    if (!r.ok) {
      errors.push({ path: `${p}.runtime`, code: 'ENUM', message: r.message });
    }
  }
```

- [ ] **Step 6: Build to verify**

Run: `npm --prefix mcp-server run build`
Expected: PASS

- [ ] **Step 7: Commit**

```
git add mcp-server/src/validators.ts mcp-server/tests/validators.test.mjs
git commit -m "feat(validators): add runtime + local. trigger-id + agent-authored template validators"
```

---

## Phase 1 — Template store + registry merge

### Task 1.1: Create template-store.ts

**Files:**
- Create: `mcp-server/src/template-store.ts`

- [ ] **Step 1: Write the module**

Create `mcp-server/src/template-store.ts`:

```ts
/**
 * template-store.ts
 *
 * Disk I/O for agent-authored trigger templates and one-off auto-templates.
 * Mirrors the per-template directory layout used by plugin-shipped types:
 *   <root>/trigger-types/<id>/template.yaml
 *   <root>/trigger-types/<id>/trigger.<ext>
 *
 * Atomic writes via writeFileAtomic. Deletes go through rename-to-tomb +
 * rmSync(recursive) so a crash mid-delete leaves a recoverable .deleted-<ts>
 * sibling instead of a half-deleted directory.
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { writeFileAtomic } from './fs-util.ts';
import { mintId } from './store.ts';
import {
  globalTriggerTypesDir, oneoffTemplatesDir, projectTriggerTypesDir,
  type RegisteredTriggerType, type TriggerTypeParameter,
  type WritableScope, type Workspace,
} from './workspace.ts';
import type { TriggerRuntime } from './validators.ts';

const RUNTIME_EXT: Record<TriggerRuntime, string> = {
  node: 'js', tsx: 'ts', python: 'py', bash: 'sh',
};

export function runtimeExt(runtime: TriggerRuntime): string {
  return RUNTIME_EXT[runtime];
}

export interface TemplateManifest {
  id: string;
  file: string;
  runtime: TriggerRuntime;
  description?: string;
  default_cron?: string;
  identity_param?: string;
  accepts_webhook?: boolean;
  binds_callback_to_recipe?: string;
  binds_callback_to?: 'thread_resume';
  parameters?: TriggerTypeParameter[];
}

export interface LoadedTemplate {
  manifest: TemplateManifest;
  scriptAbs: string;
  dir: string;
  scope: 'project' | 'global';
}

function templateDirRoot(ws: Workspace, scope: WritableScope): string {
  return scope === 'project' ? projectTriggerTypesDir(ws) : globalTriggerTypesDir(ws);
}

export function templateDir(ws: Workspace, scope: WritableScope, id: string): string {
  return join(templateDirRoot(ws, scope), id);
}

export function templateExists(ws: Workspace, scope: WritableScope, id: string): boolean {
  return existsSync(join(templateDir(ws, scope, id), 'template.yaml'));
}

export function findTemplate(ws: Workspace, id: string): LoadedTemplate | null {
  for (const scope of ['project', 'global'] as const) {
    if (templateExists(ws, scope, id)) {
      const loaded = loadTemplate(ws, scope, id);
      if (loaded) return loaded;
    }
  }
  return null;
}

export function loadTemplate(
  ws: Workspace, scope: WritableScope, id: string,
): LoadedTemplate | null {
  const dir = templateDir(ws, scope, id);
  const manifestPath = join(dir, 'template.yaml');
  if (!existsSync(manifestPath)) return null;
  let manifest: TemplateManifest;
  try {
    manifest = yamlLoad(readFileSync(manifestPath, 'utf8')) as TemplateManifest;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== 'object') return null;
  const scriptAbs = resolveScriptAbs(dir, manifest.file);
  if (!scriptAbs) return null;
  return { manifest, scriptAbs, dir, scope };
}

function resolveScriptAbs(dir: string, file: string): string | null {
  if (typeof file !== 'string' || file.length === 0) return null;
  const abs = resolve(dir, file);
  if (!abs.startsWith(dir + sep) && abs !== dir) return null;
  return abs;
}

export interface WriteOptions {
  manifest: TemplateManifest;
  scriptContent: string;
}

export function writeTemplate(
  ws: Workspace, scope: WritableScope, opts: WriteOptions,
): { dir: string; scriptAbs: string } {
  const dir = templateDir(ws, scope, opts.manifest.id);
  mkdirSync(dir, { recursive: true });
  const scriptName = `trigger.${RUNTIME_EXT[opts.manifest.runtime]}`;
  const manifestToWrite: TemplateManifest = { ...opts.manifest, file: scriptName };
  const scriptAbs = join(dir, scriptName);
  writeFileAtomic(scriptAbs, opts.scriptContent);
  writeFileAtomic(join(dir, 'template.yaml'), yamlDump(manifestToWrite));
  return { dir, scriptAbs };
}

export function deleteTemplate(ws: Workspace, scope: WritableScope, id: string): boolean {
  const dir = templateDir(ws, scope, id);
  if (!existsSync(dir)) return false;
  const tomb = `${dir}.deleted-${Date.now()}`;
  renameSync(dir, tomb);
  try { rmSync(tomb, { recursive: true, force: true }); } catch { /* ignore */ }
  return true;
}

export function listAgentAuthoredTemplates(
  ws: Workspace, scope: WritableScope,
): LoadedTemplate[] {
  const root = templateDirRoot(ws, scope);
  if (!existsSync(root)) return [];
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  const out: LoadedTemplate[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (scope === 'project' && entry === '_oneoff') continue;
    const dir = join(root, entry);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const loaded = loadTemplate(ws, scope, entry);
    if (loaded) out.push(loaded);
  }
  return out;
}

// One-off auto-templates --------------------------------------------------

export function mintOneOffId(): string {
  const seed = mintId('oneoff').replace(/^oneoff_/, '');
  return `local.oneoff.${seed}`;
}

export interface OneOffWriteOptions {
  id: string;
  runtime: TriggerRuntime;
  scriptContent: string;
  description?: string;
  bindsCallbackTo?: 'thread_resume';
}

export function writeOneOffTemplate(
  ws: Workspace, opts: OneOffWriteOptions,
): { dir: string; scriptAbs: string } {
  const dir = join(oneoffTemplatesDir(ws), opts.id);
  mkdirSync(dir, { recursive: true });
  const scriptName = `trigger.${RUNTIME_EXT[opts.runtime]}`;
  const scriptAbs = join(dir, scriptName);
  writeFileAtomic(scriptAbs, opts.scriptContent);
  const manifest: TemplateManifest = {
    id: opts.id, file: scriptName, runtime: opts.runtime,
    accepts_webhook: true,
    description: opts.description ?? `One-off trigger registered at ${new Date().toISOString()}.`,
    parameters: [],
  };
  if (opts.bindsCallbackTo) manifest.binds_callback_to = opts.bindsCallbackTo;
  writeFileAtomic(join(dir, 'template.yaml'), yamlDump(manifest));
  return { dir, scriptAbs };
}

export function loadOneOffTemplate(ws: Workspace, id: string): LoadedTemplate | null {
  const dir = join(oneoffTemplatesDir(ws), id);
  const manifestPath = join(dir, 'template.yaml');
  if (!existsSync(manifestPath)) return null;
  let manifest: TemplateManifest;
  try { manifest = yamlLoad(readFileSync(manifestPath, 'utf8')) as TemplateManifest; } catch { return null; }
  const scriptAbs = resolveScriptAbs(dir, manifest.file);
  if (!scriptAbs) return null;
  return { manifest, scriptAbs, dir, scope: 'project' };
}

export function deleteOneOffTemplate(ws: Workspace, id: string): boolean {
  const dir = join(oneoffTemplatesDir(ws), id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function toRegisteredType(loaded: LoadedTemplate): RegisteredTriggerType {
  return {
    ...loaded.manifest,
    source_plugin_id: '',
    scope: loaded.scope,
    file_abs: loaded.scriptAbs,
  } as unknown as RegisteredTriggerType;
}
```

- [ ] **Step 2: Update RegisteredTriggerType.scope to allow project/global**

In `mcp-server/src/workspace.ts`, change `RegisteredTriggerType.scope` (~line 138):

```ts
  scope: `plugin:${string}` | 'global' | 'project';
```

- [ ] **Step 3: Build to verify**

Run: `npm --prefix mcp-server run build`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add mcp-server/src/template-store.ts mcp-server/src/workspace.ts
git commit -m "feat(triggers): template-store module for agent-authored + one-off templates"
```

---

### Task 1.2: Wire the registry merge

**Files:**
- Modify: `mcp-server/src/workspace.ts`

- [ ] **Step 1: Import the template-store helpers**

At the top of `mcp-server/src/workspace.ts` (after the existing imports), add:

```ts
import { listAgentAuthoredTemplates, toRegisteredType } from './template-store.ts';
```

- [ ] **Step 2: Rename and extend `reloadPluginRegistry` → `reloadTypeRegistries`**

In `mcp-server/src/workspace.ts`, rename the function and add the global+project merge after the existing plugin walk. After populating `ws.triggerTypes` with plugin types, append:

```ts
  // ---- Global agent-authored templates (mid precedence — overrides plugins) ----
  for (const loaded of listAgentAuthoredTemplates(ws, 'global')) {
    const id = loaded.manifest.id;
    const prior = ws.triggerTypes.get(id);
    if (prior) {
      ws.triggerTypeErrors.push({
        plugin_id: prior.source_plugin_id || '<global>',
        type_id: id,
        error: `trigger_type id ${id} from ${prior.scope} is shadowed by a global agent-authored template`,
      });
    }
    ws.triggerTypes.set(id, toRegisteredType(loaded));
  }

  // ---- Project agent-authored templates (highest precedence) ----
  for (const loaded of listAgentAuthoredTemplates(ws, 'project')) {
    const id = loaded.manifest.id;
    const prior = ws.triggerTypes.get(id);
    if (prior) {
      ws.triggerTypeErrors.push({
        plugin_id: prior.source_plugin_id || '<project>',
        type_id: id,
        error: `trigger_type id ${id} from ${prior.scope} is shadowed by a project agent-authored template`,
      });
    }
    ws.triggerTypes.set(id, toRegisteredType(loaded));
  }
```

Add an alias export so existing callers keep working:

```ts
/** @deprecated — use reloadTypeRegistries. Kept for back-compat with plugin.ts callers. */
export const reloadPluginRegistry = reloadTypeRegistries;
```

Replace the `export function reloadPluginRegistry(...)` declaration with `export function reloadTypeRegistries(...)`.

- [ ] **Step 3: Update the call in `loadWorkspaceFromEnv`**

Find the line `reloadPluginRegistry(ws);` (~line 197) and change it to `reloadTypeRegistries(ws);`.

- [ ] **Step 4: Build + run existing tests for regressions**

Run: `npm --prefix mcp-server run build`
Expected: PASS

Run: `node --test --import tsx mcp-server/tests/smoke.test.mjs mcp-server/tests/external-plugins.test.mjs mcp-server/tests/workspace.test.mjs`
Expected: PASS (existing trigger.list_types and trigger.register tests still green)

- [ ] **Step 5: Commit**

```
git add mcp-server/src/workspace.ts
git commit -m "feat(triggers): merge agent-authored templates into ws.triggerTypes (project > global > plugin)"
```

---

### Task 1.3: Test the registry merge

**Files:**
- Test: `mcp-server/tests/template-registry.test.mjs` (new)

- [ ] **Step 1: Write the test**

Create `mcp-server/tests/template-registry.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump as yamlDump } from 'js-yaml';

test('agent-authored project template appears in ws.triggerTypes', async () => {
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-tpl-reg-'));
  try {
    const projectDir = join(tmp, 'project');
    const localTplDir = join(projectDir, '.clawdevbox', 'trigger-types', 'local.demo');
    mkdirSync(localTplDir, { recursive: true });
    writeFileSync(join(localTplDir, 'template.yaml'), yamlDump({
      id: 'local.demo', file: 'trigger.ts', runtime: 'tsx', description: 'demo', parameters: [],
    }));
    writeFileSync(join(localTplDir, 'trigger.ts'), '// demo\n');
    mkdirSync(join(tmp, 'global'), { recursive: true });

    const ws = loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: join(tmp, 'global'),
    });
    const t = ws.triggerTypes.get('local.demo');
    assert.ok(t, 'expected local.demo in registry');
    assert.equal(t.scope, 'project');
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('project template shadows global with same id', async () => {
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-tpl-shadow-'));
  try {
    const projectDir = join(tmp, 'project');
    const globalDir = join(tmp, 'global');
    const projTpl = join(projectDir, '.clawdevbox', 'trigger-types', 'local.shared');
    mkdirSync(projTpl, { recursive: true });
    writeFileSync(join(projTpl, 'template.yaml'), yamlDump({ id: 'local.shared', file: 'trigger.ts', runtime: 'tsx' }));
    writeFileSync(join(projTpl, 'trigger.ts'), '// project\n');
    const globTpl = join(globalDir, 'trigger-types', 'local.shared');
    mkdirSync(globTpl, { recursive: true });
    writeFileSync(join(globTpl, 'template.yaml'), yamlDump({ id: 'local.shared', file: 'trigger.ts', runtime: 'tsx' }));
    writeFileSync(join(globTpl, 'trigger.ts'), '// global\n');

    const ws = loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: globalDir,
    });
    const t = ws.triggerTypes.get('local.shared');
    assert.ok(t);
    assert.equal(t.scope, 'project');
    assert.ok(ws.triggerTypeErrors.some((e) => e.type_id === 'local.shared'));
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('_oneoff directory is excluded from project template walk', async () => {
  const { loadWorkspaceFromEnv } = await import('../src/workspace.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'cdb-tpl-oneoff-'));
  try {
    const projectDir = join(tmp, 'project');
    const oneoff = join(projectDir, '.clawdevbox', 'trigger-types', '_oneoff', 'local.oneoff.abc');
    mkdirSync(oneoff, { recursive: true });
    writeFileSync(join(oneoff, 'template.yaml'), yamlDump({ id: 'local.oneoff.abc', file: 'trigger.ts', runtime: 'tsx' }));
    writeFileSync(join(oneoff, 'trigger.ts'), '');

    const ws = loadWorkspaceFromEnv({
      CLAWDEVBOX_PROJECT_DIR: projectDir,
      CLAWDEVBOX_GLOBAL_DIR: join(tmp, 'global'),
    });
    assert.equal(ws.triggerTypes.has('local.oneoff.abc'), false);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
```

- [ ] **Step 2: Run tests**

Run: `node --test --import tsx mcp-server/tests/template-registry.test.mjs`
Expected: PASS (3/3)

- [ ] **Step 3: Commit**

```
git add mcp-server/tests/template-registry.test.mjs
git commit -m "test(triggers): registry merge precedence + _oneoff exclusion"
```

---

## Phase 2 — Trigger runner primitive

### Task 2.1: Create trigger-runner.ts

**Files:**
- Create: `mcp-server/src/trigger-runner.ts`

- [ ] **Step 1: Write the module**

Create `mcp-server/src/trigger-runner.ts`:

```ts
/**
 * trigger-runner.ts
 *
 * The script-spawning primitive. Reused by trigger.test today and intended
 * for the future cron daemon's trigger.fire path.
 *
 * Responsibilities:
 *   - Resolve a runtime to a spawn argv (`tsx` / `node` / `python` / `bash`).
 *   - Spawn the script with the envelope on stdin.
 *   - Capture stdout + stderr.
 *   - Enforce a hard timeout (kills the process tree on Windows + POSIX).
 *   - Parse stdout as JSON if possible (used for Mode A callback extraction).
 *
 * The HTTP receiver for Mode B callbacks lives in tools/trigger.ts (only
 * `trigger.test` needs it — the cron daemon will dispatch Mode B callbacks
 * directly to /callback/* which already exists).
 */

import { spawn } from 'node:child_process';
import { logger } from './logger.ts';
import type { TriggerRuntime } from './validators.ts';

export interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  callback_url: string;
  state: Record<string, unknown>;
  payload: unknown;
}

export interface RunOptions {
  scriptPath: string;
  runtime: TriggerRuntime;
  envelope: TriggerEnvelope;
  callbackSecret: string;
  timeoutMs: number;
  cwd?: string;
  /** Extra env vars merged into the spawn env (CLAWDEVBOX_MCP_SECRET is set by the runner). */
  env?: Record<string, string>;
}

export interface RunResult {
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  stdout_parsed: unknown | null;
}

function spawnArgv(runtime: TriggerRuntime, scriptPath: string): { command: string; args: string[] } {
  switch (runtime) {
    case 'tsx': return { command: 'npx', args: ['tsx', scriptPath] };
    case 'node': return { command: 'node', args: [scriptPath] };
    case 'python': {
      const cmd = process.platform === 'win32' ? 'python' : 'python3';
      return { command: cmd, args: [scriptPath] };
    }
    case 'bash': return { command: 'bash', args: [scriptPath] };
  }
}

export async function runTriggerScript(opts: RunOptions): Promise<RunResult> {
  const { command, args } = spawnArgv(opts.runtime, opts.scriptPath);
  const started = Date.now();
  let timedOut = false;
  let stdout = '';
  let stderr = '';

  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...(opts.env ?? {}),
      CLAWDEVBOX_MCP_SECRET: opts.callbackSecret,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

  child.stdin.end(JSON.stringify(opts.envelope));

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform === 'win32') {
        // SIGKILL maps to TerminateProcess on Windows for spawned children.
        child.kill('SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'trigger-runner: kill-on-timeout failed');
    }
  }, opts.timeoutMs);

  const exitCode: number | null = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  clearTimeout(timer);

  let parsed: unknown | null = null;
  if (stdout.trim()) {
    try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }
  }

  return {
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    timed_out: timedOut,
    stdout, stderr,
    stdout_parsed: parsed,
  };
}
```

- [ ] **Step 2: Build to verify**

Run: `npm --prefix mcp-server run build`
Expected: PASS

- [ ] **Step 3: Commit**

```
git add mcp-server/src/trigger-runner.ts
git commit -m "feat(triggers): trigger-runner primitive (spawn script + envelope)"
```

---

### Task 2.2: Write fixture trigger scripts

**Files:**
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-b.ts`
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-a.ts`
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-ab.ts`
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat-bad-auth.ts`
- Create: `mcp-server/tests/fixtures/trigger-runner/sleep-forever.ts`

- [ ] **Step 1: Mode B — POSTs once, exits 0**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-b.ts`:

```ts
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const secret = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
const res = await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ prompt: 'mode-b heartbeat', context: { run_id: env.run_id } }),
});
if (!res.ok) { process.stderr.write(`callback ${res.status}\n`); process.exit(1); }
process.stdout.write(JSON.stringify({ state: { ticked: true }, systemMessage: 'mode-b done' }));
```

- [ ] **Step 2: Mode A — singular callback in stdout**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-a.ts`:

```ts
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
process.stdout.write(JSON.stringify({
  state: { tickedA: true },
  systemMessage: 'mode-a done',
  callback: { body: { prompt: 'mode-a heartbeat', context: { run_id: env.run_id } } },
}));
```

- [ ] **Step 3: Mode A + B**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat-mode-ab.ts`:

```ts
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const secret = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ prompt: 'mode-b leg', context: { run_id: env.run_id } }),
});
process.stdout.write(JSON.stringify({
  state: { tickedAB: true },
  callback: { body: { prompt: 'mode-a leg', context: { run_id: env.run_id } } },
}));
```

- [ ] **Step 4: Bad auth**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat-bad-auth.ts`:

```ts
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const res = await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
  body: JSON.stringify({ prompt: 'should fail', context: {} }),
});
process.stdout.write(JSON.stringify({
  state: {}, systemMessage: `received ${res.status}`,
}));
```

- [ ] **Step 5: Sleep forever — for timeout test**

Create `mcp-server/tests/fixtures/trigger-runner/sleep-forever.ts`:

```ts
await new Promise(() => { /* never resolves */ });
```

- [ ] **Step 6: Commit fixtures**

```
git add mcp-server/tests/fixtures/trigger-runner/
git commit -m "test(triggers): fixture scripts for trigger-runner (Mode A/B/AB/bad-auth/timeout)"
```

---

### Task 2.3: Test trigger-runner against the fixtures

**Files:**
- Test: `mcp-server/tests/trigger-runner.test.mjs` (new)

- [ ] **Step 1: Write the test (with the ephemeral receiver)**

Create `mcp-server/tests/trigger-runner.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const fixturesDir = resolve(new URL('.', import.meta.url).pathname.replace(/^\//, ''), 'fixtures', 'trigger-runner');

async function startReceiver(secret) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const auth = req.headers['authorization'];
      if (auth !== `Bearer ${secret}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = body; }
      calls.push({ path: req.url, method: req.method, body: parsed, received_at: Date.now() });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/callback/test/abc`,
    calls,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

test('runner: Mode B-only script captures one POSTed callback', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-mode-b');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-b.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_modeb',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-mode-b',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr was: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
    assert.equal(recv.calls[0].body.prompt, 'mode-b heartbeat');
  } finally {
    await recv.stop();
  }
});

test('runner: Mode A-only script — stdout has callback object, no Mode B captures', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-a');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-a.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_modea',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-a',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 0);
    assert.ok(result.stdout_parsed && typeof result.stdout_parsed === 'object');
    assert.equal(result.stdout_parsed.callback.body.prompt, 'mode-a heartbeat');
  } finally {
    await recv.stop();
  }
});

test('runner: Mode A+B — stdout has Mode A, receiver has Mode B', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('secret-ab');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-mode-ab.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_ab',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'secret-ab',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 1);
    assert.equal(recv.calls[0].body.prompt, 'mode-b leg');
    assert.equal(result.stdout_parsed.callback.body.prompt, 'mode-a leg');
  } finally {
    await recv.stop();
  }
});

test('runner: bad bearer token gets 401, captures empty', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('right-secret');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat-bad-auth.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_bad',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'right-secret',
      timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(recv.calls.length, 0);
    assert.match(result.stdout, /received 401/);
  } finally {
    await recv.stop();
  }
});

test('runner: timeout kills the process and reports timed_out', async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('any');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'sleep-forever.ts'),
      runtime: 'tsx',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_to',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'any',
      timeoutMs: 800,
    });
    assert.equal(result.timed_out, true);
    assert.notEqual(result.exit_code, 0);
  } finally {
    await recv.stop();
  }
});
```

- [ ] **Step 2: Run tests**

Run: `node --test --import tsx mcp-server/tests/trigger-runner.test.mjs`
Expected: PASS (5/5). The first run may install `tsx` via npx.

- [ ] **Step 3: Commit**

```
git add mcp-server/tests/trigger-runner.test.mjs
git commit -m "test(triggers): runner tests for Mode A/B/AB/auth/timeout"
```

---

### Task 2.4: Add multi-runtime fixtures

**Files:**
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat.js`
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat.py`
- Create: `mcp-server/tests/fixtures/trigger-runner/heartbeat.sh`

- [ ] **Step 1: Node fixture**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat.js`:

```js
let body = '';
process.stdin.on('data', (c) => { body += c.toString('utf8'); });
process.stdin.on('end', async () => {
  const env = JSON.parse(body);
  const secret = process.env.CLAWDEVBOX_MCP_SECRET || '';
  const res = await fetch(env.callback_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ prompt: 'node tick', context: { run_id: env.run_id } }),
  });
  if (!res.ok) { process.stderr.write(`status ${res.status}\n`); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: { node: true } }));
});
```

- [ ] **Step 2: Python fixture**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat.py`:

```python
import json, os, sys, urllib.request

env = json.loads(sys.stdin.read())
secret = os.environ.get("CLAWDEVBOX_MCP_SECRET", "")
req = urllib.request.Request(
    env["callback_url"],
    data=json.dumps({"prompt": "python tick", "context": {"run_id": env["run_id"]}}).encode(),
    headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"},
    method="POST",
)
with urllib.request.urlopen(req) as r:
    if r.status != 200:
        sys.stderr.write(f"status {r.status}\n"); sys.exit(1)
sys.stdout.write(json.dumps({"state": {"python": True}}))
```

- [ ] **Step 3: Bash fixture**

Create `mcp-server/tests/fixtures/trigger-runner/heartbeat.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BODY=$(cat)
URL=$(printf '%s' "$BODY" | python -c "import sys,json; print(json.load(sys.stdin)['callback_url'])")
RUN=$(printf '%s' "$BODY" | python -c "import sys,json; print(json.load(sys.stdin)['run_id'])")
curl -fsS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CLAWDEVBOX_MCP_SECRET}" \
  -d "{\"prompt\":\"bash tick\",\"context\":{\"run_id\":\"${RUN}\"}}" >/dev/null
echo '{"state":{"bash":true}}'
```

- [ ] **Step 4: Append per-runtime tests to trigger-runner.test.mjs**

Add to the bottom of `mcp-server/tests/trigger-runner.test.mjs`:

```js
import { spawnSync } from 'node:child_process';
function hasCmd(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

test('runner: node runtime', { skip: !hasCmd('node') }, async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('node-secret');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat.js'),
      runtime: 'node',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_node',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'node-secret', timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
  } finally { await recv.stop(); }
});

test('runner: python runtime', { skip: !hasCmd(process.platform === 'win32' ? 'python' : 'python3') }, async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('py-secret');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat.py'),
      runtime: 'python',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_py',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'py-secret', timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
  } finally { await recv.stop(); }
});

test('runner: bash runtime', { skip: !hasCmd('bash') }, async () => {
  const { runTriggerScript } = await import('../src/trigger-runner.ts');
  const recv = await startReceiver('bash-secret');
  try {
    const result = await runTriggerScript({
      scriptPath: resolve(fixturesDir, 'heartbeat.sh'),
      runtime: 'bash',
      envelope: {
        trigger_event_name: 'TriggerFired',
        trigger_id: 'test', run_id: 'run_bash',
        callback_url: recv.url, state: {}, payload: null,
      },
      callbackSecret: 'bash-secret', timeoutMs: 30000,
    });
    assert.equal(result.exit_code, 0, `stderr: ${result.stderr}`);
    assert.equal(recv.calls.length, 1);
  } finally { await recv.stop(); }
});
```

- [ ] **Step 5: Run tests**

Run: `node --test --import tsx mcp-server/tests/trigger-runner.test.mjs`
Expected: PASS (8/8 if all runtimes installed; otherwise some skipped)

- [ ] **Step 6: Commit**

```
git add mcp-server/tests/fixtures/trigger-runner/heartbeat.js mcp-server/tests/fixtures/trigger-runner/heartbeat.py mcp-server/tests/fixtures/trigger-runner/heartbeat.sh mcp-server/tests/trigger-runner.test.mjs
git commit -m "test(triggers): runner tests for node/python/bash runtimes"
```

---

## Phase 3 — Template CRUD MCP tools

### Task 3.1: trigger.create_template (with TDD)

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts`
- Test: `mcp-server/tests/trigger-templates.test.mjs` (new — uses the WsHarness pattern from workspace.test.mjs)

- [ ] **Step 1: Bootstrap the test harness**

Create `mcp-server/tests/trigger-templates.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const entry = resolve(projectRoot, 'src/index.ts');
const repoSampleAdoPlugin = resolve(projectRoot, '..', 'samples', 'plugins', 'ado');

class TplHarness {
  constructor() {
    this.tmpRoot = mkdtempSync(join(tmpdir(), 'cdb-tpl-tools-'));
    this.callerProjectDir = join(this.tmpRoot, 'caller');
    const callerClawdevbox = join(this.callerProjectDir, '.clawdevbox');
    mkdirSync(callerClawdevbox, { recursive: true });
    for (const sub of ['recipes', 'skills', 'triggers', 'artifacts']) {
      mkdirSync(join(callerClawdevbox, sub), { recursive: true });
    }
    this.globalDir = join(this.tmpRoot, '.global');
    const globalAdoPluginDest = join(this.globalDir, 'plugins', 'ado');
    mkdirSync(dirname(globalAdoPluginDest), { recursive: true });
    cpSync(repoSampleAdoPlugin, globalAdoPluginDest, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.endsWith('package-lock.json') && !src.includes('_legacy-mcp-server'),
    });
    const globalNodeModules = join(this.globalDir, 'node_modules');
    if (!existsSync(globalNodeModules)) {
      const linkType = platform() === 'win32' ? 'junction' : 'dir';
      symlinkSync(resolve(projectRoot, 'node_modules'), globalNodeModules, linkType);
    }
    this.serverEnv = {
      ...process.env,
      CLAWDEVBOX_PROJECT_DIR: this.callerProjectDir,
      CLAWDEVBOX_GLOBAL_DIR: this.globalDir,
    };
    this.child = spawn('npx', ['tsx', entry, 'mcp'], {
      cwd: projectRoot, env: this.serverEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    this.stdoutBuf = '';
    this.responses = [];
    this.nextId = 1;
    this.child.stdout.on('data', (d) => {
      this.stdoutBuf += d.toString('utf8');
      let nl;
      while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try { this.responses.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    this.child.stderr.on('data', () => { /* swallow noise */ });
  }
  async ready() {
    await this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
  }
  async call(name, args) {
    const id = this.nextId++;
    await this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return this.awaitResponse(id);
  }
  async send(msg, expectResponse = true) {
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    if (!expectResponse) return null;
    return this.awaitResponse(msg.id);
  }
  awaitResponse(id) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const r = this.responses.find((x) => x.id === id);
        if (r) {
          if (r.error) return reject(new Error(JSON.stringify(r.error)));
          return resolve(r.result);
        }
        if (Date.now() - start > 30000) return reject(new Error(`timeout for id=${id}`));
        setTimeout(tick, 25);
      };
      tick();
    });
  }
  async stop() {
    try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
    if (existsSync(this.tmpRoot)) {
      try { rmSync(this.tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

async function withHarness(fn) {
  const h = new TplHarness();
  try { await h.ready(); await fn(h); } finally { await h.stop(); }
}

test('trigger.create_template happy path writes template + script and reloads registry', async () => {
  await withHarness(async (h) => {
    const res = await h.call('trigger.create_template', {
      id: 'local.demo', scope: 'project', runtime: 'tsx',
      description: 'demo trigger',
      script: '// demo script\n',
      parameters: [{ name: 'repo', type: 'string', required: true }],
    });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(res.structuredContent.id, 'local.demo');
    assert.equal(res.structuredContent.scope, 'project');
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.demo', 'template.yaml');
    const scriptPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.demo', 'trigger.ts');
    assert.ok(existsSync(tplPath));
    assert.ok(existsSync(scriptPath));
    const list = await h.call('trigger.list_types', { search: 'local.demo' });
    const ids = list.structuredContent.trigger_types.map((t) => t.id);
    assert.ok(ids.includes('local.demo'));
  });
});

test('trigger.create_template rejects non-local. id with VALIDATION_FAILED', async () => {
  await withHarness(async (h) => {
    const res = await h.call('trigger.create_template', {
      id: 'demo', scope: 'project', runtime: 'tsx', script: '// x\n',
    });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'VALIDATION_FAILED');
  });
});

test('trigger.create_template rejects neither/both script + script_file with INVALID_REQUEST', async () => {
  await withHarness(async (h) => {
    const neither = await h.call('trigger.create_template', {
      id: 'local.x', scope: 'project', runtime: 'tsx',
    });
    assert.equal(neither.isError, true);
    assert.equal(neither.structuredContent.code, 'INVALID_REQUEST');
    const both = await h.call('trigger.create_template', {
      id: 'local.x', scope: 'project', runtime: 'tsx',
      script: '// x\n', script_file: '.clawdevbox/trigger-types/whatever.ts',
    });
    assert.equal(both.isError, true);
    assert.equal(both.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.create_template rejects double-create with TRIGGER_TEMPLATE_EXISTS', async () => {
  await withHarness(async (h) => {
    const r1 = await h.call('trigger.create_template', {
      id: 'local.dup', scope: 'project', runtime: 'tsx', script: '// x\n',
    });
    assert.ok(!r1.isError);
    const r2 = await h.call('trigger.create_template', {
      id: 'local.dup', scope: 'project', runtime: 'tsx', script: '// y\n',
    });
    assert.equal(r2.isError, true);
    assert.equal(r2.structuredContent.code, 'TRIGGER_TEMPLATE_EXISTS');
  });
});
```

- [ ] **Step 2: Run tests — expected to FAIL**

Run: `node --test --import tsx mcp-server/tests/trigger-templates.test.mjs`
Expected: FAIL — `trigger.create_template` doesn't exist yet.

- [ ] **Step 3: Implement trigger.create_template**

In `mcp-server/src/tools/trigger.ts`, at the top of the file, **change the existing scope.ts import** to add `validationError`:

```ts
import { notFound, structuredError, validationError } from '../scope.ts';
```

Then add the rest of the new imports:

```ts
import { existsSync } from 'node:fs';
import { resolve as pathResolve, sep } from 'node:path';
import {
  validateAgentAuthoredTemplate,
  validateRuntime,
  type TriggerRuntime,
} from '../validators.ts';
import {
  deleteTemplate,
  findTemplate,
  templateExists,
  writeTemplate,
  type TemplateManifest,
} from '../template-store.ts';
import { reloadTypeRegistries } from '../workspace.ts';
```

At the bottom of `registerTriggerTools`, add:

```ts
  // -- trigger.create_template ---------------------------------------------
  server.registerTool(
    'trigger.create_template',
    {
      description:
        'Create a new agent-authored trigger TYPE on disk. Persisted as `<scope>/trigger-types/<id>/template.yaml + trigger.<ext>`. Reloads `ws.triggerTypes` so `trigger.register` can immediately consume it. Id must start with `local.`.',
      inputSchema: {
        id: z.string().min(1).describe("Type id; must match /^local\\.[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)*$/."),
        scope: z.enum(['project', 'global']).optional().describe("Default 'project'."),
        description: z.string().min(1),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']),
        script: z.string().optional().describe('Inline script source. XOR with script_file.'),
        script_file: z.string().optional().describe('Path under <projectDir>/.clawdevbox/. Copied into the template dir.'),
        default_cron: z.string().optional(),
        identity_param: z.string().optional(),
        accepts_webhook: z.boolean().optional(),
        binds_callback_to_recipe: z.string().optional(),
        binds_callback_to: z.literal('thread_resume').optional(),
        parameters: z.array(z.record(z.string(), z.unknown())).optional(),
      },
    },
    async (args) => {
      const scope = args.scope ?? 'project';
      const hasScript = typeof args.script === 'string';
      const hasFile = typeof args.script_file === 'string';
      if (hasScript === hasFile) {
        return structuredError('INVALID_REQUEST',
          'Provide exactly one of `script` (inline) or `script_file` (path).',
          { script_provided: hasScript, script_file_provided: hasFile });
      }

      const manifest: TemplateManifest = {
        id: args.id,
        file: `trigger.${args.runtime === 'tsx' ? 'ts' : args.runtime === 'node' ? 'js' : args.runtime === 'python' ? 'py' : 'sh'}`,
        runtime: args.runtime as TriggerRuntime,
        description: args.description,
      };
      if (args.default_cron !== undefined) manifest.default_cron = args.default_cron;
      if (args.identity_param !== undefined) manifest.identity_param = args.identity_param;
      if (args.accepts_webhook !== undefined) manifest.accepts_webhook = args.accepts_webhook;
      if (args.binds_callback_to_recipe !== undefined) manifest.binds_callback_to_recipe = args.binds_callback_to_recipe;
      if (args.binds_callback_to !== undefined) manifest.binds_callback_to = args.binds_callback_to;
      if (Array.isArray(args.parameters)) manifest.parameters = args.parameters as TemplateManifest['parameters'];

      const validation = validateAgentAuthoredTemplate(manifest);
      if (!validation.ok) {
        return validationError(validation.errors);
      }

      if (templateExists(ws, scope, args.id)) {
        return structuredError('TRIGGER_TEMPLATE_EXISTS',
          `A template with id ${args.id} already exists in scope ${scope}.`,
          { id: args.id, scope });
      }

      let scriptContent: string;
      if (hasScript) {
        scriptContent = args.script!;
      } else {
        const fileGuard = ensureFileUnderClawdevbox(ws.projectDir, args.script_file!);
        if (!fileGuard.ok) return fileGuard.error;
        scriptContent = readFileSync(fileGuard.path, 'utf8');
      }

      const written = writeTemplate(ws, scope, { manifest, scriptContent });
      reloadTypeRegistries(ws);

      return {
        content: [{ type: 'text', text: `Created template ${args.id} (scope=${scope}).` }],
        structuredContent: {
          id: args.id, scope, path: written.dir,
          script_path: written.scriptAbs, type_exists: true,
        },
      };
    },
  );
```

Add the file-guard helper at module top:

```ts
import { readFileSync } from 'node:fs';

function ensureFileUnderClawdevbox(projectDir: string, relPath: string):
  { ok: true; path: string } | { ok: false; error: CallToolResult } {
  const root = pathResolve(projectDir, '.clawdevbox');
  const abs = pathResolve(projectDir, relPath);
  if (!abs.startsWith(root + sep) && abs !== root) {
    return { ok: false, error: structuredError('SCRIPT_FILE_OUTSIDE_WORKSPACE',
      `script_file must resolve under .clawdevbox/. Got: ${relPath}`,
      { script_file: relPath, resolved: abs }) };
  }
  if (!existsSync(abs)) {
    return { ok: false, error: structuredError('SCRIPT_FILE_NOT_FOUND',
      `script_file does not exist: ${relPath}`,
      { script_file: relPath, resolved: abs }) };
  }
  return { ok: true, path: abs };
}
```

- [ ] **Step 4: Build + run tests — expected to PASS**

Run: `npm --prefix mcp-server run build && node --test --import tsx mcp-server/tests/trigger-templates.test.mjs`
Expected: PASS (4/4 for the create_template subtests)

- [ ] **Step 5: Commit**

```
git add mcp-server/src/tools/trigger.ts mcp-server/tests/trigger-templates.test.mjs
git commit -m "feat(triggers): trigger.create_template MCP tool"
```

---

### Task 3.2: trigger.list_templates + extend trigger.list_types projection

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts`
- Modify: `mcp-server/tests/trigger-templates.test.mjs`

- [ ] **Step 1: Add tests**

Append to `mcp-server/tests/trigger-templates.test.mjs`:

```js
test('trigger.list_templates returns only agent-authored types', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.alpha', scope: 'project', runtime: 'tsx',
      description: 'a', script: '// a\n',
    });
    await h.call('trigger.create_template', {
      id: 'local.beta', scope: 'global', runtime: 'tsx',
      description: 'b', script: '// b\n',
    });
    const list = await h.call('trigger.list_templates', {});
    const ids = list.structuredContent.trigger_types.map((t) => t.id).sort();
    assert.deepEqual(ids, ['local.alpha', 'local.beta']);
    const filtered = await h.call('trigger.list_templates', { scope: 'project' });
    const fids = filtered.structuredContent.trigger_types.map((t) => t.id);
    assert.deepEqual(fids, ['local.alpha']);
  });
});
```

- [ ] **Step 2: Implement trigger.list_templates**

In `mcp-server/src/tools/trigger.ts`, after `trigger.create_template` registration, add:

```ts
  server.registerTool(
    'trigger.list_templates',
    {
      description:
        'List agent-authored trigger TYPES (project + global scopes). Equivalent to `trigger.list_types` filtered to scope in {project, global}.',
      inputSchema: {
        scope: z.enum(['project', 'global']).optional(),
        search: z.string().min(1).optional(),
      },
    },
    async (args) => {
      const all = [...ws.triggerTypes.values()].sort((a, b) => a.id.localeCompare(b.id));
      let filtered = all.filter((t) => t.scope === 'project' || t.scope === 'global');
      if (args.scope) filtered = filtered.filter((t) => t.scope === args.scope);
      if (args.search) {
        const q = args.search.toLowerCase();
        filtered = filtered.filter((t) =>
          t.id.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q),
        );
      }
      const projected = filtered.map(projectType);
      return {
        content: [{ type: 'text', text: `Found ${projected.length} agent-authored template(s).` }],
        structuredContent: { trigger_types: projected, count: projected.length },
      };
    },
  );
```

The existing `projectType` helper already passes `scope` through, so the new project/global values surface naturally.

- [ ] **Step 3: Run tests — expected to PASS**

Run: `node --test --import tsx mcp-server/tests/trigger-templates.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add mcp-server/src/tools/trigger.ts mcp-server/tests/trigger-templates.test.mjs
git commit -m "feat(triggers): trigger.list_templates MCP tool"
```

---

### Task 3.3: trigger.update_template

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts`
- Modify: `mcp-server/tests/trigger-templates.test.mjs`

- [ ] **Step 1: Add tests**

Append to `mcp-server/tests/trigger-templates.test.mjs`:

```js
test('trigger.update_template replaces script content and bumps description', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.upd', scope: 'project', runtime: 'tsx',
      description: 'first', script: '// v1\n',
    });
    const upd = await h.call('trigger.update_template', {
      id: 'local.upd', description: 'second', script: '// v2\n',
    });
    assert.ok(!upd.isError, JSON.stringify(upd));
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.upd', 'template.yaml');
    const scriptPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.upd', 'trigger.ts');
    assert.match(readFileSync(tplPath, 'utf8'), /second/);
    assert.match(readFileSync(scriptPath, 'utf8'), /v2/);
  });
});

test('trigger.update_template rejects no-changes call with NO_CHANGES', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.nopu', scope: 'project', runtime: 'tsx', description: 'x', script: '// x\n',
    });
    const r = await h.call('trigger.update_template', { id: 'local.nopu' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'NO_CHANGES');
  });
});

test('trigger.update_template returns TRIGGER_TEMPLATE_NOT_FOUND for missing id', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.update_template', { id: 'local.absent', description: 'x' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'TRIGGER_TEMPLATE_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Implement trigger.update_template**

In `mcp-server/src/tools/trigger.ts`, add after `list_templates`:

```ts
  server.registerTool(
    'trigger.update_template',
    {
      description:
        'Update an agent-authored trigger template in place (project or global). Manifest fields omitted from the call are preserved; script is replaced only when `script` or `script_file` is supplied. Reloads `ws.triggerTypes` on success.',
      inputSchema: {
        id: z.string().min(1),
        description: z.string().optional(),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']).optional(),
        script: z.string().optional(),
        script_file: z.string().optional(),
        default_cron: z.string().optional(),
        identity_param: z.string().optional(),
        accepts_webhook: z.boolean().optional(),
        binds_callback_to_recipe: z.string().optional(),
        binds_callback_to: z.literal('thread_resume').optional(),
        parameters: z.array(z.record(z.string(), z.unknown())).optional(),
      },
    },
    async (args) => {
      const existing = findTemplate(ws, args.id);
      if (!existing) return structuredError('TRIGGER_TEMPLATE_NOT_FOUND',
        `Template ${args.id} not found.`, { id: args.id });

      const hasScript = typeof args.script === 'string';
      const hasFile = typeof args.script_file === 'string';
      if (hasScript && hasFile) {
        return structuredError('INVALID_REQUEST',
          'Provide at most one of `script` or `script_file`.',
          { script_provided: true, script_file_provided: true });
      }
      const manifestKeys = [
        'description', 'runtime', 'default_cron', 'identity_param',
        'accepts_webhook', 'binds_callback_to_recipe', 'binds_callback_to', 'parameters',
      ];
      const anyManifestChange = manifestKeys.some((k) => args[k] !== undefined);
      if (!hasScript && !hasFile && !anyManifestChange) {
        return structuredError('NO_CHANGES',
          'trigger.update_template requires at least one field to change.',
          { id: args.id });
      }

      const merged: TemplateManifest = { ...existing.manifest };
      if (args.runtime !== undefined) {
        const r = validateRuntime(args.runtime);
        if (!r.ok) return validationError([{ path: 'runtime', code: 'ENUM', message: r.message }]);
        merged.runtime = r.runtime;
        merged.file = `trigger.${r.runtime === 'tsx' ? 'ts' : r.runtime === 'node' ? 'js' : r.runtime === 'python' ? 'py' : 'sh'}`;
      }
      if (args.description !== undefined) merged.description = args.description;
      if (args.default_cron !== undefined) merged.default_cron = args.default_cron;
      if (args.identity_param !== undefined) merged.identity_param = args.identity_param;
      if (args.accepts_webhook !== undefined) merged.accepts_webhook = args.accepts_webhook;
      if (args.binds_callback_to_recipe !== undefined) merged.binds_callback_to_recipe = args.binds_callback_to_recipe;
      if (args.binds_callback_to !== undefined) merged.binds_callback_to = args.binds_callback_to;
      if (Array.isArray(args.parameters)) merged.parameters = args.parameters as TemplateManifest['parameters'];

      const validation = validateAgentAuthoredTemplate(merged);
      if (!validation.ok) return validationError(validation.errors);

      let scriptContent: string;
      if (hasScript) {
        scriptContent = args.script!;
      } else if (hasFile) {
        const guard = ensureFileUnderClawdevbox(ws.projectDir, args.script_file!);
        if (!guard.ok) return guard.error;
        scriptContent = readFileSync(guard.path, 'utf8');
      } else {
        scriptContent = readFileSync(existing.scriptAbs, 'utf8');
      }

      // If runtime changed, the old script file (with the old extension) is now
      // orphaned — drop it so we don't leave stale files behind.
      if (args.runtime !== undefined && existing.manifest.runtime !== merged.runtime) {
        try { rmSync(existing.scriptAbs, { force: true }); } catch { /* ignore */ }
      }

      const written = writeTemplate(ws, existing.scope, { manifest: merged, scriptContent });
      reloadTypeRegistries(ws);

      return {
        content: [{ type: 'text', text: `Updated template ${args.id}.` }],
        structuredContent: { id: args.id, scope: existing.scope, path: written.dir },
      };
    },
  );
```

Add `import { rmSync } from 'node:fs';` to the file's imports.

- [ ] **Step 3: Run tests**

Run: `npm --prefix mcp-server run build && node --test --import tsx mcp-server/tests/trigger-templates.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add mcp-server/src/tools/trigger.ts mcp-server/tests/trigger-templates.test.mjs
git commit -m "feat(triggers): trigger.update_template MCP tool"
```

---

### Task 3.4: trigger.delete_template (with in-use guard)

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts`
- Modify: `mcp-server/tests/trigger-templates.test.mjs`

- [ ] **Step 1: Add tests**

Append to `mcp-server/tests/trigger-templates.test.mjs`:

```js
test('trigger.delete_template removes the directory and reloads registry', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.del', scope: 'project', runtime: 'tsx',
      description: 'x', script: '// x\n',
    });
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', 'local.del');
    assert.ok(existsSync(dir));
    const res = await h.call('trigger.delete_template', { id: 'local.del' });
    assert.ok(!res.isError, JSON.stringify(res));
    assert.equal(existsSync(dir), false);
    const list = await h.call('trigger.list_types', { search: 'local.del' });
    assert.equal(list.structuredContent.trigger_types.length, 0);
  });
});

test('trigger.delete_template refuses while a registered instance still references it', async () => {
  await withHarness(async (h) => {
    await h.call('trigger.create_template', {
      id: 'local.busy', scope: 'project', runtime: 'tsx',
      description: 'x', script: '// x\n',
      parameters: [{ name: 'repo', type: 'string', required: true }],
    });
    const reg = await h.call('trigger.register', {
      type_id: 'local.busy', params: { repo: 'svc' },
    });
    assert.ok(!reg.isError);
    const del = await h.call('trigger.delete_template', { id: 'local.busy' });
    assert.equal(del.isError, true);
    assert.equal(del.structuredContent.code, 'TRIGGER_TEMPLATE_IN_USE');
    assert.ok(Array.isArray(del.structuredContent.registered_ids));
  });
});

test('trigger.delete_template refuses to delete a plugin-shipped TYPE', async () => {
  await withHarness(async (h) => {
    const res = await h.call('trigger.delete_template', { id: 'ado.new-pr-watcher' });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'TRIGGER_TEMPLATE_NOT_AUTHORED');
  });
});
```

- [ ] **Step 2: Implement trigger.delete_template**

In `mcp-server/src/tools/trigger.ts`, add after `update_template`:

```ts
  server.registerTool(
    'trigger.delete_template',
    {
      description:
        'Delete an agent-authored trigger template by id. Refuses to delete plugin-shipped TYPES (use plugin.uninstall) or templates referenced by registered instances (unregister first).',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const existing = findTemplate(ws, args.id);
      if (!existing) {
        const inMap = ws.triggerTypes.get(args.id);
        if (inMap && inMap.scope.startsWith('plugin:')) {
          return structuredError('TRIGGER_TEMPLATE_NOT_AUTHORED',
            `${args.id} is a plugin-shipped trigger type. Use plugin.uninstall to remove it.`,
            { id: args.id, scope: inMap.scope });
        }
        return structuredError('TRIGGER_TEMPLATE_NOT_FOUND',
          `Template ${args.id} not found.`, { id: args.id });
      }
      // In-use guard.
      const file = readTriggersFile(triggersJsonPath(ws));
      const refs = file.registered.filter((r) => r.type === args.id).map((r) => r.id);
      if (refs.length > 0) {
        return structuredError('TRIGGER_TEMPLATE_IN_USE',
          `Template ${args.id} is referenced by ${refs.length} registered instance(s). Unregister them first.`,
          { id: args.id, registered_ids: refs });
      }
      const removed = deleteTemplate(ws, existing.scope, args.id);
      reloadTypeRegistries(ws);
      return {
        content: [{ type: 'text', text: `Deleted template ${args.id} (scope=${existing.scope}).` }],
        structuredContent: { id: args.id, scope: existing.scope, removed },
      };
    },
  );
```

- [ ] **Step 3: Run tests**

Run: `npm --prefix mcp-server run build && node --test --import tsx mcp-server/tests/trigger-templates.test.mjs`
Expected: PASS

- [ ] **Step 4: Commit**

```
git add mcp-server/src/tools/trigger.ts mcp-server/tests/trigger-templates.test.mjs
git commit -m "feat(triggers): trigger.delete_template with in-use + plugin-shipped guards"
```

---

## Phase 4 — trigger.register XOR(type_id | script | script_file)

### Task 4.1: Extend trigger.register with one-off paths

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts`
- Modify: `mcp-server/tests/trigger-templates.test.mjs`

- [ ] **Step 1: Add tests**

Append to `mcp-server/tests/trigger-templates.test.mjs`:

```js
test('trigger.register XOR(type_id|script|script_file) — neither is INVALID_REQUEST', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', { params: {} });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.register with inline script writes _oneoff template + once:true cron:false defaults', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', {
      script: '// inline\n', runtime: 'tsx',
    });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.adhoc, true);
    assert.match(r.structuredContent.template_id, /^local\.oneoff\./);
    assert.equal(r.structuredContent.registered.once, true);
    assert.equal(r.structuredContent.registered.cron, false);
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff', r.structuredContent.template_id);
    assert.ok(existsSync(join(dir, 'template.yaml')));
    assert.ok(existsSync(join(dir, 'trigger.ts')));
  });
});

test('trigger.register with script but no runtime fails RUNTIME_REQUIRED', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', { script: '// x\n' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'RUNTIME_REQUIRED');
  });
});

test('trigger.register with subscriber_thread_id sets binds_callback_to thread_resume in the auto-template', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.register', {
      script: '// hot\n', runtime: 'tsx', subscriber_thread_id: 'thr_abc',
    });
    assert.ok(!r.isError);
    const tplPath = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff',
      r.structuredContent.template_id, 'template.yaml');
    assert.match(readFileSync(tplPath, 'utf8'), /binds_callback_to:\s*thread_resume/);
  });
});

test('trigger.unregister removes _oneoff dir for one-off registrations', async () => {
  await withHarness(async (h) => {
    const reg = await h.call('trigger.register', { script: '// once\n', runtime: 'tsx' });
    assert.ok(!reg.isError);
    const dir = join(h.callerProjectDir, '.clawdevbox', 'trigger-types', '_oneoff', reg.structuredContent.template_id);
    assert.ok(existsSync(dir));
    const un = await h.call('trigger.unregister', { id: reg.structuredContent.id });
    assert.ok(!un.isError);
    assert.equal(existsSync(dir), false);
  });
});
```

- [ ] **Step 2: Extend trigger.register implementation**

In `mcp-server/src/tools/trigger.ts`, replace the `trigger.register` registration (~line 218) with:

```ts
  server.registerTool(
    'trigger.register',
    {
      description:
        'Register a trigger instance. Three mutually-exclusive sources: (a) `type_id` for a saved TYPE; (b) `script` for an inline one-off; (c) `script_file` for a file under `.clawdevbox/`. One-off paths default to `once: true`, `cron: false` (manual/webhook only). Validates params against the type schema (where one exists), mints `<type_id>#<key>` (or auto-template id for one-offs), and writes to `triggers.json`.',
      inputSchema: {
        type_id: z.string().min(1).optional(),
        script: z.string().optional(),
        script_file: z.string().optional(),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']).optional()
          .describe('Required when script or script_file is supplied.'),
        params: z.record(z.string(), z.unknown()).optional(),
        cron: z.union([z.string(), z.null(), z.literal(false), z.literal('')]).optional(),
        subscriber_thread_id: z.string().min(1).optional(),
        expires_at: z.number().optional(),
        once: z.boolean().optional(),
      },
    },
    async (args) => {
      const sources = [args.type_id, args.script, args.script_file].filter((x) => typeof x === 'string').length;
      if (sources !== 1) {
        return structuredError('INVALID_REQUEST',
          'Provide exactly one of `type_id`, `script`, or `script_file`.',
          { type_id_provided: !!args.type_id, script_provided: !!args.script, script_file_provided: !!args.script_file });
      }

      let typeId: string;
      let isAdhoc = false;
      let oneoffTemplateId: string | null = null;

      if (args.type_id) {
        typeId = args.type_id;
      } else {
        if (!args.runtime) {
          return structuredError('RUNTIME_REQUIRED',
            'runtime is required when supplying script or script_file.', {});
        }
        let scriptContent: string;
        if (args.script) {
          scriptContent = args.script;
        } else {
          const guard = ensureFileUnderClawdevbox(ws.projectDir, args.script_file!);
          if (!guard.ok) return guard.error;
          scriptContent = readFileSync(guard.path, 'utf8');
        }
        oneoffTemplateId = mintOneOffId();
        writeOneOffTemplate(ws, {
          id: oneoffTemplateId,
          runtime: args.runtime as TriggerRuntime,
          scriptContent,
          bindsCallbackTo: args.subscriber_thread_id ? 'thread_resume' : undefined,
        });
        // Make the auto-template visible to the lookup below.
        const loaded = loadOneOffTemplate(ws, oneoffTemplateId);
        if (!loaded) {
          return structuredError('TRIGGER_TEMPLATE_WRITE_FAILED',
            'Failed to read back the one-off template just written.', { id: oneoffTemplateId });
        }
        ws.triggerTypes.set(oneoffTemplateId, toRegisteredType(loaded));
        typeId = oneoffTemplateId;
        isAdhoc = true;
      }

      const type = ws.triggerTypes.get(typeId);
      if (!type) {
        return structuredError('TRIGGER_TYPE_NOT_FOUND',
          `Trigger type ${typeId} is not declared by any loaded plugin or template.`,
          { type_id: typeId });
      }

      const params = args.params ?? {};
      const paramsCheck = validateTriggerParams(type.parameters, params);
      if (!paramsCheck.ok) {
        if (isAdhoc && oneoffTemplateId) deleteOneOffTemplate(ws, oneoffTemplateId);
        return paramValidationError(paramsCheck.errors);
      }

      const cronInput = args.cron === undefined && isAdhoc ? false : args.cron;
      const cronCheck = normalizeCron(cronInput);
      if (!cronCheck.ok) {
        if (isAdhoc && oneoffTemplateId) deleteOneOffTemplate(ws, oneoffTemplateId);
        return paramValidationError([{ path: 'cron', code: 'CRON_INVALID', message: cronCheck.message }]);
      }

      const id = mintRegisteredId(type.id, paramsCheck.params, type.identity_param);
      const path = triggersJsonPath(ws);
      const file = readTriggersFile(path);
      if (file.registered.some((r) => r.id === id)) {
        if (isAdhoc && oneoffTemplateId) deleteOneOffTemplate(ws, oneoffTemplateId);
        return structuredError('TRIGGER_ALREADY_REGISTERED',
          `A registered trigger with id ${id} already exists.`,
          { id, type_id: type.id });
      }

      const initialState: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(paramsCheck.params)) initialState[k] = v;

      const row: RegisteredTrigger = {
        id, type: type.id, params: paramsCheck.params,
        cron: cronCheck.cron, enabled: true,
        subscriber_thread_id: args.subscriber_thread_id ?? null,
        expires_at: args.expires_at ?? null,
        once: args.once ?? (isAdhoc ? true : false),
        registered_at: Date.now(),
        state: initialState,
        last_run_at: null, last_run_status: null, last_run_error: null,
      };
      file.registered = [...file.registered, row];
      writeTriggersFile(path, file);

      return {
        content: [{ type: 'text', text: `Registered trigger ${id} (type=${type.id}${isAdhoc ? ', adhoc' : ''}).` }],
        structuredContent: {
          id, type: type.id, registered: projectRegistered(row, ws),
          adhoc: isAdhoc, template_id: oneoffTemplateId,
        },
      };
    },
  );
```

- [ ] **Step 3: Update trigger.unregister to clean up _oneoff dirs**

Replace the `trigger.unregister` handler in `mcp-server/src/tools/trigger.ts` (~line 311) with:

```ts
  server.registerTool(
    'trigger.unregister',
    {
      description:
        'Remove a registered trigger instance by id. For one-off registrations, also drops the auto-template directory under `_oneoff/`. The underlying TYPE stays available for non-oneoff types.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      const path = triggersJsonPath(ws);
      const file = readTriggersFile(path);
      const row = file.registered.find((r) => r.id === args.id);
      if (!row) return notFound('registered_trigger', args.id);
      file.registered = file.registered.filter((r) => r.id !== args.id);
      writeTriggersFile(path, file);
      let oneoffRemoved = false;
      if (row.type.startsWith('local.oneoff.')) {
        oneoffRemoved = deleteOneOffTemplate(ws, row.type);
        ws.triggerTypes.delete(row.type);
      }
      return {
        content: [{ type: 'text', text: `Unregistered trigger ${args.id}${oneoffRemoved ? ' (template removed)' : ''}.` }],
        structuredContent: { id: args.id, removed: 1, oneoff_template_removed: oneoffRemoved },
      };
    },
  );
```

Add the new imports at the file top:

```ts
import {
  deleteOneOffTemplate, loadOneOffTemplate, mintOneOffId, toRegisteredType,
  writeOneOffTemplate,
} from '../template-store.ts';
```

- [ ] **Step 4: Run tests**

Run: `npm --prefix mcp-server run build && node --test --import tsx mcp-server/tests/trigger-templates.test.mjs mcp-server/tests/smoke.test.mjs`
Expected: PASS (existing trigger.register/unregister tests still pass + new XOR tests pass)

- [ ] **Step 5: Commit**

```
git add mcp-server/src/tools/trigger.ts mcp-server/tests/trigger-templates.test.mjs
git commit -m "feat(triggers): trigger.register XOR(type_id|script|script_file) + oneoff cleanup on unregister"
```

---

## Phase 5 — trigger.test

### Task 5.1: Implement and test trigger.test

**Files:**
- Modify: `mcp-server/src/tools/trigger.ts`
- Modify: `mcp-server/tests/trigger-templates.test.mjs`

- [ ] **Step 1: Add tests**

Append to `mcp-server/tests/trigger-templates.test.mjs`:

```js
test('trigger.test with inline script captures Mode B callback', async () => {
  await withHarness(async (h) => {
    const script = `
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const secret = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${secret}\` },
  body: JSON.stringify({ prompt: 'inline test', context: {} }),
});
process.stdout.write(JSON.stringify({ state: { ok: true } }));
`;
    const r = await h.call('trigger.test', { script, runtime: 'tsx', timeout_ms: 30000 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.exit_code, 0);
    assert.equal(r.structuredContent.timed_out, false);
    assert.ok(Array.isArray(r.structuredContent.callbacks));
    assert.equal(r.structuredContent.callbacks.length, 1);
    assert.equal(r.structuredContent.callbacks[0].mode, 'B');
    assert.equal(r.structuredContent.callbacks[0].body.prompt, 'inline test');
  });
});

test('trigger.test by template_id resolves a saved template', async () => {
  await withHarness(async (h) => {
    const script = `
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
process.stdout.write(JSON.stringify({ callback: { body: { prompt: 'tpl-test' } } }));
`;
    await h.call('trigger.create_template', {
      id: 'local.tpl-test', scope: 'project', runtime: 'tsx',
      description: 'tpl', script,
    });
    const r = await h.call('trigger.test', { template_id: 'local.tpl-test', timeout_ms: 30000 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.exit_code, 0);
    assert.equal(r.structuredContent.callbacks.length, 1);
    assert.equal(r.structuredContent.callbacks[0].mode, 'A');
    assert.equal(r.structuredContent.callbacks[0].body.prompt, 'tpl-test');
  });
});

test('trigger.test by registered id uses the bound params + state', async () => {
  await withHarness(async (h) => {
    const script = `
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
process.stdout.write(JSON.stringify({ callback: { body: { prompt: 'reg', state: env.state } } }));
`;
    await h.call('trigger.create_template', {
      id: 'local.regtest', scope: 'project', runtime: 'tsx',
      description: 'reg', script,
      parameters: [{ name: 'repo', type: 'string', required: true }],
    });
    const reg = await h.call('trigger.register', {
      type_id: 'local.regtest', params: { repo: 'svc' }, cron: false,
    });
    assert.ok(!reg.isError);
    const r = await h.call('trigger.test', { id: reg.structuredContent.id, timeout_ms: 30000 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.callbacks[0].body.state.repo, 'svc');
  });
});

test('trigger.test enforces XOR(id|template_id|script)', async () => {
  await withHarness(async (h) => {
    const r = await h.call('trigger.test', {});
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, 'INVALID_REQUEST');
  });
});

test('trigger.test honors timeout_ms and reports timed_out', async () => {
  await withHarness(async (h) => {
    const script = `await new Promise(() => {});`;
    const r = await h.call('trigger.test', { script, runtime: 'tsx', timeout_ms: 800 });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.timed_out, true);
  });
});
```

- [ ] **Step 2: Implement trigger.test**

In `mcp-server/src/tools/trigger.ts`, append at the bottom of `registerTriggerTools`:

```ts
  server.registerTool(
    'trigger.test',
    {
      description:
        'Run a trigger script with a synthesized envelope and capture the result. NON-MUTATING — does not write to triggers.json or update state. Three input sources (XOR): `id` (registered instance), `template_id` (saved type, any scope), or `script` + `runtime` (inline). Captures Mode A (stdout `callback.body`) and Mode B (HTTP POST to a fresh ephemeral 127.0.0.1 receiver) callbacks; receiver enforces `Authorization: Bearer <fresh-secret>` like the real /callback/* endpoints. Hard timeout (default 30s).',
      inputSchema: {
        id: z.string().min(1).optional(),
        template_id: z.string().min(1).optional(),
        script: z.string().optional(),
        runtime: z.enum(['node', 'tsx', 'python', 'bash']).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
        state: z.record(z.string(), z.unknown()).optional(),
        payload: z.unknown().optional(),
        timeout_ms: z.number().int().positive().max(600000).optional(),
      },
    },
    async (args) => {
      const sources = [args.id, args.template_id, args.script].filter((x) => typeof x === 'string').length;
      if (sources !== 1) {
        return structuredError('INVALID_REQUEST',
          'Provide exactly one of `id`, `template_id`, or `script`.', {});
      }

      let scriptPath: string;
      let runtime: TriggerRuntime;
      let parameters: TriggerTypeParameter[] = [];
      let resolvedTriggerId: string;
      let defaultParams: Record<string, unknown> = {};
      let defaultState: Record<string, unknown> = {};

      let tmpScriptPath: string | null = null;

      if (args.script) {
        if (!args.runtime) {
          return structuredError('RUNTIME_REQUIRED',
            'runtime is required when supplying script.', {});
        }
        runtime = args.runtime as TriggerRuntime;
        const ext = runtime === 'tsx' ? 'ts' : runtime === 'node' ? 'js' : runtime === 'python' ? 'py' : 'sh';
        const tmpDir = mkdtempSync(join(tmpdir(), 'cdb-trigger-test-'));
        tmpScriptPath = join(tmpDir, `inline.${ext}`);
        writeFileSync(tmpScriptPath, args.script);
        scriptPath = tmpScriptPath;
        resolvedTriggerId = 'inline';
      } else if (args.template_id) {
        const loaded = findTemplate(ws, args.template_id) ?? loadOneOffTemplate(ws, args.template_id);
        let typeFromRegistry = ws.triggerTypes.get(args.template_id);
        if (!loaded && !typeFromRegistry) {
          return structuredError('TRIGGER_TEMPLATE_NOT_FOUND',
            `Template ${args.template_id} not found.`, { template_id: args.template_id });
        }
        if (loaded) {
          scriptPath = loaded.scriptAbs;
          runtime = (loaded.manifest.runtime ?? 'tsx') as TriggerRuntime;
          parameters = (loaded.manifest.parameters ?? []) as TriggerTypeParameter[];
        } else {
          scriptPath = typeFromRegistry!.file_abs;
          runtime = ((typeFromRegistry as unknown as { runtime?: TriggerRuntime }).runtime ?? 'tsx') as TriggerRuntime;
          parameters = typeFromRegistry!.parameters ?? [];
        }
        resolvedTriggerId = args.template_id;
      } else {
        // by registered id
        const file = readTriggersFile(triggersJsonPath(ws));
        const row = file.registered.find((r) => r.id === args.id);
        if (!row) return notFound('registered_trigger', args.id!);
        const type = ws.triggerTypes.get(row.type);
        const oneoffLoaded = type ? null : loadOneOffTemplate(ws, row.type);
        if (!type && !oneoffLoaded) {
          return structuredError('TRIGGER_TYPE_NOT_FOUND',
            `Type ${row.type} for registration ${row.id} not found.`,
            { id: row.id, type_id: row.type });
        }
        if (type) {
          scriptPath = type.file_abs;
          runtime = ((type as unknown as { runtime?: TriggerRuntime }).runtime ?? 'tsx') as TriggerRuntime;
          parameters = type.parameters ?? [];
        } else {
          scriptPath = oneoffLoaded!.scriptAbs;
          runtime = oneoffLoaded!.manifest.runtime;
          parameters = oneoffLoaded!.manifest.parameters ?? [];
        }
        resolvedTriggerId = row.id;
        defaultParams = row.params;
        defaultState = row.state;
      }

      const params = args.params ?? defaultParams;
      if (parameters.length > 0) {
        const paramsCheck = validateTriggerParams(parameters, params);
        if (!paramsCheck.ok) {
          if (tmpScriptPath) try { rmSync(dirname(tmpScriptPath), { recursive: true, force: true }); } catch { /* ignore */ }
          return paramValidationError(paramsCheck.errors);
        }
      }
      const state = args.state ?? (Object.keys(defaultState).length > 0 ? defaultState : { ...params });
      const payload = args.payload ?? null;

      const secret = randomBytes(24).toString('hex');
      const captures: Array<{ mode: 'A' | 'B'; path: string; method: string; body: unknown; received_at: number }> = [];
      const httpServer = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c.toString('utf8'); });
        req.on('end', () => {
          if (req.headers['authorization'] !== `Bearer ${secret}`) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { parsed = body; }
          captures.push({
            mode: 'B', path: req.url ?? '/', method: req.method ?? 'POST',
            body: parsed, received_at: Date.now(),
          });
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
      const port = (httpServer.address() as { port: number }).port;
      const runId = mintId('run');
      const callbackUrl = `http://127.0.0.1:${port}/callback/test/${runId}`;

      let runResult: Awaited<ReturnType<typeof runTriggerScript>> | null = null;
      try {
        runResult = await runTriggerScript({
          scriptPath, runtime,
          envelope: {
            trigger_event_name: 'TriggerFired',
            trigger_id: resolvedTriggerId, run_id: runId,
            callback_url: callbackUrl, state, payload,
          },
          callbackSecret: secret,
          timeoutMs: args.timeout_ms ?? 30000,
        });
      } finally {
        await new Promise<void>((r) => httpServer.close(() => r()));
        if (tmpScriptPath) {
          try { rmSync(dirname(tmpScriptPath), { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }

      // Mode A — extract from stdout_parsed.callback.body if present.
      const parsed = runResult.stdout_parsed as { callback?: { body?: unknown } } | null;
      const modeAList: typeof captures = [];
      if (parsed && typeof parsed === 'object' && parsed.callback && typeof parsed.callback === 'object') {
        modeAList.push({
          mode: 'A', path: callbackUrl, method: 'POST',
          body: (parsed.callback as { body?: unknown }).body ?? null,
          received_at: Date.now(),
        });
      }
      const callbacks = [...modeAList, ...captures];

      return {
        content: [{
          type: 'text',
          text: `trigger.test (${resolvedTriggerId}): exit=${runResult.exit_code}, timed_out=${runResult.timed_out}, callbacks=${callbacks.length}, ${runResult.duration_ms}ms`,
        }],
        structuredContent: {
          run_id: runId,
          exit_code: runResult.exit_code,
          duration_ms: runResult.duration_ms,
          timed_out: runResult.timed_out,
          stdout: runResult.stdout,
          stderr: runResult.stderr,
          stdout_parsed: runResult.stdout_parsed,
          callbacks,
        },
      };
    },
  );
```

Add the new imports at file top:

```ts
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runTriggerScript } from '../trigger-runner.ts';
import type { TriggerTypeParameter } from '../workspace.ts';
```

- [ ] **Step 3: Run tests**

Run: `npm --prefix mcp-server run build && node --test --import tsx mcp-server/tests/trigger-templates.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the full node test suite for regressions**

Run: `node --test --import tsx mcp-server/tests/*.test.mjs`
Expected: PASS (all existing + new)

- [ ] **Step 5: Commit**

```
git add mcp-server/src/tools/trigger.ts mcp-server/tests/trigger-templates.test.mjs
git commit -m "feat(triggers): trigger.test MCP tool — spawn + capture Mode A/B callbacks"
```

---

## Phase 6 — Documentation + live verification

### Task 6.1: Update docs/tools/trigger.md

**Files:**
- Modify: `docs/tools/trigger.md`

- [ ] **Step 1: Append the new tools to the surface table**

In `docs/tools/trigger.md`, find the "## Tools" section and add subsections for `trigger.create_template`, `trigger.update_template`, `trigger.delete_template`, `trigger.list_templates`, and `trigger.test`. Document the XOR extension on `trigger.register`. Use the same per-tool format the existing tools use (description, inputs table, returns block, errors block, edge cases).

For example, the new section for `trigger.create_template`:

```md
### `trigger.create_template`

Create a new agent-authored trigger TYPE. Persisted as a `template.yaml` +
`trigger.<ext>` pair under `<scope>/trigger-types/<id>/`. Reloads
`ws.triggerTypes` so `trigger.register` can immediately consume it.

**Input fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Required. Must match `^local\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$`. |
| `scope` | `"project" | "global"` | Default `"project"`. |
| `description` | string | Required. |
| `runtime` | `"node" | "tsx" | "python" | "bash"` | Required. |
| `script` | string | XOR with `script_file`. Inline source. |
| `script_file` | string | XOR with `script`. Path under `.clawdevbox/`. |
| `default_cron` | string | Optional. |
| `identity_param` | string | Optional. |
| `accepts_webhook` | boolean | Optional. |
| `binds_callback_to_recipe` | string | XOR with `binds_callback_to`. |
| `binds_callback_to` | `"thread_resume"` | XOR with `binds_callback_to_recipe`. |
| `parameters` | array | Same shape as plugin types. |

**Returns:** `{ id, scope, path, script_path, type_exists: true }`.

**Errors:** `INVALID_REQUEST`, `VALIDATION_FAILED`, `TRIGGER_TEMPLATE_EXISTS`,
`SCRIPT_FILE_OUTSIDE_WORKSPACE`, `SCRIPT_FILE_NOT_FOUND`.
```

Mirror this for the other four tools and the `trigger.register` extension.

- [ ] **Step 2: Add a "Lifecycle: agent-authored templates" subsection**

After the existing two-layer model section, add a short walkthrough showing the create_template → register → test → unregister path, mirroring the spec §5 examples.

- [ ] **Step 3: Commit**

```
git add docs/tools/trigger.md
git commit -m "docs(triggers): document agent-authored templates + register XOR + trigger.test"
```

---

### Task 6.2: Regenerate the composed master doc

**Files:**
- Modify: `docs/MCP-TOOLS-REFERENCE.md` (regenerated)

- [ ] **Step 1: Run the regenerator**

Run: `python docs/scripts/compose_master_doc.py`
Expected: writes `docs/MCP-TOOLS-REFERENCE.md` in place.

- [ ] **Step 2: Commit**

```
git add docs/MCP-TOOLS-REFERENCE.md
git commit -m "docs: regenerate MCP-TOOLS-REFERENCE.md after trigger surface changes"
```

---

### Task 6.3: Live verification

**Files:**
- (None — runtime verification)

- [ ] **Step 1: Build + restart the live service**

Run:
```
npm --prefix mcp-server run build
Remove-Item -Recurse -Force "C:\.tools\.npm\cache\_npx" -ErrorAction SilentlyContinue
# Then restart the running clawdevbox service via its supervisor (or `npx clawdevbox restart`).
```

Expected: service reports the new tools count (existing + 5).

- [ ] **Step 2: Smoke test via stdio MCP**

Use the stdio MCP to:
1. `trigger.create_template` with `id=local.smoke`, `runtime=tsx`, `description=smoke`, inline `script` that writes `{ callback: { body: { prompt: 'hi' } } }` to stdout.
2. `trigger.test` with `template_id=local.smoke` — expect `callbacks[0].mode === 'A'` and `body.prompt === 'hi'`.
3. `trigger.register` with `script="...", runtime="bash"` — expect `adhoc: true`, `template_id` starting with `local.oneoff.`.
4. Verify `<projectDir>/.clawdevbox/trigger-types/_oneoff/<id>/` exists with `template.yaml` + `trigger.sh`.
5. `trigger.unregister` with the returned `id` — expect `oneoff_template_removed: true` and the `_oneoff/<id>/` directory gone.
6. `trigger.delete_template { id: 'local.smoke' }` — expect success, then `trigger.list_templates` returns empty.

Expected: all 6 steps succeed.

- [ ] **Step 3: Commit any incidental fixes from live verification**

If the live test surfaced any issues, fix them and run all tests again before committing.

```
git add -A
git commit -m "fix(triggers): live-verification follow-ups"
```

---

## Self-Review Notes

This plan implements every section of the spec at `docs/specs/2026-05-14-agent-authored-trigger-templates-design.md`:

- Spec §4.1 (disk layout) — Task 0.1, 1.1
- Spec §4.2 (registry merge) — Task 1.2, 1.3
- Spec §4.3 (naming rule) — Task 0.2 (validateLocalTriggerTypeId)
- Spec §4.4.1 create_template — Task 3.1
- Spec §4.4.2 update_template — Task 3.3
- Spec §4.4.3 delete_template — Task 3.4
- Spec §4.4.4 list_templates — Task 3.2
- Spec §4.4.5 register XOR — Task 4.1
- Spec §4.4.6 trigger.test — Task 5.1
- Spec §4.5 trigger-runner.ts — Task 2.1
- Spec §4.6 validators — Task 0.2
- Spec §4.7 workspace boot — Task 1.2
- Spec §6 data shapes — covered by manifest writes in Tasks 1.1, 3.1, 4.1
- Spec §7 error codes — emitted across Tasks 3.1-5.1
- Spec §8 security — `ensureFileUnderClawdevbox` (Task 3.1), bearer enforcement (Task 5.1), atomic writes (Task 1.1)
- Spec §9 compatibility — `reloadPluginRegistry` alias (Task 1.2), runtime optional on plugin types (Task 0.2 step 5)
- Spec §10 testing — Tasks 0.2, 1.3, 2.3, 2.4, 3.1-3.4, 4.1, 5.1, 6.3





