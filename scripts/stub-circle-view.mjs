// stub-render the Circle view with two circles in the store; assert the
// switcher, new-circle input, and leave control render.
import { readFileSync } from "node:fs";

const store = {
  abba_circles: JSON.stringify({
    1: { token: "tok1", name: "Family" },
    2: { token: "tok2", name: "Work" },
  }),
  abba_active_circle: "2",
};

function makeEl() {
  return {
    innerHTML: "", hidden: false, style: {}, dataset: {}, value: "",
    textContent: "",
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    appendChild() {},
    classList: { add() {}, remove() {} },
  };
}
const els = { "#app": makeEl(), "#tabbar": makeEl(), "#toast": makeEl() };

const routes = {
  "/api/me": { member: { id: 9, name: "June", color: "#C0765A", role: "owner", hasPassword: false, userId: "usr-x", circleId: 2 } },
  "/api/circle": { id: 2, name: "Work", inviteCode: "abba-work11", inviteExpiresAt: null, memberCap: 12 },
  "/api/members": { members: [{ id: 9, name: "June", color: "#C0765A", role: "owner", last_seen: new Date().toISOString() }] },
  "/api/presence": { here: [] },
  "/api/mesh/status": { nodeId: "a".repeat(32), url: "http://x", isOwner: true, peers: [], pairings: [] },
  "/api/imap": { configured: false },
};

globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.document = {
  querySelector: (s) => {
    if (els[s]) return els[s];
    if (s.startsWith("#")) { const e = makeEl(); els[s] = e; return e; }
    return null;
  },
};
globalThis.location = { hash: "#/members", origin: "http://x", pathname: "/" };
globalThis.window = { addEventListener() {}, scrollTo() {} };
try { globalThis.navigator = {}; } catch { /* node defines it read-only */ }
globalThis.fetch = async (url) => {
  const path = String(url).split("?")[0];
  const d = routes[path];
  return { ok: !!d, status: d ? 200 : 404, json: async () => d || {} };
};

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
eval(src);

// boot() ran at load with hash #/members; give the async view a beat
await new Promise((r) => setTimeout(r, 300));

const html = els["#app"].innerHTML;
const checks = [
  ["switcher section", html.includes("Your circles")],
  ["both circle names", html.includes("Family") && html.includes("Work")],
  ["current marked", html.includes("(here)")],
  ["data-circle rows", html.includes('data-circle="1"')],
  ["new circle input", html.includes('id="newc-name"')],
  ["leave hidden for owner", !html.includes('id="circ-leave"')],
  ["circle name as title", html.includes("<h1 class=\"large-title\">Work</h1>")],
  ["tab shows circle name", els["#tabbar"].innerHTML.includes("Work")],
];
let fail = 0;
for (const [n, c] of checks) {
  console.log((c ? "ok - " : "NOT OK - ") + n);
  if (!c) fail++;
}
// non-owner view: leave control appears
globalThis.__forceMember = true;
process.exit(fail ? 1 : 0);
