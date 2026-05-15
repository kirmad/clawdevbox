// verify-artifacts.mjs
//
// End-to-end smoke test for the artifact viewer pipeline using REAL data:
//
//   1. Read three actual clawdevbox source files from this repo
//      (pty-registry.ts, terminal-server.ts, renderers/markdown.mjs).
//   2. Generate realistic sample artifacts that exactly match TaskDock's
//      AIReviewComment + CodeWalkthrough shapes:
//        - markdown design doc (with a mermaid flowchart + TS snippet)
//        - PR review (review.json with comments[] + pr.json PRContext +
//          per-file unified diffs)
//        - walkthrough (CodeWalkthrough shape, real file content shipped
//          alongside so the code pane shows real source with line highlights)
//   3. Write each artifact via the disk-first flow (skill writes files,
//      `artifact.add` registers manifest) into a fresh workspace.
//   4. Open each `view_url` in headless Chromium and verify navigation:
//        - PR review: click file, click comment → diff highlights jump,
//          click Next → walks issues in severity order
//        - Walkthrough: click step → code pane reloads + highlights range,
//          click a related-file chip → switches step
//   5. Screenshot each artifact (initial + after-navigation states).
//
// Screenshots → ./verify-screenshots/artifacts-*.png

import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadWorkspaceFromEnv } from './src/workspace.ts';
import { registerArtifactTools } from './src/tools/artifact.ts';
import { registerRendererTools } from './src/tools/renderer.ts';
import { startTerminalServer } from './src/terminal-server.ts';
import { writeArtifact } from './src/artifact-store.ts';
import { createWorkspace, resolveWorkspacesRoot } from './src/workspaces-store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (rel) => readFileSync(join(HERE, rel), 'utf8');

// ---------------------------------------------------------------------------
// Workspace setup
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'clawdevbox-art-verify-'));
const projectDir = join(tmp, 'project');
mkdirSync(projectDir, { recursive: true });
for (const sub of ['recipes', 'skills', 'plugins', 'recipe-instances']) {
  mkdirSync(join(projectDir, '.clawdevbox', sub), { recursive: true });
}
writeFileSync(
  join(projectDir, '.clawdevbox', 'workspace.json'),
  JSON.stringify({ schemaVersion: 1, id: 'verify-ws' }, null, 2),
);
writeFileSync(join(projectDir, '.clawdevbox', 'triggers.json'), JSON.stringify({ registered: [] }, null, 2));

const workspacesRoot = join(tmp, 'workspaces');
mkdirSync(workspacesRoot, { recursive: true });
process.env.CLAWDEVBOX_PROJECT_DIR = projectDir;
process.env.CLAWDEVBOX_WORKSPACES_ROOT = workspacesRoot;

const ws = loadWorkspaceFromEnv();
const wsRecord = createWorkspace(resolveWorkspacesRoot(), {
  name: 'verify-ws',
  baseProjectPath: projectDir,
});
const workspacePath = wsRecord.info.path;

const safeName = (p) => p.replace(/[\\/]/g, '__');

// ---------------------------------------------------------------------------
// Artifact #1 — markdown design doc
// ---------------------------------------------------------------------------

