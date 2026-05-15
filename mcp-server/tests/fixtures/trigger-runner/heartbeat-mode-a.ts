async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
process.stdout.write(JSON.stringify({
  state: { tickedA: true },
  systemMessage: 'mode-a done',
  callback: { body: { prompt: 'mode-a heartbeat', context: { run_id: env.run_id } } },
}));
