/**
 * llm-api.test.mjs — covers POST /api/llm/ask and GET /api/llm/providers.
 *
 * Uses a mock provider to avoid real LLM calls. Tests auth, validation,
 * provider routing, and error handling.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// We test the handler directly — no need for a full workspace.
import { handleLlmApi } from '../src/cli/llm-api.ts';

const TOKEN = 'llm-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function startServer(ctx) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const handled = await handleLlmApi(req, res, ctx);
      if (!handled) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('GET /api/llm/providers — requires auth', async () => {
  const { server, base } = await startServer({ expectedToken: TOKEN });
  try {
    const res = await fetch(`${base}/api/llm/providers`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /api/llm/providers — returns provider list', async () => {
  const { server, base } = await startServer({ expectedToken: TOKEN });
  try {
    const res = await fetch(`${base}/api/llm/providers`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.providers));
    assert.ok(body.providers.length > 0);
    assert.equal(body.providers[0].id, 'github-models');
  } finally {
    server.close();
  }
});

test('POST /api/llm/ask — requires auth', async () => {
  const { server, base } = await startServer({ expectedToken: TOKEN });
  try {
    const res = await fetch(`${base}/api/llm/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /api/llm/ask — rejects empty messages', async () => {
  const { server, base } = await startServer({ expectedToken: TOKEN });
  try {
    const res = await fetch(`${base}/api/llm/ask`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('messages'));
  } finally {
    server.close();
  }
});

test('POST /api/llm/ask — rejects invalid JSON', async () => {
  const { server, base } = await startServer({ expectedToken: TOKEN });
  try {
    const res = await fetch(`${base}/api/llm/ask`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not json{{{',
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /api/llm/ask — rejects unknown provider', async () => {
  const { server, base } = await startServer({ expectedToken: TOKEN });
  try {
    const res = await fetch(`${base}/api/llm/ask`, {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'nonexistent-provider',
      }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error.includes('unknown provider'));
  } finally {
    server.close();
  }
});

test('POST /api/llm/ask — no auth required when token is null', async () => {
  const { server, base } = await startServer({ expectedToken: null });
  try {
    // Should pass auth but fail on provider (no real token for github-models)
    const res = await fetch(`${base}/api/llm/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        provider: 'nonexistent-provider',
      }),
    });
    // Gets past auth → 502 from unknown provider
    assert.equal(res.status, 502);
  } finally {
    server.close();
  }
});

test('unmatched route returns false', async () => {
  const { server, base } = await startServer({ expectedToken: null });
  try {
    const res = await fetch(`${base}/api/llm/unknown`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
