// renderers/pr-review.mjs — built-in renderer for type="pr-review".
//
// Mirrors TaskDock's review surface (src/renderer/components/file-tree.ts
// + diff-viewer.ts + app.ts plumbing). Key choices:
//
//   * Hierarchical file tree (FileNode) built from path-split, with
//     single-child folder chains collapsed (like file-tree.ts:optimizeTree).
//   * Full-file diff: every line of both the original and modified file is
//     rendered with type=add/del/ctx, line numbers in a gutter, computed via
//     the `diff` library's diffLines(). Not just hunks.
//   * 50-line chunks wrapped in `.diff-chunk` with `content-visibility: auto`
//     to keep large files fast.
//   * Review comments are anchored to the modified-file line number; a small
//     badge appears in the gutter, and the comment body inserts below the
//     anchor line as a collapsible thread.
//   * Layout: hierarchical sidebar | main diff | right-rail comments. The
//     dividers between them are draggable.
//   * Keyboard: j / k for next / prev change-group, n / p for next / prev
//     comment, when the diff pane has focus.
//
// Data shape (matches src/shared/ai-types.ts AIReviewComment + a TaskDock-
// style FileChange list):
//
//   review.json = {
//     files: [
//       { path: "src/foo.ts", changeType: "edit"|"add"|"delete"|"rename" },
//       ...
//     ],
//     comments: AIReviewComment[]
//   }
//   pr.json        = PRContext { prId, title, description, sourceBranch,
//                                targetBranch, repository, org?, project? }
//   walkthrough.json (optional) = CodeWalkthrough
//
//   For each `files[i]`, two adjacent text files must be present in the
//   artifact folder:
//     original__<safe>.txt   — full pre-PR content
//     modified__<safe>.txt   — full post-PR content
//   where `<safe>` is `path` with `/` replaced by `__`. The renderer fetches
//   them on demand when the user clicks the file in the tree.

import { marked } from 'https://esm.sh/marked@12';
import hljs from 'https://esm.sh/highlight.js@11.10.0';
import { diffLines } from 'https://esm.sh/diff@5.2.0';
import mermaid from 'https://esm.sh/mermaid@11.4.0';

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

// ============================================================================
// Constants
// ============================================================================

const SEVERITIES = ['critical', 'major', 'minor', 'trivial'];
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, trivial: 3 };
const CATEGORIES = [
  'bug', 'security', 'performance', 'logic', 'compliance',
  'style', 'recommendation', 'nitpick', 'other',
];

const CHUNK_SIZE = 50;

