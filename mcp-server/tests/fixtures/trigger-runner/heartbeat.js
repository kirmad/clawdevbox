let body = '';
process.stdin.on('data', (c) => { body += c.toString('utf8'); });
process.stdin.on('end', async () => {
  const env = JSON.parse(body);
  const secret = process.env.CLAWDEVBOX_FIRE_SECRET || '';
  const res = await fetch(env.spawn_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ prompt: 'node tick', context: { run_id: env.run_id } }),
  });
  if (!res.ok) { process.stderr.write(`status ${res.status}\n`); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: { node: true } }));
});
