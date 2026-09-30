// circle-admin.test.ts — migrate content to a new empty circle, and burn it all.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const A_PORT = 32103, B_PORT = 32104;
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

let tokenA = "", tokenAri = "", inviteCode = "";

beforeAll(async () => {
  spawn(A_PORT, mkdtempSync(join(tmpdir(), "abba-admin-a-")));
  await waitUp(A_PORT);
  const a = await api(A_PORT, "/api/circle/init", {
    method: "POST", ...auth(""), body: JSON.stringify({ name: "Circle", ownerName: "June" }),
  });
  tokenA = a.token; inviteCode = a.circle.inviteCode;
  const ari = await api(A_PORT, "/api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: inviteCode, name: "Ari" }),
  });
  tokenAri = ari.token;
  // June: one private + one shared note
  await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenA), body: JSON.stringify({ body: "June private", shared: false }) });
  const shared = await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenA), body: JSON.stringify({ body: "June shared", shared: true }) });
  // Ari: one shared (with reaction + comment from June) + one private
  const ariShared = await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenAri), body: JSON.stringify({ body: "Ari shared", shared: true }) });
  await api(A_PORT, "/api/notes", { method: "POST", ...auth(tokenAri), body: JSON.stringify({ body: "Ari private", shared: false }) });
  await api(A_PORT, `/api/notes/${ariShared.note.id}/react`, { method: "POST", ...auth(tokenA), body: JSON.stringify({ kind: "felt" }) });
  await api(A_PORT, `/api/notes/${ariShared.note.id}/comments`, { method: "POST", ...auth(tokenA), body: JSON.stringify({ body: "nice one" }) });
  // stash ids
  (globalThis as any).__sharedId = shared.note.id;
}, 60000);

afterAll(() => { for (const p of procs) try { p.kill(); } catch {} });

describe("migrate", () => {
  test("owner migrates content to a new empty circle", async () => {
    const d = await api(A_PORT, "/api/circle/migrate", { method: "POST", ...auth(tokenA) });
    expect(d.migratedNotes).toBe(3); // June private + June shared + Ari shared
    expect(d.inviteCode).not.toBe(inviteCode);
    inviteCode = d.inviteCode;

    // members: owner + one migrated shadow; Ari's token is dead
    const members = await api(A_PORT, "/api/members", auth(tokenA));
    const roles = members.members.map((m: any) => m.role).sort();
    expect(roles).toEqual(["migrated", "owner"]);
    try { await api(A_PORT, "/api/me", auth(tokenAri)); expect.unreachable(); }
    catch (e: any) { expect(String(e.message)).toContain("Not signed in"); }

    // notes: 3, with reactions + comments intact on the migrated shared note
    const mine = await api(A_PORT, "/api/notes?scope=mine", auth(tokenA));
    expect(mine.notes).toHaveLength(2);
    const circle = await api(A_PORT, "/api/notes?scope=circle", auth(tokenA));
    expect(circle.notes).toHaveLength(2);
    const ariNote = circle.notes.find((n: any) => n.body === "Ari shared");
    expect(ariNote).toBeTruthy();
    const detail = await api(A_PORT, `/api/notes/${ariNote.id}`, auth(tokenA));
    expect(detail.note.reactionCounts.felt).toBe(1);
    expect(detail.note.comments.length).toBe(1);
    expect(detail.note.comments[0].body).toBe("nice one");
  });

  test("non-owner gets an export bundle instead of an in-place migrate", async () => {
    const rook = await api(A_PORT, "/api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode, name: "Rook" }),
    });
    const d = await api(A_PORT, "/api/circle/migrate", { method: "POST", ...auth(rook.token) });
    expect(d.export).toBeTruthy();
    expect(d.export.version).toBe(1);
    expect(d.migratedNotes).toBeUndefined();
    // the circle itself is untouched
    const st = await api(A_PORT, "/api/status");
    expect(st.hasCircle).toBe(true);
  });
});