const STYLES = `
  .pr { display: grid; grid-template-rows: auto auto 1fr; gap: 12px; height: 100%; min-height: 0; }

  /* header + toolbar (same as before) */
  .pr-header { background: #252526; border: 1px solid #3e3e42; border-radius: 6px; padding: 12px 16px; }
  .pr-header .crumbs { font-size: 12px; color: #b0b0b0; }
  .pr-header h1 { margin: 4px 0 0; font-size: 18px; color: #fff; }
  .pr-header .branches { font-size: 12px; color: #b0b0b0; margin-top: 4px; font-family: Consolas, monospace; }
  .pr-header .branches .arrow { color: #888; padding: 0 4px; }
  .pr-header .desc { margin-top: 8px; color: #d4d4d4; line-height: 1.5; font-size: 13px; }

  .pr-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    background: #252526; border: 1px solid #3e3e42; border-radius: 6px; padding: 8px 12px; }
  .pr-toolbar .stat { font-size: 11px; color: #b0b0b0; padding-right: 6px; border-right: 1px solid #3e3e42; }
  .pr-toolbar .stat:last-of-type { border-right: 0; }
  .pr-toolbar .stat b { color: #fff; }
  .pr-toolbar .stat .crit { color: #ff8585; }
  .pr-toolbar .stat .maj { color: #ffb86c; }
  .pr-toolbar .stat .min { color: #4daafc; }
  .pr-toolbar .filters { display: flex; gap: 4px; flex-wrap: wrap; }
  .pr-toolbar .filters label { font-size: 11px; padding: 2px 7px; border-radius: 10px; background: #1b1b1b; border: 1px solid #3e3e42; color: #d4d4d4; cursor: pointer; user-select: none; }
  .pr-toolbar .filters label.off { opacity: 0.3; }
  .pr-toolbar .filters label input { display: none; }
  .pr-toolbar .nav { display: flex; gap: 4px; margin-left: auto; }
  .pr-toolbar .nav button { background: #0e639c; color: #fff; border: 0; padding: 4px 10px; font-size: 11px; border-radius: 3px; cursor: pointer; }
  .pr-toolbar .nav button:disabled { background: #4d4d4d; cursor: not-allowed; }
  .pr-toolbar .kbd { color: #888; font-size: 10px; font-family: Consolas, monospace; margin-left: 6px; }

  /* main grid: sidebar | diff | comments rail */
  .pr-main { display: grid; grid-template-columns: var(--tree-w, 260px) 4px 1fr 4px var(--rail-w, 340px); gap: 0; min-height: 0; }
  .pr-main > .pr-tree, .pr-main > .pr-diff-host, .pr-main > .pr-rail {
    background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; overflow: hidden; min-height: 0; min-width: 0; display: flex; flex-direction: column;
  }
  .pr-main > .pr-divider { cursor: col-resize; background: transparent; }
  .pr-main > .pr-divider:hover { background: #4d4d4d33; }

  /* file tree */
  .pr-tree-head { padding: 8px 12px; border-bottom: 1px solid #3e3e42; font-size: 11px; color: #b0b0b0; text-transform: uppercase; letter-spacing: 0.4px; display: flex; gap: 8px; align-items: center; }
  .pr-tree-head .count { color: #fff; font-size: 12px; text-transform: none; }
  .pr-tree-body { flex: 1; overflow: auto; padding: 6px 0 12px; }
  .pr-tree .row { display: grid; grid-template-columns: 1fr auto; align-items: center; padding: 3px 8px; font-size: 12px; color: #d4d4d4; cursor: pointer; line-height: 1.3; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  .pr-tree .row:hover { background: #2d2d30; }
  .pr-tree .row.active { background: #0e639c; color: #fff; }
  .pr-tree .row .lhs { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-tree .row .chev { width: 12px; color: #6e6e6e; text-align: center; flex-shrink: 0; }
  .pr-tree .row .ico { width: 14px; flex-shrink: 0; font-size: 12px; text-align: center; }
  .pr-tree .row .ico.add { color: #b6f3c6; }
  .pr-tree .row .ico.del { color: #ffc1bd; }
  .pr-tree .row .ico.edit { color: #ffb86c; }
  .pr-tree .row .ico.rename { color: #4daafc; }
  .pr-tree .row .name { font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; }
  .pr-tree .row .badge { background: #1b1b1b; border: 1px solid #3e3e42; color: #4daafc; font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 6px; }
  .pr-tree .folder-children { padding-left: 0; }
  .pr-tree .folder-children.collapsed { display: none; }

  /* diff host */
  .pr-diff-head { padding: 8px 12px; border-bottom: 1px solid #3e3e42; display: flex; gap: 8px; align-items: baseline; }
  .pr-diff-head .path { color: #fff; font-family: Consolas, monospace; font-size: 13px; }
  .pr-diff-head .lang { color: #888; font-size: 11px; margin-left: auto; }
  .pr-diff-host .pr-diff { flex: 1; overflow: auto; }
  .pr-diff-empty { padding: 40px; color: #888; font-style: italic; text-align: center; }

  /* diff lines */
  .diff-chunk { content-visibility: auto; contain-intrinsic-block-size: auto 1100px; }
  .diff-line { display: grid; grid-template-columns: 48px 48px 1fr; gap: 4px; padding: 0 6px 0 0;
    line-height: 22px; height: 22px; font-family: Consolas, "Liberation Mono", Menlo, monospace; font-size: 12px;
    white-space: pre; overflow: hidden; }
  .diff-line .ln-old, .diff-line .ln-new { color: #6e6e6e; text-align: right; user-select: none; padding-right: 2px; }
  .diff-line .content { color: #d4d4d4; padding-left: 6px; min-width: 0; overflow: visible; }
  .diff-line.add { background: rgba(46, 160, 67, 0.13); }
  .diff-line.add .content { color: #d6f7df; }
  .diff-line.add .ln-new { color: #6ea36e; }
  .diff-line.del { background: rgba(248, 81, 73, 0.13); }
  .diff-line.del .content { color: #ffd8d4; }
  .diff-line.del .ln-old { color: #a86060; }
  .diff-line.ctx { }
  .diff-line.scroll-target { animation: pulse-line 1.2s ease-out 1; }
  .diff-line.hl-range { box-shadow: inset 3px 0 0 #ffb86c; }
  .diff-line.has-comment .ln-new { color: #ffb86c; cursor: pointer; }
  .diff-line.has-comment .ln-new::after { content: "💬"; margin-left: 2px; font-size: 9px; }
  .diff-line.change-active { box-shadow: inset 3px 0 0 #4daafc; }
  @keyframes pulse-line {
    0% { background: rgba(255, 184, 108, 0.5); }
    100% { background: transparent; }
  }

  /* inline comments thread below an anchor line */
  .diff-thread { padding: 6px 6px 6px 96px; background: #1b1b1b; border-top: 1px solid #3e3e42; border-bottom: 1px solid #3e3e42; }
  .diff-thread .card { background: #252526; border: 1px solid #3e3e42; border-left: 3px solid #4d4d4d; border-radius: 4px; padding: 8px 12px; margin-bottom: 6px; }
  .diff-thread .card:last-child { margin-bottom: 0; }
  .diff-thread .card.severity-critical { border-left-color: #f14c4c; }
  .diff-thread .card.severity-major { border-left-color: #d29922; }
  .diff-thread .card.severity-minor { border-left-color: #4daafc; }
  .diff-thread .card.severity-trivial { border-left-color: #888; }
  .diff-thread .card header { display: flex; gap: 6px; align-items: center; font-size: 11px; flex-wrap: wrap; }
  .diff-thread .card .sev { padding: 1px 6px; border-radius: 3px; background: #2d2d30; color: #fff; font-weight: 600; text-transform: uppercase; font-size: 10px; }
  .diff-thread .card .sev.critical { background: #5a1d1d; color: #ff8585; }
  .diff-thread .card .sev.major { background: #4d361b; color: #ffb86c; }
  .diff-thread .card .sev.minor { background: #1f3b54; color: #4daafc; }
  .diff-thread .card .sev.trivial { background: #2d2d30; color: #b0b0b0; }
  .diff-thread .card .cat { color: #4daafc; font-weight: 600; }
  .diff-thread .card .conf { color: #888; }
  .diff-thread .card .ai-fixed { color: #c8f7c8; }
  .diff-thread .card .ado { color: #888; }
  .diff-thread .card h3 { font-size: 13px; color: #fff; margin: 4px 0 4px; }
  .diff-thread .card .body { font-size: 12px; color: #d4d4d4; line-height: 1.5; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  .diff-thread .card .body p { margin: 4px 0; }
  .diff-thread .card .fix { margin-top: 6px; background: #14241a; border: 1px solid #1f4030; border-radius: 4px; padding: 6px 10px; color: #c8f7c8; font-family: Consolas, monospace; font-size: 11px; white-space: pre-wrap; }

  /* right comments rail (summary list of every comment, current file first) */
  .pr-rail-head { padding: 8px 12px; border-bottom: 1px solid #3e3e42; font-size: 11px; color: #b0b0b0; text-transform: uppercase; letter-spacing: 0.4px; }
  .pr-rail-body { flex: 1; overflow: auto; padding: 4px 8px 12px; font-family: -apple-system, "Segoe UI", system-ui, sans-serif; }
  .pr-rail .group { margin-top: 8px; }
  .pr-rail .group-h { font-size: 10px; color: #b0b0b0; padding: 4px 4px; text-transform: uppercase; letter-spacing: 0.4px; font-family: Consolas, monospace; }
  .pr-rail .mini { background: #1b1b1b; border: 1px solid #3e3e42; border-left: 3px solid #4d4d4d; border-radius: 3px; padding: 6px 10px; margin: 4px 0; font-size: 12px; cursor: pointer; }
  .pr-rail .mini:hover { background: #1f1f1f; }
  .pr-rail .mini.severity-critical { border-left-color: #f14c4c; }
  .pr-rail .mini.severity-major { border-left-color: #d29922; }
  .pr-rail .mini.severity-minor { border-left-color: #4daafc; }
  .pr-rail .mini.severity-trivial { border-left-color: #888; }
  .pr-rail .mini header { display: flex; gap: 6px; font-size: 10px; color: #b0b0b0; }
  .pr-rail .mini header .sev { color: #fff; font-weight: 600; text-transform: uppercase; font-size: 9px; padding: 0 4px; border-radius: 3px; }
  .pr-rail .mini header .sev.critical { background: #5a1d1d; color: #ff8585; }
  .pr-rail .mini header .sev.major { background: #4d361b; color: #ffb86c; }
  .pr-rail .mini header .sev.minor { background: #1f3b54; color: #4daafc; }
  .pr-rail .mini header .sev.trivial { background: #2d2d30; color: #b0b0b0; }
  .pr-rail .mini header .loc { color: #d4d4d4; font-family: Consolas, monospace; }
  .pr-rail .mini h4 { font-size: 12px; color: #fff; margin: 4px 0 0; line-height: 1.35; }

  /* walkthrough panel (collapsible above the grid) */
  .pr-wt { background: #252526; border: 1px solid #3e3e42; border-radius: 6px; padding: 10px 14px; }
  .pr-wt summary { cursor: pointer; font-size: 12px; color: #fff; font-weight: 600; }
  .pr-wt .summary-md { margin-top: 6px; line-height: 1.45; color: #d4d4d4; font-size: 12px; }
  .pr-wt .arch { margin-top: 6px; background: #1b1b1b; border: 1px solid #3e3e42; border-radius: 4px; padding: 6px; }
  .pr-wt ol { padding-left: 1.5em; margin: 4px 0 0; }
  .pr-wt li { margin: 3px 0; color: #d4d4d4; font-size: 12px; }
  .pr-wt li a { color: #4daafc; cursor: pointer; text-decoration: underline dashed; }

  /* hljs theme (dark, minimal) */
  .hljs-keyword, .hljs-built_in, .hljs-type { color: #c586c0; }
  .hljs-string, .hljs-attr, .hljs-symbol { color: #ce9178; }
  .hljs-number, .hljs-literal { color: #b5cea8; }
  .hljs-comment, .hljs-meta { color: #6a9955; font-style: italic; }
  .hljs-title, .hljs-function, .hljs-section { color: #dcdcaa; }
  .hljs-variable, .hljs-params { color: #9cdcfe; }
  .hljs-tag, .hljs-name { color: #569cd6; }
`;

