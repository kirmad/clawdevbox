import { executeWithTools, getMcpToolsForLlm } from './src/llm/index.ts';
import { loadWorkspaceFromEnv } from './src/workspace.ts';
import { buildServer } from './src/server.ts';

// Boot the workspace + registry so MCP tools are registered
console.log('Booting workspace...');
const ws = await loadWorkspaceFromEnv({});
await buildServer(ws);

// List available MCP tools
const allTools = getMcpToolsForLlm();
console.log(`\nRegistered ${allTools.length} MCP tools as LLM tools:`);
console.log(allTools.map(t => `  ${t.function.name}`).join('\n'));

// Test 1: Use memory_status tool
console.log('\n=== Test 1: memory_status ===');
const memTools = getMcpToolsForLlm(['memory_status']);
console.log(`Injecting ${memTools.length} tool: ${memTools.map(t => t.function.name)}`);

const t0 = performance.now();
const r1 = await executeWithTools({
  messages: [
    { role: 'system', content: 'Use the memory_status tool to answer. Be concise.' },
    { role: 'user', content: 'What is the current memory system status? How many docs are indexed?' },
  ],
  tools: memTools,
  max_tokens: 300,
  temperature: 0,
});
console.log(`Latency: ${r1.latency_ms}ms (wall: ${Math.round(performance.now() - t0)}ms)`);
console.log('Response:', r1.content?.slice(0, 300));

// Test 2: Use paths.get tool
console.log('\n=== Test 2: paths.get ===');
const pathTools = getMcpToolsForLlm(['paths.get']);
const t1 = performance.now();
const r2 = await executeWithTools({
  messages: [
    { role: 'system', content: 'Use paths.get to answer. Return just the path.' },
    { role: 'user', content: 'What is the globalDir path?' },
  ],
  tools: pathTools,
  max_tokens: 100,
  temperature: 0,
});
console.log(`Latency: ${r2.latency_ms}ms (wall: ${Math.round(performance.now() - t1)}ms)`);
console.log('Response:', r2.content);
