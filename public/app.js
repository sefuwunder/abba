/* Abba client — a quiet single-user notepad, modeled after Apple Notes:
   folders, lists, large titles, hairlines, quiet gold. No sign-in (access is
   gated one layer up, by Deck). No communications — nothing leaves this device. */
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app"), tabbar = $("#tabbar"), toastEl = $("#toast");
const state = { filter: "" };

/* ---------- tasks: markdown checklists drive the daily letter ---------- */
const TASK_RE = /^(\s*[-*]\s+)\[([ xX])\](\s+.*)$/;
function taskStats(body) {
  const lines = String(body || "").split("\n");
  let total = 0, open = 0, inPre = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) { inPre = !inPre; continue; }
    if (inPre) continue;
    const m = raw.match(TASK_RE);
    if (m) { total++; if (m[2] === " ") open++; }
  }
  return { total, open, done: total - open };
}
/** Flip the nth checklist item in a body. Returns the new body. */
function toggleTask(body, idx) {
  const lines = String(body || "").split("\n");
  let n = -1, inPre = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^```/.test(raw)) { inPre = !inPre; continue; }
    if (inPre) continue;
    const m = raw.match(TASK_RE);
    if (m) {
      n++;
      if (n === idx) {
        lines[i] = m[1] + "[" + (m[2] === " " ? "x" : " ") + "]" + m[3];
        break;
      }
    }
  }
  return lines.join("\n");
}

/* ---------- smart topic folders: max 3, from tags + content ---------- */
const STOPWORDS = new Set(("a,an,the,and,or,but,in,on,at,to,for,of,with,is,are,was,were,be,been,being," +
  "have,has,had,do,does,did,will,would,should,could,this,that,these,those,it,its,as,by,from," +
  "not,no,yes,if,then,than,so,such,into,out,up,down,over,under,again,once,here,there,when," +
  "where,which,who,whom,what,how,all,any,both,each,few,more,most,other,some,only,own,same," +
  "too,very,can,just,about,after,before,between,during,through,while,because,until,against,among,per,via").split(","));
function sigWords(notes) {
  const freq = new Map();
  for (const n of notes) {
    const words = ((n.title || "") + " " + (n.body || "")).toLowerCase().match(/[^\W_]{4,}/gu) || [];
    for (const w of words) {
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
}
function topicFolders(notes) {
  const tagIds = new Map();
  for (const n of notes) {
    for (const t of (n.tags || [])) {
      const tag = String(t).trim().toLowerCase();
      if (!tag) continue;
      if (!tagIds.has(tag)) tagIds.set(tag, new Set());
      tagIds.get(tag).add(n.id);
    }
  }
  const byId = new Map(notes.map(n => [n.id, n]));
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [tag, ids] of tagIds) {
    const seeds = [...ids].map(id => byId.get(id)).filter(Boolean);
    const patterns = [tag, ...sigWords(seeds).filter(w => w !== tag)]
      .map(w => new RegExp(`\\b${escRe(w)}\\b`, "i"));
    for (const n of notes) {
      if (ids.has(n.id)) continue;
      const text = (n.title || "") + "\n" + (n.body || "");
      if (patterns.some(re => re.test(text))) ids.add(n.id);
    }
  }
  return [...tagIds.entries()]
    .map(([tag, ids]) => {
      const ns = [...ids].map(id => byId.get(id)).filter(Boolean);
      const recent = ns.reduce((a, n) => Math.max(a, Date.parse(n.updatedAt) || 0), 0);
      return { tag, notes: ns, recent };
    })
    .filter(f => f.notes.length > 0)
    .sort((a, b) => b.notes.length - a.notes.length || b.recent - a.recent)
    .slice(0, 3);
}
const capTag = t => t.charAt(0).toUpperCase() + t.slice(1);

/* ---------- tiny markdown ---------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function md(src) {
  const lines = String(src || "").split("\n");
  let html = "", inUl = false, inOl = false, inPre = false, inMer = false, para = [], taskIdx = 0;
  const flushPara = () => { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
  const closeLists = () => { if (inUl) { html += "</ul>"; inUl = false; } if (inOl) { html += "</ol>"; inOl = false; } };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) {
      flushPara(); closeLists();
      if (inPre) { html += inMer ? "</pre>" : "</code></pre>"; inPre = false; inMer = false; }
      else if (line.slice(3).trim().toLowerCase() === "mermaid") { html += '<pre class="mermaid">'; inPre = true; inMer = true; }
      else { html += "<pre><code>"; inPre = true; }
      continue;
    }
    if (inPre) { html += esc(line) + "\n"; continue; }
    if (/^\s*$/.test(line)) { flushPara(); closeLists(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flushPara(); closeLists(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^---+$/.test(line.trim())) { flushPara(); closeLists(); html += "<hr>"; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); closeLists(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/))) {
      flushPara(); if (inOl) { html += "</ol>"; inOl = false; } if (!inUl) { html += "<ul>"; inUl = true; }
      const checked = m[1] !== " ", ti = taskIdx++;
      html += `<li class="task"><button class="cbox${checked ? " on" : ""}" data-task="${ti}" aria-label="${checked ? "Reopen task" : "Complete task"}">${checked ? "✓" : ""}</button><span>${inline(m[2])}</span></li>`;
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (inOl) { html += "</ol>"; inOl = false; } if (!inUl) { html += "<ul>"; inUl = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { flushPara(); if (inUl) { html += "</ul>"; inUl = false; } if (!inOl) { html += "<ol>"; inOl = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    para.push(line);
  }
  flushPara(); closeLists();
  if (inPre) html += inMer ? "</pre>" : "</code></pre>";
  return html;
}

/* ---------- mermaid ---------- */
let mermaidLoading = null;
function renderMermaid() {
  if (!document.querySelector("pre.mermaid:not([data-mermaid])")) return;
  const run = () => {
    try {
      const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: dark ? {
          darkMode: true, background: "transparent",
          primaryColor: "#2E2620", primaryTextColor: "#EDE4D3", primaryBorderColor: "#C9973F",
          lineColor: "#C9973F", secondaryColor: "#241D16", tertiaryColor: "#1E1813",
          edgeLabelBackground: "#2E2620",
        } : {
          background: "transparent",
          primaryColor: "#FFFDF9", primaryTextColor: "#3A2E1E", primaryBorderColor: "#A07E1C",
          lineColor: "#A07E1C", secondaryColor: "#F7F1E6", tertiaryColor: "#FFFFFF",
          edgeLabelBackground: "#FFFDF9",
        },
        flowchart: { curve: "basis" },
      });
      const ran = window.mermaid.run({ querySelector: "pre.mermaid:not([data-mermaid])" });
      if (ran && ran.catch) ran.catch(() => {});
      document.querySelectorAll("pre.mermaid:not([data-mermaid])").forEach(el => el.setAttribute("data-mermaid", "1"));
    } catch (e) { /* leave the source readable */ }
  };
  if (window.mermaid) { run(); return; }
  if (!mermaidLoading) {
    mermaidLoading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "/vendor/mermaid.min.js?v=11.4.1";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    mermaidLoading.then(run, () => {});
  } else {
    mermaidLoading.then(run, () => {});
  }
}

/* ---------- api (no auth — access is gated by Deck) ---------- */
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
  return data;
}
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("show"), 2600);
}
function relTime(iso) {
  const d = new Date(iso), now = new Date();
  const s = Math.max(1, Math.floor((now - d) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const days = Math.floor(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return days + "d ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
function weekKey(d) {
  d = d || new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day);
  return t.toISOString().slice(0, 10);
}
function weekRangeLabel(wk) {
  const m = wk.match(/(\d+)-(\d+)-(\d+)/);
  if (!m) return wk;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + (+m[2] - 1) * 7);
  const sun = new Date(t.getTime() + 6 * 864e5);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return f(t) + " – " + f(sun);
}
const STATUS_LABEL = { seed: "Seed", sprout: "Sprout", motion: "In motion", decided: "Decided", resting: "Resting" };
const STATUS_FLOW = ["seed", "sprout", "motion", "decided"];

function plainExcerpt(body) {
  const line = String(body || "").split("\n").filter(l => l.trim() && !/^#{1,3}\s/.test(l.trim()))[0] || "";
  return line.replace(/^[-*>\d.\s]+/, "").replace(/(\*\*|__)([^*_]+)\1/g, "$2").replace(/[*_`~]/g, "").trim().slice(0, 120);
}
function folderSvg(kind) {
  if (kind === "letters") {
    return '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="#E3B23C"/><path d="M3.5 7.5 12 13.5l8.5-6" stroke="#B9862A" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M2.5 6.5a2 2 0 0 1 2-2h5l2 2.4h8a2 2 0 0 1 2 2V18a2 2 0 0 1 2-2V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="#EBCB5E"/><path d="M2.5 9.5h19V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="#E3B23C"/></svg>';
}

/* ---------- shell ---------- */
const TABS = [
  ["#/folders", "✎", "Notes", "notes"],
  ["#/settings", "⚙", "Settings", "settings"],
];
function renderTabs(active) {
  tabbar.hidden = false;
  tabbar.innerHTML = TABS.map(([href, g, label, key]) =>
    `<button class="tab${key === active ? " on" : ""}" data-go="${href}"><span class="g">${g}</span>${esc(label)}</button>`
  ).join("");
  tabbar.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
}
function nudgeHtml(nudges) {
  return (nudges || []).map(n => `
    <div class="nudge" data-nudge="${esc(n.key)}"><span>✦</span>
      <span>${esc(n.text)} ${n.noteId ? `<button class="go" data-open="${n.noteId}">open</button>` : ""}</span>
      <button class="x" data-dismiss="${esc(n.key)}" aria-label="dismiss">×</button>
    </div>`).join("");
}
function bindNudges(root) {
  root.querySelectorAll("[data-dismiss]").forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    await api("/api/nudges/dismiss", { method: "POST", body: JSON.stringify({ key: b.dataset.dismiss }) }).catch(() => {});
    const el = b.closest(".nudge"); if (el) el.remove();
  });
  root.querySelectorAll("[data-open]").forEach(b => b.onclick = (e) => { e.stopPropagation(); location.hash = "#/note/" + b.dataset.open; });
}

