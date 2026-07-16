// markdown-renderer.mjs — thin stub modeled on mcp-server/src/renderers/markdown.mjs.
//
// Loads the markdown file (sample-artifact.md by default), renders to HTML,
// expands ```mermaid fences via mermaid, and returns the body element so the
// caller can hand it to enableComments.

import { marked } from 'https://esm.sh/marked@12';
import hljs from 'https://esm.sh/highlight.js@11.10.0';
import mermaid from 'https://esm.sh/mermaid@11.4.0';

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

marked.use({
  renderer: {
    code(codeOrToken, infostring) {
      const text = typeof codeOrToken === 'string' ? codeOrToken : (codeOrToken?.text ?? '');
      const lang = typeof codeOrToken === 'string' ? infostring : codeOrToken?.lang;
      if (lang === 'mermaid') {
        return `<div class="mermaid-pending" data-source="${escapeAttr(text)}"></div>`;
      }
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
      const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      return `<pre class="hljs"><code class="language-${language}">${html}</code></pre>`;
    },
  },
});

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function renderMermaidDiagrams(root) {
  const pending = root.querySelectorAll('.mermaid-pending');
  let i = 0;
  for (const el of pending) {
    const source = el.getAttribute('data-source') ?? '';
    const decoded = source
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<');
    try {
      const { svg } = await mermaid.render(
        `mermaid-svg-${++i}-${Math.random().toString(36).slice(2)}`, decoded,
      );
      const container = document.createElement('div');
      container.className = 'mermaid-rendered';
      container.innerHTML = svg;
      el.replaceWith(container);
    } catch (err) {
      const pre = document.createElement('pre');
      pre.className = 'mermaid-error';
      pre.textContent = `Mermaid render error: ${err?.message ?? err}\n\n${decoded}`;
      el.replaceWith(pre);
    }
  }
}

const STYLE_ID = 'markdown-spike-styles';
const STYLES = `
  .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 {
    color: #fff; border-bottom: 1px solid #3e3e42; padding-bottom: 4px; margin-top: 1.4em;
  }
  .markdown-body h1 { font-size: 1.8em; }
  .markdown-body h2 { font-size: 1.4em; }
  .markdown-body h3 { font-size: 1.15em; border-bottom: 0; }
  .markdown-body h4 { font-size: 1.0em; border-bottom: 0; color: #cdd2da; }
  .markdown-body p { margin: 0.7em 0; }
  .markdown-body a { color: #4daafc; }
  .markdown-body code { background: #2d2d30; padding: 2px 5px; border-radius: 3px;
    font-family: Consolas, monospace; font-size: 0.92em; }
  .markdown-body pre { background: #1b1b1b; border: 1px solid #3e3e42; border-radius: 4px;
    padding: 12px; overflow: auto; }
  .markdown-body pre code { background: transparent; padding: 0; }
  .markdown-body blockquote { border-left: 3px solid #4d4d4d; margin: 0.7em 0;
    padding: 0.1em 12px; color: #b0b0b0; }
  .markdown-body ul, .markdown-body ol { padding-left: 1.5em; }
  .markdown-body img { max-width: 100%; border-radius: 4px; }
  .mermaid-rendered { margin: 1em 0; background: #1b1b1b; border: 1px solid #3e3e42;
    border-radius: 4px; padding: 12px; }
  .mermaid-error { color: #f14c4c; background: #1b1b1b; padding: 12px; border-radius: 4px; }
  .hljs { color: #d4d4d4; }
  .hljs-keyword, .hljs-built_in, .hljs-type { color: #c586c0; }
  .hljs-string, .hljs-attr, .hljs-symbol { color: #ce9178; }
  .hljs-number, .hljs-literal { color: #b5cea8; }
  .hljs-comment, .hljs-meta { color: #6a9955; font-style: italic; }
  .hljs-title, .hljs-function, .hljs-section { color: #dcdcaa; }
  .hljs-variable, .hljs-params { color: #9cdcfe; }
  .hljs-tag, .hljs-name { color: #569cd6; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLES;
  document.head.appendChild(el);
}

export async function renderMarkdown(root, ctx) {
  ensureStyles();
  const md = await ctx.fetchFile('sample-artifact.md');
  const html = marked.parse(md);
  const body = document.createElement('div');
  body.className = 'markdown-body';
  body.innerHTML = html;
  root.appendChild(body);
  await renderMermaidDiagrams(body);
  return body;
}
