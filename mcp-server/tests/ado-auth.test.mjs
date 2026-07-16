/**
 * ado-auth.test.mjs
 *
 * Unit tests for the ADO plugin's _auth.ts auth header + az-token cache.
 * Uses the injection seam (_setAzRunnerForTesting) to substitute a stub
 * for the real `az account get-access-token` shell-out — no Azure CLI
 * required.
 *
 * Covered:
 *   - az path wins over env tokens (precedence B)
 *   - env ADO_BEARER_TOKEN is used when az returns null
 *   - env ADO_PAT is used when az returns null and bearer is empty
 *   - missing all three throws AdoConfigError with helpful message
 *   - token cache reuses across calls
 *   - cache refreshes when within the 5-min expiry buffer
 *   - concurrent calls coalesce into a single az invocation
 *   - first az failure marks unavailable; subsequent calls skip the runner
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeader,
  AdoConfigError,
  _resetAzTokenCacheForTesting,
  _setAzRunnerForTesting,
} from '../../plugins/ado/tools/_auth.ts';

function makeCtx(env = {}) {
  return {
    env,
    fetch: globalThis.fetch,
    signal: undefined,
  };
}

test('authHeader: az token wins over env tokens', async () => {
  _resetAzTokenCacheForTesting();
  _setAzRunnerForTesting(async () => ({
    token: 'az-token-abc',
    expiresAtMs: Date.now() + 60 * 60 * 1000, // 60 min
  }));
  try {
    const h = await authHeader(makeCtx({
      ADO_BEARER_TOKEN: 'env-bearer-xyz',
      ADO_PAT: 'env-pat-456',
    }));
    assert.equal(h, 'Bearer az-token-abc', 'az token should win over env');
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: falls back to ADO_BEARER_TOKEN when az returns null', async () => {
  _resetAzTokenCacheForTesting();
  _setAzRunnerForTesting(async () => null);
  try {
    const h = await authHeader(makeCtx({
      ADO_BEARER_TOKEN: 'env-bearer-xyz',
      ADO_PAT: 'env-pat-456',
    }));
    assert.equal(h, 'Bearer env-bearer-xyz');
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: falls back to ADO_PAT when az and bearer are absent', async () => {
  _resetAzTokenCacheForTesting();
  _setAzRunnerForTesting(async () => null);
  try {
    const h = await authHeader(makeCtx({ ADO_PAT: 'env-pat-456' }));
    // Basic header is base64 of ':<pat>'
    const expected = `Basic ${Buffer.from(':env-pat-456').toString('base64')}`;
    assert.equal(h, expected);
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: throws AdoConfigError when all three sources are missing', async () => {
  _resetAzTokenCacheForTesting();
  _setAzRunnerForTesting(async () => null);
  try {
    await assert.rejects(
      () => authHeader(makeCtx({})),
      (err) => {
        assert.ok(err instanceof AdoConfigError);
        assert.match(err.message, /az login/);
        assert.match(err.message, /ADO_BEARER_TOKEN/);
        return true;
      },
    );
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: caches az token across calls (single runner invocation)', async () => {
  _resetAzTokenCacheForTesting();
  let calls = 0;
  _setAzRunnerForTesting(async () => {
    calls++;
    return { token: `az-token-${calls}`, expiresAtMs: Date.now() + 60 * 60 * 1000 };
  });
  try {
    const h1 = await authHeader(makeCtx({}));
    const h2 = await authHeader(makeCtx({}));
    const h3 = await authHeader(makeCtx({}));
    assert.equal(calls, 1, 'runner should be called only once');
    assert.equal(h1, 'Bearer az-token-1');
    assert.equal(h2, 'Bearer az-token-1');
    assert.equal(h3, 'Bearer az-token-1');
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: refreshes cache when within the 5-min expiry buffer', async () => {
  _resetAzTokenCacheForTesting();
  let calls = 0;
  const runner = async () => {
    calls++;
    // Hand out a token that expires in 2 minutes — well inside the 5-min buffer
    return { token: `az-token-${calls}`, expiresAtMs: Date.now() + 2 * 60 * 1000 };
  };
  _setAzRunnerForTesting(runner);
  try {
    const h1 = await authHeader(makeCtx({}));
    const h2 = await authHeader(makeCtx({}));
    assert.equal(calls, 2, 'runner should be re-invoked because cached token is in the buffer window');
    assert.equal(h1, 'Bearer az-token-1');
    assert.equal(h2, 'Bearer az-token-2');
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: concurrent calls coalesce into a single az invocation', async () => {
  _resetAzTokenCacheForTesting();
  let calls = 0;
  _setAzRunnerForTesting(async () => {
    calls++;
    // Simulate some work
    await new Promise((r) => setTimeout(r, 25));
    return { token: 'az-coalesced', expiresAtMs: Date.now() + 60 * 60 * 1000 };
  });
  try {
    const [h1, h2, h3, h4, h5] = await Promise.all([
      authHeader(makeCtx({})),
      authHeader(makeCtx({})),
      authHeader(makeCtx({})),
      authHeader(makeCtx({})),
      authHeader(makeCtx({})),
    ]);
    assert.equal(calls, 1, 'all 5 concurrent calls should share a single runner invocation');
    for (const h of [h1, h2, h3, h4, h5]) {
      assert.equal(h, 'Bearer az-coalesced');
    }
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});

test('authHeader: az failure marks unavailable; subsequent calls skip the runner', async () => {
  _resetAzTokenCacheForTesting();
  let calls = 0;
  _setAzRunnerForTesting(async () => {
    calls++;
    return null; // simulate az login failure
  });
  try {
    // First call: az tried, failed, falls back to env
    await assert.rejects(() => authHeader(makeCtx({})), AdoConfigError);
    assert.equal(calls, 1);

    // Second call: az should NOT be re-tried (marked unavailable)
    const h = await authHeader(makeCtx({ ADO_BEARER_TOKEN: 'env-fallback' }));
    assert.equal(calls, 1, 'az should not be re-tried after first failure');
    assert.equal(h, 'Bearer env-fallback');
  } finally {
    _setAzRunnerForTesting(null);
    _resetAzTokenCacheForTesting();
  }
});