/* ---------- folders (home) ---------- */
async function viewFolders() {
  renderTabs("notes");
  const [nudges, notes, letters] = await Promise.all([
    api("/api/nudges").then(d => d.nudges).catch(() => []),
    api("/api/notes").then(d => d.notes).catch(() => []),
    api("/api/digests").then(d => d.digests).catch(() => []),
  ]);
  const topics = topicFolders(notes);
  app.innerHTML = `
    <h1 class="large-greet">${greeting()}.<br>Your notepad.</h1>
    <div id="nudges">${nudgeHtml(nudges)}</div>
    <p class="section-label">Abba</p>
    <div class="group">
      <div class="frow" data-go="#/list/notes">${folderSvg("folder")}
        <span class="frow-name">Notepad</span><span class="frow-count">${notes.length}</span><span class="chev">›</span></div>
      <div class="frow" data-go="#/list/letters">${folderSvg("letters")}
        <span class="frow-name">Weekly Letters</span><span class="frow-count">${letters.length}</span><span class="chev">›</span></div>
    </div>
    ${topics.length ? `
    <p class="section-label">Smart folders</p>
    <div class="group">
      ${topics.map(t => `
      <div class="frow" data-go="#/list/topic/${encodeURIComponent(t.tag)}"><span class="frow-ic">◈</span>
        <span class="frow-name">${esc(capTag(t.tag))}</span><span class="frow-count">${t.notes.length}</span><span class="chev">›</span></div>`).join("")}
    </div>` : ""}
    <p class="foot-note">A quiet notepad. Nothing leaves this device.</p>`;
  bindNudges(app);
  app.querySelectorAll("[data-go]").forEach(r => r.onclick = () => location.hash = r.dataset.go);
}

