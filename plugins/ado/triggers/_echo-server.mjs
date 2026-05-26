// Tiny callback echo server for trigger E2E.
// Logs each POST as one JSON line to ECHO_LOG file (and stdout), replies 202.
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT ?? 5299);
const TOKEN = process.env.CLAWDEVBOX_MCP_SECRET ?? '';
const LOG = process.env.ECHO_LOG ?? '';
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    const ok = !TOKEN || auth === `Bearer ${TOKEN}`;
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      url: req.url,
      authOk: ok,
      bodyPreview: typeof body === 'object'
        ? { prompt_head: String(body.prompt ?? '').slice(0, 80), context: body.context, attach: body.attach_to_inbox_item_id }
        : body,
    }) + '\n';
    if (LOG) fs.appendFileSync(LOG, line);
    process.stdout.write(line);
    res.writeHead(ok ? 202 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  });
});
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`echo-server listening on http://127.0.0.1:${PORT}\n`);
});

