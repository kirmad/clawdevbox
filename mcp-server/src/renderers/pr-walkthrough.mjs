// renderers/pr-walkthrough.mjs — built-in renderer for type="pr-walkthrough".
//
// Production graduation of the spike at spikes/pr-walkthrough/. The spike
// is preserved verbatim as the spec — this module is a mechanical port
// adjusted only where production wiring requires it:
//
//   1. Module shape: { type, comments: false, render(root, ctx) }
//      `comments: false` opts out of the universal artifact-comments overlay
//      because we ship our own line-anchored 💬 button inside the diff.
//   2. Data source: ctx.fetchFileJson / ctx.fetchFile / ctx.artifactId
//      instead of `./artifact/<name>` fetches.
//   3. Q&A backend: real fetch + dispatch + poll instead of setTimeout fake.
//      Mirrors the session resolution pattern used by _comment-overlay.mjs.
//   4. State scoping: spike's top-level `let active = 0;` etc. now live
//      inside bootApp() closures (mermaid.initialize stays at module load).
//
// Surfaces on the overview, all driven by walkthrough.json:
//   1. VERDICT BAR — agent's recommendation + confidence + click-to-expand notes
//   2. CONFIDENCE DASHBOARD — 6 gauges (risk / tests / rollback / api / perf / deploy)
//   3. TL;DR — single sentence at the top of the left column
//   4. WHAT TO LOOK AT — ordered priority list with time-budgets
//   5. DISQUALIFIERS — concrete failure conditions + how-to-check + agent-verified flag
//   6. FAQ — pre-answered questions the reviewer would otherwise ask
//   7. 6-bullet summary, architecture, file tree
//
// Step mode:
//   - per-step mini-diagram rendered above the diff when present
//   - right rail is COLLAPSIBLE (chevron in the rail-collapse-bar)

import { PR_WALKTHROUGH_STYLES } from './_pr-walkthrough-styles.mjs';
import hljs from 'https://esm.sh/highlight.js@11.10.0';
import mermaid from 'https://esm.sh/mermaid@11.4.0';

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

// =====================================================================
// Shell HTML — verbatim from spikes/pr-walkthrough/index.html (body only)
// =====================================================================
function buildShellHtml() {
  return `
  <!-- ============================================================ TOP BAR -->
  <header class="topbar">
    <div class="topbar-left">
      <button class="ghost mode-toggle" id="mode-toggle" title="Switch mode">
        <span id="mode-label">Overview</span>
        <span class="dim">·</span>
        <span class="dim mini">click to switch</span>
      </button>
      <span class="pr-badge">PR #<span id="pr-id">…</span></span>
      <span class="pr-title" id="pr-title">…</span>
    </div>
    <div class="topbar-right">
      <span class="branch-pill" id="pr-branches">…</span>
      <span class="stat"><b id="pr-files">…</b><span class="dim"> files</span></span>
      <span class="stat stat-changes">
        <span class="add">+<span id="pr-add">…</span></span>
        <span class="del">−<span id="pr-del">…</span></span>
      </span>
      <span class="stat" id="iter-stat"><b>iter <span id="pr-iter">…</span></b></span>
      <button class="ghost" id="open-pr">ADO ↗</button>
      <button class="ghost" id="share-artifact" title="Copy a shareable link to this artifact">🔗 Share</button>
    </div>
  </header>

  <!-- ============================= CONTENT ROW (main content + persistent rail) -->
  <div class="content-row" id="content-row">
  <div class="content-main" id="content-main">

  <!-- ============================================================ OVERVIEW -->
  <section class="overview" id="overview">
    <!-- VERDICT BAR — the headline -->
    <section class="verdict-bar" id="verdict-bar">
      <div class="verdict-icon" id="verdict-icon"></div>
      <div class="verdict-text">
        <div class="verdict-line">
          <span class="verdict-rec" id="verdict-rec">…</span>
          <span class="verdict-conf" id="verdict-conf">…</span>
        </div>
        <div class="verdict-rationale" id="verdict-rationale">…</div>
        <div class="verdict-reviewers dim mini" id="verdict-reviewers">…</div>
      </div>
      <button class="ghost" id="verdict-details">Agent notes →</button>
    </section>

    <!-- CONFIDENCE DASHBOARD — 6 gauges at a glance -->
    <section class="confidence-grid" id="confidence-grid"></section>

    <!-- MAIN TWO-COLUMN GRID -->
    <div class="overview-grid">
      <!-- LEFT — context (TL;DR, arch, bullets) -->
      <div class="overview-col">
        <section class="card">
          <header class="card-head">
            <h2>TL;DR</h2>
            <span class="dim mini">5-second read</span>
          </header>
          <div class="tldr" id="tldr"></div>
        </section>

        <section class="card">
          <header class="card-head">
            <h2>Architecture</h2>
            <button class="ghost-mini" id="zoom-arch" title="Zoom">⤢</button>
          </header>
          <div class="arch" id="arch"></div>
        </section>

        <section class="card">
          <header class="card-head">
            <h2>6-bullet summary</h2>
            <span class="dim mini">read in ~40s</span>
          </header>
          <ul class="bullets" id="bullets"></ul>
        </section>
      </div>

      <!-- RIGHT — decision tools (what-to-look-at, disqualifiers, FAQ, files) -->
      <div class="overview-col">
        <section class="card focused">
          <header class="card-head">
            <h2>📍 What to look at — 5min plan</h2>
            <span class="dim mini" id="total-time">…</span>
          </header>
          <ol class="attention-list" id="attention-list"></ol>
        </section>

        <section class="card">
          <header class="card-head">
            <h2>🛑 What would change my mind (catch list)</h2>
            <span class="dim mini" id="disq-count">…</span>
          </header>
          <ul class="disq-list" id="disq-list"></ul>
        </section>

        <section class="card">
          <header class="card-head">
            <h2>❓ Pre-answered FAQ</h2>
            <span class="dim mini" id="faq-count">…</span>
          </header>
          <div class="faq-list" id="faq-list"></div>
        </section>

        <section class="card">
          <header class="card-head">
            <h2>Files changed</h2>
            <span class="dim mini"><span id="overview-file-count">…</span> files</span>
          </header>
          <ul class="file-tree" id="file-tree"></ul>
        </section>

        <button class="primary block" id="enter-stepmode">
          Start step-by-step walkthrough →
        </button>
      </div>
    </div>
  </section>

  <!-- ============================================================ STEP MODE -->
  <section class="stepmode hidden" id="stepmode">
    <main class="grid" id="step-grid">
      <aside class="left" id="steps-left">
        <section class="card">
          <header class="card-head">
            <h2>Steps</h2>
            <div class="card-head-actions">
              <span class="dim"><span id="step-progress">1</span>/<span id="step-total">…</span></span>
              <button class="ghost-mini collapse-btn" id="steps-collapse" title="Collapse steps (more room for the diff)">⟨</button>
            </div>
          </header>
          <ol class="steps" id="steps"></ol>
        </section>
        <section class="card">
          <header class="card-head">
            <h2>Summary</h2>
            <button class="ghost-mini" id="back-overview" title="Back to overview">← overview</button>
          </header>
          <ul class="bullets bullets-compact" id="bullets-compact"></ul>
        </section>
      </aside>

      <!-- COLLAPSED STEPS STRIP (shown when the steps column is collapsed) -->
      <button class="rail-collapsed-strip side-collapsed-strip" id="steps-collapsed-strip" hidden title="Expand steps">
        <span class="strip-icon">⟩</span>
        <span class="strip-label">Steps</span>
        <span class="strip-badge" id="strip-steps-count">1/8</span>
      </button>

      <section class="diff-pane" id="diff-pane">
        <header class="step-head">
          <div class="step-meta">
            <span class="step-n">Step <b id="active-n">1</b></span>
            <span class="dot">·</span>
            <span class="file" id="active-file">…</span>
            <span class="dot">·</span>
            <span class="time-budget" id="active-time">…</span>
          </div>
          <div class="step-actions">
            <button class="ghost-mini why-toggle" id="toggle-why" title="Collapse the description &amp; diagram for more diff space"><span class="why-toggle-caret">▾</span> Why</button>
            <button class="ghost" id="prev-step">← Prev</button>
            <button class="primary" id="next-step">Next →</button>
          </div>
        </header>

        <div class="why" id="active-why">…</div>

        <!-- per-step mini diagram (when present) -->
        <div class="step-diagram-wrap" id="step-diagram-wrap" hidden>
          <button class="ghost-mini diagram-expand-btn" id="expand-step-diagram" title="Expand diagram">⤢</button>
          <div class="step-diagram" id="step-diagram"></div>
        </div>

        <div class="diff-host" id="diff-host"></div>
      </section>
      </main>
  </section>

  </div><!-- /content-main -->

      <!-- PERSISTENT RIGHT RAIL — visible in BOTH overview and step mode -->
      <aside class="right" id="right-rail">
        <div class="rail-resize-handle" id="rail-resize" title="Drag to resize · double-click to reset"></div>
        <div class="rail-collapse-bar">
          <button class="rail-collapse-btn" id="rail-collapse" title="Collapse panel">
            <span class="rail-collapse-icon">⟩</span>
          </button>
          <div class="rail-tabs">
            <button class="tab active" data-tab="qa">
              <span>Q&amp;A</span>
              <span class="badge" id="qa-count">0</span>
            </button>
            <button class="tab" data-tab="comments">
              <span>Comments</span>
              <span class="badge" id="comments-count">0</span>
            </button>
          </div>
        </div>
        <section class="tab-body" data-tab-body="qa">
          <div class="qa-scope" id="qa-scope" role="tablist" aria-label="Q&amp;A scope">
            <button type="button" class="qa-scope-btn active" data-scope="step" title="Show questions on the current step only">This step</button>
            <button type="button" class="qa-scope-btn" data-scope="all" title="Show questions across all steps">All steps</button>
          </div>
          <div class="qa-thread" id="qa-thread"></div>
          <form class="qa-form" id="qa-form">
            <label class="dim">Ask about <b id="qa-step-label">this step</b></label>
            <textarea id="qa-input" placeholder="e.g. Why guard idempotency in the populate method?" rows="3"></textarea>
            <div class="qa-form-row">
              <span class="dim mini">Agent answers inline · usually &lt;15s</span>
              <button type="button" id="qa-send" class="primary">Ask →</button>
            </div>
          </form>
        </section>
        <section class="tab-body hidden" data-tab-body="comments">
          <div class="comments-help dim mini">
            Click the <span class="kbd">💬</span> in the diff gutter to anchor a comment to a line.
          </div>
          <div class="comments-thread" id="comments-thread"></div>
          <button class="primary block" id="send-comments" disabled>
            Send 0 comment(s) to agent
          </button>
        </section>
      </aside>

      <!-- COLLAPSED STRIP (shown when rail collapsed) -->
      <button class="rail-collapsed-strip" id="rail-collapsed-strip" hidden title="Expand panel">
        <span class="strip-icon">⟨</span>
        <span class="strip-label">Q&amp;A</span>
        <span class="strip-badge" id="strip-qa-count">0</span>
        <span class="strip-divider"></span>
        <span class="strip-label">Comments</span>
        <span class="strip-badge" id="strip-com-count">0</span>
      </button>

  </div><!-- /content-row -->

  <div class="toast" id="toast" hidden></div>

  <!-- AGENT-NOTES MODAL -->
  <div class="modal" id="agent-notes-modal" hidden>
    <div class="modal-card">
      <header>
        <h2>Agent review notes</h2>
        <button class="ghost" id="agent-notes-close">✕</button>
      </header>
      <div class="agent-notes-body">
        <div class="reviewers-list" id="modal-reviewers"></div>
        <ul class="agent-notes-list" id="agent-notes-list"></ul>
      </div>
    </div>
  </div>

  <!-- ARCH MODAL -->
  <div class="modal" id="arch-modal" hidden>
    <div class="modal-card">
      <header>
        <h2 id="arch-modal-title">Architecture</h2>
       <span class="zoom-controls">
         <button class="ghost zoom-btn" id="zoom-out" title="Zoom out (−)">−</button>
         <button class="ghost zoom-btn" id="zoom-reset" title="Reset zoom">⊙</button>
         <button class="ghost zoom-btn" id="zoom-in" title="Zoom in (+)">+</button>
         <span class="zoom-level" id="zoom-label">100%</span>
       </span>
       <button class="ghost" id="arch-modal-close">✕</button>
     </header>
     <div class="arch big" id="arch-big"></div>
   </div>
  </div>
  `;
}

