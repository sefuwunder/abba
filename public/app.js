/* Abba client — a quiet notepad. No AI branding anywhere, by design:
   auto-titles, related ideas, the digest and nudges are rendered as plain
   interface. The intelligence stays invisible. */
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app"), tabbar = $("#tabbar"), toastEl = $("#toast");
const state = { me: null, circle: null, notes: [], filter: "all", here: [], nudges: [], digest: null, editing: null };

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
const STATUS_LABEL = { seed: "Seed", sprout: "Sprout", motion: "In motion", decided: "Decided", resting: "Resting" };
const STATUS_FLOW = ["seed", "sprout", "motion", "decided"];
const REACT_META = { felt: ["❤", "felt this"], spark: ["💡", "sparked"], yes: ["🙌", "yes"] };

/* ---------- shell ---------- */
const TABS = [
  ["#/capture", "✎", "Capture", "capture"],
  ["#/circle", "◯", "Circle", "circle"],
  ["#/digest", "❝", "Digest", "digest"],
  ["#/members", "☺", "Members", "members"],
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
function plainExcerpt(body) {
  const line = String(body || "").split("\n").filter(l => l.trim() && !/^#{1,3}\s/.test(l.trim()))[0] || "";
  return line.replace(/^[-*>\d.\s]+/, "").replace(/(\*\*|__)([^*_]+)\1/g, "$2").replace(/[*_`~]/g, "").trim().slice(0, 140);
}
function noteCard(n) {
  const excerpt = plainExcerpt(n.body);
  return `<article class="card tappable note-card" data-note="${n.id}">
    <div class="note-meta">
      <span class="dot" style="background:${esc(n.author.color)}"></span>
      <span>${esc(n.author.name)}</span><span>·</span><span>${relTime(n.updatedAt)}</span>
      <span class="pill ${n.status}">${STATUS_LABEL[n.status] || n.status}</span>
      ${n.shared ? '<span class="shared-flag">in circle</span>' : ""}
    </div>
    <h3 class="title">${esc(n.title)}</h3>
    <p class="excerpt">${esc(excerpt)}</p>
    <div class="counts"><span>◷ ${n.readMins} min</span><span>💬 ${n.comments.length}</span><span>❤ ${Object.values(n.reactionCounts).reduce((a, b) => a + b, 0)}</span></div>
  </article>`;
}
function bindCards(root) {
  root.querySelectorAll("[data-note]").forEach(c => c.onclick = () => location.hash = "#/idea/" + c.dataset.note);
}

/* ---------- views ---------- */
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
      ${hasCircle ? "" : `<div class="field"><label>Your circle's name</label><input id="w-circle" placeholder="e.g. The Founders Table" maxlength="60"></div>`}
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
      location.hash = "#/capture";
      await boot(true);
    } catch (e) { toast(e.message); }
  };
}

async function viewCapture() {
  renderTabs("capture");
  const [nudges, notes] = await Promise.all([
    api("/api/nudges").then(d => d.nudges).catch(() => []),
    api("/api/notes?scope=mine").then(d => d.notes).catch(() => []),
  ]);
  state.nudges = nudges; state.notes = notes;
  const draft = localStorage.getItem("abba_draft") || "";
  app.innerHTML = `
    <p class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
    <h2 class="greeting">${greeting()}, ${esc(state.me.name.split(" ")[0])}.</h2>
    <p class="sub">What's on your mind?</p>
    <div id="nudges">${nudges.map(n => `
      <div class="nudge" data-nudge="${esc(n.key)}"><span>✦</span>
        <span>${esc(n.text)} ${n.noteId ? `<button class="go" data-open="${n.noteId}">open</button>` : ""}</span>
        <button class="x" data-dismiss="${esc(n.key)}" aria-label="dismiss">×</button>
      </div>`).join("")}</div>
    <div class="card capture-box">
      <textarea id="cap" placeholder="Capture it before it evaporates…" aria-label="Capture a thought">${esc(draft)}</textarea>
      <div class="capture-row">
        <span class="saved-hint" id="savehint">${draft ? "draft restored" : ""}</span>
        <button class="btn btn-primary" id="keep">Keep it</button>
      </div>
    </div>
    <p class="eyebrow">Your notepad</p>
    <div id="mine">${notes.length ? notes.map(noteCard).join("") : `<div class="empty-state">Nothing here yet.<br>Your first thought is one tap away.</div>`}</div>`;
  bindCards(app);
  const cap = $("#cap"), hint = $("#savehint");
  const fit = () => { cap.style.height = "auto"; cap.style.height = Math.min(320, cap.scrollHeight) + "px"; };
  fit();
  let t;
  cap.addEventListener("input", () => {
    fit();
    clearTimeout(t);
    t = setTimeout(() => {
      if (cap.value.trim()) { localStorage.setItem("abba_draft", cap.value); hint.textContent = "saved"; }
      else { localStorage.removeItem("abba_draft"); hint.textContent = ""; }
    }, 600);
  });
  $("#keep").onclick = async () => {
    const bodyText = cap.value.trim();
    if (!bodyText) { toast("Write something first — even a fragment."); return; }
    try {
      await api("/api/notes", { method: "POST", body: JSON.stringify({ body: bodyText }) });
      localStorage.removeItem("abba_draft");
      toast("Kept. It's in your notepad.");
      await viewCapture();
    } catch (e) { toast(e.message); }
  };
  app.querySelectorAll("[data-dismiss]").forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    await api("/api/nudges/dismiss", { method: "POST", body: JSON.stringify({ key: b.dataset.dismiss }) }).catch(() => {});
    b.closest(".nudge").remove();
  });
  app.querySelectorAll("[data-open]").forEach(b => b.onclick = (e) => { e.stopPropagation(); location.hash = "#/idea/" + b.dataset.open; });
  heartbeat("capture");
}

