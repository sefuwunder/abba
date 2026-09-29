/* Abba client — modeled after Apple Notes: folders, lists, large titles,
   hairlines, quiet yellow. The intelligence stays invisible: auto-titles,
   related ideas, the weekly letters and nudges render as plain interface. */
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app"), tabbar = $("#tabbar"), toastEl = $("#toast");
const state = { me: null, circle: null, filter: "", here: [] };

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
  let html = "", inUl = false, inOl = false, inPre = false, para = [];
  const flushPara = () => { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
  const closeLists = () => { if (inUl) { html += "</ul>"; inUl = false; } if (inOl) { html += "</ol>"; inOl = false; } };
  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) { flushPara(); closeLists(); html += inPre ? "</code></pre>" : "<pre><code>"; inPre = !inPre; continue; }
    if (inPre) { html += esc(line) + "\n"; continue; }
    if (/^\s*$/.test(line)) { flushPara(); closeLists(); continue; }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flushPara(); closeLists(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^---+$/.test(line.trim())) { flushPara(); closeLists(); html += "<hr>"; continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flushPara(); closeLists(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (inOl) { html += "</ol>"; inOl = false; } if (!inUl) { html += "<ul>"; inUl = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { flushPara(); if (inUl) { html += "</ul>"; inUl = false; } if (!inOl) { html += "<ol>"; inOl = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    para.push(line);
  }
  flushPara(); closeLists();
  if (inPre) html += "</code></pre>";
  return html;
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
const REACT_META = { felt: ["❤", "felt this"], spark: ["💡", "sparked"], yes: ["🙌", "yes"] };

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
};
async function viewList(kind) {
  renderTabs("notes");
  const meta = FOLDER_META[kind] || FOLDER_META.mine;
  let items = [];
  if (kind === "letters") {
    const { digests } = await api("/api/digests").catch(() => ({ digests: [] }));
    items = digests.map(d => ({ kind: "letter", id: d.weekKey, weekKey: d.weekKey }));
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
      return `<div class="empty-state">${query ? "Nothing matches “" + esc(q.trim()) + "”." : kind === "letters" ? "No letters yet.<br>The first one arrives Monday." : "Nothing here yet."}</div>`;
    }
    return list.map(it => {
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
function respondMenuHtml(note) {
  let statusPart;
  if (note.mine) {
    const seg = STATUS_FLOW.map(function (s) {
      const on = note.status === s ? " on" : "";
      return '<button data-status="' + s + '" class="' + on.trim() + '">' + STATUS_LABEL[s] + "</button>";
    }).join("");
    const restBtn = note.status !== "resting"
      ? '<button data-status="resting">Let it rest</button>'
      : '<button data-status="seed">Wake it up</button>';
    const shareBtn = !note.shared
      ? '<button id="share">Bring to circle</button>'
      : '<button id="unshare">Take back to notepad</button>';
    statusPart = '<div class="seg">' + seg + "</div>" +
      '<div class="respond-sub">' + restBtn + '<span class="dot-sep">·</span>' + shareBtn + "</div>";
  } else {
    statusPart = '<div class="respond-sub" style="margin-top:0"><span class="pill ' + note.status + '">' +
      (STATUS_LABEL[note.status] || note.status) + "</span></div>";
  }
  const reacts = Object.keys(REACT_META).map(function (k) {
    const g = REACT_META[k][0], label = REACT_META[k][1];
    const on = note.myReactions.indexOf(k) >= 0 ? " on" : "";
    const n = note.reactionCounts[k] || 0;
    return '<button class="react' + on + '" data-react="' + k + '">' + g + " " + label + " · " + n + "</button>";
  }).join("");
  return '<div class="card respond">' + statusPart +
    '<div class="respond-div"></div><div class="reacts">' + reacts + "</div></div>";
}
function relatedHtml(related) {
  if (!related.length) return "";
  const rows = related.map(function (r) {
    return '<div class="nrow" data-note="' + r.id + '"><div class="nr-title">' + esc(r.title) + "</div></div>";
  }).join("");
  return '<p class="section-label">Related</p><div class="ngroup">' + rows + "</div>";
}
function commentsHtml(note) {
  let inner;
  if (note.comments.length) {
    inner = note.comments.map(function (c) {
      return '<div class="comment"><div class="who"><span class="dot" style="background:' + esc(c.author.color) +
        '"></span><b>' + esc(c.author.name) + "</b><span>" + relTime(c.createdAt) + "</span></div><p>" + esc(c.body) + "</p></div>";
    }).join("");
  } else {
    inner = '<p class="sub">No thoughts yet. The first one sets the tone.</p>';
  }
  return '<p class="section-label">Conversation</p><div class="card"><div id="comments">' + inner + "</div>" +
    '<div class="comment-box"><input id="cbox" placeholder="Add a thought…" maxlength="5000">' +
    '<button class="btn btn-primary" id="csend">↩</button></div></div>';
}
function actionsHtml(note) {
  let h = '<div class="btn-row" style="margin:4px 0 8px">';
  if (note.mine) h += '<button class="btn btn-ghost" id="edit">Edit</button>';
  h += '<button class="btn btn-ghost" id="dl">Export</button>';
  if (note.mine) h += '<button class="btn btn-danger" id="del">Delete</button>';
  return h + "</div>";
}
function editorHtml(note) {
  return '<div class="editbar"><button class="back" id="e-cancel">‹ Cancel</button>' +
    '<button class="done-btn" id="e-save">Done</button></div>' +
    '<input id="e-title" class="title-input" value="' + esc(note.title) + '" maxlength="120">' +
    '<div class="toolbar">' +
    '<button class="tool" data-md="**bold**">B</button><button class="tool" data-md="*italic*">I</button>' +
    '<button class="tool" data-md="## ">H</button><button class="tool" data-md="- ">• List</button>' +
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
  return '<button class="back" data-go="' + backHash + '">‹ ' + esc(backLabel) + "</button>" +
    '<h1 class="note-title">' + esc(note.title) + "</h1>" +
    '<p class="note-meta"><span class="dot" style="background:' + esc(note.author.color) + '"></span>' +
    esc(note.author.name) + " · " + relTime(note.updatedAt) + " · ◷ " + note.readMins + " min</p>" +
    tags + '<div class="reader">' + md(note.body) + "</div>" +
    respondMenuHtml(note) + relatedHtml(related) + commentsHtml(note) + actionsHtml(note);
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
  app.querySelectorAll("[data-status]").forEach(b => b.onclick = async () => {
    try {
      await api("/api/notes/" + id, { method: "PATCH", body: JSON.stringify({ status: b.dataset.status }) });
      toast(b.dataset.status === "decided" ? "Marked decided. Nice." : "Updated.");
      viewDetail(id, false);
    } catch (e) { toast(e.message); }
  });
  const sh = $("#share"), ush = $("#unshare");
  if (sh) sh.onclick = async () => { try { await api("/api/notes/" + id + "/share", { method: "POST" }); toast("Shared with the circle."); viewDetail(id, false); } catch (e) { toast(e.message); } };
  if (ush) ush.onclick = async () => { try { await api("/api/notes/" + id + "/unshare", { method: "POST" }); toast("Back in your notepad."); viewDetail(id, false); } catch (e) { toast(e.message); } };
  app.querySelectorAll("[data-react]").forEach(b => b.onclick = async () => {
    try { await api("/api/notes/" + id + "/react", { method: "POST", body: JSON.stringify({ kind: b.dataset.react }) }); viewDetail(id, false); }
    catch (e) { toast(e.message); }
  });
  $("#csend").onclick = async () => {
    const v = $("#cbox").value.trim();
    if (!v) return;
    try { await api("/api/notes/" + id + "/comments", { method: "POST", body: JSON.stringify({ body: v }) }); viewDetail(id, false); }
    catch (e) { toast(e.message); }
  };
  $("#cbox").addEventListener("keydown", e => { if (e.key === "Enter") $("#csend").click(); });
  const ed = $("#edit"); if (ed) ed.onclick = () => viewDetail(id, true);
  $("#dl").onclick = async () => {
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
  };
  const del = $("#del");
  if (del) del.onclick = async () => {
    if (!confirm("Delete this note for good?")) return;
    try { await api("/api/notes/" + id, { method: "DELETE" }); toast("Deleted."); location.hash = note.shared ? "#/list/circle" : "#/list/mine"; }
    catch (e) { toast(e.message); }
  };
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
async function viewMembers() {
  renderTabs("circle");
  const [{ members }, { here }] = await Promise.all([
    api("/api/members"), api("/api/presence").catch(() => ({ here: [] })),
  ]);
  const hereIds = new Set(here.map(h => h.id));
  const isOwner = state.me.role === "owner";
  app.innerHTML = `
    <h1 class="large-title">Circle</h1>
    ${presenceLine()}
    <p class="section-label">Members · ${members.length} of ${state.circle.memberCap}</p>
    <div class="group">
      ${members.map(m => {
        const isHere = hereIds.has(m.id) || m.id === state.me.id;
        return `<div class="mrow"><span class="dot" style="background:${esc(m.color)};width:16px;height:16px"></span>
          <div class="mrow-main"><div class="mrow-name">${esc(m.name)}${m.id === state.me.id ? " (you)" : ""}</div>
          <div class="mrow-sub${isHere ? " here" : ""}">${isHere ? "here now" : m.role === "owner" ? "started the circle" : "member"}</div></div></div>`;
      }).join("")}
    </div>
    <p class="section-label">Invite</p>
    <div class="card invite-card">
      <div class="code">${esc(state.circle.inviteCode)}</div>
      <p>Share this code — it opens the door. The circle stays small on purpose.</p>
      <div class="btn-row">
        <button class="btn btn-ghost" id="copy">Copy invite link</button>
        ${isOwner ? `<button class="btn btn-quiet" id="regen" style="color:#C9BBA6">New code</button>` : ""}
      </div>
    </div>`;
  $("#copy").onclick = async () => {
    const link = location.origin + location.pathname + "#/welcome?code=" + state.circle.inviteCode;
    try { await navigator.clipboard.writeText(link); toast("Invite link copied."); }
    catch { prompt("Copy this link:", link); }
  };
  const regen = $("#regen");
  if (regen) regen.onclick = async () => {
    try { const d = await api("/api/invite/regenerate", { method: "POST" }); state.circle.inviteCode = d.inviteCode; viewMembers(); toast("New code issued."); }
    catch (e) { toast(e.message); }
  };
  heartbeat("members");
}

/* ---------- welcome ---------- */
async function viewWelcome() {
  tabbar.hidden = true;
  const hasCircle = await api("/api/status").then(d => d.hasCircle).catch(() => false);
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
      ${hasCircle ? `<div class="field"><label>Invite code</label><input id="w-code" placeholder="abba-…" autocomplete="off"></div>` : ""}
      <div class="btn-row"><button class="btn btn-primary" id="w-go">${hasCircle ? "Join the circle" : "Start our circle"}</button></div>
    </div>
    <p class="sub" style="margin-top:18px">One circle per Abba · stays intimate by design.</p>
  </div>`;
  $("#w-go").onclick = async () => {
    const name = ($("#w-name") || {}).value || "";
    if (!name.trim()) { toast("Tell us your name first."); return; }
    try {
      const data = hasCircle
        ? await api("/api/join", { method: "POST", body: JSON.stringify({ code: $("#w-code").value.trim(), name: name.trim() }) })
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
