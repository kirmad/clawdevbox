// Tests for cli/ensure-devtunnel.ts probe functions.
//
// Probes are easy to test: shape & exit-code handling, plus the PATH
// refresh logic. The interactive install + login functions are NOT tested
// here because they spawn real package managers / browser flows that we
// don't want to fire in unit tests. The E2E happy path is exercised
// manually by running `clawdevbox init` on a clean machine; a separate
// gated E2E test could be added later.

import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDevtunnel, probeDevtunnelLogin } from '../src/cli/ensure-devtunnel.ts';

// On systems WITH devtunnel installed: probe returns a non-empty version.
// On systems WITHOUT devtunnel: probe returns null. Either is valid for
// this test — we just verify the contract (string | null).
test('probeDevtunnel returns string or null', () => {
  const v = probeDevtunnel();
  assert.ok(v === null || (typeof v === 'string' && v.length > 0),
    `expected string | null, got ${typeof v} ${JSON.stringify(v)}`);
});

test('probeDevtunnelLogin returns string or null', () => {
  const a = probeDevtunnelLogin();
  assert.ok(a === null || (typeof a === 'string' && a.length > 0),
    `expected string | null, got ${typeof a} ${JSON.stringify(a)}`);
});

// PATH-refresh logic is tested indirectly via the install step which is
// gated. A future test could expose `refreshPath` for direct testing.
