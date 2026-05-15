async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const secret = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
const res = await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
  body: JSON.stringify({ prompt: 'mode-b heartbeat', context: { run_id: env.run_id } }),
});
if (!res.ok) { process.stderr.write(`callback ${res.status}\n`); process.exit(1); }
process.stdout.write(JSON.stringify({ state: { ticked: true }, systemMessage: 'mode-b done' }));
