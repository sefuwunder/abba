/* Abba client — modeled after Apple Notes: folders, lists, large titles,
   hairlines, quiet yellow. The intelligence stays invisible: auto-titles,
   related ideas, the weekly letters and nudges render as plain interface. */
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app"), tabbar = $("#tabbar"), toastEl = $("#toast");
const state = { me: null, circle: null, filter: "", here: [] };

/* ---------- tasks: markdown checklists drive the smart folders ---------- */
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
  }
  mermaidLoading.then(run).catch(() => { mermaidLoading = null; });
}

/* ---------- api ---------- */
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const tok = localStorage.getItem("abba_token");
  if (tok) headers["Authorization"] = "Bearer " + tok;
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
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
/* ISO week key, mirroring the server (for "This week" labels). */
function weekKey(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - first.getTime()) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + "-W" + p(week);
}
function weekRangeLabel(wk) {
  const m = String(wk).match(/(\d+)-W(\d+)/);
  if (!m) return wk;
  const t = new Date(Date.UTC(+m[1], 0, 4));
  const day = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - day + (+m[2] - 1) * 7); // Monday of week 1, plus weeks
  const sun = new Date(t.getTime() + 6 * 864e5);
  const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return f(t) + " – " + f(sun);
}
const STATUS_LABEL = { seed: "Seed", sprout: "Sprout", motion: "In motion", decided: "Decided", resting: "Resting" };
const STATUS_FLOW = ["seed", "sprout", "motion", "decided"];
const REACT_META = { felt: ["❤️", "felt this"], spark: ["💡", "sparked"], yes: ["🙌", "yes"] };

