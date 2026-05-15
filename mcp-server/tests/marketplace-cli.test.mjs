/**
 * marketplace-cli.test.mjs
 *
 * Tests for `clawdevbox marketplace {add,list,update,remove}` (Phase 5.3).
 * Exercises local-junction marketplaces against a per-test `<globalDir>`.
 * Git-clone paths require network and are intentionally not covered here.
 *
 * Lives in a separate file from marketplace-load.test.mjs because importing
 * `src/cli/marketplace.ts` (and its transitive `config.ts`) under
 * `node --import tsx --test` interacts badly with later sync `test()` calls
 * in the same file — splitting keeps the loader stable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMarketplace } from '../src/cli/marketplace.ts';

function write(p, body) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
}

function claudeMarketplace() {
  return {
    name: 'demo-mp',
    owner: { name: 'demo team', email: 'demo@example.com' },
    description: 'demo marketplace',
    version: '1.0.0',
    plugins: [
      { name: 'plug-a', source: './plugins/plug-a', version: '0.1.0' },
      { name: 'plug-b', source: './plugins/plug-b' },
    ],
  };
}

function captureStdio() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    out.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  return {
    out,
    err,
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

async function withGlobalDir(fn) {
  const globalDir = mkdtempSync(join(tmpdir(), 'cdb-mp-cli-'));
  const prev = process.env.CLAWDEVBOX_GLOBAL_DIR;
  const prevProj = process.env.CLAWDEVBOX_PROJECT_DIR;
  process.env.CLAWDEVBOX_GLOBAL_DIR = globalDir;
  process.env.CLAWDEVBOX_PROJECT_DIR = globalDir;
  try {
    return await fn(globalDir);
  } finally {
    if (prev === undefined) delete process.env.CLAWDEVBOX_GLOBAL_DIR;
    else process.env.CLAWDEVBOX_GLOBAL_DIR = prev;
    if (prevProj === undefined) delete process.env.CLAWDEVBOX_PROJECT_DIR;
    else process.env.CLAWDEVBOX_PROJECT_DIR = prevProj;
    rmSync(globalDir, { recursive: true, force: true });
  }
}

test('runMarketplace: add local + list + update + remove round-trip', async () => {
  await withGlobalDir(async (globalDir) => {
    const mpRoot = mkdtempSync(join(tmpdir(), 'cdb-mp-src-'));
    try {
      write(join(mpRoot, '.claude-plugin', 'marketplace.json'), claudeMarketplace());

      // add
      let cap = captureStdio();
      let rc;
      try {
        rc = await runMarketplace(['add', mpRoot]);
      } finally {
        cap.restore();
      }
      assert.equal(rc, 0, cap.err.join(''));
      assert.match(cap.out.join(''), /added marketplace 'demo-mp'/);
      assert.match(cap.out.join(''), /2 plugins available/);

      // sidecar present and well-formed
      const sidecar = join(globalDir, 'marketplaces', 'demo-mp.json');
      assert.ok(existsSync(sidecar));
      const rec = JSON.parse(readFileSync(sidecar, 'utf8'));
      assert.equal(rec.kind, 'local');
      assert.equal(rec.pluginCount, 2);

      // list shows the marketplace
      cap = captureStdio();
      try {
        rc = await runMarketplace(['list']);
      } finally {
        cap.restore();
      }
      assert.equal(rc, 0);
      assert.match(cap.out.join(''), /demo-mp/);

      // update on a local marketplace is a no-op note
      cap = captureStdio();
      try {
        rc = await runMarketplace(['update']);
      } finally {
        cap.restore();
      }
      assert.equal(rc, 0);
      assert.match(cap.out.join(''), /local marketplaces are live/);

      // remove
      cap = captureStdio();
      try {
        rc = await runMarketplace(['remove', 'demo-mp']);
      } finally {
        cap.restore();
      }
      assert.equal(rc, 0);
      assert.match(cap.out.join(''), /removed marketplace 'demo-mp'/);
      assert.ok(!existsSync(sidecar));
    } finally {
      rmSync(mpRoot, { recursive: true, force: true });
    }
  });
});

test('runMarketplace: list with no marketplaces installed', async () => {
  await withGlobalDir(async () => {
    const cap = captureStdio();
    let rc;
    try {
      rc = await runMarketplace(['list']);
    } finally {
      cap.restore();
    }
    assert.equal(rc, 0);
    assert.match(cap.out.join(''), /no marketplaces installed/);
  });
});

test('runMarketplace: add missing source → exit 2', async () => {
  await withGlobalDir(async () => {
    const cap = captureStdio();
    let rc;
    try {
      rc = await runMarketplace(['add']);
    } finally {
      cap.restore();
    }
    assert.equal(rc, 2);
    assert.match(cap.err.join(''), /<source> is required/);
  });
});

test('runMarketplace: remove unknown id → exit 1', async () => {
  await withGlobalDir(async () => {
    const cap = captureStdio();
    let rc;
    try {
      rc = await runMarketplace(['remove', 'nonexistent']);
    } finally {
      cap.restore();
    }
    assert.equal(rc, 1);
    assert.match(cap.err.join(''), /not installed/);
  });
});

test('runMarketplace: unknown subcommand → usage + exit 2', async () => {
  await withGlobalDir(async () => {
    const cap = captureStdio();
    let rc;
    try {
      rc = await runMarketplace(['nope']);
    } finally {
      cap.restore();
    }
    assert.equal(rc, 2);
    assert.match(cap.err.join(''), /unknown marketplace subcommand: nope/);
  });
});
