#!/usr/bin/env tsx
/**
 * memory-sync trigger — spawns an agent to sync memory vaults.
 *
 * The trigger script itself does NOT do git operations or auditing.
 * It POSTs to spawn_url with a detailed prompt telling the agent to:
 *   1. Check each vault for local uncommitted changes → commit with a
 *      meaningful message (the agent reviews the diff and writes it)
 *   2. Fetch from remote → review incoming diffs with LLM judgment
 *      (not regex) for safety → pull or block + notify via inbox
 *   3. Auto-resolve merge conflicts
 *   4. Push to remote
 *   5. Notify user via inbox with summary
 */

interface TriggerEnvelope {
  trigger_id: string;
  run_id: string;
  output_dir: string;
  spawn_url: string;
  dispatch_url?: string;
  callback_url?: string;
  fired_by?: 'cron' | 'manual' | 'external';
  state: Record<string, unknown>;
  payload: unknown;
}

interface SyncState {
  vault_scope?: string;
  auto_push?: boolean;
  provider?: string;
  lastFiredAt?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeStdout(r: { state: SyncState; systemMessage?: string }): void {
  process.stdout.write(JSON.stringify(r));
}

function blockingError(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const env = JSON.parse(await readStdin()) as TriggerEnvelope;
  const state: SyncState = (env.state ?? {}) as SyncState;
  const scope = state.vault_scope ?? 'all';
  const autoPush = state.auto_push !== false;

  const callbackUrl = env.callback_url ?? env.spawn_url;
  if (!callbackUrl) blockingError('env.callback_url / spawn_url missing');

  const today = new Date().toISOString().slice(0, 10);
  const sessionId = `memory-sync-${today}`;

  const vaultList: string[] = [];
  if (scope === 'all' || scope === 'personal') vaultList.push('personal');
  if (scope === 'all' || scope === 'team') vaultList.push('team');

  const prompt = `Memory vault sync triggered (${env.fired_by ?? 'cron'}, ${today}).

Read and execute the \`memory-vault-sync\` skill:
\`\`\`
skill.read({ id: "memory-vault-sync" })
\`\`\`

Scope: ${vaultList.join(', ')} vault(s). Auto-push: ${autoPush ? 'yes' : 'no'}.
Follow the skill procedure exactly — including the 3-subagent consensus audit for both commits and pulls.`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.CLAWDEVBOX_MCP_SECRET) {
    headers.Authorization = `Bearer ${process.env.CLAWDEVBOX_MCP_SECRET}`;
  }

  const body: Record<string, unknown> = {
    prompt,
    session_id: sessionId,
    context: {
      source: 'memory-sync',
      fired_by: env.fired_by ?? 'cron',
      date: today,
      vault_scope: scope,
    },
  };
  if (state.provider) body.provider = state.provider;

  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`spawn POST ${res.status}: ${text}`);
  }

  state.lastFiredAt = new Date().toISOString();
  writeStdout({
    state,
    systemMessage: `memory-sync agent spawned session=${sessionId} scope=${scope} fired_by=${env.fired_by ?? 'cron'}`,
  });
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.exit(1);
});
