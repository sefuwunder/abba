// inline-shot.ts — inline public/* + canned API for CDP screenshots.
// Usage: bun scripts/inline-shot.ts <view>   (view = welcome|capture|circle|idea|digest|members)
import { readFileSync, writeFileSync } from "fs";

const NOW = Date.now();
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const ME = { id: 1, name: "Sam Rivera", color: "#C0765A", role: "owner" };
const ARI = { id: 2, name: "Ari", color: "#7A8B6F", role: "member" };
const JUNE = { id: 3, name: "June", color: "#B8934A", role: "member" };

const note1 = {
  id: 1, title: "Buy the building on Madison", readMins: 2, status: "sprout", shared: true, mine: true,
  author: { name: "Sam Rivera", color: "#C0765A" }, createdAt: iso(3 * 864e5), updatedAt: iso(2 * 36e5),
  tags: ["property", "long-term"],
  body: "## The case\n\nThe landlord hinted they'd sell the Madison building for **~$310k** — below what we paid in rent over six years.\n\n> Owning the room changes how you think about the work.\n\n### Open questions\n- Financing: SBA vs. conventional?\n- Does the kitchen need the full refit first?\n- Ask June about the survey she mentioned\n\nNext step: get the inspection booked before October.",
  comments: [
    { id: 1, body: "I know a good inspector — sending you his number.", createdAt: iso(5 * 36e5), mine: false, author: { name: "Ari", color: "#7A8B6F" } },
    { id: 2, body: "The survey came back clean, by the way. No easement surprises.", createdAt: iso(3 * 36e5), mine: false, author: { name: "June", color: "#B8934A" } },
  ],
  reactionCounts: { felt: 2, spark: 1 }, myReactions: ["felt"],
};
const note2 = {
  id: 2, title: "Q4 hiring plan", readMins: 1, status: "seed", shared: false, mine: true,
  author: { name: "Sam Rivera", color: "#C0765A" }, createdAt: iso(26 * 36e5), updatedAt: iso(26 * 36e5),
  tags: [], body: "Two roles: a morning lead and someone for weekends.\n\nDon't rush this — the last hire taught us that.",
  comments: [], reactionCounts: {}, myReactions: [],
};
const note3 = {
  id: 3, title: "Kill the newsletter?", readMins: 1, status: "motion", shared: true, mine: true,
  author: { name: "Sam Rivera", color: "#C0765A" }, createdAt: iso(6 * 864e5), updatedAt: iso(30 * 36e5),
  tags: ["marketing"], body: "Open rate is 11% and falling. Options:\n\n1. Kill it and put the energy into the regulars' board\n2. Monthly instead of weekly\n\nLeaning toward monthly.",
  comments: [], reactionCounts: { yes: 1 }, myReactions: [],
};
const note4 = {
  id: 4, title: "Supplier renegotiation", readMins: 3, status: "seed", shared: true, mine: false,
  author: { name: "Ari", color: "#7A8B6F" }, createdAt: iso(20 * 36e5), updatedAt: iso(20 * 36e5),
  tags: ["costs"], body: "Produce costs are up 18% year over year. I want to renegotiate with Greenline before the holiday rush.\n\nTalking points ready — want a second pair of eyes?",
  comments: [], reactionCounts: {}, myReactions: [],
};
const note5 = {
  id: 5, title: "Pop-up in November", readMins: 1, status: "decided", shared: true, mine: false,
  author: { name: "June", color: "#B8934A" }, createdAt: iso(9 * 864e5), updatedAt: iso(2 * 864e5),
  tags: ["events"], body: "We're doing it — first weekend of November, collab with Fern Bakery.",
  comments: [{ id: 3, body: "Yes. This is the one.", createdAt: iso(2 * 864e5), mine: true, author: { name: "Sam Rivera", color: "#C0765A" } }],
  reactionCounts: { felt: 3, yes: 2 }, myReactions: ["yes"],
};

