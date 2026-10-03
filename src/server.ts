// server.ts — Abba: a quiet markdown notepad for an executive and their circle.
// Bun + zero dependencies + SQLite. Port 3013.
import { Database } from "bun:sqlite";
import { initDataDir, getDb, nowIso, randomToken, randomInviteCode, inviteExpiryIso, randomUserId, randomMeshId, isUserId, __setDbForTests } from "./db";
import { autoTitle, readMins, relatedIdeas, composeDigest, composeDailyLetter, getDigest, listDigests, nudgesFor, dismissNudge, type NoteRow } from "./mind";
import {
  getMesh, publicUrl, meshTick, meshProtocol, ensureNoteGids,
  publishNote, publishNoteTombstone, publishReaction, publishComment,
  publishMemberCredential, findMeshCredential, publishCircleInvite, findPeerInvite,
  advertisedCircles, pairCircles, unpublishCircleInvite,
} from "./meshbridge";
import { migrateCircle, burnCircle, resetAbba, exportMemberBundle, importBundle } from "./circleadmin";
import { peerIdFor } from "./mesh/identity";
import { syncImapAccount, testImap } from "./imapnotes";

const PORT = Number(process.env.ABBA_PORT || 3013);
const PALETTE = ["#C0765A", "#7A8B6F", "#5A7A8C", "#9A6B8F", "#B8934A", "#6B7F9E", "#8C5A5A", "#5F8C7A", "#A0765A", "#7A6B9E", "#4F7A6B", "#96522F"];
const STATUSES = ["seed", "sprout", "motion", "decided", "resting"] as const;
const REACTIONS = ["felt", "spark", "yes"] as const; // ❤ felt this · 💡 sparked · 🙌 yes

initDataDir();

// ---- IMAP Notes-folder sync ------------------------------------------------------
// Per-member two-way sync with a Notes folder on the member's own IMAP server.
// queueImapSync() debounces a sync ~20s after the member edits notes; a
// 10-minute interval catches changes made from mail clients.
const imapTimers = new Map<number, any>();
function queueImapSync(memberId: number) {
  try {
    const has = getDb().query("SELECT member_id FROM imap_accounts WHERE member_id = ?").get(memberId);
    if (!has) return;
    if (imapTimers.has(memberId)) clearTimeout(imapTimers.get(memberId));
    imapTimers.set(memberId, setTimeout(() => {
      imapTimers.delete(memberId);
      syncImapAccount(memberId).catch(() => {});
    }, 20000));
  } catch { /* db not ready */ }
}
setInterval(() => {
  try {
    const rows = getDb().query("SELECT member_id FROM imap_accounts").all() as any[];
    for (const r of rows) syncImapAccount(r.member_id).catch(() => {});
  } catch { /* db not ready */ }
}, 10 * 60 * 1000);

