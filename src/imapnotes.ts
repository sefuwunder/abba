// imapnotes.ts — two-way sync between a member's Abba notes and a "Notes"
// folder on their own IMAP server (the Apple Mail convention).
//
// Each note is one message: Subject = title, body = markdown, with
// X-Abba-Id / X-Abba-Tags / X-Abba-Status headers carrying the metadata.
// Last-writer-wins by timestamp. Abba is the source of truth for existence:
// deleting a note deletes its message; deleting a message just lets the
// note sync back down again.
//
// Wire client is modeled on relay's zero-dependency IMAP Conn (implicit TLS,
// tagged commands, literal handling), trimmed to what the sync needs.
import { getDb, nowIso } from "./db.ts";

export interface ImapAccount {
  host: string;
  port: number;
  user: string;
  pass: string;
  folder: string;
}

export class ImapError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

const READ_TIMEOUT_MS = 30000;

class Conn {
  private buf = Buffer.alloc(0);
  private lines: string[] = [];
  private wake: (() => void) | null = null;
  private closedErr: Error | null = null;
  private sock: any = null;

  async open(host: string, port: number, secure = true) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new ImapError(0, `mail server not reachable (${host}:${port}) — timed out`)); }
      }, READ_TIMEOUT_MS);
      const self = this;
      const pending: any = Bun.connect({
        hostname: host, port, tls: secure,
        socket: {
          open(sock: any) {
            self.sock = sock;
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          },
          data(_s: any, data: Buffer) { self.onData(data); },
          error(_s: any, err: Error) {
            if (!settled) { settled = true; clearTimeout(timer); reject(new ImapError(0, `mail server not reachable (${host}:${port}) — ${err.message}`)); }
            else self.onClose(err);
          },
          close() { self.onClose(new Error("connection closed by server")); },
        },
      });
      if (pending && typeof pending.catch === "function") {
        pending.catch((err: Error) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(new ImapError(0, `mail server not reachable (${host}:${port}) — ${err.message || "connection failed"}`)); }
        });
      }
    });
  }

  private onData(data: Buffer) {
    this.buf = Buffer.concat([this.buf, data]);
    for (;;) {
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) break;
      const line = this.buf.slice(0, idx).toString("utf8");
      let rest = this.buf.slice(idx + 2);
      const lm = line.match(/\{(\d+)\}$/);
      if (lm) {
        const n = Number(lm[1]);
        if (rest.length < n) break; // wait for the full literal
        const lit = rest.slice(0, n).toString("utf8");
        rest = rest.slice(n);
        this.buf = rest;
        this.lines.push(line + "\n" + lit);
        continue;
      }
      this.buf = rest;
      this.lines.push(line);
    }
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  private onClose(err: Error) {
    if (!this.closedErr) this.closedErr = err;
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }

  async readLine(): Promise<string> {
    for (;;) {
      if (this.lines.length) return this.lines.shift()!;
      if (this.closedErr) throw new ImapError(0, this.closedErr.message);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = null;
          reject(new ImapError(0, "mail server timed out waiting for a reply"));
        }, READ_TIMEOUT_MS);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  write(s: string) { this.sock.write(s); }

  /** Send one tagged command; return response lines through the tagged OK. */
  async cmd(tag: string, command: string): Promise<string[]> {
    this.write(`${tag} ${command}\r\n`);
    const out: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1);
        if (/^OK\b/i.test(rest)) return out;
        const msg = rest.replace(/^(NO|BAD)\s*/i, "").trim();
        const authish = /auth|login|credential|password|username/i.test(msg);
        throw new ImapError(authish ? 401 : 502, `mail server refused: ${msg || rest}`);
      }
      out.push(line);
    }
  }

  /** APPEND with a literal body: wait for the "+" continuation first. */
  async append(tag: string, folder: string, raw: string) {
    const bytes = Buffer.byteLength(raw, "utf8");
    this.write(`${tag} APPEND ${qstr(folder)} {${bytes}}\r\n`);
    const cont = await this.readLine();
    if (!cont.startsWith("+")) throw new ImapError(502, `mail server refused APPEND: ${cont.slice(0, 80)}`);
    this.write(raw);
    const out: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (/^OK\b/i.test(line.slice(tag.length + 1))) return;
        throw new ImapError(502, `APPEND failed: ${line.slice(0, 120)}`);
      }
      out.push(line);
    }
  }

  close() {
    try { this.write("a999 LOGOUT\r\n"); } catch { /* already gone */ }
    try { this.sock.end(); } catch { /* already gone */ }
  }
}

function qstr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Connect + LOGIN. Caller owns the connection. `insecure` is for the local
 *  test fake only — real mail servers are always reached over implicit TLS. */
