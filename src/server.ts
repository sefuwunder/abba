// server.ts — Abba: a quiet markdown notepad for an executive and their circle.
// Bun + zero dependencies + SQLite. Port 3013.
import { Database } from "bun:sqlite";
import { initDataDir, getDb, nowIso, randomToken, randomInviteCode, __setDbForTests } from "./db";
import { autoTitle, readMins, relatedIdeas, composeDigest, getDigest, listDigests, nudgesFor, dismissNudge, type NoteRow } from "./mind";
import {
  getMesh, publicUrl, meshTick, meshProtocol, ensureNoteGids,
  publishNote, publishNoteTombstone, publishReaction, publishComment,
  publishMemberCredential, findMeshCredential,
} from "./meshbridge";
import { migrateCircle, burnCircle, resetAbba, exportMemberBundle, importBundle } from "./circleadmin";

const PORT = Number(process.env.ABBA_PORT || 3013);
const PALETTE = ["#C0765A", "#7A8B6F", "#5A7A8C", "#9A6B8F", "#B8934A", "#6B7F9E", "#8C5A5A", "#5F8C7A", "#A0765A", "#7A6B9E", "#4F7A6B", "#96522F"];
const STATUSES = ["seed", "sprout", "motion", "decided", "resting"] as const;
const REACTIONS = ["felt", "spark", "yes"] as const; // ❤ felt this · 💡 sparked · 🙌 yes