const CANNED: Record<string, any> = {
  "/api/status": { hasCircle: true },
  "/api/me": { member: ME },
  "/api/circle": { name: "The Corner Table", inviteCode: "abba-7k2qx9", memberCap: 12 },
  "/api/members": { members: [ME, ARI, JUNE] },
  "/api/presence": { here: [ARI, JUNE] },
  "/api/nudges": { nudges: [{ key: "stale-3", text: "\u201cKill the newsletter?\u201d has been sprouting for a while \u2014 still alive, or time to let it rest?", noteId: 3, action: "rest" }] },
  "/api/digests": { digests: [
    { weekKey: "2026-W40", createdAt: "2026-09-29T10:00:00.000Z", title: "This week in the circle" },
    { weekKey: "2026-W39", createdAt: "2026-09-22T10:00:00.000Z", title: "This week in the circle" },
  ] },
  "/api/notes": { notes: [note1, note3, note4, note5] }, // scope=circle (query stripped)
  "/api/notes/1": { note: note1 },
  "/api/notes/1/related": { related: [{ id: 3, title: "Kill the newsletter?", shared: true }, { id: 4, title: "Supplier renegotiation", shared: true }] },
  "/api/digest": {
    digest: {
      weekKey: "2026-W40", title: "This week in the circle",
      intro: "What moved, what landed, and what's still simmering \u2014 this week in the circle.",
      empty: false,
      sections: [
        { heading: "New seeds", lines: ["**Supplier renegotiation** \u2014 Ari"] },
        { heading: "What moved", lines: ["**Pop-up in November** landed \u2014 a decision was made (June)", "**Kill the newsletter?** is in motion (Sam Rivera)"] },
        { heading: "Worth a re-read", lines: ["**Buy the building on Madison** \u2014 the conversation kept going"] },
        { heading: "Still simmering", lines: ["**Buy the building on Madison** \u2014 Sam Rivera planted this a while back"] },
      ],
    },
  },
};

const which = process.argv[2] || "capture";
const stub = `
// data: URLs have an opaque origin: window.localStorage is an own,
// getter-only property that throws on access. Replace it outright
// (it is configurable) with an in-memory shim.
var __memStore = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(__memStore, k) ? __memStore[k] : null; },
    setItem: function(k,v){ __memStore[k] = String(v); },
    removeItem: function(k){ delete __memStore[k]; },
    clear: function(){ __memStore = {}; }
  }
});
var __MINE_NOTES = ${JSON.stringify([note2, note1, note3])};
var __CIRCLE_NOTES = ${JSON.stringify([note1, note3, note4, note5])};
var __CANNED = ${JSON.stringify(CANNED)};
window.fetch = function(url, opts) {
  var u = String(url).split("?")[0];
  if (u === "/api/notes") {
    var isCircle = String(url).includes("scope=circle");
    return Promise.resolve({ ok: true, status: 200, json: function() { return Promise.resolve({ notes: isCircle ? __CIRCLE_NOTES : __MINE_NOTES }); } });
  }
  var hit = __CANNED[u];
  return Promise.resolve({ ok: !!hit, status: hit ? 200 : 404, json: function() { return Promise.resolve(hit || { error: "not found" }); } });
};
${which === "welcome" ? "" : 'localStorage.setItem("abba_token", "demo");'}
`;

let html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
let js = readFileSync("public/app.js", "utf8");
js = stub + js;
html = html.replace('<link rel="stylesheet" href="/styles.css">', "<style>" + css.replace(/<\/script/gi, "<\\/script") + "</style>");
html = html.replace('<script src="/app.js"></script>', "<script>" + js.replace(/<\/script/gi, "<\\/script") + "</script>");


const POST: Record<string, string> = {
  folders: `<script>setTimeout(function(){ viewFolders(); }, 400);</script>`,
  "list-mine": `<script>setTimeout(function(){ viewList("mine"); }, 400);</script>`,
  "list-circle": `<script>setTimeout(function(){ viewList("circle"); }, 400);</script>`,
  "list-letters": `<script>setTimeout(function(){ viewList("letters"); }, 400);</script>`,
  detail: `<script>setTimeout(function(){ viewDetail(1, false); }, 400);</script>`,
  compose: `<script>setTimeout(function(){ viewCompose("mine"); }, 400);</script>`,
  letter: `<script>setTimeout(function(){ viewLetter("2026-W40"); }, 400);</script>`,
  members: `<script>setTimeout(function(){ viewMembers(); }, 400);</script>`,
};
html = html.replace("</body>", (POST[which] || "") + "</body>");
writeFileSync("/tmp/abba-inline-" + which + ".html", html);
console.log("wrote", html.length, "bytes for", which);