/* ---------- lists ---------- */
const FOLDER_META = {
  notes: { title: "Notepad", back: "Folders", compose: true },
  letters: { title: "Weekly Letters", back: "Folders", compose: false },
};
async function viewList(kind) {
  renderTabs("notes");
  const meta = FOLDER_META[kind] || FOLDER_META.notes;
  let items = [];
  if (kind === "letters") {
    const { digests } = await api("/api/digests").catch(() => ({ digests: [] }));
    items = [{ kind: "today" }];
    items.push(...digests.map(d => ({ kind: "letter", id: d.weekKey, weekKey: d.weekKey })));
  } else {
    const { notes } = await api("/api/notes").catch(() => ({ notes: [] }));
    items = notes.map(n => ({ kind: "note", id: n.id, note: n }));
  }
  const renderRows = (q) => {
    const query = q.trim().toLowerCase();
    const list = items.filter(it => {
      if (!query) return true;
      if (it.kind === "today") return "today your tasks, gathered".includes(query);
      if (it.kind === "letter") return it.weekKey.toLowerCase().includes(query);
      return (it.note.title + " " + it.note.body).toLowerCase().includes(query);
    });
    if (!list.length) {
      const empty = query ? "Nothing matches “" + esc(q.trim()) + "”."
        : kind === "letters" ? "No letters yet.<br>The first one arrives Monday."
        : "Nothing here yet.";
      return `<div class="empty-state">${empty}</div>`;
    }
    return list.map(it => {
      if (it.kind === "today") {
        return `<div class="nrow" data-today="1">
          <div class="nr-title">Today</div>
          <div class="nr-sub">Your tasks, gathered</div></div>`;
      }
      if (it.kind === "letter") {
        const isThis = it.weekKey === weekKey();
        return `<div class="nrow" data-letter="${esc(it.weekKey)}">
          <div class="nr-title">${isThis ? "This week" : "Week of " + esc(weekRangeLabel(it.weekKey).split(" – ")[0])}</div>
          <div class="nr-sub">${esc(weekRangeLabel(it.weekKey))}</div></div>`;
      }
      const n = it.note;
      return `<div class="nrow" data-note="${n.id}">
        <div class="nr-title">${esc(n.title)}</div>
        <div class="nr-sub">${relTime(n.updatedAt)} · ${STATUS_LABEL[n.status] || n.status} — ${esc(plainExcerpt(n.body))}</div></div>`;
    }).join("");
  };
  app.innerHTML = `
    <button class="back" data-go="#/folders">‹ ${meta.back}</button>
    <h1 class="large-title">${esc(meta.title)}</h1>
    <p class="list-count">${items.length} ${items.length === 1 ? (kind === "letters" ? "letter" : "note") : (kind === "letters" ? "letters" : "notes")}</p>
    <div class="search"><span class="s-ic">⌕</span><input id="q" placeholder="Search" autocomplete="off"></div>
    <div class="ngroup" id="rows">${renderRows("")}</div>
    ${meta.compose ? `<button class="fab" id="compose" aria-label="New note">✎</button>` : ""}`;
  app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
  const q = $("#q");
  q.addEventListener("input", () => { $("#rows").innerHTML = renderRows(q.value); bindRows(); });
  const bindRows = () => {
    app.querySelectorAll("[data-note]").forEach(r => r.onclick = () => location.hash = "#/note/" + r.dataset.note);
    app.querySelectorAll("[data-letter]").forEach(r => r.onclick = () => location.hash = "#/letter/" + r.dataset.letter);
    app.querySelectorAll("[data-today]").forEach(r => r.onclick = () => location.hash = "#/letter/today");
  };
  bindRows();
  const fab = $("#compose");
  if (fab) fab.onclick = () => location.hash = "#/compose";
}

