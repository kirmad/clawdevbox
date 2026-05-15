async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const secret = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ prompt: 'mode-b leg', context: { run_id: env.run_id } }),
});
process.stdout.write(JSON.stringify({
  state: { tickedAB: true },
  callback: { body: { prompt: 'mode-a leg', context: { run_id: env.run_id } } },
}));
