# Non-Interactive Launcher Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every clawdevbox-managed Copilot and Agency launch pass `--no-ask-user` immediately before one `--yolo`.

**Architecture:** Keep argument construction local to each provider. Strengthen each repository's existing launcher test surface first, then make the smallest argv change; Agency also removes its duplicate `--yolo` and updates its spawn documentation.

**Tech Stack:** TypeScript, Node.js ESM, `node:test`, npm.

---

## File Map

- Modify `mcp-server/tests/agent-clis.test.mjs`: assert the Copilot permission flags are unique and adjacent.
- Modify `mcp-server/src/agent-clis/copilot.ts`: insert `--no-ask-user` before `--yolo`.
- Modify `C:\git\agency-provider\test-fixture.mjs`: capture Agency spawn argv and assert the permission pair.
- Modify `C:\git\agency-provider\package.json`: make `npm test` run the fixture.
- Modify `C:\git\agency-provider\agency-provider.mjs`: replace duplicate `--yolo` pushes with one final permission pair.
- Modify `C:\git\agency-provider\README.md`: document the current spawn shape and permission flags.

### Task 1: Copilot provider argument pair

**Files:**
- Modify: `mcp-server/tests/agent-clis.test.mjs:112-123`
- Modify: `mcp-server/src/agent-clis/copilot.ts:99-104`

- [ ] **Step 1: Write the failing Copilot argv assertions**

Replace the existing `--yolo` presence assertion in the Copilot matrix test with:

```js
    const noAskIdx = c.args.indexOf('--no-ask-user');
    const yoloIdx = c.args.indexOf('--yolo');
    assert.equal(
      c.args.filter((arg) => arg === '--no-ask-user').length,
      1,
      `expected one --no-ask-user: ${c.args.join(' ')}`,
    );
    assert.equal(
      c.args.filter((arg) => arg === '--yolo').length,
      1,
      `expected one --yolo: ${c.args.join(' ')}`,
    );
    assert.equal(
      yoloIdx,
      noAskIdx + 1,
      `--no-ask-user must immediately precede --yolo: ${c.args.join(' ')}`,
    );
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
Set-Location C:\git\clawdevbox\mcp-server
node --import tsx --test --test-name-pattern="copilot argv" tests\agent-clis.test.mjs
```

Expected: FAIL because `--no-ask-user` is absent, so `yoloIdx` is not `noAskIdx + 1`.

- [ ] **Step 3: Add the Copilot launcher flag**

Change the initial argv in `copilot.ts` to:

```ts
    const argv: string[] = [
      `--session-id=${opts.init.session_id}`,
      '--no-ask-user',
      '--yolo',
      '--additional-mcp-config', `@${mcpPath}`,
    ];
```

Update the nearby permission comment to state that `--no-ask-user` suppresses
interactive confirmation prompts and must stay immediately before `--yolo`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
Set-Location C:\git\clawdevbox\mcp-server
node --import tsx --test --test-name-pattern="copilot argv" tests\agent-clis.test.mjs
```

Expected: all six Copilot argv matrix cases PASS.

- [ ] **Step 5: Commit the Copilot change**

Run:

```powershell
Set-Location C:\git\clawdevbox
git add -- mcp-server\src\agent-clis\copilot.ts mcp-server\tests\agent-clis.test.mjs
git commit -m "fix: suppress prompts in Copilot launches" `
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" `
  -m "Copilot-Session: 8c756da9-8785-4e15-bd67-cdce7ce90fce"
```

Expected: one commit containing only the Copilot provider and its test.

### Task 2: Agency provider argument pair

**Files:**
- Modify: `C:\git\agency-provider\test-fixture.mjs:1-3,85-145`
- Modify: `C:\git\agency-provider\package.json:7-9`
- Modify: `C:\git\agency-provider\agency-provider.mjs:286-292,358-361`
- Modify: `C:\git\agency-provider\README.md:42-55`

- [ ] **Step 1: Make the Agency fixture assert spawn argv**

Add the strict assertion import:

```js
import assert from 'node:assert/strict';
```

In `testCwdFix`, replace the throwing `spawnPty` stub with a capturing fake:

```js
  let capturedSpawn;
  const ctx = {
    ws: { projectDir: serverProjectDir, globalDir: join(tmp, 'global') },
    logger: { warn: () => {}, debug: () => {} },
    writeWorkspaceFile: (rel, content) => { wsfWrites.push({ rel, content }); },
    spawnPty: (file, args, spawnOpts) => {
      capturedSpawn = { file, args, opts: spawnOpts };
      return {
        pid: 12345,
        onExit(cb) {
          setImmediate(() => cb({ exitCode: 0, signal: 0 }));
          return { dispose() {} };
        },
        onData() { return { dispose() {} }; },
        write() {},
        kill() {},
        resize() {},
      };
    },
  };
