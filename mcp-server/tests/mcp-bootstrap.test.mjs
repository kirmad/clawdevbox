/**
 * mcp-bootstrap.test.mjs — covers Phase 8 bootstrap helpers.
 *
 * - `listenOrConfirmExisting` (Task 8.3): when the target port is bound by
 *   our own service (probe response matches our schema) -> 'already-running'.
 *   When bound by something else -> 'conflict'. When free -> 'listening'.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { listenOrConfirmExisting } from '../src/cli/start.ts';

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

test('listenOrConfirmExisting — port free returns listening', async () => {
  const port = await freePort();
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'token');
    assert.equal(result, 'listening');
    assert.equal(server.address().port, port);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('listenOrConfirmExisting — port held by our schema returns already-running', async () => {
  const port = await freePort();
  const probeServer = createServer((req, res) => {
    if (req.url === '/api/cron/status' && req.headers.authorization === 'Bearer my-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        service: { pid: 1, port, started_at: 0, version: '0' },
        scheduler: { next_wake_at: null, last_wake_at: null, total_wakes: 0 },
        dispatcher: { in_flight: 0, max_concurrent: 4, queued_count: 0, retrying_count: 0, dead_count: 0 },
        db: { path: ':memory:', schema_version: 1 },
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => probeServer.listen(port, '127.0.0.1', r));
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'my-token');
    assert.equal(result, 'already-running');
  } finally {
    await new Promise((r) => probeServer.close(r));
    if (server.listening) await new Promise((r) => server.close(r));
  }
});

test('listenOrConfirmExisting — port held by something else returns conflict', async () => {
  const port = await freePort();
  // Foreign server returns 200 OK but a totally different shape.
  const foreign = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service_name: 'something-else', version: '1.0' }));
  });
  await new Promise((r) => foreign.listen(port, '127.0.0.1', r));
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'token');
    assert.equal(result, 'conflict');
  } finally {
    await new Promise((r) => foreign.close(r));
    if (server.listening) await new Promise((r) => server.close(r));
  }
});

test('listenOrConfirmExisting — port held but wrong bearer returns conflict', async () => {
  const port = await freePort();
  const probeServer = createServer((req, res) => {
    // Only respond 200 to right bearer.
    if (req.headers.authorization === 'Bearer right-token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        service: {}, scheduler: {}, dispatcher: {}, db: {},
      }));
      return;
    }
    res.writeHead(401); res.end();
  });
  await new Promise((r) => probeServer.listen(port, '127.0.0.1', r));
  const server = createServer();
  try {
    const result = await listenOrConfirmExisting(server, '127.0.0.1', port, 'wrong-token');
    assert.equal(result, 'conflict');
  } finally {
    await new Promise((r) => probeServer.close(r));
    if (server.listening) await new Promise((r) => server.close(r));
  }
});
