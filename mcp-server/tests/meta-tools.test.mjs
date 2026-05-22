/**
 * meta-tools.test.mjs
 *
 * Tests for the central tool registry and the 3 meta-tools
 * (list_tools, learn_tool, run_tool).
 *
 *   node --import tsx --test tests/meta-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

test('registry: defineTool stores entries and getRegistry returns them', async () => {
  const { defineTool, getRegistry, clearRegistry } = await import('../src/tools/registry.ts');
  const { z } = await import('zod');
  clearRegistry();

  defineTool({
    name: 'test.hello',
    description: 'A test tool',
    parameters: z.object({ name: z.string() }),
    handler: async (args) => ({ greeting: `Hello ${args.name}` }),
    source: 'builtin',
  });

  const reg = getRegistry();
  assert.equal(reg.size, 1);
  assert.ok(reg.has('test.hello'));
  const entry = reg.get('test.hello');
  assert.equal(entry.name, 'test.hello');
  assert.equal(entry.description, 'A test tool');
  assert.equal(entry.source, 'builtin');
  clearRegistry();
});

test('registry: defineTool rejects duplicate names', async () => {
  const { defineTool, clearRegistry } = await import('../src/tools/registry.ts');
  const { z } = await import('zod');
  clearRegistry();

  const entry = {
    name: 'test.dup',
    description: 'First',
    parameters: z.object({}),
    handler: async () => ({}),
    source: 'builtin',
  };
  defineTool(entry);
  assert.throws(() => defineTool(entry), /already registered/);
  clearRegistry();
});

// ---------------------------------------------------------------------------
// Meta-tools tests
// ---------------------------------------------------------------------------

async function setupMetaTools() {
  const { defineTool, clearRegistry } = await import('../src/tools/registry.ts');
  const { registerMetaTools } = await import('../src/tools/meta-tools.ts');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');

  clearRegistry();

  // Create a temp dir with a sibling .md for one tool
  const tmpDir = mkdtempSync(join(tmpdir(), 'meta-tools-test-'));
  const fakeToolFile = join(tmpDir, 'greet.ts');
  writeFileSync(fakeToolFile, '// fake');
  writeFileSync(join(tmpDir, 'greet.md'), '# How to greet\n\nCall with a name parameter.');

  defineTool({
    name: 'mock.greet',
    description: 'Greets a user',
    parameters: z.object({ name: z.string() }),
    handler: async (args) => ({
      content: [{ type: 'text', text: `Hello ${args.name}` }],
    }),
    examples: [{ description: 'Greet Alice', args: { name: 'Alice' } }],
    source: 'builtin',
    sourceFile: fakeToolFile,
  });
  defineTool({
    name: 'mock.add',
    description: 'Adds two numbers',
    parameters: z.object({ a: z.number(), b: z.number() }),
    handler: async (args) => ({
      content: [{ type: 'text', text: `Result: ${args.a + args.b}` }],
      structuredContent: { result: args.a + args.b },
    }),
    source: 'builtin',
  });

  const server = new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  registerMetaTools(server, tmpDir);
  return { server, clearRegistry };
}

/**
 * Helper to call a tool registered on the McpServer.
 * Uses the internal _registeredTools object (SDK implementation detail).
 */
function callTool(server, toolName, args = {}) {
  const entry = server._registeredTools?.[toolName];
  if (!entry) throw new Error(`Tool ${toolName} not found on server`);
  return entry.handler(args, {});
}

test('list_tools returns all registered tools', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'list_tools', {});
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.count, 2);
  assert.deepEqual(
    parsed.tools.map((t) => t.name).sort(),
    ['mock.add', 'mock.greet'],
  );
  clearRegistry();
});

test('list_tools supports filter', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'list_tools', { filter: 'greet' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.tools[0].name, 'mock.greet');
  clearRegistry();
});

test('learn_tool returns schema, examples, and documentation', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'learn_tool', { tools: ['mock.greet'] });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.tools.length, 1);
  const tool = parsed.tools[0];
  assert.equal(tool.name, 'mock.greet');
  assert.ok(tool.parameters_schema);
  assert.equal(tool.examples.length, 1);
  assert.equal(tool.examples[0].args.name, 'Alice');
  // Sibling .md should be found
  assert.ok(tool.documentation);
  assert.ok(tool.documentation.includes('How to greet'));
  clearRegistry();
});

test('learn_tool returns null documentation when no .md exists', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'learn_tool', { tools: ['mock.add'] });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.tools[0].documentation, null);
  clearRegistry();
});

test('learn_tool handles unknown tool gracefully', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'learn_tool', { tools: ['no.such'] });
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.tools[0].error);
  assert.ok(parsed.tools[0].error.includes('not found'));
  clearRegistry();
});

test('run_tool dispatches to the correct handler', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'run_tool', { tool: 'mock.add', args: { a: 3, b: 4 } });
  assert.ok(result.content[0].text.includes('7'));
  clearRegistry();
});

test('run_tool returns error for unknown tool', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'run_tool', { tool: 'no.such', args: {} });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('not found'));
  clearRegistry();
});

test('run_tool returns validation error for bad args', async () => {
  const { server, clearRegistry } = await setupMetaTools();
  const result = await callTool(server, 'run_tool', {
    tool: 'mock.add',
    args: { a: 'not a number', b: 4 },
  });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('Validation error'));
  clearRegistry();
});
