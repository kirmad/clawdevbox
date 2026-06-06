// Connect to /terminal/main/ws and grab a snapshot to see what's on screen.
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:5201/terminal/main/ws');
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

let buf = '';
ws.on('message', (m) => { buf += m.toString(); });

// Wait for snapshot
await new Promise((r) => setTimeout(r, 2000));

// Strip ANSI for readability
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');

// Extract just the 'snapshot' / 'data' chunks
const lines = buf.split('\n').filter((l) => l.trim());
let collected = '';
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    if (o.type === 'snapshot' && o.content) collected += o.content;
    if (o.type === 'data' && o.chunk) collected += o.chunk;
  } catch { /* not json */ }
}

const clean = stripAnsi(collected);
// Show last 1500 chars
console.log('---last 1500 chars of terminal snapshot---');
console.log(clean.slice(-1500));
console.log('---END---');

ws.close();