// ============================================================================
// Helpers
// ============================================================================

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function safeFileName(filePath) {
  return filePath.replace(/[\\/]/g, '__');
}

function langGuess(path) {
  const ext = (path?.split('.').pop() ?? '').toLowerCase();
  if (!ext) return 'plaintext';
  if (hljs.getLanguage(ext)) return ext;
  return 'plaintext';
}

function severityShort(sev) {
  return sev === 'critical' ? 'crit' : sev === 'major' ? 'maj' : sev === 'minor' ? 'min' : 'triv';
}

function commentSort(a, b) {
  const sa = SEVERITY_RANK[a.severity] ?? 99;
  const sb = SEVERITY_RANK[b.severity] ?? 99;
  if (sa !== sb) return sa - sb;
  if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
  return (a.startLine || 0) - (b.startLine || 0);
}

// ============================================================================
// File tree (mirrors taskdock file-tree.ts: buildTree + optimizeTree)
// ============================================================================

function buildFileTree(files) {
  const root = { name: '', displayName: '', path: '', isFolder: true, children: [], file: null };

  function addPath(file) {
    const parts = file.path.split('/').filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let next = cur.children.find((c) => c.name === part && c.isFolder === !isLast);
      if (!next) {
        next = {
          name: part,
          displayName: part,
          path: parts.slice(0, i + 1).join('/'),
          isFolder: !isLast,
          children: [],
          file: isLast ? file : null,
        };
        cur.children.push(next);
      }
      cur = next;
    }
  }

  for (const f of files) addPath(f);

  // Collapse single-child folder chains (file-tree.ts:optimizeTree).
  function optimize(node) {
    for (const c of node.children) optimize(c);
    if (node.isFolder && node.children.length === 1 && node.children[0].isFolder) {
      const only = node.children[0];
      node.displayName = node.displayName + '/' + only.displayName;
      node.path = only.path;
      node.children = only.children;
    }
  }
  for (const c of root.children) optimize(c);

  // Sort folders before files at each level, alphabetical within group.
  function sort(node) {
    node.children.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sort(c);
  }
  sort(root);

  return root;
}

