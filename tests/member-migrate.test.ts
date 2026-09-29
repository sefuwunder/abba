// member-migrate.test.ts — a non-host forks to their own circle: keeps data,
// becomes host, carries frozen links + comments, old circle's stream stays out.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const A_PORT = 32105, C_PORT = 32106;
const procs: any[] = [];

async function api(port: number, path: string, opts: any = {}): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${d.error || r.status}`);
  return d;
}
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

function spawn(port: number, dataDir: string): void {
  procs.push(Bun.spawn(["bun", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ABBA_DATA: dataDir, ABBA_PORT: String(port), ABBA_PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdout: "ignore", stderr: "ignore",
  }));
}
async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/status`); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error("abba did not start on :" + port);
}

let tokenJune = "", tokenAri = "", bundle: any;

beforeAll(async () => {
  spawn(A_PORT, mkdtempSync(join(tmpdir(), "abba-mmig-a-")));
  spawn(C_PORT, mkdtempSync(join(tmpdir(), "abba-mmig-c-")));
  await Promise.all([waitUp(A_PORT), waitUp(C_PORT)]);
  const a = await api(A_PORT, "/api/circle/init", {
    method: "POST", ...auth(""), body: JSON.stringify({ name: "Old Circle", ownerName: "June" }),
  });
  tokenJune = a.token;
  const ari = await api(A_PORT, "/api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: a.circle.inviteCode, name: "Ari" }),
  });
  tokenAri = ari.token;
  // June shares a note; Ari comments + reacts on it
  const jn = await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenJune), body: JSON.stringify({ body: "June's wisdom", shared: true }) });
  (globalThis as any).__juneNote = jn.note.id;
  await api(A_PORT, `/api/notes/${jn.note.id}/comments`, { method: "POST", ...auth(tokenAri), body: JSON.stringify({ body: "Ari's take" }) });
  await api(A_PORT, `/api/notes/${jn.note.id}/react`, { method: "POST", ...auth(tokenAri), body: JSON.stringify({ kind: "spark" }) });
  // Ari's own notes (private + shared); June comments on the shared one
  await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenAri), body: JSON.stringify({ body: "Ari private", shared: false }) });
  const as = await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenAri), body: JSON.stringify({ body: "Ari shared", shared: true }) });
  await api(A_PORT, `/api/notes/${as.note.id}/comments`, { method: "POST", ...auth(tokenJune), body: JSON.stringify({ body: "June replies" }) });
  // Ari sets a secret (should carry over)
  await api(A_PORT, "/api/account/password", { method: "POST", ...auth(tokenAri), body: JSON.stringify({ password: "ari secret phrase" }) });
}, 60000);

afterAll(() => { for (const p of procs) try { p.kill(); } catch {} });

describe("member export", () => {
  test("non-host gets a bundle, not an in-place migrate", async () => {
    const d = await api(A_PORT, "/api/circle/migrate", { method: "POST", ...auth(tokenAri) });
    expect(d.export).toBeTruthy();
    expect(d.export.version).toBe(1);
    expect(d.export.profile.name).toBe("Ari");
    expect(d.export.profile.passwordHash).toBeTruthy();
    expect(d.export.notes).toHaveLength(2);
    expect(d.export.links).toHaveLength(1);
    expect(d.export.links[0].title).toBe("June's wisdom");
    expect(d.export.links[0].author.name).toBe("June");
    expect(d.export.links[0].comments.map((c: any) => c.body)).toContain("Ari's take");
    // old circle untouched
    const st = await api(A_PORT, "/api/status");
    expect(st.hasCircle).toBe(true);
    bundle = d.export;
  });

  test("owner still migrates in place", async () => {
    const d = await api(A_PORT, "/api/circle/migrate", { method: "POST", ...auth(tokenJune) });
    expect(d.migratedNotes).toBeGreaterThan(0);
    expect(d.export).toBeUndefined();
  });
});

