/**
 * One-shot manual test of the @conductor/mcp-ado server.
 * - Sends initialize, notifications/initialized, tools/list
 * - Then calls ado.list_pr_comments against the test PR
 *
 * Run from this directory:
 *   ADO_ORG="..." ADO_BEARER_TOKEN="..." node manual-test.mjs
 *
 * Outputs the raw JSON-RPC exchange so it can be pasted into a report.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const entry = resolve(__dirname, 'src/index.ts');

const child = spawn('npx', ['tsx', entry], {
  cwd: __dirname,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

let stdoutBuf = '';
const responses = [];

child.stdout.on('data', (d) => {
  stdoutBuf += d.toString('utf8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      process.stderr.write(`[non-JSON stdout] ${line}\n`);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server-stderr] ${d}`));
child.on('error', (e) => { console.error('spawn error:', e); process.exit(1); });

function waitForResponse(id, timeoutMs = 30000) {
  return new Promise((resolveP, rejectP) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = responses.find((r) => r.id === id);
      if (found) return resolveP(found);
      if (Date.now() > deadline) return rejectP(new Error(`timeout waiting for id=${id}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function send(obj) {
  const line = JSON.stringify(obj) + '\n';
  process.stdout.write(`>>> ${line}`);
  child.stdin.write(line);
}

async function main() {
  await new Promise((r) => setTimeout(r, 1500));

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'manual-test', version: '0' },
  }});
  const init = await waitForResponse(1);
  process.stdout.write(`<<< initialize result:\n${JSON.stringify(init, null, 2)}\n\n`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await waitForResponse(2);
  process.stdout.write(`<<< tools/list result:\n${JSON.stringify(list, null, 2)}\n\n`);

  if (!process.env.ADO_BEARER_TOKEN && !process.env.ADO_PAT) {
    process.stdout.write('[skip ado.list_pr_comments — no ADO auth in env]\n');
  } else {
    send({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
        name: 'ado.list_pr_comments',
        arguments: {
          org: process.env.ADO_ORG,
          repo: 'SubstrateSearch',
          pr_id: 5180686,
        },
      },
    });
    const call = await waitForResponse(3, 30000);
    // Truncate big bodies for printing
    const printable = JSON.parse(JSON.stringify(call));
    if (printable.result?.structuredContent?.comments) {
      printable.result.structuredContent.comments =
        printable.result.structuredContent.comments.slice(0, 3);
    }
    process.stdout.write(`<<< ado.list_pr_comments result (first 3 comments):\n${JSON.stringify(printable, null, 2)}\n`);
  }

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL:', err);
  child.kill('SIGTERM');
  process.exit(1);
});