describe("burn", () => {
  test("burn requires the word BURN", async () => {
    try {
      await api(A_PORT, "/api/circle/burn", { method: "POST", ...auth(tokenA), body: JSON.stringify({ confirm: "yes" }) });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("BURN"); }
    const st = await api(A_PORT, "/api/status");
    expect(st.hasCircle).toBe(true);
  });

  test("non-owner cannot burn", async () => {
    const members = await api(A_PORT, "/api/members", auth(tokenA));
    const rook = members.members.find((m: any) => m.name === "Rook");
    // Rook's token unknown here; use a fresh join instead
    const r2 = await api(A_PORT, "/api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode, name: "Rook2" }),
    });
    try {
      await api(A_PORT, "/api/circle/burn", { method: "POST", ...auth(r2.token), body: JSON.stringify({ confirm: "BURN" }) });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("owner"); }
    expect(rook).toBeTruthy();
  });

  test("burn destroys the circle", async () => {
    const d = await api(A_PORT, "/api/circle/burn", { method: "POST", ...auth(tokenA), body: JSON.stringify({ confirm: "BURN" }) });
    expect(d.ok).toBe(true);
    const st = await api(A_PORT, "/api/status");
    expect(st.hasCircle).toBe(false);
    try { await api(A_PORT, "/api/me", auth(tokenA)); expect.unreachable(); }
    catch (e: any) { expect(String(e.message)).toContain("Not signed in"); }
    // mesh peers are gone, but the node still answers sync (tombstones served)
    const mst = await fetch(`http://127.0.0.1:${A_PORT}/api/sync/state`).then(r => r.json());
    expect(mst.id).toBeTruthy();
  });
});

describe("migrate/burn across the mesh", () => {
  let tokenB = "";
  beforeAll(async () => {
    spawn(B_PORT, mkdtempSync(join(tmpdir(), "abba-admin-b-")));
    await waitUp(B_PORT);
    const b = await api(B_PORT, "/api/circle/init", {
      method: "POST", ...auth(""), body: JSON.stringify({ name: "Circle B", ownerName: "Sam" }),
    });
    tokenB = b.token;
    // fresh A state for this block: re-init a circle on A (it was burned)
    const a = await api(A_PORT, "/api/circle/init", {
      method: "POST", ...auth(""), body: JSON.stringify({ name: "Circle A2", ownerName: "June" }),
    });
    tokenA = a.token;
    const note = await api(A_PORT, "/api/notes", {
      method: "POST", ...auth(tokenA), body: JSON.stringify({ body: "mesh migrate me", shared: true }),
    });
    (globalThis as any).__meshNoteId = note.note.id;
    // peer A <-> B
    const inv = await api(A_PORT, "/api/mesh/invite", { method: "POST", ...auth(tokenA) });
    await api(B_PORT, "/api/mesh/join", { method: "POST", ...auth(tokenB), body: JSON.stringify({ code: inv.code }) });
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB));
    expect(notes.notes.length).toBe(1);
  }, 60000);

  test("migrate replaces the note on the peer (no duplicates)", async () => {
    await api(A_PORT, "/api/circle/migrate", { method: "POST", ...auth(tokenA) });
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB));
    expect(notes.notes.length).toBe(1);
    expect(notes.notes[0].body).toBe("mesh migrate me");
  });

  test("burn retracts the note from the peer", async () => {
    await api(A_PORT, "/api/circle/burn", { method: "POST", ...auth(tokenA), body: JSON.stringify({ confirm: "BURN" }) });
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB));
    expect(notes.notes.length).toBe(0);
  });
});