// =====================================================================
// Boot — all state and render functions are scoped to this closure
// so the renderer can be re-imported / re-rendered without leaking globals.
// =====================================================================
async function bootApp(root, ctx) {
  // ---------------- Artifact loader (cached) ----------------
  const cache = new Map();
  async function fetchArtifact(name) {
    if (cache.has(name)) return cache.get(name);
    const text = await ctx.fetchFile(name);
    cache.set(name, text);
    return text;
  }

  const MANIFEST = ctx.manifest;
  const WT = await ctx.fetchFileJson('walkthrough.json');
  const {
    pr: PR, verdict: VERDICT, tldr: TLDR,
    whatToLookAt: ATTENTION, faq: FAQ, disqualifiers: DISQUALIFIERS,
    summary: SUMMARY, architecture: ARCH, fileStats: FILE_STATS, steps: STEPS,
  } = WT;
  // Support 'gauges' as alias for 'confidence' (skill docs use both)
  const CONFIDENCE = WT.confidence || WT.gauges || null;

  let mode = 'overview';
  let active = 0;
  let activeTab = 'qa';
  let qaScope = 'step';
  let railCollapsed = false;
  let stepsCollapsed = false;
  let whyCollapsed = false;
  const qaThreads = (STEPS || []).map(() => []);
  let drafts = [];

  // =====================================================================
  // TOP BAR
  // =====================================================================
  function renderTopbar() {
    if (!PR) {
      document.getElementById('pr-title').textContent = WT.title || MANIFEST?.title || 'PR Walkthrough';
      document.getElementById('pr-id').textContent = '';
      document.getElementById('pr-branches').textContent = WT.branch || '';
      document.getElementById('pr-files').textContent = STEPS?.length ?? '';
      document.getElementById('pr-add').textContent = '';
      document.getElementById('pr-del').textContent = '';
      document.getElementById('pr-iter').textContent = '';
    } else {
      document.getElementById('pr-id').textContent = PR.id ?? '';
      document.getElementById('pr-title').textContent = PR.title ?? '';
      document.getElementById('pr-branches').textContent = PR.sourceBranch && PR.targetBranch ? `${PR.sourceBranch} → ${PR.targetBranch}` : (PR.sourceBranch || '');
      document.getElementById('pr-files').textContent = PR.filesChanged ?? '';
      document.getElementById('pr-add').textContent = PR.additions ?? '';
      document.getElementById('pr-del').textContent = PR.deletions ?? '';
      document.getElementById('pr-iter').textContent = PR.iteration ?? '';
    }
    document.getElementById('mode-toggle').addEventListener('click', () => setMode(mode === 'overview' ? 'step' : 'overview'));
    const shareBtn = document.getElementById('share-artifact');
    if (shareBtn) shareBtn.addEventListener('click', async () => {
      let url = location.href;
      try {
        if (typeof window.getArtifactShareUrl === 'function') url = await window.getArtifactShareUrl();
      } catch { /* fall back to current url */ }
      try {
        await navigator.clipboard.writeText(url);
        const prev = shareBtn.innerHTML;
        shareBtn.textContent = '✓ Copied';
        shareBtn.classList.add('copied');
        setTimeout(() => { shareBtn.innerHTML = prev; shareBtn.classList.remove('copied'); }, 2000);
      } catch {
        prompt('Copy this URL:', url);
      }
    });
  }

  // =====================================================================
  // VERDICT BAR
  // =====================================================================
  function renderVerdict() {
    if (!VERDICT) return;
    const isApprove = VERDICT.recommendation === 'APPROVE';
    const bar = document.getElementById('verdict-bar');
    bar.classList.add(isApprove ? 'verdict-approve' : 'verdict-changes');
    document.getElementById('verdict-icon').textContent = isApprove ? '✅' : '⚠️';
    document.getElementById('verdict-rec').textContent =
      isApprove ? 'Recommended: APPROVE' : 'Recommended: REQUEST CHANGES';
    const conf = VERDICT.confidence;
    const confEl = document.getElementById('verdict-conf');
    confEl.textContent = `confidence: ${conf}`;
    confEl.classList.add(`conf-${conf}`);
    document.getElementById('verdict-rationale').innerHTML = md(VERDICT.oneLiner);
    document.getElementById('verdict-reviewers').textContent =
      'Reviewed by: ' + (VERDICT.reviewedBy || []).join(' · ');
    document.getElementById('verdict-details').addEventListener('click', openAgentNotes);
  }

  function openAgentNotes() {
    const m = document.getElementById('agent-notes-modal');
    document.getElementById('modal-reviewers').innerHTML =
      `<div class="dim mini">Reviewed by</div>` +
      (VERDICT.reviewedBy || []).map(r => `<span class="reviewer-chip">${escapeHtml(r)}</span>`).join('');
    document.getElementById('agent-notes-list').innerHTML =
      (VERDICT.agentNotes || []).map(n => `<li>${md(n)}</li>`).join('');
    m.hidden = false;
    document.getElementById('agent-notes-close').onclick = () => { m.hidden = true; };
    m.onclick = ev => { if (ev.target === m) m.hidden = true; };
  }

  // =====================================================================
  // CONFIDENCE DASHBOARD
  // =====================================================================
  function renderConfidence() {
    const order = [
      ['risk',      'Risk'],
      ['tests',     'Tests'],
      ['rollback',  'Rollback'],
      ['publicApi', 'Public API'],
      ['perf',      'Perf'],
      ['deploy',    'Deploy'],
    ];
    const grid = document.getElementById('confidence-grid');
    grid.innerHTML = order.map(([key, label]) => {
      const c = CONFIDENCE?.[key];
      if (!c) return '';
      const emoji = c.grade === 'good' ? '🟢' : c.grade === 'caution' ? '🟡' : c.grade === 'warn' ? '🟠' : '🔴';
      return `<button class="conf-gauge grade-${escapeHtml(c.grade)}" data-step="${c.anchorStep ?? ''}">
        <div class="conf-emoji">${emoji}</div>
        <div class="conf-label">${escapeHtml(label)}</div>
        <div class="conf-headline">${escapeHtml(c.headline)}</div>
        <div class="conf-claim">${md(c.claim)}</div>
        ${c.anchorStep ? `<div class="conf-link dim mini">↪ proof in step ${c.anchorStep}</div>` : ''}
      </button>`;
    }).join('');
    grid.querySelectorAll('.conf-gauge').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = Number(btn.dataset.step);
        if (s) { active = s - 1; setMode('step'); }
      });
    });
  }

  // =====================================================================
  // TL;DR
  // =====================================================================
  function renderTldr() {
    document.getElementById('tldr').innerHTML = md(TLDR || '');
  }

  // =====================================================================
  // WHAT TO LOOK AT
  // =====================================================================
  function renderAttention() {
    if (!ATTENTION?.length) return;
    const ol = document.getElementById('attention-list');
    const totalSec = ATTENTION.reduce((acc, a) => {
      const m = a.timeBudget?.match(/(\d+)s/);
      return acc + (m ? Number(m[1]) : 0);
    }, 0);
    document.getElementById('total-time').textContent = `~${Math.ceil(totalSec / 60)} min total`;
    ol.innerHTML = ATTENTION.map(a => {
      const s = STEPS[a.stepN - 1];
      const pIcon =
        a.priority === 'high' ? '🔴' :
        a.priority === 'medium' ? '🟠' :
        a.priority === 'low' ? '🟢' : '⚪';
      return `<li class="att-item priority-${escapeHtml(a.priority)}" data-step="${a.stepN}">
        <div class="att-head">
          <span class="att-priority">${pIcon} ${escapeHtml(a.priority.toUpperCase())}</span>
          <span class="att-time dim mini">${escapeHtml(a.timeBudget || '')}</span>
          <span class="att-step-link">Step ${a.stepN}: ${escapeHtml(s.title)}</span>
        </div>
        <div class="att-claim">${md(a.claim)}</div>
      </li>`;
    }).join('');
    ol.querySelectorAll('.att-item').forEach(li => {
      li.addEventListener('click', () => { active = Number(li.dataset.step) - 1; setMode('step'); });
    });
  }

  // =====================================================================
  // DISQUALIFIERS
  // =====================================================================
  function renderDisqualifiers() {
    if (!DISQUALIFIERS?.length) return;
    document.getElementById('disq-count').textContent = `${DISQUALIFIERS.length} checks`;
    const ul = document.getElementById('disq-list');
    ul.innerHTML = DISQUALIFIERS.map(d => {
      const sevClass = `sev-${d.severity}`;
      const sevIcon = d.severity === 'block' ? '🛑' : d.severity === 'major' ? '⚠️' : '⚪';
      const verifyMark = d.agentVerified ? '<span class="verified" title="Agent confirmed this is NOT a problem">✓ agent verified</span>' : '<span class="unverified">? unverified — please check</span>';
      return `<li class="disq-item ${sevClass}">
        <div class="disq-head">
          <span class="disq-sev">${sevIcon} ${escapeHtml(d.severity.toUpperCase())}</span>
          ${verifyMark}
        </div>
        <div class="disq-text">${md(d.text)}</div>
        <div class="disq-check dim mini">↪ How to check: ${md(d.howToCheck)}</div>
      </li>`;
    }).join('');
  }

  // =====================================================================
  // FAQ
  // =====================================================================
  function renderFaq() {
    if (!FAQ?.length) return;
    document.getElementById('faq-count').textContent = `${FAQ.length} questions`;
    const list = document.getElementById('faq-list');
    list.innerHTML = FAQ.map((f, i) => `
      <details class="faq-item">
        <summary><span class="faq-q">${escapeHtml(f.q)}</span></summary>
        <div class="faq-a">${md(f.a)}</div>
        ${f.anchorStep ? `<button class="faq-anchor" data-step="${f.anchorStep}">↪ Jump to step ${f.anchorStep}</button>` : ''}
      </details>`).join('');
    list.querySelectorAll('.faq-anchor').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        active = Number(btn.dataset.step) - 1;
        setMode('step');
      });
    });
  }

  // =====================================================================
  // 6-BULLET SUMMARY
  // =====================================================================
  function renderSummary(target = '#bullets') {
    const ul = document.querySelector(target);
    ul.innerHTML = SUMMARY.map(b => {
      let cls = '';
      if (b.label === 'Risk') cls = 'risk';
      else if (/safe deployment|rollback/i.test(b.label)) cls = 'sdp';
      return `<li class="${cls}"><b>${b.label}</b>${md(b.text)}</li>`;
    }).join('');
  }

  // =====================================================================
  // ARCH + FILE TREE + STEP PREVIEW
  // =====================================================================
  async function renderArch(sel = '#arch', id = 'small') {
    const el = document.querySelector(sel);
    if (!ARCH) { if (el) el.hidden = true; return; }
    try {
      const { svg } = await mermaid.render(`arch-${id}-${Date.now()}`, ARCH);
      el.innerHTML = svg;
    } catch (err) {
      el.textContent = `mermaid render error: ${err.message}`;
    }
  }

  function renderFileTree() {
    if (!FILE_STATS?.length) {
      const el = document.getElementById('overview-file-count');
      if (el) el.textContent = STEPS?.length ?? '0';
      return;
    }
    document.getElementById('overview-file-count').textContent = FILE_STATS.length;
    const groups = [];
    const seenStep = new Set();
    for (const f of FILE_STATS) {
      const ownerIdx = f.stepIdx;
      if (ownerIdx == null) {
        const g = groups.find(g => g.kind === 'unassigned') || (groups.push({ kind: 'unassigned', files: [] }), groups[groups.length - 1]);
        g.files.push(f);
        continue;
      }
      if (seenStep.has(ownerIdx)) {
        const g = groups.find(g => g.stepIdx === ownerIdx);
        if (STEPS[ownerIdx].kind === 'batch') g.extraCount = (g.extraCount || 0) + 1;
        else g.files.push(f);
        continue;
      }
      seenStep.add(ownerIdx);
      groups.push({ kind: STEPS[ownerIdx].kind, stepIdx: ownerIdx, files: [f], extraCount: 0 });
    }
    const ul = document.getElementById('file-tree');
    // Only show the files assigned to a step at the top; unassigned at bottom collapsed
    const assigned = groups.filter(g => g.kind !== 'unassigned');
    const unassigned = groups.find(g => g.kind === 'unassigned');
    ul.innerHTML = assigned.map(g => {
      const s = STEPS[g.stepIdx];
      const main = g.files[0];
      const isBatch = s.kind === 'batch' && g.extraCount > 0;
      return `<li class="step-group">
        ${fileRowHtml(main)}
        ${isBatch ? `<div class="batch-mention">+ ${g.extraCount} more files in this batch</div>` : ''}
        <div class="file-steps">
          <button class="step-chip" data-i="${g.stepIdx}">
            <span class="num">${s.n}</span><span class="t">${escapeHtml(s.title)}</span>
          </button>
        </div>
      </li>`;
    }).join('') + (unassigned ? `
      <li class="step-group unassigned-block">
        <details>
          <summary class="dim mini">+ ${unassigned.files.length} other files (not in the narrative — view all)</summary>
          <ul>${unassigned.files.slice(0, 40).map(fileRowHtml).join('')}${unassigned.files.length > 40 ? `<li class="dim mini">… and ${unassigned.files.length - 40} more</li>` : ''}</ul>
        </details>
      </li>` : '');
    ul.querySelectorAll('.step-chip').forEach(btn => {
      btn.addEventListener('click', () => { active = Number(btn.dataset.i); setMode('step'); });
    });
  }
  function fileRowHtml(f) {
    const fileName = f.path.split('/').pop();
    const dirPath = f.path.slice(0, f.path.length - fileName.length - 1);
    return `<li><div class="file-row">
      <span class="file-icon">📄</span>
      <span class="file-path"><span class="dim">${escapeHtml(dirPath)}/</span><b>${escapeHtml(fileName)}</b></span>
      <span class="file-stats"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></span>
    </div></li>`;
  }

  // =====================================================================
  // STEP MODE
  // =====================================================================
  function renderStepList() {
    document.getElementById('step-total').textContent = STEPS.length;
    const ol = document.getElementById('steps');
    ol.innerHTML = STEPS.map((s, i) => {
      const fileName = s.file.split('/').pop();
      const qa = stepQuestions(i).length;
      const com = stepComments(i).length + drafts.filter(d => !d.sent && d.stepIdx === i).length;
      return `<li data-i="${i}" class="${i === active ? 'active' : ''}">
        <span class="step-num">${s.n}</span>
        <div class="step-card">
          <div class="t">${escapeHtml(s.title)}</div>
          <div class="sub">${escapeHtml(fileName)}${s.timeBudget ? ` · ${escapeHtml(s.timeBudget)}` : ''}</div>
          ${qa + com > 0 ? `<div class="badges">
            ${qa ? `<span class="badge qa">${qa} Q&amp;A</span>` : ''}
            ${com ? `<span class="badge com">${com} comment${com === 1 ? '' : 's'}</span>` : ''}
          </div>` : ''}
        </div>
      </li>`;
    }).join('');
    ol.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => setActive(Number(li.dataset.i)));
    });
  }

  function renderStepHead() {
    const s = STEPS[active];
    document.getElementById('active-n').textContent = s.n;
    document.getElementById('active-file').textContent = s.file;
    document.getElementById('active-time').textContent = s.timeBudget ? `${s.timeBudget} read` : '';
    document.getElementById('active-why').innerHTML = md(s.why);
    document.getElementById('step-progress').textContent = active + 1;
    const stripCount = document.getElementById('strip-steps-count');
    if (stripCount) stripCount.textContent = `${active + 1}/${STEPS.length}`;
    document.getElementById('prev-step').disabled = active === 0;
    document.getElementById('next-step').disabled = active === STEPS.length - 1;
  }

  async function renderStepDiagram() {
    const wrap = document.getElementById('step-diagram-wrap');
    const el = document.getElementById('step-diagram');
    const s = STEPS[active];
    if (!s.diagram) { wrap.hidden = true; el.innerHTML = ''; return; }
    wrap.hidden = false;
    try {
      const { svg } = await mermaid.render(`step-${active}-${Date.now()}`, s.diagram);
      el.innerHTML = `<div class="step-diagram-inner">${svg}</div>`;
    } catch (err) {
      el.innerHTML = `<div class="step-diagram-error">mermaid: ${err.message}</div>`;
    }
  }

  // Render the active step's diagram as raw svg into an arbitrary container
  // (e.g. the zoom modal's #arch-big) so pan/zoom transforms target the svg.
  async function renderStepDiagramInto(sel) {
    const el = document.querySelector(sel);
    if (!el) return;
    const s = STEPS[active];
    if (!s.diagram) { el.innerHTML = ''; return; }
    try {
      const { svg } = await mermaid.render(`stepbig-${active}-${Date.now()}`, s.diagram);
      el.innerHTML = svg;
    } catch (err) {
      el.textContent = `mermaid: ${err.message}`;
    }
  }

  // =====================================================================
  // DIFF — fetch + parse + render
  // =====================================================================
  async function renderDiff() {
    const s = STEPS[active];
    const host = document.getElementById('diff-host');
    host.innerHTML = '<div class="diff-loading">Loading diff…</div>';

    const fileHeader = document.createElement('div');
    fileHeader.className = 'diff-file-header';
    const kindBadge = s.isNewFile
      ? '<span class="kind-badge new-file">NEW FILE</span>'
      : s.kind === 'batch'
        ? `<span class="kind-badge batch">BATCH · ${(s.relatedFiles || []).length} files</span>`
        : '';
    fileHeader.innerHTML = `
      <span class="dfh-icon">📄</span>
      <span class="dfh-path">${escapeHtml(s.file)}</span>
      ${kindBadge}
      <span class="dfh-spacer"></span>
      <button class="ghost-mini" data-act="copy-path" title="Copy path">⧉</button>`;
    fileHeader.querySelector('[data-act="copy-path"]').addEventListener('click', () => {
      navigator.clipboard.writeText(s.file).then(() => toast('Path copied'));
    });
    host.innerHTML = '';
    host.appendChild(fileHeader);

    if (s.kind === 'batch' && s.relatedFiles?.length > 1) {
      const batchInfo = document.createElement('div');
      batchInfo.className = 'batch-info';
      const visible = s.relatedFiles.slice(0, 10);
      const more = s.relatedFiles.length - visible.length;
      batchInfo.innerHTML = `
        <div class="batch-note"><b>${s.relatedFiles.length} files</b> received textually identical edits. Representative below:</div>
        <ul class="batch-files">
          ${visible.map(f => `<li>${escapeHtml(f)}</li>`).join('')}
          ${more > 0 ? `<li class="batch-more">… and ${more} more</li>` : ''}
        </ul>`;
      host.appendChild(batchInfo);
    }

    let hunks;
    try {
      const patch = await fetchArtifact(s.diffUrl);
      hunks = parseUnifiedPatch(patch);
    } catch (err) {
      host.appendChild(Object.assign(document.createElement('div'),
        { className: 'diff-loading', textContent: `Diff load failed: ${err.message}` }));
      return;
    }

    const diffEl = document.createElement('div');
    diffEl.className = `diff-body lang-${s.fileLang}`;
    diffEl.innerHTML = renderHunks(hunks, s.fileLang, active);
    host.appendChild(diffEl);

    if (s.focusNewLine) {
      requestAnimationFrame(() => {
        const target = diffEl.querySelector(`.diff-line[data-new-line="${s.focusNewLine}"]`);
        if (target) target.scrollIntoView({ block: 'center', behavior: 'auto' });
      });
    }

    diffEl.querySelectorAll('.line-comment-btn').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const row = btn.closest('.diff-line');
        const side = row.dataset.side;
        const line = Number(row.dataset.newLine || row.dataset.oldLine);
        openLineComposer(active, line, side);
      });
    });
  }

  function parseUnifiedPatch(patch) {
    const lines = String(patch).split(/\r?\n/);
    const hunks = [];
    let i = 0;
    while (i < lines.length && !lines[i].startsWith('@@')) i++;
    while (i < lines.length) {
      const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) { i++; continue; }
      const oldStart = Number(m[1]); const oldLen = m[2] ? Number(m[2]) : 1;
      const newStart = Number(m[3]); const newLen = m[4] ? Number(m[4]) : 1;
      i++;
      const rows = [];
      let oldLine = oldStart, newLine = newStart;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
        const line = lines[i]; i++;
        if (line.startsWith('+') && !line.startsWith('+++')) { rows.push({ type: 'add', newLine, content: line.slice(1) }); newLine++; }
        else if (line.startsWith('-') && !line.startsWith('---')) { rows.push({ type: 'del', oldLine, content: line.slice(1) }); oldLine++; }
        else if (line.startsWith(' ')) { rows.push({ type: 'ctx', oldLine, newLine, content: line.slice(1) }); oldLine++; newLine++; }
      }
      hunks.push({ oldStart, oldLen, newStart, newLen, rows });
    }
    return hunks;
  }

  function renderHunks(hunks, lang, stepIdx) {
    if (!hunks.length) return '<div class="diff-loading">No diff hunks.</div>';
    const out = [];
    for (let hi = 0; hi < hunks.length; hi++) {
      const h = hunks[hi];
      if (hi > 0 || h.oldStart > 1) {
        out.push(`<div class="hunk-header">@@ −${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@</div>`);
      }
      const paired = pairDelAdd(h.rows);
      for (const item of paired) {
        if (item.kind === 'single') out.push(renderRow({ ...item.row, lang, stepIdx }));
        else {
          const max = Math.max(item.dels.length, item.adds.length);
          for (let k = 0; k < max; k++) {
            const d = item.dels[k]; const a = item.adds[k];
            if (d && a) {
              const { delHtml } = computeWordDiff(d.content, a.content);
              out.push(renderRow({ type: 'del', oldLine: d.oldLine, content: d.content, contentHtml: delHtml, lang, stepIdx }));
            } else if (d) out.push(renderRow({ ...d, lang, stepIdx }));
          }
          for (let k = 0; k < max; k++) {
            const d = item.dels[k]; const a = item.adds[k];
            if (d && a) {
              const { addHtml } = computeWordDiff(d.content, a.content);
              out.push(renderRow({ type: 'add', newLine: a.newLine, content: a.content, contentHtml: addHtml, lang, stepIdx }));
            } else if (a) out.push(renderRow({ ...a, lang, stepIdx }));
          }
        }
      }
    }
    return out.join('');
  }

  function pairDelAdd(rows) {
    const out = []; let i = 0;
    while (i < rows.length) {
      if (rows[i].type === 'del') {
        const dels = []; while (i < rows.length && rows[i].type === 'del') { dels.push(rows[i]); i++; }
        const adds = []; while (i < rows.length && rows[i].type === 'add') { adds.push(rows[i]); i++; }
        if (adds.length) out.push({ kind: 'pair', dels, adds });
        else for (const d of dels) out.push({ kind: 'single', row: d });
      } else { out.push({ kind: 'single', row: rows[i] }); i++; }
    }
    return out;
  }

  function computeWordDiff(oldText, newText) {
    const tokenize = s => s.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) || [];
    const ops = lcsDiff(tokenize(oldText), tokenize(newText));
    const del = [], add = [];
    for (const op of ops) {
      if (op.type === 'eq') { del.push(escapeHtml(op.value)); add.push(escapeHtml(op.value)); }
      else if (op.type === 'del') del.push(`<span class="word-del">${escapeHtml(op.value)}</span>`);
      else if (op.type === 'add') add.push(`<span class="word-add">${escapeHtml(op.value)}</span>`);
    }
    return { delHtml: del.join(''), addHtml: add.join('') };
  }
  function lcsDiff(a, b) {
    const m = a.length, n = b.length;
    const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { out.push({ type: 'eq', value: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', value: a[i] }); i++; }
      else { out.push({ type: 'add', value: b[j] }); j++; }
    }
    while (i < m) out.push({ type: 'del', value: a[i++] });
    while (j < n) out.push({ type: 'add', value: b[j++] });
    return out;
  }

  function renderRow({ type, oldLine, newLine, content, contentHtml, lang, stepIdx }) {
    const oldCol = oldLine ?? ''; const newCol = newLine ?? '';
    const sign = type === 'add' ? '+' : type === 'del' ? '−' : ' ';
    const anchorLine = newLine ?? oldLine;
    const hasComment = drafts.some(d => d.stepIdx === stepIdx && d.line === anchorLine && d.side === type)
      || stepComments(stepIdx).some(e => e.anchor && e.anchor.line === anchorLine && e.anchor.side === type);
    let body;
    if (contentHtml != null) body = contentHtml || '&nbsp;';
    else if (!content) body = '&nbsp;';
    else { try { body = hljs.highlight(content, { language: lang, ignoreIllegals: true }).value; } catch { body = escapeHtml(content); } }
    return `<div class="diff-line ${type} ${hasComment ? 'commented' : ''}"
      data-side="${type}" data-old-line="${oldLine ?? ''}" data-new-line="${newLine ?? ''}">
      <button class="line-comment-btn" title="Comment on this line">💬</button>
      <span class="ln-old">${oldCol}</span>
      <span class="ln-new">${newCol}</span>
      <span class="sign">${sign}</span>
      <span class="content">${body}</span>
    </div>`;
  }

  // =====================================================================
  // Q&A / COMMENTS
  // =====================================================================
  // Entries in a step's thread are either questions (Q&A tab) or line-anchored
  // comments (Comments tab). Both persist in the SAME qa-store thread and are
  // answered by the agent via the same pr-walkthrough.answer tool; we just
  // split them by `kind` for rendering.
  function stepQuestions(i) { return (qaThreads[i] || []).filter(e => e.kind !== 'comment'); }
  function stepComments(i) { return (qaThreads[i] || []).filter(e => e.kind === 'comment'); }

  function qaBubbleHtml(qa) {
    return `
      <div class="qa-bubble q"><div class="who">You <span class="ts">${qa.askedAt || ''}</span></div><div>${escapeHtml(qa.q)}</div></div>
      ${qa.a ? `<div class="qa-bubble a"><div class="who">Agent <span class="ts">${qa.ts || ''}</span></div><div>${md(qa.a)}</div></div>`
              : `<div class="qa-bubble pending">Agent is thinking</div>`}`;
  }

  function renderQA() {
    const s = STEPS[active];
    document.getElementById('qa-step-label').textContent = `step ${s.n}: ${truncate(s.title, 36)}`;
    const thread = document.getElementById('qa-thread');

    if (qaScope === 'all') {
      // Aggregate questions across every step, grouped with a clickable header.
      const groups = STEPS.map((st, i) => ({ st, i, items: stepQuestions(i) })).filter(g => g.items.length);
      const total = groups.reduce((n, g) => n + g.items.length, 0);
      document.getElementById('qa-count').textContent = total;
      document.getElementById('strip-qa-count').textContent = total;
      if (!total) {
        thread.innerHTML = `<div class="qa-empty"><div class="ic">🤔</div><div>No questions yet on any step.</div>
          <div class="mini" style="margin-top:4px;">Ask anything — the agent has full PR context.</div></div>`;
        return;
      }
      thread.innerHTML = groups.map(g => `
        <button type="button" class="qa-group-head${g.i === active ? ' current' : ''}" data-step-idx="${g.i}" title="Jump to step ${g.st.n}">
          <span class="qa-group-n">Step ${g.st.n}</span>
          <span class="qa-group-t">${escapeHtml(truncate(g.st.title, 32))}</span>
          <span class="qa-group-c">${g.items.length}</span>
        </button>
        ${g.items.map(qaBubbleHtml).join('')}`).join('');
      thread.scrollTop = 0;
      return;
    }

    // scope === 'step' — active step only.
    const items = stepQuestions(active);
    document.getElementById('qa-count').textContent = items.length;
    document.getElementById('strip-qa-count').textContent = items.length;
    if (!items.length) {
      thread.innerHTML = `<div class="qa-empty"><div class="ic">🤔</div><div>No questions yet on this step.</div>
        <div class="mini" style="margin-top:4px;">Ask anything — the agent has full PR context.</div></div>`;
      return;
    }
    thread.innerHTML = items.map(qaBubbleHtml).join('');
    thread.scrollTop = thread.scrollHeight;
  }

  function bindQA() {
    const submit = () => {
      const ta = document.getElementById('qa-input');
      const q = ta.value.trim(); if (!q) return;
      ta.value = '';
      submitQuestion(q).catch(err => {
        console.warn('[pr-walkthrough] submitQuestion failed:', err);
        toast(`Failed to send: ${err?.message ?? err}`);
      });
    };
    // Send via a BUTTON CLICK, not a native <form> submit. The artifact renders
    // inside a sandboxed iframe in the SPA; without `allow-forms` the browser
    // SILENTLY BLOCKS form submission ("Blocked form submission … the
    // 'allow-forms' permission is not set"), so the old submit handler never
    // fired and "Ask" did nothing. A button click is never sandbox-blocked, so
    // Q&A send now works in every embedding regardless of the iframe sandbox.
    document.getElementById('qa-send')?.addEventListener('click', submit);
    // Ctrl/Cmd+Enter also sends (plain Enter stays a newline in the textarea).
    document.getElementById('qa-input')?.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
    // Harmless fallback for non-sandboxed embeddings that still submit natively.
    document.getElementById('qa-form')?.addEventListener('submit', (ev) => { ev.preventDefault(); submit(); });

    // Scope toggle: "This step" vs "All steps".
    document.getElementById('qa-scope')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.qa-scope-btn');
      if (!btn) return;
      const scope = btn.dataset.scope;
      if (scope === qaScope) return;
      qaScope = scope;
      document.querySelectorAll('#qa-scope .qa-scope-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderQA();
      // "All steps" needs every step's thread loaded (they're otherwise lazy).
      if (scope === 'all') {
        loadAllQaThreads().then(() => {
          if (qaScope === 'all') renderQA();
          renderStepList();
        });
      }
    });
    // In "All steps" view, clicking a step-group header jumps to that step
    // (and switches back to per-step scope).
    document.getElementById('qa-thread')?.addEventListener('click', (ev) => {
      const head = ev.target.closest('.qa-group-head');
      if (!head) return;
      const i = Number(head.dataset.stepIdx);
      if (!Number.isNaN(i)) {
        qaScope = 'step';
        document.querySelectorAll('#qa-scope .qa-scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope === 'step'));
        if (mode !== 'step') setMode('step');
        setActive(i);
      }
    });
  }

  async function submitQuestion(text) {
    const s = STEPS[active];
    const url = `/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${s.n}.json`;

    // 1. Persist the question (server-side store).
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      toast(`Failed to send: HTTP ${res.status}`);
      return;
    }
    const entry = await res.json();

    // 2. Update local thread + render the pending bubble.
    qaThreads[active].push(entry);
    renderQA();
    renderStepList();
    toast('Sent to agent →');

    // 3. Dispatch the structured prompt to the agent. Resolve the session
    //    via the existing /artifact/<id>/session endpoint (same pattern
    //    _comment-overlay.mjs uses).
    const dispatched = await dispatchQaToAgent(entry, s);

    // 4. Begin polling for the answer (only if the dispatch was actually
    //    accepted — otherwise there's nothing to wait for).
    if (dispatched) pollForAnswer(s.n, entry.id);
  }

  async function dispatchQaToAgent(entry, step) {
    const prompt = buildQaPrompt(entry, step);
    try {
      // Scoped, share-safe dispatch: the server enqueues to this artifact's
      // durable outbox and delivers asynchronously (dispatch if live, resume
      // if asleep), retrying on failure. A 202 means "durably queued". A non-
      // 2xx is a permanent error (unknown artifact / no bound session) — the
      // message will NEVER be delivered, so surface it instead of pretending
      // it was sent.
      const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.warn('[pr-walkthrough] dispatch rejected:', r.status, txt);
        toast(`Couldn't reach the agent (HTTP ${r.status}). Your question is saved — reload to retry.`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[pr-walkthrough] dispatch failed:', err);
      toast(`Couldn't reach the agent: ${err?.message ?? err}. Your question is saved — reload to retry.`);
      return false;
    }
  }

  function buildQaPrompt(entry, step) {
    return [
      `Question on step ${step.n} of artifact ${ctx.artifactId}`,
      `File: ${step.file}`,
      step.focusNewLine ? `Focus: L${step.focusNewLine}` : '',
      '',
      `Question (id: ${entry.id}):`,
      `> ${entry.q}`,
      '',
      `When you have an answer, call \`pr-walkthrough.answer\` MCP tool:`,
      `  artifact_id="${ctx.artifactId}", step_n=${step.n}, question_id="${entry.id}", text="<your answer>"`,
    ].filter(Boolean).join('\n');
  }

  function pollForAnswer(stepN, questionId, attempts = 0) {
    // 60 attempts × 3s = 3 min max poll window
    if (attempts >= 60) return;
    setTimeout(async () => {
      try {
        const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${stepN}.json`);
        if (r.ok) {
          const thread = await r.json();
          const matched = thread.find(e => e.id === questionId);
          if (matched?.a) {
            // Replace this step's local thread with the authoritative server thread
            // (keeps any other entries that landed via different clients)
            const stepIdx = STEPS.findIndex(x => x.n === stepN);
            if (stepIdx >= 0) {
              qaThreads[stepIdx] = thread;
              if (active === stepIdx) { renderQA(); renderComments(); }
              renderStepList();
            }
            return;
          }
        }
      } catch { /* network blip — try again */ }
      pollForAnswer(stepN, questionId, attempts + 1);
    }, 3000);
  }

  function pendingCommentCount() {
    const committed = drafts.filter(d => !d.sent && d.stepIdx === active).length;
    let openWithText = 0;
    document.querySelectorAll('#comments-thread .composer').forEach(c => {
      const ta = c.querySelector('textarea');
      // Composers that edit an already-committed draft are counted above; only
      // count brand-new composers so we don't double-count.
      const isEdit = drafts.some(d => d.id === c.dataset.id);
      if (ta && ta.value.trim() && !isEdit) openWithText++;
    });
    return committed + openWithText;
  }

  function refreshSendBtn() {
    const n = pendingCommentCount();
    const sendBtn = document.getElementById('send-comments');
    if (!sendBtn) return;
    sendBtn.disabled = n === 0;
    sendBtn.textContent = `Send ${n} comment(s) to agent`;
  }

  function renderComments() {
    const persisted = stepComments(active);            // saved to the artifact (+ agent replies)
    const unsent = drafts.filter(d => !d.sent && d.stepIdx === active); // local, still composing
    const total = persisted.length + unsent.length;
    document.getElementById('comments-count').textContent = total;
    document.getElementById('strip-com-count').textContent = total;
    refreshSendBtn();
    const thread = document.getElementById('comments-thread');
    if (!total) {
      thread.innerHTML = `<div class="comments-empty"><div>No comments on this step.</div>
        <div class="mini" style="margin-top:4px;">Click 💬 in the diff gutter to add one.</div></div>`;
      return;
    }
    const anchorHtml = (file, line, side) => {
      const name = (file || '').split('/').pop() || '';
      const sideCls = side || 'ctx';
      const sign = side === 'add' ? '+' : side === 'del' ? '−' : ' ';
      return `<div class="anchor">${escapeHtml(name)}${line ? ':L' + line : ''}
        <span class="side ${sideCls}">${sign}</span></div>`;
    };
    // Persisted comments — saved to the artifact and pushed to every client,
    // with the agent's threaded reply shown once it lands (same answer path
    // as Q&A).
    const persistedHtml = persisted.map(e => {
      const a = e.anchor || {};
      return `<div class="comment-card sent" data-id="${e.id}">
        ${anchorHtml(a.file || STEPS[active].file, a.line, a.side)}
        <div class="body">${escapeHtml(e.q)}</div>
        ${e.a
          ? `<div class="comment-reply"><div class="who">Agent <span class="ts">${e.ts || ''}</span></div><div class="reply-body">${md(e.a)}</div></div>`
          : `<div class="comment-reply pending">Agent is thinking…</div>`}
      </div>`;
    }).join('');
    // Local unsent drafts — editable/deletable until Send persists them.
    const draftHtml = unsent.map(d => `
      <div class="comment-card" data-id="${d.id}">
        ${anchorHtml(STEPS[d.stepIdx].file, d.line, d.side)}
        <div class="body">${escapeHtml(d.text)}</div>
        <div class="actions">
          <button class="edit" data-act="edit">edit</button>
          <button class="del" data-act="del">delete</button></div>
      </div>`).join('');
    thread.innerHTML = persistedHtml + draftHtml;
    thread.querySelectorAll('.comment-card .actions button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.comment-card');
        const id = card.dataset.id; const d = drafts.find(x => x.id === id); if (!d) return;
        if (btn.dataset.act === 'del') drafts = drafts.filter(x => x.id !== id);
        else if (btn.dataset.act === 'edit') openLineComposer(d.stepIdx, d.line, d.side, d);
        renderComments(); renderDiff(); renderStepList();
      });
    });
  }

  function buildCommentsPrompt(entries, step) {
    const lines = [
      `${entries.length} inline review comment(s) on step ${step.n} of artifact ${ctx.artifactId} (file ${step.file}):`,
      '',
    ];
    for (const e of entries) {
      const a = e.anchor || {};
      const where = `${a.file || step.file}${a.line ? ':L' + a.line : ''}`;
      lines.push(`• Comment (id: ${e.id}) on ${where}:`);
      lines.push(`  > ${e.q}`);
      lines.push('');
    }
    lines.push('Reply to EACH comment by calling the `pr-walkthrough.answer` MCP tool:');
    lines.push(`  artifact_id="${ctx.artifactId}", step_n=${step.n}, question_id="<the comment id above>", text="<your reply>"`);
    lines.push("Address the reviewer's point directly; cite files + line ranges where relevant.");
    return lines.join('\n');
  }

  function bindComments() {
    document.getElementById('send-comments').addEventListener('click', () => { void sendComments(); });
    document.querySelectorAll('.rail-tabs .tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        document.querySelectorAll('.rail-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('[data-tab-body]').forEach(b => b.classList.toggle('hidden', b.dataset.tabBody !== activeTab));
      });
    });
  }

  async function sendComments() {
    // Commit any open composer(s) that have text first, so "type a comment
    // and press Send" works without a separate Add click.
    document.querySelectorAll('#comments-thread .composer').forEach(c => {
      const ta = c.querySelector('textarea');
      if (ta && ta.value.trim()) c.querySelector('[data-act="save"]')?.click();
    });
    const unsent = drafts.filter(d => !d.sent && d.stepIdx === active);
    if (!unsent.length) { toast('Add a comment first (💬 in the diff), then Send.'); return; }
    const s = STEPS[active];
    const url = `/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${s.n}.json`;

    // 1. PERSIST each comment to the artifact's store. Comments are artifact
    //    data — they survive reload and are pushed to every connected client
    //    via SSE, exactly like Q&A. Each becomes a line-anchored entry the
    //    agent replies to with the same pr-walkthrough.answer tool.
    const saved = [];
    for (const d of unsent) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: d.text,
            kind: 'comment',
            anchor: { file: STEPS[d.stepIdx].file, line: d.line, side: d.side },
          }),
        });
        if (res.ok) {
          const entry = await res.json();
          qaThreads[active].push(entry);
          drafts = drafts.filter(x => x.id !== d.id); // draft is persisted now
          saved.push(entry);
        }
      } catch { /* keep the draft so the user can retry */ }
    }
    renderComments(); renderDiff(); renderStepList();
    if (!saved.length) { toast("Couldn't save comments — check your connection and try again."); return; }
    toast(`Saved ${saved.length} comment(s) → asking the agent`);

    // 2. DISPATCH to the agent via the durable outbox (resumes a closed
    //    session, retries on failure). Fire-and-forget — the comment is
    //    already saved; the agent's reply lands back in the same store and
    //    shows inline under the comment.
    const prompt = buildCommentsPrompt(saved, s);
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        toast(`Saved, but couldn't reach the agent (HTTP ${r.status} ${txt.slice(0, 80)}).`);
      }
    } catch (err) {
      toast(`Saved, but couldn't reach the agent: ${err?.message ?? err}.`);
    }

    // 3. Poll for the agent's reply on each saved comment (same as Q&A).
    saved.forEach(e => pollForAnswer(s.n, e.id));
  }

  function openLineComposer(stepIdx, line, side, existing = null) {
    if (railCollapsed) toggleRail(false);
    document.querySelector('.rail-tabs .tab[data-tab="comments"]').click();
    const thread = document.getElementById('comments-thread');
    const compId = existing?.id ?? mintId();
    const composer = document.createElement('div');
    composer.className = 'composer'; composer.dataset.id = compId;
    composer.innerHTML = `
      <div class="anchor">${escapeHtml(STEPS[stepIdx].file.split('/').pop())}:L${line}
        <span class="side ${side}">${side === 'add' ? '+' : side === 'del' ? '−' : ' '}</span></div>
      <textarea placeholder="Leave a comment for the agent…">${existing ? escapeHtml(existing.text) : ''}</textarea>
      <div class="row">
        <button class="ghost" data-act="cancel">Cancel</button>
        <button class="primary" data-act="save">${existing ? 'Update' : 'Add'}</button>
      </div>`;
    thread.insertBefore(composer, thread.firstChild);
    const ta = composer.querySelector('textarea');
    ta.focus();
    ta.addEventListener('input', refreshSendBtn);
    composer.querySelector('[data-act="cancel"]').addEventListener('click', () => { composer.remove(); refreshSendBtn(); });
    refreshSendBtn();
    composer.querySelector('[data-act="save"]').addEventListener('click', () => {
      const text = composer.querySelector('textarea').value.trim(); if (!text) return;
      if (existing) existing.text = text;
      else drafts.push({ id: compId, stepIdx, line, side, text, sent: false });
      composer.remove();
      renderComments(); renderDiff(); renderStepList();
      toast(existing ? 'Comment updated' : 'Comment added (unsent)');
    });
  }

  // =====================================================================
  // COLLAPSIBLE RAIL
  // =====================================================================
  function toggleRail(force) {
    railCollapsed = force === undefined ? !railCollapsed : !!force;
    const row = document.getElementById('content-row');
    const rail = document.getElementById('right-rail');
    const strip = document.getElementById('rail-collapsed-strip');
    if (railCollapsed) {
      if (row) row.classList.add('rail-collapsed');
      rail.hidden = true;
      strip.hidden = false;
    } else {
      if (row) row.classList.remove('rail-collapsed');
      rail.hidden = false;
      strip.hidden = true;
    }
  }
  function bindRailCollapse() {
    document.getElementById('rail-collapse').addEventListener('click', () => toggleRail(true));
    document.getElementById('rail-collapsed-strip').addEventListener('click', () => toggleRail(false));
  }

  // Drag-to-resize the right rail. Width lives in a CSS var on the rail element
  // (which `.right { flex-basis: var(--rail-width) }` reads) and persists in
  // localStorage, shared across walkthroughs. Double-click the handle resets.
  function bindRailResize() {
    const handle = document.getElementById('rail-resize');
    const rail = document.getElementById('right-rail');
    if (!handle || !rail) return;
    const KEY = 'cdb:pr-rail-width';
    const DEFAULT = 380;
    const clamp = (w) => {
      const max = Math.max(320, Math.round(window.innerWidth * 0.7));
      return Math.min(Math.max(Math.round(w), 280), max);
    };
    const apply = (w) => rail.style.setProperty('--rail-width', clamp(w) + 'px');
    // The rail is pinned to the right and its right edge stays fixed during a
    // drag (only the left edge moves), so its width is the distance from the
    // cursor to the rail's own right edge.
    const widthFor = (e) => clamp(rail.getBoundingClientRect().right - e.clientX);
    try {
      const saved = parseInt(localStorage.getItem(KEY) || '', 10);
      if (Number.isFinite(saved)) apply(saved);
    } catch { /* localStorage blocked */ }
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (railCollapsed) return;
      dragging = true;
      document.body.classList.add('rail-resizing');
      try { handle.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (dragging) apply(widthFor(e)); });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('rail-resizing');
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      try { localStorage.setItem(KEY, String(widthFor(e))); } catch { /* ignore */ }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('dblclick', () => {
      rail.style.setProperty('--rail-width', DEFAULT + 'px');
      try { localStorage.setItem(KEY, String(DEFAULT)); } catch { /* ignore */ }
    });
  }

  // Collapse the left Steps column (mirrors the rail collapse) to give the
  // diff more horizontal room. Collapsed state persists across step nav
  // because it lives on the stable #step-grid / .left containers.
  function toggleSteps(force) {
    stepsCollapsed = force === undefined ? !stepsCollapsed : !!force;
    const grid = document.getElementById('step-grid');
    const left = document.getElementById('steps-left');
    const strip = document.getElementById('steps-collapsed-strip');
    if (stepsCollapsed) {
      grid.classList.add('steps-collapsed');
      left.hidden = true;
      strip.hidden = false;
    } else {
      grid.classList.remove('steps-collapsed');
      left.hidden = false;
      strip.hidden = true;
    }
  }

  // Collapse the per-step "why" description to give the diff more vertical room.
  function toggleWhy(force) {
    whyCollapsed = force === undefined ? !whyCollapsed : !!force;
    const pane = document.getElementById('diff-pane');
    if (pane) pane.classList.toggle('why-collapsed', whyCollapsed);
    const btn = document.getElementById('toggle-why');
    if (btn) btn.title = whyCollapsed
      ? 'Show the description & diagram'
      : 'Collapse the description & diagram for more diff space';
  }

  function bindSideCollapse() {
    document.getElementById('steps-collapse').addEventListener('click', () => toggleSteps(true));
    document.getElementById('steps-collapsed-strip').addEventListener('click', () => toggleSteps(false));
    document.getElementById('toggle-why').addEventListener('click', () => toggleWhy());
  }

  // =====================================================================
  // MODE TOGGLE + NAV
  // =====================================================================
  // Load the Q&A thread for `stepIdx` from the server into qaThreads[stepIdx].
  // Best-effort: if the request fails, leave whatever's in local state alone.
  async function loadQaThreadForActive() {
    const s = STEPS[active];
    if (!s) return;
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${s.n}.json`);
      if (r.ok) {
        const thread = await r.json();
        if (Array.isArray(thread)) qaThreads[active] = thread;
      }
    } catch { /* network blip — ignore */ }
  }

  // Load EVERY step's Q&A thread (in parallel) — needed for the "All steps"
  // Q&A view, since threads are otherwise loaded lazily per active step.
  // Also makes the step-list Q&A badges accurate for unvisited steps.
  async function loadAllQaThreads() {
    await Promise.all(STEPS.map(async (s, i) => {
      try {
        const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${s.n}.json`);
        if (r.ok) {
          const thread = await r.json();
          if (Array.isArray(thread)) qaThreads[i] = thread;
        }
      } catch { /* network blip — ignore this step */ }
    }));
  }

  // ---- Cross-client Q&A sync ------------------------------------------------
  // Continuously poll the ACTIVE step's Q&A thread so questions + answers asked
  // from ANOTHER browser / machine / the shared URL show up here without a
  // reload. Only re-renders when the thread actually changed (no scroll jank
  // or needless DOM churn on unchanged polls). Reads the live `active`/`mode`
  // so it follows step navigation automatically. Reuses GET
  // /artifact/<id>/qa/step-N.json, which is allow-listed on the share tunnel.
  let _qaSyncTimer = null;
  let _qaEventSource = null;
  function _qaThreadsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i]?.id !== b[i]?.id || a[i]?.q !== b[i]?.q || a[i]?.a !== b[i]?.a) return false;
    }
    return true;
  }
  async function syncActiveQaThread() {
    if (mode !== 'step') return;
    const s = STEPS[active];
    if (!s) return;
    try {
      const r = await fetch(`/artifact/${encodeURIComponent(ctx.artifactId)}/qa/step-${s.n}.json`);
      if (!r.ok) return;
      const thread = await r.json();
      if (Array.isArray(thread) && !_qaThreadsEqual(thread, qaThreads[active])) {
        qaThreads[active] = thread;
        renderQA();
        renderComments();
        renderStepList();
      }
    } catch { /* network blip — ignore */ }
  }
  function startQaSync() {
    // Primary: Server-Sent Events. The server pushes a `qa` event whenever a
    // question/answer is appended to this artifact (from any browser, machine,
    // or the shared URL); we re-read the active step thread on notify. The
    // stream endpoint is allow-listed on the share tunnel too. EventSource
    // reconnects on its own (honouring the server's `retry:`).
    try {
      _qaEventSource = new EventSource(`/artifact/${encodeURIComponent(ctx.artifactId)}/qa/events`);
      _qaEventSource.addEventListener('qa', () => { void syncActiveQaThread(); });
      // On (re)connect, do an immediate catch-up in case we missed events
      // while disconnected.
      _qaEventSource.addEventListener('open', () => { void syncActiveQaThread(); });
    } catch { _qaEventSource = null; }

    // Fallback safety net: a slow poll covers environments where a proxy
    // buffers/blocks SSE, plus an immediate catch-up when the tab refocuses.
    if (!_qaSyncTimer) {
      _qaSyncTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void syncActiveQaThread();
      }, 20000);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void syncActiveQaThread();
    });
  }

  async function setMode(m) {
    mode = m;
    document.getElementById('overview').classList.toggle('hidden', m !== 'overview');
    document.getElementById('stepmode').classList.toggle('hidden', m !== 'step');
    document.getElementById('mode-label').textContent = m === 'overview' ? 'Overview' : `Step ${active + 1}/${STEPS.length}`;
    if (m === 'step') {
      renderStepList(); renderStepHead(); renderComments();
      renderSummary('#bullets-compact');
      await loadQaThreadForActive();
      renderQA();
      renderComments();
      await renderStepDiagram();
      await renderDiff();
    } else {
      renderArch();
      // The Q&A / Comments rail is persistent (visible in overview too) —
      // populate it with the active step's threads.
      await loadQaThreadForActive();
      renderQA();
      renderComments();
    }
  }
  async function setActive(i) {
    active = Math.max(0, Math.min(STEPS.length - 1, i));
    renderStepList(); renderStepHead(); renderComments();
    document.getElementById('mode-label').textContent = `Step ${active + 1}/${STEPS.length}`;
    await loadQaThreadForActive();
    renderQA();
    renderComments();
    await renderStepDiagram();
    await renderDiff();
  }
  function bindNav() {
    document.getElementById('prev-step').addEventListener('click', () => setActive(active - 1));
    document.getElementById('next-step').addEventListener('click', () => setActive(active + 1));
    document.getElementById('back-overview').addEventListener('click', () => setMode('overview'));
    document.getElementById('enter-stepmode').addEventListener('click', () => { active = 0; setMode('step'); });
    window.addEventListener('keydown', ev => {
      if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'INPUT') return;
      if (mode !== 'step') return;
      if (ev.key === 'j' || ev.key === 'ArrowDown') setActive(active + 1);
      else if (ev.key === 'k' || ev.key === 'ArrowUp') setActive(active - 1);
      else if (ev.key === 'o') setMode('overview');
      else if (ev.key === '[' || ev.key === ']') toggleRail();
      else if (ev.key === 's') toggleSteps();
      else if (ev.key === 'w') toggleWhy();
    });
  }
  function bindArchZoom() {
    let scale = 1, panX = 0, panY = 0;
    let dragging = false, lastX = 0, lastY = 0;
    const container = document.getElementById('arch-big');
    const label = document.getElementById('zoom-label');

    function applyTransform() {
      const svg = container.querySelector('svg');
      if (svg) svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      label.textContent = `${Math.round(scale * 100)}%`;
    }
    function resetZoom() {
      scale = 1; panX = 0; panY = 0;
      applyTransform();
    }
    function zoom(delta, cx, cy) {
      const prev = scale;
      scale = Math.min(10, Math.max(0.1, scale + delta));
      // Zoom toward cursor position
      const ratio = scale / prev;
      panX = cx - ratio * (cx - panX);
      panY = cy - ratio * (cy - panY);
      applyTransform();
    }

    const setModalTitle = (t) => { const el = document.getElementById('arch-modal-title'); if (el) el.textContent = t; };
    document.getElementById('zoom-arch').addEventListener('click', async () => {
      setModalTitle('Architecture');
      document.getElementById('arch-modal').hidden = false;
      await renderArch('#arch-big', 'big');
      resetZoom();
    });
    // Expand the per-step diagram into the same zoom modal.
    const expandStep = document.getElementById('expand-step-diagram');
    if (expandStep) expandStep.addEventListener('click', async () => {
      setModalTitle(`Step ${STEPS[active].n} diagram`);
      document.getElementById('arch-modal').hidden = false;
      await renderStepDiagramInto('#arch-big');
      resetZoom();
    });
    document.getElementById('arch-modal-close').addEventListener('click', () => {
      document.getElementById('arch-modal').hidden = true;
    });
    document.getElementById('arch-modal').addEventListener('click', ev => {
      if (ev.target.id === 'arch-modal') document.getElementById('arch-modal').hidden = true;
    });
    window.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') document.getElementById('arch-modal').hidden = true;
    });

    // Zoom buttons
    document.getElementById('zoom-in').addEventListener('click', () => { zoom(0.2, container.clientWidth / 2, container.clientHeight / 2); });
    document.getElementById('zoom-out').addEventListener('click', () => { zoom(-0.2, container.clientWidth / 2, container.clientHeight / 2); });
    document.getElementById('zoom-reset').addEventListener('click', resetZoom);

    // Mouse wheel zoom (toward cursor)
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      zoom(e.deltaY < 0 ? 0.15 : -0.15, cx, cy);
    }, { passive: false });

    // Drag to pan
    container.addEventListener('mousedown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      container.classList.add('grabbing');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panX += e.clientX - lastX;
      panY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      applyTransform();
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      container.classList.remove('grabbing');
    });
  }

  // =====================================================================
  // HELPERS
  // =====================================================================
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function md(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function mintId() { return `c_${Math.random().toString(36).slice(2, 10)}`; }
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2000);
  }

  // =====================================================================
  // BOOT
  // =====================================================================
  const bootSteps = [
    ['topbar', renderTopbar],
    ['verdict', renderVerdict],
    ['confidence', renderConfidence],
    ['tldr', renderTldr],
    ['attention', renderAttention],
    ['disqualifiers', renderDisqualifiers],
    ['faq', renderFaq],
    ['summary', () => renderSummary('#bullets')],
    ['arch', renderArch],
    ['fileTree', renderFileTree],
    ['qa', bindQA],
    ['comments', bindComments],
    ['railCollapse', bindRailCollapse],
    ['railResize', bindRailResize],
    ['sideCollapse', bindSideCollapse],
    ['nav', bindNav],
    ['archZoom', bindArchZoom],
    ['mode', () => setMode('overview')],
  ];
  for (const [name, fn] of bootSteps) {
    try { await fn(); } catch (err) {
      console.warn(`[pr-walkthrough] render step "${name}" failed:`, err);
    }
  }

  // Begin live cross-client Q&A sync (questions/answers from other browsers,
  // machines, or the shared URL appear without a reload).
  startQaSync();

  // Expose for debugging — same shape as the spike's window.__spike
  window.__prWalkthrough = { manifest: MANIFEST, walkthrough: WT, setMode, setActive, toggleRail, toggleSteps, toggleWhy };
  console.log('PR walkthrough loaded:', MANIFEST?.id ?? ctx.artifactId);
}

export default {
  type: 'pr-walkthrough',
  // We ship our own line-anchored 💬 button inside the diff. The universal
  // artifact-comments overlay (auto-mounted when comments !== false) would
  // duplicate that affordance and confuse users about which comment path is
  // authoritative — opt out.
  comments: false,
  async render(root, ctx) {
    // 1. Inject styles
    const styleEl = document.createElement('style');
    styleEl.textContent = PR_WALKTHROUGH_STYLES;
    document.head.appendChild(styleEl);

    // 2. Build shell HTML in `root`
    root.innerHTML = buildShellHtml();

    // 3. Boot the app — pass ctx so we can use ctx.fetchFileJson and ctx.artifactId
    await bootApp(root, ctx);
  },
};
