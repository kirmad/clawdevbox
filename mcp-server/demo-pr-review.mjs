// demo-pr-review.mjs
//
// Manual review demo for the pr-review renderer using TaskDock's full-file
// diff + hierarchical file tree pattern.
//
//   1. Boots terminal-server.
//   2. Authors a realistic PR review artifact:
//        - PRContext (pr.json)
//        - review.json = { files: [{path, changeType}, ...], comments: [...] }
//        - per file: original__<safe>.txt + modified__<safe>.txt (full source)
//        - walkthrough.json (CodeWalkthrough)
//   3. Opens headed Chromium.

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

const tmp = mkdtempSync(join(tmpdir(), 'clawdevbox-pr-demo-'));
const projectDir = join(tmp, 'project');
mkdirSync(projectDir, { recursive: true });
for (const sub of ['recipes', 'skills', 'plugins', 'recipe-instances']) {
  mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
}
writeFileSync(
  join(projectDir, '.clawdevbox', 'workspace.json'),
  JSON.stringify({ schemaVersion: 1, id: 'demo-ws' }, null, 2),
);
writeFileSync(join(projectDir, '.clawdevbox', 'triggers.json'), JSON.stringify({ registered: [] }, null, 2));

const workspacesRoot = join(tmp, 'workspaces');
mkdirSync(workspacesRoot, { recursive: true });
process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
process.env.CLAWDEVBOX_WORKSPACES_ROOT = workspacesRoot;

const ws = loadWorkspaceFromEnv();
const wsRecord = createWorkspace(resolveWorkspacesRoot(), {
  name: 'demo-ws',
  baseProjectPath: projectDir,
});
const workspacePath = wsRecord.info.path;

// --- Author the PR review --------------------------------------------------

const id = 'pr-5180686-review';

const pr = {
  prId: 5180686,
  title: 'Add hidden pty viewer + artifact renderer pipeline',
  description: [
    'Introduces a ConPTY-based hidden agent runner and an HTTP viewer',
    'served by the Clawdevbox MCP server. Also ships the artifact storage',
    'model and three built-in renderers (markdown, pr-review, walkthrough).',
    '',
    'Validated with `verify-artifacts.mjs` and `verify-agency-alignment.mjs`',
    'against headless Chromium.',
  ].join('\n'),
  sourceBranch: 'feature/clawdevbox-artifact-viewer',
  targetBranch: 'main',
  repository: 'taskdock',
  org: 'msft-eng',
  project: 'Clawdevbox',
};

const fileList = [
  { path: 'src/pty-registry.ts', changeType: 'edit' },
  { path: 'src/terminal-server.ts', changeType: 'edit' },
  { path: 'src/renderers/markdown.mjs', changeType: 'add' },
  { path: 'src/renderers/pr-review.mjs', changeType: 'add' },
  { path: 'src/renderers/walkthrough.mjs', changeType: 'add' },
  { path: 'src/renderer-registry.ts', changeType: 'add' },
  { path: 'src/artifact-store.ts', changeType: 'add' },
  { path: 'src/tools/artifact.ts', changeType: 'add' },
  { path: 'src/tools/renderer.ts', changeType: 'add' },
];

