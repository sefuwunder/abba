// multi-circle.test.ts — several circles on one Abba instance: isolation,
// create/join/leave, per-circle invites, scoped digests, burn scoping.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 32201;
const BASE = `http://localhost:${PORT}`;
let proc: any;

async function api(path: string, opts: any = {}, tok = ""): Promise<{ status: number; data: any }> {
  const headers: any = { "Content-Type": "application/json" };
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(BASE + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const post = (p: string, body: any, tok = "") => api(p, { method: "POST", body: JSON.stringify(body) }, tok);

let ownerA = "", ownerB = "", circleA = 0, circleB = 0, codeA = "", codeB = "";
let noteA = 0;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "abba-multicircle-"));
  proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ABBA_DATA: dir, ABBA_PORT: String(PORT) },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    try { const r = await fetch(BASE + "/api/status"); if (r.ok) break; }
    catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  const a = await post("/api/circle/init", { name: "Family", ownerName: "June" });
  ownerA = a.data.token; circleA = a.data.circle.id; codeA = a.data.circle.inviteCode;
}, 30000);

afterAll(() => { try { proc.kill(); } catch {} });

describe("multiple circles on one instance", () => {
  test("create a second circle", async () => {
    const r = await post("/api/circles", { name: "Work" }, ownerA);
    expect(r.status).toBe(201);
    expect(r.data.circle.id).not.toBe(circleA);
    expect(r.data.circle.name).toBe("Work");
    expect(r.data.member.role).toBe("owner");
    expect(r.data.member.circleId).toBe(r.data.circle.id);
    expect(r.data.circle.inviteCode).not.toBe(codeA);
    ownerB = r.data.token; circleB = r.data.circle.id; codeB = r.data.circle.inviteCode;
  });

  test("circles have isolated notes", async () => {
    const n = await post("/api/notes", { body: "Family secret recipe.", shared: true }, ownerA);
    noteA = n.data.note.id;
    const feedA = await api("/api/notes?scope=circle", {}, ownerA);
    expect(feedA.data.notes.map((x: any) => x.id)).toContain(noteA);
    const feedB = await api("/api/notes?scope=circle", {}, ownerB);
    expect(feedB.data.notes).toHaveLength(0);
    // cross-circle note access is invisible
    const peek = await api(`/api/notes/${noteA}`, {}, ownerB);
    expect(peek.status).toBe(404);
  });

  test("members and presence are per-circle", async () => {
    const mA = await api("/api/members", {}, ownerA);
    const mB = await api("/api/members", {}, ownerB);
    expect(mA.data.members).toHaveLength(1);
    expect(mB.data.members).toHaveLength(1);
    expect(mA.data.members[0].name).toBe("June");
  });

  test("invite lookup identifies the circle", async () => {
    const l = await api("/api/invite/lookup?code=" + encodeURIComponent(codeB));
    expect(l.data.kind).toBe("local");
    expect(l.data.circle.id).toBe(circleB);
    const bad = await api("/api/invite/lookup?code=abba-nope00");
    expect(bad.status).toBe(404);
  });

  test("join lands in the right circle by code", async () => {
    const j = await post("/api/join", { code: codeB, name: "Ari" });
    expect(j.data.member.circleId).toBe(circleB);
    expect(j.data.circle.id).toBe(circleB);
    const members = await api("/api/members", {}, ownerB);
    expect(members.data.members.map((m: any) => m.name).sort()).toEqual(["Ari", "June"]);
    // circle A untouched
    const mA = await api("/api/members", {}, ownerA);
    expect(mA.data.members).toHaveLength(1);
  });

  test("targeted user-ID invite is circle-scoped", async () => {
    const uid = "usr-" + "z".repeat(20);
    const inv = await post("/api/circle/invites", { userId: uid, name: "Sam" }, ownerA);
    expect(inv.status).toBe(201);
    const j = await post("/api/join", { userId: uid, name: "Sam" });
    expect(j.data.member.circleId).toBe(circleA);
    // invite is one-use
    const j2 = await post("/api/join", { userId: uid, name: "Sam2" });
    expect(j2.status).toBe(403);
  });

  test("digests are per-circle", async () => {
    const dA = await api("/api/digest", {}, ownerA);
    expect(dA.data.digest.sections.length).toBeGreaterThan(0);
    const dB = await api("/api/digest", {}, ownerB);
    expect(dB.data.digest.empty).toBe(true);
    const shelfB = await api("/api/digests", {}, ownerB);
    expect(shelfB.data.digests).toHaveLength(1); // this week's, cached
    const shelfA = await api("/api/digests", {}, ownerA);
    expect(shelfA.data.digests).toHaveLength(1);
  });

  test("member can leave a circle", async () => {
    const ari = (await api("/api/members", {}, ownerB)).data.members.find((m: any) => m.name === "Ari");
    // need Ari's token: re-join path gives it — use a fresh join for a leaver
    const j = await post("/api/join", { code: codeB, name: "Leaver" });
    const lv = await api("/api/circle/leave", { method: "POST" }, j.data.token);
    expect(lv.data.ok).toBe(true);
    const gone = await api("/api/me", {}, j.data.token);
    expect(gone.status).toBe(401);
    // owner cannot leave
    const no = await api("/api/circle/leave", { method: "POST" }, ownerB);
    expect(no.status).toBe(403);
    expect(ari).toBeTruthy();
  });

  test("burn destroys only that circle", async () => {
    const r = await post("/api/circle/burn", { confirm: "BURN" }, ownerB);
    expect(r.data.ok).toBe(true);
    const gone = await api("/api/me", {}, ownerB);
    expect(gone.status).toBe(401);
    // circle A fully intact
    const feedA = await api("/api/notes?scope=circle", {}, ownerA);
    expect(feedA.data.notes.map((x: any) => x.id)).toContain(noteA);
    const cA = await api("/api/circle", {}, ownerA);
    expect(cA.data.name).toBe("Family");
    const st = await api("/api/status");
    expect(st.data.hasCircle).toBe(true);
    expect(st.data.circles).toHaveLength(1);
  });

  test("expired codes are per-circle", async () => {
    // regenerate A's code; B's old code is gone with B anyway — use a fresh circle
    const c = await post("/api/circles", { name: "Third" }, ownerA);
    const thirdTok = c.data.token;
    const oldCode = c.data.circle.inviteCode;
    const reg = await post("/api/invite/regenerate", {}, thirdTok);
    expect(reg.data.inviteCode).not.toBe(oldCode);
    const look = await api("/api/invite/lookup?code=" + encodeURIComponent(oldCode));
    expect(look.status).toBe(404);
    const look2 = await api("/api/invite/lookup?code=" + encodeURIComponent(reg.data.inviteCode));
    expect(look2.data.circle.id).toBe(c.data.circle.id);
  });
});