```

Replace the expected-error spawn block with:

```js
  const handle = await provider.spawnSession(ctx, opts);
  await handle.exited;
```

After the existing workspace-file assertions, add:

```js
  assert.ok(capturedSpawn, 'spawnPty should capture the Agency launch');
  const noAskIdx = capturedSpawn.args.indexOf('--no-ask-user');
  const yoloIdx = capturedSpawn.args.indexOf('--yolo');
  assert.equal(
    capturedSpawn.args.filter((arg) => arg === '--no-ask-user').length,
    1,
    `expected one --no-ask-user: ${capturedSpawn.args.join(' ')}`,
  );
  assert.equal(
    capturedSpawn.args.filter((arg) => arg === '--yolo').length,
    1,
    `expected one --yolo: ${capturedSpawn.args.join(' ')}`,
  );
  assert.equal(
    yoloIdx,
    noAskIdx + 1,
    `--no-ask-user must immediately precede --yolo: ${capturedSpawn.args.join(' ')}`,
  );
```

Change `package.json` so the existing fixture is the package test:

```json
  "scripts": {
    "test": "node test-fixture.mjs"
  },
```

- [ ] **Step 2: Run the Agency test and verify it fails**

Run:

```powershell
Set-Location C:\git\agency-provider
npm test
```

Expected: FAIL because `--no-ask-user` is absent and `--yolo` occurs twice.

- [ ] **Step 3: Replace duplicate Agency permission flags**

Delete the earlier `argv.push('--yolo')` block near the MCP arguments.
Replace the final permission block with:

```js
    // Suppress Agency confirmation prompts and grant full Copilot tool,
    // path, and URL permissions. Keep these adjacent and last so the
    // permission pair overrides any earlier narrowing flags.
    argv.push('--no-ask-user', '--yolo');
```

- [ ] **Step 4: Update the Agency spawn documentation**

Replace the README spawn example and bullets with:

````markdown
```text
agency copilot --mcp teams --session-id <session_id> \
  --additional-mcp-config @<session>.mcp.json \
  [--model <model>] [--agent <agent>] [-p <prompt>] \
  --no-ask-user --yolo
```

- Every spawned session ends with `--no-ask-user --yolo` so it can run without confirmation prompts.
- Headless sessions additionally pass `-p <prompt>`.
````

- [ ] **Step 5: Run the Agency test and verify it passes**

Run:

```powershell
Set-Location C:\git\agency-provider
npm test
```

Expected: the fixture exits 0, prints `cwd-fix test: PASS`, and all permission
flag assertions pass.

- [ ] **Step 6: Commit the Agency change**

Run:

```powershell
Set-Location C:\git\agency-provider
git add -- agency-provider.mjs test-fixture.mjs package.json README.md
git commit -m "fix: suppress prompts in Agency launches" `
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" `
  -m "Copilot-Session: 8c756da9-8785-4e15-bd67-cdce7ce90fce"
```

Expected: one commit containing only the Agency provider, fixture, package
test command, and README.

### Task 3: Cross-repository verification

**Files:**
- Verify only; no additional files.

- [ ] **Step 1: Type-check clawdevbox**

Run:

```powershell
Set-Location C:\git\clawdevbox\mcp-server
npm run typecheck
```

Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 2: Re-run both targeted test commands**

Run:

```powershell
Set-Location C:\git\clawdevbox\mcp-server
node --import tsx --test --test-name-pattern="copilot argv" tests\agent-clis.test.mjs

Set-Location C:\git\agency-provider
npm test
```

Expected: both commands exit 0.

- [ ] **Step 3: Inspect final repository state**

Run:

```powershell
Set-Location C:\git\clawdevbox
git status --short
git --no-pager show --stat --oneline HEAD

Set-Location C:\git\agency-provider
git status --short
git --no-pager show --stat --oneline HEAD
```

Expected: clawdevbox still shows only the user's pre-existing unrelated dirty
files; the latest implementation commit contains only the Copilot provider and
test. Agency-provider is clean and its latest commit contains only the four
planned files.