const comments = [
  {
    id: 'c1', filePath: 'src/pty-registry.ts',
    startLine: 80, endLine: 83,
    severity: 'critical', category: 'bug',
    title: 'Unbounded ring buffer if BUFFER_LIMIT_BYTES is 0',
    content:
      '`appendToBuffer` only shrinks the ring while `bufferBytes > BUFFER_LIMIT_BYTES`. If a misconfigured workspace sets `BUFFER_LIMIT_BYTES = 0` the inner loop never enters and the buffer grows without bound for the lifetime of the pty.\n\nAdd a floor to a safe minimum (e.g. 4 KB).',
    suggestedFix:
      'const limit = Math.max(BUFFER_LIMIT_BYTES, 4 * 1024);\nwhile (s.bufferBytes > limit && s.buffer.length > 1) { ... }',
    confidence: 0.92, published: false,
  },
  {
    id: 'c2', filePath: 'src/pty-registry.ts',
    startLine: 104, endLine: 109,
    severity: 'minor', category: 'performance',
    title: 'Forwarding inside the onData hot path',
    content:
      'Each chunk iterates the `subscribers` Set in a try/catch per subscriber. For a chatty agent this is hot — collapse the try/catch out of the per-iteration step, or batch chunks by 50ms to coalesce.',
    confidence: 0.65, published: false,
  },
  {
    id: 'c3', filePath: 'src/terminal-server.ts',
    startLine: 161, endLine: 165,
    severity: 'major', category: 'security',
    title: 'Renderer path validated only by regex',
    content:
      "The `/__renderer/:type.mjs` handler relies on `resolveRendererFile` for safety. If a future plugin ships a renderer with a `..` segment in its filename (or a symlink), the regex check on the URL alone wouldn't catch it.\n\nNormalize the resolved path and verify it stays inside one of the trusted renderer roots before serving.",
    suggestedFix:
      'const abs = path.resolve(entry.filePath);\nif (!isUnder(abs, allowedRoots)) return res.writeHead(403).end();',
    confidence: 0.74, published: false, adoThreadId: 42511,
  },
  {
    id: 'c4', filePath: 'src/terminal-server.ts',
    startLine: 152, endLine: 175,
    severity: 'minor', category: 'style',
    title: 'Repetitive HTTP routing branches',
    content:
      "The artifact / renderer / pty routes are all `regex.match() → handler`. Worth extracting a small route table so adding a new surface (e.g. signals, approvals) doesn't require editing the dispatcher itself.",
    confidence: 0.55, published: false,
  },
  {
    id: 'c6', filePath: 'src/renderers/markdown.mjs',
    startLine: 21, endLine: 30,
    severity: 'major', category: 'bug',
    title: 'Renderer code() callback handles both signatures — but silently swallows text',
    content:
      'When marked v12 passes a token object, you correctly pluck `text`. When it falls back to positional args, you re-use the parameter name `codeOrToken`. If a future marked version passes a third object shape (with `raw` only), `text` resolves to `""` and the code block disappears silently.\n\nThrow if neither path provides a string, so we notice during dev rather than after a renderer upgrade.',
    confidence: 0.7, published: false,
    fixedByAI: true, fixedAt: new Date().toISOString(),
  },
  {
    id: 'c7', filePath: 'src/renderers/markdown.mjs',
    startLine: 48, endLine: 48,
    severity: 'minor', category: 'compliance',
    title: 'Inline mermaid SVG IDs use Math.random()',
    content:
      "Diagram IDs use `Math.random().toString(36)`. Safe but not cryptographically random — fine for a renderer, but Clawdevbox's security policy prefers `crypto.randomUUID()` for any identifier that crosses a process boundary.",
    confidence: 0.5, published: false,
  },
];

// Build originalContent + modifiedContent for every PR file.
const modifiedContent = {};
const originalContent = {};
for (const f of fileList) {
  modifiedContent[f.path] = readRepoFile(f.path);
  originalContent[f.path] = '';  // default for 'add'
}

function trimEdit(path, mutate) {
  const original = mutate(modifiedContent[path]);
  originalContent[path] = original;
}

trimEdit('src/pty-registry.ts', (m) => m
  .replace(
    /\/\*\* Rolling output buffer kept per session for late-attach snapshots\. \*\/\nconst BUFFER_LIMIT_BYTES = 256 \* 1024;/,
    'const BUFFER_LIMIT_BYTES = 64 * 1024;',
  )
  .replace(
    /  opts\.ipty\.onData\(\(data\) => \{\n    appendToBuffer\(session, data\);\n    for \(const sub of session\.subscribers\) \{\n      try \{ sub\(\{ type: 'data', chunk: data \}\); \} catch \{ \/\* viewer drop \*\/ \}\n    \}\n  \}\);/,
    '  opts.ipty.onData((data) => session.buffer.push(data));',
  ));

