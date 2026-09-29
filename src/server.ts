// server.ts — Abba: a quiet markdown notepad for an executive and their circle.
// Bun + zero dependencies + SQLite. Port 3013.
import { Database } from "bun:sqlite";
import { initDataDir, getDb, nowIso, randomToken, randomInviteCode, __setDbForTests } from "./db";
import { autoTitle, readMins, relatedIdeas, composeDigest, nudgesFor, dismissNudge, type NoteRow } from "./mind";

const PORT = Number(process.env.ABBA_PORT || 3013);
const PALETTE = ["#C0765A", "#7A8B6F", "#5A7A8C", "#9A6B8F", "#B8934A", "#6B7F9E", "#8C5A5A", "#5F8C7A", "#A0765A", "#7A6B9E", "#4F7A6B", "#96522F"];
const STATUSES = ["seed", "sprout", "motion", "decided", "resting"] as const;
const REACTIONS = ["felt", "spark", "yes"] as const; // ❤ felt this · 💡 sparked · 🙌 yes

initDataDir();

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
    const count = (db.query("SELECT COUNT(*) AS c FROM members").get() as any).c;
    if (count >= circle.member_cap) return err("The circle is full — it stays intimate by design.", 403);
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) return err("Tell us your name so the circle knows who's here.", 400);
    const token = randomToken("abba_");
    const res = db.query("INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES (?, ?, ?, 'member', ?, ?)")
      .run(name, PALETTE[count % PALETTE.length], token, nowIso(), nowIso());
    const member = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
    return json({ token, member: publicMember(member) });
  }

  // public status: does a circle exist yet? (for the welcome screen)
  if (req.method === "GET" && path === "/api/status") {
    const circle = db.query("SELECT id FROM circle WHERE id = 1").get();
    return json({ hasCircle: !!circle });
  }

  const me = memberFrom(req);
  if (!me) return err("Not signed in.", 401);
  touchPresence(me, url.searchParams.get("view") || "");

  if (req.method === "GET" && path === "/api/me") return json({ member: publicMember(me) });
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
    const t = nowIso();
    const res = db.query(`INSERT INTO notes (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'seed', 0, ?, ?, ?)`).run(me.id, title, noteBody, JSON.stringify(tags), readMins(noteBody), t, t);
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

    if (note.member_id !== me.id && !["/comments", "/react"].includes(sub)) return err("That's someone else's note.", 403);

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
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }

    if (req.method === "DELETE" && sub === "") {
      db.query("DELETE FROM notes WHERE id = ?").run(noteId);
      return json({ ok: true });
    }

    if (req.method === "POST" && sub === "/share") {
      if (note.shared === 1) return json({ note: noteJson(note, me) });
      db.query("UPDATE notes SET shared = 1, updated_at = ? WHERE id = ?").run(nowIso(), noteId);
      logEvent("shared", me.id, noteId, {});
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }
    if (req.method === "POST" && sub === "/unshare") {
      db.query("UPDATE notes SET shared = 0, updated_at = ? WHERE id = ?").run(nowIso(), noteId);
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }

    if (req.method === "POST" && sub === "/comments") {
      const b = await body(req);
      const cbody = String(b.body || "").trim().slice(0, 5000);
      if (!cbody) return err("Write something first.", 400);
      db.query("INSERT INTO comments (note_id, member_id, body, created_at) VALUES (?, ?, ?, ?)")
        .run(noteId, me.id, cbody, nowIso());
      logEvent("comment", me.id, noteId, {});
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
      const fresh = db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
        JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh, me) });
    }
    return err("Not found.", 404);
  }

  if (req.method === "GET" && path === "/api/digest") return json({ digest: composeDigest() });
  if (req.method === "GET" && path === "/api/nudges") return json({ nudges: nudgesFor(me.id) });
  if (req.method === "POST" && path === "/api/nudges/dismiss") {
    const b = await body(req);
    if (b.key) dismissNudge(me.id, String(b.key));
    return json({ ok: true });
  }

  return err("Not found.", 404);
}

function publicMember(m: any): any {
  return { id: m.id, name: m.name, color: m.color, role: m.role };
}

export function __resetForTests(d: Database): void { __setDbForTests(d); }

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: handle });
  console.log(`Abba listening on http://localhost:${PORT}`);
}
