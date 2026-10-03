// imapnotes.ts — two-way sync between a member's Abba notes and a "Notes"
// folder on their own IMAP server (the Apple Mail convention).
//
// Each note is one message: Subject = title, body = markdown, with
// X-Abba-Id / X-Abba-Tags / X-Abba-Status headers carrying the metadata.
// Last-writer-wins by timestamp. Abba is the source of truth for existence:
// deleting a note deletes its message; deleting a message just lets the
// note sync back down again.
//
// The wire protocol runs on Relay's proven IMAP client (src/imap.ts —
// Abba's copy of relay/src/imap.ts). This file only adds the notes-sync
// semantics on top of its Conn.
import { getDb, nowIso } from "./db.ts";
import { Conn, ImapError, connectAndLogin, qstr, decodeHeader } from "./imap.ts";

export { decodeHeader } from "./imap.ts";
export { ImapError } from "./imap.ts";

export interface ImapAccount {
  host: string;
  port: number;
  user: string;
  pass: string;
  folder: string;
}

function toCfg(a: ImapAccount, insecure = false) {
  return { host: a.host, port: a.port, user: a.user, pass: a.pass, secure: !insecure };
}

/** SELECT the notes folder, creating it first when it doesn't exist. */
async function selectOrCreate(conn: Conn, folder: string) {
  try {
    await conn.cmd("a002", `SELECT ${qstr(folder)}`);
  } catch (e: any) {
    if (e instanceof ImapError && /no such|doesn't exist|unknown mailbox|nonexistent/i.test(e.message)) {
      await conn.cmd("a002c", `CREATE ${qstr(folder)}`);
      await conn.cmd("a002s", `SELECT ${qstr(folder)}`);
      return;
    }
    throw e;
  }
}

/** APPEND with a literal body: wait for the "+" continuation first. */
async function appendMessage(conn: Conn, tag: string, folder: string, raw: string) {
  const bytes = Buffer.byteLength(raw, "utf8");
  conn.write(`${tag} APPEND ${qstr(folder)} {${bytes}}\r\n`);
  const cont = await conn.readLine();
  if (!cont.startsWith("+")) throw new ImapError(502, `mail server refused APPEND: ${cont.slice(0, 80)}`);
  conn.write(raw);
  for (;;) {
    const line = await conn.readLine();
    if (line.startsWith(`${tag} `)) {
      if (/^OK\b/i.test(line.slice(tag.length + 1))) return;
      throw new ImapError(502, `APPEND failed: ${line.slice(0, 120)}`);
    }
  }
}

/** Validate credentials and folder access without changing anything. */
export async function testImap(a: ImapAccount): Promise<void> {
  const { conn } = await connectAndLogin(toCfg(a));
  try {
    await selectOrCreate(conn, a.folder);
  } finally {
    conn.close();
  }
}

// ---------- message parsing ----------

interface RemoteMsg {
  uid: number;
  flags: string;
  abbaId: string | null;
  subject: string;
  dateMs: number;
  tags: string[];
  status: string;
}

/** Unfold + split raw headers into a lowercase-name map. */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur = "";
  for (const line of raw.split("\r\n")) {
    if (/^[ \t]/.test(line) && cur) {
      out[cur] += " " + line.trim();
    } else {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) { cur = m[1].toLowerCase(); out[cur] = (out[cur] ? out[cur] + " " : "") + m[2].trim(); }
    }
  }
  return out;
}

function encodeHeader(v: string): string {
  return /[^\x00-\x7F]/.test(v) ? `=?UTF-8?B?${Buffer.from(v, "utf-8").toString("base64")}?=` : v;
}

function parseImapDate(s: string): number {
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // INTERNALDATE: "02-Oct-2026 16:04:11 +0000"
  const m = s.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mo = months[m[2].toLowerCase()];
    if (mo !== undefined) return Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]);
  }
  return 0;
}

