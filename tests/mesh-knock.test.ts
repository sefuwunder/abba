// mesh-knock.test.ts — peer *towards* a new instance by URL alone.
// D knocks on C's URL: no invite code changes hands. Verifies mutual peering
// (the accept-back), two-way shared-note replication, and the error paths.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const C_PORT = 32103, D_PORT = 32104, FAKE_PORT = 32105;
const procs: any[] = [];
let fake: any = null;

async function api(port: number, path: string, opts: any = {}): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${path} -> ${d.error || r.status}`), { status: r.status, body: d });
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

let tokenC = "", tokenD = "", memberTokenD = "";

beforeAll(async () => {
  spawn(C_PORT, mkdtempSync(join(tmpdir(), "abba-knock-c-")));
  spawn(D_PORT, mkdtempSync(join(tmpdir(), "abba-knock-d-")));
  await Promise.all([waitUp(C_PORT), waitUp(D_PORT)]);
  const c = await api(C_PORT, "/api/circle/init", { method: "POST", body: JSON.stringify({ name: "Circle C", ownerName: "June" }) });
  const d = await api(D_PORT, "/api/circle/init", { method: "POST", body: JSON.stringify({ name: "Circle D", ownerName: "Sam" }) });
  tokenC = c.token; tokenD = d.token;
  // a non-owner member on D for the authz check
  const circle = await api(D_PORT, "/api/circle", auth(tokenD));
  const m = await api(D_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: circle.inviteCode, name: "Pat" }) });
  memberTokenD = m.token;
  // a fake HTTP server that is not a mesh node
  fake = Bun.serve({ port: FAKE_PORT, fetch: () => new Response(JSON.stringify({ hello: "not abba" })) });
}, 60000);

afterAll(() => {
  for (const p of procs) try { p.kill(); } catch {}
  try { fake.stop(); } catch {}
});

describe("knock peering", () => {
  test("D knocks on C by URL — no invite code", async () => {
    const knocked = await api(D_PORT, "/api/mesh/knock", {
      method: "POST", ...auth(tokenD),
      body: JSON.stringify({ url: `http://127.0.0.1:${C_PORT}` }),
    });
    expect(knocked.peer.id).toHaveLength(32);
    const st = await api(D_PORT, "/api/mesh/status", auth(tokenD));
    expect(st.peers).toHaveLength(1);
    expect(st.peers[0].url).toBe(`http://127.0.0.1:${C_PORT}`);
  });

  test("mutual: C added D back via the accept handshake", async () => {
    const st = await api(C_PORT, "/api/mesh/status", auth(tokenC));
    expect(st.peers).toHaveLength(1);
    expect(st.peers[0].url).toBe(`http://127.0.0.1:${D_PORT}`);
  });

  test("shared note replicates C -> D after knock", async () => {
    await api(C_PORT, "/api/notes", {
      method: "POST", ...auth(tokenC),
      body: JSON.stringify({ body: "Knocked notes travel too.", shared: true }),
    });
    await api(D_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenD) });
    const notes = await api(D_PORT, "/api/notes?scope=circle", auth(tokenD));
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0].body).toContain("Knocked notes");
  });

  test("shared note replicates D -> C (both directions)", async () => {
    await api(D_PORT, "/api/notes", {
      method: "POST", ...auth(tokenD),
      body: JSON.stringify({ body: "And back the other way.", shared: true }),
    });
    await api(C_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenC) });
    const notes = await api(C_PORT, "/api/notes?scope=circle", auth(tokenC));
    expect(notes.notes).toHaveLength(2);
    expect(notes.notes.map((n: any) => n.body).join(" ")).toContain("other way");
  });

  test("knock rejects non-URLs, dead hosts, non-nodes, and self", async () => {
    await expect(api(D_PORT, "/api/mesh/knock", { method: "POST", ...auth(tokenD), body: JSON.stringify({ url: "not a url" }) }))
      .rejects.toMatchObject({ status: 400 });
    await expect(api(D_PORT, "/api/mesh/knock", { method: "POST", ...auth(tokenD), body: JSON.stringify({ url: "http://127.0.0.1:9/" }) }))
      .rejects.toMatchObject({ status: 502 });
    await expect(api(D_PORT, "/api/mesh/knock", { method: "POST", ...auth(tokenD), body: JSON.stringify({ url: `http://127.0.0.1:${FAKE_PORT}` }) }))
      .rejects.toMatchObject({ status: 400 });
    await expect(api(D_PORT, "/api/mesh/knock", { method: "POST", ...auth(tokenD), body: JSON.stringify({ url: `http://127.0.0.1:${D_PORT}` }) }))
      .rejects.toMatchObject({ status: 400 });
  });

  test("non-owners cannot knock", async () => {
    await expect(api(D_PORT, "/api/mesh/knock", { method: "POST", ...auth(memberTokenD), body: JSON.stringify({ url: `http://127.0.0.1:${C_PORT}` }) }))
      .rejects.toMatchObject({ status: 403 });
  });
});
