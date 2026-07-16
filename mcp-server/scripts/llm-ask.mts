#!/usr/bin/env node --import tsx
/**
 * llm-ask — CLI wrapper for the llm_ask API.
 *
 * Usage:
 *   node --import tsx scripts/llm-ask.mts "What is 2+2?"
 *   node --import tsx scripts/llm-ask.mts -s "You are a poet" "Write about rain"
 *   node --import tsx scripts/llm-ask.mts -m openai/gpt-4o "Explain monads"
 *   echo "Summarize this" | node --import tsx scripts/llm-ask.mts
 */

import { ask } from '../src/llm/index.ts';

function usage(): never {
  console.error(`Usage: llm-ask [options] <prompt>

Options:
  -s, --system <msg>    System message
  -m, --model <id>      Model (default: openai/gpt-4o-mini)
  -t, --temperature <n> Temperature 0-2 (default: 0)
  -n, --max-tokens <n>  Max tokens (default: 1024)
  -p, --provider <id>   Provider (default: github-models)
  -j, --json            Output raw JSON response
  -h, --help            Show this help

Examples:
  llm-ask "What is the capital of France?"
  llm-ask -s "Reply in JSON" "List 3 fruits"
  echo "explain this code" | llm-ask`);
  process.exit(1);
}

const args = process.argv.slice(2);
let system: string | undefined;
let model: string | undefined;
let temperature = 0;
let maxTokens = 1024;
let provider: string | undefined;
let jsonOutput = false;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '-h' || a === '--help') usage();
  else if ((a === '-s' || a === '--system') && args[i + 1]) system = args[++i]!;
  else if ((a === '-m' || a === '--model') && args[i + 1]) model = args[++i]!;
  else if ((a === '-t' || a === '--temperature') && args[i + 1]) temperature = Number(args[++i]);
  else if ((a === '-n' || a === '--max-tokens') && args[i + 1]) maxTokens = Number(args[++i]);
  else if ((a === '-p' || a === '--provider') && args[i + 1]) provider = args[++i]!;
  else if (a === '-j' || a === '--json') jsonOutput = true;
  else if (!a.startsWith('-')) positional.push(a);
  else { console.error(`Unknown option: ${a}`); usage(); }
}

// Read from stdin if no positional prompt and stdin is piped
let prompt = positional.join(' ');
if (!prompt && !process.stdin.isTTY) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  prompt = Buffer.concat(chunks).toString('utf8').trim();
}

if (!prompt) {
  console.error('Error: no prompt provided');
  usage();
}

const messages: { role: 'system' | 'user'; content: string }[] = [];
if (system) messages.push({ role: 'system', content: system });
messages.push({ role: 'user', content: prompt });

try {
  const result = await ask({ messages, model, temperature, max_tokens: maxTokens, provider });
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.content);
    console.error(`\n[${result.provider} · ${result.model} · ${result.latency_ms}ms]`);
  }
} catch (err) {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
}