/* ---------- topic folder ---------- */
async function viewTopic(tag) {
  renderTabs("notes");
  const { notes } = await api("/api/notes").catch(() => ({ notes: [] }));
  const folder = topicFolders(notes).find(f => f.tag === tag);
  const items = folder ? folder.notes : [];
  app.innerHTML = `
    <button class="back" data-go="#/folders">‹ Folders</button>
    <h1 class="large-title">${esc(capTag(tag))}</h1>
    <p class="list-count">${items.length} ${items.length === 1 ? "note" : "notes"}</p>
    <div class="search"><span class="s-ic">⌕</span><input id="q" placeholder="Search" autocomplete="off"></div>
    <div class="ngroup" id="rows"></div>`;
  const renderRows = (q) => {
    const query = q.trim().toLowerCase();
    const list = items.filter(n => !query || (n.title + " " + n.body).toLowerCase().includes(query));
    if (!list.length) return `<div class="empty-state">${query ? "Nothing matches “" + esc(q.trim()) + "”." : "Nothing gathered here yet."}</div>`;
    return list.map(n => `<div class="nrow" data-note="${n.id}">
        <div class="nr-title">${esc(n.title)}</div>
        <div class="nr-sub">${relTime(n.updatedAt)} · ${STATUS_LABEL[n.status] || n.status} — ${esc(plainExcerpt(n.body))}</div></div>`).join("");
  };
  const rows = $("#rows"), q = $("#q");
  const bind = () => rows.querySelectorAll("[data-note]").forEach(r => r.onclick = () => location.hash = "#/note/" + r.dataset.note);
  rows.innerHTML = renderRows("");
  bind();
  q.addEventListener("input", () => { rows.innerHTML = renderRows(q.value); bind(); });
  app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
}