function plainExcerpt(body) {
  const line = String(body || "").split("\n").filter(l => l.trim() && !/^#{1,3}\s/.test(l.trim()))[0] || "";
  return line.replace(/^[-*>\d.\s]+/, "").replace(/(\*\*|__)([^*_]+)\1/g, "$2").replace(/[*_`~]/g, "").trim().slice(0, 120);
}
function folderSvg(kind) {
  if (kind === "letters") {
    return '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="#E3B23C"/><path d="M3.5 7.5 12 13.5l8.5-6" stroke="#B9862A" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M2.5 6.5a2 2 0 0 1 2-2h5l2 2.4h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="#EBCB5E"/><path d="M2.5 9.5h19V18a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="#E3B23C"/></svg>';
}

/* ---------- shell ---------- */
const TABS = [
  ["#/folders", "✎", "Notes", "notes"],
  ["#/members", "◯", "Circle", "circle"],
];
function renderTabs(active) {
  tabbar.hidden = false;
  tabbar.innerHTML = TABS.map(([href, g, label, key]) =>
    `<button class="tab${key === active ? " on" : ""}" data-go="${href}"><span class="g">${g}</span>${label}</button>`).join("");
  tabbar.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
}
function presenceLine() {
  if (!state.here.length) return "";
  const names = state.here.map(h => esc(h.name));
  const who = names.length <= 2 ? names.join(" and ") : names.slice(0, 2).join(", ") + ` and ${names.length - 2} more`;
  return `<p class="presence"><span class="pulse"></span>${who} ${names.length === 1 ? "is" : "are"} here now</p>`;
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
  const [nudges, mine, circle, letters] = await Promise.all([
    api("/api/nudges").then(d => d.nudges).catch(() => []),
    api("/api/notes?scope=mine").then(d => d.notes).catch(() => []),
    api("/api/notes?scope=circle").then(d => d.notes).catch(() => []),
    api("/api/digests").then(d => d.digests).catch(() => []),
  ]);
  const first = esc(state.me.name.split(" ")[0]);
  const smart = mine.map(n => ({ n, st: taskStats(n.body) }));
  const openNotes = smart.filter(t => t.st.total > 0 && t.st.open > 0);
  const doneNotes = smart.filter(t => t.st.total > 0 && t.st.open === 0);
  const openItems = openNotes.reduce((a, t) => a + t.st.open, 0);
  app.innerHTML = `
    <h1 class="large-greet">${greeting()},<br>${first}.</h1>
    <div id="nudges">${nudgeHtml(nudges)}</div>
    <p class="section-label">Abba</p>
    <div class="group">
      <div class="frow" data-go="#/list/mine">${folderSvg("folder")}
        <span class="frow-name">My Notepad</span><span class="frow-count">${mine.length}</span><span class="chev">›</span></div>
      <div class="frow" data-go="#/list/circle">${folderSvg("folder")}
        <span class="frow-name">The Circle</span><span class="frow-count">${circle.length}</span><span class="chev">›</span></div>
      <div class="frow" data-go="#/list/letters">${folderSvg("letters")}
        <span class="frow-name">Weekly Letters</span><span class="frow-count">${letters.length}</span><span class="chev">›</span></div>
    </div>
    <p class="section-label">Smart folders</p>
    <div class="group">
      <div class="frow" data-go="#/list/smart-open"><span class="frow-ic">◔</span>
        <span class="frow-name">Open tasks</span><span class="frow-count">${openNotes.length ? openNotes.length + " notes · " + openItems + " open" : ""}</span><span class="chev">›</span></div>
      <div class="frow" data-go="#/list/smart-done"><span class="frow-ic">✓</span>
        <span class="frow-name">All done</span><span class="frow-count">${doneNotes.length || ""}</span><span class="chev">›</span></div>
    </div>
    <p class="section-label">Circle</p>
    <div class="group">
      <div class="frow" data-go="#/members"><span class="frow-ic">◯</span>
        <span class="frow-name">Members</span><span class="frow-count"></span><span class="chev">›</span></div>
    </div>
    <p class="foot-note">One circle · stays intimate by design.</p>`;
  bindNudges(app);
  app.querySelectorAll("[data-go]").forEach(r => r.onclick = () => location.hash = r.dataset.go);
  heartbeat("folders");
}

/* ---------- notes list ---------- */
const FOLDER_META = {
  mine: { title: "My Notepad", back: "Folders", compose: true },
  circle: { title: "The Circle", back: "Folders", compose: true },
  letters: { title: "Weekly Letters", back: "Folders", compose: false },
  "smart-open": { title: "Open tasks", back: "Folders", compose: false },
  "smart-done": { title: "All done", back: "Folders", compose: false },
};
const SMART_KINDS = { "smart-open": true, "smart-done": true };
async function viewList(kind) {
  renderTabs("notes");
  const meta = FOLDER_META[kind] || FOLDER_META.mine;
  let items = [];
  if (kind === "letters") {
    const { digests } = await api("/api/digests").catch(() => ({ digests: [] }));
    items = digests.map(d => ({ kind: "letter", id: d.weekKey, weekKey: d.weekKey }));
  } else if (SMART_KINDS[kind]) {
    const { notes } = await api("/api/notes?scope=mine").catch(() => ({ notes: [] }));
    items = notes
      .map(n => ({ kind: "note", id: n.id, note: n, st: taskStats(n.body) }))
      .filter(it => it.st.total > 0 && (kind === "smart-open" ? it.st.open > 0 : it.st.open === 0));
  } else {
    const scope = kind === "mine" ? "mine" : "circle";
    const { notes } = await api("/api/notes?scope=" + scope).catch(() => ({ notes: [] }));
    items = notes.map(n => ({ kind: "note", id: n.id, note: n }));
    if (kind === "circle") {
      const { here } = await api("/api/presence").catch(() => ({ here: [] }));
      state.here = here;
    }
  }
  const renderRows = (q) => {
    const query = q.trim().toLowerCase();
    const list = items.filter(it => {
      if (!query) return true;
      if (it.kind === "letter") return it.weekKey.toLowerCase().includes(query);
      return (it.note.title + " " + it.note.body).toLowerCase().includes(query);
    });
    if (!list.length) {
      const empty = query ? "Nothing matches “" + esc(q.trim()) + "”."
        : kind === "letters" ? "No letters yet.<br>The first one arrives Monday."
        : kind === "smart-open" ? "No open tasks.<br>Enjoy the clear desk."
        : kind === "smart-done" ? "Nothing finished yet.<br>Tick off a task and it lands here."
        : "Nothing here yet.";
      return `<div class="empty-state">${empty}</div>`;
    }
    return list.map(it => {
      if (it.kind === "letter") {
        const isThis = it.weekKey === weekKey();
        return `<div class="nrow" data-letter="${esc(it.weekKey)}">
          <div class="nr-title">${isThis ? "This week" : "Week of " + esc(weekRangeLabel(it.weekKey).split(" – ")[0])}</div>
          <div class="nr-sub">${esc(weekRangeLabel(it.weekKey))}</div></div>`;
      }
      const n = it.note;
      const sub = SMART_KINDS[kind] && it.st
        ? `${it.st.done}/${it.st.total} done · ${relTime(n.updatedAt)}`
        : `${relTime(n.updatedAt)} · ${STATUS_LABEL[n.status] || n.status} — ${esc(plainExcerpt(n.body))}`;
      return `<div class="nrow" data-note="${n.id}">
        <div class="nr-title">${n.link ? "🔗 " : ""}${esc(n.title)}</div>
        <div class="nr-sub">${sub}</div></div>`;
    }).join("");
  };
  app.innerHTML = `
    <button class="back" data-go="#/folders">‹ ${meta.back}</button>
    <h1 class="large-title">${esc(kind === "circle" ? state.circle.name : meta.title)}</h1>
    <p class="list-count">${items.length} ${items.length === 1 ? (kind === "letters" ? "letter" : "note") : (kind === "letters" ? "letters" : "notes")}</p>
    ${kind === "circle" ? presenceLine() : ""}
    <div class="search"><span class="s-ic">⌕</span><input id="q" placeholder="Search" autocomplete="off"></div>
    <div class="ngroup" id="rows">${renderRows("")}</div>
    ${meta.compose ? `<button class="fab" id="compose" aria-label="New note">✎</button>` : ""}`;
  app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
  const q = $("#q");
  q.addEventListener("input", () => { $("#rows").innerHTML = renderRows(q.value); bindRows(); });
  const bindRows = () => {
    app.querySelectorAll("[data-note]").forEach(r => r.onclick = () => location.hash = "#/note/" + r.dataset.note);
    app.querySelectorAll("[data-letter]").forEach(r => r.onclick = () => location.hash = "#/letter/" + r.dataset.letter);
  };
  bindRows();
  const fab = $("#compose");
  if (fab) fab.onclick = () => location.hash = "#/compose/" + kind;
  heartbeat("list:" + kind);
}

/* ---------- compose ---------- */
async function viewCompose(kind) {
  renderTabs("notes");
  const backHash = kind === "circle" ? "#/list/circle" : "#/list/mine";
  const backLabel = kind === "circle" ? state.circle.name : "My Notepad";
  const draftKey = "abba_draft_" + kind;
  const draft = JSON.parse(localStorage.getItem(draftKey) || '{"title":"","body":"","tags":""}');
  app.innerHTML = `
    <div class="editbar"><button class="back" id="bk">‹ ${esc(backLabel)}</button>
      <button class="done-btn" id="done">Done</button></div>
    ${kind === "circle" ? `<p class="share-banner">Shared with ${esc(state.circle.name)} the moment you’re done.</p>` : ""}
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
  $("#bk").onclick = () => { location.hash = backHash; };
  $("#done").onclick = async () => {
    const body = bodyEl.value.trim();
    if (!body && !titleEl.value.trim()) { location.hash = backHash; return; }
    if (!body) { toast("Write something first — even a fragment."); return; }
    try {
      const { note } = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: titleEl.value, body,
          tags: tagsEl.value.split(",").map(x => x.trim()).filter(Boolean),
          shared: kind === "circle",
        }),
      });
      localStorage.removeItem(draftKey);
      toast(kind === "circle" ? "Shared with the circle." : "Kept in your notepad.");
      location.hash = "#/note/" + note.id;
    } catch (e) { toast(e.message); }
  };
  titleEl.focus();
  heartbeat("compose");
}

