/* =========================================================================
   ClawDevbox Documentation — shared chrome & interactions
   Renders the topbar + sidebar from a single NAV definition, builds the
   on-this-page TOC, powers client-side search, theme toggle, code copy
   buttons and the mobile menu. No framework, no build step.
   ========================================================================= */
(function () {
  "use strict";

  var REPO = "https://github.com/kirmad/clawdevbox";

  /* ------------------------------- Icons -------------------------------- */
  var I = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    rocket:
      '<path d="M5 15c-1.5.5-2 3-2 3s2.5-.5 3-2"/><path d="M9 15l-3-3c2-6 6-9 12-9 0 6-3 10-9 12z"/><circle cx="14.5" cy="9.5" r="1.4"/>',
    layers:
      '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/><path d="M3 18l9 5 9-5" opacity=".5"/>',
    book: '<path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 0-2 2V4Z"/><path d="M5 20a2 2 0 0 1 2-2h11"/>',
    workflow:
      '<rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/><path d="M6.5 9v4a2 2 0 0 0 2 2H14"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    award:
      '<circle cx="12" cy="9" r="6"/><path d="M8.5 14 7 22l5-3 5 3-1.5-8"/>',
    database:
      '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    image:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m21 16-5-5L5 20"/>',
    inbox:
      '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M6.5 5h11l3.5 8v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4l3.5-8Z"/>',
    terminal:
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
    box: '<path d="m12 2 8 4.5v9L12 20l-8-4.5v-9L12 2Z"/><path d="m4 6.5 8 4.5 8-4.5"/><path d="M12 11v9"/>',
    puzzle:
      '<path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H7a1 1 0 0 1-1-1v-3H5a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h3V4Z"/>',
    tool: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L3 18l3 3 6.2-6.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.5-2.5 2.6-2.6Z"/>',
    github:
      '<path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.2-3.37-1.2-.46-1.18-1.11-1.5-1.11-1.5-.9-.64.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/>',
    sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    search:
      '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    link: '<path d="M9.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7l-1.2 1.2"/><path d="M14.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.2-1.2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  };

  function svg(name, cls) {
    return (
      '<svg class="' +
      (cls || "") +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (I[name] || "") +
      "</svg>"
    );
  }
  // Some icons are fill-based (github). Render those filled.
  function svgFill(name, cls) {
    return (
      '<svg class="' +
      (cls || "") +
      '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      (I[name] || "") +
      "</svg>"
    );
  }

  var LOGO =
    '<svg class="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
    '<rect width="32" height="32" rx="8" fill="url(#cdbg)"/>' +
    '<path d="M9 10.5 13.5 16 9 21.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M16 21.5h7" stroke="#ffce7a" stroke-width="2.4" stroke-linecap="round"/>' +
    '<defs><linearGradient id="cdbg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">' +
    '<stop stop-color="#8b7dff"/><stop offset="1" stop-color="#5b4bff"/></linearGradient></defs></svg>';

  /* ------------------------------- Nav ---------------------------------- */
  var NAV = [
    {
      group: "Introduction",
      items: [
        { t: "Home", u: "index.html", i: "home" },
        { t: "Getting Started", u: "getting-started.html", i: "rocket" },
        { t: "Architecture", u: "architecture.html", i: "layers" },
        { t: "Core Concepts", u: "concepts.html", i: "book" },
      ],
    },
    {
      group: "Building Blocks",
      items: [
        { t: "Recipes", u: "recipes.html", i: "workflow" },
        { t: "Triggers", u: "triggers.html", i: "zap" },
        { t: "Skills", u: "skills.html", i: "award" },
        { t: "Memory", u: "memory.html", i: "database" },
        { t: "Artifacts & Renderers", u: "artifacts.html", i: "image" },
        { t: "Inbox & Workflow", u: "inbox.html", i: "inbox" },
        { t: "Agent Sessions", u: "sessions.html", i: "terminal" },
      ],
    },
    {
      group: "Extend & Integrate",
      items: [
        { t: "Plugins", u: "plugins.html", i: "box" },
        { t: "Extensibility", u: "extensibility.html", i: "puzzle" },
        { t: "MCP Tools Reference", u: "mcp-tools.html", i: "tool" },
      ],
    },
  ];

  function currentPage() {
    var p = location.pathname.split("/").pop();
    return !p ? "index.html" : p;
  }

  /* ---------------------------- Build topbar ---------------------------- */
  function buildTopbar() {
    var el = document.getElementById("topbar");
    if (!el) return;
    el.innerHTML =
      '<button class="icon-btn menu-btn" id="menuBtn" aria-label="Menu">' +
      svg("menu") +
      "</button>" +
      '<a class="brand" href="index.html">' +
      LOGO +
      "<span>ClawDevbox</span>" +
      '<span class="brand-sub">Docs</span></a>' +
      '<div class="topbar-spacer"></div>' +
      '<div class="search" id="search">' +
      svg("search", "search-icon") +
      '<input type="text" id="searchInput" placeholder="Search the docs\u2026" ' +
      'autocomplete="off" spellcheck="false" aria-label="Search" />' +
      '<span class="search-kbd">/</span>' +
      '<div class="search-results" id="searchResults"></div>' +
      "</div>" +
      '<div class="topbar-actions">' +
      '<button class="icon-btn" id="themeBtn" aria-label="Toggle theme"></button>' +
      '<a class="icon-btn" href="' +
      REPO +
      '" target="_blank" rel="noopener" aria-label="GitHub">' +
      svgFill("github") +
      "</a></div>";
  }

  /* ---------------------------- Build sidebar --------------------------- */
  function buildSidebar() {
    var el = document.getElementById("sidebar");
    if (!el) return;
    var cur = currentPage();
    var html = "";
    NAV.forEach(function (grp) {
      html += '<div class="nav-group"><div class="nav-group-title">' + grp.group + "</div>";
      grp.items.forEach(function (it) {
        var active = it.u === cur ? " active" : "";
        html +=
          '<a class="nav-link' +
          active +
          '" href="' +
          it.u +
          '">' +
          svg(it.i, "nav-ico") +
          "<span>" +
          it.t +
          "</span></a>";
      });
      html += "</div>";
    });
    el.innerHTML = html;
  }

  /* ------------------------------ Theme --------------------------------- */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("cdb-theme", t);
    } catch (e) {}
    var btn = document.getElementById("themeBtn");
    if (btn) btn.innerHTML = svg(t === "dark" ? "sun" : "moon");
    var dark = document.getElementById("hljs-dark");
    var light = document.getElementById("hljs-light");
    if (dark && light) {
      dark.disabled = t !== "dark";
      light.disabled = t === "dark";
    }
  }
  function initTheme() {
    applyTheme(currentTheme());
    var btn = document.getElementById("themeBtn");
    if (btn)
      btn.addEventListener("click", function () {
        applyTheme(currentTheme() === "dark" ? "light" : "dark");
      });
  }

  /* ------------------------------ Mobile -------------------------------- */
  function initMobile() {
    var btn = document.getElementById("menuBtn");
    var body = document.body;
    // No sidebar on this page (e.g. the landing) — hide the menu button.
    if (btn && !document.getElementById("sidebar")) {
      btn.style.display = "none";
      return;
    }
    if (btn)
      btn.addEventListener("click", function () {
        body.classList.toggle("nav-open");
      });
    var bd = document.querySelector(".sidebar-backdrop");
    if (bd)
      bd.addEventListener("click", function () {
        body.classList.remove("nav-open");
      });
    document.querySelectorAll("#sidebar .nav-link").forEach(function (a) {
      a.addEventListener("click", function () {
        body.classList.remove("nav-open");
      });
    });
  }

  /* -------------------------- Headings + anchors ------------------------ */
  function slug(s) {
    return s
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
  }
  function decorateHeadings() {
    var content = document.querySelector(".content-inner");
    if (!content) return [];
    var hs = content.querySelectorAll("h2, h3");
    var list = [];
    hs.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
      var a = document.createElement("a");
      a.className = "anchor";
      a.href = "#" + h.id;
      a.setAttribute("aria-label", "Link to this section");
      a.innerHTML = svg("link");
      a.querySelector("svg").style.width = "15px";
      a.querySelector("svg").style.height = "15px";
      a.querySelector("svg").style.verticalAlign = "middle";
      h.appendChild(a);
      list.push({ id: h.id, text: h.textContent.trim(), level: h.tagName === "H3" ? 3 : 2 });
    });
    return list;
  }

  /* ------------------------------- TOC ---------------------------------- */
  function buildTOC(headings) {
    var el = document.getElementById("toc");
    if (!el || !headings.length) return;
    var html = '<div class="toc-title">On this page</div>';
    headings.forEach(function (h) {
      html +=
        '<a href="#' +
        h.id +
        '" class="' +
        (h.level === 3 ? "lvl-3" : "") +
        '">' +
        h.text +
        "</a>";
    });
    el.innerHTML = html;

    var links = el.querySelectorAll("a");
    var map = {};
    links.forEach(function (a) {
      map[a.getAttribute("href").slice(1)] = a;
    });
    if ("IntersectionObserver" in window) {
      var visible = {};
      var obs = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            visible[e.target.id] = e.isIntersecting;
          });
          var active = null;
          headings.forEach(function (h) {
            if (visible[h.id] && !active) active = h.id;
          });
          links.forEach(function (a) {
            a.classList.remove("active");
          });
          if (active && map[active]) map[active].classList.add("active");
        },
        { rootMargin: "-70px 0px -70% 0px", threshold: 0 }
      );
      headings.forEach(function (h) {
        var t = document.getElementById(h.id);
        if (t) obs.observe(t);
      });
    }
  }

  /* --------------------------- Copy buttons ----------------------------- */
  function initCopy() {
    var pres = document.querySelectorAll(".content pre");
    pres.forEach(function (pre) {
      if (pre.closest(".terminal") || pre.closest(".diagram")) return;
      var block = pre.closest(".code-block");
      if (!block) {
        block = document.createElement("div");
        block.className = "code-block";
        pre.parentNode.insertBefore(block, pre);
        block.appendChild(pre);
      }
      var lang = block.getAttribute("data-lang");
      if (lang && !block.querySelector(".code-label")) {
        var lab = document.createElement("span");
        lab.className = "code-label";
        lab.textContent = lang;
        block.appendChild(lab);
      }
      if (block.querySelector(".copy-btn")) return;
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.innerHTML = svg("copy") + "<span>Copy</span>";
      btn.addEventListener("click", function () {
        var code = pre.innerText;
        var done = function () {
          btn.classList.add("copied");
          btn.innerHTML = svg("check") + "<span>Copied</span>";
          setTimeout(function () {
            btn.classList.remove("copied");
            btn.innerHTML = svg("copy") + "<span>Copy</span>";
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done, done);
        } else {
          var ta = document.createElement("textarea");
          ta.value = code;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
          } catch (e) {}
          document.body.removeChild(ta);
          done();
        }
      });
      block.appendChild(btn);
    });
  }

  /* ------------------------------ Search -------------------------------- */
  function initSearch() {
    var input = document.getElementById("searchInput");
    var box = document.getElementById("searchResults");
    if (!input || !box) return;
    var idx = window.SEARCH_INDEX || [];
    var results = [];
    var sel = -1;

    function score(entry, q) {
      var hay = (entry.t + " " + (entry.g || "") + " " + (entry.d || "")).toLowerCase();
      var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      var s = 0;
      for (var i = 0; i < terms.length; i++) {
        var idxOf = hay.indexOf(terms[i]);
        if (idxOf === -1) return 0;
        s += 10 - Math.min(9, idxOf / 8);
        if (entry.t.toLowerCase().indexOf(terms[i]) !== -1) s += 8;
      }
      return s;
    }

    function render() {
      if (!results.length) {
        box.innerHTML = '<div class="sr-empty">No matches. Try another term.</div>';
        box.classList.add("open");
        return;
      }
      box.innerHTML = results
        .map(function (r, i) {
          return (
            '<a href="' +
            r.u +
            '" data-i="' +
            i +
            '" class="' +
            (i === sel ? "active" : "") +
            '"><div class="sr-title">' +
            r.t +
            '</div><div class="sr-group">' +
            (r.g || "") +
            (r.d ? " \u2014 " + r.d : "") +
            "</div></a>"
          );
        })
        .join("");
      box.classList.add("open");
    }

    function search(q) {
      if (!q.trim()) {
        box.classList.remove("open");
        results = [];
        return;
      }
      results = idx
        .map(function (e) {
          return { e: e, s: score(e, q) };
        })
        .filter(function (x) {
          return x.s > 0;
        })
        .sort(function (a, b) {
          return b.s - a.s;
        })
        .slice(0, 12)
        .map(function (x) {
          return x.e;
        });
      sel = -1;
      render();
    }

    input.addEventListener("input", function () {
      search(input.value);
    });
    input.addEventListener("focus", function () {
      if (input.value.trim()) search(input.value);
    });
    input.addEventListener("keydown", function (e) {
      if (!box.classList.contains("open")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(results.length - 1, sel + 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, sel - 1);
        render();
      } else if (e.key === "Enter") {
        if (sel >= 0 && results[sel]) location.href = results[sel].u;
        else if (results[0]) location.href = results[0].u;
      } else if (e.key === "Escape") {
        box.classList.remove("open");
        input.blur();
      }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest("#search")) box.classList.remove("open");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== input) {
        var tag = (document.activeElement.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        e.preventDefault();
        input.focus();
      }
    });
  }

  /* ---------------------------- Highlight ------------------------------- */
  function initHighlight() {
    if (window.hljs) {
      try {
        document.querySelectorAll("pre code").forEach(function (b) {
          if (!b.closest(".terminal")) window.hljs.highlightElement(b);
        });
      } catch (e) {}
    }
  }

  /* ------------------------------- Init --------------------------------- */
  function init() {
    buildTopbar();
    buildSidebar();
    initTheme();
    initMobile();
    var headings = decorateHeadings();
    buildTOC(headings);
    initCopy();
    initSearch();
    initHighlight();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