initDataDir();

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
function logEvent(kind: string, memberId: number | null, noteId: number | null, meta: any = {}): void {
  getDb().query("INSERT INTO events (kind, member_id, note_id, meta, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(kind, memberId, noteId, JSON.stringify(meta), nowIso());
}
function touchPresence(me: any, view: string): void {
  getDb().query("UPDATE members SET last_seen = ? WHERE id = ?").run(nowIso(), me.id);
}

// ---- app -----------------------------------------------------------------------
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const db = getDb();

  // static
  if (req.method === "GET" && (path === "/" || path === "/index.html"))
    return new Response(Bun.file(`${import.meta.dir}/../public/index.html`));
  if (req.method === "GET" && path === "/app.js")
    return new Response(Bun.file(`${import.meta.dir}/../public/app.js`), { headers: { "Content-Type": "text/javascript" } });
  if (req.method === "GET" && path === "/styles.css")
    return new Response(Bun.file(`${import.meta.dir}/../public/styles.css`), { headers: { "Content-Type": "text/css" } });

  // bootstrap: create the circle (only when none exists)
  if (req.method === "POST" && path === "/api/circle/init") {
    const exists = db.query("SELECT id FROM circle WHERE id = 1").get();
    if (exists) return err("This Abba already has a circle.", 409);
    const b = await body(req);
    const name = String(b.name || "The Circle").slice(0, 60);
    const ownerName = String(b.ownerName || "You").slice(0, 40);
    const code = randomInviteCode();
    db.query("INSERT INTO circle (id, name, invite_code, created_at) VALUES (1, ?, ?, ?)")
      .run(name, code, nowIso());
    const token = randomToken("abba_");
    const res = db.query("INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES (?, ?, ?, 'owner', ?, ?)")
      .run(ownerName, PALETTE[0], token, nowIso(), nowIso());
    const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
    return json({ token, member: publicMember(member), circle: { name, inviteCode: code } });
  }

  // join via invite code
  if (req.method === "POST" && path === "/api/join") {
    const b = await body(req);
    const circle = db.query("SELECT * FROM circle WHERE id = 1").get() as any;
    if (!circle) return err("No circle yet — someone needs to start one first.", 404);
    if (String(b.code || "").trim().toLowerCase() !== circle.invite_code) return err("That invite code doesn't match.", 403);
    const count = (db.query("SELECT COUNT(*) AS c FROM members WHERE role NOT IN ('remote', 'migrated')").get() as any).c;
    if (count >= circle.member_cap) return err("The circle is full — it stays intimate by design.", 403);
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) return err("Tell us your name so the circle knows who's here.", 400);
    const token = randomToken("abba_");
    const res = db.query("INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES (?, ?, ?, 'member', ?, ?)")
      .run(name, PALETTE[count % PALETTE.length], token, nowIso(), nowIso());
    const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
    return json({ token, member: publicMember(member) });
  }

  // public: re-open an account with name + secret. Works when the account row
  // lives on this device, or when its credential was synced through the mesh.
  if (req.method === "POST" && path === "/api/account/reopen") {
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
    if (!reopenAllowed(ip)) return err("Too many attempts — wait a minute.", 429);
    const b = await body(req);
    const name = String(b.name || "").trim();
    const password = String(b.password || "");
    if (!name || !password) return err("Name and secret required.", 400);
    const fail = () => err("No account matches that name and secret.", 404);
    // 1. on this device
    const cands = db.query(
      "SELECT * FROM members WHERE LOWER(name) = LOWER(?) AND password_hash IS NOT NULL AND role != 'remote'",
    ).all(name) as any[];
    for (const c of cands) {
      if (await Bun.password.verify(password, c.password_hash)) {
        db.query("UPDATE members SET last_seen = ? WHERE id = ?").run(nowIso(), c.id);
        return json({ token: c.token, member: publicMember(c) });
      }
    }
    // 2. in the mesh
    const circle = db.query("SELECT id, member_cap FROM circle WHERE id = 1").get() as any;
    if (!circle) return fail();
    const cred = findMeshCredential(getMesh(), name);
    if (cred && await Bun.password.verify(password, cred.passwordHash)) {
      const count = (db.query("SELECT COUNT(*) AS c FROM members WHERE role != 'remote'").get() as any).c;
      if (count >= circle.member_cap) return err("The circle is full — it stays intimate by design.", 403);
      const token = randomToken("abba_");
      const res = db.query(
        "INSERT INTO members (name, color, token, role, created_at, last_seen, password_hash) VALUES (?, ?, ?, 'member', ?, ?, ?)",
      ).run(String(cred.name).slice(0, 40), cred.color || "#A08C5B", token, nowIso(), nowIso(), cred.passwordHash);
      const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
      return json({ token, member: publicMember(member), fromMesh: true });
    }
    return fail();
  }

  // public: import a migration bundle onto a fresh instance — you become host
  if (req.method === "POST" && path === "/api/circle/import") {
    const exists = db.query("SELECT id FROM circle WHERE id = 1").get();
    if (exists) return err("This Abba already has a circle.", 409);
    const b = await body(req);
    try {
      const r = importBundle(db, getMesh(), b.bundle, b.circleName);
      const member = db.query("SELECT * FROM members WHERE id = ?").get(r.memberId);
      return json({ token: r.token, member: publicMember(member), circle: r.circle }, 201);
    } catch (e: any) { return err(e.message || "Bad migration bundle.", 400); }
  }

  // public status: does a circle exist yet? (for the welcome screen)
  if (req.method === "GET" && path === "/api/status") {
    const circle = db.query("SELECT id FROM circle WHERE id = 1").get();
    return json({ hasCircle: !!circle });
  }

  // mesh sync protocol (peer-facing; payloads are signed — no bearer needed)
  if (path.startsWith("/api/sync/")) {
    return meshProtocol(getMesh(), req, url) || err("Not found.", 404);
  }
  // mutual-peering handshake: accept a peer's invite code (bearer credential)
  if (req.method === "POST" && path === "/api/mesh/accept") {
    const b = await body(req);
    if (!b.code) return err("Invite code required.", 400);
    try {
      const p = getMesh().joinViaInvite(String(b.code));
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
    const circle = db.query("SELECT * FROM circle WHERE id = 1").get() as any;
    return json({ name: circle?.name || "The Circle", inviteCode: circle?.invite_code, memberCap: circle?.member_cap || 12 });
  }
  if (req.method === "POST" && path === "/api/invite/regenerate") {
    if (me.role !== "owner") return err("Only the circle's owner can do that.", 403);
    const code = randomInviteCode();
    db.query("UPDATE circle SET invite_code = ? WHERE id = 1").run(code);
    return json({ inviteCode: code });
  }
  if (req.method === "GET" && path === "/api/members") {
    const members = db.query("SELECT id, name, color, role, last_seen FROM members ORDER BY created_at ASC").all();
    return json({ members });
  }
  if (req.method === "GET" && path === "/api/presence") {
    const cutoff = new Date(Date.now() - 120_000).toISOString();
    const here = db.query("SELECT id, name, color FROM members WHERE last_seen >= ? AND id != ?").all(cutoff, me.id) as any[];
    return json({ here });
  }

  // mesh: peer this Abba instance with another instance's circle.
  // Only shared notes ever leave the instance; the private notepad never syncs.
  if (path.startsWith("/api/mesh")) {
    const mesh = getMesh();
    if (req.method === "GET" && path === "/api/mesh/status") {
      return json({
        nodeId: mesh.identity.id, url: publicUrl(), isOwner: me.role === "owner",
        peers: mesh.listPeers().map((p) => ({ id: p.id, url: p.url, name: p.name, lastSeen: p.last_seen, lastOk: p.last_ok, via: p.via })),
      });
    }
    if (me.role !== "owner") return err("Only the circle's owner can peer instances.", 403);
    if (req.method === "POST" && path === "/api/mesh/invite") {
      return json({ code: mesh.createInvite(), url: publicUrl(), nodeId: mesh.identity.id });
    }
    if (req.method === "POST" && path === "/api/mesh/join") {
      const b = await body(req);
      if (!b.code) return err("Invite code required.", 400);
      try {
        const p = mesh.joinViaInvite(String(b.code));
        // mutual peering: hand our own invite back so they sync from us too
        try {
          const back = await fetch(p.url.replace(/\/+$/, "") + "/api/mesh/accept", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: mesh.createInvite() }),
            signal: AbortSignal.timeout(10000),
          });
          if (!back.ok) console.error("[mesh] peer did not accept our invite");
        } catch (e: any) { console.error("[mesh] accept-back failed:", e.message); }
        await meshTick(); // pull immediately so the circle appears right away
        return json({ peer: { id: p.id, url: p.url, name: p.name } });
      } catch (e: any) { return err(e.message || "Bad invite code.", 400); }
    }
    const delMp = path.match(/^\/api\/mesh\/peers\/([0-9a-f]{32})$/);
    if (delMp && req.method === "DELETE") return json({ removed: mesh.removePeer(delMp[1]) });
    if (req.method === "POST" && path === "/api/mesh/sync") {
      await meshTick();
      return json({ ok: true });
    }
    return err("Not found.", 404);
  }

  // circle admin: migrate content to a fresh circle, or burn it all down.
  // Owners restructure in place; members export a bundle to fork their own circle.
  if (req.method === "POST" && path === "/api/circle/migrate") {
    if (me.role === "owner") return json(migrateCircle(db, getMesh(), me.id));
    return json({ export: exportMemberBundle(db, getMesh(), me.id) });
  }
  if (req.method === "POST" && path === "/api/circle/burn") {
    if (me.role !== "owner") return err("Only the circle's owner can do that.", 403);
    const b = await body(req);
    if (b.confirm !== "BURN") return err("Type BURN to confirm.", 400);
    burnCircle(db, getMesh());
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
        JOIN members m ON m.id = n.member_id WHERE n.member_id = ? ORDER BY n.updated_at DESC`).all(me.id) as NoteRow[];
    } else {
      rows = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.shared = 1 ORDER BY n.updated_at DESC`).all() as NoteRow[];
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
    const res = db.query(`INSERT INTO notes (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'seed', ?, ?, ?, ?)`).run(me.id, title, noteBody, JSON.stringify(tags), shared, readMins(noteBody), t, t);
    if (shared) logEvent("shared", me.id, Number(res.lastInsertRowid), {});
    publishNote(getMesh(), db, Number(res.lastInsertRowid));
    const note = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
      JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(Number(res.lastInsertRowid)) as NoteRow;
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
        WHERE (n.shared = 1 OR n.member_id = ?) AND n.id != ?`).all(me.id, noteId) as NoteRow[];
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
        logEvent("status", me.id, note.id, { from: note.status, to: b.status });
      }
      if (!updates.length) return err("Nothing to change.", 400);
      updates.push("updated_at = ?"); vals.push(nowIso()); vals.push(noteId);
      db.query(`UPDATE notes SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
      publishNote(getMesh(), db, noteId);
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }

    if (req.method === "DELETE" && sub === "") {
      if (!isLink) publishNoteTombstone(getMesh(), db, noteId); // links are local-only
      db.query("DELETE FROM notes WHERE id = ?").run(noteId);
      return json({ ok: true });
    }

    if (req.method === "POST" && sub === "/share") {
      if (note.shared === 1) return json({ note: noteJson(note, me) });
      db.query("UPDATE notes SET shared = 1, updated_at = ? WHERE id = ?").run(nowIso(), noteId);
      logEvent("shared", me.id, noteId, {});
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
      logEvent("comment", me.id, noteId, {});
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

  if (req.method === "GET" && path === "/api/digests") return json({ digests: listDigests() });
  if (req.method === "GET" && path === "/api/digest") {
    const d = getDigest(url.searchParams.get("week") || undefined);
    if (!d) return err("That letter isn't on the shelf.", 404);
    return json({ digest: d });
  }
  if (req.method === "GET" && path === "/api/nudges") return json({ nudges: nudgesFor(me.id) });
  if (req.method === "POST" && path === "/api/nudges/dismiss") {
    const b = await body(req);
    if (b.key) dismissNudge(me.id, String(b.key));
    return json({ ok: true });
  }

  return err("Not found.", 404);
}

function publicMember(m: any): any {
  return { id: m.id, name: m.name, color: m.color, role: m.role, hasPassword: !!m.password_hash };
}

export function __resetForTests(d: Database): void { __setDbForTests(d); }

if (import.meta.main) {
  ensureNoteGids(getDb(), getMesh());
  Bun.serve({ port: PORT, fetch: handle });
  console.log(`Abba listening on http://localhost:${PORT}  (mesh node ${getMesh().identity.id})`);
  setTimeout(meshTick, 10000);
  setInterval(meshTick, 30000);
}
