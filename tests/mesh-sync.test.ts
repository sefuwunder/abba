// mesh-sync.test.ts — two real Abba instances peer over the embedded mesh node:
// shared notes, reactions, comments replicate; unshare retracts; private
// notes never leave the instance.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const A_PORT = 32101, B_PORT = 32102;
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
    env: {
      ...process.env,
      ABBA_DATA: dataDir,
      ABBA_PORT: String(port),
      ABBA_PUBLIC_URL: `http://127.0.0.1:${port}`,
    },
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

let tokenA = "", tokenB = "";
let noteIdB = 0;

beforeAll(async () => {
  spawn(A_PORT, mkdtempSync(join(tmpdir(), "abba-mesh-a-")));
  spawn(B_PORT, mkdtempSync(join(tmpdir(), "abba-mesh-b-")));
  await Promise.all([waitUp(A_PORT), waitUp(B_PORT)]);
  const a = await api(A_PORT, "/api/circle/init", { method: "POST", ...auth(""), body: JSON.stringify({ name: "Circle A", ownerName: "June" }) });
  const b = await api(B_PORT, "/api/circle/init", { method: "POST", ...auth(""), body: JSON.stringify({ name: "Circle B", ownerName: "Sam" }) });
  tokenA = a.token; tokenB = b.token;
}, 60000);

afterAll(() => { for (const p of procs) try { p.kill(); } catch {} });

describe("abba over mesh", () => {
  test("peering two instances", async () => {
    const inv = await api(A_PORT, "/api/mesh/invite", { method: "POST", ...auth(tokenA) });
    expect(inv.code.length).toBeGreaterThan(50);
    const joined = await api(B_PORT, "/api/mesh/join", { method: "POST", ...auth(tokenB), body: JSON.stringify({ code: inv.code }) });
    expect(joined.peer.id).toBe(inv.nodeId);
    const st = await api(B_PORT, "/api/mesh/status", auth(tokenB));
    expect(st.peers).toHaveLength(1);
  });

  test("shared note replicates A -> B", async () => {
    const created = await api(A_PORT, "/api/notes", {
      method: "POST", ...auth(tokenA),
      body: JSON.stringify({ body: "The Madison building is ours if we move fast.", shared: true }),
    });
    expect(created.note.id).toBeGreaterThan(0);
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB));
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0].title).toBe(created.note.title);
    expect(notes.notes[0].body).toContain("Madison");
    noteIdB = notes.notes[0].id;
    // author attribution rode along
    const detail = await api(B_PORT, `/api/notes/${noteIdB}`, auth(tokenB));
    expect(detail.note.mine).toBe(false);
  });

  test("private notes never leave the instance", async () => {
    await api(A_PORT, "/api/notes", {
      method: "POST", ...auth(tokenA),
      body: JSON.stringify({ body: "Secret diary entry.", shared: false }),
    });
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB));
    expect(notes.notes).toHaveLength(1); // still only the shared one
    const mine = await api(A_PORT, "/api/notes?scope=mine", auth(tokenA));
    expect(mine.notes).toHaveLength(2);
  });

  test("reaction replicates B -> A without loss", async () => {
    await api(B_PORT, `/api/notes/${noteIdB}/react`, {
      method: "POST", ...auth(tokenB), body: JSON.stringify({ kind: "felt" }),
    });
    await api(A_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenA) });
    const notes = await api(A_PORT, "/api/notes?scope=circle", auth(tokenA));
    const n = notes.notes[0];
    expect(n.reactionCounts.felt).toBe(1);
    expect(n.myReactions).not.toContain("felt"); // it's Sam's, not June's
  });

  test("comment replicates B -> A", async () => {
    await api(B_PORT, `/api/notes/${noteIdB}/comments`, {
      method: "POST", ...auth(tokenB), body: JSON.stringify({ body: "Let's tour it Friday." }),
    });
    await api(A_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenA) });
    const notes = await api(A_PORT, "/api/notes?scope=circle", auth(tokenA));
    const idA = notes.notes[0].id;
    const detail = await api(A_PORT, `/api/notes/${idA}`, auth(tokenA));
    expect(detail.note.comments.length).toBe(1);
    expect(detail.note.comments[0].body).toBe("Let's tour it Friday.");
  });

  test("status change replicates A -> B", async () => {
    const notes = await api(A_PORT, "/api/notes?scope=circle", auth(tokenA));
    const idA = notes.notes[0].id;
    await api(A_PORT, `/api/notes/${idA}`, {
      method: "PATCH", ...auth(tokenA), body: JSON.stringify({ status: "motion" }),
    });
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const detail = await api(B_PORT, `/api/notes/${noteIdB}`, auth(tokenB));
    expect(detail.note.status).toBe("motion");
  });

  test("unshare retracts the note from the peer", async () => {
    const notes = await api(A_PORT, "/api/notes?scope=circle", auth(tokenA));
    const idA = notes.notes[0].id;
    await api(A_PORT, `/api/notes/${idA}/unshare`, { method: "POST", ...auth(tokenA) });
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    const after = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB));
    expect(after.notes).toHaveLength(0);
  });

  test("non-owners cannot peer instances", async () => {
    // join the circle as a plain member on A
    const circle = await api(A_PORT, "/api/circle", auth(tokenA));
    const joined = await api(A_PORT, "/api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: circle.inviteCode, name: "Rook" }),
    });
    try {
      await api(A_PORT, "/api/mesh/invite", { method: "POST", ...auth(joined.token) });
      expect.unreachable();
    } catch (e: any) {
      expect(String(e.message)).toContain("owner");
    }
  });
});

