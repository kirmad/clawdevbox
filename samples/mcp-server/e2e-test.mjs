// End-to-end test: recipe.run with real `agency copilot` spawning the
// simple-prompt recipe; verify the spawned agent calls recipe.done and the
// instance file ends up with status='success'.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleRecipePath = resolve(here, '..', 'recipes', 'simple-prompt.yaml');

// 1) Set up an isolated workspace + WORKSPACES_ROOT
const workspacesRoot = mkdtempSync(join(tmpdir(), 'conductor-e2e-'));
const projectDir = mkdtempSync(join(tmpdir(), 'conductor-proj-'));
mkdirSync(join(projectDir, '.conductor', 'recipes'), { recursive: true });
copyFileSync(sampleRecipePath, join(projectDir, '.conductor', 'recipes', 'simple-prompt.yaml'));

console.log('workspaces root:', workspacesRoot);
console.log('project dir:    ', projectDir);

// 2) Boot the Conductor MCP server (the one we'll call via MCP)
const serverPath = resolve(here, 'src', 'index.ts');
const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', 'tsx', serverPath],
  env: {
    ...process.env,
    CONDUCTOR_PROJECT_DIR: projectDir,
    CONDUCTOR_WORKSPACES_ROOT: workspacesRoot,
    // ADO env passes through to the spawned copilot too (via spawnEnv copy)
  },
});
const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('connected to Conductor MCP');

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    throw new Error(`${name} failed: ${JSON.stringify(res.structuredContent ?? res.content)}`);
  }
  return res.structuredContent ?? JSON.parse(res.content[0].text);
}

// 3) Verify simple-prompt is visible
const recipes = await call('recipe.list', { scope: 'project' });
const found = recipes.recipes.find((r) => r.id === 'simple-prompt');
if (!found) throw new Error(`simple-prompt not visible: ${JSON.stringify(recipes)}`);
console.log('simple-prompt visible in project scope');

// 4) Fire recipe.run with real agency copilot
const PROMPT = `You are testing the Conductor recipe pipeline. Do exactly two things in order:
1. Call the MCP tool \`conductor.recipe.instance_info\` (no args). Take note of the recipe_instance_id you get back.
2. Call \`conductor.recipe.done\` with status='success', message='hello from agency copilot', and result={"echoed": "PONG"}.

Output nothing else. The tools are available via the conductor MCP server.`;

const run = await call('recipe.run', {
  id: 'simple-prompt',
  prompt: PROMPT,
  agent_cli: 'copilot',
});
console.log('recipe.run returned:', JSON.stringify(run, null, 2));

// 5) Poll the instance file for status update — agency copilot takes ~30-60s
const instanceFile = join(run.workspace_path, '.conductor', 'recipe-instances', `${run.recipe_instance_id}.json`);
console.log('waiting for agent to call recipe.done...');
console.log('instance file:', instanceFile);

const deadline = Date.now() + 180_000;  // 3min
let lastStatus = 'running';
while (Date.now() < deadline) {
  if (existsSync(instanceFile)) {
    const inst = JSON.parse(readFileSync(instanceFile, 'utf8'));
    if (inst.status !== lastStatus) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] status=${inst.status}`);
      lastStatus = inst.status;
    }
    if (inst.status !== 'running') {
      console.log('--- final instance state ---');
      console.log(JSON.stringify(inst, null, 2));
      if (inst.status === 'success') {
        console.log('\n✅ E2E TEST PASSED');
        await client.close();
        process.exit(0);
      } else {
        console.error('\n❌ E2E TEST FAILED: status', inst.status);
        process.exit(1);
      }
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error('\n❌ E2E TEST FAILED: timed out waiting for recipe.done');
const inst = existsSync(instanceFile) ? JSON.parse(readFileSync(instanceFile, 'utf8')) : null;
if (inst) console.error('Last instance state:', JSON.stringify(inst, null, 2));
process.exit(1);
