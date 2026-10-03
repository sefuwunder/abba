// mesh-circles.test.ts — two instances, one with two circles: shared notes
// route only into the explicitly paired circle.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const A_PORT = 32301, B_PORT = 32302;
const procs: any[] = [];

async function api(port: number, path: string, opts: any = {}): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} -> ${d.error || r.status}`);
  return d;
}
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
const post = (port: number, p: string, body: any, tok: string) =>
  api(port, p, { method: "POST", ...auth(tok), body: JSON.stringify(body) });

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

let tokenA1 = "", tokenA2 = "", tokenB1 = "";
let circleA2 = 0, circleB1 = 0;

beforeAll(async () => {
  spawn(A_PORT, mkdtempSync(join(tmpdir(), "abba-mc-a-")));
  spawn(B_PORT, mkdtempSync(join(tmpdir(), "abba-mc-b-")));
  await Promise.all([waitUp(A_PORT), waitUp(B_PORT)]);
  const a1 = await post(A_PORT, "/api/circle/init", { name: "Home", ownerName: "June" }, "");
  tokenA1 = a1.token;
  const a2 = await post(A_PORT, "/api/circles", { name: "Work" }, tokenA1);
  tokenA2 = a2.token; circleA2 = a2.circle.id;
  const b1 = await post(B_PORT, "/api/circle/init", { name: "Home", ownerName: "Sam" }, "");
  tokenB1 = b1.token; circleB1 = b1.circle.id;
}, 60000);

afterAll(() => { for (const p of procs) try { p.kill(); } catch {} });

describe("mesh routes into the paired circle", () => {
  test("peer, then pair B1 explicitly with A2", async () => {
    const inv = await post(A_PORT, "/api/mesh/invite", {}, tokenA1);
    await post(B_PORT, "/api/mesh/join", { code: inv.code }, tokenB1);
    await post(B_PORT, "/api/mesh/sync", {}, tokenB1);
    // find A's node + A2's mesh id from the advertised circles
    const rc = await api(B_PORT, "/api/mesh/remote-circles", auth(tokenB1));
    const node = rc.nodes.find((n: any) => n.circles.some((c: any) => c.name === "Work"));
    expect(node).toBeTruthy();
    const work = node.circles.find((c: any) => c.name === "Work");
    const st = await api(B_PORT, "/api/mesh/status", auth(tokenB1));
    const peerId = st.peers[0].id;
    await post(B_PORT, "/api/mesh/pair", { peerId, circleId: circleB1, remoteMeshId: work.meshId }, tokenB1);
    const st2 = await api(B_PORT, "/api/mesh/status", auth(tokenB1));
    const pairing = st2.pairings.find((p: any) => p.peer_node_id === peerId);
    expect(pairing.local_circle_id).toBe(circleB1);
    expect(pairing.remote_mesh_id).toBe(work.meshId);
  });

  test("a note shared in A2 lands in B1", async () => {
    await post(A_PORT, "/api/notes", { body: "Q3 planning draft.", shared: true }, tokenA2);
    await post(B_PORT, "/api/mesh/sync", {}, tokenB1);
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB1));
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0].body).toContain("Q3 planning");
    expect(notes.notes[0].mine).toBe(false);
  });

  test("a note shared in unpaired A1 does not land in B1", async () => {
    await post(A_PORT, "/api/notes", { body: "Home note, stays home.", shared: true }, tokenA1);
    await post(B_PORT, "/api/mesh/sync", {}, tokenB1);
    const notes = await api(B_PORT, "/api/notes?scope=circle", auth(tokenB1));
    expect(notes.notes).toHaveLength(1); // still only the Work note
    // and A1's own circle feed is intact
    const aNotes = await api(A_PORT, "/api/notes?scope=circle", auth(tokenA1));
    expect(aNotes.notes).toHaveLength(1);
  });
});
