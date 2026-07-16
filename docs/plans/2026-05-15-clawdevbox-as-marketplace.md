# Clawdevbox-as-Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Single subagent dispatch — changes are small, mechanical, and tightly coupled.

**Goal:** Turn the clawdevbox repo into its own Claude-Code-style marketplace. Move built-ins out of `samples/plugins/` into top-level `plugins/`. Ship `clawdevbox-mcp` (required), `dev-buddy` (recommended, extracted from kernel code), and `ado` (optional). Replace `BUILTIN_PLUGINS` + `installBuiltinPlugin` + `seedDevBuddySkill` with the standard marketplace install path. After init, `clawdevbox-mcp` propagates to the configured CLI through the existing bidirectional sync.

**Architecture:** A new `.claude-plugin/marketplace.json` at repo root references three local plugin dirs. `ensureBuiltinMarketplaceRegistered()` junctions the bundled marketplace into `<globalDir>/marketplaces/clawdevbox/` at init + boot. Init's existing marketplace consumer reads it; a new tier-driven install step handles `required` / `recommended` / `optional` plugins. The downstream bidirectional sync (already in place) forwards everything to the configured CLI.

**Tech Stack:** TypeScript, node:test, `@clack/prompts`, existing manifest + marketplace loader.

**Spec:** `docs/specs/2026-05-15-clawdevbox-as-marketplace-design.md`

**Baseline:** HEAD `eb3bdb3` on `main`. 409/409 tests passing. Pre-existing typecheck errors at `template-store.ts:155`, `tools/trigger.ts:658`, `tools/trigger.ts:778`.

---

## File structure

**New files:**
- `.claude-plugin/marketplace.json` — repo-root marketplace catalog.
- `plugins/clawdevbox-mcp/.claude-plugin/plugin.json`
- `plugins/clawdevbox-mcp/.mcp.json`
- `plugins/dev-buddy/.claude-plugin/plugin.json`
- `plugins/dev-buddy/skills/dev-buddy/SKILL.md` — content extracted from `main-agent.ts`.
- `mcp-server/src/builtin-marketplace.ts` — renamed from `builtin-plugins.ts`; new helpers.
- `mcp-server/tests/builtin-marketplace.test.mjs` — new tests.

**Moved (git mv):**
- `samples/plugins/ado/` → `plugins/ado/` (entire directory; preserve git history via `git mv`).

**Modified:**
- `mcp-server/src/cli/init.ts` — drop `BUILTIN_PLUGINS` multi-select; add tier-driven step; add `--no-builtin` flag.
- `mcp-server/src/cli/mcp.ts` — cwd fallback for `CLAWDEVBOX_PROJECT_DIR`.
- `mcp-server/src/workspace.ts` — cwd fallback in `loadWorkspaceFromEnv`.
- `mcp-server/src/main-agent.ts` — delete `seedDevBuddySkill`, `DEV_BUDDY_SKILL_BODY`, `DEV_BUDDY_SKILL_ID`, the call site at line 174.
- `scripts/build.mjs` — produce `dist/marketplace/`.
- `mcp-server/tests/hosted-tools.test.mjs` — path comment.
- `mcp-server/tests/smoke.test.mjs` — path comment.
- `samples/README.md` — note: plugins moved to `plugins/`.
- `docs/plugins.md` — document built-in marketplace, install_tier, `--no-builtin`.
- `docs/agent-clis.md` — note that bidirectional sync now installs `clawdevbox-mcp` automatically.

**Deleted:**
- `samples/plugins/` directory (after `git mv`, the parent dir is removed if empty).
- `mcp-server/src/builtin-plugins.ts` (renamed — `git mv` to `builtin-marketplace.ts`).

---

## Phase 1 — Single subagent dispatch (everything below)

### Task 1.1: Add the marketplace skeleton + move ADO

Commit: `feat(repo): clawdevbox is a marketplace; move ado out of samples`

Steps:
1. Create `.claude-plugin/marketplace.json` with the content from spec §4 (three plugins, install_tier annotations).
2. Run `git mv samples/plugins/ado plugins/ado` (preserves history; everything inside the dir moves intact).
3. If `samples/plugins/` is now empty, leave it for git to clean up; otherwise check what's left and decide.
4. Update `samples/README.md` to note the move:
   ```
   ## Note: built-in plugins moved
   
   Built-in plugins (ado, dev-buddy, clawdevbox-mcp) now live at the
   repo-root `plugins/` directory. This directory keeps only sample
   recipes and trigger fixtures used by tests.
   ```
5. `npm test` — expect tests that path-reference `samples/plugins/ado` to fail until Task 1.4 updates them. If failures are limited to path comments (not actual code paths), proceed; otherwise fix the test breakage now.

Note: the `samples/plugins/ado/` directory has `node_modules/` and `_legacy-mcp-server/` subdirs that ARE in git today. After `git mv`, those move too. Inspect the result: if any of these are >100MB or otherwise problematic, leave them out of the move by `git mv` -ing just the necessary files instead. **Pragmatic call**: try `git mv samples/plugins/ado plugins/ado` first; if the result is fine in terms of size, keep it. If git is unhappy, fall back to a manual file-by-file move.

