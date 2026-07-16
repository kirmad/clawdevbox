import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// We import the overlay as a string and eval inside a JSDOM window. This
// avoids the esm.sh html2canvas import (we'd need to mock it). For the
// unit tests we only exercise text-selection paths, which don't need
// html2canvas — but we still need to stub the import if any remains.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../src/renderers/_comment-overlay.mjs'), 'utf8');

async function freshDom(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  // Stub fetch. Use a plain object (not dom.window.Response, which JSDOM
  // doesn't expose as a constructor) since the overlay only reads
  // `.ok`, `.status`, and calls `.json()` / `.text()`.
  //
  // Handles the endpoints sendAll() now hits directly (no postMessage
  // hop): /artifact/<id>/session (the new first hop), then either
  // /dispatch (live) or /spawn (resume). /api/sessions and /manifest
  // are still mocked for the legacy fallback path. Any test that
  // triggers sendAll through these stubs will see a successful
  // round-trip on the /dispatch path.
  const makeResp = (body, status) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['etag', '"sha1:deadbeef"']]),
    json: async () => JSON.parse(body || 'null'),
    text: async () => body || '',
  });
  dom.window.fetch = async (url, opts) => {
    const method = opts?.method ?? 'GET';
    if (method === 'PUT') return makeResp('', 204);
    const u = String(url);
    // /artifact/<id>/session is now the first call sendAll() makes.
    // Mirror the server's contract: { session_id, workspace_id,
    // live_instance_id }. We return a live instance so the overlay
    // takes the /dispatch path (matches the legacy stub behaviour).
    if (/\/artifact\/[^/]+\/session\b/.test(u)) {
      return makeResp(JSON.stringify({
        session_id: null,
        workspace_id: 'project',
        live_instance_id: 'fake_inst_1',
      }), 200);
    }
    if (u.includes('/manifest')) {
      return makeResp(JSON.stringify({ workspace_id: 'project' }), 200);
    }
    if (u.includes('/api/sessions')) {
      return makeResp(JSON.stringify({
        items: [{ instance_id: 'fake_inst_1', live: true, workspace_id: 'project', started_at: Date.now() }],
      }), 200);
    }
    if (u.includes('/dispatch')) {
      return makeResp('{"ok":true}', 200);
    }
    if (u.includes('/spawn')) {
      return makeResp('{"ok":true,"mode":"spawn","instance_id":"fake_inst_spawn","session_id":"sess_x"}', 200);
    }
    return makeResp('', 404);
  };
  // SHA-1 via node:crypto polyfill, since JSDOM's Web Crypto may not
  // implement SHA-1 or may be a read-only getter we can't reassign.
  const { createHash } = await import('node:crypto');
  const subtleStub = {
    digest: async (_alg, buf) => {
      const u8 = new Uint8Array(buf);
      const hex = createHash('sha1').update(Buffer.from(u8)).digest();
      return hex.buffer.slice(hex.byteOffset, hex.byteOffset + hex.byteLength);
    },
  };
  // Use defineProperty because JSDOM exposes `crypto` as a getter-only
  // property on the Window prototype.
  Object.defineProperty(dom.window, 'crypto', {
    value: { subtle: subtleStub, getRandomValues: (arr) => arr },
    configurable: true,
    writable: true,
  });
  // Strip any remaining top-level imports (the overlay's html2canvas is
  // dynamic-imported lazily via loadHtml2Canvas, but we still strip just
  // in case the regex pattern survives in the spike port).
  const patched = SRC.replace(
    /^import\s+.+?\s+from\s+.+?;$/gm,
    "// (import stripped for jsdom)",
  );
  // Convert ESM exports to top-level declarations.
  const wrapped = `
    (async () => {
      ${patched.replace(/^export\s+/gm, '')}
      window.enableComments = enableComments;
    })();
  `;
  dom.window.eval(wrapped);
  // wait one microtask for the async IIFE to attach the export
  await new Promise((r) => setImmediate(r));
  return dom;
}