// light rate limit for the public re-open endpoint (10 tries / minute / ip)
const reopenAttempts = new Map<string, number[]>();
function reopenAllowed(ip: string): boolean {
  const now = Date.now();
  const arr = (reopenAttempts.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  reopenAttempts.set(ip, arr);
  return arr.length <= 10;
}

// ---- helpers -------------------------------------------------------------------
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function err(message: string, status = 400): Response { return json({ error: message }, status); }
async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function memberFrom(req: Request): any | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  return getDb().query("SELECT * FROM members WHERE token = ?").get(m[1]) as any;
}
function noteVisible(note: NoteRow, me: any): boolean {
  if (note.circle_id !== me.circle_id) return false;
  return note.shared === 1 || note.member_id === me.id;
}
function noteJson(n: NoteRow, me: any): any {
  const db = getDb();
  const tags = JSON.parse(n.tags || "[]");
  const comments = db.query(`
    SELECT c.*, m.name AS member_name, m.color AS member_color FROM comments c
    JOIN members m ON m.id = c.member_id WHERE c.note_id = ? ORDER BY c.created_at ASC
  `).all(n.id) as any[];
  const reacts = db.query(`
    SELECT kind, member_id FROM reactions WHERE note_id = ?
  `).all(n.id) as any[];
  const reactionCounts: Record<string, number> = {};
  const myReactions: string[] = [];
  for (const r of reacts) {
    reactionCounts[r.kind] = (reactionCounts[r.kind] || 0) + 1;
    if (r.member_id === me.id) myReactions.push(r.kind);
  }
  return {
    id: n.id, title: n.title, body: n.body, tags, status: n.status,
    shared: n.shared === 1, readMins: n.read_mins,
    mine: n.member_id === me.id,
    link: (n as any).link_origin ? JSON.parse((n as any).link_origin) : null,
    author: { name: n.member_name || "Someone", color: n.member_color || PALETTE[0] },
    createdAt: n.created_at, updatedAt: n.updated_at,
    comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at, mine: c.member_id === me.id, author: { name: c.member_name, color: c.member_color } })),
    reactionCounts, myReactions,
  };
}
function logEvent(kind: string, memberId: number | null, noteId: number | null, meta: any = {}, circleId?: number): void {
  const db = getDb();
  const cid = circleId ?? (memberId != null
    ? (db.query("SELECT circle_id FROM members WHERE id = ?").get(memberId) as any)?.circle_id
    : null) ?? 1;
  db.query("INSERT INTO events (circle_id, kind, member_id, note_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(cid, kind, memberId, noteId, JSON.stringify(meta), nowIso());
}
function touchPresence(me: any, view: string): void {
  getDb().query("UPDATE members SET last_seen = ? WHERE id = ?").run(nowIso(), me.id);
}

// ---- app -----------------------------------------------------------------------
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const db = getDb();

  // static — index.html gets a cache-busting version so clients never run stale JS
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    const dir = `${import.meta.dir}/../public`;
    let v = 0;
    for (const f of ["app.js", "styles.css", "index.html", "sw.js", "manifest.webmanifest",
                     "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
      try { v = Math.max(v, Bun.file(`${dir}/${f}`).lastModified); } catch { /* ignore */ }
    }
    const html = (await Bun.file(`${dir}/index.html`).text()).replaceAll("__V__", String(Math.floor(v / 1000)));
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  // service worker — version-stamped so deploys bust its cache name
  if (req.method === "GET" && path === "/sw.js") {
    const dir = `${import.meta.dir}/../public`;
    let v = 0;
    for (const f of ["app.js", "styles.css", "sw.js"]) {
      try { v = Math.max(v, Bun.file(`${dir}/${f}`).lastModified); } catch { /* ignore */ }
    }
    const js = (await Bun.file(`${dir}/sw.js`).text()).replaceAll("__V__", String(Math.floor(v / 1000)));
    return new Response(js, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache" } });
  }
  if (req.method === "GET" && path === "/manifest.webmanifest")
    return new Response(Bun.file(`${import.meta.dir}/../public/manifest.webmanifest`), { headers: { "Content-Type": "application/manifest+json" } });
  for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
    if (req.method === "GET" && path === "/" + icon)
      return new Response(Bun.file(`${import.meta.dir}/../public/${icon}`), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } });
  }
  if (req.method === "GET" && path === "/app.js")
    return new Response(Bun.file(`${import.meta.dir}/../public/app.js`), { headers: { "Content-Type": "text/javascript" } });
  if (req.method === "GET" && path === "/styles.css")
    return new Response(Bun.file(`${import.meta.dir}/../public/styles.css`), { headers: { "Content-Type": "text/css" } });
  if (req.method === "GET" && path === "/favicon.svg")
    return new Response(Bun.file(`${import.meta.dir}/../public/favicon.svg`), { headers: { "Content-Type": "image/svg+xml" } });
  if (req.method === "GET" && path === "/vendor/mermaid.min.js")
    return new Response(Bun.file(`${import.meta.dir}/../public/vendor/mermaid.min.js`), { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" } });

  // bootstrap: create the first circle (only when none exists)
  if (req.method === "POST" && path === "/api/circle/init") {
    const n = (db.query("SELECT COUNT(*) AS c FROM circle").get() as any).c;
    if (n > 0) return err("This Abba already has a circle.", 409);
    const b = await body(req);
    const name = String(b.name || "The Circle").slice(0, 60);
    const ownerName = String(b.ownerName || "You").slice(0, 40);
    const { token, member, circle } = createCircle(db, name, ownerName);
    return json({ token, member: publicMember(member), circle: circleJson(circle) });
  }

  // create an additional circle (any signed-in member becomes its owner)
  if (req.method === "POST" && path === "/api/circles") {
    const caller = memberFrom(req);
    if (!caller) return err("Not signed in.", 401);
    const b = await body(req);
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return err("Name the circle.", 400);
    const ownerName = String(b.ownerName || caller.name || "You").trim().slice(0, 40) || "You";
    const { token, member, circle } = createCircle(db, name, ownerName, caller.color || PALETTE[0]);
    return json({ token, member: publicMember(member), circle: circleJson(circle) }, 201);
  }

  // public: look up what an invite code identifies — a local circle, or a
  // peered instance's code (mesh-wide trust). Drives the join UI.
  if (req.method === "GET" && path === "/api/invite/lookup") {
    const raw = String(url.searchParams.get("code") || "").trim().toLowerCase();
    if (!raw) return err("Invite code required.", 400);
    const local = db.query("SELECT id, name FROM circle WHERE invite_code = ?").get(raw) as any;
    if (local) return json({ kind: "local", circle: { id: local.id, name: local.name } });
    if (findPeerInvite(getMesh(), raw)) {
      const circles = (db.query("SELECT id, name FROM circle ORDER BY id ASC").all() as any[])
        .map((c) => ({ id: c.id, name: c.name }));
      return json({ kind: "peer", circles });
    }
    return err("That invite code doesn't match.", 404);
  }

  // join via invite code — a local circle's code, a targeted user ID, or any
  // peered instance's code (mesh-wide trust; then a local circle must be chosen).
  if (req.method === "POST" && path === "/api/join") {
    const b = await body(req);
    const raw = String(b.code || "").trim().toLowerCase();
    const userId = String(b.userId || "").trim();
    let circle: any = null;
    if (userId) {
      // targeted invite: the owner added this exact user ID
      if (!isUserId(userId)) return err("That user ID doesn't look right.", 400);
      const inv = db.query("SELECT * FROM invited_users WHERE user_id = ?").get(userId) as any;
      if (!inv) return err("That user ID isn't on any circle's invite list — ask the owner to add you.", 403);
      if (inv.expires_at && Date.now() > Date.parse(inv.expires_at)) {
        db.query("DELETE FROM invited_users WHERE user_id = ?").run(userId);
        return err("That invitation has expired — ask the owner to add you again.", 403);
      }
      if (db.query("SELECT id FROM members WHERE user_id = ?").get(userId))
        return err("That user ID has already joined.", 403);
      circle = db.query("SELECT * FROM circle WHERE id = ?").get(inv.circle_id) as any;
      if (!circle) return err("That circle no longer exists.", 410);
    } else if (raw) {
      const own = db.query("SELECT * FROM circle WHERE invite_code = ?").get(raw) as any;
      if (own) {
        if (own.invite_expires_at && Date.now() > Date.parse(own.invite_expires_at))
          return err("That invite code has expired — ask the circle's owner for a fresh one.", 403);
        circle = own;
      } else if (findPeerInvite(getMesh(), raw)) {
        const cid = Number(b.circleId || 0);
        circle = cid
          ? (db.query("SELECT * FROM circle WHERE id = ?").get(cid) as any)
          : (db.query("SELECT * FROM circle ORDER BY id ASC LIMIT 1").get() as any);
        if (!circle) return err("No circle yet — someone needs to start one first.", 404);
        const n = (db.query("SELECT COUNT(*) AS c FROM circle").get() as any).c;
        if (!cid && n > 1) return err("That code is honored mesh-wide — pick which of your circles to join.", 400);
      } else {
        return err("That invite code doesn't match.", 403);
      }
    } else {
      return err("Invite code required.", 400);
    }
    const count = (db.query("SELECT COUNT(*) AS c FROM members WHERE circle_id = ? AND role NOT IN ('remote', 'migrated')").get(circle.id) as any).c;
    if (count >= circle.member_cap) return err("The circle is full — it stays intimate by design.", 403);
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) return err("Tell us your name so the circle knows who's here.", 400);
    const token = randomToken("abba_");
    const uid = userId || randomUserId();
    const res = db.query("INSERT INTO members (circle_id, name, color, token, role, created_at, last_seen, user_id) VALUES (?, ?, ?, ?, 'member', ?, ?, ?)")
      .run(circle.id, name, PALETTE[count % PALETTE.length], token, nowIso(), nowIso(), uid);
    if (userId) db.query("DELETE FROM invited_users WHERE user_id = ?").run(userId);
    const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
    return json({ token, member: publicMember(member), circle: circleJson(circle) });
  }

  // leave a circle (members only — owners burn or migrate instead)
  if (req.method === "POST" && path === "/api/circle/leave") {
    const caller = memberFrom(req);
    if (!caller) return err("Not signed in.", 401);
    if (caller.role === "owner") return err("Owners can't leave — burn the circle or hand it a fresh start instead.", 403);
    db.query("DELETE FROM imap_accounts WHERE member_id = ?").run(caller.id);
    db.query("DELETE FROM members WHERE id = ?").run(caller.id);
    return json({ ok: true });
  }

  // owner: add a specific user to the circle by their user ID (targeted
  // invite — they join with the ID instead of the shared code, one use each)
  if (path === "/api/circle/invites") {
    const caller = memberFrom(req);
    if (!caller || caller.role !== "owner") return err("Only the circle's owner can do that.", 403);
    if (req.method === "GET") {
      const rows = db.query("SELECT user_id, name, created_at, expires_at FROM invited_users WHERE circle_id = ? ORDER BY created_at ASC").all(caller.circle_id);
      return json({ invites: rows });
    }
    if (req.method === "POST") {
      const b = await body(req);
      const userId = String(b.userId || "").trim();
      if (!isUserId(userId)) return err("That doesn't look like a user ID — it starts with usr-.", 400);
      if (db.query("SELECT id FROM members WHERE user_id = ?").get(userId))
        return err("That user is already in a circle here.", 409);
      if (db.query("SELECT user_id FROM invited_users WHERE user_id = ?").get(userId))
        return err("That user is already invited.", 409);
      const nm = String(b.name || "").trim().slice(0, 40);
      const exp = inviteExpiryIso();
      db.query("INSERT INTO invited_users (circle_id, user_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(caller.circle_id, userId, nm, nowIso(), exp);
      return json({ invite: { userId, name: nm, expiresAt: exp } }, 201);
    }
    return err("Not found.", 404);
  }
  if (req.method === "DELETE" && path.startsWith("/api/circle/invites/")) {
    const caller = memberFrom(req);
    if (!caller || caller.role !== "owner") return err("Only the circle's owner can do that.", 403);
    const userId = decodeURIComponent(path.slice("/api/circle/invites/".length));
    const r = db.query("DELETE FROM invited_users WHERE user_id = ? AND circle_id = ?").run(userId, caller.circle_id);
    return json({ removed: r.changes > 0 });
  }

  // public: re-open an account with name + secret. Works when the account row
  // lives on this device, or when its credential was synced through the mesh.
  // circleId (or a circle invite code) scopes the search when given.
  if (req.method === "POST" && path === "/api/account/reopen") {
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
    if (!reopenAllowed(ip)) return err("Too many attempts — wait a minute.", 429);
    const b = await body(req);
    const name = String(b.name || "").trim();
    const password = String(b.password || "");
    if (!name || !password) return err("Name and secret required.", 400);
    const fail = () => err("No account matches that name and secret.", 404);
    let circleScope: number | null = null;
    if (b.circleId) {
      circleScope = Number(b.circleId);
    } else if (b.code) {
      const c = db.query("SELECT id FROM circle WHERE invite_code = ?").get(String(b.code).trim().toLowerCase()) as any;
      if (c) circleScope = c.id;
    }
    const scopeSql = circleScope ? "AND circle_id = ?" : "";
    const scopeArgs = circleScope ? [circleScope] : [];
    // 1. on this device
    const cands = db.query(
      `SELECT * FROM members WHERE LOWER(name) = LOWER(?) AND password_hash IS NOT NULL AND role != 'remote' ${scopeSql}`,
    ).all(name, ...scopeArgs) as any[];
    const hits: any[] = [];
    for (const c of cands) {
      if (await Bun.password.verify(password, c.password_hash)) hits.push(c);
    }
    if (hits.length > 1 && !circleScope)
      return err("That name matches accounts in more than one circle — rejoin with an invite code instead.", 409);
    if (hits.length === 1) {
      const c = hits[0];
      db.query("UPDATE members SET last_seen = ? WHERE id = ?").run(nowIso(), c.id);
      const circle = db.query("SELECT * FROM circle WHERE id = ?").get(c.circle_id);
      return json({ token: c.token, member: publicMember(c), circle: circleJson(circle) });
    }
    if (hits.length === 0 && circleScope) return fail();
    // 2. in the mesh (scoped to the matching circle when the credential names one)
    const cred = findMeshCredential(getMesh(), name);
    if (cred && await Bun.password.verify(password, cred.passwordHash)) {
      let circle: any = null;
      if (cred.circleMeshId) {
        circle = db.query("SELECT * FROM circle WHERE mesh_id = ?").get(cred.circleMeshId) as any;
      }
      if (!circle && circleScope) {
        circle = db.query("SELECT * FROM circle WHERE id = ?").get(circleScope) as any;
      }
      if (!circle) {
        // the credential's circle isn't here (e.g. a peered instance's circle):
        // land in the only circle, or ask the human to choose
        const all = db.query("SELECT * FROM circle ORDER BY id ASC").all() as any[];
        if (all.length === 1) circle = all[0];
        else return err("That account belongs to a circle this Abba doesn't have — ask the owner for an invite code.", 409);
      }
      if (!circle) return fail();
      const count = (db.query("SELECT COUNT(*) AS c FROM members WHERE circle_id = ? AND role != 'remote'").get(circle.id) as any).c;
      if (count >= circle.member_cap) return err("The circle is full — it stays intimate by design.", 403);
      const token = randomToken("abba_");
      const res = db.query(
        "INSERT INTO members (circle_id, name, color, token, role, created_at, last_seen, user_id, password_hash) VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)",
      ).run(circle.id, String(cred.name).slice(0, 40), cred.color || "#A08C5B", token, nowIso(), nowIso(), randomUserId(), cred.passwordHash);
      const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
      return json({ token, member: publicMember(member), circle: circleJson(circle), fromMesh: true });
    }
    return fail();
  }

  // public: import a migration bundle onto a fresh instance — you become host
  if (req.method === "POST" && path === "/api/circle/import") {
    const n = (db.query("SELECT COUNT(*) AS c FROM circle").get() as any).c;
    if (n > 0) return err("This Abba already has a circle.", 409);
    const b = await body(req);
    try {
      const r = importBundle(db, getMesh(), b.bundle, b.circleName);
      const member = db.query("SELECT * FROM members WHERE id = ?").get(r.memberId);
      return json({ token: r.token, member: publicMember(member), circle: r.circle }, 201);
    } catch (e: any) { return err(e.message || "Bad migration bundle.", 400); }
  }

  // public: start a brand new circle from the welcome page (reset + init atomically).
  // Owner-only — except when the owner never set a secret (pre-secrets accounts),
  // in which case nobody can prove ownership and the wipe is the recovery path.
  if (req.method === "POST" && path === "/api/circle/fresh-start") {
    const b = await body(req);
    const name = String(b.name || "The Circle").slice(0, 60);
    const ownerName = String(b.ownerName || "You").slice(0, 40);
    const caller = memberFrom(req);
    if (!caller || caller.role !== "owner") {
      const ownerSecret = db.query("SELECT 1 FROM members WHERE role = 'owner' AND password_hash IS NOT NULL AND password_hash != ''").get();
      if (ownerSecret) return err("Only the circle's owner can do that.", 403);
    }
    resetAbba(db, getMesh());
    const { token, member, circle } = createCircle(db, name, ownerName);
    return json({ token, member: publicMember(member), circle: circleJson(circle) }, 201);
  }

  // public status: does a circle exist yet? (for the welcome screen)
  // also lists circle names so a join-by-code UI can offer a picker.
  if (req.method === "GET" && path === "/api/status") {
    const circles = (db.query("SELECT id, name FROM circle ORDER BY id ASC").all() as any[])
      .map((c) => ({ id: c.id, name: c.name }));
    return json({ hasCircle: circles.length > 0, circles });
  }

  // mesh sync protocol (peer-facing; payloads are signed — no bearer needed)
  if (path.startsWith("/api/sync/")) {
    return meshProtocol(getMesh(), req, url) || err("Not found.", 404);
  }
  // mutual-peering handshake: accept a peer's invite code (bearer credential).
  // Pairs back with the initiator's circle when this instance runs exactly
  // one circle; with several, the owner pairs explicitly in Circle settings.
  if (req.method === "POST" && path === "/api/mesh/accept") {
    const b = await body(req);
    if (!b.code) return err("Invite code required.", 400);
    try {
      const p = getMesh().joinViaInvite(String(b.code));
      const circles = getDb().query("SELECT id FROM circle ORDER BY id ASC").all() as any[];
      if (circles.length === 1 && b.circleMeshId) {
        pairCircles(getDb(), circles[0].id, p.id, String(b.circleMeshId));
      }
      try { await meshTick(); } catch { /* best effort */ }
      return json({ ok: true, peer: p.id });
    } catch (e: any) { return err(e.message || "Bad invite code.", 400); }
  }

  const me = memberFrom(req);
  if (!me) return err("Not signed in.", 401);
  touchPresence(me, url.searchParams.get("view") || "");

  if (req.method === "GET" && path === "/api/me") return json({ member: publicMember(me) });
  // set (or change) the secret that can re-open this account later
  if (req.method === "POST" && path === "/api/account/password") {
    const b = await body(req);
    const password = String(b.password || "");
    if (password.length < 4) return err("Use at least 4 characters — a short phrase is best.", 400);
    if (password.length > 256) return err("Keep it under 256 characters.", 400);
    const hash = await Bun.password.hash(password);
    db.query("UPDATE members SET password_hash = ? WHERE id = ?").run(hash, me.id);
    publishMemberCredential(getMesh(), db, me.id);
    return json({ ok: true });
  }
  if (req.method === "GET" && path === "/api/circle") {
    const circle = db.query("SELECT * FROM circle WHERE id = ?").get(me.circle_id) as any;
    return json(circleJson(circle));
  }
  if (req.method === "POST" && path === "/api/invite/regenerate") {
    if (me.role !== "owner") return err("Only the circle's owner can do that.", 403);
    const { code, expiresAt } = issueInviteCode(db, me.circle_id);
    return json({ inviteCode: code, inviteExpiresAt: expiresAt });
  }
  if (req.method === "GET" && path === "/api/members") {
    const members = db.query("SELECT id, name, color, role, last_seen FROM members WHERE circle_id = ? ORDER BY created_at ASC").all(me.circle_id);
    return json({ members });
  }
  if (req.method === "GET" && path === "/api/presence") {
    const cutoff = new Date(Date.now() - 120_000).toISOString();
    const here = db.query("SELECT id, name, color FROM members WHERE circle_id = ? AND last_seen >= ? AND id != ?").all(me.circle_id, cutoff, me.id) as any[];
    return json({ here });
  }

  // mesh: peer this Abba instance with another instance's circle.
  // Only shared notes ever leave the instance; the private notepad never syncs.
  // Peering links one LOCAL circle to one REMOTE circle (by the remote
  // circle's stable mesh id); snapshots route through the pairing table.
  if (path.startsWith("/api/mesh")) {
    const mesh = getMesh();
    if (req.method === "GET" && path === "/api/mesh/status") {
      const pairings = db.query(`SELECT cp.local_circle_id, c.name AS circle_name, cp.peer_node_id, cp.remote_mesh_id
        FROM circle_peers cp LEFT JOIN circle c ON c.id = cp.local_circle_id`).all();
      return json({
        nodeId: mesh.identity.id, url: publicUrl(), isOwner: me.role === "owner",
        peers: mesh.listPeers().map((p) => ({ id: p.id, url: p.url, name: p.name, lastSeen: p.last_seen, lastOk: p.last_ok, via: p.via })),
        pairings,
      });
    }
    // every circle this mesh has heard about, grouped by node (for pairing)
    if (req.method === "GET" && path === "/api/mesh/remote-circles") {
      const by: Record<string, any> = {};
      for (const c of advertisedCircles(mesh)) {
        (by[c.nodeId] = by[c.nodeId] || { nodeId: c.nodeId, circles: [] }).circles
          .push({ meshId: c.meshId, name: c.name, expiresAt: c.expiresAt });
      }
      return json({ nodes: Object.values(by) });
    }
    if (me.role !== "owner") return err("Only the circle's owner can peer instances.", 403);
    if (req.method === "POST" && path === "/api/mesh/invite") {
      return json({ code: mesh.createInvite(), url: publicUrl(), nodeId: mesh.identity.id });
    }
    // explicitly pair a local circle with a remote circle (by its mesh id)
    if (req.method === "POST" && path === "/api/mesh/pair") {
      const b = await body(req);
      const circleId = Number(b.circleId || 0);
      const peerId = String(b.peerId || "");
      const remoteMeshId = String(b.remoteMeshId || "");
      if (!circleId || !peerId || !remoteMeshId) return err("circleId, peerId, and remoteMeshId required.", 400);
      if (db.query("SELECT id FROM circle WHERE id = ?").get(circleId) == null)
        return err("No such circle.", 404);
      if (!mesh.listPeers().some((p) => p.id === peerId)) return err("No such peer.", 404);
      pairCircles(db, circleId, peerId, remoteMeshId);
      await meshTick();
      return json({ ok: true });
    }
    if (req.method === "POST" && path === "/api/mesh/join") {
      const b = await body(req);
      if (!b.code) return err("Invite code required.", 400);
      const circleId = Number(b.circleId || me.circle_id);
      if (db.query("SELECT id FROM circle WHERE id = ?").get(circleId) == null)
        return err("No such circle.", 404);
      try {
        const p = mesh.joinViaInvite(String(b.code));
        // mutual peering: hand our own invite back so they sync from us too.
        // their side pairs with this circle's stable mesh id (or explicitly,
        // if they run several circles).
        try {
          const back = await fetch(p.url.replace(/\/+$/, "") + "/api/mesh/accept", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: mesh.createInvite(), circleMeshId: circleMeshId(db, circleId) }),
            signal: AbortSignal.timeout(10000),
          });
          if (!back.ok) console.error("[mesh] peer did not accept our invite");
        } catch (e: any) { console.error("[mesh] accept-back failed:", e.message); }
        // pair this circle with theirs; the remote circle resolves on tick
        pairCircles(db, circleId, p.id, null);
        await meshTick(); // pull immediately so the circle appears right away
        return json({ peer: { id: p.id, url: p.url, name: p.name } });
      } catch (e: any) { return err(e.message || "Bad invite code.", 400); }
    }
    // knock: peer with an instance by URL alone — no invite code needed.
    // The remote's identity is cryptographically bound (id = hash of pubkey),
    // so the /api/sync/state response is self-verifying. Mutual peering
    // completes through the same public accept handshake the invite flow uses.
    if (req.method === "POST" && path === "/api/mesh/knock") {
      const b = await body(req);
      const raw = String(b.url || "").trim();
      if (!raw) return err("Instance URL required.", 400);
      if (!/^https?:\/\//i.test(raw)) return err("Use a full http(s) URL, e.g. https://abba.example.com.", 400);
      const base = raw.replace(/\/+$/, "");
      let st: any;
      try {
        const r = await fetch(base + "/api/sync/state", { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        st = await r.json();
      } catch (e: any) {
        return err("Couldn't reach that instance: " + (e?.message || e), 502);
      }
      if (!st || !st.id || !st.pubkey || peerIdFor(st.pubkey) !== st.id)
        return err("That URL isn't an Abba mesh node (identity check failed).", 400);
      if (st.id === mesh.identity.id) return err("That's this Abba — you can't peer with yourself.", 400);
      const circleId = Number(b.circleId || me.circle_id);
      if (db.query("SELECT id FROM circle WHERE id = ?").get(circleId) == null)
        return err("No such circle.", 404);
      const p = mesh.addPeer(st.id, base, st.pubkey, "");
      // mutual peering: hand our own invite back so they sync from us too
      try {
        const back = await fetch(base + "/api/mesh/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: mesh.createInvite(), circleMeshId: circleMeshId(db, circleId) }),
          signal: AbortSignal.timeout(10000),
        });
        if (!back.ok) console.error("[mesh] peer did not accept our invite");
      } catch (e: any) { console.error("[mesh] accept-back failed:", e.message); }
      // pair this circle with theirs; the remote circle resolves on tick
      pairCircles(db, circleId, p.id, null);
      await meshTick(); // pull immediately so the circle appears right away
      return json({ peer: { id: p.id, url: p.url, name: p.name } });
    }
    const delMp = path.match(/^\/api\/mesh\/peers\/([0-9a-f]{32})$/);
    if (delMp && req.method === "DELETE") {
      const removed = mesh.removePeer(delMp[1]);
      db.query("DELETE FROM circle_peers WHERE peer_node_id = ?").run(delMp[1]);
      return json({ removed });
    }
    if (req.method === "POST" && path === "/api/mesh/sync") {
      await meshTick();
      return json({ ok: true });
    }
    return err("Not found.", 404);
  }

  // circle admin: migrate content to a fresh circle, or burn it all down.
  // Owners restructure in place; members export a bundle to fork their own circle.
  // Everything is scoped to the caller's circle — other circles are untouched.
  if (req.method === "POST" && path === "/api/circle/migrate") {
    if (me.role === "owner") return json(migrateCircle(db, getMesh(), me.id));
    return json({ export: exportMemberBundle(db, getMesh(), me.id) });
  }
  if (req.method === "POST" && path === "/api/circle/burn") {
    if (me.role !== "owner") return err("Only the circle's owner can do that.", 403);
    const b = await body(req);
    if (b.confirm !== "BURN") return err("Type BURN to confirm.", 400);
    burnCircle(db, getMesh(), me.circle_id);
    return json({ ok: true });
  }
  if (req.method === "POST" && path === "/api/circle/reset") {
    if (me.role !== "owner") return err("Only the circle's owner can do that.", 403);
    resetAbba(db, getMesh());
    return json({ ok: true });
  }

  // notes
  if (req.method === "GET" && path === "/api/notes") {
    const scope = url.searchParams.get("scope") || "circle";
    let rows: NoteRow[];
    if (scope === "mine") {
      rows = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.circle_id = ? AND n.member_id = ? ORDER BY n.updated_at DESC`).all(me.circle_id, me.id) as NoteRow[];
    } else {
      rows = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.circle_id = ? AND n.shared = 1 ORDER BY n.updated_at DESC`).all(me.circle_id) as NoteRow[];
    }
    return json({ notes: rows.map((n) => noteJson(n, me)) });
  }
  if (req.method === "POST" && path === "/api/notes") {
    const b = await body(req);
    const noteBody = String(b.body || "").slice(0, 60000);
    if (!noteBody.trim()) return err("Write something first — even a fragment.", 400);
    const title = String(b.title || "").trim().slice(0, 120) || autoTitle(noteBody);
    const tags = Array.isArray(b.tags) ? b.tags.map((t: any) => String(t).slice(0, 30)).slice(0, 8) : [];
    const shared = b.shared === true ? 1 : 0;
    const t = nowIso();
    const res = db.query(`INSERT INTO notes (circle_id, member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'seed', ?, ?, ?, ?)`).run(me.circle_id, me.id, title, noteBody, JSON.stringify(tags), shared, readMins(noteBody), t, t);
    if (shared) logEvent("shared", me.id, Number(res.lastInsertRowid), {}, me.circle_id);
    publishNote(getMesh(), db, Number(res.lastInsertRowid));
    const note = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
      JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(Number(res.lastInsertRowid)) as NoteRow;
    queueImapSync(me.id);
    return json({ note: noteJson(note, me) }, 201);
  }

  const noteIdMatch = path.match(/^\/api\/notes\/(\d+)(\/.*)?$/);
  if (noteIdMatch) {
    const noteId = Number(noteIdMatch[1]);
    const sub = noteIdMatch[2] || "";
    const note = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
      JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as unknown as NoteRow | null;
    if (!note || !noteVisible(note, me)) return err("Not found.", 404);

    const isLink = !!(note as any).link_origin;
    if (isLink) {
      // frozen migration links: readable and removable, nothing else
      const allowed = req.method === "GET" || (req.method === "DELETE" && sub === "");
      if (!allowed) return err("Linked notes are read-only.", 403);
    }

    if (req.method === "GET" && sub === "") return json({ note: noteJson(note, me) });

    if (req.method === "GET" && sub === "/related") {
      const pool = db.query(`SELECT n.*, m.name AS member_name FROM notes n JOIN members m ON m.id = n.member_id
        WHERE n.circle_id = ? AND (n.shared = 1 OR n.member_id = ?) AND n.id != ?`).all(me.circle_id, me.id, noteId) as NoteRow[];
      // Only shared notes (or your own) can appear as related — never someone else's private notes.
      const visible = pool.filter((n) => n.shared === 1 || n.member_id === me.id);
      return json({ related: relatedIdeas(note, visible).map((n) => ({ id: n.id, title: n.title, shared: n.shared === 1 })) });
    }

    if (req.method === "GET" && sub === "/export") {
      const md = `# ${note.title}\n\n${note.body}\n\n---\n*${note.member_name} · ${note.created_at.slice(0, 10)} · ${note.status}*\n`;
      return new Response(md, { headers: { "Content-Type": "text/markdown", "Content-Disposition": `attachment; filename="abba-${note.id}.md"` } });
    }

    if (note.member_id !== me.id && !isLink && !["/comments", "/react"].includes(sub)) return err("That's someone else's note.", 403);

    if (req.method === "PATCH" && sub === "") {
      const b = await body(req);
      const updates: string[] = []; const vals: any[] = [];
      if (typeof b.title === "string" && b.title.trim()) { updates.push("title = ?"); vals.push(b.title.trim().slice(0, 120)); }
      if (typeof b.body === "string" && b.body.trim()) {
        updates.push("body = ?"); vals.push(b.body.slice(0, 60000));
        updates.push("read_mins = ?"); vals.push(readMins(b.body));
      }
      if (Array.isArray(b.tags)) { updates.push("tags = ?"); vals.push(JSON.stringify(b.tags.map((t: any) => String(t).slice(0, 30)).slice(0, 8))); }
      if (typeof b.status === "string" && (STATUSES as readonly string[]).includes(b.status) && b.status !== note.status) {
        updates.push("status = ?"); vals.push(b.status);
        logEvent("status", me.id, note.id, { from: note.status, to: b.status }, me.circle_id);
      }
      if (!updates.length) return err("Nothing to change.", 400);
      updates.push("updated_at = ?"); vals.push(nowIso()); vals.push(noteId);
      db.query(`UPDATE notes SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
      publishNote(getMesh(), db, noteId);
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      queueImapSync(me.id);
      return json({ note: noteJson(fresh, me) });
    }

    if (req.method === "DELETE" && sub === "") {
      if (!isLink) publishNoteTombstone(getMesh(), db, noteId); // links are local-only
      db.query("DELETE FROM notes WHERE id = ?").run(noteId);
      queueImapSync(me.id);
      return json({ ok: true });
    }

    if (req.method === "POST" && sub === "/share") {
      if (note.shared === 1) return json({ note: noteJson(note, me) });
      db.query("UPDATE notes SET shared = 1, updated_at = ? WHERE id = ?").run(nowIso(), noteId);
      logEvent("shared", me.id, noteId, {}, me.circle_id);
      publishNote(getMesh(), db, noteId);
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }
    if (req.method === "POST" && sub === "/unshare") {
      db.query("UPDATE notes SET shared = 0, updated_at = ? WHERE id = ?").run(nowIso(), noteId);
      publishNote(getMesh(), db, noteId); // retraction: remotes drop it
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }

    if (req.method === "POST" && sub === "/comments") {
      const b = await body(req);
      const cbody = String(b.body || "").trim().slice(0, 5000);
      if (!cbody) return err("Write something first.", 400);
      const cres = db.query("INSERT INTO comments (note_id, member_id, body, created_at) VALUES (?, ?, ?, ?)")
        .run(noteId, me.id, cbody, nowIso());
      logEvent("comment", me.id, noteId, {}, me.circle_id);
      publishComment(getMesh(), db, Number(cres.lastInsertRowid));
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) }, 201);
    }

    if (req.method === "POST" && sub === "/react") {
      const b = await body(req);
      const kind = String(b.kind || "");
      if (!(REACTIONS as readonly string[]).includes(kind)) return err("Unknown reaction.", 400);
      const existing = db.query("SELECT 1 FROM reactions WHERE note_id = ? AND member_id = ? AND kind = ?").get(noteId, me.id, kind);
      if (existing) db.query("DELETE FROM reactions WHERE note_id = ? AND member_id = ? AND kind = ?").run(noteId, me.id, kind);
      else db.query("INSERT INTO reactions (note_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)").run(noteId, me.id, kind, nowIso());
      publishReaction(getMesh(), db, noteId, me, kind, !existing);
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }
    return err("Not found.", 404);
  }

  if (req.method === "GET" && path === "/api/digests") return json({ digests: listDigests(me.circle_id) });
  if (req.method === "GET" && path === "/api/digest/today") return json({ digest: composeDailyLetter(me.id) });
  if (req.method === "GET" && path === "/api/digest") {
    const d = getDigest(url.searchParams.get("week") || undefined, me.circle_id);
    if (!d) return err("That letter isn't on the shelf.", 404);
    return json({ digest: d });
  }
  if (req.method === "GET" && path === "/api/nudges") return json({ nudges: nudgesFor(me.id, me.circle_id) });
  if (req.method === "POST" && path === "/api/nudges/dismiss") {
    const b = await body(req);
    if (b.key) dismissNudge(me.id, String(b.key));
    return json({ ok: true });
  }

  // ---- IMAP Notes-folder sync (per member; password never leaves the server) ----
  if (path === "/api/imap" && req.method === "GET") {
    const a = db.query("SELECT host, port, username, folder, last_sync_at, last_error FROM imap_accounts WHERE member_id = ?").get(me.id) as any;
    return json(a ? {
      configured: true, host: a.host, port: a.port, username: a.username,
      folder: a.folder, lastSyncAt: a.last_sync_at, lastError: a.last_error,
    } : { configured: false });
  }
  if (path === "/api/imap" && (req.method === "PUT" || req.method === "POST")) {
    const b = await body(req);
    const host = String(b.host || "").trim();
    const username = String(b.username || "").trim();
    const folder = String(b.folder || "Notes").trim().slice(0, 60) || "Notes";
    const port = b.port && Number(b.port) > 0 ? Number(b.port) : 993;
    const existing = db.query("SELECT password FROM imap_accounts WHERE member_id = ?").get(me.id) as any;
    const password = typeof b.password === "string" && b.password ? b.password : (existing ? existing.password : "");
    if (!host || !username || !password) return err("Host, username, and password are required.", 400);
    try {
      await testImap({ host, port, user: username, pass: password, folder });
    } catch (e: any) {
      return err("Couldn't reach that mailbox: " + String((e && e.message) || e).slice(0, 160), 502);
    }
    const t = nowIso();
    db.query(`INSERT INTO imap_accounts (member_id, host, port, username, password, folder, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_id) DO UPDATE SET host = excluded.host, port = excluded.port,
        username = excluded.username, password = excluded.password, folder = excluded.folder,
        last_error = '', updated_at = excluded.updated_at`)
      .run(me.id, host, port, username, password, folder, t);
    queueImapSync(me.id);
    return json({ ok: true });
  }
  if (path === "/api/imap" && req.method === "DELETE") {
    db.query("DELETE FROM imap_accounts WHERE member_id = ?").run(me.id);
    if (imapTimers.has(me.id)) { clearTimeout(imapTimers.get(me.id)); imapTimers.delete(me.id); }
    return json({ ok: true });
  }
  if (path === "/api/imap/sync" && req.method === "POST") {
    const r = await syncImapAccount(me.id);
    return json(r);
  }

  return err("Not found.", 404);
}

function publicMember(m: any): any {
  return { id: m.id, name: m.name, color: m.color, role: m.role, hasPassword: !!m.password_hash, userId: m.user_id || null, circleId: m.circle_id ?? 1 };
}

// A code no other circle uses (invite codes identify circles now).
function uniqueInviteCode(db: Database): string {
  for (let i = 0; i < 20; i++) {
    const code = randomInviteCode();
    if (!db.query("SELECT id FROM circle WHERE invite_code = ?").get(code)) return code;
  }
  return randomInviteCode() + randomInviteCode().slice(5); // astronomically unlikely path
}

/** Create a circle and its owner member. Returns the owner's bearer token. */
function createCircle(db: Database, name: string, ownerName: string, ownerColor = PALETTE[0]): { token: string; member: any; circle: any } {
  const code = uniqueInviteCode(db);
  const expiresAt = inviteExpiryIso();
  const res = db.query("INSERT INTO circle (name, invite_code, invite_expires_at, mesh_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, code, expiresAt, randomMeshId(), nowIso());
  const circleId = Number(res.lastInsertRowid);
  const token = randomToken("abba_");
  const mres = db.query("INSERT INTO members (circle_id, name, color, token, role, created_at, last_seen, user_id) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)")
    .run(circleId, ownerName, ownerColor, token, nowIso(), nowIso(), randomUserId());
  const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(mres.lastInsertRowid));
  const circle = db.query("SELECT * FROM circle WHERE id = ?").get(circleId);
  try { publishCircleInvite(getMesh(), db); } catch { /* mesh not up in some paths */ }
  return { token, member, circle };
}

function circleMeshId(db: Database, circleId: number): string | null {
  const c = db.query("SELECT mesh_id FROM circle WHERE id = ?").get(circleId) as any;
  return c?.mesh_id || null;
}

function circleJson(c: any): any {
  if (!c) return null;
  return { id: c.id, name: c.name, inviteCode: c.invite_code, inviteExpiresAt: c.invite_expires_at || null, memberCap: c.member_cap || 12 };
}

// Issue a fresh circle invite code (7-day expiry) and advertise it to the
// mesh so peered instances honor it. Used by init, reset, and regenerate.
function issueInviteCode(db: Database, circleId: number): { code: string; expiresAt: string } {
  const code = uniqueInviteCode(db);
  const expiresAt = inviteExpiryIso();
  db.query("UPDATE circle SET invite_code = ?, invite_expires_at = ? WHERE id = ?").run(code, expiresAt, circleId);
  try { publishCircleInvite(getMesh(), db); } catch { /* mesh not up in some paths */ }
  return { code, expiresAt };
}

export function __resetForTests(d: Database): void { __setDbForTests(d); }

if (import.meta.main) {
  ensureNoteGids(getDb(), getMesh());
  // existing circles predate expiring codes: grant the current code a fresh
  // 7-day window rather than expiring it out from under the owner.
  try {
    const db = getDb();
    for (const c of db.query("SELECT id FROM circle WHERE invite_expires_at IS NULL OR invite_expires_at = ''").all() as any[]) {
      db.query("UPDATE circle SET invite_expires_at = ? WHERE id = ?").run(inviteExpiryIso(), c.id);
    }
    for (const c of db.query("SELECT id FROM circle WHERE mesh_id IS NULL OR mesh_id = ''").all() as any[]) {
      db.query("UPDATE circle SET mesh_id = ? WHERE id = ?").run(randomMeshId(), c.id);
    }
    for (const m of db.query("SELECT id FROM members WHERE user_id IS NULL").all() as any[]) {
      db.query("UPDATE members SET user_id = ? WHERE id = ?").run(randomUserId(), m.id);
    }
    publishCircleInvite(getMesh(), db);
  } catch (e) { console.error("[mesh] invite publish:", (e as any)?.message); }
  Bun.serve({ port: PORT, fetch: handle });
  console.log(`Abba listening on http://localhost:${PORT}  (mesh node ${getMesh().identity.id})`);
  setTimeout(meshTick, 10000);
  setInterval(meshTick, 30000);
}