async function viewCircle() {
  renderTabs("circle");
  const [notes, here] = await Promise.all([
    api("/api/notes?scope=circle").then(d => d.notes).catch(() => []),
    api("/api/presence").then(d => d.here).catch(() => []),
  ]);
  state.here = here;
  const f = state.filter;
  const counts = { all: notes.length, seed: 0, sprout: 0, motion: 0, decided: 0 };
  notes.forEach(n => { if (counts[n.status] != null) counts[n.status]++; });
  const list = notes.filter(n => f === "all" || n.status === f);
  app.innerHTML = `
    <p class="eyebrow">${esc(state.circle.name)}</p>
    <h2 class="greeting">The circle's ideas</h2>
    ${presenceLine()}
    <div class="chips">
      ${[["all", "All"], ["seed", "Seeds"], ["sprout", "Sprouting"], ["motion", "In motion"], ["decided", "Decided"]].map(([k, l]) =>
        `<button class="chip${f === k ? " on" : ""}" data-f="${k}">${l} · ${counts[k]}</button>`).join("")}
    </div>
    <div id="feed">${list.length ? list.map(noteCard).join("") : `<div class="empty-state">Quiet so far.<br>Share something worth thinking about together.</div>`}</div>`;
  bindCards(app);
  app.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { state.filter = b.dataset.f; viewCircle(); });
  heartbeat("circle");
}