function renderFileTreeHtml(root, commentCountByPath, collapsed) {
  function changeIcon(ct) {
    switch (ct) {
      case 'add': return '<span class="ico add" title="added">+</span>';
      case 'delete': return '<span class="ico del" title="deleted">−</span>';
      case 'rename': return '<span class="ico rename" title="renamed">↪</span>';
      case 'edit':
      default: return '<span class="ico edit" title="modified">●</span>';
    }
  }
  function renderNode(node, depth) {
    const pad = 8 + depth * 14;
    if (node.isFolder) {
      const isCollapsed = collapsed.has(node.path);
      const chev = isCollapsed ? '▸' : '▾';
      return `
        <div class="folder">
          <div class="row folder-row" data-folder="${escapeHtml(node.path)}" style="padding-left:${pad}px">
            <div class="lhs"><span class="chev">${chev}</span><span class="ico" style="color:#dcb67a">▣</span><span class="name">${escapeHtml(node.displayName)}</span></div>
            <span class="badge">${countDescendants(node)}</span>
          </div>
          <div class="folder-children ${isCollapsed ? 'collapsed' : ''}">
            ${node.children.map((c) => renderNode(c, depth + 1)).join('')}
          </div>
        </div>`;
    } else {
      const count = commentCountByPath.get(node.path) ?? 0;
      return `
        <div class="row file-row" data-file="${escapeHtml(node.path)}" style="padding-left:${pad}px">
          <div class="lhs"><span class="chev"> </span>${changeIcon(node.file?.changeType)}<span class="name">${escapeHtml(node.name)}</span></div>
          ${count > 0 ? `<span class="badge">${count}</span>` : ''}
        </div>`;
    }
  }
  function countDescendants(node) {
    if (!node.isFolder) return 1;
    return node.children.reduce((acc, c) => acc + countDescendants(c), 0);
  }
  return root.children.map((c) => renderNode(c, 0)).join('');
}

// ============================================================================
// Diff computation (entire-file)
// ============================================================================

function computeDiffLines(original, modified) {
  const changes = diffLines(original ?? '', modified ?? '');
  const lines = [];
  let oldNum = 1;
  let newNum = 1;
  for (const change of changes) {
    // diff library appends a trailing newline when value ends with one; split
    // and drop the trailing empty produced by that newline.
    const parts = String(change.value).split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    for (const text of parts) {
      if (change.added) {
        lines.push({ type: 'add', newLine: newNum, content: text });
        newNum++;
      } else if (change.removed) {
        lines.push({ type: 'del', oldLine: oldNum, content: text });
        oldNum++;
      } else {
        lines.push({ type: 'ctx', oldLine: oldNum, newLine: newNum, content: text });
        oldNum++;
        newNum++;
      }
    }
  }
  return lines;
}

function highlightLineContent(text, lang) {
  if (!text) return '&nbsp;';
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function renderDiffHtml(lines, lang) {
  // Chunk into 50-line groups so content-visibility skips off-screen work.
  const out = [];
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const chunk = lines.slice(i, i + CHUNK_SIZE);
    out.push('<div class="diff-chunk">');
    for (const l of chunk) {
      const oldCol = l.oldLine != null ? l.oldLine : '';
      const newCol = l.newLine != null ? l.newLine : '';
      const dataLine = l.newLine != null ? l.newLine : (l.oldLine != null ? `o${l.oldLine}` : '');
      out.push(
        `<div class="diff-line ${l.type}" data-line="${dataLine}" data-new-line="${l.newLine ?? ''}" data-old-line="${l.oldLine ?? ''}">` +
        `<span class="ln-old">${oldCol}</span>` +
        `<span class="ln-new">${newCol}</span>` +
        `<span class="content">${highlightLineContent(l.content, lang)}</span>` +
        `</div>`,
      );
    }
    out.push('</div>');
  }
  return out.join('');
}