/** Parse the untagged FETCH lines from the header-fields listing. */
function parseListing(lines: string[]): RemoteMsg[] {
  const out: RemoteMsg[] = [];
  for (const line of lines) {
    if (!line.startsWith("*")) continue;
    const uid = Number((line.match(/UID (\d+)/) || [])[1] || 0);
    if (!uid) continue;
    const flags = (line.match(/FLAGS \(([^)]*)\)/) || [])[1] || "";
    const internal = (line.match(/INTERNALDATE "([^"]+)"/) || [])[1] || "";
    const litIdx = line.indexOf("\n");
    const headers = litIdx >= 0 ? parseHeaders(line.slice(litIdx + 1).replace(/\n\)$/, "")) : {};
    const dateMs = (headers["date"] && parseImapDate(headers["date"])) || parseImapDate(internal);
    out.push({
      uid, flags,
      abbaId: (headers["x-abba-id"] || "").trim() || null,
      subject: decodeHeader(headers["subject"] || "").trim(),
      dateMs,
      tags: (headers["x-abba-tags"] || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
      status: (headers["x-abba-status"] || "").trim().toLowerCase(),
    });
  }
  return out;
}

async function listMessages(conn: Conn): Promise<RemoteMsg[]> {
  const lines = await conn.cmd("a010", "UID FETCH 1:* (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID X-ABBA-ID X-ABBA-TAGS X-ABBA-STATUS)])");
  return parseListing(lines);
}

/** Fetch the full raw message for one UID. */
async function fetchRaw(conn: Conn, uid: number): Promise<string> {
  const lines = await conn.cmd("a011", `UID FETCH ${uid} (BODY.PEEK[])`);
  for (const line of lines) {
    const idx = line.indexOf("\n");
    if (line.startsWith("*") && idx >= 0) return line.slice(idx + 1).replace(/\n\)$/, "");
  }
  return "";
}

interface ParsedNote { subject: string; body: string; tags: string[]; status: string; }

/** Best-effort text extraction: our own text/plain messages, or the first
 *  text/plain part of a multipart message, or stripped text/html.
 *  Exported for tests. */
export function parseMessage(raw: string): ParsedNote {
  const split = raw.indexOf("\r\n\r\n");
  const head = split >= 0 ? raw.slice(0, split) : "";
  let body = split >= 0 ? raw.slice(split + 4) : raw;
  const headers = parseHeaders(head);
  const ct = (headers["content-type"] || "").toLowerCase();
  const boundary = (ct.match(/boundary="?([^";]+)"?/) || [])[1];
  if (boundary) {
    const parts = body.split("--" + boundary);
    let html = "";
    for (const p of parts) {
      const ps = p.indexOf("\r\n\r\n");
      if (ps < 0) continue;
      const ph = parseHeaders(p.slice(0, ps));
      const pct = (ph["content-type"] || "").toLowerCase();
      const pbody = p.slice(ps + 4).replace(/\r\n$/, "");
      if (pct.includes("text/plain")) { body = pbody; html = ""; break; }
      if (pct.includes("text/html") && !html) html = pbody;
    }
    if (!body.trim() && html) {
      body = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
    }
  }
  return {
    subject: decodeHeader(headers["subject"] || "").trim(),
    body: body.replace(/\r\n/g, "\n").trim(),
    tags: (headers["x-abba-tags"] || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8),
    status: (headers["x-abba-status"] || "").trim().toLowerCase(),
  };
}

// ---------- message building ----------

const STATUSES = ["seed", "sprout", "motion", "decided", "resting"] as const;

