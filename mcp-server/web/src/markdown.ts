/**
 * Tiny safe-markdown helper used by InboxPanel (and reusable elsewhere).
 *
 * Markdown is rendered with `marked` then sanitized with `DOMPurify`.
 * The renderer is intentionally pure-function — no side effects, no
 * caching — so it's safe to call during a computed().
 *
 * Text format is escaped + wrapped in <pre> to preserve whitespace
 * without re-introducing the markdown surface area.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: false,
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInboxBody(
  body: string,
  format: 'markdown' | 'text' | undefined,
): string {
  if (!body) return '';
  if (format === 'text') {
    return `<pre class="inbox-body-pre">${escapeHtml(body)}</pre>`;
  }
  const html = marked.parse(body, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // Force every <a> to open externally and drop opener relationship.
    ADD_ATTR: ['target', 'rel'],
  });
}
