// server.ts — Abba: a quiet single-user markdown notepad.
// Bun + zero dependencies + SQLite. Port 3013.
//
// There is no sign-in: the server binds to 127.0.0.1 and access control
// lives one layer up (Deck's TOTP gate). There is no peer-to-peer mesh.
// Sharing is email through IMAP: notes go out with X-Abba-Share headers,
// incoming shares are picked up from INBOX into the "shared with me" shelf.
import { Database } from "bun:sqlite";
import { initDataDir, getDb, nowIso, __setDbForTests } from "./db";
import { autoTitle, readMins, relatedIdeas, composeDigest, composeDailyLetter, getDigest, listDigests, nudgesFor, dismissNudge, type NoteRow } from "./mind";
import { syncImapAccount, testImap } from "./imapnotes";
import { shareNote, scanSharedInbox, getImapAccount, smtpHostFor, SmtpError } from "./share";
import { testSmtp } from "./smtp";

const PORT = Number(process.env.ABBA_PORT || 3013);
const STATUSES = ["seed", "sprout", "motion", "decided", "resting"] as const;

initDataDir();

// ---- IMAP sync ---------------------------------------------------------------
// queueImapSync() debounces a sync ~20s after edits; a 10-minute interval
// catches changes made from mail clients and picks up incoming shares.
//
// IMPORTANT: IMAP work never holds an HTTP request open. A full Gmail
// round-trip is dozens of sequential APPEND/FETCH commands and can run
// longer than proxy timeouts (Cloudflare ~100s) — the browser then reports
// "Load failed" even though the sync is fine. runImapWork() runs everything
// in the background; the client polls GET /api/imap for completion.
let imapTimer: any = null;
let imapWork: { kind: "sync" | "scan"; startedAt: string } | null = null;
let lastSyncResult: { pushed: number; pulled: number; deleted: number; errors: string[] } | null = null;
let lastScanResult: { imported: number } | null = null;

function runImapWork(kind: "sync" | "scan", fn: () => Promise<any>): boolean {
  if (imapWork) return false; // one at a time — the other trigger retries later
  imapWork = { kind, startedAt: nowIso() };
  fn().then(
    (r) => {
      if (kind === "sync") lastSyncResult = r as any;
      else lastScanResult = r as any;
      imapWork = null;
    },
    (e) => { console.error(`[imap] background ${kind} failed:`, (e as any)?.message); imapWork = null; },
  );
  return true;
}
function queueImapSync() {
  try {
    if (!getImapAccount()) return;
    if (imapTimer) clearTimeout(imapTimer);
    imapTimer = setTimeout(() => {
      imapTimer = null;
      runImapWork("sync", () => syncImapAccount());
      runImapWork("scan", () => scanSharedInbox());
    }, 20000);
  } catch { /* db not ready */ }
}
setInterval(() => {
  try {
    if (!getImapAccount()) return;
    runImapWork("sync", () => syncImapAccount());
    runImapWork("scan", () => scanSharedInbox());
  } catch { /* db not ready */ }
}, 10 * 60 * 1000);