describe("import onto a fresh instance", () => {
  let tokenC = "";
  test("bundle becomes a new circle with Ari as host", async () => {
    const d = await api(C_PORT, "/api/circle/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundle, circleName: "Ari's Circle" }),
    });
    expect(d.member.role).toBe("owner");
    expect(d.member.name).toBe("Ari");
    expect(d.circle.name).toBe("Ari's Circle");
    tokenC = d.token;
    (globalThis as any).__tokenC = tokenC;

    const mine = await api(C_PORT, "/api/notes?scope=mine", auth(tokenC));
    expect(mine.notes).toHaveLength(2);
    const circle = await api(C_PORT, "/api/notes?scope=circle", auth(tokenC));
    // 1 shared of hers + 1 frozen link
    expect(circle.notes).toHaveLength(2);
    const link = circle.notes.find((n: any) => n.link);
    expect(link).toBeTruthy();
    expect(link.title).toBe("June's wisdom");
    expect(link.link.name).toBe("June");
  });

  test("comments and reactions carried over", async () => {
    const tokenC = (globalThis as any).__tokenC;
    const circle = await api(C_PORT, "/api/notes?scope=circle", auth(tokenC));
    const link = circle.notes.find((n: any) => n.link);
    const detail = await api(C_PORT, `/api/notes/${link.id}`, auth(tokenC));
    expect(detail.note.comments.map((c: any) => c.body)).toContain("Ari's take");
    expect(detail.note.reactionCounts.spark).toBe(1);
    const mine = await api(C_PORT, "/api/notes?scope=mine", auth(tokenC));
    const hers = mine.notes.find((n: any) => n.body === "Ari shared");
    const hd = await api(C_PORT, `/api/notes/${hers.id}`, auth(tokenC));
    expect(hd.note.comments.map((c: any) => c.body)).toContain("June replies");
  });

  test("links are read-only but removable", async () => {
    const tokenC = (globalThis as any).__tokenC;
    const circle = await api(C_PORT, "/api/notes?scope=circle", auth(tokenC));
    const link = circle.notes.find((n: any) => n.link);
    try {
      await api(C_PORT, `/api/notes/${link.id}`, { method: "PATCH", ...auth(tokenC), body: JSON.stringify({ title: "x" }) });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("read-only"); }
    try {
      await api(C_PORT, `/api/notes/${link.id}/react`, { method: "POST", ...auth(tokenC), body: JSON.stringify({ kind: "felt" }) });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("read-only"); }
    // owner can remove the link
    await api(C_PORT, `/api/notes/${link.id}`, { method: "DELETE", ...auth(tokenC) });
    const after = await api(C_PORT, "/api/notes?scope=circle", auth(tokenC));
    expect(after.notes.find((n: any) => n.link)).toBeUndefined();
  });

  test("secret carried over — re-open works on the new circle", async () => {
    const ro = await api(C_PORT, "/api/account/reopen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ari", password: "ari secret phrase" }),
    });
    expect(ro.member.name).toBe("Ari");
    expect(ro.member.role).toBe("owner");
  });

  test("import refuses when a circle already exists", async () => {
    try {
      await api(C_PORT, "/api/circle/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle }),
      });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("already has a circle"); }
  });

  test("no new shared notes flow in from the old circle", async () => {
    const tokenC = (globalThis as any).__tokenC;
    // peer C with A (mesh), then A shares something brand new
    const inv = await api(A_PORT, "/api/mesh/invite", { method: "POST", ...auth(tokenJune) });
    await api(C_PORT, "/api/mesh/join", { method: "POST", ...auth(tokenC), body: JSON.stringify({ code: inv.code }) });
    // A's new note after the block
    await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenJune), body: JSON.stringify({ body: "brand new from old circle", shared: true }) });
    await api(C_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenC) });
    const circle = await api(C_PORT, "/api/notes?scope=circle", auth(tokenC));
    const bodies = circle.notes.map((n: any) => n.body);
    expect(bodies).not.toContain("brand new from old circle");
  });
});
