/**
 * test-ui.ts — standalone HTML test UI for the spawn/dispatch API.
 *
 * Served at GET /test-ui. Self-contained single page with embedded CSS
 * and JS — no Vue, no build pipeline. Uses xterm.js + addon-fit from
 * unpkg CDN for the live terminal view.
 *
 * Hits the same loopback-only /spawn, /dispatch, /api/sessions endpoints
 * the CLI uses. No auth (same posture as the main SPA).
 *
 * Sections:
 *   - Sidebar: live session list (auto-refresh 2s), click to attach
 *   - Spawn form: prompt + provider + workspace_path/id + alias + model + agent
 *   - Dispatch form: prompt + instance_id (auto-filled from selected session)
 *   - Scenario runner: smart-alias, model-switch, stress (mirror cdb tool)
 *   - Terminal: live xterm view of the selected session
 *   - Event log: timestamped API requests + responses
 */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1a2028">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>clawdevbox · test UI</title>
<link rel="stylesheet" href="https://unpkg.com/@xterm/xterm@5.5.0/css/xterm.css">
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1419;
    color: #d8dde2;
    height: 100%;
    overflow: hidden;
    -webkit-text-size-adjust: 100%;
  }
  header {
    background: #1a2028;
    padding: 8px 14px;
    border-bottom: 1px solid #2c3540;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 44px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header h1 { font-size: 13px; font-weight: 600; margin: 0; color: #f0c674; white-space: nowrap; }
  header .status { font-size: 11px; color: #7c858f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  header .status.ok::before { content: '● '; color: #a8c97f; }
  header .status.err::before { content: '● '; color: #cc6666; }
  header .spacer { flex: 1; }
  header .clock { font-size: 11px; color: #7c858f; font-variant-numeric: tabular-nums; }
  header button { min-height: 32px; touch-action: manipulation; }

  /* ── DESKTOP (≥1200px): 3-col × 2-row grid ─────────────────────── */
  .layout {
    display: grid;
    grid-template-columns: 280px 1fr 480px;
    grid-template-rows: 1fr 200px;
    grid-template-areas: "side main term" "side log term";
    height: calc(100vh - 44px);
    gap: 1px;
    background: #2c3540;
  }
  .panel { background: #0f1419; overflow: auto; }
  .side { grid-area: side; padding: 8px; }
  .main { grid-area: main; padding: 12px; overflow-y: auto; }
  .term { grid-area: term; padding: 8px; display: flex; flex-direction: column; min-height: 0; }
  .term-host { flex: 1; min-height: 0; }
  .log { grid-area: log; padding: 8px; font-family: 'Cascadia Code', Consolas, monospace; font-size: 11px; }
  .log-entry { padding: 2px 0; border-bottom: 1px solid #1a2028; white-space: pre-wrap; word-break: break-all; }
  .log-entry .ts { color: #5c6370; }
  .log-entry .method { color: #61afef; font-weight: 600; }
  .log-entry.req { color: #d8dde2; }
  .log-entry.res { color: #a8c97f; }
  .log-entry.err { color: #e06c75; }
  .session {
    padding: 10px;
    border: 1px solid #2c3540;
    border-radius: 4px;
    margin-bottom: 6px;
    cursor: pointer;
    transition: border-color 0.15s;
    touch-action: manipulation;
  }
  .session:hover { border-color: #5c6370; }
  .session.selected { border-color: #f0c674; background: #1a2028; }
  .session .id { font-family: 'Cascadia Code', Consolas, monospace; font-size: 11px; color: #61afef; word-break: break-all; }
  .session .meta { font-size: 11px; color: #7c858f; margin-top: 2px; }
  .session .state { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .session .state.idle { background: #1a2e1a; color: #a8c97f; }
  .session .state.busy { background: #2e2a1a; color: #f0c674; }
  .session .state.starting { background: #1a242e; color: #61afef; }
  .session .actions { display: flex; gap: 6px; margin-top: 8px; }
  .session .actions button {
    background: #2c3540; border: none; color: #d8dde2;
    padding: 6px 10px; font-size: 11px; border-radius: 3px; cursor: pointer;
    min-height: 32px; touch-action: manipulation;
  }
  .session .actions button:hover { background: #3c4651; }
  .session .actions button.danger { background: #3c2828; color: #e06c75; }
  .session .actions button.danger:hover { background: #5c3838; }
  .tabs { display: flex; gap: 0; margin-bottom: 12px; border-bottom: 1px solid #2c3540; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    padding: 10px 16px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: #7c858f;
    font-weight: 500;
    user-select: none;
    white-space: nowrap;
    min-height: 40px;
    touch-action: manipulation;
  }
  .tab.active { color: #f0c674; border-bottom-color: #f0c674; }
  .tab:hover:not(.active) { color: #d8dde2; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .form-grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 12px; max-width: 700px; }
  .form-grid label { color: #7c858f; padding-top: 8px; font-size: 12px; }
  .form-grid input, .form-grid select, .form-grid textarea {
    background: #1a2028;
    border: 1px solid #2c3540;
    color: #d8dde2;
    padding: 8px 10px;
    border-radius: 3px;
    font-family: inherit;
    font-size: 13px;
    min-height: 36px;
    width: 100%;
  }
  .form-grid textarea { font-family: 'Cascadia Code', Consolas, monospace; resize: vertical; min-height: 70px; }
  .form-grid input:focus, .form-grid select:focus, .form-grid textarea:focus {
    outline: none; border-color: #61afef;
  }
  .form-grid .hint { color: #5c6370; font-size: 11px; padding-top: 6px; }
  .form-actions { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  button.primary {
    background: #61afef; color: #0f1419; border: none;
    padding: 10px 18px; border-radius: 3px; cursor: pointer;
    font-weight: 600; font-size: 13px;
    min-height: 40px; touch-action: manipulation;
  }
  button.primary:hover { background: #7ec2f5; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary:active { transform: translateY(1px); }
  button.secondary {
    background: transparent; border: 1px solid #2c3540; color: #d8dde2;
    padding: 9px 16px; border-radius: 3px; cursor: pointer; font-size: 13px;
    min-height: 40px; touch-action: manipulation;
  }
  button.secondary:hover { border-color: #5c6370; }
  .scenario-card {
    border: 1px solid #2c3540;
    border-radius: 4px;
    padding: 12px;
    margin-bottom: 10px;
  }
  .scenario-card h3 { margin: 0 0 4px 0; font-size: 13px; color: #f0c674; }
  .scenario-card p { margin: 4px 0 8px 0; color: #7c858f; font-size: 12px; }
  .panel-h { font-size: 11px; color: #7c858f; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #2c3540; }
  .empty { color: #5c6370; padding: 16px; text-align: center; font-style: italic; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: #0f1419; }
  ::-webkit-scrollbar-thumb { background: #2c3540; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #3c4651; }
  .response {
    margin-top: 12px; padding: 10px; background: #1a2028; border-radius: 3px;
    font-family: 'Cascadia Code', Consolas, monospace; font-size: 11px;
    border-left: 3px solid #61afef;
    white-space: pre-wrap; word-break: break-all;
    max-height: 60vh;
    overflow-y: auto;
  }
  .response.err { border-left-color: #e06c75; color: #e06c75; }
  .response.ok { border-left-color: #a8c97f; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-left: 4px; font-weight: 600; }
  .badge.spawn { background: #1a2e1a; color: #a8c97f; }
  .badge.dispatch { background: #1a242e; color: #61afef; }

  /* ── MOBILE NAV (only shown < 768px) ──────────────────────────── */
  .mobile-nav {
    display: none;
    background: #1a2028;
    border-top: 1px solid #2c3540;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }
  .mobile-nav-tab {
    flex: 1;
    padding: 10px 4px 12px;
    text-align: center;
    cursor: pointer;
    user-select: none;
    color: #7c858f;
    font-size: 10px;
    line-height: 1.3;
    border-right: 1px solid #2c3540;
    touch-action: manipulation;
  }
  .mobile-nav-tab:last-child { border-right: none; }
  .mobile-nav-tab.active { color: #f0c674; background: #0f1419; }
  .mobile-nav-tab .icon { display: block; font-size: 18px; margin-bottom: 2px; }

  /* ── TABLET (≤1199px): 2 columns, term + log stack below ─────── */
  @media (max-width: 1199px) {
    .layout {
      grid-template-columns: 260px 1fr;
      grid-template-rows: 1fr 280px 160px;
      grid-template-areas: "side main" "side term" "side log";
    }
  }

  /* ── PHONE (≤767px): single panel + bottom mobile-nav ─────────── */
  @media (max-width: 767px) {
    header { padding: 8px 12px; gap: 8px; }
    header h1 { font-size: 13px; }
    header .status { font-size: 10px; }
    header .clock { display: none; }
    body { height: 100dvh; }
    .layout {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 56px;
      grid-template-areas: "active" "mnav";
      height: calc(100dvh - 44px);
    }
    .panel { grid-area: active; display: none; }
    .panel.mobile-active { display: block; }
    .term { padding: 4px 6px; }
    .term.mobile-active { display: flex; }
    .mobile-nav { display: flex; grid-area: mnav; }
    /* form fields stack labels on top */
    .form-grid {
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .form-grid label {
      padding-top: 12px;
      font-weight: 600;
      color: #a8c97f;
    }
    /* 16px input prevents iOS auto-zoom */
    .form-grid input, .form-grid select, .form-grid textarea {
      font-size: 16px;
      padding: 10px;
    }
    .form-actions button { flex: 1; min-width: 0; }
    .tab { padding: 12px 14px; font-size: 13px; }
    .main { padding: 10px; }
    .side { padding: 6px; }
    .log { font-size: 10px; }
  }
</style>
</head>
<body>

<header>
  <h1>clawdevbox · test UI</h1>
  <span class="status" id="server-status">connecting…</span>
  <span class="spacer"></span>
  <span class="clock" id="clock"></span>
  <button class="secondary" onclick="refreshSessions()" style="padding: 6px 12px; font-size: 11px; min-height: 32px;">↻</button>
</header>

<div class="layout">

  <div class="panel side">
    <div class="panel-h">active sessions</div>
    <div id="session-list"></div>
  </div>

  <div class="panel main">
    <div class="tabs">
      <div class="tab active" data-tab="spawn">Spawn</div>
      <div class="tab" data-tab="dispatch">Dispatch</div>
      <div class="tab" data-tab="scenarios">Scenarios</div>
      <div class="tab" data-tab="raw">Raw</div>
    </div>

    <div class="tab-content active" data-tab="spawn">
      <div class="form-grid">
        <label>Prompt *</label>
        <textarea id="sp-prompt" placeholder="Reply with only: HELLO_WORLD"></textarea>

        <label>Provider</label>
        <select id="sp-provider"></select>

        <label>Workspace path</label>
        <input id="sp-ws" placeholder="C:\\path\\to\\workspace">

        <label>Workspace id</label>
        <input id="sp-wsid" placeholder="(optional — stable id)">

        <label>Session alias</label>
        <input id="sp-alias" placeholder="(optional — friendly name)">

        <label>Session id (GUID)</label>
        <input id="sp-guid" placeholder="(optional — UUID instead of alias)">

        <label>Model</label>
        <input id="sp-model" placeholder="gpt-5.2 | claude-opus-4.7-1m-internal | opus">

        <label>Agent</label>
        <input id="sp-agent" placeholder="dev-buddy:dev-buddy">

        <label>Fire id</label>
        <input id="sp-fire" placeholder="(optional)">
      </div>
      <div class="form-actions">
        <button class="primary" onclick="doSpawn()">Spawn</button>
        <button class="secondary" onclick="clearForm('spawn')">Clear</button>
      </div>
      <div id="sp-response"></div>
    </div>

    <div class="tab-content" data-tab="dispatch">
      <div class="form-grid">
        <label>Prompt *</label>
        <textarea id="dp-prompt" placeholder="follow-up message"></textarea>

        <label>Instance id</label>
        <input id="dp-instance" placeholder="ri_xxx (click a session to fill)">

        <label>Fire id</label>
        <input id="dp-fire" placeholder="(or use a fire_id instead)">
      </div>
      <div class="form-actions">
        <button class="primary" onclick="doDispatch()">Dispatch</button>
        <button class="secondary" onclick="clearForm('dispatch')">Clear</button>
      </div>
      <div id="dp-response"></div>
    </div>

    <div class="tab-content" data-tab="scenarios">
      <div class="scenario-card">
        <h3>smart-alias</h3>
        <p>Spawn → dispatch (same alias) → kill → spawn (resume with same GUID). Validates the full lifecycle.</p>
        <button class="primary" onclick="runScenario('smart-alias')">Run</button>
        <div id="sc-smart-alias-response"></div>
      </div>
      <div class="scenario-card">
        <h3>model-switch</h3>
        <p>Spawn with two different models, verify each appears in the copilot status bar.</p>
        <button class="primary" onclick="runScenario('model-switch')">Run</button>
        <div id="sc-model-switch-response"></div>
      </div>
      <div class="scenario-card">
        <h3>stress (N concurrent × 2 turns)</h3>
        <p>Spawn N concurrent aliases, dispatch a follow-up to each, verify all 2N canaries arrived.</p>
        <div class="form-grid" style="grid-template-columns: 80px 100px; max-width: 220px;">
          <label>N</label>
          <input id="sc-stress-n" type="number" value="3" min="1" max="10">
        </div>
        <div class="form-actions">
          <button class="primary" onclick="runScenario('stress')">Run</button>
        </div>
        <div id="sc-stress-response"></div>
      </div>
    </div>

    <div class="tab-content" data-tab="raw">
      <div class="form-grid">
        <label>Method</label>
        <select id="raw-method">
          <option>GET</option><option>POST</option><option>DELETE</option><option>PUT</option>
        </select>
        <label>Path</label>
        <input id="raw-path" value="/api/sessions?status=active&limit=20">
        <label>Body (JSON)</label>
        <textarea id="raw-body" placeholder='{"prompt": "..."}' style="min-height: 100px;"></textarea>
      </div>
      <div class="form-actions">
        <button class="primary" onclick="doRaw()">Send</button>
      </div>
      <div id="raw-response"></div>
    </div>

  </div>

  <div class="panel term">
    <div class="panel-h">
      terminal · <span id="term-id" style="font-family: 'Cascadia Code', monospace; color: #61afef;">(none)</span>
    </div>
    <div class="term-host" id="term-host"></div>
  </div>

  <div class="panel log">
    <div class="panel-h">event log</div>
    <div id="event-log"></div>
  </div>

  <nav class="mobile-nav" id="mobile-nav">
    <div class="mobile-nav-tab active" data-panel="main" onclick="setMobilePanel('main')"><span class="icon">▤</span>Forms</div>
    <div class="mobile-nav-tab" data-panel="side" onclick="setMobilePanel('side')"><span class="icon">≡</span>Sessions</div>
    <div class="mobile-nav-tab" data-panel="term" onclick="setMobilePanel('term')"><span class="icon">▭</span>Terminal</div>
    <div class="mobile-nav-tab" data-panel="log" onclick="setMobilePanel('log')"><span class="icon">⌖</span>Log</div>
  </nav>

</div>

<script src="https://unpkg.com/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://unpkg.com/@xterm/addon-fit@0.10.0/lib/addon-fit.js"></script>
<script>
(function () {
  // ── state ──
  const BASE = window.location.origin;
  let selectedInstance = null;
  let xterm = null, fitAddon = null, termWs = null;
  let providers = [];

  // ── log ──
  function logEntry(level, text) {
    const el = document.getElementById('event-log');
    const ts = new Date().toTimeString().slice(0, 8);
    const div = document.createElement('div');
    div.className = 'log-entry ' + level;
    div.innerHTML = '<span class="ts">' + ts + '</span> ' + text;
    el.insertBefore(div, el.firstChild);
    while (el.children.length > 200) el.removeChild(el.lastChild);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ── api ──
  async function api(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    logEntry('req', '<span class="method">' + method + '</span> ' + esc(path) + (body ? ' ' + esc(JSON.stringify(body)) : ''));
    try {
      const r = await fetch(BASE + path, init);
      const text = await r.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (r.ok) logEntry('res', '← ' + r.status + ' ' + esc(typeof parsed === 'object' ? JSON.stringify(parsed) : parsed));
      else logEntry('err', '← ' + r.status + ' ' + esc(text));
      return { status: r.status, body: parsed, raw: text, ok: r.ok };
    } catch (err) {
      logEntry('err', '✗ ' + esc(err.message));
      throw err;
    }
  }

  // ── session list ──
  async function refreshSessions() {
    const r = await api('GET', '/api/sessions?status=active&limit=200');
    const items = r.body?.items ?? [];
    const list = document.getElementById('session-list');
    if (items.length === 0) {
      list.innerHTML = '<div class="empty">(no active sessions)</div>';
      return;
    }
    list.innerHTML = items.map((s) => {
      const sel = s.instance_id === selectedInstance ? ' selected' : '';
      const state = s.state || 'unknown';
      return \`
        <div class="session\${sel}" onclick="selectSession('\${s.instance_id}')">
          <div class="id">\${esc(s.instance_id)}</div>
          <div class="meta">
            <span class="state \${state}">\${state}</span>
            \${esc(s.provider_id || '(main)')} · queue \${s.queue_depth ?? 0}
          </div>
          <div class="meta">\${esc(s.label || '')}</div>
          <div class="actions">
            <button onclick="event.stopPropagation(); attachTerm('\${s.instance_id}')">attach</button>
            \${s.instance_id !== 'main' ? \`<button class="danger" onclick="event.stopPropagation(); killSession('\${s.instance_id}')">kill</button>\` : ''}
          </div>
        </div>\`;
    }).join('');
  }
  window.refreshSessions = refreshSessions;

  // ── providers ──
  async function loadProviders() {
    try {
      const r = await api('GET', '/api/test/agent-clis');
      providers = (r.body?.items ?? []).filter((p) => !p.internal);
      const sel = document.getElementById('sp-provider');
      sel.innerHTML = providers.map((p) => \`<option value="\${p.id}">\${p.id} — \${p.display_name}</option>\`).join('');
      if (providers.find((p) => p.id === 'copilot')) sel.value = 'copilot';
    } catch {}
  }

  // ── select / attach ──
  function selectSession(id) {
    selectedInstance = id;
    document.getElementById('dp-instance').value = id;
    refreshSessions();
    attachTerm(id);
    // On mobile, auto-switch to the Terminal panel
    if (isMobile()) setMobilePanel('term');
  }
  window.selectSession = selectSession;

  // ── mobile panel switching ──
  function isMobile() { return window.matchMedia('(max-width: 767px)').matches; }
  function setMobilePanel(name) {
    document.querySelectorAll('.panel').forEach((el) => el.classList.remove('mobile-active'));
    const target = document.querySelector('.' + name);
    if (target) target.classList.add('mobile-active');
    document.querySelectorAll('.mobile-nav-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.panel === name);
    });
    // Re-fit xterm when switching to the terminal panel
    if (name === 'term' && fitAddon && xterm) {
      setTimeout(() => {
        try { fitAddon.fit(); termWs?.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows })); } catch {}
      }, 50);
    }
  }
  window.setMobilePanel = setMobilePanel;

  function attachTerm(id) {
    document.getElementById('term-id').textContent = id;
    if (termWs) { try { termWs.close(); } catch {} termWs = null; }
    if (xterm) { xterm.dispose(); xterm = null; }
    fitAddon = new FitAddon.FitAddon();
    xterm = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: isMobile() ? 10 : 12,
      theme: { background: '#0f1419', foreground: '#d8dde2', cursor: '#f0c674' },
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
    });
    xterm.loadAddon(fitAddon);
    const host = document.getElementById('term-host');
    host.innerHTML = '';
    xterm.open(host);
    setTimeout(() => fitAddon.fit(), 50);

    const wsUrl = BASE.replace(/^http/, 'ws') + '/terminal/' + encodeURIComponent(id) + '/ws';
    termWs = new WebSocket(wsUrl);
    termWs.onmessage = (m) => {
      try {
        const o = JSON.parse(m.data);
        if (o.type === 'snapshot') xterm.write(o.content || '');
        else if (o.type === 'data') xterm.write(o.chunk || '');
        else if (o.type === 'exit') xterm.write('\\r\\n\\x1b[33m[session exited code=' + o.exitCode + ']\\x1b[0m\\r\\n');
      } catch {}
    };
    termWs.onerror = () => logEntry('err', 'terminal ws error for ' + id);
    // Forward keystrokes
    xterm.onData((d) => { try { termWs.send(JSON.stringify({ type: 'input', data: d })); } catch {} });
    // Forward resize
    const sendResize = () => {
      try {
        fitAddon.fit();
        const { cols, rows } = xterm;
        termWs.send(JSON.stringify({ type: 'resize', cols, rows }));
      } catch {}
    };
    termWs.onopen = () => sendResize();
    new ResizeObserver(sendResize).observe(host);
  }
  window.attachTerm = attachTerm;

  async function killSession(id) {
    const r = await api('DELETE', '/api/sessions/' + encodeURIComponent(id));
    if (r.ok) logEntry('res', 'killed ' + id);
    refreshSessions();
  }
  window.killSession = killSession;

  // ── tabs ──
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      const name = t.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
      document.querySelectorAll('.tab-content').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    });
  });

  function clearForm(which) {
    if (which === 'spawn') {
      ['sp-prompt','sp-ws','sp-wsid','sp-alias','sp-guid','sp-model','sp-agent','sp-fire'].forEach((id) => document.getElementById(id).value = '');
      document.getElementById('sp-response').innerHTML = '';
    } else if (which === 'dispatch') {
      ['dp-prompt','dp-instance','dp-fire'].forEach((id) => document.getElementById(id).value = '');
      document.getElementById('dp-response').innerHTML = '';
    }
  }
  window.clearForm = clearForm;

  function renderResp(id, r) {
    const ok = r.ok;
    const cls = ok ? 'ok' : 'err';
    let html = '<div class="response ' + cls + '"><strong>HTTP ' + r.status + '</strong>';
    if (ok && r.body?.mode) html += ' <span class="badge ' + r.body.mode + '">' + r.body.mode + '</span>';
    html += '\\n' + esc(JSON.stringify(r.body, null, 2)) + '</div>';
    document.getElementById(id).innerHTML = html;
  }

  // ── spawn ──
  async function doSpawn() {
    const body = {
      prompt: document.getElementById('sp-prompt').value,
      provider: document.getElementById('sp-provider').value,
    };
    const fields = { workspace_path: 'sp-ws', workspace_id: 'sp-wsid', session_id: 'sp-alias', agent: 'sp-agent', model: 'sp-model' };
    for (const [k, id] of Object.entries(fields)) {
      const v = document.getElementById(id).value.trim();
      if (v) body[k] = v;
    }
    // GUID overrides alias if both present
    const guid = document.getElementById('sp-guid').value.trim();
    if (guid) body.session_id = guid;
    const fireId = document.getElementById('sp-fire').value.trim();
    const path = fireId ? '/spawn?fire_id=' + encodeURIComponent(fireId) : '/spawn';
    if (!body.prompt) { alert('prompt required'); return; }
    const r = await api('POST', path, body);
    renderResp('sp-response', r);
    if (r.ok && r.body?.instance_id) {
      // Refresh the sidebar immediately so the new session is visible.
      // Defer the auto-attach: opening the xterm WebSocket sends a resize
      // to the pty, which races with copilot's initial-prompt delivery
      // (the user-reported "prompt is added but not submitted" bug). Wait
      // a few seconds — by then copilot's load+input handler has settled.
      // User can still click the session in the sidebar to attach sooner.
      setTimeout(() => { refreshSessions(); }, 500);
      setTimeout(() => { selectSession(r.body.instance_id); }, 5000);
    }
  }
  window.doSpawn = doSpawn;

  // ── dispatch ──
  async function doDispatch() {
    const body = { prompt: document.getElementById('dp-prompt').value };
    const i = document.getElementById('dp-instance').value.trim();
    const f = document.getElementById('dp-fire').value.trim();
    if (i) body.instance_id = i;
    if (f) body.fire_id = f;
    if (!body.prompt) { alert('prompt required'); return; }
    if (!i && !f) { alert('instance_id or fire_id required'); return; }
    const r = await api('POST', '/dispatch', body);
    renderResp('dp-response', r);
  }
  window.doDispatch = doDispatch;

  // ── raw ──
  async function doRaw() {
    const method = document.getElementById('raw-method').value;
    const path = document.getElementById('raw-path').value;
    const bodyText = document.getElementById('raw-body').value.trim();
    let body;
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch (e) { alert('invalid JSON: ' + e.message); return; }
    }
    const r = await api(method, path, body);
    renderResp('raw-response', r);
  }
  window.doRaw = doRaw;

  // ── scenarios ──
  async function waitForCanary(id, text, maxSec = 90) {
    const wsUrl = BASE.replace(/^http/, 'ws') + '/terminal/' + encodeURIComponent(id) + '/ws';
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      let buf = '';
      const stop = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, maxSec * 1000);
      ws.onmessage = (m) => {
        try {
          const o = JSON.parse(m.data);
          if (o.type === 'snapshot') buf += o.content || '';
          else if (o.type === 'data') buf += o.chunk || '';
          // crude ansi strip
          const stripped = buf.replace(/\\u001b\\[[0-9;?]*[A-Za-z]/g, '');
          if (stripped.includes(text)) { clearTimeout(stop); try { ws.close(); } catch {} resolve(true); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(stop); resolve(false); };
    });
  }

  async function runScenario(name) {
    const respId = 'sc-' + name + '-response';
    const out = document.getElementById(respId);
    out.innerHTML = '<div class="response">running…</div>';
    const lines = [];
    const log = (msg) => { lines.push(msg); out.innerHTML = '<div class="response">' + lines.map(esc).join('\\n') + '</div>'; };
    const provider = document.getElementById('sp-provider').value || 'copilot';
    const ws = document.getElementById('sp-ws').value || '';

    try {
      if (name === 'smart-alias') {
        const alias = 'ui-scenario-' + Math.random().toString(36).slice(2, 8);
        log('alias=' + alias);
        log('1. initial spawn...');
        const r1 = await api('POST', '/spawn', { prompt: 'Reply with only: HELLO_1', session_id: alias, provider, workspace_path: ws });
        if (r1.body.mode !== 'spawn') throw new Error('expected mode=spawn, got ' + r1.body.mode);
        log('   → ' + r1.body.mode + ' instance=' + r1.body.instance_id + ' session=' + r1.body.session_id);
        await refreshSessions();
        if (!await waitForCanary(r1.body.instance_id, 'HELLO_1', 120)) throw new Error('HELLO_1 timeout');
        log('   ✓ HELLO_1 arrived');

        log('2. repeat spawn (same alias)...');
        const r2 = await api('POST', '/spawn', { prompt: 'Reply with only: HELLO_2', session_id: alias, provider, workspace_path: ws });
        if (r2.body.mode !== 'dispatch') throw new Error('expected dispatch, got ' + r2.body.mode);
        log('   → ' + r2.body.mode + ' (same instance)');
        if (!await waitForCanary(r1.body.instance_id, 'HELLO_2', 60)) throw new Error('HELLO_2 timeout');
        log('   ✓ HELLO_2 arrived');

        log('3. kill pty...');
        await api('DELETE', '/api/sessions/' + r1.body.instance_id);
        log('   ✓ killed');
        await new Promise((r) => setTimeout(r, 4000));

        log('4. spawn with same alias (no live pty)...');
        const r3 = await api('POST', '/spawn', { prompt: 'Reply with only: HELLO_3', session_id: alias, provider, workspace_path: ws });
        if (r3.body.mode !== 'spawn') throw new Error('expected spawn, got ' + r3.body.mode);
        if (r3.body.session_id !== r1.body.session_id) throw new Error('GUID drifted');
        log('   → ' + r3.body.mode + ' new instance, SAME GUID preserved');
        if (!await waitForCanary(r3.body.instance_id, 'HELLO_3', 120)) throw new Error('HELLO_3 timeout');
        log('   ✓ HELLO_3 arrived');
        log('cleanup...');
        await api('DELETE', '/api/sessions/' + r3.body.instance_id);
        log('\\n🎯 smart-alias PASS');
      }
      else if (name === 'model-switch') {
        const cases = [
          { model: 'claude-opus-4.7-1m-internal', rx: /Opus 4\\.7/i, canary: 'MODEL_OPUS' },
          { model: 'gpt-5.2', rx: /GPT[\\s-]*5\\.2/i, canary: 'MODEL_GPT52' },
        ];
        for (const c of cases) {
          const alias = 'ui-model-' + Math.random().toString(36).slice(2, 6);
          log('model=' + c.model);
          const r = await api('POST', '/spawn', { prompt: 'Reply with only: ' + c.canary, session_id: alias, provider, workspace_path: ws, model: c.model });
          if (!await waitForCanary(r.body.instance_id, c.canary, 120)) throw new Error(c.canary + ' timeout');
          log('   ✓ ' + c.canary + ' arrived');
          // Quick visual check: read scrollback once more, look for model name
          const ws2 = new WebSocket(BASE.replace(/^http/, 'ws') + '/terminal/' + r.body.instance_id + '/ws');
          let buf = '';
          await new Promise((res) => {
            ws2.onmessage = (m) => { try { const o = JSON.parse(m.data); if (o.type === 'snapshot') buf += o.content || ''; else if (o.type === 'data') buf += o.chunk || ''; } catch {} };
            setTimeout(() => { try { ws2.close(); } catch {} res(); }, 2000);
          });
          const stripped = buf.replace(/\\u001b\\[[0-9;?]*[A-Za-z]/g, '');
          if (!c.rx.test(stripped)) throw new Error('model name ' + c.model + ' not visible in status bar');
          log('   ✓ ' + c.rx + ' matched in status bar');
          await api('DELETE', '/api/sessions/' + r.body.instance_id);
        }
        log('\\n🎯 model-switch PASS');
      }
      else if (name === 'stress') {
        const n = Number(document.getElementById('sc-stress-n').value || 3);
        const aliases = [];
        for (let i = 0; i < n; i++) aliases.push({ alias: 'ui-stress-' + i + '-' + Math.random().toString(36).slice(2, 6), canaries: [] });
        log('phase 1: ' + n + ' parallel spawns...');
        const phase1 = await Promise.all(aliases.map((a) => {
          const c = 'STR_S' + a.alias.slice(-4).toUpperCase();
          a.canaries.push(c);
          return api('POST', '/spawn', { prompt: 'Reply with only: ' + c, session_id: a.alias, provider, workspace_path: ws })
            .then((r) => Object.assign(a, { instance: r.body.instance_id, guid: r.body.session_id }));
        }));
        log('   ✓ ' + n + ' spawned');
        await refreshSessions();
        await Promise.all(phase1.map((r) => waitForCanary(r.instance, r.canaries[0], 180)));
        log('   ✓ initial canaries arrived');

        log('phase 2: parallel follow-ups...');
        await Promise.all(phase1.map(async (r) => {
          const c = 'STR_D' + r.alias.slice(-4).toUpperCase();
          r.canaries.push(c);
          const r2 = await api('POST', '/spawn', { prompt: 'Reply with only: ' + c, session_id: r.alias, provider, workspace_path: ws });
          if (r2.body.mode !== 'dispatch') throw new Error(r.alias + ': expected dispatch');
        }));
        await Promise.all(phase1.map(async (r) => {
          for (const c of r.canaries) {
            if (!await waitForCanary(r.instance, c, 90)) throw new Error(r.alias + ' missing ' + c);
          }
        }));
        log('   ✓ all ' + (n * 2) + ' canaries delivered');
        log('cleanup...');
        await Promise.all(phase1.map((r) => api('DELETE', '/api/sessions/' + r.instance)));
        log('\\n🎯 stress PASS (' + n + ' × 2 = ' + (n * 2) + ' canaries)');
      }
    } catch (err) {
      out.innerHTML = '<div class="response err">' + esc(lines.join('\\n') + '\\n\\n✗ FAIL: ' + err.message) + '</div>';
    }
  }
  window.runScenario = runScenario;

  // ── health check + clock ──
  async function healthCheck() {
    try {
      const r = await fetch(BASE + '/healthz');
      const s = document.getElementById('server-status');
      if (r.ok) { s.className = 'status ok'; s.textContent = BASE; }
      else { s.className = 'status err'; s.textContent = BASE + ' (HTTP ' + r.status + ')'; }
    } catch (e) {
      const s = document.getElementById('server-status');
      s.className = 'status err';
      s.textContent = BASE + ' (unreachable)';
    }
  }
  setInterval(() => { document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 8); }, 1000);
  setInterval(healthCheck, 5000);
  setInterval(refreshSessions, 2000);

  // ── boot ──
  healthCheck();
  loadProviders();
  refreshSessions();
  document.getElementById('sp-ws').value = window.location.search.includes('ws=') ? new URLSearchParams(window.location.search).get('ws') : '';
  // Initialize mobile panel state: default to "Forms" (the main tab area).
  // On desktop, this is a no-op because the .panel display: none rule only
  // applies via the @media (max-width: 767px) query.
  setMobilePanel('main');
  // If the viewport crosses the 768px boundary (orientation flip, devtools
  // open/close, real resize), re-fit the xterm so it adapts.
  window.matchMedia('(max-width: 767px)').addEventListener('change', () => {
    setTimeout(() => { try { fitAddon?.fit(); } catch {} }, 100);
  });
})();
</script>
</body>
</html>`;

export function renderTestUI(): string {
  return HTML;
}
