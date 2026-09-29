// api.test.ts — end-to-end over real HTTP against a spawned server
// with a fresh data dir. Covers the full circle lifecycle.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 31313;
const BASE = `http://localhost:${PORT}`;
let proc: any;
let ownerTok = "", ariTok = "", inviteCode = "";
let noteId = 0, secondNoteId = 0;

async function api(path: string, opts: any = {}, tok = ""): Promise<{ status: number; data: any }> {
  const headers: any = { "Content-Type": "application/json" };
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(BASE + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const post = (p: string, body: any, tok = "") => api(p, { method: "POST", body: JSON.stringify(body) }, tok);
const patch = (p: string, body: any, tok = "") => api(p, { method: "PATCH", body: JSON.stringify(body) }, tok);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sefu-test-"));
  proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, SEFU_DATA: dir, SEFU_PORT: String(PORT) },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const r = await fetch(BASE + "/api/status");
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterAll(() => { try { proc.kill(); } catch { /* already down */ } });

describe("circle bootstrap", () => {
  test("no circle yet", async () => {
    const { data } = await api("/api/status");
    expect(data.hasCircle).toBe(false);
  });
  test("init creates circle + owner", async () => {
    const { status, data } = await post("/api/circle/init", { name: "Test Circle", ownerName: "Sam" });
    expect(status).toBe(200);
    expect(data.token).toMatch(/^sefu_/);
    expect(data.member.role).toBe("owner");
    expect(data.circle.inviteCode).toMatch(/^sefu-/);
    ownerTok = data.token; inviteCode = data.circle.inviteCode;
  });
  test("init twice is refused", async () => {
    const { status } = await post("/api/circle/init", { name: "X", ownerName: "Y" });
    expect(status).toBe(409);
  });
  test("join with wrong code fails", async () => {
    const { status } = await post("/api/join", { code: "sefu-nope", name: "Ari" });
    expect(status).toBe(403);
  });
  test("join with code works", async () => {
    const { status, data } = await post("/api/join", { code: inviteCode, name: "Ari" });
    expect(status).toBe(200);
    expect(data.member.role).toBe("member");
    ariTok = data.token;
  });
  test("me + members + circle", async () => {
    expect((await api("/api/me", {}, ownerTok)).data.member.name).toBe("Sam");
    expect((await api("/api/members", {}, ownerTok)).data.members.length).toBe(2);
    expect((await api("/api/circle", {}, ownerTok)).data.inviteCode).toBe(inviteCode);
  });
});

describe("notes lifecycle", () => {
  test("create auto-titles from heading", async () => {
    const { status, data } = await post("/api/notes", { body: "## Launch plan\nShip the marketplace in October." }, ownerTok);
    expect(status).toBe(201);
    expect(data.note.title).toBe("Launch plan");
    expect(data.note.status).toBe("seed");
    expect(data.note.shared).toBe(false);
    expect(data.note.readMins).toBe(1);
    noteId = data.note.id;
  });
  test("create requires a body", async () => {
    expect((await post("/api/notes", { body: "   " }, ownerTok)).status).toBe(400);
  });
  test("mine vs circle scopes", async () => {
    expect((await api("/api/notes?scope=mine", {}, ownerTok)).data.notes.length).toBe(1);
    expect((await api("/api/notes?scope=circle", {}, ownerTok)).data.notes.length).toBe(0);
  });
  test("private note is invisible to others", async () => {
    expect((await api(`/api/notes/${noteId}`, {}, ariTok)).status).toBe(404);
  });
  test("others cannot edit your note", async () => {
    await post(`/api/notes/${noteId}/share`, {}, ownerTok); // visible to Ari now
    const { status } = await patch(`/api/notes/${noteId}`, { title: "Hijacked" }, ariTok);
    expect(status).toBe(403);
    await post(`/api/notes/${noteId}/unshare`, {}, ownerTok); // back to private for the next tests
  });
  test("share publishes to the circle", async () => {
    const { data } = await post(`/api/notes/${noteId}/share`, {}, ownerTok);
    expect(data.note.shared).toBe(true);
    const feed = (await api("/api/notes?scope=circle", {}, ariTok)).data.notes;
    expect(feed.length).toBe(1);
    expect(feed[0].title).toBe("Launch plan");
  });
  test("status advance logs an event", async () => {
    const { data } = await patch(`/api/notes/${noteId}`, { status: "sprout" }, ownerTok);
    expect(data.note.status).toBe("sprout");
  });
  test("bad status rejected", async () => {
    expect((await patch(`/api/notes/${noteId}`, { status: "flying" }, ownerTok)).status).toBe(400);
  });
  test("comment + reaction from a member", async () => {
    const c = await post(`/api/notes/${noteId}/comments`, { body: "This feels right." }, ariTok);
    expect(c.status).toBe(201);
    expect(c.data.note.comments.length).toBe(1);
    const r = await post(`/api/notes/${noteId}/react`, { kind: "felt" }, ariTok);
    expect(r.data.note.reactionCounts.felt).toBe(1);
    expect(r.data.note.myReactions).toContain("felt");
    const r2 = await post(`/api/notes/${noteId}/react`, { kind: "felt" }, ariTok);
    expect(r2.data.note.reactionCounts.felt || 0).toBe(0); // toggle off
  });
  test("related finds shared language", async () => {
    const { data } = await post("/api/notes",
      { body: "## Marketplace marketing\nThe marketing push for the October marketplace launch needs real budget." }, ownerTok);
    secondNoteId = data.note.id;
    await post(`/api/notes/${secondNoteId}/share`, {}, ownerTok);
    const rel = (await api(`/api/notes/${noteId}/related`, {}, ownerTok)).data.related;
    expect(rel.map((r: any) => r.id)).toContain(secondNoteId);
  });
  test("private notes never surface as related", async () => {
    const { data } = await post("/api/notes", { body: "## Secret marketplace scheme\nmarketplace launch October budget push" }, ariTok);
    const rel = (await api(`/api/notes/${noteId}/related`, {}, ownerTok)).data.related;
    expect(rel.map((r: any) => r.id)).not.toContain(data.note.id);
  });
  test("unshare pulls it back", async () => {
    await post(`/api/notes/${noteId}/unshare`, {}, ownerTok);
    expect((await api("/api/notes?scope=circle", {}, ariTok)).data.notes.map((n: any) => n.id)).not.toContain(noteId);
    // re-share for the digest tests below
    await post(`/api/notes/${noteId}/share`, {}, ownerTok);
  });
  test("export returns markdown", async () => {
    const res = await fetch(`${BASE}/api/notes/${noteId}/export`, { headers: { Authorization: "Bearer " + ownerTok } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("# Launch plan")).toBe(true);
  });
  test("delete removes it", async () => {
    expect((await api(`/api/notes/${secondNoteId}`, { method: "DELETE" }, ownerTok)).status).toBe(200);
    expect((await api(`/api/notes/${secondNoteId}`, {}, ownerTok)).status).toBe(404);
  });
});

describe("digest + nudges", () => {
  test("digest composes from the week", async () => {
    const { data } = await api("/api/digest", {}, ownerTok);
    expect(data.digest.title).toBe("This week in the circle");
    expect(data.digest.empty).toBe(false);
    const heads = data.digest.sections.map((s: any) => s.heading);
    expect(heads).toContain("New seeds");
    // lines are markdown; the client renders them (titles are raw here, escaped client-side)
    const seeds = data.digest.sections.find((s: any) => s.heading === "New seeds");
    expect(seeds.lines[0]).toMatch(/^\*\*.+\*\* — /);
  });
  test("digest has no AI fingerprints", async () => {
    const { data } = await api("/api/digest", {}, ownerTok);
    const text = JSON.stringify(data.digest).toLowerCase();
    for (const w of ["ai-generated", "as an ai", "language model", "🤖", "✨"]) expect(text.includes(w)).toBe(false);
  });
  test("nudges list + dismiss", async () => {
    const n1 = (await api("/api/nudges", {}, ownerTok)).data.nudges;
    expect(Array.isArray(n1)).toBe(true);
    if (n1.length) {
      await post("/api/nudges/dismiss", { key: n1[0].key }, ownerTok);
      const n2 = (await api("/api/nudges", {}, ownerTok)).data.nudges;
      expect(n2.map((n: any) => n.key)).not.toContain(n1[0].key);
    }
  });
});

describe("intimacy guardrails", () => {
  test("circle caps at 12", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post("/api/join", { code: inviteCode, name: "Member" + i });
      expect(r.status).toBe(200);
    }
    const full = await post("/api/join", { code: inviteCode, name: "TooMany" });
    expect(full.status).toBe(403);
    expect(full.data.error).toMatch(/full/);
  });
  test("presence heartbeat", async () => {
    const { data } = await api("/api/presence", {}, ownerTok);
    expect(data.here.map((h: any) => h.name)).toContain("Ari");
  });
  test("unauthenticated requests are refused", async () => {
    expect((await api("/api/notes")).status).toBe(401);
  });
});