/* ---------- compose ---------- */
async function viewCompose() {
  renderTabs("notes");
  const draftKey = "abba_draft";
  const draft = JSON.parse(localStorage.getItem(draftKey) || '{"title":"","body":"","tags":""}');
  app.innerHTML = `
    <div class="editbar"><button class="back" id="bk">‹ Notepad</button>
      <button class="done-btn" id="done">Done</button></div>
    <input id="c-title" class="title-input" placeholder="Title" value="${esc(draft.title)}" maxlength="120">
    <textarea id="c-body" class="body-input" placeholder="Start writing…">${esc(draft.body)}</textarea>
    <input id="c-tags" class="tags-input" placeholder="tags, separated by commas" value="${esc(draft.tags)}">`;
  const titleEl = $("#c-title"), bodyEl = $("#c-body"), tagsEl = $("#c-tags");
  const fit = () => { bodyEl.style.height = "auto"; bodyEl.style.height = Math.max(300, bodyEl.scrollHeight) + "px"; };
  fit();
  let t;
  const saveDraft = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const v = { title: titleEl.value, body: bodyEl.value, tags: tagsEl.value };
      if (v.title.trim() || v.body.trim()) localStorage.setItem(draftKey, JSON.stringify(v));
      else localStorage.removeItem(draftKey);
    }, 500);
  };
  [titleEl, bodyEl, tagsEl].forEach(el => el.addEventListener("input", () => { fit(); saveDraft(); }));
  $("#bk").onclick = () => { location.hash = "#/list/notes"; };
  $("#done").onclick = async () => {
    const body = bodyEl.value.trim();
    if (!body && !titleEl.value.trim()) { location.hash = "#/list/notes"; return; }
    if (!body) { toast("Write something first — even a fragment."); return; }
    try {
      const { note } = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: titleEl.value, body,
          tags: tagsEl.value.split(",").map(x => x.trim()).filter(Boolean),
        }),
      });
      localStorage.removeItem(draftKey);
      toast("Kept in your notepad.");
      location.hash = "#/note/" + note.id;
    } catch (e) { toast(e.message); }
  };
  titleEl.focus();
}

