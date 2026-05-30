async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
await fetch(env.spawn_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'mode-b leg', context: { run_id: env.run_id } }),
});
process.stdout.write(JSON.stringify({
  state: { tickedAB: true },
  callback: { body: { prompt: 'mode-a leg', context: { run_id: env.run_id } } },
}));