test('enableComments creates the sidebar', async () => {
  const dom = await freshDom('<p>hello</p>');
  await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  const aside = dom.window.document.querySelector('.cdb-sidebar');
  assert.ok(aside, 'sidebar should be created');
  assert.ok(dom.window.document.body.classList.contains('cdb-has-sidebar'));
});

test('text selection produces a draft with text anchor', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Drive 30% YoY growth</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  const p = dom.window.document.querySelector('p');
  const range = dom.window.document.createRange();
  range.setStart(p.firstChild, 6);
  range.setEnd(p.firstChild, 20);  // "30% YoY growth" (14 chars; setEnd is exclusive)
  const anchor = await overlay.makeTextAnchor(range);
  assert.equal(anchor.kind, 'text');
  assert.equal(anchor.section, 'Goals');
  assert.equal(anchor.text, '30% YoY growth');
  assert.ok(anchor.fingerprint.startsWith('sha1:'));
  assert.equal(anchor.occurrence, 0);

  // Also exercise addDraft to honor the test's name. This pins Task 6's
  // fix where addDraft would silently swallow applyTextHighlight failures.
  await overlay.addDraft(anchor);
  assert.equal(overlay.drafts.length, 1, 'draft added to overlay state');
  assert.equal(overlay.drafts[0].comment, '', 'new drafts start with empty comment');
  assert.equal(overlay.drafts[0].orphan, false, 'in-DOM text yields non-orphan draft');
});

test('re-anchoring finds existing text after a fresh render', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Drive 30% YoY growth</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: { kind: 'text', section: 'Goals', text: '30% YoY growth', fingerprint: '', occurrence: 0 },
    comment: 'test',
  }];
  overlay.indexDrafts();
  await overlay.renderHighlights();
  const span = dom.window.document.querySelector('.cdb-comment-anchor');
  assert.ok(span, 'highlight should be applied');
  assert.equal(span.textContent, '30% YoY growth');
});

test('re-anchoring marks missing text as orphan', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Completely different content here</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: { kind: 'text', section: 'Goals', text: 'not present', fingerprint: '', occurrence: 0 },
    comment: 'test',
  }];
  overlay.indexDrafts();
  await overlay.renderHighlights();
  assert.equal(overlay.drafts[0].orphan, true);
});

test('buildMarkdownBundle includes text quote and section label', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>x</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test Plan' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: { kind: 'text', section: 'Goals', text: 'baseline', fingerprint: '', occurrence: 0 },
    comment: 'Needs a baseline number.',
  }];
  const md = overlay.buildMarkdownBundle();
  assert.match(md, /Test Plan/);
  assert.match(md, /Comment 1.*Goals/);
  assert.match(md, /Needs a baseline number\./);
  assert.match(md, /"baseline"/);
});

test('buildMarkdownBundle includes attachment path for image anchors', async () => {
  const dom = await freshDom('<h2>Architecture</h2>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test Plan' },
  });
  overlay.drafts = [{
    id: 'c1',
    anchor: {
      kind: 'image', element: 'mermaid', section: 'Architecture',
      attachment_id: 'att_x', attachment_path: '.clawdevbox/store/artifact-comment-attachments/att_x.png',
    },
    comment: 'branch at step 3',
  }];
  const md = overlay.buildMarkdownBundle();
  assert.match(md, /mermaid snapshot in .*Architecture/);
  assert.match(md, /\.clawdevbox\/store\/artifact-comment-attachments\/att_x\.png/);
});

// ===========================================================================
// Mark-sent contract — drafts stay in the sidebar after a successful Send
// and the sidebar's Send-button counter ignores them.
// ===========================================================================

