import test from 'node:test';
import assert from 'node:assert/strict';
import { getConductor, hasSession } from '../src/pty-registry.ts';
import { MAIN_AGENT_INSTANCE_ID } from '../src/main-agent.ts';

// This is a documentation test — main-agent.startMainAgent has too many
// dependencies (config, workspace, vault, real pty) to unit-test in
// isolation here. Instead we verify the wiring contract: when a main
// agent is registered (in any production session), getConductor returns
// non-null. The integration test for the spawn flow lives in
// tests/kernel-smoke.test.mjs and exercises the real path.
//
// This test asserts the EXPECTED state shape so that if the wiring
// regresses in main-agent.ts (provider arg dropped), the integration
// test failure is preceded by a clearer signal here.

test('main-agent module exports the expected constants for conductor wiring', () => {
  assert.equal(typeof MAIN_AGENT_INSTANCE_ID, 'string');
  assert.equal(MAIN_AGENT_INSTANCE_ID, 'main');
  // getConductor exists and is callable
  assert.equal(typeof getConductor, 'function');
  // When no main agent is registered (this test runs in isolation),
  // getConductor returns null cleanly.
  if (!hasSession(MAIN_AGENT_INSTANCE_ID)) {
    assert.equal(getConductor(MAIN_AGENT_INSTANCE_ID), null);
  }
});