/* Single-level template helpers for the idea view (no nested backticks). */
function stepHtml(s, i, flowIdx) {
  const cls = i < flowIdx ? " done" : (i === flowIdx ? " current" : "");
  const mark = i < flowIdx ? "✓" : "";
  return '<button class="step' + cls + '" data-status="' + s + '">' +
    '<span class="knob">' + mark + '</span><span class="lbl">' + STATUS_LABEL[s] + "</span></button>";
}
function statusBlockHtml(note) {
  if (!note.mine) {
    return '<p class="eyebrow">Where it stands</p><div class="card">' +
      '<span class="pill ' + note.status + '">' + (STATUS_LABEL[note.status] || note.status) + "</span>" +
      '<p class="sub" style="margin:8px 0 0">' + esc(note.author.name.split(" ")[0]) + " is tending this one.</p></div>";
  }
  const flowIdx = STATUS_FLOW.indexOf(note.status);
  const steps = STATUS_FLOW.map(function (s, i) { return stepHtml(s, i, flowIdx); }).join("");
  const restBtn = note.status !== "resting"
    ? '<button class="btn btn-quiet" data-status="resting">Let it rest</button>'
    : '<button class="btn btn-quiet" data-status="seed">Wake it up</button>';
  const shareBtn = !note.shared
    ? '<button class="btn btn-ghost" id="share">Bring to circle</button>'
    : '<button class="btn btn-quiet" id="unshare">Take back to notepad</button>';
  return '<p class="eyebrow">Where it stands</p><div class="card"><div class="stepper">' + steps +
    '</div><div class="btn-row">' + restBtn + shareBtn + "</div></div>";
}
function reactsHtml(note) {
  const btns = Object.keys(REACT_META).map(function (k) {
    const g = REACT_META[k][0], label = REACT_META[k][1];
    const on = note.myReactions.indexOf(k) >= 0 ? " on" : "";
    const n = note.reactionCounts[k] || 0;
    return '<button class="react' + on + '" data-react="' + k + '">' + g + " " + label + " · " + n + "</button>";
  }).join("");
  return '<p class="eyebrow">How it lands</p><div class="reacts">' + btns + "</div>";
}
function relatedHtml(related) {
  if (!related.length) return "";
  const rows = related.map(function (r) {
    return '<div class="related-item" data-note="' + r.id + '"><span>' + esc(r.title) + '</span><span style="color:var(--faint)">→</span></div>';
  }).join("");
  return '<p class="eyebrow">Related</p><div class="card"><div class="related-row">' + rows + "</div></div>";
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
  return '<p class="eyebrow">Conversation</p><div class="card"><div id="comments">' + inner + "</div>" +
    '<div class="comment-box"><input id="cbox" placeholder="Add a thought…" maxlength="5000">' +
    '<button class="btn btn-primary" id="csend">↩</button></div></div>';
}
function actionsHtml(note) {
  let h = '<div class="btn-row" style="margin-bottom:8px">';
  if (note.mine) h += '<button class="btn btn-ghost" id="edit">Edit</button>';
  h += '<button class="btn btn-ghost" id="dl">Export .md</button>';
  if (note.mine) h += '<button class="btn btn-danger" id="del">Delete</button>';
  return h + "</div>";
}
function editorHtml(note) {
  return '<div class="card editor">' +
    '<div class="field" style="margin-top:0"><label>Title</label><input id="e-title" value="' + esc(note.title) + '" maxlength="120"></div>' +
    '<div class="toolbar">' +
    '<button class="tool" data-md="**bold**">B</button><button class="tool" data-md="*italic*">I</button>' +
    '<button class="tool" data-md="## ">H</button><button class="tool" data-md="- ">• List</button>' +
    '<button class="tool" data-md="> ">❝ Quote</button>' +
    "</div>" +
    '<textarea id="e-body">' + esc(note.body) + "</textarea>" +
    '<div class="field"><label>Tags (comma separated)</label><input id="e-tags" value="' + esc(note.tags.join(", ")) + '"></div>' +
    '<div class="btn-row"><button class="btn btn-primary" id="e-save">Save</button>' +
    '<button class="btn btn-quiet" id="e-cancel">Cancel</button></div></div>';
}
function ideaReadHtml(note, related) {
  const tags = note.tags.length
    ? '<div class="tags">' + note.tags.map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + "</div>"
    : "";
  return '<div class="note-meta" style="margin-top:6px">' +
    '<span class="dot" style="background:' + esc(note.author.color) + '"></span><span>' + esc(note.author.name) + "</span>" +
    "<span>·</span><span>" + relTime(note.updatedAt) + "</span><span>·</span><span>◷ " + note.readMins + " min read</span></div>" +
    '<h1 class="idea-title">' + esc(note.title) + "</h1>" + tags +
    '<div class="card" style="margin-top:14px"><div class="idea-body">' + md(note.body) + "</div></div>" +
    statusBlockHtml(note) + reactsHtml(note) + relatedHtml(related) + commentsHtml(note) + actionsHtml(note);
}

async function viewIdea(id, editing) {
  renderTabs("circle");
  let note;
  try { note = (await api("/api/notes/" + id)).note; }
  catch (e) {
    app.innerHTML = '<button class="back" id="bk">← Back</button><div class="empty-state">That idea isn\'t here anymore.</div>';
    $("#bk").onclick = () => history.back();
    return;
  }
  const related = await api("/api/notes/" + id + "/related").then(d => d.related).catch(() => []);
  const backLabel = note.shared ? "Circle" : "Notepad";
  app.innerHTML = '<button class="back" id="bk">← ' + backLabel + "</button>" +
    (editing ? editorHtml(note) : ideaReadHtml(note, related));
  $("#bk").onclick = () => history.back();
  bindCards(app);

  if (editing) {
    const ta = $("#e-body");
    app.querySelectorAll("[data-md]").forEach(b => b.onclick = () => {
      const s = ta.selectionStart || 0, ins = b.dataset.md;
      ta.value = ta.value.slice(0, s) + ins + ta.value.slice(ta.selectionEnd || 0);
      ta.focus();
    });
    $("#e-cancel").onclick = () => viewIdea(id, false);
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
        viewIdea(id, false);
      } catch (e) { toast(e.message); }
    };
    return;
  }
  app.querySelectorAll("[data-status]").forEach(b => b.onclick = async () => {
    try {
      await api("/api/notes/" + id, { method: "PATCH", body: JSON.stringify({ status: b.dataset.status }) });
      toast(b.dataset.status === "decided" ? "Marked decided. Nice." : "Updated.");
      viewIdea(id, false);
    } catch (e) { toast(e.message); }
  });
  const sh = $("#share"), ush = $("#unshare");
  if (sh) sh.onclick = async () => { try { await api("/api/notes/" + id + "/share", { method: "POST" }); toast("Shared with the circle."); viewIdea(id, false); } catch (e) { toast(e.message); } };
  if (ush) ush.onclick = async () => { try { await api("/api/notes/" + id + "/unshare", { method: "POST" }); toast("Back in your notepad."); viewIdea(id, false); } catch (e) { toast(e.message); } };
  app.querySelectorAll("[data-react]").forEach(b => b.onclick = async () => {
    try { await api("/api/notes/" + id + "/react", { method: "POST", body: JSON.stringify({ kind: b.dataset.react }) }); viewIdea(id, false); }
    catch (e) { toast(e.message); }
  });
  $("#csend").onclick = async () => {
    const v = $("#cbox").value.trim();
    if (!v) return;
    try { await api("/api/notes/" + id + "/comments", { method: "POST", body: JSON.stringify({ body: v }) }); viewIdea(id, false); }
    catch (e) { toast(e.message); }
  };
  $("#cbox").addEventListener("keydown", e => { if (e.key === "Enter") $("#csend").click(); });
  const ed = $("#edit"); if (ed) ed.onclick = () => viewIdea(id, true);
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
    if (!confirm("Delete this idea for good?")) return;
    try { await api("/api/notes/" + id, { method: "DELETE" }); toast("Deleted."); location.hash = note.shared ? "#/circle" : "#/capture"; }
    catch (e) { toast(e.message); }
  };
  heartbeat("note:" + id);
}