/* ---------- note detail ---------- */
/* Floating response orb (after callmenick's CSS-Circle-Menu): your presence pill,
   fixed above the tab bar. Tapping fans statuses, actions and reactions out
   over the interface with staggered spring timing. */
const ZEN_STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const ZEN = {
  seed: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M13 4.5c3.2 4.3 4.2 9 0 13.5-4.2-4.5-3.2-9.2 0-13.5z"/></svg>',
  sprout: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M13 21.5v-9"/><path d="M13 15.5c-3.6-.4-5.8-2.4-6.3-6.2 3.6.4 5.8 2.4 6.3 6.2z"/><path d="M13 12.5c3.6-.4 5.8-2.4 6.3-6.2-3.6.4-5.8 2.4-6.3 6.2z"/></svg>',
  motion: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M4 9.5c2.5-1.8 5 1.8 7.5 0s5 1.8 7.5 0"/><path d="M4 14.5c2.5-1.8 5 1.8 7.5 0s5 1.8 7.5 0"/><path d="M4 19.5c2.5-1.8 5 1.8 7.5 0s5 1.8 7.5 0"/></svg>',
  decided: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M21.3 13a8.3 8.3 0 1 1-2.5-5.9"/></svg>',
  resting: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M19.8 14.8A7.8 7.8 0 1 1 11.2 5.4a6.2 6.2 0 0 0 8.6 9.4z"/></svg>',
  share: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><circle cx="13" cy="13" r="1.8" fill="currentColor" stroke="none"/><circle cx="13" cy="13" r="6.2"/><circle cx="13" cy="13" r="10.5"/></svg>',
  edit: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M5 19.5l1.2-4.2L16.7 4.8a2 2 0 0 1 2.8 2.8L9 18.1z"/><path d="M14.8 6.7l2.8 2.8"/></svg>',
  export: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M13 4.5V15"/><path d="M8.8 11.2L13 15.4l4.2-4.2"/><path d="M5.5 19.5h15"/></svg>',
  del: '<svg class="zen" viewBox="0 0 26 26" ' + ZEN_STROKE + '><path d="M5 7h16"/><path d="M9.5 7V5h7v2"/><path d="M7 7l1 13.5h8L17 7"/><path d="M10.8 10.5v7M15.2 10.5v7"/></svg>',
};
function orbHtml(note) {
  const items = [];
  if (note.mine) {
    STATUS_FLOW.forEach(s => items.push({ kind: "status", key: s, label: STATUS_LABEL[s], active: note.status === s }));
    items.push({ kind: "status", key: "resting", label: note.status === "resting" ? "Wake up" : "Rest", active: note.status === "resting" });
    items.push({ kind: "share", key: "share", label: note.shared ? "Unshare" : "Share", active: false });
  }
  Object.keys(REACT_META).forEach(k => {
    items.push({
      kind: "react", key: k, emoji: REACT_META[k][0], label: REACT_META[k][1],
      count: note.reactionCounts[k] || 0, active: note.myReactions.indexOf(k) >= 0,
    });
  });
  if (note.mine) {
    items.push({ kind: "act", key: "edit", label: "Edit" });
    items.push({ kind: "act", key: "export", label: "Export" });
    items.push({ kind: "act", key: "del", label: "Delete" });
  } else {
    items.push({ kind: "act", key: "export", label: "Export" });
  }
  const n = items.length, step = n > 1 ? 180 / (n - 1) : 0;
  const dense = n > 9, radius = dense ? 168 : 145;
  const sats = items.map((it, i) => {
    const a = 180 + i * step;
    const inner = it.kind === "react"
      ? '<span class="c-emoji">' + it.emoji + "</span>" + (it.count ? '<span class="c-badge">' + it.count + "</span>" : "")
      : (ZEN[it.key] || '<span class="c-label">' + esc(it.label) + "</span>");
    return '<button class="c-item' + (it.active ? " on" : "") + (it.key === "del" ? " danger" : "") + '" data-ck="' + it.kind + '" data-ckey="' + it.key + '"' +
      ' style="--a:' + a.toFixed(1) + 'deg;--i:' + i + '" aria-label="' + esc(it.label || it.key) + '">' + inner + "</button>";
  }).join("");
  const me = state.me || {};
  const color = esc(me.color || "#A08C5B");
  const hint = localStorage.getItem("abba_orb_seen")
    ? ""
    : '<div class="orb-hint" id="orbhint">Tap for reactions &amp; more</div>';
  const enso = '<svg class="enso" viewBox="0 0 60 60" aria-hidden="true"><path d="M30 7 C43 7 53 17 53 30 C53 43 43 52 30 53 C17 54 7 44 7 31 C7 19 16 8 28 7" fill="none" stroke="' + color + '" stroke-width="3.4" stroke-linecap="round"/></svg>';
  const tchev = '<svg class="tchev" viewBox="0 0 12 8" aria-hidden="true"><path d="M1.5 1.5 L6 6 L10.5 1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return '<div class="orb-wrap' + (dense ? " dense" : "") + '" id="cstage" style="--r:' + radius + 'px">' + sats +
    '<button class="orb-toggle" id="ctoggle" aria-label="React and more">' + enso + tchev + "</button>" +
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
  if (!n && !note.shared) return "";
  const label = n ? n + (n === 1 ? " thought" : " thoughts") : "Start the conversation";
  let body = "";
  if (open) {
    const list = note.comments.map(function (c) {
      return '<div class="comment"><div class="who"><span class="dot" style="background:' + esc(c.author.color) +
        '"></span><b>' + esc(c.author.name) + "</b><span>" + relTime(c.createdAt) + "</span></div><p>" + esc(c.body) + "</p></div>";
    }).join("");
    body = '<div class="card" style="margin-top:6px"><div id="comments">' + list + "</div>" +
      '<div class="comment-box"><input id="cbox" placeholder="Add a thought…" maxlength="5000">' +
      '<button class="btn btn-primary" id="csend">↩</button></div></div>';
  }
  return '<button class="convo-toggle" id="convo-toggle"><span>💬</span><span>' + esc(label) +
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
}
async function downloadNote(id) {
  try {
    const tok = localStorage.getItem("abba_token");
    const res = await fetch("/api/notes/" + id + "/export", { headers: { Authorization: "Bearer " + tok } });
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "abba-" + id + ".md";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message); }
}
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
  const backHash = note.shared ? "#/list/circle" : "#/list/mine";
  const backLabel = note.shared ? state.circle.name : "My Notepad";
  const linkBadge = note.link
    ? '<p class="link-badge">🔗 Linked from ' + esc(note.link.name || "someone") + (note.link.circle ? " · " + esc(note.link.circle) : "") + " — frozen, read-only</p>"
    : "";
  return '<button class="back" data-go="' + backHash + '">‹ ' + esc(backLabel) + "</button>" +
    '<h1 class="note-title">' + esc(note.title) + "</h1>" +
    '<p class="note-meta"><span class="dot" style="background:' + esc(note.author.color) + '"></span>' +
    esc(note.author.name) + " · " + relTime(note.updatedAt) + " · ◷ " + note.readMins + " min</p>" +
    linkBadge +
    tags + '<div class="reader">' + md(note.body) + "</div>" +
    (note.link ? "" : orbHtml(note)) + relatedHtml(related) +
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
  // task checkboxes: tap to flip the underlying "- [ ]" line (own notes only)
  const bindTasks = () => {
    app.querySelectorAll(".reader .cbox").forEach(b => {
      b.onclick = async (e) => {
        e.preventDefault();
        if (!note.mine || note.link) return;
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
      ctoggle.setAttribute("aria-label", open ? "Close" : "React and more");
      const hint = $("#orbhint");
      if (hint) hint.remove();
      try { localStorage.setItem("abba_orb_seen", "1"); } catch (e) { /* private mode */ }
    };
    /* first-visit auto-peek: bloom the fan once so the gesture is learned, then settle */
    try {
      const seen = localStorage.getItem("abba_orb_seen");
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
          ctoggle.setAttribute("aria-label", "React and more");
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
        } else if (kind === "share") {
          await api("/api/notes/" + id + (note.shared ? "/unshare" : "/share"), { method: "POST" });
          toast(note.shared ? "Back in your notepad." : "Shared with the circle.");
        } else if (kind === "react") {
          await api("/api/notes/" + id + "/react", { method: "POST", body: JSON.stringify({ kind: key }) });
        } else if (kind === "act") {
          if (key === "edit") { viewDetail(id, true); return; }
          if (key === "export") { downloadNote(id); return; }
          if (key === "del") {
            if (!confirm("Delete this note for good?")) return;
            await api("/api/notes/" + id, { method: "DELETE" });
            toast("Deleted.");
            location.hash = note.shared ? "#/list/circle" : "#/list/mine";
            return;
          }
        }
        viewDetail(id, false);
      } catch (e) { toast(e.message); }
    });
  }
  bindConvo(note, id);
  renderMermaid();
  heartbeat("note:" + id);
}

