/**
 * service.test.mjs
 *
 * Unit + smoke tests for the new global config + service lifecycle:
 *
 *   - resolveConfig merges global + project config layers correctly
 *   - service.ts state-file helpers round-trip
 *   - spawnDetached + readServiceState + stopService work end-to-end
 *     against a trivial detached child (a `node -e 'setInterval...'`
 *     blocker we can kill cleanly)
 *
 * OS auto-start (schtasks / launchctl / systemctl) is NOT exercised —
 * those paths are platform-dependent and require root or per-user system
 * services that we don't want to mutate in a unit test. The structure of
 * those helpers is verified by typecheck + manual smoke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

const configModUrl = pathToFileURL(resolve(projectRoot, 'src/config.ts')).href;
const serviceModUrl = pathToFileURL(resolve(projectRoot, 'src/service.ts')).href;

function makeProject() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'clawdevbox-service-test-'));
  return {
    tmpRoot,
    cleanup() {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

// ----------------------------------------------------------------------------
// config.ts — global + project merge
// ----------------------------------------------------------------------------

test('resolveConfig — defaults only', async () => {
  const cfg = await import(configModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const resolved = cfg.resolveConfig({
      projectDir: tmpRoot,
      globalDir: join(tmpRoot, '.global'),
      env: {},
    });
    assert.equal(resolved.http.port, cfg.DEFAULT_HTTP_PORT);
    assert.equal(resolved.http.host, cfg.DEFAULT_HTTP_HOST);
    assert.equal(resolved.http.token, null);
    assert.equal(resolved.tunnel.kind, 'none');
    assert.equal(resolved.notifications.enabled, false);
    assert.equal(resolved.configPath, null);
  } finally {
    cleanup();
  }
});

test('resolveConfig — global config only', async () => {
  const cfg = await import(configModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    cfg.writeGlobalConfig(globalDir, {
      version: cfg.CONFIG_VERSION,
      global_dir: globalDir,
      http: { port: 6500, host: '0.0.0.0', token: 'global-token' },
      tunnel: { kind: 'devtunnel', name: 'myname', allow_anonymous: true, auto_start: true },
    });
    const resolved = cfg.resolveConfig({
      projectDir: tmpRoot,
      globalDir,
      env: {},
    });
    assert.equal(resolved.http.port, 6500);
    assert.equal(resolved.http.host, '0.0.0.0');
    assert.equal(resolved.http.token, 'global-token');
    assert.equal(resolved.tunnel.kind, 'devtunnel');
    assert.equal(resolved.tunnel.name, 'myname');
    assert.equal(resolved.tunnel.allow_anonymous, true);
    assert.equal(resolved.configPath, cfg.globalConfigPath(globalDir));
  } finally {
    cleanup();
  }
});

test('resolveConfig — project config overrides global', async () => {
  const cfg = await import(configModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    cfg.writeGlobalConfig(globalDir, {
      version: cfg.CONFIG_VERSION,
      global_dir: globalDir,
      http: { port: 6500, token: 'global-token' },
      tunnel: { kind: 'none' },
    });
    // Project layer overrides port + token; tunnel falls through from global.
    cfg.writeConfig(tmpRoot, {
      version: cfg.CONFIG_VERSION,
      project_dir: tmpRoot,
      global_dir: globalDir,
      http: { port: 7777, token: 'project-token' },
    });
    const resolved = cfg.resolveConfig({
      projectDir: tmpRoot,
      globalDir,
      env: {},
    });
    assert.equal(resolved.http.port, 7777, 'project port should win');
    assert.equal(resolved.http.token, 'project-token', 'project token should win');
    assert.equal(resolved.tunnel.kind, 'none', 'tunnel falls through from global');
    // configPath surfaces the project layer when both exist.
    assert.equal(resolved.configPath, cfg.configPath(tmpRoot));
  } finally {
    cleanup();
  }
});

test('resolveConfig — env vars override file layers', async () => {
  const cfg = await import(configModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    cfg.writeGlobalConfig(globalDir, {
      version: cfg.CONFIG_VERSION,
      http: { port: 6500, token: 'global-token' },
    });
    const resolved = cfg.resolveConfig({
      projectDir: tmpRoot,
      globalDir,
      env: {
        CLAWDEVBOX_PORT: '9999',
        CLAWDEVBOX_TOKEN: 'env-token',
      },
    });
    assert.equal(resolved.http.port, 9999);
    assert.equal(resolved.http.token, 'env-token');
  } finally {
    cleanup();
  }
});

test('global config — project_dir is optional and round-trips when omitted', async () => {
  const cfg = await import(configModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    // Write a global config WITHOUT project_dir.
    cfg.writeGlobalConfig(globalDir, {
      version: cfg.CONFIG_VERSION,
      global_dir: globalDir,
      http: { port: 5500, token: 'tok' },
    });
    const round = cfg.readGlobalConfig(globalDir);
    assert.ok(round, 'global config should be readable');
    assert.equal(round.project_dir, undefined, 'project_dir must remain undefined');
    assert.equal(round.http?.port, 5500);
  } finally {
    cleanup();
  }
});

// ----------------------------------------------------------------------------
// service.ts — state file round-trip + spawn/stop
// ----------------------------------------------------------------------------

test('service state file — write/read/clear round-trip', async () => {
  const svc = await import(serviceModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    const state = {
      pid: 99999,
      port: 5201,
      started_at: Date.now(),
      version: '0.0.0-test',
      exec_path: '/usr/bin/node',
      exec_args: ['cli.js', 'start'],
    };
    svc.writeServiceState(globalDir, state);
    assert.ok(existsSync(svc.serviceStatePath(globalDir)));
    const r = svc.readServiceState(globalDir);
    assert.deepEqual(r, state);
    svc.clearServiceState(globalDir);
    assert.equal(svc.readServiceState(globalDir), null);
  } finally {
    cleanup();
  }
});

test('isProcessAlive — returns false for impossible pid, true for current pid', async () => {
  const svc = await import(serviceModUrl);
  assert.equal(svc.isProcessAlive(0), false);
  assert.equal(svc.isProcessAlive(-1), false);
  assert.equal(svc.isProcessAlive(2147483647), false);
  assert.equal(svc.isProcessAlive(process.pid), true);
});

test('spawnDetached + stopService round-trip against a long-lived child', async () => {
  const svc = await import(serviceModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    // Spawn a Node process that idles forever — same shape the real service
    // takes (a node binary + a script). The child exits cleanly on SIGTERM
    // (POSIX) or taskkill (Windows).
    const { pid } = svc.spawnDetached(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000);',
    ]);
    assert.ok(pid > 0, 'spawnDetached must return a positive pid');
    svc.writeServiceState(globalDir, {
      pid,
      port: 12345,
      started_at: Date.now(),
      version: '0.0.0-test',
      exec_path: process.execPath,
      exec_args: ['-e', 'setInterval(() => {}, 1000);'],
    });
    // Give the OS a beat to actually start the child.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(svc.isProcessAlive(pid), true, 'child should be alive after spawn');

    const result = svc.stopService(globalDir);
    assert.equal(result.stopped, true, `stop should succeed: ${result.reason ?? ''}`);
    assert.equal(result.pid, pid);

    // Give the OS up to a second to actually reap.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise((r) => setTimeout(r, 50));
      alive = svc.isProcessAlive(pid);
    }
    assert.equal(alive, false, 'child should be reaped after stopService');

    // State file is cleared.
    assert.equal(svc.readServiceState(globalDir), null);
  } finally {
    cleanup();
  }
});

test('stopService — no-op when no state file exists', async () => {
  const svc = await import(serviceModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    const r = svc.stopService(globalDir);
    assert.equal(r.stopped, false);
    assert.equal(r.pid, null);
    assert.match(r.reason ?? '', /no service\.json/);
  } finally {
    cleanup();
  }
});

test('stopService — clears state file when recorded pid is dead', async () => {
  const svc = await import(serviceModUrl);
  const { tmpRoot, cleanup } = makeProject();
  try {
    const globalDir = join(tmpRoot, '.global');
    mkdirSync(globalDir, { recursive: true });
    svc.writeServiceState(globalDir, {
      pid: 2147483647, // guaranteed not to exist
      port: 12345,
      started_at: Date.now(),
      version: '0.0.0-test',
      exec_path: '/bin/true',
      exec_args: [],
    });
    const r = svc.stopService(globalDir);
    assert.equal(r.stopped, false);
    assert.equal(r.pid, 2147483647);
    assert.equal(svc.readServiceState(globalDir), null, 'stale state should be cleared');
  } finally {
    cleanup();
  }
});

// ----------------------------------------------------------------------------
// probeHealth — verifies the post-spawn /healthz check
// ----------------------------------------------------------------------------

test('probeHealth — returns ok when a server replies `ok` on /healthz', async () => {
  const svc = await import(serviceModUrl);
  const http = await import('node:http');
  // Find an open port by binding to 0 first.
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await svc.probeHealth({ host: '127.0.0.1', port, timeoutMs: 2000 });
    assert.equal(r.ok, true);
  } finally {
    server.close();
  }
});

test('probeHealth — fails fast with reason when nothing is listening', async () => {
  const svc = await import(serviceModUrl);
  // Port 1 is guaranteed not to be listening for our process.
  const r = await svc.probeHealth({
    host: '127.0.0.1',
    port: 1,
    timeoutMs: 600,
    intervalMs: 100,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout/);
});

test('probeHealth — rejects when /healthz returns a non-ok body', async () => {
  const svc = await import(serviceModUrl);
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('whoops');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await svc.probeHealth({
      host: '127.0.0.1',
      port,
      timeoutMs: 500,
      intervalMs: 100,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /unexpected/);
  } finally {
    server.close();
  }
});

// ----------------------------------------------------------------------------
// fetchTunnelStatus — used by `init` + `status` to surface the tunnel URL.
// ----------------------------------------------------------------------------

test('fetchTunnelStatus — returns the running url when present', async () => {
  const svc = await import(serviceModUrl);
  const http = await import('node:http');
  const fakeUrl = 'https://example-1234.usw2.devtunnels.ms';
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tunnel/status') {
      const auth = req.headers.authorization;
      if (auth !== 'Bearer right-token') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          kind: 'devtunnel',
          name: 'example',
          port: 5201,
          running: true,
          url: fakeUrl,
          inspect_url: 'https://example-1234-inspect.usw2.devtunnels.ms',
          error: null,
          pid: 99,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await svc.fetchTunnelStatus({
      host: '127.0.0.1',
      port,
      token: 'right-token',
      timeoutMs: 2000,
      waitForUrl: true,
    });
    assert.ok(r, 'expected a non-null status');
    assert.equal(r.url, fakeUrl);
    assert.equal(r.kind, 'devtunnel');
  } finally {
    server.close();
  }
});

test('fetchTunnelStatus — returns null on 401', async () => {
  const svc = await import(serviceModUrl);
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await svc.fetchTunnelStatus({
      host: '127.0.0.1',
      port,
      token: 'wrong-token',
      timeoutMs: 500,
      intervalMs: 100,
    });
    assert.equal(r, null, 'unauthorized response should produce null');
  } finally {
    server.close();
  }
});

test('fetchTunnelStatus — returns null if server never responds', async () => {
  const svc = await import(serviceModUrl);
  const r = await svc.fetchTunnelStatus({
    host: '127.0.0.1',
    port: 1, // not listening
    token: 'whatever',
    timeoutMs: 500,
    intervalMs: 100,
  });
  assert.equal(r, null);
});
