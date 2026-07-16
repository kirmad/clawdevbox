/**
 * tests/live/local-triggers-live.test.mjs
 *
 * TDD-style node:test wrapper over the non-mocked live probes in ./probes.mjs.
 * These run the REAL local trigger scripts against the REAL MCP server, live
 * DB, and memory vault chain — so they are OPT-IN and skip entirely unless
 * CDB_LIVE_PROBE=1.
 *
 * Each probe is executed once (shared across its assertions) and every
 * individual check becomes an assertion, so a regression in any one live
 * invariant fails a named test. The runner scripts/live-local-probe.mjs uses
 * the same probes for a report-producing CI/manual entry point.
 *
 * SAFETY: recipe-cron dry-run (empty spawn_url) → no spawn/network;
 * vault-test only echoes stdin; memory-sync uses a loopback recorder and the
 * probe asserts NO git ref moved on any real vault. Nothing here mutates the
 * repo, the DB, or any vault.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  LiveMcpClient,
  probeRecipeCron,
  probeVaultTest,
  probeMemorySync,
} from './probes.mjs';

const LIVE = process.env.CDB_LIVE_PROBE === '1';
const skip = LIVE ? false : 'live probes are opt-in — set CDB_LIVE_PROBE=1';

/** Run one probe, then assert each of its checks as its own assertion. */
function assertProbe(getResult) {
  const result = getResult();
  assert.ok(result.checks.length > 0, `${result.name}: probe produced no checks`);
  for (const c of result.checks) {
    assert.ok(c.ok, `${result.name}: ${c.label}${c.ok ? '' : ` — ${c.detail ?? ''}`}`);
  }
}

describe('live local triggers (CDB_LIVE_PROBE=1)', { skip }, () => {
  let cfg;
  let mcp;
  const done = {};

  before(async () => {
    cfg = loadConfig();
    mcp = new LiveMcpClient(cfg);
    await mcp.init(); // proves the live MCP server is reachable
    done.recipeCron = await probeRecipeCron(cfg, mcp);
    done.vaultTest = await probeVaultTest(cfg, mcp);
    done.memorySync = await probeMemorySync(cfg, mcp);
    await mcp.close();
  });

  test('local.recipe-cron: resolves a real recipe via live MCP and dry-runs cleanly', () => {
    assertProbe(() => done.recipeCron);
  });

  test('local.vault-test: discovered via live MCP and echoes Unicode state', () => {
    assertProbe(() => done.vaultTest);
  });

  test('memory-sync: real vault chain, auto_push=false, no git ref moved', () => {
    assertProbe(() => done.memorySync);
  });
});