trimEdit('src/terminal-server.ts', (m) => m.replace(
  /\/\/ -------- Renderer module ----------------------------------------------\n[\s\S]*?\/\/ -------- Artifact: HTML host page ------------------------------------\n  const artifactMatch = url\.pathname\.match\(\/\^\\\/artifact\\\/\(\[A-Za-z0-9\._-\]\+\)\\\/\?\$\/\);\n  if \(artifactMatch\) \{\n    serveArtifactHost\(res, artifactMatch\[1\]\);\n    return;\n  \}\n\n/,
  '',
));

trimEdit('src/renderers/markdown.mjs', (m) => m.replace(
  /    \/\/ marked 12 may pass either positional \(legacy\) or a token object —\n    \/\/ accept both so this renderer works regardless of how marked is configured\.\n    code\(codeOrToken, infostring\) \{\n      const text = typeof codeOrToken === 'string' \? codeOrToken : \(codeOrToken\?\.text \?\? ''\);\n      const lang = typeof codeOrToken === 'string' \? infostring : codeOrToken\?\.lang;/,
  "    code({ text, lang }) {",
));

for (const f of fileList) {
  if (originalContent[f.path] && originalContent[f.path] !== modifiedContent[f.path]) {
    f.changeType = 'edit';
  }
}

const walkthrough = {
  id: 'wt-pr-5180686',
  prId: pr.prId,
  summary:
    'Two changes land together: the hidden pty + viewer, and the artifact renderer pipeline. Open `pty-registry.ts` first to see the ring-buffer + broadcast pattern, then `terminal-server.ts` for the new HTTP routes, then `renderers/markdown.mjs` for the renderer contract.',
  architectureDiagram: [
    'flowchart LR',
    '  Agent -- recipe.run --> Clawdevbox',
    '  Clawdevbox -- node-pty --> Pty',
    '  Browser -- WS --> TermServer',
    '  TermServer -- subscribe --> Pty',
    '  Agent -- artifact.add --> Disk',
    '  Browser -- import --> Renderer',
  ].join('\n'),
  steps: [
    { stepNumber: 1, title: 'Ring buffer + broadcast', description: 'Hidden pty data fan-outs to N subscribers + a scrollback ring.', filePath: 'src/pty-registry.ts', startLine: 76, endLine: 110 },
    { stepNumber: 2, title: 'HTTP route table', description: 'Artifact + pty + renderer routes share one server.', filePath: 'src/terminal-server.ts', startLine: 152, endLine: 175 },
    { stepNumber: 3, title: 'Marked v12 code callback', description: "Defensive against marked's signature flip.", filePath: 'src/renderers/markdown.mjs', startLine: 19, endLine: 35 },
  ],
  totalSteps: 3,
  estimatedReadTime: 4,
};

const files = {
  'pr.json': pr,
  'review.json': { files: fileList, comments },
  'walkthrough.json': walkthrough,
};
for (const f of fileList) {
  files[`original__${safeName(f.path)}.txt`] = originalContent[f.path];
  files[`modified__${safeName(f.path)}.txt`] = modifiedContent[f.path];
}

writeArtifact({
  workspacePath,
  manifest: {
    id, type: 'pr-review',
    title: pr.title,
    workspace_id: wsRecord.info.id,
    created_at: Date.now(),
  },
  files,
});

// --- Boot server + open headed Chromium -----------------------------------

const srv = await startTerminalServer({ workspace: ws });
const url = `${new URL(srv.url('x')).origin}/artifact/${encodeURIComponent(id)}`;

console.log('');
console.log('================================================================');
console.log(' Clawdevbox — PR review demo (full-file diff + hierarchical tree)');
console.log('================================================================');
console.log(` View URL:  ${url}`);
console.log('');
console.log(' Try:');
console.log('   - expand / collapse folders in the left tree');
console.log('   - click any file → full-file diff with add/del/ctx lines');
console.log('   - inline review threads anchored below their target line');
console.log('   - click a comment in the right rail → diff scrolls + pulses');
console.log('   - "Next →" walks issues in severity-then-file order');
console.log('   - j / k = next / prev change-group; n / p = next / prev comment');
console.log('   - drag the column dividers to resize');
console.log(' Close the browser window or Ctrl-C this shell to exit.');
console.log('================================================================');
console.log('');

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });

function shutdown() { srv.close().finally(() => process.exit(0)); }
browser.on('disconnected', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