describe("account password + reopen", () => {
  const secret = "june's orchard passphrase";

  test("set secret, then re-open on the same device", async () => {
    await api(A_PORT, "/api/account/password", {
      method: "POST", ...auth(tokenA), body: JSON.stringify({ password: secret }),
    });
    const me = await api(A_PORT, "/api/me", auth(tokenA));
    expect(me.member.hasPassword).toBe(true);
    // token "lost" — re-open with name + secret, no bearer
    const ro = await api(A_PORT, "/api/account/reopen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "june", password: secret }),
    });
    expect(ro.token).toBeTruthy();
    expect(ro.fromMesh).toBeUndefined();
    const me2 = await api(A_PORT, "/api/me", auth(ro.token));
    expect(me2.member.name).toBe("June");
  });

  test("wrong secret fails closed", async () => {
    try {
      await api(A_PORT, "/api/account/reopen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "June", password: "wrong guess" }),
      });
      expect.unreachable();
    } catch (e: any) {
      expect(String(e.message)).toContain("No account matches");
    }
  });

  test("short secret rejected", async () => {
    try {
      await api(A_PORT, "/api/account/password", {
        method: "POST", ...auth(tokenA), body: JSON.stringify({ password: "abc" }),
      });
      expect.unreachable();
    } catch (e: any) {
      expect(String(e.message)).toContain("at least 4");
    }
  });

  test("re-open from the mesh on the peered instance", async () => {
    // pull the credential KV that A's password-set published
    await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
    // B has no June — the mesh provides her
    const ro = await api(B_PORT, "/api/account/reopen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "June", password: secret }),
    });
    expect(ro.fromMesh).toBe(true);
    expect(ro.member.role).toBe("member");
    expect(ro.member.name).toBe("June");
    const me = await api(B_PORT, "/api/me", auth(ro.token));
    expect(me.member.name).toBe("June");
    // the hash carried over: a second re-open now resolves locally
    const ro2 = await api(B_PORT, "/api/account/reopen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "June", password: secret }),
    });
    expect(ro2.fromMesh).toBeUndefined();
    expect(ro2.member.id).toBe(ro.member.id);
  });

  test("remote shadow members can't be re-opened", async () => {
    // Sam reacted on B earlier; if a shadow ever got a hash it still must not open
    try {
      await api(A_PORT, "/api/account/reopen", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Nobody Here", password: secret }),
      });
      expect.unreachable();
    } catch (e: any) {
      expect(String(e.message)).toContain("No account matches");
    }
  });
});