function commentCardHtml(c) {
  const sevCls = c.severity ?? 'minor';
  const range = c.endLine && c.endLine !== c.startLine ? `L${c.startLine}-L${c.endLine}` : `L${c.startLine}`;
  const conf = typeof c.confidence === 'number' ? `${Math.round(c.confidence * 100)}%` : '';
  const fix = c.suggestedFix
    ? `<div class="fix">Suggested fix:\n${escapeHtml(c.suggestedFix)}</div>` : '';
  return `
    <div class="card severity-${escapeHtml(sevCls)} ${c.fixedByAI ? 'fixed-by-ai' : ''}" data-cid="${escapeHtml(c.id)}">
      <header>
        <span class="sev ${escapeHtml(sevCls)}">${escapeHtml(sevCls)}</span>
        <span class="cat">${escapeHtml(c.category ?? '')}</span>
        <span class="loc">${escapeHtml(c.filePath)}:${range}</span>
        ${conf ? `<span class="conf">conf ${conf}</span>` : ''}
        ${c.fixedByAI ? '<span class="ai-fixed">✓ fixed by AI</span>' : ''}
        ${c.adoThreadId ? `<span class="ado">ADO #${escapeHtml(String(c.adoThreadId))}</span>` : ''}
      </header>
      <h3>${escapeHtml(c.title ?? '')}</h3>
      <div class="body">${c.content ? marked.parse(String(c.content)) : ''}</div>
      ${fix}
    </div>`;
}

function miniCardHtml(c) {
  const range = c.endLine && c.endLine !== c.startLine ? `L${c.startLine}-L${c.endLine}` : `L${c.startLine}`;
  return `
    <div class="mini severity-${escapeHtml(c.severity ?? 'minor')}" data-cid="${escapeHtml(c.id)}" data-file="${escapeHtml(c.filePath)}" data-line="${escapeHtml(String(c.startLine))}" data-end-line="${escapeHtml(String(c.endLine ?? c.startLine))}">
      <header>
        <span class="sev ${escapeHtml(c.severity ?? 'minor')}">${escapeHtml(c.severity ?? '')}</span>
        <span>${escapeHtml(c.category ?? '')}</span>
        <span class="loc">${escapeHtml(c.filePath)}:${range}</span>
      </header>
      <h4>${escapeHtml(c.title ?? '')}</h4>
    </div>`;
}

// ============================================================================
// Renderer
// ============================================================================

export default {
  type: 'pr-review',
  async render(root, ctx) {
    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    const presentFiles = new Set(await ctx.listFiles());
    let pr = null;
    try { if (presentFiles.has('pr.json')) pr = await ctx.fetchFileJson('pr.json'); } catch { /* optional */ }
    const review = await ctx.fetchFileJson('review.json');
    const comments = Array.isArray(review.comments) ? [...review.comments].sort(commentSort) : [];

    let walkthrough = null;
    if (presentFiles.has('walkthrough.json')) {
      try { walkthrough = await ctx.fetchFileJson('walkthrough.json'); } catch { /* optional */ }
    }

    // Resolve the file list. Prefer review.files when present; fall back to
    // the unique set of filePaths referenced by comments (legacy shape).
    const files = Array.isArray(review.files) && review.files.length
      ? review.files
      : [...new Set(comments.map((c) => c.filePath))].sort().map((p) => ({ path: p, changeType: 'edit' }));

    // Per-file maps.
    const byFile = new Map();
    for (const c of comments) {
      const arr = byFile.get(c.filePath) ?? [];
      arr.push(c);
      byFile.set(c.filePath, arr);
    }
    const commentCountByPath = new Map();
    for (const [p, arr] of byFile.entries()) commentCountByPath.set(p, arr.length);

    const totals = {
      critical: comments.filter((c) => c.severity === 'critical').length,
      major: comments.filter((c) => c.severity === 'major').length,
      minor: comments.filter((c) => c.severity === 'minor').length,
      trivial: comments.filter((c) => c.severity === 'trivial').length,
      total: comments.length,
      fixed: comments.filter((c) => c.fixedByAI).length,
    };

    // ---------------- DOM scaffold -----------------------------------------
    const container = document.createElement('div');
    container.className = 'pr';
    container.appendChild(buildHeader(pr, ctx.manifest.title));
    container.appendChild(buildToolbar(totals));
    if (walkthrough) container.appendChild(buildWalkthrough(walkthrough));

    const main = document.createElement('section');
    main.className = 'pr-main';
    main.innerHTML = `
      <aside class="pr-tree">
        <div class="pr-tree-head"><span>Files</span><span class="count">${files.length}</span></div>
        <div class="pr-tree-body" id="pr-tree-body"></div>
      </aside>
      <div class="pr-divider" data-resize="tree"></div>
      <section class="pr-diff-host">
        <div class="pr-diff-head"><span class="path" id="pr-diff-path">—</span><span class="lang" id="pr-diff-lang"></span></div>
        <div class="pr-diff" id="pr-diff" tabindex="0"></div>
      </section>
      <div class="pr-divider" data-resize="rail"></div>
      <aside class="pr-rail">
        <div class="pr-rail-head">Comments · ${totals.total}</div>
        <div class="pr-rail-body" id="pr-rail-body"></div>
      </aside>
    `;
    container.appendChild(main);
    root.appendChild(container);

    // ---------------- File tree --------------------------------------------
    let activeFile = null;
    const treeRoot = buildFileTree(files);
    const collapsed = new Set();   // folder paths currently collapsed
    const treeBody = main.querySelector('#pr-tree-body');

    function repaintTree() {
      treeBody.innerHTML = renderFileTreeHtml(treeRoot, commentCountByPath, collapsed);
      // Re-apply active-row styling after render.
      if (activeFile) {
        const row = treeBody.querySelector(`.row.file-row[data-file="${cssEscape(activeFile)}"]`);
        if (row) row.classList.add('active');
      }
    }
    repaintTree();

    treeBody.addEventListener('click', async (ev) => {
      const folderRow = ev.target.closest('.row.folder-row');
      if (folderRow) {
        const p = folderRow.dataset.folder;
        if (collapsed.has(p)) collapsed.delete(p); else collapsed.add(p);
        repaintTree();
        return;
      }
      const fileRow = ev.target.closest('.row.file-row');
      if (fileRow) {
        await loadFile(fileRow.dataset.file);
      }
    });

    // ---------------- Diff state -------------------------------------------
    const diffEl = main.querySelector('#pr-diff');
    const diffHead = main.querySelector('#pr-diff-path');
    const langEl = main.querySelector('#pr-diff-lang');
    const fileCache = new Map();          // path → { original, modified }

    async function loadFileContents(file) {
      if (fileCache.has(file.path)) return fileCache.get(file.path);
      const safe = safeFileName(file.path);
      let original = '';
      let modified = '';
      const oCands = [`original__${safe}.txt`, `original__${safe}`, `before__${safe}.txt`];
      const mCands = [`modified__${safe}.txt`, `modified__${safe}`, `after__${safe}.txt`];
      for (const n of oCands) if (presentFiles.has(n)) { try { original = await ctx.fetchFile(n); break; } catch {} }
      for (const n of mCands) if (presentFiles.has(n)) { try { modified = await ctx.fetchFile(n); break; } catch {} }
      const entry = { original, modified };
      fileCache.set(file.path, entry);
      return entry;
    }

    async function loadFile(path) {
      const file = files.find((f) => f.path === path);
      if (!file) return;
      activeFile = path;
      // Mark active in tree.
      for (const r of treeBody.querySelectorAll('.row.file-row.active')) r.classList.remove('active');
      const row = treeBody.querySelector(`.row.file-row[data-file="${cssEscape(path)}"]`);
      if (row) row.classList.add('active');

      diffHead.textContent = path;
      const lang = langGuess(path);
      langEl.textContent = lang;
      diffEl.innerHTML = '<div class="pr-diff-empty">Loading…</div>';

      const { original, modified } = await loadFileContents(file);
      if (!original && !modified) {
        diffEl.innerHTML = `<div class="pr-diff-empty">No original/modified content shipped for <code>${escapeHtml(path)}</code>.</div>`;
        return;
      }
      const lines = computeDiffLines(original, modified);
      diffEl.innerHTML = renderDiffHtml(lines, lang);

      // Attach comments as inline threads below their anchor lines.
      const fileComments = (byFile.get(path) ?? []).slice();
      const threadsByLine = new Map();
      for (const c of fileComments) {
        const arr = threadsByLine.get(c.startLine) ?? [];
        arr.push(c);
        threadsByLine.set(c.startLine, arr);
      }
      for (const [lineNum, cs] of threadsByLine.entries()) {
        const anchor = diffEl.querySelector(`.diff-line[data-new-line="${lineNum}"]`);
        if (!anchor) continue;
        anchor.classList.add('has-comment');
        for (const c of cs) {
          // Highlight the comment's range on the modified side.
          const endLine = c.endLine ?? c.startLine;
          for (let n = c.startLine; n <= endLine; n++) {
            const r = diffEl.querySelector(`.diff-line[data-new-line="${n}"]`);
            if (r) r.classList.add('hl-range');
          }
        }
        const thread = document.createElement('div');
        thread.className = 'diff-thread';
        thread.innerHTML = cs.map(commentCardHtml).join('');
        anchor.after(thread);
      }

      // Repaint the right rail to surface the current file's comments first.
      paintRail(path);
    }

    // ---------------- Right rail ------------------------------------------
    const railBody = main.querySelector('#pr-rail-body');

    function paintRail(currentFile) {
      const filterSev = filterState.severity;
      const filterCat = filterState.category;
      const visible = comments.filter((c) => filterSev.has(c.severity) && filterCat.has(c.category));
      const cur = currentFile ? visible.filter((c) => c.filePath === currentFile) : [];
      const others = visible.filter((c) => c.filePath !== currentFile);
      const groups = [];
      if (cur.length) groups.push({ label: currentFile, items: cur });
      // Group others by file.
      const byPath = new Map();
      for (const c of others) {
        const arr = byPath.get(c.filePath) ?? [];
        arr.push(c);
        byPath.set(c.filePath, arr);
      }
      for (const [p, arr] of byPath.entries()) groups.push({ label: p, items: arr });

      railBody.innerHTML = groups.length === 0
        ? '<div style="padding:12px;color:#888;font-style:italic;font-size:12px;">No comments match the current filters.</div>'
        : groups.map((g) => `
          <div class="group">
            <div class="group-h">${escapeHtml(g.label)}</div>
            ${g.items.map(miniCardHtml).join('')}
          </div>
        `).join('');
    }

    railBody.addEventListener('click', (ev) => {
      const mini = ev.target.closest('.mini');
      if (!mini) return;
      jumpToComment(mini.dataset.cid);
    });

    // ---------------- Filters ---------------------------------------------
    const filterState = {
      severity: new Set(SEVERITIES),
      category: new Set(CATEGORIES),
    };
    container.querySelector('.pr-toolbar').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const kind = cb.dataset.filter;
        const value = cb.dataset.value;
        if (cb.checked) filterState[kind].add(value);
        else filterState[kind].delete(value);
        cb.closest('label').classList.toggle('off', !cb.checked);
        paintRail(activeFile);
      });
    });

    // ---------------- Scroll-to-line + jumping comments --------------------
    function scrollToLine(line) {
      if (line == null) return;
      const sel = `[data-line="${cssEscape(String(line))}"]`;
      const el = diffEl.querySelector(sel);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('scroll-target');
      // re-trigger animation
      void el.offsetWidth;
      el.classList.add('scroll-target');
    }

    async function jumpToComment(cid) {
      const c = comments.find((x) => x.id === cid);
      if (!c) return;
      if (activeFile !== c.filePath) await loadFile(c.filePath);
      scrollToLine(c.startLine);
    }

    // ---------------- Next/Prev issue (severity-sorted, all files) ---------
    let issueIdx = -1;
    async function gotoIssue(delta) {
      if (comments.length === 0) return;
      issueIdx = (issueIdx + delta + comments.length) % comments.length;
      const c = comments[issueIdx];
      if (activeFile !== c.filePath) await loadFile(c.filePath);
      scrollToLine(c.startLine);
    }
    container.querySelector('#pr-prev').addEventListener('click', () => gotoIssue(-1));
    container.querySelector('#pr-next').addEventListener('click', () => gotoIssue(+1));

    // ---------------- Keyboard: j/k next/prev change, n/p comment ---------
    function navigateChange(delta) {
      if (!activeFile) return;
      const allRows = [...diffEl.querySelectorAll('.diff-line.add, .diff-line.del')];
      if (allRows.length === 0) return;
      // Group consecutive add/del rows into change-groups.
      const groups = [];
      let cur = null;
      for (const r of allRows) {
        const idx = parseInt(r.dataset.newLine || `-o${r.dataset.oldLine}`, 10);
        if (cur && (idx - cur.lastIdx === 1)) {
          cur.rows.push(r); cur.lastIdx = idx;
        } else {
          cur = { rows: [r], firstIdx: idx, lastIdx: idx };
          groups.push(cur);
        }
      }
      // Track which group is currently focused via .change-active class.
      let activeGroupIdx = groups.findIndex((g) => g.rows.some((r) => r.classList.contains('change-active')));
      activeGroupIdx = (activeGroupIdx + delta + groups.length) % groups.length;
      for (const g of groups) for (const r of g.rows) r.classList.remove('change-active');
      const target = groups[activeGroupIdx].rows[0];
      target.classList.add('change-active');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function navigateComment(delta) {
      if (!activeFile) return;
      const fileComments = (byFile.get(activeFile) ?? []);
      if (fileComments.length === 0) return;
      let idx = parseInt(diffEl.dataset.commentIdx ?? '-1', 10);
      idx = (idx + delta + fileComments.length) % fileComments.length;
      diffEl.dataset.commentIdx = String(idx);
      const c = fileComments[idx];
      scrollToLine(c.startLine);
    }

    diffEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'j') { ev.preventDefault(); navigateChange(+1); }
      else if (ev.key === 'k') { ev.preventDefault(); navigateChange(-1); }
      else if (ev.key === 'n') { ev.preventDefault(); navigateComment(+1); }
      else if (ev.key === 'p') { ev.preventDefault(); navigateComment(-1); }
    });

    // ---------------- Walkthrough mermaid + click handler -----------------
    if (walkthrough?.architectureDiagram) {
      const arch = container.querySelector('.pr-wt .arch');
      if (arch) {
        try {
          const { svg } = await mermaid.render(`pr-arch-${Math.random().toString(36).slice(2)}`, String(walkthrough.architectureDiagram));
          arch.innerHTML = svg;
        } catch (err) {
          arch.textContent = `Mermaid render error: ${err?.message ?? err}`;
          arch.style.color = '#f14c4c';
        }
      }
    }
    container.addEventListener('click', async (ev) => {
      const a = ev.target.closest('.pr-wt a[data-file]');
      if (!a) return;
      ev.preventDefault();
      await loadFile(a.dataset.file);
      scrollToLine(Number(a.dataset.line));
    });

    // ---------------- Resizable columns -----------------------------------
    const mainEl = main;
    function startResize(which, startX) {
      const startTree = parseFloat(getComputedStyle(mainEl).getPropertyValue('--tree-w')) || 260;
      const startRail = parseFloat(getComputedStyle(mainEl).getPropertyValue('--rail-w')) || 340;
      function onMove(e) {
        const dx = e.clientX - startX;
        if (which === 'tree') {
          mainEl.style.setProperty('--tree-w', `${Math.max(160, Math.min(560, startTree + dx))}px`);
        } else {
          mainEl.style.setProperty('--rail-w', `${Math.max(220, Math.min(560, startRail - dx))}px`);
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
    main.querySelectorAll('.pr-divider').forEach((div) => {
      div.addEventListener('mousedown', (e) => { startResize(div.dataset.resize, e.clientX); e.preventDefault(); });
    });

    // ---------------- Initial load ----------------------------------------
    if (files.length) await loadFile(files[0].path);

    // Public API.
    window.__conductorPrReview = {
      pr, comments, files,
      gotoFile: loadFile,
      gotoComment: jumpToComment,
      gotoIssue,
      scrollToLine,
      get totals() { return totals; },
    };
  },
};

// Escape a value for embedding inside a double-quoted CSS attribute selector
// like `[data-file="..."]`. Only `"` and `\` need handling there.
function cssEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildHeader(pr, fallbackTitle) {
  const el = document.createElement('section');
  el.className = 'pr-header';
  if (!pr) {
    el.innerHTML = `<h1>${escapeHtml(fallbackTitle)}</h1>`;
    return el;
  }
  const repoLine = [pr.org, pr.project, pr.repository].filter(Boolean).join(' / ');
  el.innerHTML = `
    <div class="crumbs">PR #${escapeHtml(String(pr.prId ?? ''))}${repoLine ? ` · ${escapeHtml(repoLine)}` : ''}</div>
    <h1>${escapeHtml(pr.title ?? fallbackTitle)}</h1>
    <div class="branches"><code>${escapeHtml(pr.sourceBranch ?? '')}</code><span class="arrow">→</span><code>${escapeHtml(pr.targetBranch ?? '')}</code></div>
    ${pr.description ? `<div class="desc">${marked.parse(String(pr.description))}</div>` : ''}
  `;
  return el;
}

function buildToolbar(totals) {
  const el = document.createElement('section');
  el.className = 'pr-toolbar';
  el.innerHTML = `
    <div class="stat"><b>${totals.total}</b> comments</div>
    <div class="stat"><b class="crit">${totals.critical}</b> critical</div>
    <div class="stat"><b class="maj">${totals.major}</b> major</div>
    <div class="stat"><b class="min">${totals.minor}</b> minor</div>
    <div class="stat"><b>${totals.trivial}</b> trivial</div>
    ${totals.fixed > 0 ? `<div class="stat" style="color:#c8f7c8"><b>${totals.fixed}</b> ✓ fixed</div>` : ''}
    <div class="filters">
      ${SEVERITIES.map((s) =>
        `<label><input type="checkbox" data-filter="severity" data-value="${s}" checked />${s}</label>`,
      ).join('')}
    </div>
    <div class="filters">
      ${CATEGORIES.map((c) =>
        `<label><input type="checkbox" data-filter="category" data-value="${c}" checked />${c}</label>`,
      ).join('')}
    </div>
    <div class="nav">
      <button id="pr-prev" title="Previous issue (severity-sorted)">← Prev</button>
      <button id="pr-next" title="Next issue (severity-sorted)">Next →</button>
      <span class="kbd">j/k change · n/p comment</span>
    </div>
  `;
  return el;
}

function buildWalkthrough(wt) {
  const stepLinks = Array.isArray(wt.steps)
    ? wt.steps.map((s) => `<li><a data-file="${escapeHtml(s.filePath ?? '')}" data-line="${escapeHtml(String(s.startLine ?? ''))}"><b>${escapeHtml(s.title ?? '')}</b></a> — ${escapeHtml(String(s.description ?? '').split('\n')[0])}</li>`).join('')
    : '';
  const el = document.createElement('details');
  el.open = false;
  el.className = 'pr-wt';
  el.innerHTML = `
    <summary>Reviewer's walkthrough — ${wt.totalSteps ?? (wt.steps?.length ?? 0)} step(s) · ~${wt.estimatedReadTime ?? '?'} min</summary>
    ${wt.summary ? `<div class="summary-md">${marked.parse(String(wt.summary))}</div>` : ''}
    ${wt.architectureDiagram ? '<div class="arch">…</div>' : ''}
    <ol>${stepLinks}</ol>
  `;
  return el;
}