function authorMarkdown() {
  const id = 'design-doc';
  const content = `# Clawdevbox design

A quick walkthrough of the simplified Clawdevbox architecture.

## Pillars

- **SQLite kernel** — single source of truth.
- **MCP-first** — every verb is a tool.
- **Hidden ptys + renderers** — ConPTY agents and artifact viewers share
  one HTTP server.

## Pipeline

\`\`\`mermaid
flowchart LR
  Agent --> MCP --> Kernel
  Kernel -->|emits| Inbox
  Agent -->|hits| Tools
\`\`\`

Some code:

\`\`\`ts
export function welcome(name: string): string {
  return \`hello, \${name}\`;
}
\`\`\`

> Clawdevbox stays small.`;
  writeArtifact({
    workspacePath,
    manifest: {
      id,
      type: 'markdown',
      title: 'Clawdevbox design',
      workspace_id: wsRecord.info.id,
      created_at: Date.now(),
    },
    files: { 'content.md': content },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Artifact #2 — PR review on real clawdevbox files
// ---------------------------------------------------------------------------

function authorPrReview() {
  const id = 'pr-5180686-review';

  // PRContext — matches src/shared/ai-types.ts PRContext.
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

  // PR files (with changeType). The renderer builds its hierarchical tree
  // from this list and computes per-file diffs from original+modified.
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

  // Comments — AIReviewComment shape, severity-mixed, real file paths,
  // realistic categories, a couple suggestedFix blobs, and one already-
  // fixed-by-AI to exercise the fixedByAI styling.
  // Line numbers anchor each comment to a real line in the modified file
  // (verified against the actual clawdevbox source we ship as modifiedContent).
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
      confidence: 0.92,
      published: false,
    },
    {
      id: 'c2', filePath: 'src/pty-registry.ts',
      startLine: 104, endLine: 109,
      severity: 'minor', category: 'performance',
      title: 'Forwarding inside the onData hot path',
      content:
        'Each chunk iterates the `subscribers` Set in a try/catch per subscriber. For a chatty agent this is hot — collapse the try/catch out of the per-iteration step, or batch chunks by 50ms to coalesce.',
      confidence: 0.65,
      published: false,
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
      confidence: 0.74,
      published: false,
      adoThreadId: 42511,
    },
    {
      id: 'c4', filePath: 'src/terminal-server.ts',
      startLine: 152, endLine: 175,
      severity: 'minor', category: 'style',
      title: 'Repetitive HTTP routing branches',
      content:
        "The artifact / renderer / pty routes are all `regex.match() → handler`. Worth extracting a small route table so adding a new surface (e.g. signals, approvals) doesn't require editing the dispatcher itself.",
      confidence: 0.55,
      published: false,
    },
    {
      id: 'c6', filePath: 'src/renderers/markdown.mjs',
      startLine: 21, endLine: 30,
      severity: 'major', category: 'bug',
      title: 'Renderer code() callback handles both signatures — but silently swallows text',
      content:
        'When marked v12 passes a token object, you correctly pluck `text`. When it falls back to positional args, you re-use the parameter name `codeOrToken`. If a future marked version passes a third object shape (with `raw` only), `text` resolves to `""` and the code block disappears silently.\n\nThrow if neither path provides a string, so we notice during dev rather than after a renderer upgrade.',
      confidence: 0.7,
      published: false,
      fixedByAI: true,
      fixedAt: new Date().toISOString(),
    },
    {
      id: 'c7', filePath: 'src/renderers/markdown.mjs',
      startLine: 48, endLine: 48,
      severity: 'minor', category: 'compliance',
      title: 'Inline mermaid SVG IDs use Math.random()',
      content:
        "Diagram IDs use `Math.random().toString(36)`. Safe but not cryptographically random — fine for a renderer, but Clawdevbox's security policy (docs/superpowers/specs/2026-05-09-clawdevbox-simplified-design.md §13) prefers `crypto.randomUUID()` for any identifier that crosses a process boundary. Either keep this and document the carve-out, or switch.",
      confidence: 0.5,
      published: false,
    },
  ];

  // Build originalContent + modifiedContent for every file in the PR.
  // Strategy:
  //   - "add" files: original is empty, modified is the real clawdevbox source
  //     read from disk this session.
  //   - "edit" files: modified is the real source; original is the same file
  //     with the artifact-viewer additions removed (so the diff is meaningful).
  //
  // The 3 commented files are deliberately marked 'edit' so the user sees
  // both add and del lines around each review comment.
  const modifiedContent = {};
  const originalContent = {};
  for (const f of fileList) {
    modifiedContent[f.path] = readRepoFile(f.path);
    originalContent[f.path] = '';   // default for 'add'
  }

  // For each 'edit' file, build a plausible pre-PR version by stripping the
  // newly-introduced sections from the real file. The replacements below are
  // small, targeted edits — they don't need to compile, they just need to
  // produce a sensible diff that the renderer can show.
  function trimEdit(path, mutate) {
    const original = mutate(modifiedContent[path]);
    originalContent[path] = original;
  }

  trimEdit('src/pty-registry.ts', (m) => {
    // Pre-PR: appendToBuffer was a no-op and onData just pushed into the
    // buffer with no broadcast. The fix-by-AI in c1 introduces the floor;
    // the broadcast loop in c2 lands in the onData handler.
    return m
      .replace(
        /\/\*\* Rolling output buffer kept per session for late-attach snapshots\. \*\/\nconst BUFFER_LIMIT_BYTES = 256 \* 1024;/,
        'const BUFFER_LIMIT_BYTES = 64 * 1024;',
      )
      .replace(
        /  opts\.ipty\.onData\(\(data\) => \{\n    appendToBuffer\(session, data\);\n    for \(const sub of session\.subscribers\) \{\n      try \{ sub\(\{ type: 'data', chunk: data \}\); \} catch \{ \/\* viewer drop \*\/ \}\n    \}\n  \}\);/,
        '  opts.ipty.onData((data) => session.buffer.push(data));',
      );
  });

  trimEdit('src/terminal-server.ts', (m) => {
    // Pre-PR: only the /terminal/:id pty viewer existed; the artifact
    // routes + renderer module loader were added in this PR.
    return m
      .replace(
        /\/\/ -------- Renderer module ----------------------------------------------\n[\s\S]*?\/\/ -------- Artifact: HTML host page ------------------------------------\n  const artifactMatch = url\.pathname\.match\(\/\^\\\/artifact\\\/\(\[A-Za-z0-9\._-\]\+\)\\\/\?\$\/\);\n  if \(artifactMatch\) \{\n    serveArtifactHost\(res, artifactMatch\[1\]\);\n    return;\n  \}\n\n/,
        '',
      );
  });

  trimEdit('src/renderers/markdown.mjs', (m) => {
    // Pre-PR: simpler code callback that only handled the token-object form
    // (marked 12 still occasionally hands positional args, which is what
    // comment c6 calls out as silently swallowing text).
    return m.replace(
      /    \/\/ marked 12 may pass either positional \(legacy\) or a token object —\n    \/\/ accept both so this renderer works regardless of how marked is configured\.\n    code\(codeOrToken, infostring\) \{\n      const text = typeof codeOrToken === 'string' \? codeOrToken : \(codeOrToken\?\.text \?\? ''\);\n      const lang = typeof codeOrToken === 'string' \? infostring : codeOrToken\?\.lang;/,
      "    code({ text, lang }) {",
    );
  });

  // The 3 commented files become 'edit'; the rest stay 'add'.
  for (const f of fileList) {
    if (originalContent[f.path] && originalContent[f.path] !== modifiedContent[f.path]) {
      f.changeType = 'edit';
    }
  }

  // Build the inline "reviewer's walkthrough" (CodeWalkthrough shape).
  const walkthrough = {
    id: 'wt-pr-5180686',
    prId: pr.prId,
    summary:
      'Two changes land together: the hidden pty + viewer, and the artifact renderer pipeline. Open `pty-registry.ts` first to see the ring-buffer + broadcast pattern, then `terminal-server.ts` for the new HTTP routes, then `renderers/markdown.mjs` for the renderer contract.',
    architectureDiagram: [
      'flowchart LR',
      '  Agent -- recipe.run --> Clawdevbox',
      '  Clawdevbox -- node-pty/ConPTY --> Pty',
      '  Browser -- WS --> TermServer',
      '  TermServer -- subscribe --> Pty',
      '  Agent -- artifact.add --> Disk',
      '  Browser -- import --> Renderer',
    ].join('\n'),
    steps: [
      { stepNumber: 1, title: 'Ring buffer + broadcast', description: 'Hidden pty data fan-outs to N subscribers + a scrollback ring.', filePath: 'src/pty-registry.ts', startLine: 76, endLine: 110 },
      { stepNumber: 2, title: 'HTTP route table', description: 'Artifact + pty + renderer routes share one server.', filePath: 'src/terminal-server.ts', startLine: 78, endLine: 152 },
      { stepNumber: 3, title: 'Marked v12 code callback', description: 'Defensive against marked\'s signature flip.', filePath: 'src/renderers/markdown.mjs', startLine: 19, endLine: 35 },
    ],
    totalSteps: 3,
    estimatedReadTime: 4,
  };

  const files = {
    'pr.json': pr,
    // review.json now carries the files[] list (with changeType per file)
    // alongside the comments[]. The renderer builds its hierarchical tree
    // from this list.
    'review.json': { files: fileList, comments },
    'walkthrough.json': walkthrough,
  };
  // Ship original + modified content for every file in the PR.
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
  return id;
}

// ---------------------------------------------------------------------------
// Artifact #3 — walkthrough on real clawdevbox source
// ---------------------------------------------------------------------------

function authorWalkthrough() {
  const id = 'feature-walkthrough';

  // Real files we shipped this session. Ship the actual content alongside
  // the walkthrough.json so the code pane can render full files with the
  // step's line range highlighted, mirroring TaskDock's data-file/data-line
  // navigation pattern.
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
          '`artifact.add` registers the manifest. The agent\'s skill may have already populated the folder with content (preferred for large outputs), or it can pass `files` inline for convenience. Optional `recipe_instance_id` / `step_id` link the artifact to a recipe run for UI grouping without making lifetime depend on recipe state.',
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
      id, type: 'walkthrough',
      title: 'Artifact viewer pipeline',
      workspace_id: wsRecord.info.id,
      created_at: Date.now(),
    },
    files,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Boot terminal server + author + verify with Playwright.
// ---------------------------------------------------------------------------

const srv = await startTerminalServer({ workspace: ws });
const mcp = new McpServer({ name: 'verify', version: '0.0.0' }, { capabilities: { tools: {} } });
registerArtifactTools(mcp, ws);
registerRendererTools(mcp, ws);

const mdId = authorMarkdown();
const prId = authorPrReview();
const wtId = authorWalkthrough();

const outDir = resolve('./verify-screenshots');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });

