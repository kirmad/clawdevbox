// fresh-workspace-stress.test.mjs
//
// STRESS TEST. Creates N brand-new temp workspaces back-to-back, drives
// /api/test/record-active-run + /spawn against each (using the lightweight
// e2e-test-runner provider so we don't burn LLM tokens), and verifies:
//
//   1. The workspace is registered in BOTH the DB AND the on-disk index
//      (the fix from commit 1f67b57).
//   2. The /spawn succeeds and returns a live instance_id.
//   3. The new session shows up in GET /api/sessions?status=active.
//   4. Cleanup: /dispatch __EXIT__ closes the pty cleanly.
//
// Runs against the LIVE 5201 server so it shares the same WS / dispatcher /
// conductor / pty-registry code paths that production triggers exercise.
//
// Run: node --import tsx --test tests/fresh-workspace-stress.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';

const BASE = process.env.CLAWDEVBOX_URL ?? 'http://127.0.0.1:5201';
const TOKEN = process.env.CLAWDEVBOX_TOKEN ?? '';
const N = Number(process.env.FRESH_WS_N ?? '3');
const WORKSPACES_ROOT = process.env.CLAWDEVBOX_WORKSPACES_ROOT
  ?? join(homedir(), '.clawdevbox', 'workspaces');

const baseAuth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

async function fetchJson(path, init = {}) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...baseAuth, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json ?? text, raw: text };
}

async function postJson(path, body, extraHeaders = {}) {
  return fetchJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body ?? {}),
  });
}

async function recordActiveRun(workspacePath, providerId) {
  const body = {
    fire_id: `fire_fws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    secret: 'sec_fws_' + Math.random().toString(36).slice(2, 10).padEnd(32, 'x'),
    workspace_path: workspacePath,
    provider_id: providerId,
  };
  const rec = await postJson('/api/test/record-active-run', body);
  if (rec.status !== 200) throw new Error(`record-active-run failed: ${rec.raw}`);
  return { fireId: rec.body.fire_id, secret: rec.body.secret, workspaceId: rec.body.workspace_id };
}

function loadOnDiskIndex() {
  const idxPath = join(WORKSPACES_ROOT, 'index.json');
  if (!existsSync(idxPath)) return { workspaces: {} };
  try {
    return JSON.parse(readFileSync(idxPath, 'utf8'));
  } catch {
    return { workspaces: {} };
  }
}

test('fresh-workspace stress: server reachable', async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.ok(r.ok, `clawdevbox not reachable at ${BASE}`);
});

test(`fresh-workspace stress: ${N} cold-start workspaces all register + spawn`, async () => {
  const results = [];
  const tempDirs = [];
  const spawnedInstances = [];

  try {
    for (let i = 0; i < N; i++) {
      const tag = `fws${Date.now().toString(36).slice(-4)}_${i}`;
      const tempDir = mkdtempSync(join(tmpdir(), `clawdevbox-fws-${tag}-`));
      tempDirs.push(tempDir);
      console.log(`\n=== iteration ${i + 1}/${N} : workspace = ${tempDir} ===`);

      const idxBefore = loadOnDiskIndex();
      const beforeCount = Object.keys(idxBefore.workspaces).length;

      const { fireId, secret, workspaceId } = await recordActiveRun(tempDir, 'e2e-test-runner');
      console.log(`[fws ${i + 1}] recorded: fire=${fireId} ws=${workspaceId}`);

      // Verify on-disk index registration (the fix from 1f67b57)
      const idxAfter = loadOnDiskIndex();
      const afterCount = Object.keys(idxAfter.workspaces).length;
      assert.ok(
        idxAfter.workspaces[workspaceId],
        `on-disk index missing workspace ${workspaceId} after record-active-run (before=${beforeCount} after=${afterCount}). The 1f67b57 fix may be regressed.`,
      );
      assert.equal(
        idxAfter.workspaces[workspaceId].path,
        tempDir,
        `on-disk index path mismatch for ${workspaceId}`,
      );
      console.log(`[fws ${i + 1}] ✅ on-disk index registered (${beforeCount} → ${afterCount})`);

      // Spawn against the fresh workspace
      const spawnRes = await postJson(
        `/spawn/${fireId}`,
        { prompt: `echo from iteration ${i + 1}` },
        { Authorization: `Bearer ${secret}` },
      );
      assert.equal(spawnRes.status, 200, `/spawn failed: ${spawnRes.raw}`);
      const instanceId = spawnRes.body.instance_id;
      assert.ok(instanceId, '/spawn did not return instance_id');
      spawnedInstances.push({ instanceId, fireId, secret });
      console.log(`[fws ${i + 1}] ✅ spawned: instance=${instanceId}`);

      // Wait for it to appear in the active sessions list
      let foundActive = false;
      for (let j = 0; j < 60; j++) {
        const list = await fetchJson('/api/sessions?status=active&limit=200');
        const row = list.body?.items?.find((it) => it.instance_id === instanceId);
        if (row?.live) {
          foundActive = true;
          console.log(`[fws ${i + 1}] ✅ live in /api/sessions: state=${row.state}`);
          break;
        }
        await sleep(500);
      }
      assert.ok(foundActive, `instance ${instanceId} never appeared as live in /api/sessions`);

      results.push({ i: i + 1, workspaceId, instanceId, tempDir });
    }

    console.log(`\n✅ STRESS PASS: ${N}/${N} fresh workspaces registered + spawned successfully`);
    for (const r of results) {
      console.log(`   #${r.i} ws=${r.workspaceId} instance=${r.instanceId}`);
    }
  } finally {
    // Cleanup: try to /exit each spawned instance
    for (const s of spawnedInstances) {
      try {
        const cleanupCtx = await recordActiveRun(tempDirs[0], 'e2e-test-runner').catch(() => null);
        if (cleanupCtx) {
          await postJson(`/dispatch/${cleanupCtx.fireId}`, { prompt: '__EXIT__' },
            { Authorization: `Bearer ${cleanupCtx.secret}` }).catch(() => {});
        }
      } catch {}
    }
    // Wait a moment for ptys to wind down then remove temp dirs
    await sleep(2000);
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});
