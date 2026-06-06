// Submit a prompt to Main Agent and watch state.
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:5201/terminal/main/ws');
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});
console.log('WS open');

// Wait for terminal to be fully ready (snapshot flush).
await new Promise((r) => setTimeout(r, 1500));

// Clear any half-typed input by sending Ctrl-U first.
ws.send(JSON.stringify({ type: 'input', data: '\x15' }));   // Ctrl-U: kill-line
await new Promise((r) => setTimeout(r, 200));

// Type fresh prompt.
const prompt = 'reply with exactly: pong';
ws.send(JSON.stringify({ type: 'input', data: prompt }));
await new Promise((r) => setTimeout(r, 600));

// Submit.
ws.send(JSON.stringify({ type: 'input', data: '\r' }));
console.log('Prompt + Enter submitted');

// Sample API every 2s for 60s.
async function getState() {
  const r = await fetch('http://127.0.0.1:5201/api/sessions?status=active');
  const j = await r.json();
  return j.items.find((x) => x.instance_id === 'main')?.state ?? '?';
}

await new Promise((r) => setTimeout(r, 1500));
const t0 = Date.now();
for (const target of [2, 4, 6, 8, 10, 14, 20, 30, 45, 60]) {
  const wait = t0 + target * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const st = await getState();
  console.log(`T+${target}s: state=${st}`);
}

ws.close();
