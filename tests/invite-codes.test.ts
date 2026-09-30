// invite-codes.test.ts — circle invite codes are mesh-wide and expire.
// A peer's code joins this instance; expired codes (own or peered) are
// rejected; regenerate rotates code + expiry; old installs get a grace
// window on boot.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const A_PORT = 32111, B_PORT = 32112, C_PORT = 32113;
const procs: any[] = [];
const dataA = mkdtempSync(join(tmpdir(), "abba-inv-a-"));
const dataB = mkdtempSync(join(tmpdir(), "abba-inv-b-"));
const dataC = mkdtempSync(join(tmpdir(), "abba-inv-c-"));

async function api(port: number, path: string, opts: any = {}): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${path} -> ${d.error || r.status}`), { status: r.status, body: d });
  return d;
}
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

function spawn(port: number, dataDir: string): any {
  const p = Bun.spawn(["bun", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ABBA_DATA: dataDir, ABBA_PORT: String(port), ABBA_PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdout: "ignore", stderr: "ignore",
  });
  procs.push(p);
  return p;
}
async function waitUp(port: number): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/status`); return; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error("abba did not start on :" + port);
}
function setExpiry(dataDir: string, iso: string | null): void {
  const db = new Database(join(dataDir, "abba.db"));
  db.query("UPDATE circle SET invite_expires_at = ? WHERE id = 1").run(iso);
  db.close();
}

let tokenA = "", tokenB = "", codeA = "", codeB = "";

beforeAll(async () => {
  spawn(A_PORT, dataA);
  spawn(B_PORT, dataB);
  await Promise.all([waitUp(A_PORT), waitUp(B_PORT)]);
  const a = await api(A_PORT, "/api/circle/init", { method: "POST", body: JSON.stringify({ name: "Circle A", ownerName: "June" }) });
  const b = await api(B_PORT, "/api/circle/init", { method: "POST", body: JSON.stringify({ name: "Circle B", ownerName: "Sam" }) });
  tokenA = a.token; tokenB = b.token;
  codeA = a.circle.inviteCode; codeB = b.circle.inviteCode;
  // B knocks A: B's immediate pull learns A's code; A learns B's via forced sync
  await api(B_PORT, "/api/mesh/knock", { method: "POST", ...auth(tokenB), body: JSON.stringify({ url: `http://127.0.0.1:${A_PORT}` }) });
  await api(A_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenA) });
}, 60000);

afterAll(() => { for (const p of procs) try { p.kill(); } catch { /* already down */ } });

test("codes carry a future expiry at issuance", async () => {
  const c = await api(A_PORT, "/api/circle", auth(tokenA));
  expect(c.inviteCode).toBe(codeA);
  expect(Date.parse(c.inviteExpiresAt)).toBeGreaterThan(Date.now());
});

test("a peer's code joins this instance (mesh-wide)", async () => {
  const j = await api(B_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: codeA, name: "Rae" }) });
  expect(j.member.name).toBe("Rae");
  const members = await api(B_PORT, "/api/members", auth(tokenB));
  expect(members.members.some((m: any) => m.name === "Rae")).toBe(true);
});

test("reverse direction works too", async () => {
  const j = await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: codeB, name: "Kim" }) });
  expect(j.member.name).toBe("Kim");
});

test("unknown code is rejected", async () => {
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: "abba-nope12", name: "Zed" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
});

test("expired own code is rejected", async () => {
  setExpiry(dataA, new Date(Date.now() - 1000).toISOString());
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: codeA, name: "Lou" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); expect(e.body.error).toMatch(/expired/i); }
});

test("expired peer code is rejected mesh-wide", async () => {
  // A's tick re-publishes the lapsed code; B pulls it and stops honoring it
  await api(A_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenA) });
  await api(B_PORT, "/api/mesh/sync", { method: "POST", ...auth(tokenB) });
  try {
    await api(B_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: codeA, name: "Nia" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
});

test("regenerate issues a fresh unexpired code; the old one dies", async () => {
  const r = await api(A_PORT, "/api/invite/regenerate", { method: "POST", ...auth(tokenA) });
  expect(r.inviteCode).not.toBe(codeA);
  expect(Date.parse(r.inviteExpiresAt)).toBeGreaterThan(Date.now());
  const j = await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: r.inviteCode, name: "Ari" }) });
  expect(j.member.name).toBe("Ari");
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: codeA, name: "Old" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
});

test("pre-expiry installs get a grace window on boot", async () => {
  const proc = spawn(C_PORT, dataC);
  await waitUp(C_PORT);
  const c = await api(C_PORT, "/api/circle/init", { method: "POST", body: JSON.stringify({ name: "Circle C", ownerName: "Mo" }) });
  // simulate an old install that predates expiring codes
  setExpiry(dataC, null);
  try { proc.kill(); } catch { /* ignore */ }
  await new Promise(r => setTimeout(r, 500));
  spawn(C_PORT, dataC);
  await waitUp(C_PORT);
  const after = await api(C_PORT, "/api/circle", { headers: { Authorization: `Bearer ${c.token}` } });
  expect(after.inviteCode).toBe(c.circle.inviteCode); // same code, not rotated
  expect(Date.parse(after.inviteExpiresAt)).toBeGreaterThan(Date.now()); // granted a window
}, 60000);
