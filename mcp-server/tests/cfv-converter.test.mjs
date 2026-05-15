/**
 * cfv-converter.test.mjs
 *
 * Unit-tests the CFV split + TOON converter that was ported back from
 * taskdock. Uses a small synthetic fixture (no network) and asserts:
 *
 *   1. convertCallFlow writes callflow/index.csv + per-message TOON
 *      files + README.txt and returns the message count.
 *   2. convertCallDetails writes the six diagnostic TOON files and
 *      returns 6.
 *   3. writeMetadata writes metadata.toon listing every artifact.
 *   4. Each TOON file is non-empty and human-readable (encode is wired).
 *
 * Requires the clawdevbox-plugins/cfv plugin to be available at the
 * standard sibling-folder location — skipped otherwise.
 *
 *   node --test tests/cfv-converter.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');
const cfvPluginDir = resolve(
  process.env.CLAWDEVBOX_PLUGINS_SRC ?? resolve(projectRoot, '..', '..', 'clawdevbox-plugins'),
  'cfv',
);
const converterPath = join(cfvPluginDir, 'tools', '_converter.ts');
const converterUrl = pathToFileURL(converterPath).href;

// The plugin tool imports `@toon-format/toon`, which Node resolves by
// walking up from the tool's own directory looking for `node_modules`.
// Junction the clawdevbox server's `node_modules` into the plugins repo
// root so the resolution succeeds without polluting the plugin tree.
// Skips silently if the junction is already in place or the host OS
// can't create it (Windows EPERM without admin / developer mode).
if (existsSync(cfvPluginDir)) {
  const pluginsRepoRoot = resolve(cfvPluginDir, '..');
  const link = join(pluginsRepoRoot, 'node_modules');
  if (!existsSync(link)) {
    const linkType = platform() === 'win32' ? 'junction' : 'dir';
    try {
      symlinkSync(resolve(projectRoot, 'node_modules'), link, linkType);
    } catch {
      /* surfaces as ERR_MODULE_NOT_FOUND below if it matters */
    }
  }
}

const FLOW_FIXTURE = {
  callId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  callInfo: { deployments: { cc: { ownerTenant: 'tenant-A' }, conv: { ownerTenant: 'tenant-B' } } },
  nrtStreamingIndexAugmentedCall: {
    fullCallFlow: {
      messages: [
        {
          index: 0,
          messageId: 'm0',
          reqTime: '2024-01-01T00:00:00.123Z',
          respTime: '2024-01-01T00:00:00.234Z',
          time: 0,
          from: 'client',
          to: 'gateway',
          protocol: 'HTTPS',
          reqTitle: 'POST /api/x',
          label: 'invite user',
          req: 'POST /api/x HTTP/1.1\r\nHost: gw\r\n\r\n',
          resp: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok',
          latency: '111ms',
          isFailure: false,
          hasError: false,
          error: '',
          callId: 'c0',
          ltid: 'lt0',
          randId: 1234,
          kind: 1,
        },
        {
          index: 1,
          messageId: 'm1',
          reqTime: '2024-01-01T00:00:01.000Z',
          from: 'gateway',
          to: 'backend',
          reqTitle: 'GET /api/y',
          label: 'lookup, with, commas',
          req: 'GET /api/y HTTP/1.1\r\n',
          resp: 'HTTP/1.1 500 Internal\r\n',
          latency: '999ms',
          isFailure: true,
          hasError: true,
          error: 'boom',
        },
      ],
    },
  },
};

const DETAILS_FIXTURE = {
  finished: true,
  failed: false,
  error: '',
  callDetails: {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    isNgInvolved: true,
    isNgMultiparty: false,
    legs: [
      {
        legId: 'leg-1',
        legType: 'caller',
        userType: 'EnterpriseUser',
        role: 'Originator',
        isNGInvolved: true,
        failedStep: null,
        backendParticipant: {
          participantId: 'p1',
          role: 'Caller',
          userType: 'EnterpriseUser',
          resultCode: 'Success',
          resultSubCode: '',
          resultDetail: 'Done',
          resultDetailString: '',
          callEndMessage: 'normal',
          didAccept: true,
          didInitiateCallEnd: false,
          timestamps: ['2024-01-01T00:00:00Z'],
        },
        uiVersion: { major: 1 },
      },
    ],
    qoe: [
      {
        mediaLine_OutboundStream_Network_Delay_RoundTrip: 50,
        mediaLine_OutboundStream_Network_PacketLoss_LossRate: 0.001,
        endpoint_v2_OS: 'Windows 11',
        ignored_field: 'should be skipped',
      },
    ],
    mdiag: [
      {
        connectivity_AllocationTimeInMs: 12,
        media_NetworkErr: 0,
        reason: 'ok',
        unrelated: 'skip',
      },
    ],
    csamod: [
      {
        result_code: 0,
        result_detail: 'success',
        call_duration: 12345,
        call_setup_duration: 250,
        is_multiparty: false,
        eventTimestampBag: JSON.stringify({
          eventStart: '2024-01-01T00:00:00Z',
          events: [{ name: 'callStart' }, { name: 'callEnd' }],
        }),
      },
    ],
    modelCall: {
      clientEndpoints: [
        {
          nodeId: '0123456789abcdefABCDEF0123456789',
          uiVersion: { major: 1 },
          diagnostics: [
            { problemOccured: true, code: 'X' },
            { problemOccured: false, code: 'Y' },
          ],
          callSessions: [
            { resultCode: 'OK', resultDetail: 'done', timestamps: ['t0'] },
          ],
        },
      ],
    },
  },
};

