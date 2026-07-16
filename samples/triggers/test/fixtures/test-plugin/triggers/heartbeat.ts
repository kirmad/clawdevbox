#!/usr/bin/env tsx
/**
 * heartbeat.ts — synthetic test-plugin trigger.
 *
 * Reads the standard TriggerEnvelope from stdin (the mock-clawdevbox builds
 * it the same way real Clawdevbox does), POSTs ONE Mode B callback with the
 * literal prompt "plugin heartbeat tick", and exits 0 with a `{ state,
 * systemMessage }` envelope on stdout.
 *
 * Why Mode B for a heartbeat?
 *   Mode A would also work for a single deterministic callback, but using
 *   Mode B exercises the same auth + POST path the real ADO comment-watcher
 *   uses, which is exactly the contract we want plugin discovery to be
 *   compatible with. The scenario asserts on both the captured callback AND
 *   the trigger's scope label — neither depends on the mode.
 *
 * Zero dependencies beyond Node 20+ built-in fetch (matches the constraint
 * the rest of the test harness operates under).
 */

interface TriggerEnvelope {
  trigger_event_name: 'TriggerFired';
  trigger_id: string;
  run_id: string;
  callback_url: string;
  state: HeartbeatState;
  payload: unknown;
}

interface HeartbeatState {
  /** Monotonic counter — proves state round-trips through the harness. */
  tickCount?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    process.stdout.write(JSON.stringify({ systemMessage: 'no envelope' }));
    return;
  }

  let env: TriggerEnvelope;
  try {
    env = JSON.parse(stdin);
  } catch (err) {
    process.stderr.write(`invalid JSON on stdin: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (!env.callback_url) {
    process.stderr.write('env.callback_url missing\n');
    process.exit(2);
  }

  const secret = process.env.CLAWDEVBOX_MCP_SECRET;
  if (!secret) {
    process.stderr.write('CLAWDEVBOX_MCP_SECRET env var required for Mode B callback POSTs\n');
    process.exit(2);
  }

  const tick = (env.state.tickCount ?? 0) + 1;

  const body = {
    prompt: 'plugin heartbeat tick',
    context: {
      source: 'test-plugin',
      kind: 'heartbeat',
      tick,
      trigger_id: env.trigger_id,
      run_id: env.run_id,
    },
  };

  const res = await fetch(env.callback_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    process.stderr.write(`callback POST ${res.status}: ${text}\n`);
    process.exit(1);
  }

  process.stdout.write(
    JSON.stringify({
      state: { tickCount: tick },
      systemMessage: `Heartbeat tick #${tick} emitted by plugin trigger.`,
    }),
  );
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.stderr.write('\n');
  process.exit(1);
});