/* ---------- note detail ---------- */
const ZEN_STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const ZEN = {
  seed: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M13 4.5c3.2 4.3 4.2 9 0 13.5-4.2-4.5-3.2-9.2 0-13.5z"/></svg>',
  sprout: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M13 21.5v-9"/><path d="M13 15.5c-3.6-.4-5.8-2.4-6.3-6.2 3.6.4 5.8 2.4 6.3 6.2z"/><path d="M13 12.5c3.6-.4 5.8-2.4 6.3-6.2-3.6.4-5.8 2.4-6.3 6.2z"/></svg>',
  motion: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M4 9.5c2.5-1.8 5 1.8 7.5 0s5 1.8 7.5 0"/><path d="M4 14.5c2.5-1.8 5 1.8 7.5 0s5 1.8 7.5 0"/><path d="M4 19.5c2.5-1.8 5 1.8 7.5 0s5 1.8 7.5 0"/></svg>',
  decided: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M21.3 13a8.3 8.3 0 1 1-2.5-5.9"/></svg>',
  resting: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M19.8 14.8A7.8 7.8 0 1 1 11.2 5.4a6.2 6.2 0 0 0 8.6 9.4z"/></svg>',
  edit: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M5 19.5l1.2-4.2L16.7 4.8a2 2 0 0 1 2.8 2.8L9 18.1z"/><path d="M14.8 6.7l2.8 2.8"/></svg>',
  export: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M13 4.5V15"/><path d="M8.8 11.2L13 15.4l4.2-4.2"/><path d="M5.5 19.5h15"/></svg>',
  del: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M5 7h16"/><path d="M9.5 7V5h7v2"/><path d="M7 7l1 13.5h8L17 7"/><path d="M10.8 10.5v7M15.2 10.5v7"/></svg>',
};
function orbHtml(note) {
  const items = [];
  STATUS_FLOW.forEach(s => items.push({ kind: "status", key: s, label: STATUS_LABEL[s], active: note.status === s }));
  items.push({ kind: "status", key: "resting", label: note.status === "resting" ? "Wake up" : "Rest", active: note.status === "resting" });
  items.push({ kind: "act", key: "edit", label: "Edit" });
  items.push({ kind: "act", key: "export", label: "Export" });
  items.push({ kind: "act", key: "del", label: "Delete" });
  const n = items.length, step = n > 1 ? 180 / (n - 1) : 0;
  const sats = items.map((it, i) => {
    const a = 180 + i * step;
    const inner = (ZEN[it.key] || '<span class="c-label">' + esc(it.label) + "</span>");
    return '<button class="c-item' + (it.active ? " on" : "") + (it.key === "del" ? " danger" : "") + '" data-ck="' + it.kind + '" data-ckey="' + it.key + '"' +
      ' style="--a:' + a.toFixed(1) + 'deg;--i:' + i + '" aria-label="' + esc(it.label || it.key) + '">' + inner + "</button>";
  }).join("");
  const hint = localStorage.getItem("abba_orb_seen")
    ? ""
    : '<div class="orb-hint" id="orbhint">Tap for more</div>';
  const enso = '<svg class="enso" viewBox="0 0 60 60" aria-hidden="true"><path d="M30 7 C43 7 53 17 53 30 C53 43 43 52 30 53 C17 54 7 44 7 31 C7 19 16 8 28 7" fill="none" stroke="#A08C5B" stroke-width="3.4" stroke-linecap="round"/></svg>';
  const tchev = '<svg class="tchev" viewBox="0 0 12 8" aria-hidden="true"><path d="M1.5 1.5 L6 6 L10.5 1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return '<div class="orb-wrap" id="cstage" style="--r:145px">' + sats +
    '<button class="orb-toggle" id="ctoggle" aria-label="More actions">' + enso + tchev + "</button>" +
    hint + "</div>";
}
function relatedHtml(related) {
  if (!related.length) return "";
  const rows = related.map(function (r) {
    return '<div class="nrow" data-note="' + r.id + '"><div class="nr-title">' + esc(r.title) + "</div></div>";
  }).join("");
  return '<p class="section-label">Related</p><div class="ngroup">' + rows + "</div>";
}
let convoState = { id: null, open: false };
function convoOpen() { return convoState.open; }
function commentsHtml(note, open) {
  const n = note.comments.length;
  if (!n) return "";
  let body = "";
  if (open) {
    const list = note.comments.map(function (c) {
      return '<div class="comment"><div class="who"><b>' + (esc(c.author) || "Note to self") + "</b><span>" + relTime(c.createdAt) + '</span><button class="go" data-cdel="' + c.id + '">delete</button></div><p>' + esc(c.body) + "</p></div>";
    }).join("");
    body = '<div class="card" style="margin-top:6px"><div id="comments">' + list + "</div>" +
      '<div class="comment-box"><input id="cbox" placeholder="Add a margin note…" maxlength="5000">' +
      '<button class="btn btn-primary" id="csend">↩</button></div></div>';
  }
  return '<button class="convo-toggle" id="convo-toggle"><span>💬</span><span>' +
    esc(n + (n === 1 ? " margin note" : " margin notes")) +
    '</span><span class="chev">' + (open ? "▾" : "▸") + "</span></button>" + body;
}
function bindConvo(note, id) {
  const t = $("#convo-toggle");
  if (t) t.onclick = () => {
    convoState.open = !convoState.open;
    const w = $("#convo-wrap");
    if (w) { w.innerHTML = commentsHtml(note, convoState.open); bindConvo(note, id); }
  };
  const s = $("#csend");
  if (s) s.onclick = async () => {
    const v = $("#cbox").value.trim();
    if (!v) return;
    try {
      await api("/api/notes/" + id + "/comments", { method: "POST", body: JSON.stringify({ body: v }) });
      convoState.open = true;
      viewDetail(id, false);
    } catch (e) { toast(e.message); }
  };
  const box = $("#cbox");
  if (box) box.addEventListener("keydown", e => { if (e.key === "Enter") $("#csend").click(); });
  app.querySelectorAll("[data-cdel]").forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    if (!confirm("Delete this margin note?")) return;
    try {
      await api("/api/notes/" + id + "/comments/" + b.dataset.cdel, { method: "DELETE" });
      viewDetail(id, false);
    } catch (err) { toast(err.message); }
  });
}
async function downloadNote(id) {
  try {
    const res = await fetch("/api/notes/" + id + "/export");
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "abba-" + id + ".md";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message); }
}
/* note editor */
function editorHtml(note) {
  return '<div class="editbar"><button class="back" id="e-cancel">‹ Cancel</button>' +
    '<button class="done-btn" id="e-save">Done</button></div>' +
    '<input id="e-title" class="title-input" value="' + esc(note.title) + '" maxlength="120">' +
    '<div class="toolbar">' +
    '<button class="tool" data-md="**bold**">B</button><button class="tool" data-md="*italic*">I</button>' +
    '<button class="tool" data-md="## ">H</button><button class="tool" data-md="- ">• List</button>' +
    '<button class="tool" data-md="- [ ] ">☐ Task</button>' +
    '<button class="tool" data-md="> ">❝ Quote</button>' +
    "</div>" +
    '<textarea id="e-body" class="body-input">' + esc(note.body) + "</textarea>" +
    '<input id="e-tags" class="tags-input" placeholder="tags, separated by commas" value="' + esc(note.tags.join(", ")) + '">';
}
function detailBodyHtml(note, related) {
  const tags = note.tags.length
    ? '<div class="tags">' + note.tags.map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>"
    : "";
  return '<button class="back" data-go="#/list/notes">‹ Notepad</button>' +
    '<h1 class="note-title">' + esc(note.title) + "</h1>" +
    '<p class="note-meta">' + relTime(note.updatedAt) + " · ◷ " + note.readMins + " min</p>" +
    tags + '<div class="reader">' + md(note.body) + "</div>" +
    orbHtml(note) + relatedHtml(related) +
    '<div id="convo-wrap">' + commentsHtml(note, convoOpen()) + "</div>";
}
async function viewDetail(id, editing) {
  renderTabs("notes");
  let note;
  try { note = (await api("/api/notes/" + id)).note; }
  catch (e) {
    app.innerHTML = '<button class="back" data-go="#/folders">‹ Folders</button><div class="empty-state">That note isn\'t here anymore.</div>';
    app.querySelector("[data-go]").onclick = (ev) => location.hash = ev.target.closest("[data-go]").dataset.go;
    return;
  }
  const related = await api("/api/notes/" + id + "/related").then(d => d.related).catch(() => []);
  if (convoState.id !== id) convoState = { id: id, open: false };
  app.innerHTML = editing ? editorHtml(note) : detailBodyHtml(note, related);
  app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
  const bindNoteRows = () => app.querySelectorAll(".nrow[data-note]").forEach(r => r.onclick = () => location.hash = "#/note/" + r.dataset.note);
  bindNoteRows();

  if (editing) {
    const ta = $("#e-body");
    const fit = () => { ta.style.height = "auto"; ta.style.height = Math.max(300, ta.scrollHeight) + "px"; };
    fit();
    ta.addEventListener("input", fit);
    app.querySelectorAll("[data-md]").forEach(b => b.onclick = () => {
      const s = ta.selectionStart || 0, ins = b.dataset.md;
      ta.value = ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd || 0);
      ta.focus();
    });
    $("#e-cancel").onclick = () => viewDetail(id, false);
    $("#e-save").onclick = async () => {
      try {
        await api("/api/notes/" + id, {
          method: "PATCH",
          body: JSON.stringify({
            title: $("#e-title").value, body: ta.value,
            tags: $("#e-tags").value.split(",").map(t => t.trim()).filter(Boolean),
          }),
        });
        toast("Saved.");
        viewDetail(id, false);
      } catch (e) { toast(e.message); }
    };
    return;
  }
  const stage = $("#cstage"), ctoggle = $("#ctoggle");
  const bindTasks = () => {
    app.querySelectorAll(".reader .cbox").forEach(b => {
      b.onclick = async (e) => {
        e.preventDefault();
        const body = toggleTask(note.body, Number(b.dataset.task));
        if (body === note.body) return;
        b.disabled = true;
        try {
          const d = await api("/api/notes/" + note.id, { method: "PATCH", body: JSON.stringify({ body }) });
          note.body = d.note.body;
          const reader = app.querySelector(".reader");
          if (reader) { reader.innerHTML = md(note.body); bindTasks(); }
        } catch (err) { toast(err.message); b.disabled = false; }
      };
    });
  };
  bindTasks();
  if (stage && ctoggle) {
    ctoggle.onclick = () => {
      const open = stage.classList.toggle("open");
      ctoggle.setAttribute("aria-label", open ? "Close" : "More actions");
      const hint = $("#orbhint");
      if (hint) hint.remove();
      try { localStorage.setItem("abba_orb_seen", "1"); } catch (e) { /* private mode */ }
    };
    try {
      const seen = localStorage.getItem("abba_orb_seen");
      const reduce = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (!seen && !reduce) {
        localStorage.setItem("abba_orb_seen", "1");
        setTimeout(() => {
          if (!document.body.contains(stage)) return;
          stage.classList.add("open");
          ctoggle.setAttribute("aria-label", "Close");
        }, 700);
        setTimeout(() => {
          if (!document.body.contains(stage)) return;
          stage.classList.remove("open");
          ctoggle.setAttribute("aria-label", "More actions");
          const hint = $("#orbhint");
          if (hint) hint.remove();
        }, 2100);
      }
    } catch (e) { /* private mode */ }
    app.querySelectorAll(".c-item").forEach(b => b.onclick = async () => {
      const kind = b.dataset.ck, key = b.dataset.ckey;
      try {
        if (kind === "status") {
          await api("/api/notes/" + id, { method: "PATCH", body: JSON.stringify({ status: key }) });
          toast(key === "decided" ? "Marked decided. Nice." : "Updated.");
        } else if (kind === "act") {
          if (key === "edit") { viewDetail(id, true); return; }
          if (key === "export") { downloadNote(id); return; }
          if (key === "del") {
            if (!confirm("Delete this note for good?")) return;
            await api("/api/notes/" + id, { method: "DELETE" });
            toast("Deleted.");
            location.hash = "#/list/notes";
            return;
          }
        }
        viewDetail(id, false);
      } catch (e) { toast(e.message); }
    });
  }
  bindConvo(note, id);
  renderMermaid();
}

