#!/usr/bin/env tsx
// local.recipe-cron — fires a recipe on a cron tick.
// Reusable: register one instance per cadence with (recipe_id, recipe_inputs, cron).

interface CronState {
  recipe_id: string;
  recipe_inputs?: Record<string, unknown>;
  session_id_prefix?: string;
  workspace_path?: string;
  provider?: string;
  prompt_addendum?: string;
  bootstrapped?: boolean;
  lastFiredAt?: string;
}

interface TriggerEnvelope {
  trigger_id: string;
  run_id: string;
  output_dir: string;
  spawn_url: string;
  dispatch_url?: string;
  callback_url?: string;
  fired_by?: 'cron' | 'manual' | 'external';
  trigger_data_dir?: string;
  state: Record<string, unknown>;
  payload: unknown;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function writeStdout(r: { state: CronState; systemMessage?: string }): void {
  process.stdout.write(JSON.stringify(r));
}
function blockingError(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const env = JSON.parse(await readStdin()) as TriggerEnvelope;
  const raw = (env.state ?? {}) as Record<string, unknown>;

  // Normalize snake_case + camelCase — register-time params land in snake_case;
  // script writes back camelCase too so subsequent ticks see both forms.
  const state: CronState = {
    recipe_id: (raw.recipe_id ?? (raw as Record<string, unknown>).recipeId) as string,
    recipe_inputs: (raw.recipe_inputs ?? (raw as Record<string, unknown>).recipeInputs ?? {}) as Record<string, unknown>,
    session_id_prefix: (raw.session_id_prefix ?? (raw as Record<string, unknown>).sessionIdPrefix) as string | undefined,
    workspace_path: (raw.workspace_path ?? (raw as Record<string, unknown>).workspacePath) as string | undefined,
    provider: raw.provider as string | undefined,
    prompt_addendum: (raw.prompt_addendum ?? (raw as Record<string, unknown>).promptAddendum) as string | undefined,
    bootstrapped: raw.bootstrapped as boolean | undefined,
    lastFiredAt: raw.lastFiredAt as string | undefined,
  };

  if (!state.recipe_id) blockingError('state.recipe_id required (pass as register-time param)');
  const callbackUrl = env.callback_url ?? env.spawn_url;
  if (!callbackUrl) blockingError('env.callback_url / spawn_url missing');

  // Per-day session so each cadence lands in a fresh console daily.
  const today = new Date().toISOString().slice(0, 10);
  const prefix = state.session_id_prefix ?? state.recipe_id;
  const sessionId = `${prefix}-${today}`;

  const inputsJson = JSON.stringify(state.recipe_inputs ?? {}, null, 2);
  const prompt = [
    `Cron tick (${env.fired_by ?? 'cron'}): run recipe \`${state.recipe_id}\` for ${today}.`,
    '',
    'Steps:',
    `1. Call \`recipe.instance.begin({ template_id: "${state.recipe_id}", inputs: <inputs below> })\`.`,
    '2. Iterate the steps yourself with `recipe.steps.update_status`.',
    '3. Honor every gate via `inbox.upsert` (batched questions where possible). Never use `ask_user` or `approval.request`.',
    '4. On any genuine doubt, escalate via inbox card with batched `questions:` array — do not guess.',
    '',
    'Inputs:',
    inputsJson,
    state.prompt_addendum ? '' : '',
    state.prompt_addendum ?? '',
  ].filter(s => s !== undefined && s !== null).join('\n');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.CLAWDEVBOX_MCP_SECRET) headers.Authorization = `Bearer ${process.env.CLAWDEVBOX_MCP_SECRET}`;

  const body: Record<string, unknown> = {
    prompt,
    session_id: sessionId,
    context: {
      source: 'local.recipe-cron',
      recipe_id: state.recipe_id,
      fired_by: env.fired_by ?? 'cron',
      date: today,
    },
  };
  if (state.workspace_path) body.workspace_path = state.workspace_path;
  if (state.provider) body.provider = state.provider;

  const res = await fetch(callbackUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`callback POST ${res.status}: ${text}`);
  }

  state.lastFiredAt = new Date().toISOString();
  state.bootstrapped = true;
  writeStdout({
    state,
    systemMessage: `cron fired recipe=${state.recipe_id} session=${sessionId} fired_by=${env.fired_by ?? 'cron'}`,
  });
}

main().catch((err) => {
  process.stderr.write((err as Error).stack ?? String(err));
  process.exit(1);
});