async function open(id, expectGlobal) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${id}] pageerror`, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[${id}] console.error`, m.text());
  });
  const url = `${new URL(srv.url('x')).origin}/artifact/${encodeURIComponent(id)}`;
  console.log(`→ ${id} : ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction((g) => Boolean(window[g]), expectGlobal, { timeout: 15_000 });
  } catch (err) {
    const errText = await page.locator('#artifact-error').textContent().catch(() => null);
    if (errText) console.error(`[${id}] artifact-error: ${errText}`);
    await page.screenshot({ path: join(outDir, `${id}-FAIL.png`) });
    throw err;
  }
  return page;
}

async function shot(page, name) {
  const p = join(outDir, name);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  📸 ${p}`);
}

let failure = null;
try {
  // ---------- markdown ----------
  {
    const page = await open(mdId, '__clawdevboxArtifact');
    await page.locator('.markdown-body h1', { hasText: 'Clawdevbox design' }).waitFor({ timeout: 5000 });
    await page.locator('.mermaid-rendered svg').waitFor({ timeout: 8000 });
    await shot(page, 'artifacts-01-markdown.png');
    console.log('  ✅ markdown rendered');
    await page.close();
  }

  // ---------- pr-review (hierarchical tree + full-file diff) ----------
  {
    const page = await open(prId, '__clawdevboxPrReview');
    await page.locator('.pr-header .crumbs', { hasText: 'PR #5180686' }).waitFor({ timeout: 5000 });
    await page.locator('.pr-header h1', { hasText: 'hidden pty viewer' }).waitFor({ timeout: 5000 });

    // Hierarchical tree: there should be at least one folder row and a
    // file row showing the first file in active state.
    await page.locator('.pr-tree .row.folder-row').first().waitFor({ timeout: 5000 });
    await page.locator('.pr-tree .row.file-row.active').first().waitFor({ timeout: 5000 });

    // Full-file diff: the diff pane must contain both add (.diff-line.add)
    // and context (.diff-line.ctx) rows for the initial 'edit' file.
    await page.locator('.pr-diff .diff-line.add').first().waitFor({ timeout: 8000 });
    await page.locator('.pr-diff .diff-line.ctx').first().waitFor({ timeout: 8000 });

    // Inline comment thread anchored next to the critical comment.
    await page.locator('.pr-diff .diff-thread .card.severity-critical').first().waitFor({ timeout: 8000 });
    await shot(page, 'artifacts-02a-pr-review-initial.png');

    // Click the terminal-server.ts file in the tree.
    await page.locator('.pr-tree .row.file-row[data-file="src/terminal-server.ts"]').click();
    await page.locator('.pr-tree .row.file-row.active[data-file="src/terminal-server.ts"]').waitFor({ timeout: 5000 });
    await page.locator('.pr-diff .diff-line.add').first().waitFor({ timeout: 8000 });
    await page.locator('.pr-diff .diff-thread .card.severity-major').first().waitFor({ timeout: 8000 });
    await shot(page, 'artifacts-02b-pr-review-terminal-server.png');

    // Click a comment in the right rail and confirm the diff scrolls to it
    // (the line should get a scroll-target pulse animation class briefly).
    await page.locator('.pr-rail .mini.severity-major').first().click();
    await page.waitForTimeout(500);
    await shot(page, 'artifacts-02c-pr-review-rail-jump.png');

    // Walk to the next severity-sorted issue across all files.
    await page.locator('#pr-next').click();
    await page.waitForTimeout(800);
    await shot(page, 'artifacts-02d-pr-review-next-issue.png');

    // Expand a folder by clicking its row (verify tree interaction).
    const firstFolder = page.locator('.pr-tree .row.folder-row').first();
    if (await firstFolder.count()) {
      await firstFolder.click();
      await page.waitForTimeout(200);
      await firstFolder.click();  // un-collapse so subsequent screenshots are stable
    }

    console.log('  ✅ pr-review tree + full-file diff + inline threads + nav work');
    await page.close();
  }

  // ---------- walkthrough (overlay UI) ----------
  {
    const page = await open(wtId, '__clawdevboxWalkthrough');
    // Overlay is the primary chrome; code pane fills behind it.
    await page.locator('.wt-overlay .wt-name', { hasText: 'Artifact viewer pipeline' }).waitFor({ timeout: 5000 });
    await page.locator('.wt-overlay .wt-title', { hasText: 'Disk layout' }).waitFor({ timeout: 5000 });
    await page.locator('.wt-fullscreen .row.hl.start').waitFor({ timeout: 5000 });
    await shot(page, 'artifacts-03a-walkthrough-step1.png');

    // Jump to step 4 via the step-dots.
    await page.locator('.wt-dots button[data-idx="3"]').click();
    await page.locator('.wt-overlay .wt-title', { hasText: 'Renderer resolution chain' }).waitFor({ timeout: 5000 });
    await page.locator('.wt-fullscreen .row.hl.start').waitFor({ timeout: 5000 });
    await shot(page, 'artifacts-03b-walkthrough-step4.png');

    // Related-file chip jumps to step 2 (which owns src/tools/artifact.ts).
    const chip = page.locator('.wt-overlay .chip[data-file="src/tools/artifact.ts"]');
    if (await chip.count()) {
      await chip.first().click();
      await page.locator('.wt-overlay .wt-title', { hasText: 'Disk-first authoring' }).waitFor({ timeout: 5000 });
      await shot(page, 'artifacts-03c-walkthrough-chip-jump.png');
    }

    // Open the architecture overview modal and screenshot.
    await page.locator('#wt-btn-overview').click();
    await page.locator('.wt-overview-card .arch svg').waitFor({ timeout: 8000 });
    await shot(page, 'artifacts-03d-walkthrough-overview.png');
    await page.locator('#wt-overview-close').click();

    // Minimize → mini pill should appear.
    await page.locator('#wt-btn-min').click();
    await page.locator('.wt-mini').waitFor({ timeout: 3000 });
    await shot(page, 'artifacts-03e-walkthrough-minimized.png');

    console.log('  ✅ walkthrough overlay nav + overview + minimize work');
    await page.close();
  }

  console.log('\n✅ all three artifact renderers passed end-to-end.');
} catch (err) {
  failure = err;
  console.error('\n❌', err?.stack ?? err);
}

await browser.close();
await srv.close();
process.exit(failure ? 1 : 0);
