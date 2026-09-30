// circle-invites.test.ts — targeted invites: every member has a unique user
// ID; the owner adds specific users by ID; they join with the ID (one use).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

const A_PORT = 32121;
const procs: any[] = [];
const dataA = mkdtempSync(join(tmpdir(), "abba-tinv-a-"));

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

let tokenA = "", memberToken = "", codeA = "", ownerUid = "";
const uid = (s: string) => "usr-" + s.repeat(20).slice(0, 20);

beforeAll(async () => {
  spawn(A_PORT, dataA);
  await waitUp(A_PORT);
  const a = await api(A_PORT, "/api/circle/init", { method: "POST", body: JSON.stringify({ name: "Circle A", ownerName: "June" }) });
  tokenA = a.token; codeA = a.circle.inviteCode;
  ownerUid = (await api(A_PORT, "/api/me", auth(tokenA))).member.userId;
  const m = await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ code: codeA, name: "Pat" }) });
  memberToken = m.token;
}, 60000);

afterAll(() => { for (const p of procs) try { p.kill(); } catch { /* already down */ } });

test("members have unique user IDs", async () => {
  expect(ownerUid).toMatch(/^usr-[A-Za-z0-9_-]{16,}$/);
  const me = await api(A_PORT, "/api/me", auth(memberToken));
  expect(me.member.userId).toMatch(/^usr-[A-Za-z0-9_-]{16,}$/);
  expect(me.member.userId).not.toBe(ownerUid);
});

test("owner adds a user by ID; they join with it", async () => {
  const target = uid("a");
  const r = await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(tokenA), body: JSON.stringify({ userId: target, name: "Rae" }) });
  expect(r.invite.userId).toBe(target);
  const list = await api(A_PORT, "/api/circle/invites", auth(tokenA));
  expect(list.invites.some((i: any) => i.user_id === target)).toBe(true);
  const j = await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: target, name: "Rae" }) });
  expect(j.member.name).toBe("Rae");
  expect(j.member.userId).toBe(target);
});

test("non-owner cannot add users", async () => {
  try {
    await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(memberToken), body: JSON.stringify({ userId: uid("b") }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
  try {
    await api(A_PORT, "/api/circle/invites", auth(memberToken));
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
});

test("unknown or malformed user IDs are rejected", async () => {
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: uid("z"), name: "Zed" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: "nope", name: "Zed" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(400); }
  try {
    await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(tokenA), body: JSON.stringify({ userId: "nope" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(400); }
});

test("an invite is single-use", async () => {
  const target = uid("c");
  await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(tokenA), body: JSON.stringify({ userId: target }) });
  await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: target, name: "Cid" }) });
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: target, name: "Cid" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
});

test("revoked invites don't work", async () => {
  const target = uid("d");
  await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(tokenA), body: JSON.stringify({ userId: target }) });
  const del = await api(A_PORT, "/api/circle/invites/" + target, { method: "DELETE", ...auth(tokenA) });
  expect(del.removed).toBe(true);
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: target, name: "Dee" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); }
});

test("expired invites are rejected", async () => {
  const target = uid("e");
  await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(tokenA), body: JSON.stringify({ userId: target }) });
  const db = new Database(join(dataA, "abba.db"));
  db.query("UPDATE invited_users SET expires_at = ? WHERE user_id = ?").run(new Date(Date.now() - 1000).toISOString(), target);
  db.close();
  try {
    await api(A_PORT, "/api/join", { method: "POST", body: JSON.stringify({ userId: target, name: "Eli" }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(403); expect(e.body.error).toMatch(/expired/i); }
});

test("can't invite someone already in the circle", async () => {
  try {
    await api(A_PORT, "/api/circle/invites", { method: "POST", ...auth(tokenA), body: JSON.stringify({ userId: ownerUid }) });
    expect(false).toBe(true);
  } catch (e: any) { expect(e.status).toBe(409); }
});