// ---- helpers -----------------------------------------------------------------
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
  const shareCount = (db.query(`SELECT COUNT(*) AS n FROM shares WHERE note_id = ?`).get(n.id) as any)?.n || 0;
  return {
    id: n.id, title: n.title, body: n.body, tags, status: n.status,
    readMins: n.read_mins, shared: shareCount > 0,
    createdAt: n.created_at, updatedAt: n.updated_at,
    comments: comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at, author: c.author_name || "" })),
  };
}
function logEvent(kind: string, noteId: number | null, meta: any = {}): void {
  getDb().query("INSERT INTO events (kind, note_id, meta, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, noteId, JSON.stringify(meta), nowIso());
}
function imapJson(a: any): any {
  if (!a) return { configured: false };
  return {
    configured: true, host: a.host, port: a.port, username: a.username,
    folder: a.folder, smtpHost: a.smtp_host || "", smtpPort: a.smtp_port || 587,
    lastSyncAt: a.last_sync_at, lastError: a.last_error, lastShareScanAt: a.last_share_scan_at,
    syncRunning: !!imapWork, syncKind: imapWork ? imapWork.kind : null,
    lastSync: lastSyncResult, lastScan: lastScanResult,
  };
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
  if (req.method === "GET" && path === "/sw.js") {
    return new Response(await Bun.file(`${import.meta.dir}/../public/sw.js`).text(), { headers: { "Content-Type": "application/javascript" } });
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
    const sharedIn = (db.query("SELECT COUNT(*) AS n FROM shared_notes").get() as any).n;
    return json({ ok: true, notes, sharedInbox: sharedIn, mail: !!getImapAccount() });
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
    queueImapSync();
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
      queueImapSync();
      return json({ note: noteJson(fresh) });
    }

    if (req.method === "DELETE" && sub === "") {
      db.query("DELETE FROM notes WHERE id = ?").run(noteId);
      queueImapSync();
      return json({ ok: true });
    }

    // share by email — the email is the invite; no codes, no mesh
    if (req.method === "POST" && sub === "/share") {
      const b = await body(req);
      const emails = Array.isArray(b.emails) ? b.emails : [];
      try {
        const r = await shareNote(noteId, emails);
        logEvent("shared", noteId, { recipients: emails.length });
        return json({ sent: r.sent });
      } catch (e: any) {
        const status = e instanceof SmtpError ? (e.code >= 500 ? 502 : e.code) : 502;
        return err("Couldn't send: " + String((e && e.message) || e).slice(0, 200), status);
      }
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

  // ---- share history ----
  if (req.method === "GET" && path === "/api/shares") {
    const rows = db.query(`
      SELECT s.id, s.note_id, s.recipient, s.shared_at, n.title
      FROM shares s LEFT JOIN notes n ON n.id = s.note_id
      ORDER BY s.shared_at DESC LIMIT 100`).all();
    return json({ shares: rows });
  }

  // ---- shared with me (incoming shares) ----
  if (req.method === "GET" && path === "/api/shared") {
    const rows = db.query(`SELECT * FROM shared_notes ORDER BY received_at DESC`).all();
    return json({ shared: rows });
  }
  const sharedIdMatch = path.match(/^\/api\/shared\/(\d+)$/);
  if (sharedIdMatch) {
    const sid = Number(sharedIdMatch[1]);
    if (req.method === "GET") {
      const row = db.query(`SELECT * FROM shared_notes WHERE id = ?`).get(sid);
      if (!row) return err("Not found.", 404);
      return json({ note: row });
    }
    if (req.method === "DELETE") {
      db.query(`DELETE FROM shared_notes WHERE id = ?`).run(sid);
      return json({ ok: true });
    }
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

  // ---- mail: IMAP notes sync + SMTP sharing (one account; password never leaves the server) ----
  if (path === "/api/imap" && req.method === "GET") {
    return json(imapJson(getImapAccount()));
  }
  if (path === "/api/imap" && (req.method === "PUT" || req.method === "POST")) {
    const b = await body(req);
    const host = String(b.host || "").trim();
    const username = String(b.username || "").trim();
    const folder = String(b.folder || "Notes").trim().slice(0, 60) || "Notes";
    const port = b.port && Number(b.port) > 0 ? Number(b.port) : 993;
    const smtpHost = String(b.smtpHost || "").trim().slice(0, 120);
    const smtpPort = b.smtpPort && Number(b.smtpPort) > 0 ? Number(b.smtpPort) : 587;
    const existing = getImapAccount();
    const password = typeof b.password === "string" && b.password ? b.password : (existing ? existing.password : "");
    if (!host || !username || !password) return err("Host, username, and password are required.", 400);
    try {
      await testImap({ host, port, user: username, pass: password, folder });
    } catch (e: any) {
      return err("Couldn't reach that mailbox: " + String((e && e.message) || e).slice(0, 160), 502);
    }
    let smtpWarning = "";
    try {
      await testSmtp({ host: smtpHost || host.replace(/^imap\./i, "smtp."), port: smtpPort, user: username, pass: password });
    } catch (e: any) {
      smtpWarning = "Mail sync is on, but sending shares failed this check: " + String((e && e.message) || e).slice(0, 140);
    }
    const t = nowIso();
    db.query(`INSERT INTO imap_account (id, host, port, username, password, folder, smtp_host, smtp_port, last_error, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, '', ?)
      ON CONFLICT(id) DO UPDATE SET host = excluded.host, port = excluded.port,
        username = excluded.username, password = excluded.password, folder = excluded.folder,
        smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
        last_error = '', updated_at = excluded.updated_at`)
      .run(host, port, username, password, folder, smtpHost, smtpPort, t);
    queueImapSync();
    return json({ ok: true, smtpWarning: smtpWarning || undefined });
  }
  if (path === "/api/imap" && req.method === "DELETE") {
    db.query("DELETE FROM imap_account WHERE id = 1").run();
    if (imapTimer) { clearTimeout(imapTimer); imapTimer = null; }
    return json({ ok: true });
  }
  if (path === "/api/imap/sync" && req.method === "POST") {
    const started = runImapWork("sync", () => syncImapAccount());
    return json({ ok: true, running: true, started });
  }
  if (path === "/api/imap/scan" && req.method === "POST") {
    const started = runImapWork("scan", () => scanSharedInbox());
    return json({ ok: true, running: true, started });
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
    queueImapSync();
    return json({ ok: true, imported });
  }

  return err("Not found.", 404);
}

export function __resetForTests(d: Database): void { __setDbForTests(d); }

if (import.meta.main) {
  Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: handle });
  console.log(`Abba listening on http://127.0.0.1:${PORT}  (single-user; access via Deck)`);
}