test('cfv converter', { skip: !existsSync(converterPath) && `cfv plugin missing at ${cfvPluginDir}` }, async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'cfv-converter-'));
  t.after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const mod = await import(converterUrl);

  await t.test('convertCallFlow writes per-message TOON + CSV index + README', async () => {
    const count = await mod.convertCallFlow(FLOW_FIXTURE, tmpRoot);
    assert.equal(count, 2);
    assert.ok(existsSync(join(tmpRoot, 'callflow', 'index.csv')));
    assert.ok(existsSync(join(tmpRoot, 'callflow', 'README.txt')));
    assert.ok(existsSync(join(tmpRoot, 'callflow', 'messages', '0000.toon')));
    assert.ok(existsSync(join(tmpRoot, 'callflow', 'messages', '0001.toon')));

    const csv = readFileSync(join(tmpRoot, 'callflow', 'index.csv'), 'utf8');
    const lines = csv.split('\n');
    assert.equal(lines[0], 'seq,timestamp,from,to,status,latency,fail,label');
    // Row 0 — should have HTTP 200 extracted from resp
    assert.ok(lines[1].startsWith('0,2024-01-01T00:00:00,client,gateway,200,'));
    // Row 1 — failure row, commas in label must be replaced with semicolons
    assert.ok(lines[2].includes('500'), `row1 expected 500 status: ${lines[2]}`);
    assert.ok(lines[2].includes('"lookup; with; commas"'), `commas should be replaced: ${lines[2]}`);

    const msg0 = readFileSync(join(tmpRoot, 'callflow', 'messages', '0000.toon'), 'utf8');
    assert.ok(msg0.length > 0, 'message TOON should be non-empty');
    // TOON encodes scalar strings without surrounding quotes, but it must
    // at least include the fields the converter emits.
    assert.ok(msg0.includes('messageId'), `expected messageId field in toon: ${msg0.slice(0, 200)}`);
    assert.ok(msg0.includes('client'), `expected 'client' (from field) in toon: ${msg0.slice(0, 200)}`);

    const readme = readFileSync(join(tmpRoot, 'callflow', 'README.txt'), 'utf8');
    assert.ok(readme.includes('Call ID: aaaaaaaa'));
    assert.ok(readme.includes('Total Messages: 2'));
    assert.ok(readme.includes('CC: tenant-A'));
  });

  await t.test('convertCallDetails writes six diagnostic TOON files', async () => {
    const count = await mod.convertCallDetails(DETAILS_FIXTURE, tmpRoot);
    assert.equal(count, 6);
    const expected = ['summary.toon', 'legs.toon', 'qoe.toon', 'network.toon', 'timeline.toon', 'participants.toon'];
    for (const name of expected) {
      const p = join(tmpRoot, 'diagnostics', name);
      assert.ok(existsSync(p), `${p} missing`);
      const body = readFileSync(p, 'utf8');
      assert.ok(body.length > 0, `${name} is empty`);
    }
    const summary = readFileSync(join(tmpRoot, 'diagnostics', 'summary.toon'), 'utf8');
    assert.ok(summary.includes('callId'));
    assert.ok(summary.includes('aaaaaaaa'));
    const participants = readFileSync(join(tmpRoot, 'diagnostics', 'participants.toon'), 'utf8');
    // 32-char nodeId should be truncated to 20 chars + ellipsis.
    assert.ok(participants.includes('0123456789abcdefABCD'), `expected truncated nodeId in participants: ${participants}`);
    assert.ok(participants.includes('...'));
  });

  await t.test('convertCallDetails returns 0 when callDetails is empty', async () => {
    const inner = join(tmpRoot, 'empty-call');
    const count = await mod.convertCallDetails({ finished: true }, inner);
    assert.equal(count, 0);
  });

  await t.test('writeMetadata writes metadata.toon manifest', async () => {
    await mod.writeMetadata(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ['raw/callSummary.json', 'raw/callFlow.json'],
      { callflowMessages: 2, diagnosticFiles: 6 },
      tmpRoot,
    );
    const p = join(tmpRoot, 'metadata.toon');
    assert.ok(existsSync(p));
    const body = readFileSync(p, 'utf8');
    assert.ok(body.includes('call_id'));
    assert.ok(body.includes('callflow/index.csv'));
    assert.ok(body.includes('diagnostics/summary.toon'));
  });
});