async function connectAndLogin(a: ImapAccount, insecure = false): Promise<Conn> {
  const conn = new Conn();
  await conn.open(a.host, a.port, !insecure);
  const greet = await conn.readLine();
  if (!/^\* OK/i.test(greet)) { conn.close(); throw new ImapError(502, `mail server did not greet properly: ${greet.slice(0, 80)}`); }
  try {
    await conn.cmd("a001", `LOGIN ${qstr(a.user)} ${qstr(a.pass)}`);
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
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

/** Validate credentials and folder access without changing anything. */
export async function testImap(a: ImapAccount): Promise<void> {
  const conn = await connectAndLogin(a);
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

/** RFC 2047 encoded-word decoding for subjects. */
export function decodeHeader(v: string): string {
  return String(v ?? "").replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") {
        return new TextDecoder(cs || "utf-8").decode(Buffer.from(String(text), "base64"));
      }
      const bytes: number[] = [];
      const s = String(text);
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "_") { bytes.push(0x20); continue; }
        if (c === "=" && i + 2 < s.length) {
          const h = parseInt(s.slice(i + 1, i + 3), 16);
          if (!Number.isNaN(h)) { bytes.push(h); i += 2; continue; }
        }
        bytes.push(c.charCodeAt(0));
      }
      return new TextDecoder(cs || "utf-8").decode(new Uint8Array(bytes));
    } catch { return String(text); }
  });
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

/** Two-way sync for one member. Never throws — errors land in the result.
 *  `opts.insecure` talks plain TCP and exists for the local test fake only. */
export async function syncImapAccount(memberId: number, opts: { insecure?: boolean } = {}): Promise<SyncResult> {
  const db = getDb();
  const result: SyncResult = { pushed: 0, pulled: 0, deleted: 0, errors: [] };
  const acct = db.query("SELECT * FROM imap_accounts WHERE member_id = ?").get(memberId) as any;
  if (!acct) { result.errors.push("IMAP not configured."); return result; }
  const cfg: ImapAccount = {
    host: acct.host, port: acct.port || 993,
    user: acct.username, pass: acct.password, folder: acct.folder || "Notes",
  };
  const conn = await connectAndLogin(cfg, !!opts.insecure).catch((e: any) => {
    const msg = String((e && e.message) || e).slice(0, 200);
    try { db.query("UPDATE imap_accounts SET last_error = ? WHERE member_id = ?").run(msg, memberId); } catch { /* db gone */ }
    result.errors.push(msg);
    return null;
  });
  if (!conn) return result;
  try {
    await selectOrCreate(conn, cfg.folder);
    const remote = await listMessages(conn);
    const byAbbaId = new Map<string, RemoteMsg>();
    for (const m of remote) if (m.abbaId && !m.flags.includes("\\Deleted")) byAbbaId.set(m.abbaId, m);
    const notes = db.query("SELECT * FROM notes WHERE member_id = ?").all(memberId) as any[];
    const noteIds = new Set(notes.map((n) => "note-" + n.id));
    const matchedUids = new Set<number>();

    // push new / changed notes; pull messages that are newer
    for (const n of notes) {
      const abbaId = "note-" + n.id;
      const m = byAbbaId.get(abbaId);
      const tags = JSON.parse(n.tags || "[]");
      if (!m) {
        await conn.append("a020", cfg.folder, buildMessage({ ...n, tags }));
        result.pushed++;
        continue;
      }
      matchedUids.add(m.uid);
      const noteMs = Date.parse(n.updated_at) || 0;
      if (noteMs - m.dateMs > 2000) {
        await conn.cmd("a021", `UID STORE ${m.uid} +FLAGS (\\Deleted)`);
        await conn.append("a022", cfg.folder, buildMessage({ ...n, tags }));
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
      const r = db.query(`INSERT INTO notes (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(memberId, p.subject || "Untitled", p.body, JSON.stringify(p.tags),
          STATUSES.includes(p.status as any) ? p.status : "seed", readMins(p.body), t, t);
      const newId = Number(r.lastInsertRowid);
      await conn.cmd("a023", `UID STORE ${m.uid} +FLAGS (\\Deleted)`);
      await conn.append("a024", cfg.folder, buildMessage({
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
    db.query("UPDATE imap_accounts SET last_sync_at = ?, last_error = '' WHERE member_id = ?").run(nowIso(), memberId);
  } catch (e: any) {
    const msg = String((e && e.message) || e).slice(0, 200);
    try { db.query("UPDATE imap_accounts SET last_error = ? WHERE member_id = ?").run(msg, memberId); } catch { /* db gone */ }
    result.errors.push(msg);
  } finally {
    conn.close();
  }
  return result;
}