### Task 1.2: Built-in plugins

Commit: `feat(plugins): clawdevbox-mcp + dev-buddy built-in plugins`

Steps:
1. Create `plugins/clawdevbox-mcp/.claude-plugin/plugin.json` and `plugins/clawdevbox-mcp/.mcp.json` per spec §5.1.
2. Create `plugins/dev-buddy/.claude-plugin/plugin.json` per spec §5.2.
3. Extract the `DEV_BUDDY_SKILL_BODY` content from `mcp-server/src/main-agent.ts:61-125` and write it byte-for-byte to `plugins/dev-buddy/skills/dev-buddy/SKILL.md`. Pay attention to the YAML frontmatter and any escape sequences (the JS string literal escapes `\\` and `\``).
4. Verify the extracted SKILL.md parses cleanly: `node -e "const yaml=require('js-yaml'); const fs=require('fs'); const text=fs.readFileSync('plugins/dev-buddy/skills/dev-buddy/SKILL.md','utf8'); const fm = text.match(/^---\\n([\\s\\S]*?)\\n---/)?.[1]; console.log(yaml.load(fm));"`.
5. Don't delete `seedDevBuddySkill` from main-agent.ts yet — that happens in Task 1.4.

### Task 1.3: Marketplace registration + rename

Commit: `feat(builtin-marketplace): ensureBuiltinMarketplaceRegistered + resolver`

Steps:
1. `git mv mcp-server/src/builtin-plugins.ts mcp-server/src/builtin-marketplace.ts`.
2. In the renamed file, delete the `BUILTIN_PLUGINS` array, `BuiltinPluginDef` interface, `installBuiltinPlugin` function, and `resolveBuiltinPluginSource` function.
3. Add `resolveBuiltinMarketplaceSource(): string | null` per spec §6. Walks 4 candidate paths looking for `.claude-plugin/marketplace.json`.
4. Add `ensureBuiltinMarketplaceRegistered(cfg: ResolvedConfig): void` per spec §6. Idempotent: if `<globalDir>/marketplaces/clawdevbox.json` exists, no-op. Else junction the source dir and write the sidecar with `kind: 'builtin'`.
5. Keep `ensureGlobalNodeModulesLink` unchanged.
6. Add tests in `mcp-server/tests/builtin-marketplace.test.mjs`:
   - `resolveBuiltinMarketplaceSource` returns the repo root in dev.
   - `ensureBuiltinMarketplaceRegistered` is idempotent.
   - Junction failure → WARN-only (mock `fs.symlinkSync` to throw).
7. Update any imports of the old file path to the new one. Run `grep -rn "builtin-plugins" mcp-server/src` to find them.
8. Add the new test file to `mcp-server/package.json` `"test"` script.

### Task 1.4: Init rewrite + main-agent cleanup + cwd fallback

Commit: `feat(init): tier-driven built-in install; drop BUILTIN_PLUGINS; cwd fallback in cli/mcp.ts`

Steps:
1. In `mcp-server/src/cli/init.ts`:
   - Remove imports of `BUILTIN_PLUGINS`, `installBuiltinPlugin` (now-missing from `builtin-marketplace.ts`).
   - Add import of `ensureBuiltinMarketplaceRegistered` from the renamed file.
   - At the top of `runInit`, call `ensureBuiltinMarketplaceRegistered(cfg)` BEFORE the `--plugin` install pass.
   - Replace the existing `BUILTIN_PLUGINS.map(...)` multi-select block (around line 332-345) with the tier-driven step per spec §8:
     - Load `<globalDir>/marketplaces/clawdevbox/` via `loadMarketplace`.
     - Auto-install every plugin with `install_tier === 'required'` via `installFromLocalFolder`.
     - Build a multi-select for `install_tier === 'recommended'` (pre-checked) + `install_tier === 'optional'` (unchecked).
     - Install each user-picked plugin via `installFromLocalFolder`.
     - Skip step 5 entirely if `flags['no-builtin']` is set.
   - Replace the existing `installBuiltinPlugin(globalDir, id)` call (around line 475) with the tier-driven step's install logic.
   - Add `--no-builtin` to the recognized init flags.
   - Add a PATH diagnostic right after the auto-install: call `which('clawdevbox')` (or use `child_process.spawnSync('where', ['clawdevbox'])` on Windows, `which clawdevbox` on POSIX); if not found, print a `note(...)` warning.
2. In `mcp-server/src/main-agent.ts`:
   - Delete `DEV_BUDDY_SKILL_ID` constant.
   - Delete `DEV_BUDDY_SKILL_BODY` constant (~70 lines).
   - Delete `seedDevBuddySkill` function (lines 127-141 ish).
   - Delete the call site at line 174.
   - Verify nothing else in the file references those identifiers.
