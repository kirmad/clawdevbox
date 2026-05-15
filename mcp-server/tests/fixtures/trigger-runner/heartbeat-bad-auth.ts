async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
const env = JSON.parse(await readStdin());
const res = await fetch(env.callback_url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-secret' },
  body: JSON.stringify({ prompt: 'should fail', context: {} }),
});
process.stdout.write(JSON.stringify({
  state: {}, systemMessage: `received ${res.status}`,
}));