/** Build the raw RFC822 message for a note. Exported for tests. */
export function buildMessage(n: { id: number; title: string; body: string; tags: string[]; status: string; updated_at: string }): string {
  const abbaId = "note-" + n.id;
  const bodyText = String(n.body || "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const lines = [
    `Message-ID: <abba-${n.id}-${Date.now()}@abba.local>`,
    `Date: ${new Date(n.updated_at).toUTCString()}`,
    `Subject: ${encodeHeader(n.title || "Untitled")}`,
    `X-Abba-Id: ${abbaId}`,
    `X-Abba-Tags: ${n.tags.join(", ")}`,
    `X-Abba-Status: ${STATUSES.includes(n.status as any) ? n.status : "seed"}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    bodyText,
  ];
  return lines.join("\r\n") + "\r\n";
}

// ---------- sync ----------

export interface SyncResult { pushed: number; pulled: number; deleted: number; errors: string[]; }

function readMins(body: string): number {
  const words = String(body || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** Two-way sync of the notepad with the Notes folder. Never throws —
 *  errors land in the result. `opts.insecure` talks plain TCP and exists
 *  for the local test fake only. */
export async function syncImapAccount(opts: { insecure?: boolean } = {}): Promise<SyncResult> {
  const db = getDb();
  const result: SyncResult = { pushed: 0, pulled: 0, deleted: 0, errors: [] };
  const acct = db.query("SELECT * FROM imap_account WHERE id = 1").get() as any;
  if (!acct) { result.errors.push("IMAP not configured."); return result; }
  const cfg: ImapAccount = {
    host: acct.host, port: acct.port || 993,
    user: acct.username, pass: acct.password, folder: acct.folder || "Notes",
  };
  const { conn } = await connectAndLogin(toCfg(cfg, !!opts.insecure)).catch((e: any) => {
    const msg = String((e && e.message) || e).slice(0, 200);
    try { db.query("UPDATE imap_account SET last_error = ? WHERE id = 1").run(msg); } catch { /* db gone */ }
    result.errors.push(msg);
    return { conn: null as Conn | null };
  });
  if (!conn) return result;
  try {
    await selectOrCreate(conn, cfg.folder);
    const remote = await listMessages(conn);
    const byAbbaId = new Map<string, RemoteMsg>();
    for (const m of remote) if (m.abbaId && !m.flags.includes("\\Deleted")) byAbbaId.set(m.abbaId, m);
    const notes = db.query("SELECT * FROM notes").all() as any[];
    const noteIds = new Set(notes.map((n) => "note-" + n.id));
    const matchedUids = new Set<number>();

    // push new / changed notes; pull messages that are newer
    for (const n of notes) {
      const abbaId = "note-" + n.id;
      const m = byAbbaId.get(abbaId);
      const tags = JSON.parse(n.tags || "[]");
      if (!m) {
        await appendMessage(conn, "a020", cfg.folder, buildMessage({ ...n, tags }));
        result.pushed++;
        continue;
      }
      matchedUids.add(m.uid);
      const noteMs = Date.parse(n.updated_at) || 0;
      if (noteMs - m.dateMs > 2000) {
        await conn.cmd("a021", `UID STORE ${m.uid} +FLAGS (\\Deleted)`);
        await appendMessage(conn, "a022", cfg.folder, buildMessage({ ...n, tags }));
        result.pushed++;
      } else if (m.dateMs - noteMs > 2000) {
        const p = parseMessage(await fetchRaw(conn, m.uid));
        if (!p.body && !p.subject) continue;
        db.query("UPDATE notes SET title = ?, body = ?, tags = ?, status = ?, read_mins = ?, updated_at = ? WHERE id = ?")
          .run(p.subject || n.title, p.body || n.body, JSON.stringify(p.tags.length ? p.tags : tags),
            STATUSES.includes(p.status as any) ? p.status : n.status,
            readMins(p.body || n.body), new Date(m.dateMs).toISOString(), n.id);
        result.pulled++;
      }
    }

    // brand-new messages (written in a mail client) become notes
    for (const m of remote) {
      if (m.abbaId || matchedUids.has(m.uid) || m.flags.includes("\\Deleted")) continue;
      const p = parseMessage(await fetchRaw(conn, m.uid));
      if (!p.body && !p.subject) continue;
      const t = nowIso();
      const r = db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(p.subject || "Untitled", p.body, JSON.stringify(p.tags),
          STATUSES.includes(p.status as any) ? p.status : "seed", readMins(p.body), t, t);
      const newId = Number(r.lastInsertRowid);
      await conn.cmd("a023", `UID STORE ${m.uid} +FLAGS (\\Deleted)`);
      await appendMessage(conn, "a024", cfg.folder, buildMessage({
        id: newId, title: p.subject || "Untitled", body: p.body, tags: p.tags,
        status: STATUSES.includes(p.status as any) ? p.status : "seed", updated_at: t,
      }));
      result.pulled++;
    }

    // notes deleted in Abba: drop their messages
    for (const m of remote) {
      if (m.abbaId && !noteIds.has(m.abbaId) && !m.flags.includes("\\Deleted")) {
        await conn.cmd("a025", `UID STORE ${m.uid} +FLAGS (\\Deleted)`);
        result.deleted++;
      }
    }

    await conn.cmd("a026", "EXPUNGE");
    db.query("UPDATE imap_account SET last_sync_at = ?, last_error = '' WHERE id = 1").run(nowIso());
  } catch (e: any) {
    const msg = String((e && e.message) || e).slice(0, 200);
    try { db.query("UPDATE imap_account SET last_error = ? WHERE id = 1").run(msg); } catch { /* db gone */ }
    result.errors.push(msg);
  } finally {
    conn.close();
  }
  return result;
}