/* ---------- weekly letter ---------- */
async function viewLetter(weekKeyParam) {
  renderTabs("notes");
  const isToday = weekKeyParam === "today";
  let digest;
  try { digest = (await api(isToday ? "/api/digest/today" : "/api/digest?week=" + encodeURIComponent(weekKeyParam))).digest; }
  catch (e) {
    app.innerHTML = '<button class="back" data-go="#/list/letters">‹ Weekly Letters</button><div class="empty-state">That letter isn\'t on the shelf.</div>';
    app.querySelector("[data-go]").onclick = (ev) => location.hash = ev.target.closest("[data-go]").dataset.go;
    return;
  }
  const subtitle = isToday ? (digest.subtitle || "") : weekRangeLabel(digest.weekKey);
  const emptyHtml = isToday
    ? `<div class="digest-empty">${esc(digest.emptyText || "Nothing here yet.").replace(/\n/g, "<br>")}</div>`
    : `<div class="digest-empty">A quiet week.<br>Sometimes the best ideas are still forming.</div>`;
  app.innerHTML = `
    <button class="back" data-go="#/list/letters">‹ Weekly Letters</button>
    <h1 class="note-title">${esc(digest.title)}</h1>
    <p class="note-meta">${esc(subtitle)}</p>
    <div class="card digest-letter">
      ${digest.empty ? emptyHtml : `
        <p class="intro">${esc(digest.intro)}</p>
        ${digest.sections.map(s => `<h3>${esc(s.heading)}</h3><ul>${s.lines.map(l => `<li>${inline(l)}</li>`).join("")}</ul>`).join("")}
        ${isToday ? "" : `<p class="intro" style="margin-top:22px">Carry one of these into next week — that's plenty.</p>`}`}
    </div>`;
  app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
}

