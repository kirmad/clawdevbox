// demo-walkthrough.mjs
//
// Manual review demo for the walkthrough renderer.
//
//   1. Boots the terminal-server in-process.
//   2. Authors the same walkthrough artifact as verify-artifacts.mjs —
//      real conductor source files, 5 steps, mermaid architecture diagram,
//      per-step diagrams, related-file chips.
//   3. Opens headed Chromium pointed at the view URL.
//
// Use the sidebar to walk steps, click related-file chips to jump steps,
// or use #step=N fragments to deep-link. Close the browser to exit.

import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceFromEnv } from './src/workspace.ts';
import { startTerminalServer } from './src/terminal-server.ts';
import { writeArtifact } from './src/artifact-store.ts';
import { createWorkspace, resolveWorkspacesRoot } from './src/workspaces-store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (rel) => readFileSync(join(HERE, rel), 'utf8');
const safeName = (p) => p.replace(/[\\/]/g, '__');

// --- Workspace + server ----------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'conductor-wt-demo-'));
const projectDir = join(tmp, 'project');
mkdirSync(projectDir, { recursive: true });
for (const sub of ['recipes', 'skills', 'plugins', 'recipe-instances']) {
  mkdirSync(join(projectDir, '.conductor', sub), { recursive: true });
}
writeFileSync(
  join(projectDir, '.conductor', 'workspace.json'),
  JSON.stringify({ schemaVersion: 1, id: 'demo-ws' }, null, 2),
);
writeFileSync(join(projectDir, '.conductor', 'triggers.json'), JSON.stringify({ registered: [] }, null, 2));

const workspacesRoot = join(tmp, 'workspaces');
mkdirSync(workspacesRoot, { recursive: true });
process.env.CONDUCTOR_PROJECT_DIR = projectDir;
process.env.CONDUCTOR_WORKSPACES_ROOT = workspacesRoot;

const ws = loadWorkspaceFromEnv();
const wsRecord = createWorkspace(resolveWorkspacesRoot(), {
  name: 'demo-ws',
  baseProjectPath: projectDir,
});
const workspacePath = wsRecord.info.path;

// --- Author the walkthrough -----------------------------------------------

const id = 'feature-walkthrough';

const realFiles = {
  'src/artifact-store.ts': readRepoFile('src/artifact-store.ts'),
  'src/tools/artifact.ts': readRepoFile('src/tools/artifact.ts'),
  'src/terminal-server.ts': readRepoFile('src/terminal-server.ts'),
  'src/renderers/markdown.mjs': readRepoFile('src/renderers/markdown.mjs'),
  'src/renderer-registry.ts': readRepoFile('src/renderer-registry.ts'),
};

const wt = {
  id: 'wt-artifact-viewer',
  prId: 5180686,
  summary:
    '**How the artifact viewer wires up.** The agent runs a skill that writes content files into `<workspace>/artifacts/<id>/`, then calls `artifact.add` to register the manifest. The terminal-server serves an HTML host page that dynamic-imports a renderer resolved through `workspace → plugin → builtin`.',
  architectureDiagram: [
    'flowchart LR',
    '  Agent[Agent and skill]',
    '  Disk[(workspace artifacts dir)]',
    '  Server[terminal-server.ts]',
    '  Browser[artifact host page]',
    '  Renderer[renderer .mjs]',
    '  Agent -- writes files --> Disk',
    '  Agent -- artifact.add --> Disk',
    '  Browser -- HTTP --> Server',
    '  Server -- HTML --> Browser',
    '  Browser -- import --> Renderer',
    '  Renderer -- fetch --> Server',
  ].join('\n'),
  steps: [
    {
      stepNumber: 1,
      title: 'Disk layout & manifest',
      description:
        'Each artifact lives in `<workspace>/artifacts/<artifact_id>/`. The folder name is the id; `manifest.json` discriminates the renderer via `type`. One artifact per folder so every folder represents exactly one renderable view.',
      filePath: 'src/artifact-store.ts',
      startLine: 27, endLine: 60,
      relatedFiles: ['src/tools/artifact.ts'],
    },
    {
      stepNumber: 2,
      title: 'Disk-first authoring',
      description:
        "`artifact.add` registers the manifest. The agent's skill may have already populated the folder with content (preferred for large outputs), or it can pass `files` inline. Optional `recipe_instance_id` / `step_id` link the artifact to a recipe run for UI grouping without making lifetime depend on recipe state.",
      filePath: 'src/tools/artifact.ts',
      startLine: 96, endLine: 200,
      relatedFiles: ['src/artifact-store.ts'],
      diagram: [
        'sequenceDiagram',
        '  Skill->>Disk: write content files',
        '  Skill->>MCP: artifact.add',
        '  MCP->>Disk: write manifest.json',
        '  MCP-->>Skill: view_url',
      ].join('\n'),
    },
    {
      stepNumber: 3,
      title: 'HTTP host page',
      description:
        '`GET /artifact/:id` returns a small HTML host page. The page fetches the manifest + file list, then `import("/__renderer/<type>.mjs")` and calls `renderer.render(root, ctx)`. Errors during render fall into a visible `#artifact-error` block.',
      filePath: 'src/terminal-server.ts',
      startLine: 173, endLine: 250,
      relatedFiles: ['src/renderer-registry.ts'],
    },
    {
      stepNumber: 4,
      title: 'Renderer resolution chain',
      description:
        'Renderer type → file lookup walks workspace → plugin → builtin and returns the first match. Agents can write workspace renderers (via `renderer.write`) that shadow plugin / builtin entries, enabling per-workspace customization without forking the server.',
      filePath: 'src/renderer-registry.ts',
      startLine: 47, endLine: 80,
      relatedFiles: ['src/tools/artifact.ts'],
    },
    {
      stepNumber: 5,
      title: 'Renderer contract',
      description:
        'Every renderer is an ES module with `export default { type, render(root, ctx) }`. `ctx` provides `manifest`, `artifactId`, `listFiles()`, `fetchFile(name)`, `fetchFileJson(name)`. The built-in markdown renderer demonstrates the minimal shape: marked + highlight.js + mermaid for code-fenced diagrams.',
      filePath: 'src/renderers/markdown.mjs',
      startLine: 80, endLine: 120,
      relatedFiles: ['src/renderer-registry.ts'],
    },
  ],
  totalSteps: 5,
  estimatedReadTime: 6,
};

const files = { 'walkthrough.json': wt };
for (const [path, source] of Object.entries(realFiles)) {
  files[`files__${safeName(path)}.txt`] = source;
}

writeArtifact({
  workspacePath,
  manifest: {
    id,
    type: 'walkthrough',
    title: 'Artifact viewer pipeline',
    workspace_id: wsRecord.info.id,
    created_at: Date.now(),
  },
  files,
});

// --- Boot server + open headed Chromium ----------------------------------

const srv = await startTerminalServer({ workspace: ws });
const url = `${new URL(srv.url('x')).origin}/artifact/${encodeURIComponent(id)}`;

console.log('');
console.log('================================================================');
console.log(' Conductor — walkthrough demo');
console.log('================================================================');
console.log(` View URL:  ${url}`);
console.log('');
console.log(' Try:');
console.log('   - click any step in the left sidebar');
console.log('   - click the file-path link under the step title');
console.log('   - click a "Related:" chip — it jumps to a step that owns it');
console.log('   - append #step=3 to the URL to deep-link');
console.log(' Close the browser window or Ctrl-C this shell to exit.');
console.log('================================================================');
console.log('');

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });

function shutdown() {
  srv.close().finally(() => process.exit(0));
}
browser.on('disconnected', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