describe("reset", () => {
  const R_PORT = 32107;
  let tokenR = "";
  const nodeIdOf = (code: string): string =>
    JSON.parse(Buffer.from(code, "base64url").toString("utf8")).id;

  beforeAll(async () => {
    spawn(R_PORT, mkdtempSync(join(tmpdir(), "abba-reset-")));
    await waitUp(R_PORT);
    const r = await api(R_PORT, "/api/circle/init", {
      method: "POST", ...auth(""), body: JSON.stringify({ name: "Doomed", ownerName: "Zed" }),
    });
    tokenR = r.token;
    await api(R_PORT, "/api/notes", { method: "POST", ...auth(tokenR), body: JSON.stringify({ body: "wipe me", shared: true }) });
  }, 60000);

  test("non-owner cannot reset", async () => {
    const m = await api(R_PORT, "/api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: (await api(R_PORT, "/api/circle", auth(tokenR))).inviteCode, name: "Pip" }),
    });
    try {
      await api(R_PORT, "/api/circle/reset", { method: "POST", ...auth(m.token) });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("owner"); }
  });

  test("reset wipes everything and mints a new identity", async () => {
    const before = await api(R_PORT, "/api/mesh/invite", { method: "POST", ...auth(tokenR) });
    await api(R_PORT, "/api/circle/reset", { method: "POST", ...auth(tokenR) });
    // back to the welcome screen
    const st = await api(R_PORT, "/api/status");
    expect(st.hasCircle).toBe(false);
    // old tokens are dead
    try { await api(R_PORT, "/api/notes?scope=mine", auth(tokenR)); expect.unreachable(); }
    catch (e: any) { expect(String(e.message)).toContain("signed in"); }
    // a brand-new circle starts empty with a new node identity
    const r2 = await api(R_PORT, "/api/circle/init", {
      method: "POST", ...auth(""), body: JSON.stringify({ name: "Fresh", ownerName: "Zed" }),
    });
    const after = await api(R_PORT, "/api/mesh/invite", { method: "POST", ...auth(r2.token) });
    expect(nodeIdOf(after.code)).not.toBe(nodeIdOf(before.code));
    const notes = await api(R_PORT, "/api/notes?scope=mine", auth(r2.token));
    expect(notes.notes.length).toBe(0);
    const members = await api(R_PORT, "/api/members", auth(r2.token));
    expect(members.members.length).toBe(1);
  });
});

describe("fresh-start", () => {
  const F_PORT = 32109;
  const nodeIdOf = (code: string): string =>
    JSON.parse(Buffer.from(code, "base64url").toString("utf8")).id;
  const freshStart = (body: any, token = "") =>
    api(F_PORT, "/api/circle/fresh-start", {
      method: "POST", ...(token ? auth(token) : { headers: { "Content-Type": "application/json" } }),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    spawn(F_PORT, mkdtempSync(join(tmpdir(), "abba-fresh-")));
    await waitUp(F_PORT);
    const r = await api(F_PORT, "/api/circle/init", {
      method: "POST", ...auth(""), body: JSON.stringify({ name: "Old", ownerName: "June" }),
    });
    (globalThis as any).__freshOwner = r.token;
    await api(F_PORT, "/api/notes", { method: "POST", ...auth(r.token), body: JSON.stringify({ body: "old note", shared: true }) });
  }, 60000);

  test("recovery hatch: no token works when the owner never set a secret", async () => {
    const before = await api(F_PORT, "/api/mesh/invite", { method: "POST", ...auth((globalThis as any).__freshOwner) });
    const d = await freshStart({ name: "New Dawn", ownerName: "June" });
    expect(d.member.role).toBe("owner");
    expect(d.circle.name).toBe("New Dawn");
    (globalThis as any).__freshOwner = d.token;
    const notes = await api(F_PORT, "/api/notes?scope=mine", auth(d.token));
    expect(notes.notes.length).toBe(0);
    const after = await api(F_PORT, "/api/mesh/invite", { method: "POST", ...auth(d.token) });
    expect(nodeIdOf(after.code)).not.toBe(nodeIdOf(before.code));
  });

  test("a member's secret doesn't close the owner's recovery hatch", async () => {
    const tok = (globalThis as any).__freshOwner; // secretless owner of "New Dawn"
    const circle = await api(F_PORT, "/api/circle", auth(tok));
    const m = await api(F_PORT, "/api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: circle.inviteCode, name: "Pip" }),
    });
    await api(F_PORT, "/api/account/password", { method: "POST", ...auth(m.token), body: JSON.stringify({ password: "pip secret" }) });
    const d = await freshStart({ name: "Fourth", ownerName: "June" });
    expect(d.circle.name).toBe("Fourth");
    expect(d.member.role).toBe("owner");
    (globalThis as any).__freshOwner = d.token;
  });

  test("locked once the owner has a secret: no token -> 403", async () => {
    const tok = (globalThis as any).__freshOwner;
    await api(F_PORT, "/api/account/password", { method: "POST", ...auth(tok), body: JSON.stringify({ password: "june secret" }) });
    try {
      await freshStart({ name: "Nope", ownerName: "June" });
      expect.unreachable();
    } catch (e: any) { expect(String(e.message)).toContain("owner"); }
  });

  test("owner token still works after the hatch closes", async () => {
    const tok = (globalThis as any).__freshOwner;
    const d = await freshStart({ name: "Fifth", ownerName: "June" }, tok);
    expect(d.circle.name).toBe("Fifth");
    expect(d.member.role).toBe("owner");
  });
});
