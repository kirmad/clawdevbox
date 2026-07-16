/**
 * boot-self-link.test.mjs
 *
 * Regression test for the duplicate `ensureClawdevboxSelfLink` bug.
 *
 * Before this fix, `tools/plugin.ts::locateHostNodeModules` called a
 * LOCAL `ensureClawdevboxSelfLink` that created a JUNCTION at
 * `<hostNodeModules>/clawdevbox` → `<pkgRoot>`. Subsequent calls to
 * `clawdevbox init` (which delegates to the modern stub-package writer
 * in `builtin-marketplace.ts`) replaced that junction with a real
 * directory containing `package.json` + `stub-*.mjs`. The long-running
 * clawdevbox process kept its cached Node ESM `package.json` exports
 * (which still pointed at `dist/agent-clis.mjs` via the deleted
 * junction) and any subsequent dynamic `import('clawdevbox/agent-clis')`
 * from a plugin failed with
 * `Cannot find module '.../node_modules/clawdevbox/dist/agent-clis.mjs'`.
 *
 * Symptom for the user: inbox replies that hit the resume path of
 * `spawnDispatchOrResume` returned `RESUME_FAILED`, so the session was
 * never actually resumed.
 *
 * Fix: `tools/plugin.ts::locateHostNodeModules` now delegates to the
 * single stub-package writer in `builtin-marketplace.ts`. The boot path
 * matches init, no junction ever leaks, and the cached resolution is
 * stable across init runs.
 *
 * This test asserts that locateHostNodeModules writes a stub package
 * (with `package.json` + `stub-N.mjs`) and NEVER a junction at
 * `<hostNodeModules>/clawdevbox`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureClawdevboxSelfLink } from '../src/builtin-marketplace.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

function tmpHostNodeModules() {
  const dir = mkdtempSync(join(tmpdir(), 'cdb-self-link-'));
  const nm = join(dir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  return { dir, nm };
}

test('ensureClawdevboxSelfLink writes a stub package (NOT a junction) when the slot is empty', () => {
  const { dir, nm } = tmpHostNodeModules();
  try {
    ensureClawdevboxSelfLink(nm);
    const stubDir = join(nm, 'clawdevbox');
    assert.equal(existsSync(stubDir), true, 'stub dir must exist');
    // Must NOT be a symlink/junction (that was the legacy bug).
    assert.equal(
      lstatSync(stubDir).isSymbolicLink(),
      false,
      'stub MUST be a real directory, not a symlink/junction',
    );
    const pkg = JSON.parse(readFileSync(join(stubDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'clawdevbox');
    // `./agent-clis` must resolve to a relative ./stub-N.mjs file inside
    // the stub dir, NOT a direct path to dist/agent-clis.mjs (which is
    // what the old junction-cached resolution returned).
    const agentClis = pkg.exports?.['./agent-clis']?.default;
    assert.ok(
      typeof agentClis === 'string' && agentClis.startsWith('./stub-'),
      `'./agent-clis' default must be a ./stub-N.mjs re-export, got ${agentClis}`,
    );
    // The stub file itself must exist and re-export from the canonical
    // dist via a file:// URL.
    const stubFile = join(stubDir, agentClis.slice(2));
    assert.equal(existsSync(stubFile), true, `${stubFile} must exist`);
    const body = readFileSync(stubFile, 'utf8');
    assert.match(body, /file:\/\/.*agent-clis\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureClawdevboxSelfLink replaces an existing junction (legacy stub) with a real stub package', () => {
  const { dir, nm } = tmpHostNodeModules();
  try {
    // Simulate the legacy state: a junction pointing back at pkgRoot.
    const linkPath = join(nm, 'clawdevbox');
    try {
      const type = process.platform === 'win32' ? 'junction' : 'dir';
      symlinkSync(pkgRoot, linkPath, type);
    } catch (err) {
      // On POSIX dev machines without symlink perms, skip.
      console.warn(`skipping junction-setup: ${err?.message ?? err}`);
      return;
    }
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'pre: must be junction');

    ensureClawdevboxSelfLink(nm);

    assert.equal(existsSync(linkPath), true, 'post: stub must exist');
    assert.equal(
      lstatSync(linkPath).isSymbolicLink(),
      false,
      'post: stub MUST be a real directory, not a junction',
    );
    const pkg = JSON.parse(readFileSync(join(linkPath, 'package.json'), 'utf8'));
    assert.ok(pkg.exports?.['./agent-clis']?.default?.startsWith('./stub-'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('locateHostNodeModules (boot path) writes a stub — not a junction', async () => {
  // Smoke test that the boot path in `tools/plugin.ts` delegates to the
  // stub-package writer. We can't easily redirect `thisDir` from outside,
  // so we just call locateHostNodeModules() and assert the host's own
  // stub is a real dir (not a junction). This is the regression that
  // would have caught the duplicate-function bug.
  const { locateHostNodeModules } = await import('../src/tools/plugin.ts');
  const hostNm = locateHostNodeModules();
  assert.ok(hostNm, 'locateHostNodeModules should resolve when running from this checkout');
  const linkPath = join(hostNm, 'clawdevbox');
  assert.equal(existsSync(linkPath), true);
  assert.equal(
    lstatSync(linkPath).isSymbolicLink(),
    false,
    'host stub MUST be a real directory after boot — never a junction',
  );
});