async function viewDigest() {
  renderTabs("digest");
  const { digest } = await api("/api/digest").catch(() => ({ digest: null }));
  state.digest = digest;
  app.innerHTML = `
    <p class="eyebrow">Weekly letter</p>
    <h2 class="greeting">This week in the circle</h2>
    <div class="card digest-letter">
      ${digest && !digest.empty ? `
        <p class="intro">${esc(digest.intro)}</p>
        ${digest.sections.map(s => `<h3>${esc(s.heading)}</h3><ul>${s.lines.map(l => `<li>${inline(l)}</li>`).join("")}</ul>`).join("")}
        <p class="intro" style="margin-top:22px">Carry one of these into next week — that's plenty.</p>`
      : `<div class="digest-empty">A quiet week.<br>Sometimes the best ideas are still forming.</div>`}
    </div>
    <p class="sub" style="text-align:center">Arrives every Monday, written from what actually happened.</p>`;
  heartbeat("digest");
}

async function viewMembers() {
  renderTabs("members");
  const [{ members }, { here }] = await Promise.all([
    api("/api/members"), api("/api/presence").catch(() => ({ here: [] })),
  ]);
  const hereIds = new Set(here.map(h => h.id));
  const isOwner = state.me.role === "owner";
  app.innerHTML = `
    <p class="eyebrow">The circle · ${members.length} of ${state.circle.memberCap}</p>
    <h2 class="greeting">Who's here</h2>
    <div class="card">
      ${members.map(m => `<div class="member-row">
        <span class="dot" style="background:${esc(m.color)};width:14px;height:14px"></span>
        <div><div class="nm">${esc(m.name)}${m.id === state.me.id ? " (you)" : ""}</div>
        <div class="rl">${m.role === "owner" ? "started the circle" : "member"}</div></div>
        ${hereIds.has(m.id) || m.id === state.me.id ? `<span class="here-dot" title="here now"></span>` : ""}
      </div>`).join("")}
    </div>
    <div class="card invite-card">
      <div class="eyebrow" style="color:#C9BBA6;margin-top:0">Invite someone in</div>
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

/* ---------- presence heartbeat (invisible) ---------- */
let hbTimer = null;
function heartbeat(view) {
  clearTimeout(hbTimer);
  const beat = () => api("/api/me?view=" + encodeURIComponent(view), {}).catch(() => {});
  // presence rides on every authed request server-side; this keeps it warm
  hbTimer = setTimeout(function tick() { beat(); hbTimer = setTimeout(tick, 45000); }, 45000);
}

/* ---------- boot & router ---------- */
async function boot(force) {
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
  const h = location.hash || "#/capture";
  window.scrollTo(0, 0);
  if (h.startsWith("#/idea/")) { const ed = h.includes("?edit"); viewIdea(h.split("/")[2].split("?")[0], ed); }
  else if (h === "#/circle") viewCircle();
  else if (h === "#/digest") viewDigest();
  else if (h === "#/members") viewMembers();
  else if (h === "#/welcome") viewWelcome();
  else viewCapture();
  if (h.startsWith("#/welcome")) {
    const m = h.match(/code=([^&]+)/);
    setTimeout(() => { const c = $("#w-code"); if (c && m) c.value = decodeURIComponent(m[1]); }, 50);
  }
}
window.addEventListener("hashchange", () => { if (state.me || (location.hash || "").startsWith("#/welcome")) route(); });
boot();