3. In `mcp-server/src/workspace.ts`:
   - In `loadWorkspaceFromEnv`, change:
     ```ts
     const projectDir = env.CLAWDEVBOX_PROJECT_DIR;
     if (!projectDir || projectDir.trim() === '') {
       throw new WorkspaceConfigError(
         'CLAWDEVBOX_PROJECT_DIR env var is required (path to the workspace root).',
       );
     }
     ```
     To:
     ```ts
     let projectDir = env.CLAWDEVBOX_PROJECT_DIR?.trim();
     if (!projectDir) projectDir = process.cwd();
     if (!existsSync(projectDir)) {
       throw new WorkspaceConfigError(
         `Resolved project dir does not exist: ${projectDir}`,
       );
     }
     ```
4. In `mcp-server/src/cli/mcp.ts`:
   - Confirm it uses `loadWorkspaceFromEnv` (which now has the fallback). No code change needed unless `cli/mcp.ts` does its own env-var check first.
5. Run `npm test` — fix any test breakage caused by the workspace fallback (tests that previously expected the throw may need adjustment).
6. Add tests for the init flow:
   - `--no-builtin` skips step 5.
   - With no `--no-builtin`, `clawdevbox-mcp` lands in `<globalDir>/plugins/`.
   - Mock `@clack/prompts.multiselect` to return `['dev-buddy']` → `dev-buddy` lands in `<globalDir>/plugins/`; `ado` does not.

### Task 1.5: Build script + dist marketplace

Commit: `feat(build): produce dist/marketplace/ with bundled plugins`

Steps:
1. In `scripts/build.mjs`, find the existing logic that copies `samples/plugins/*` to `dist/plugins/*`. Replace with:
   - Read `<repo>/.claude-plugin/marketplace.json` to determine which plugins to copy.
   - Copy each `<repo>/plugins/<name>/` to `<dist>/marketplace/plugins/<name>/`.
   - Copy `<repo>/.claude-plugin/marketplace.json` to `<dist>/marketplace/.claude-plugin/marketplace.json`.
   - Use the same filter as today (skip `node_modules/`, `_legacy-*`).
2. Remove the `dist/plugins/` output entirely.
3. Update `resolveBuiltinMarketplaceSource` to look at `<module-dir>/../marketplace` (published-package layout) AS WELL AS `<module-dir>/../../marketplace` (one level up).
4. `npm run build` and verify `dist/marketplace/.claude-plugin/marketplace.json` exists; `dist/marketplace/plugins/clawdevbox-mcp/.claude-plugin/plugin.json` exists; `dist/plugins/` does NOT exist.

### Task 1.6: Tests + docs

Commit: `test+docs: built-in marketplace coverage + samples/README; regen master ref`

Steps:
1. Add integration tests in `mcp-server/tests/builtin-marketplace.test.mjs`:
   - Load `<repo-root>` as a marketplace via `loadMarketplace` → assert 3 plugins, correct `install_tier` values.
   - Each plugin's `.claude-plugin/plugin.json` passes `validatePluginManifestJson`.
   - The marketplace.json passes `validateMarketplaceJson`.
2. Add a byte-for-byte diff test: read `plugins/dev-buddy/skills/dev-buddy/SKILL.md`; assert its content (after stripping any LF/CRLF normalization differences) matches a known-good reference. Pragmatic: just assert frontmatter `name: Dev Buddy` and a couple key prose lines.
3. Update `mcp-server/tests/hosted-tools.test.mjs:33` and `mcp-server/tests/smoke.test.mjs:6` path comments from `samples/plugins/ado` → `plugins/ado`.
4. Add an end-to-end test that runs init programmatically against a fake `copilot` CLI binary (reuse existing `fake-copilot.cjs` fixture):
   - `clawdevbox-mcp` lands in `<globalDir>/plugins/`.
   - The fake CLI's `calls.jsonl` records `marketplace add` AND `plugin install clawdevbox-mcp@clawdevbox`.
5. Update docs:
   - `docs/plugins.md`: new section "Built-in marketplace" covering the schema, `install_tier`, `--no-builtin` flag.
   - `docs/agent-clis.md`: note that bidirectional sync now installs `clawdevbox-mcp` automatically.
   - `samples/README.md`: see Task 1.1.
6. Regenerate `docs/MCP-TOOLS-REFERENCE.md`: `python docs/scripts/compose_master_doc.py`.

---

## Rules
- **NEVER use Haiku.**
- `npm test` and `npm run typecheck` after EVERY commit.
- Co-authored-by trailer on every commit.
- Stay on `main`.
- Pre-existing 3 typecheck errors stay. No new errors.
- Don't break the 409-test baseline.

## Deliverables
1. Git SHAs (6 commits in order 1.1-1.6)
2. Final test count (~409 baseline + new tests)
3. Final typecheck (3 pre-existing only)
4. `npm run build` succeeds; `dist/marketplace/` exists with the expected layout
5. `grep -rn "BUILTIN_PLUGINS\\|installBuiltinPlugin\\|seedDevBuddy\\|DEV_BUDDY_SKILL_BODY" mcp-server/src` is empty (or only matches comments referencing the migration)
6. `Get-ChildItem samples\\plugins` returns empty or doesn't exist
7. `Get-ChildItem plugins` shows the three built-in plugin dirs
8. Live smoke: start the service in a tmp project, hit `GET /api/agent-clis` to confirm everything still works
9. Final HEAD SHA

Begin now.
