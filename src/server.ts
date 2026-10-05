// server.ts — Abba: a quiet single-user markdown notepad.
// Bun + zero dependencies + SQLite. Port 3013.
//
// There is no sign-in: the server binds to 127.0.0.1 and access control
// lives one layer up (Deck's TOTP gate). Abba handles no communications —
// no email, no IMAP, no SMTP, no polling. The only network interface beyond
// the UI is the read-only GET /api/sync/notes feed for Switchboard.
import { Database } from "bun:sqlite";
import { initDataDir, getDb, nowIso, kvGet, kvSet, __setDbForTests } from "./db";
import { autoTitle, readMins, relatedIdeas, composeDigest, composeDailyLetter, getDigest, listDigests, nudgesFor, dismissNudge, type NoteRow } from "./mind";

const PORT = Number(process.env.ABBA_PORT || 3013);
const STATUSES = ["seed", "sprout", "motion", "decided", "resting"] as const;

initDataDir();

// ---- helpers -----------------------------------------------------------------
function assetVersion(): number {
  const dir = `${import.meta.dir}/../public`;
  let v = 0;
  for (const f of ["app.js", "styles.css", "index.html", "sw.js", "manifest.webmanifest",
                   "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) {
    try { v = Math.max(v, Bun.file(`${dir}/${f}`).lastModified); } catch { /* ignore */ }
  }
  return Math.floor(v / 1000);
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function err(message: string, status = 400): Response { return json({ error: message }, status); }
async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}
function noteJson(n: NoteRow): any {
  const db = getDb();
  const tags = JSON.parse(n.tags || "[]");
  const comments = db.query(`SELECT * FROM comments WHERE note_id = ? ORDER BY created_at ASC`).all(n.id) as any[];
  return {
    id: n.id, title: n.title, body: n.body, tags, status: n.status,
    readMins: n.read_mins,
    createdAt: n.created_at, updatedAt: n.updated_at,
    comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at, author: c.author_name || "" })),
  };
}
function logEvent(kind: string, noteId: number | null, meta: any = {}): void {
  getDb().query("INSERT INTO events (kind, note_id, meta, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, noteId, JSON.stringify(meta), nowIso());
}

// ---- app -----------------------------------------------------------------------
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const db = getDb();

  // static — index.html gets a cache-busting version so clients never run stale JS
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    const html = (await Bun.file(`${import.meta.dir}/../public/index.html`).text()).replaceAll("__V__", String(assetVersion()));
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  if (req.method === "GET" && path === "/sw.js") {
    // The SW cache name MUST be version-stamped: an unchanging name plus
    // ignoreSearch:true in the fetch handler pins clients to the first
    // cached app.js forever, so a deploy never reaches them.
    const sw = (await Bun.file(`${import.meta.dir}/../public/sw.js`).text()).replaceAll("__V__", String(assetVersion()));
    return new Response(sw, { headers: { "Content-Type": "application/javascript" } });
  }
  if (req.method === "GET" && path === "/manifest.webmanifest")
    return new Response(await Bun.file(`${import.meta.dir}/../public/manifest.webmanifest`).text(), { headers: { "Content-Type": "application/manifest+json" } });
  for (const icon of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "favicon.svg"]) {
    if (req.method === "GET" && path === "/" + icon)
      return new Response(Bun.file(`${import.meta.dir}/../public/${icon}`));
  }
  if (req.method === "GET" && path === "/app.js")
    return new Response(await Bun.file(`${import.meta.dir}/../public/app.js`).text(), { headers: { "Content-Type": "application/javascript" } });
  if (req.method === "GET" && path === "/styles.css")
    return new Response(await Bun.file(`${import.meta.dir}/../public/styles.css`).text(), { headers: { "Content-Type": "text/css" } });
  if (req.method === "GET" && path === "/favicon.svg")
    return new Response(await Bun.file(`${import.meta.dir}/../public/favicon.svg`).text(), { headers: { "Content-Type": "image/svg+xml" } });
  if (req.method === "GET" && path === "/vendor/mermaid.min.js")
    return new Response(await Bun.file(`${import.meta.dir}/../public/vendor/mermaid.min.js`).text(), { headers: { "Content-Type": "application/javascript" } });

  // ---- status ----
  if (req.method === "GET" && path === "/api/status") {
    const notes = (db.query("SELECT COUNT(*) AS n FROM notes").get() as any).n;
    return json({ ok: true, notes });
  }

  // ---- notes ----
  if (req.method === "GET" && path === "/api/notes") {
    const rows = db.query(`SELECT * FROM notes ORDER BY updated_at DESC`).all() as NoteRow[];
    return json({ notes: rows.map(noteJson) });
  }
  if (req.method === "POST" && path === "/api/notes") {
    const b = await body(req);
    const noteBody = String(b.body || "").slice(0, 60000);
    if (!noteBody.trim()) return err("Write something first — even a fragment.", 400);
    const title = String(b.title || "").trim().slice(0, 120) || autoTitle(noteBody);
    const tags = Array.isArray(b.tags) ? b.tags.map((t: any) => String(t).slice(0, 30)).slice(0, 8) : [];
    const t = nowIso();
    const res = db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
      VALUES (?, ?, ?, 'seed', ?, ?, ?)`).run(title, noteBody, JSON.stringify(tags), readMins(noteBody), t, t);
    const note = db.query(`SELECT * FROM notes WHERE id = ?`).get(Number(res.lastInsertRowid)) as NoteRow;
    return json({ note: noteJson(note) }, 201);
  }

  const noteIdMatch = path.match(/^\/api\/notes\/(\d+)(\/.*)?$/);
  if (noteIdMatch) {
    const noteId = Number(noteIdMatch[1]);
    const sub = noteIdMatch[2] || "";
    const note = db.query(`SELECT * FROM notes WHERE id = ?`).get(noteId) as unknown as NoteRow | null;
    if (!note) return err("Not found.", 404);

    if (req.method === "GET" && sub === "") return json({ note: noteJson(note) });

    if (req.method === "GET" && sub === "/related") {
      const pool = db.query(`SELECT * FROM notes WHERE id != ?`).all(noteId) as NoteRow[];
      return json({ related: relatedIdeas(note, pool).map((n) => ({ id: n.id, title: n.title })) });
    }

    if (req.method === "GET" && sub === "/export") {
      const md = `# ${note.title}\n\n${note.body}\n\n---\n*${note.created_at.slice(0, 10)} · ${note.status}*\n`;
      return new Response(md, { headers: { "Content-Type": "text/markdown", "Content-Disposition": `attachment; filename="abba-${note.id}.md"` } });
    }

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
        logEvent("status", note.id, { from: note.status, to: b.status });
      }
      if (!updates.length) return err("Nothing to change.", 400);
      updates.push("updated_at = ?"); vals.push(nowIso()); vals.push(noteId);
      db.query(`UPDATE notes SET ${updates.join(", ")} WHERE id = ?`).run(...vals);
      const fresh = db.query(`SELECT * FROM notes WHERE id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh) });
    }

    if (req.method === "DELETE" && sub === "") {
      db.query("DELETE FROM notes WHERE id = ?").run(noteId);
      return json({ ok: true });
    }

    if (req.method === "POST" && sub === "/comments") {
      const b = await body(req);
      const cbody = String(b.body || "").trim().slice(0, 5000);
      if (!cbody) return err("Write something first.", 400);
      const author = String(b.author || "").trim().slice(0, 40);
      const cres = db.query("INSERT INTO comments (note_id, author_name, body, created_at) VALUES (?, ?, ?, ?)")
        .run(noteId, author, cbody, nowIso());
      logEvent("comment", noteId, {});
      const fresh = db.query(`SELECT * FROM notes WHERE id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh), commentId: Number(cres.lastInsertRowid) }, 201);
    }
    if (req.method === "DELETE" && sub.startsWith("/comments/")) {
      const cid = Number(sub.split("/")[2]);
      if (!cid) return err("Not found.", 404);
      db.query("DELETE FROM comments WHERE id = ? AND note_id = ?").run(cid, noteId);
      const fresh = db.query(`SELECT * FROM notes WHERE id = ?`).get(noteId) as NoteRow;
      return json({ note: noteJson(fresh) });
    }
    return err("Not found.", 404);
  }

  // ---- letters ----
  if (req.method === "GET" && path === "/api/digests") return json({ digests: listDigests() });
  if (req.method === "GET" && path === "/api/digest/today") return json({ digest: composeDailyLetter() });
  if (req.method === "GET" && path === "/api/digest") {
    const d = getDigest(url.searchParams.get("week") || undefined);
    if (!d) return err("That letter isn't on the shelf.", 404);
    return json({ digest: d });
  }
  if (req.method === "GET" && path === "/api/nudges") return json({ nudges: nudgesFor() });
  if (req.method === "POST" && path === "/api/nudges/dismiss") {
    const b = await body(req);
    if (b.key) dismissNudge(String(b.key));
    return json({ ok: true });
  }

  // ---- sync feed (read-only, for Switchboard) ----
  // GET /api/sync/notes?since=<unix-timestamp>
  // Returns notes (ideas) changed since the timestamp: [{id, title, folder, updated_at, state}].
  // updated_at is ISO 8601; compare with >= against `since`.
  // This is the only network interface Abba exposes beyond its UI.
  if (req.method === "GET" && path === "/api/sync/notes") {
    const sinceRaw = url.searchParams.get("since");
    let sinceMs = Number(sinceRaw || 0);
    if (sinceMs > 0 && sinceMs < 1e12) sinceMs *= 1000; // accept unix seconds as well as ms
    const since = sinceMs > 0 ? new Date(sinceMs).toISOString() : "1970-01-01T00:00:00.000Z";
    const rows = db.query(
      `SELECT id, title, status, updated_at FROM notes WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 500`
    ).all(since) as any[];
    return json({
      notes: rows.map((r) => ({
        id: r.id,
        title: r.title,
        folder: "Notepad",
        updated_at: r.updated_at,
        state: r.status,
      })),
    });
  }

  // ---- backup: plain JSON export / import ----
  if (req.method === "GET" && path === "/api/backup") {
    const notes = db.query(`SELECT * FROM notes ORDER BY id`).all();
    const comments = db.query(`SELECT * FROM comments ORDER BY id`).all();
    const digests = db.query(`SELECT week_key, payload, created_at FROM digests ORDER BY week_key`).all();
    return new Response(JSON.stringify({ app: "abba", version: 1, exportedAt: nowIso(), notes, comments, digests }, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="abba-backup.json"` },
    });
  }
  if (req.method === "POST" && path === "/api/backup") {
    const b = await body(req);
    if (b.app !== "abba" || !Array.isArray(b.notes)) return err("That's not an Abba backup.", 400);
    const t = nowIso();
    let imported = 0;
    for (const n of b.notes.slice(0, 5000)) {
      const title = String(n.title || "").slice(0, 120) || autoTitle(String(n.body || ""));
      const nbody = String(n.body || "").slice(0, 60000);
      if (!nbody.trim()) continue;
      db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(title, nbody, JSON.stringify(Array.isArray(n.tags) ? n.tags.slice(0, 8) : []),
          (STATUSES as readonly string[]).includes(n.status) ? n.status : "seed",
          readMins(nbody), n.created_at || t, n.updated_at || t);
      imported++;
    }
    return json({ ok: true, imported });
  }

  return err("Not found.", 404);
}

export function __resetForTests(d: Database): void { __setDbForTests(d); }

// ---------------------------------------------------------------------------
// Email-to-note ingest: Abba pulls emails Relay found in the Notes IMAP
// folder via Relay's HTTP API. NO IMAP/SMTP here — Abba stays comms-free.
// One-way ingest only: nothing is ever written back to the Notes folder.
//
// Relay contract: GET {RELAY_URL}/api/relay/notes-emails?since=<ms|sec>
//   → { emails: [{ id, message_id, subject, body, from, date }] }
//   date is unix seconds; body is markdown (Apple Notes convention).
// ---------------------------------------------------------------------------
const RELAY_BASE = (process.env.RELAY_URL || "http://127.0.0.1:3006").trim().replace(/\/+$/, "");
const INGEST_INTERVAL_MS = 5 * 60 * 1000;
const INGEST_WATERMARK_KEY = "notes_mail_watermark";

export interface NotesEmail {
  id?: unknown;
  message_id?: unknown;
  subject?: unknown;
  body?: unknown;
  from?: unknown;
  date?: unknown;
}

/** Dedupe key: message_id, falling back to relay's id. Empty when unidentifiable. */
export function notesEmailDedupeKey(e: NotesEmail): string {
  const mid = String(e?.message_id ?? "").trim();
  if (mid) return mid;
  const rid = String(e?.id ?? "").trim();
  return rid ? `relay:${rid}` : "";
}

function notesEmailDateMs(e: NotesEmail): number {
  const d = e?.date;
  if (typeof d === "number" && Number.isFinite(d) && d > 0) return d > 1e12 ? d : d * 1000;
  if (typeof d === "string" && d.trim()) {
    const p = Date.parse(d.trim());
    if (!Number.isNaN(p) && p > 0) return p;
  }
  return Date.now();
}

/** Pure mapping: Relay Notes-folder email → Abba note fields. */
export function notesEmailToNote(e: NotesEmail): {
  title: string; body: string; tags: string; created_at: string; updated_at: string;
} {
  const body = String(e?.body ?? "");
  const subject = String(e?.subject ?? "").trim();
  const title = (subject || body.trim().slice(0, 60) || "Untitled note").slice(0, 200);
  const iso = new Date(notesEmailDateMs(e)).toISOString();
  return { title, body, tags: JSON.stringify(["from-email"]), created_at: iso, updated_at: iso };
}

/** One ingest pass. Quiet on Relay failure; never throws. */
export async function ingestNotesEmails(): Promise<{ fetched: number; ingested: number }> {
  const db = getDb();
  let wm = Number(kvGet(INGEST_WATERMARK_KEY) || 0);
  if (!wm) wm = Date.now() - 7 * 86400000; // first run: last 7 days only, no ancient history
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res: Response;
  try {
    res = await fetch(`${RELAY_BASE}/api/relay/notes-emails?since=${wm}`, { signal: ctrl.signal });
  } catch {
    console.log("[ingest] relay unreachable, skipping notes-email poll");
    return { fetched: 0, ingested: 0 };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    console.log(`[ingest] relay HTTP ${res.status}, skipping notes-email poll`);
    return { fetched: 0, ingested: 0 };
  }
  const j: any = await res.json().catch(() => null);
  const emails: NotesEmail[] = Array.isArray(j?.emails) ? j.emails : [];
  let ingested = 0;
  let maxDate = wm;
  for (const e of emails) {
    const key = notesEmailDedupeKey(e);
    if (!key) continue; // unidentifiable: skip rather than risk duplicates
    if (db.query(`SELECT 1 FROM ingested_mail WHERE message_id = ?`).get(key)) continue;
    const n = notesEmailToNote(e);
    const r = db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
      VALUES (?, ?, ?, 'seed', ?, ?, ?)`)
      .run(n.title, n.body, n.tags, readMins(n.body), n.created_at, n.updated_at);
    db.query(`INSERT INTO ingested_mail (message_id, note_id, ingested_at) VALUES (?, ?, ?)`)
      .run(key, Number(r.lastInsertRowid), nowIso());
    ingested++;
    const ems = Date.parse(n.created_at);
    if (ems > maxDate) maxDate = ems;
  }
  if (maxDate > wm) kvSet(INGEST_WATERMARK_KEY, String(maxDate));
  if (ingested > 0) console.log(`[ingest] notes-email: ${ingested} new note(s) from ${emails.length} fetched`);
  return { fetched: emails.length, ingested };
}

function startNotesEmailIngest(): void {
  ingestNotesEmails().catch(() => {});
  setInterval(() => { ingestNotesEmails().catch(() => {}); }, INGEST_INTERVAL_MS);
}

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: handle });
  console.log(`Abba listening on http://127.0.0.1:${PORT}  (single-user; access via Deck)`);
  startNotesEmailIngest();
}