/* ---------- weekly letter ---------- */
async function viewLetter(weekKeyParam) {
  renderTabs("notes");
  let digest;
  try { digest = (await api("/api/digest?week=" + encodeURIComponent(weekKeyParam))).digest; }
  catch (e) {
    app.innerHTML = '<button class="back" data-go="#/list/letters">‹ Weekly Letters</button><div class="empty-state">That letter isn\'t on the shelf.</div>';
    app.querySelector("[data-go]").onclick = (ev) => location.hash = ev.target.closest("[data-go]").dataset.go;
    return;
  }
  app.innerHTML = `
    <button class="back" data-go="#/list/letters">‹ Weekly Letters</button>
    <h1 class="note-title">${esc(digest.title)}</h1>
    <p class="note-meta">${esc(weekRangeLabel(digest.weekKey))}</p>
    <div class="card digest-letter">
      ${digest.empty ? `<div class="digest-empty">A quiet week.<br>Sometimes the best ideas are still forming.</div>` : `
        <p class="intro">${esc(digest.intro)}</p>
        ${digest.sections.map(s => `<h3>${esc(s.heading)}</h3><ul>${s.lines.map(l => `<li>${inline(l)}</li>`).join("")}</ul>`).join("")}
        <p class="intro" style="margin-top:22px">Carry one of these into next week — that's plenty.</p>`}
    </div>`;
  app.querySelectorAll("[data-go]").forEach(b => b.onclick = () => location.hash = b.dataset.go);
  heartbeat("letter");
}

/* ---------- members ---------- */
function inviteExpiryHtml(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return `<p class="sub" style="color:var(--danger)">This code has expired — issue a new one to keep inviting.</p>`;
  const days = Math.ceil(ms / 86400000);
  const d = new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `<p class="sub">Works on any peered Abba · expires ${d} (${days} day${days === 1 ? "" : "s"} left).</p>`;
}
async function viewMembers() {
  renderTabs("circle");
  const [{ members }, { here }] = await Promise.all([
    api("/api/members"), api("/api/presence").catch(() => ({ here: [] })),
  ]);
  const hereIds = new Set(here.map(h => h.id));
  const isOwner = state.me.role === "owner";
  const localCount = members.filter(m => m.role !== "remote" && m.role !== "migrated").length;
  app.innerHTML = `
    <h1 class="large-title">Circle</h1>
    ${presenceLine()}
    <p class="section-label">Members · ${localCount} of ${state.circle.memberCap}</p>
    <div class="group">
      ${members.map(m => {
        const isHere = hereIds.has(m.id) || m.id === state.me.id;
        const sub = isHere ? "here now" : m.role === "owner" ? "started the circle"
          : m.role === "remote" ? "synced from another Abba"
          : m.role === "migrated" ? "from the old circle" : "member";
        return `<div class="mrow"><span class="dot" style="background:${esc(m.color)};width:16px;height:16px"></span>
          <div class="mrow-main"><div class="mrow-name">${esc(m.name)}${m.id === state.me.id ? " (you) " : ""}</div>
          <div class="mrow-sub${isHere ? " here" : ""}">${sub}</div></div></div>`;
      }).join("")}
    </div>
    <p class="section-label">Invite</p>
    <div class="card invite-card">
      <div class="code">${esc(state.circle.inviteCode)}</div>
      <p>Share this code — it opens the door on this Abba and any it's peered with. The circle stays small on purpose.</p>
      ${inviteExpiryHtml(state.circle.inviteExpiresAt)}
      <div class="btn-row">
        <button class="btn btn-ghost" id="copy">Copy invite link</button>
        ${isOwner ? `<button class="btn btn-quiet" id="regen" style="color:#C9BBA6">New code</button>` : ""}
      </div>
    </div>
    <p class="section-label">Mesh sync</p>
    <div class="card" id="mesh-card"><p class="sub" id="mesh-loading">Checking the mesh…</p></div>
    ${isOwner ? `
    <p class="section-label">Invite specific people</p>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Add someone by their user ID — they join with it instead of the shared code. One use each, good for 7 days.</p>
      <div class="btn-row">
        <input id="tinv-uid" placeholder="usr-…" style="flex:1;min-width:0" autocomplete="off">
        <input id="tinv-name" placeholder="Their name" style="flex:1;min-width:0" maxlength="40">
        <button class="btn btn-primary" id="tinv-add">Add</button>
      </div>
      <div id="tinv-list" style="margin-top:10px"><p class="sub">Loading…</p></div>
    </div>` : ""}
    <p class="section-label">Account</p>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">${state.me.hasPassword
        ? "A secret is set — your name + secret re-opens this account, here or through the mesh."
        : "No secret yet. Set one and your name + secret will always re-open this account."}</p>
      <div class="btn-row">
        <input id="acc-pass" type="password" placeholder="new secret (4+ characters)" style="flex:1;min-width:0" autocomplete="new-password">
        <button class="btn btn-primary" id="acc-set">Set secret</button>
      </div>
      <div class="btn-row" id="install-row" style="display:none;margin-top:10px">
        <button class="btn btn-ghost" id="acc-install">Install Abba on this device</button>
      </div>
      <div style="border-top:1px solid var(--hairline);margin:14px 0"></div>
      <p class="sub" style="margin:0 0 6px">Your user ID — share it with a circle owner to be added directly, no invite code needed.</p>
      <div class="btn-row">
        <div class="code" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(state.me.userId || "…")}</div>
        <button class="btn btn-ghost" id="uid-copy">Copy</button>
      </div>
    </div>
    ${isOwner ? `
    <p class="section-label danger">Danger zone</p>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Migrate moves this circle's content — your notes and shared notes — into a fresh, empty circle with a new invite code. Everyone but you starts over.</p>
      <div class="btn-row"><button class="btn btn-ghost" id="circ-migrate">Migrate to new circle</button></div>
      <div style="border-top:1px solid var(--hairline);margin:14px 0"></div>
      <p class="sub" style="margin:0 0 10px">Burning destroys the circle on this Abba — members, notes, everything. Peered instances are told to drop shared notes. This can't be undone.</p>
      <div class="btn-row"><button class="btn btn-ghost btn-danger" id="circ-burn">Burn circle</button></div>
      <div style="border-top:1px solid var(--hairline);margin:14px 0"></div>
      <p class="sub" style="margin:0 0 10px">Reset wipes everything — circle, notes, members, and this Abba's identity — and starts over as a fresh install. Peered copies keep what they already synced.</p>
      <div class="btn-row"><button class="btn btn-ghost btn-danger" id="circ-reset">Reset Abba</button></div>
    </div>` : `
    <p class="section-label">Your own circle</p>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Take your notes, your comments, and frozen links to notes shared with you — and become host of your own circle on a fresh Abba. Nothing new flows back from here afterwards.</p>
      <div class="btn-row"><button class="btn btn-ghost" id="circ-export">Migrate to your own circle</button></div>
    </div>`}`;
  $("#copy").onclick = async () => {
    const link = location.origin + location.pathname + "#/welcome?code=" + state.circle.inviteCode;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied."); }
    catch { prompt("Copy this link:", link); }
  };
  const regen = $("#regen");
  if (regen) regen.onclick = async () => {
    try { const d = await api("/api/invite/regenerate", { method: "POST" }); state.circle.inviteCode = d.inviteCode; state.circle.inviteExpiresAt = d.inviteExpiresAt; viewMembers(); toast("New code issued."); }
    catch (e) { toast(e.message); }
  };
  renderMeshCard(isOwner);
  const accSet = $("#acc-set");
  if (accSet) accSet.onclick = async () => {
    const pw = ($("#acc-pass") || {}).value || "";
    try {
      await api("/api/account/password", { method: "POST", body: JSON.stringify({ password: pw }) });
      toast("Secret set.");
      state.me.hasPassword = true;
      viewMembers();
    } catch (e) { toast(e.message); }
  };
  // PWA install: the row appears only when the browser offers installation
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
    try { await p.userChoice; } catch {}
  };
  const uidCopy = $("#uid-copy");
  if (uidCopy) uidCopy.onclick = async () => {
    try { await navigator.clipboard.writeText(state.me.userId || ""); toast("User ID copied."); }
    catch { prompt("Copy your user ID:", state.me.userId || ""); }
  };
  // targeted invites (owner): add specific users by their user ID
  const tinvList = $("#tinv-list");
  const renderInvites = async () => {
    if (!tinvList) return;
    try {
      const d = await api("/api/circle/invites");
      tinvList.innerHTML = d.invites.length ? d.invites.map(iv => {
        const left = Math.max(0, Date.parse(iv.expires_at) - Date.now());
        const days = Math.ceil(left / 86400000);
        return `<div class="mrow"><div class="mrow-main"><div class="mrow-name">${esc(iv.name || "Someone")}</div>
          <div class="mrow-sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(iv.user_id)} · ${days} day${days === 1 ? "" : "s"} left</div></div>
          <button class="btn btn-quiet" data-uninvite="${esc(iv.user_id)}">Revoke</button></div>`;
      }).join("") : `<p class="sub">No pending invites.</p>`;
      tinvList.querySelectorAll("[data-uninvite]").forEach(b => b.onclick = async () => {
        await api("/api/circle/invites/" + encodeURIComponent(b.dataset.uninvite), { method: "DELETE" });
        toast("Invite revoked."); renderInvites();
      });
    } catch (e) { tinvList.innerHTML = `<p class="sub">Couldn't load invites.</p>`; }
  };
  renderInvites();
  const tinvAdd = $("#tinv-add");
  if (tinvAdd) tinvAdd.onclick = async () => {
    const userId = ($("#tinv-uid") || {}).value || "";
    const name = (($("#tinv-name") || {}).value || "").trim();
    try {
      await api("/api/circle/invites", { method: "POST", body: JSON.stringify({ userId: userId.trim(), name }) });
      $("#tinv-uid").value = ""; $("#tinv-name").value = "";
      toast(name ? `${name} can now join with their user ID.` : "User added — they can join with their user ID.");
      renderInvites();
    } catch (e) { toast(e.message); }
  };
  const mig = $("#circ-migrate");
  if (mig) mig.onclick = async () => {
    if (!confirm("Migrate this circle's content into a fresh, empty circle? Everyone but you will need to re-join with the new invite code.")) return;
    try {
      const d = await api("/api/circle/migrate", { method: "POST" });
      state.circle.inviteCode = d.inviteCode;
      state.circle.inviteExpiresAt = d.inviteExpiresAt;
      toast(`New circle ready — ${d.migratedNotes} notes migrated.`);
      viewMembers();
    } catch (e) { toast(e.message); }
  };
  const brn = $("#circ-burn");
  if (brn) brn.onclick = async () => {
    const c = prompt("Type BURN to destroy this circle and everything in it. This can't be undone.");
    if (c === null) return;
    try {
      await api("/api/circle/burn", { method: "POST", body: JSON.stringify({ confirm: c }) });
      localStorage.removeItem("abba_token");
      location.hash = "#/welcome";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
  const exp = $("#circ-export");
  if (exp) exp.onclick = async () => {
    if (!confirm("Download your migration bundle? It holds your notes, your comments, and frozen links to notes shared with you.")) return;
    try {
      const d = await api("/api/circle/migrate", { method: "POST" });
      const blob = new Blob([JSON.stringify(d.export)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "abba-migrate-" + (state.me.name || "me").toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      toast("Bundle downloaded — import it on a fresh Abba's welcome screen.");
    } catch (e) { toast(e.message); }
  };
  const rst = $("#circ-reset");
  if (rst) rst.onclick = async () => {
    if (!confirm("Reset Abba to a fresh install? Everything on this Abba — circle, notes, members, identity — is wiped. This can't be undone.")) return;
    try {
      await api("/api/circle/reset", { method: "POST" });
      localStorage.removeItem("abba_token");
      location.hash = "#/welcome";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
  heartbeat("members");
}

async function renderMeshCard(isOwner) {
  const card = $("#mesh-card");
  if (!card) return;
  let st;
  try { st = await api("/api/mesh/status"); }
  catch (e) { card.innerHTML = `<p class="sub">Mesh isn't reachable: ${esc(e.message)}</p>`; return; }
  const shortId = st.nodeId.slice(0, 8) + "…" + st.nodeId.slice(-4);
  card.innerHTML = `
    <div class="mesh-head"><span class="mono">${esc(shortId)}</span>
      <span class="sub" style="margin:0">${esc(st.url)}</span></div>
    ${st.peers.length ? `<div class="mesh-peers">${st.peers.map(p => `
      <div class="mrow"><span class="dot" style="background:${p.lastOk ? "var(--sage)" : "var(--faint)"};width:12px;height:12px"></span>
        <div class="mrow-main"><div class="mrow-name mono">${esc(p.id.slice(0, 8))}…</div>
        <div class="mrow-sub">${esc(p.url)}${p.via ? " · via mesh" : ""}</div></div>
        ${isOwner ? `<button class="btn btn-quiet mesh-rm" data-id="${esc(p.id)}" style="color:#C9BBA6">Remove</button>` : ""}
      </div>`).join("")}</div>`
      : `<p class="sub">No peered instances. Shared notes stay on this Abba until you peer one.</p>`}
    ${isOwner ? `
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-ghost" id="mesh-invite">Create instance invite</button>
      <button class="btn btn-ghost" id="mesh-sync">Sync now</button>
    </div>
    <div id="mesh-code-wrap" style="display:none;margin-top:10px">
      <input class="mono" id="mesh-code" readonly style="width:100%;font-size:11px">
      <div class="btn-row" style="margin-top:8px"><button class="btn btn-ghost" id="mesh-copy">Copy code</button></div>
      <p class="sub" style="margin-top:8px">Paste this on the <em>other</em> Abba's Circle → Mesh sync → Join. Only shared notes replicate; private notepad notes never leave this instance.</p>
    </div>
    <div class="btn-row" style="margin-top:10px">
      <input id="mesh-join-code" class="mono" placeholder="paste instance invite…" style="flex:1;min-width:0;font-size:11px">
      <button class="btn btn-primary" id="mesh-join">Join</button>
    </div>
    <div class="btn-row" style="margin-top:10px">
      <input id="mesh-knock-url" class="mono" placeholder="https://… — peer by URL, no invite needed" style="flex:1;min-width:0;font-size:11px">
      <button class="btn btn-primary" id="mesh-knock">Peer</button>
    </div>` : `<p class="sub">Only the circle's owner can peer instances.</p>`}`;
  const inv = $("#mesh-invite");
  if (inv) inv.onclick = async () => {
    try {
      const d = await api("/api/mesh/invite", { method: "POST" });
      $("#mesh-code-wrap").style.display = "block";
      $("#mesh-code").value = d.code;
    } catch (e) { toast(e.message); }
  };
  const cp = $("#mesh-copy");
  if (cp) cp.onclick = async () => {
    const el = $("#mesh-code");
    try { await navigator.clipboard.writeText(el.value); toast("Copied."); }
    catch { el.select(); toast("Copy it manually."); }
  };
  const jn = $("#mesh-join");
  if (jn) jn.onclick = async () => {
    const code = $("#mesh-join-code").value.trim();
    if (!code) return;
    try { await api("/api/mesh/join", { method: "POST", body: JSON.stringify({ code }) }); toast("Instance peered. Syncing…"); renderMeshCard(isOwner); }
    catch (e) { toast(e.message); }
  };
  const kn = $("#mesh-knock");
  if (kn) kn.onclick = async () => {
    const url = $("#mesh-knock-url").value.trim();
    if (!url) return;
    try { await api("/api/mesh/knock", { method: "POST", body: JSON.stringify({ url }) }); toast("Instance peered. Syncing…"); renderMeshCard(isOwner); }
    catch (e) { toast(e.message); }
  };
  const sy = $("#mesh-sync");
  if (sy) sy.onclick = async () => {
    try { await api("/api/mesh/sync", { method: "POST" }); toast("Synced."); renderMeshCard(isOwner); }
    catch (e) { toast(e.message); }
  };
  card.querySelectorAll(".mesh-rm").forEach(b => b.onclick = async () => {
    if (!confirm("Stop syncing with this instance?")) return;
    try { await api("/api/mesh/peers/" + b.dataset.id, { method: "DELETE" }); renderMeshCard(isOwner); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- welcome ---------- */
async function viewWelcome() {
  tabbar.hidden = true;
  const hasCircle = await api("/api/status").then(d => d.hasCircle).catch(() => false);
  const ownerHere = !!(state.me && state.me.role === "owner");
  app.innerHTML = `<div class="welcome">
    <div class="mark">◯</div>
    <h1>Abba</h1>
    <p class="tagline">A quiet notepad for you and your circle.</p>
    <div class="creed">
      <div><b>Soulfulness</b> — written for humans, not feeds</div>
      <div><b>Effectiveness</b> — ideas that move, not just accumulate</div>
      <div><b>Flow</b> — capture in seconds, find in less</div>
      <div><b>Unity</b> — a small circle, thinking together</div>
    </div>
    <div class="card" style="text-align:left">
      <div class="eyebrow" style="margin-top:0">Begin</div>
      ${hasCircle ? "" : `<div class="field"><label>Your circle's name</label><input id="w-circle" placeholder="e.g. The Corner Table" maxlength="60"></div>`}
      <div class="field"><label>Your name</label><input id="w-name" placeholder="What should the circle call you?" maxlength="40"></div>
      ${hasCircle ? `<div class="field"><label>Invite code or user ID</label><input id="w-code" placeholder="abba-… or usr-…" autocomplete="off"></div>` : ""}
      <div class="btn-row"><button class="btn btn-primary" id="w-go">${hasCircle ? "Join the circle" : "Start our circle"}</button></div>
    </div>
    ${hasCircle ? `<p class="sub" style="margin-top:14px"><a href="#" id="w-reopen-link" style="color:var(--terra-deep)">Lost your sign-in? Re-open with a secret</a></p>` : ""}
    ${hasCircle ? `<p class="sub" style="margin-top:10px"><a href="#" id="w-fresh-link" class="text-danger">Or start a brand new circle</a></p>` : ""}
    <div class="card" id="w-fresh-card" style="display:none;text-align:left">
      <div class="eyebrow text-danger" style="margin-top:0">Brand new circle</div>
      <p class="sub" style="margin:0 0 10px">This wipes the current circle — notes, members, identity — and starts over. There's no undo.</p>
      <div class="field"><label>New circle's name</label><input id="w-f-circle" placeholder="e.g. The Corner Table" maxlength="60"></div>
      <div class="field"><label>Your name</label><input id="w-f-name" placeholder="What should the circle call you?" maxlength="40"></div>
      ${ownerHere ? "" : `
      <div class="field"><label>Current owner's name (if they set a secret)</label><input id="w-f-owner" placeholder="The name the circle knows them by" maxlength="40"></div>
      <div class="field"><label>Owner's secret (if set)</label><input id="w-f-pass" type="password" placeholder="Their secret phrase" autocomplete="current-password"></div>`}
      <div class="btn-row"><button class="btn btn-ghost btn-danger" id="w-f-go">Wipe and start fresh</button></div>
    </div>
    <div class="card" id="w-reopen-card" style="display:none;text-align:left">
      <div class="eyebrow" style="margin-top:0">Re-open your account</div>
      <div class="field"><label>Your name</label><input id="w-r-name" placeholder="The name the circle knows you by" maxlength="40"></div>
      <div class="field"><label>Secret</label><input id="w-r-pass" type="password" placeholder="Your secret phrase" autocomplete="current-password"></div>
      <div class="btn-row"><button class="btn btn-primary" id="w-r-go">Re-open my account</button></div>
      <p class="sub" style="margin:10px 0 0">Works on this Abba, or anywhere your account reached through mesh sync.</p>
    </div>
    ${hasCircle ? `
    <div class="card" style="text-align:left;margin-top:14px">
      <div class="eyebrow" style="margin-top:0">Migrating from another circle?</div>
      <p class="sub" style="margin:0">Importing starts a brand-new circle, and this Abba already has one — reset it first (owner · Circle → Danger zone), or import your bundle on a fresh Abba.</p>
    </div>` : `
    <div class="card" style="text-align:left;margin-top:14px">
      <div class="eyebrow" style="margin-top:0">Migrating from another circle?</div>
      <p class="sub" style="margin:0 0 10px">Import your migration bundle — you become host of a fresh circle with your notes, links, and comments.</p>
      <div class="field"><label>Your circle's name</label><input id="w-m-circle" placeholder="e.g. Ari's Circle" maxlength="60"></div>
      <div class="field"><label>Migration bundle</label><input id="w-m-file" type="file" accept=".json,application/json"></div>
      <div class="btn-row"><button class="btn btn-ghost" id="w-m-go">Import bundle</button></div>
    </div>`}
    <p class="sub" style="margin-top:18px">One circle per Abba · stays intimate by design.</p>
  </div>`;
  const rl = $("#w-reopen-link");
  if (rl) rl.onclick = (e) => {
    e.preventDefault();
    $("#w-reopen-card").style.display = "block";
    rl.parentElement.style.display = "none";
  };
  const rgo = $("#w-r-go");
  if (rgo) rgo.onclick = async () => {
    const name = ($("#w-r-name") || {}).value || "";
    const password = ($("#w-r-pass") || {}).value || "";
    if (!name.trim() || !password) { toast("Name and secret, both."); return; }
    try {
      const data = await api("/api/account/reopen", { method: "POST", body: JSON.stringify({ name: name.trim(), password }) });
      localStorage.setItem("abba_token", data.token);
      toast(data.fromMesh ? "Account restored from the mesh. Welcome back." : "Welcome back.");
      location.hash = "#/folders";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
  const fl = $("#w-fresh-link");
  if (fl) fl.onclick = (e) => {
    e.preventDefault();
    const c = $("#w-fresh-card");
    if (c) c.style.display = c.style.display === "none" ? "" : "none";
  };
  const fgo = $("#w-f-go");
  if (fgo) fgo.onclick = async () => {
    const circleName = (($("#w-f-circle") || {}).value || "").trim();
    const ownerName = ($("#w-f-name") || {}).value || "";
    if (!circleName || !ownerName.trim()) { toast("Name the circle and yourself."); return; }
    if (!confirm("Wipe this Abba completely and start \"" + circleName + "\"? There's no undo.")) return;
    try {
      if (!(state.me && state.me.role === "owner")) {
        // owner secret when one exists; pre-secrets instances skip this via the recovery hatch
        const on = (($("#w-f-owner") || {}).value || "").trim();
        const op = (($("#w-f-pass") || {}).value || "");
        if (on && op) {
          const ro = await api("/api/account/reopen", { method: "POST", body: JSON.stringify({ name: on, password: op }) });
          if (ro.member.role !== "owner") { toast("Only the owner can start a brand new circle."); return; }
          localStorage.setItem("abba_token", ro.token);
        }
      }
      const init = await api("/api/circle/fresh-start", {
        method: "POST", body: JSON.stringify({ name: circleName, ownerName: ownerName.trim() }),
      });
      localStorage.setItem("abba_token", init.token);
      toast("Fresh circle, fresh start.");
      location.hash = "#/folders";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
  const mgo = $("#w-m-go");
  if (mgo) mgo.onclick = async () => {
    const f = ($("#w-m-file") || {}).files || [];
    if (!f.length) { toast("Choose your migration bundle first."); return; }
    try {
      const bundle = JSON.parse(await f[0].text());
      const circleName = (($("#w-m-circle") || {}).value || "").trim();
      const data = await api("/api/circle/import", {
        method: "POST", body: JSON.stringify({ bundle, circleName: circleName || undefined }),
      });
      localStorage.setItem("abba_token", data.token);
      toast("Welcome home, host.");
      location.hash = "#/folders";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
  $("#w-go").onclick = async () => {
    const name = ($("#w-name") || {}).value || "";
    if (!name.trim()) { toast("Tell us your name first."); return; }
    try {
      const wCode = (($("#w-code") || {}).value || "").trim();
      const joinBody = wCode.startsWith("usr-")
        ? { userId: wCode, name: name.trim() }
        : { code: wCode, name: name.trim() };
      const data = hasCircle
        ? await api("/api/join", { method: "POST", body: JSON.stringify(joinBody) })
        : await api("/api/circle/init", { method: "POST", body: JSON.stringify({ name: ($("#w-circle") || {}).value || "The Circle", ownerName: name.trim() }) });
      localStorage.setItem("abba_token", data.token);
      location.hash = "#/folders";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
}

/* ---------- presence heartbeat (invisible) ---------- */
let hbTimer = null;
function heartbeat(view) {
  clearTimeout(hbTimer);
  const beat = () => api("/api/me?view=" + encodeURIComponent(view), {}).catch(() => {});
  hbTimer = setTimeout(function tick() { beat(); hbTimer = setTimeout(tick, 45000); }, 45000);
}

/* ---------- boot & router ---------- */
async function boot() {
  const tok = localStorage.getItem("abba_token");
  if (!tok) { viewWelcome(); return; }
  try {
    const [me, circle] = await Promise.all([
      api("/api/me").then(d => d.member),
      api("/api/circle"),
    ]);
    state.me = me; state.circle = circle;
    route();
  } catch (e) { localStorage.removeItem("abba_token"); viewWelcome(); }
}
function route() {
  const h = location.hash || "#/folders";
  window.scrollTo(0, 0);
  if (h.startsWith("#/note/")) { const ed = h.includes("?edit"); viewDetail(h.split("/")[2].split("?")[0], ed); }
  else if (h.startsWith("#/list/")) viewList(h.split("/")[2] || "mine");
  else if (h.startsWith("#/compose/")) viewCompose(h.split("/")[2] || "mine");
  else if (h.startsWith("#/letter/")) viewLetter(h.split("/")[2]);
  else if (h === "#/members") viewMembers();
  else if (h === "#/folders") { if (state.me) viewFolders(); else viewWelcome(); }
  else if (h.startsWith("#/welcome")) viewWelcome();
  else if (state.me) viewFolders();
  else viewWelcome();
  if (h.startsWith("#/welcome")) {
    const m = h.match(/code=([^&]+)/);
    setTimeout(() => { const c = $("#w-code"); if (c && m) c.value = decodeURIComponent(m[1]); }, 50);
  }
}
window.addEventListener("hashchange", () => { if (state.me || (location.hash || "").startsWith("#/welcome")) route(); });
boot();