test('renderCards shows total count but Send button counts only unsent', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Hello there.</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [
    { id: 'c1', anchor: { kind: 'text', section: 'Goals', text: 'Hello', fingerprint: '', occurrence: 0 }, comment: 'a', sent: true, sent_at: new Date().toISOString() },
    { id: 'c2', anchor: { kind: 'text', section: 'Goals', text: 'there', fingerprint: '', occurrence: 0 }, comment: 'b' },
  ];
  overlay.indexDrafts();
  overlay.renderCards();

  const count = dom.window.document.querySelector('.cdb-sidebar .cdb-count');
  const sendBtn = dom.window.document.querySelector('.cdb-sidebar .send');
  assert.equal(count.textContent, '2', 'header count includes sent + unsent');
  assert.match(sendBtn.textContent, /Send \(1\)/, 'Send button counts only unsent');
  assert.equal(sendBtn.disabled, false, 'Send button enabled while unsent exist');
});

test('renderCards disables Send button when all drafts are sent', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Hello.</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [
    { id: 'c1', anchor: { kind: 'text', section: 'Goals', text: 'Hello', fingerprint: '', occurrence: 0 }, comment: 'a', sent: true, sent_at: new Date().toISOString() },
  ];
  overlay.indexDrafts();
  overlay.renderCards();

  const sendBtn = dom.window.document.querySelector('.cdb-sidebar .send');
  assert.match(sendBtn.textContent, /Send \(0\)/);
  assert.equal(sendBtn.disabled, true);
});

test('renderCard adds cdb-sent class and hides edit/delete buttons on sent cards', async () => {
  const dom = await freshDom('<h2>Goals</h2><p>Hello.</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [
    { id: 'c1', anchor: { kind: 'text', section: 'Goals', text: 'Hello', fingerprint: '', occurrence: 0 }, comment: 'a', sent: true, sent_at: new Date().toISOString() },
  ];
  overlay.indexDrafts();
  overlay.renderCards();

  const card = dom.window.document.querySelector('.cdb-card');
  assert.ok(card.classList.contains('cdb-sent'), 'card has cdb-sent class');
  assert.ok(card.querySelector('.sent-meta'), 'card shows ✓ Sent meta line');
  assert.equal(card.querySelector('.edit'), null, 'no edit button on sent card');
  assert.equal(card.querySelector('.delete'), null, 'no delete button on sent card');
});

test('buildMarkdownBundle(unsent) includes only the unsent drafts', async () => {
  const dom = await freshDom('<h2>A</h2><p>x</p><h2>B</h2><p>y</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [
    { id: 'c1', anchor: { kind: 'text', section: 'A', text: 'x', fingerprint: '', occurrence: 0 }, comment: 'OLD already sent', sent: true, sent_at: new Date().toISOString() },
    { id: 'c2', anchor: { kind: 'text', section: 'B', text: 'y', fingerprint: '', occurrence: 0 }, comment: 'NEW unsent' },
  ];
  const unsent = overlay.drafts.filter(d => !d.sent);
  const md = overlay.buildMarkdownBundle(unsent);
  assert.match(md, /NEW unsent/);
  assert.doesNotMatch(md, /OLD already sent/);
});

test('clearAll only removes unsent drafts; sent drafts persist as history', async () => {
  const dom = await freshDom('<h2>A</h2><p>x</p>');
  const overlay = await dom.window.enableComments(dom.window.document.getElementById('root'), {
    artifactId: 'art_test', manifest: { title: 'Test' },
  });
  overlay.drafts = [
    { id: 'c_sent', anchor: { kind: 'text', section: 'A', text: 'x', fingerprint: '', occurrence: 0 }, comment: 'shipped', sent: true, sent_at: new Date().toISOString() },
    { id: 'c_unsent', anchor: { kind: 'text', section: 'A', text: 'x', fingerprint: '', occurrence: 0 }, comment: 'draft' },
  ];
  overlay.indexDrafts();
  // Stub confirm() so clearAll proceeds without user interaction.
  dom.window.confirm = () => true;
  await overlay.clearAll();
  assert.equal(overlay.drafts.length, 1, 'sent draft survives clearAll');
  assert.equal(overlay.drafts[0].id, 'c_sent');
});