/* ---------- settings ---------- */
async function viewSettings() {
  renderTabs("settings");
  app.innerHTML = `
    <h1 class="large-title">Settings</h1>
    <p class="section-label">Backup</p>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Your notes as one JSON file — keep it somewhere safe.</p>
      <div class="btn-row">
        <button class="btn btn-ghost" id="bk-export">Download backup</button>
        <label class="btn btn-ghost" style="cursor:pointer">Import backup<input id="bk-file" type="file" accept=".json,application/json" style="display:none"></label>
      </div>
    </div>
    <p class="section-label">About</p>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Abba is a single-user notepad. There is no sign-in — this page is reachable only on this machine, and Deck's sign-in guards the way in.</p>
      <div class="btn-row" id="install-row" style="display:none">
        <button class="btn btn-ghost" id="acc-install">Install Abba on this device</button>
      </div>
    </div>
    <p class="foot-note">S · E · F · U — soulfulness, effectiveness, flow, unity.</p>`;
  $("#bk-export").onclick = async () => {
    try {
      const res = await fetch("/api/backup");
      if (!res.ok) throw new Error("Backup failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "abba-backup.json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast(e.message); }
  };
  $("#bk-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const r = await api("/api/backup", { method: "POST", body: JSON.stringify(data) });
      toast(r.imported + " notes imported.");
      e.target.value = "";
    } catch (err) { toast(err.message); }
  });
  const showInstall = () => {
    const row = $("#install-row");
    if (row && window.__deferredInstall) row.style.display = "";
  };
  window.addEventListener("abba:installable", showInstall);
  showInstall();
  const instBtn = $("#acc-install");
  if (instBtn) instBtn.onclick = async () => {
    const p = window.__deferredInstall;
    if (!p) return;
    window.__deferredInstall = null;
    const row = $("#install-row");
    if (row) row.style.display = "none";
    p.prompt();
    try { await p.userChoice; } catch (e) {}
  };
}

/* ---------- boot & router ---------- */
function route() {
  const h = location.hash || "#/folders";
  window.scrollTo(0, 0);
  if (h.startsWith("#/note/")) { const ed = h.includes("?edit"); viewDetail(h.split("/")[2].split("?")[0], ed); }
  else if (h.startsWith("#/list/")) {
    const parts = h.split("/");
    if (parts[2] === "topic") viewTopic(decodeURIComponent(parts.slice(3).join("/")));
    else viewList(parts[2] || "notes");
  }
  else if (h === "#/compose") viewCompose();
  else if (h.startsWith("#/letter/")) viewLetter(h.split("/")[2]);
  else if (h === "#/settings") viewSettings();
  else viewFolders();
}
window.addEventListener("hashchange", route);
route();
