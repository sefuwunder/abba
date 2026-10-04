// Abba's copy of Relay's minimal zero-dependency IMAP client over Bun TLS sockets.
// (originally relay/src/imap.ts; kept in sync by hand when Relay's changes)
// Abba divergence: onData decodes as UTF-8 instead of latin1 — note bodies
// are UTF-8, and IMAP protocol lines are ASCII so this is safe.
// Supports: implicit TLS connect (port 993 default), LOGIN, SELECT INBOX,
// UID SEARCH FLAGGED (starred = \Flagged), UID FETCH of UID + INTERNALDATE +
// ENVELOPE, plus a best-effort BODY.PEEK[TEXT]<0.2048> snippet. Tagged and
// untagged responses, literal strings ({N} CRLF) and nested parenthesized
// lists are parsed. A `secure: false` option exists for the local test stub
// only — real mail servers are always reached over implicit TLS.

export class ImapError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

/**
 * Re-throw a read timeout naming what we were waiting for, so "Last error"
 * pinpoints the stall (greeting? LOGIN? FETCH?) instead of a bare timeout.
 */
export function timeoutContext(e: any, waitingFor: string): any {
  if (isTimeoutError(e)) {
    return new ImapError(0, `mail server timed out ${waitingFor}`);
  }
  return e;
}

/** True when e is our own read-timeout (status 0), as opposed to a refusal. */
export function isTimeoutError(e: any): boolean {
  return e instanceof ImapError && e.status === 0 && /timed out/i.test(e.message);
}

export interface ImapConfig {
  host: string;
  port?: number; // default 993
  user: string;
  pass: string;
  secure?: boolean; // default true; false = plain TCP (test stub only)
}

export interface StarredMail {
  uid: string;
  from: string;
  subject: string;
  date: string; // YYYY-MM-DD (calendar day of the message)
  snippet: string;
}

const READ_TIMEOUT_MS = 30000;
// (text fetch sizing lives with fetchSnippets as TEXT_FETCH_BYTES)

// ---------- RFC 2047 encoded-word decoding (=?UTF-8?Q?...?= / =?UTF-8?B?...?=) ----------
function decodeQ(s: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "_") { bytes.push(0x20); continue; }
    if (c === "=" && i + 2 < s.length) {
      const h = parseInt(s.slice(i + 1, i + 3), 16);
      if (!Number.isNaN(h)) { bytes.push(h); i += 2; continue; }
    }
    bytes.push(c.charCodeAt(0));
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}
export function decodeHeader(v: string): string {
  return String(v ?? "").replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    try {
      if (enc.toUpperCase() === "B") {
        const bin = Buffer.from(String(text), "base64");
        return new TextDecoder(cs || "utf-8").decode(bin);
      }
      return decodeQ(String(text), String(cs));
    } catch {
      return String(text);
    }
  });
}

// ---------- tiny IMAP list parser ----------
// Parses atoms, quoted strings ("a\"b"), NIL, parenthesized lists, and
// literals (already merged into the line as {N}CRLF<payload>). Returns the
// value plus the unconsumed remainder.
export function parseImapValue(s: string): [any, string] {
  s = s.replace(/^\s+/, "");
  if (!s) return [null, ""];
  const c = s[0];
  if (c === "(") {
    const out: any[] = [];
    let rest = s.slice(1);
    for (;;) {
      rest = rest.replace(/^\s+/, "");
      if (!rest) break; // unbalanced — best effort
      if (rest[0] === ")") return [out, rest.slice(1)];
      const [v, r] = parseImapValue(rest);
      out.push(v);
      rest = r;
    }
    return [out, rest];
  }
  if (c === '"') {
    let i = 1, acc = "";
    while (i < s.length) {
      if (s[i] === "\\" && i + 1 < s.length) { acc += s[i + 1]; i += 2; continue; }
      if (s[i] === '"') return [acc, s.slice(i + 1)];
      acc += s[i]; i++;
    }
    return [acc, ""];
  }
  const m = s.match(/^(NIL|\d+|[^\s()"\]]+)/i);
  if (m) {
    const tok = m[1];
    if (/^NIL$/i.test(tok)) return [null, s.slice(m[0].length)];
    if (/^\d+$/.test(tok)) return [Number(tok), s.slice(m[0].length)];
    return [tok, s.slice(m[0].length)];
  }
  return [null, s.slice(1)];
}

function addrText(addr: any[]): string {
  // address = (display-name route mailbox host)
  if (!Array.isArray(addr)) return "";
  const [name, , mailbox, host] = addr;
  const email = mailbox && host ? `${mailbox}@${host}` : String(mailbox || "");
  const n = decodeHeader(String(name || ""));
  return n && email && n !== email ? `${n} <${email}>` : email;
}

// INTERNALDATE "15-Sep-2026 10:23:45 +0000" → "2026-09-15"
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
export function internalDateToIso(d: string): string {
  const m = String(d || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return "";
  const mon = MONTHS[m[2].slice(0, 1).toUpperCase() + m[2].slice(1).toLowerCase()];
  if (mon === undefined) return "";
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** INTERNALDATE → full ISO UTC timestamp ("2026-09-17T12:00:00Z"); "" when unparseable. */
export function internalDateTimeToIso(d: string): string {
  const m = String(d || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return internalDateToIso(d);
  const mon = MONTHS[m[2].slice(0, 1).toUpperCase() + m[2].slice(1).toLowerCase()];
  if (mon === undefined) return internalDateToIso(d);
  return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// ---------- connection ----------

export class Conn {
  private buf = Buffer.alloc(0);
  private lines: string[] = [];
  private wake: (() => void) | null = null;
  private closedErr: Error | null = null;
  private sock: any = null;

  async open(host: string, port: number, secure: boolean) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new ImapError(0, `mail server not reachable (${host}:${port}) — timed out`)); }
      }, READ_TIMEOUT_MS);
      const self = this;
      const pending: any = Bun.connect({
        hostname: host,
        port,
        tls: secure,
        socket: {
          open(sock: any) {
            self.sock = sock;
            if (!settled) { settled = true; clearTimeout(timer); resolve(); }
          },
          data(_s: any, data: Buffer) {
            self.onData(data);
          },
          error(_s: any, err: Error) {
            if (!settled) { settled = true; clearTimeout(timer); reject(new ImapError(0, `mail server not reachable (${host}:${port}) — ${err.message}`)); }
            else self.onClose(err);
          },
          close() {
            self.onClose(new Error("connection closed by server"));
          },
        },
      });
      // Bun.connect's returned promise rejects on hard failures (e.g.
      // ECONNREFUSED) that never reach the socket error callback.
      if (pending && typeof pending.catch === "function") {
        pending.catch((err: Error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new ImapError(0, `mail server not reachable (${host}:${port}) — ${err.message || "connection failed"}`));
          }
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

  async readLine(timeoutMs: number = READ_TIMEOUT_MS): Promise<string> {
    for (;;) {
      if (this.lines.length) return this.lines.shift()!;
      if (this.closedErr) throw new ImapError(0, this.closedErr.message);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = null;
          reject(new ImapError(0, "mail server timed out waiting for a reply"));
        }, timeoutMs);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  write(s: string | Buffer) {
    this.sock.write(s as any);
  }

  /** Send one tagged command; return the response lines through the tagged OK. */
  async cmd(tag: string, command: string, timeoutMs: number = READ_TIMEOUT_MS): Promise<string[]> {
    this.write(`${tag} ${command}\r\n`);
    const out: string[] = [];
    for (;;) {
      let line: string;
      try {
        line = await this.readLine(timeoutMs);
      } catch (e: any) {
        throw timeoutContext(e, `waiting for a reply to ${command.split(/\s+/)[0] || "command"} (${tag})`);
      }
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

  close() {
    try { this.write("a999 LOGOUT\r\n"); } catch { /* already gone */ }
    try { this.sock.end(); } catch { /* already gone */ }
  }
}

function cfgOk(c: ImapConfig): ImapConfig {
  const host = String(c.host || "").trim();
  const user = String(c.user || "").trim();
  if (!host) throw new ImapError(400, "mail host is required");
  if (!user) throw new ImapError(400, "mail username is required");
  if (!c.pass) throw new ImapError(400, "mail password is required");
  return {
    host,
    port: c.port && Number(c.port) > 0 ? Number(c.port) : 993,
    user,
    pass: String(c.pass),
    secure: c.secure !== false,
  };
}

/** Connect and log in without selecting a mailbox. */
export async function connectAndLogin(cfg0: ImapConfig): Promise<{ conn: Conn; cfg: ImapConfig }> {
  const cfg = cfgOk(cfg0);
  const conn = new Conn();
  await conn.open(cfg.host, cfg.port!, cfg.secure!);
  let greet: string;
  try {
    greet = await conn.readLine();
  } catch (e: any) {
    throw timeoutContext(e, "waiting for the server greeting");
  }
  if (!/^\* OK/i.test(greet)) {
    conn.close();
    throw new ImapError(502, `mail server did not greet properly: ${greet.slice(0, 80)}`);
  }
  try {
    await conn.cmd("a001", `LOGIN ${qstr(cfg.user)} ${qstr(cfg.pass)}`);
  } catch (e) {
    conn.close();
    throw e;
  }
  return { conn, cfg };
}

/** Connect, log in, select a mailbox (INBOX by default). Returns the open connection. */
async function login(cfg0: ImapConfig, mailbox = "INBOX"): Promise<Conn> {
  const { conn } = await connectAndLogin(cfg0);
  try {
    await conn.cmd("a002", `SELECT ${qstr(mailbox)}`);
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
}

export function qstr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Validate credentials: log in and SELECT INBOX, then disconnect. */
export async function validateImap(cfg: ImapConfig): Promise<{ ok: true }> {
  const conn = await login(cfg);
  conn.close();
  return { ok: true };
}

export function parseSearchUids(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\* SEARCH\s*(.*)$/i);
    if (m && m[1].trim()) out.push(...m[1].trim().split(/\s+/));
  }
  return out;
}

// Fetch envelopes for a batch of UIDs; returns partial results on parse issues.
export interface MailEnvelope {
  from: string; subject: string; date: string; messageId: string;
  /** Recipient emails from the envelope to/cc lists. */
  to: string[];
  /** Full INTERNALDATE timestamp as ISO UTC ("" when unparseable). */
  dateTime: string;
}
async function fetchEnvelopes(conn: Conn, tag: string, uids: string[]): Promise<Map<string, MailEnvelope>> {
  const out = new Map<string, MailEnvelope>();
  const lines = await conn.cmd(tag, `UID FETCH ${uids.join(",")} (UID INTERNALDATE ENVELOPE)`);
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const joined = cur.join("\r\n");
    const m = joined.match(/\* \d+ FETCH \((.*)\)$/s);
    cur = [];
    if (!m) return;
    const body = m[1].replace(/\n[^\n]*$/s, (tail) => tail); // keep literals attached
    const parts: Record<string, string> = {};
    // Split "KEY value" pairs at top level.
    let rest = body;
    while (rest.trim()) {
      const km = rest.match(/^\s*([A-Z.\[\]<>\d]+)\s*/i);
      if (!km) break;
      const key = km[1].toUpperCase();
      rest = rest.slice(km[0].length);
      if (rest.startsWith("{")) {
        const nm = rest.match(/^\{(\d+)\}\r?\n?/);
        if (!nm) break;
        const n = Number(nm[1]);
        parts[key] = rest.slice(nm[0].length, nm[0].length + n);
        rest = rest.slice(nm[0].length + n);
      } else {
        const [v, r] = parseImapValue(rest);
        parts[key] = v as any;
        rest = r;
      }
    }
    // ENVELOPE value arrives via parseImapValue as nested array (or string when literal-merged).
    const uid = String(parts["UID"] ?? "");
    if (!uid) return;
    let env = parts["ENVELOPE"];
    if (typeof env === "string") {
      const [v] = parseImapValue(env.trim());
      env = v;
    }
    let from = "", subject = "", date = "", messageId = "";
    let to: string[] = [];
    let dateTime = "";
    if (Array.isArray(env)) {
      subject = decodeHeader(String(env[1] ?? "")).trim();
      const fromList = env[2];
      if (Array.isArray(fromList)) from = fromList.map(addrText).filter(Boolean).join(", ");
      const internalDate = String(parts["INTERNALDATE"] ?? env[0] ?? "");
      date = internalDateToIso(internalDate);
      dateTime = internalDateTimeToIso(internalDate);
      // ENVELOPE = (date subject from sender reply-to to cc bcc in-reply-to message-id)
      if (typeof env[9] === "string" && env[9].toUpperCase() !== "NIL") messageId = env[9].trim();
      try { to = envelopeAddrs(env).map((a) => a.email); } catch { /* best effort */ }
    } else {
      const internalDate = String(parts["INTERNALDATE"] ?? "");
      date = internalDateToIso(internalDate);
      dateTime = internalDateTimeToIso(internalDate);
    }
    out.set(uid, { from, subject, date, messageId, to, dateTime });
  };
  for (const line of lines) {
    if (/^\* \d+ FETCH/i.test(line) && cur.length) flush();
    cur.push(line);
  }
  flush();
  return out;
}

// Best-effort text snippets; a failure here never fails the import.
// The fetch window is deliberately larger than the final snippet: multipart
// mail (e.g. Google Voice forwards) needs the whole text/plain part present
// to base64-decode cleanly.
const TEXT_FETCH_BYTES = 8192;
async function fetchSnippets(conn: Conn, tag: string, uids: string[], maxChars = 280): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const lines = await conn.cmd(tag, `UID FETCH ${uids.join(",")} (UID BODY.PEEK[TEXT]<0.${TEXT_FETCH_BYTES}>)`);
    let cur: string[] = [];
    const flush = () => {
      if (!cur.length) return;
      const joined = cur.join("\r\n");
      cur = [];
      const um = joined.match(/UID (\d+)/i);
      if (!um) return;
      // The literal payload is everything after the last {N}\n marker.
      const lm = joined.match(/\{(\d+)\}\n([\s\S]*)$/);
      let text = lm ? lm[2].slice(0, Number(lm[1])) : "";
      const mime = decodeMimeText(text);
      if (mime !== null) {
        text = mime;
      } else {
        // Strip a leading MIME header block when present.
        const hm = text.match(/\r?\n\r?\n/);
        if (hm) text = text.slice(hm.index! + hm[0].length);
      }
      text = stripGvFooter(text);
      text = text.replace(/\s+/g, " ").trim().slice(0, maxChars);
      if (text) out.set(um[1], text);
    };
    for (const line of lines) {
      if (/^\* \d+ FETCH/i.test(line) && cur.length) flush();
      cur.push(line);
    }
    flush();
  } catch {
    /* snippet fetch is optional — envelopes already succeeded */
  }
  return out;
}

/** Fetch up to maxChars of plain text for one UID; "" on any failure. */
async function fetchTextPlain(conn: Conn, tag: string, uid: string, maxChars: number): Promise<string> {
  try {
    const lines = await conn.cmd(tag, `UID FETCH ${uid} (UID BODY.PEEK[TEXT]<0.${maxChars}>)`);
    const joined = lines.join("\r\n");
    const lm = joined.match(/\{(\d+)\}\r?\n([\s\S]*)$/);
    let text = lm ? lm[2].slice(0, Number(lm[1])) : "";
    const mime = decodeMimeText(text);
    if (mime !== null) {
      text = mime;
    } else {
      const hm = text.match(/\r?\n\r?\n/);
      if (hm) text = text.slice(hm.index! + hm[0].length);
    }
    text = stripGvFooter(text);
    if (/<\/?(html|body|div|p|br|table|span)\b/i.test(text)) {
      text = text.replace(/<[^>]*>/g, " ");
      text = text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
    }
    return text.replace(/\s+/g, " ").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

/** Fetch up to maxChars of decoded plain text for one INBOX UID; "" on any failure. */
export async function fetchInboxBody(cfg0: ImapConfig, uid: string, maxChars = 4000): Promise<string> {
  const { conn } = await connectAndLogin(cfg0);
  try {
    await conn.cmd("r001", "SELECT INBOX");
    return await fetchTextPlain(conn, "r002", uid, maxChars);
  } finally {
    conn.close();
  }
}

/** ENVELOPE message-id for one INBOX UID; "" on any failure. */
export async function fetchInboxMessageId(cfg0: ImapConfig, uid: string): Promise<string> {
  const { conn } = await connectAndLogin(cfg0);
  try {
    await conn.cmd("q001", "SELECT INBOX");
    const envs = await fetchEnvelopes(conn, "q002", [uid]);
    return envs.get(uid)?.messageId || "";
  } catch {
    return "";
  } finally {
    conn.close();
  }
}

export interface EmailContext {
  mailbox: "inbox" | "sent";
  uid: string;
  messageId: string;
  from: string;
  subject: string;
  date: string; // ISO
  body: string; // plain text
  direction: "in" | "out";
}

/**
 * Newest email (inbox or sent) involving `email`, used to pre-populate an
 * empty conversation with the last email conversation. Read-only: SELECT/EXAMINE and
 * BODY.PEEK fetches never set \\Seen.
 */
export async function latestEmailWith(cfg0: ImapConfig, email: string, maxBodyChars = 1500): Promise<EmailContext | null> {
  const addr = (email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return null;
  const { conn } = await connectAndLogin(cfg0);
  try {
    const sentName = await findSentMailbox(conn).catch(() => null);
    const boxes: { name: string; kind: "inbox" | "sent" }[] = [{ name: "INBOX", kind: "inbox" }];
    if (sentName && sentName.toUpperCase() !== "INBOX") boxes.push({ name: sentName, kind: "sent" });
    let best: { kind: "inbox" | "sent"; box: string; uid: string; from: string; subject: string; date: string; messageId: string } | null = null;
    for (const box of boxes) {
      await conn.cmd("e001", `${box.kind === "inbox" ? "SELECT" : "EXAMINE"} ${qstr(box.name)}`);
      const uids = parseSearchUids(await conn.cmd("e002", `UID SEARCH OR FROM ${qstr(addr)} TO ${qstr(addr)}`));
      if (!uids.length) continue;
      const tail = uids.slice(-3);
      const envs = await fetchEnvelopes(conn, "e003", tail);
      for (const u of tail) {
        const e = envs.get(u);
        if (!e || !e.date) continue;
        if (!best || e.date >= best.date) {
          best = { kind: box.kind, box: box.name, uid: u, from: e.from, subject: e.subject, date: e.date, messageId: e.messageId };
        }
      }
    }
    if (!best) return null;
    await conn.cmd("e004", `${best.kind === "inbox" ? "SELECT" : "EXAMINE"} ${qstr(best.box)}`);
    const body = await fetchTextPlain(conn, "e005", best.uid, maxBodyChars);
    return {
      mailbox: best.kind, uid: best.uid, messageId: best.messageId,
      from: best.from, subject: best.subject, date: best.date, body,
      direction: extractEmail(best.from).toLowerCase() === addr ? "in" : "out",
    };
  } finally {
    conn.close();
  }
}

/**
 * Find emails by Message-ID across INBOX and the Sent mailbox. Read-only:
 * EXAMINE (never SELECT) and BODY.PEEK envelope fetches, so no flags change.
 * Message-IDs are stable across sessions, unlike UIDs, which makes this the
 * reliable way to re-locate mail we imported long ago. Returns a map from the
 * queried Message-ID to its sender + recipient envelope.
 */
export async function lookupEnvelopesByMessageId(
  cfg0: ImapConfig, messageIds: string[]
): Promise<Map<string, { from: string; to: string[] }>> {
  const out = new Map<string, { from: string; to: string[] }>();
  const ids = [...new Set(messageIds.map((s) => (s || "").replace(/[\r\n]+/g, "").trim()).filter(Boolean))];
  if (!ids.length) return out;
  const { conn } = await connectAndLogin(cfg0);
  try {
    const sentName = await findSentMailbox(conn).catch(() => null);
    const boxes = ["INBOX"];
    if (sentName && sentName.toUpperCase() !== "INBOX") boxes.push(sentName);
    let tag = 0;
    for (const box of boxes) {
      await conn.cmd(`mi${++tag}`, `EXAMINE ${qstr(box)}`);
      // One SEARCH per Message-ID on the same connection, then a single
      // batched envelope fetch for everything we found in this box.
      const hitToId = new Map<string, string>();
      for (const mid of ids) {
        if (out.has(mid)) continue; // already found in an earlier box
        const uids = parseSearchUids(await conn.cmd(`mi${++tag}`, `UID SEARCH HEADER Message-ID ${qstr(mid)}`));
        for (const u of uids.slice(0, 3)) hitToId.set(u, mid);
      }
      if (!hitToId.size) continue;
      const envs = await fetchEnvelopes(conn, `mi${++tag}`, [...hitToId.keys()]);
      for (const [u, mid] of hitToId) {
        const e = envs.get(u);
        if (!e || out.has(mid)) continue;
        out.set(mid, { from: e.from, to: e.to });
      }
    }
  } finally {
    conn.close();
  }
  return out;
}

// Batched Return-Path header fetch; best-effort like snippets. Used to spot
// Google Voice forwards via their stable bounce domain.
async function fetchReturnPaths(conn: Conn, tag: string, uids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const lines = await conn.cmd(tag, `UID FETCH ${uids.join(",")} (UID BODY.PEEK[HEADER.FIELDS (RETURN-PATH)])`);
    let cur: string[] = [];
    const flush = () => {
      if (!cur.length) return;
      const joined = cur.join("\r\n");
      cur = [];
      const um = joined.match(/UID (\d+)/i);
      if (!um) return;
      const lm = joined.match(/\{(\d+)\}\n([\s\S]*)$/);
      const text = lm ? lm[2].slice(0, Number(lm[1])) : "";
      const rm = text.match(/^return-path:\s*(\S+)/im);
      if (rm) out.set(um[1], rm[1]);
    };
    for (const line of lines) {
      if (/^\* \d+ FETCH/i.test(line) && cur.length) flush();
      cur.push(line);
    }
    flush();
  } catch {
    /* optional — callers fall back to From-address detection */
  }
  return out;
}

/** List starred (\\Flagged) messages in INBOX, newest first. */
export async function fetchStarred(cfg0: ImapConfig, limit = 200): Promise<StarredMail[]> {
  const conn = await login(cfg0);
  try {
    const uids = parseSearchUids(await conn.cmd("a003", "UID SEARCH FLAGGED"));
    if (!uids.length) return [];
    const picked = uids.slice(-Math.min(limit, 200));
    const envs = await fetchEnvelopes(conn, "a004", picked);
    const snips = await fetchSnippets(conn, "a005", picked);
    const mails: StarredMail[] = [];
    for (const uid of picked) {
      const e = envs.get(uid) || { from: "", subject: "", date: "" };
      mails.push({
        uid,
        from: e.from,
        subject: e.subject || "(no subject)",
        date: e.date,
        snippet: snips.get(uid) || "",
      });
    }
    return mails.reverse(); // newest first
  } finally {
    conn.close();
  }
}

export interface UnseenMail {
  uid: string;
  from: string;
  /** Recipient emails from the envelope to/cc lists — used to spot group threads. */
  to: string[];
  subject: string;
  date: string;
  snippet: string; // 280-char preview for list views
  body: string;    // fuller decoded text (4000 chars) for stored messages
  returnPath: string;
  messageId: string; // ENVELOPE message-id — used to thread SMS replies
}

/** Fetch UNSEEN messages from INBOX (oldest first), then mark them \Seen. */
export async function fetchUnseen(cfg0: ImapConfig, limit = 50): Promise<UnseenMail[]> {
  const conn = await login(cfg0);
  try {
    const uids = parseSearchUids(await conn.cmd("b001", "UID SEARCH UNSEEN"));
    if (!uids.length) return [];
    const picked = uids.slice(0, Math.min(limit, 50));
    const envs = await fetchEnvelopes(conn, "b002", picked);
    // One batched fetch sized for stored bodies (4000 chars); the 280-char
    // list preview is just a prefix of it. (The poller used to store the
    // 280-char snippet as the whole message body, truncating longer mail.)
    const bodies = await fetchSnippets(conn, "b003", picked, 4000);
    const rps = await fetchReturnPaths(conn, "b004", picked);
    const mails: UnseenMail[] = [];
    for (const uid of picked) {
      const e = envs.get(uid) || { from: "", subject: "", date: "", messageId: "", to: [] as string[], dateTime: "" };
      const body = bodies.get(uid) || "";
      mails.push({
        uid,
        from: e.from,
        to: e.to,
        subject: e.subject || "(no subject)",
        date: e.date,
        snippet: body.slice(0, 280),
        body,
        returnPath: rps.get(uid) || "",
        messageId: e.messageId || "",
      });
    }
    await conn.cmd("b005", `UID STORE ${picked.join(",")} +FLAGS (\\Seen)`);
    return mails;
  } finally {
    conn.close();
  }
}

/** Pull a bare email address out of "Name <addr>" or a raw address. */
export function extractEmail(from: string): string {
  const m = from.match(/<([^<>@\s]+@[^<>\s]+)>/);
  if (m) return m[1].toLowerCase();
  const m2 = from.match(/([^\s<>,;]+@[^\s<>,;]+)/);
  return (m2 ? m2[1] : from).toLowerCase().trim();
}

// ---------- sent-folder contact harvesting ----------

export interface HarvestedContact {
  name: string;
  email: string;
  count: number; // how many of the scanned sent mails went to them
}

export interface HarvestedSms {
  number: string;   // 10 digits
  name: string;     // sender name from the forward ("Acela"), "" when unknown
  count: number;    // messages in the window
  lastDate: string; // YYYY-MM-DD of the most recent one
  // Newest forward in the window — sending "replies" to it keeps the GV
  // gateway delivering (a fresh mail to the bare gateway address fails).
  replyTo: { messageId: string; from: string; subject: string } | null;
}

export interface SmsHarvest {
  conversations: HarvestedSms[];
  scanned: number; // inbox messages seen in the window (diagnostic)
}

/**
 * Most-recent Google Voice SMS conversations in INBOX over the last `days`.
 * GV forwards arrive as mail from {digits}@txt|mms.voice.google.com; ENVELOPE
 * fetches never set \Seen, so this is read-only and non-destructive.
 */
export async function harvestRecentSms(cfg0: ImapConfig, days = 14): Promise<SmsHarvest> {
  const conn = await login(cfg0); // SELECTs INBOX
  try {
    const d = new Date(Date.now() - days * 86400_000);
    const mon = Object.keys(MONTHS)[d.getMonth()];
    const since = `${String(d.getDate()).padStart(2, "0")}-${mon}-${d.getFullYear()}`;
    const uids = parseSearchUids(await conn.cmd("s001", `UID SEARCH SINCE ${since}`));
    if (!uids.length) return { conversations: [], scanned: 0 };
    const picked = uids.slice(-500);
    const envs = await fetchEnvelopes(conn, "s002", picked);
    const rps = await fetchReturnPaths(conn, "s003", picked);
    const agg = new Map<string, { name: string; count: number; last: string; replyTo: { messageId: string; from: string; subject: string } | null }>();
    for (const uid of picked) {
      const e = envs.get(uid);
      if (!e) continue;
      const num = gvNumberFrom(e.from || "", e.subject || "", rps.get(uid) || "");
      if (!num) continue;
      const nm = gvSenderName(e.from || "", e.subject || "");
      const replyTo = e.messageId ? { messageId: e.messageId, from: e.from || "", subject: e.subject || "" } : null;
      const cur = agg.get(num);
      if (cur) {
        if (nm && e.date >= cur.last) cur.name = nm;
        cur.count++;
        if (e.date > cur.last) { cur.last = e.date; if (replyTo) cur.replyTo = replyTo; }
      } else agg.set(num, { name: nm, count: 1, last: e.date, replyTo });
    }
    return {
      conversations: [...agg.entries()]
        .map(([number, v]) => ({ number, name: v.name, count: v.count, lastDate: v.last, replyTo: v.replyTo }))
        .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.count - a.count),
      scanned: picked.length,
    };
  } finally {
    conn.close();
  }
}

export interface GvThreadHead {
  messageId: string;
  from: string;    // composite forward address, original case
  subject: string;
}

/**
 * Newest Google Voice forward for one 10-digit number in the last `days`.
 * Read-only (ENVELOPE fetches never set \\Seen). Used at SMS send time so the
 * outbound message is always a reply to the previous thread — the GV gateway
 * drops fresh mail to the bare gateway address.
 */
export async function latestGvForward(cfg0: ImapConfig, digits: string, days = 30): Promise<GvThreadHead | null> {
  if (!/^\d{10}$/.test(digits)) return null;
  const conn = await login(cfg0); // SELECTs INBOX
  try {
    const d = new Date(Date.now() - days * 86400_000);
    const mon = Object.keys(MONTHS)[d.getMonth()];
    const since = `${String(d.getDate()).padStart(2, "0")}-${mon}-${d.getFullYear()}`;
    const uids = parseSearchUids(await conn.cmd("t001", `UID SEARCH SINCE ${since}`));
    if (!uids.length) return null;
    const picked = uids.slice(-500);
    const envs = await fetchEnvelopes(conn, "t002", picked);
    const rps = await fetchReturnPaths(conn, "t003", picked);
    let best: GvThreadHead | null = null;
    let bestDate = "";
    for (const uid of picked) {
      const e = envs.get(uid);
      if (!e || !e.messageId || !e.from) continue;
      if (gvNumberFrom(e.from, e.subject || "", rps.get(uid) || "") !== digits) continue;
      if (!best || e.date >= bestDate) {
        best = { messageId: e.messageId, from: e.from, subject: e.subject || "" };
        bestDate = e.date;
      }
    }
    return best;
  } finally {
    conn.close();
  }
}

/** Find the sent mailbox: "Sent", "[Gmail]/Sent Mail", "Sent Items", … */
async function findSentMailbox(conn: Conn): Promise<string | null> {
  const lines = await conn.cmd("h002", 'LIST "" "*"');
  const names: string[] = [];
  for (const line of lines) {
    const rest = line.replace(/^\* LIST\s+/i, "");
    if (rest === line) continue;
    // Response shape: (flags) delimiter name
    const parts: any[] = [];
    let r = rest;
    for (let i = 0; i < 3 && r.trim(); i++) {
      const [v, nr] = parseImapValue(r);
      parts.push(v);
      r = nr;
    }
    if (typeof parts[2] === "string") names.push(parts[2]);
  }
  const tests: RegExp[] = [
    /^sent$/i,
    /^\[gmail\]\/sent mail$/i,
    /^sent (items|messages)$/i,
    /sent/i,
  ];
  for (const re of tests) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

function envelopeAddrs(env: any[]): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  // ENVELOPE = (date subject from sender reply-to to cc bcc in-reply-to message-id)
  for (const idx of [5, 6]) { // to, cc
    const list = env[idx];
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      if (!Array.isArray(a)) continue;
      const [rawName, , mailbox, host] = a;
      const email = mailbox && host ? `${mailbox}@${host}`.toLowerCase() : "";
      if (!email || !email.includes("@")) continue;
      out.push({ name: decodeHeader(String(rawName || "")).trim(), email });
    }
  }
  return out;
}

const SKIP_SENDERS = /^(noreply|no-reply|donotreply|mailer-daemon|postmaster)@/i;
const GV_HOST_RE = /^(?:txt|mms)\.voice\.google\.com$/i;
// Google Voice's bounce domain — stable even when Google changes the From format.
const GV_BOUNCE_RE = /@grandcentral\.bounces\.google\.com/i;

/**
 * Pull the sender's 10-digit number out of a Google Voice forward address.
 * Formats seen in the wild:
 *   12014720451.15139672841.X47VN2Z-g6@txt.voice.google.com  (own.sender.token)
 *   15553334444@txt.voice.google.com                         (11-digit)
 *   5551112222@txt.voice.google.com                          (10-digit)
 *   ... on txt. or mms.voice.google.com
 * Returns "" when the address is not a GV forward.
 */
export function parseGvNumber(rawFrom: string): string {
  const email = extractEmail(rawFrom).toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  if (!GV_HOST_RE.test(email.slice(at + 1))) return "";
  const parts = email.slice(0, at).split(".");
  const numParts = parts.filter((p) => /^\d{10,11}$/.test(p));
  // In the composite format the first numeric part is the account's own GV
  // number; the sender is the next one. Single-part formats take the part.
  const cand = numParts.find((p) => p !== parts[0]) || numParts[0] || "";
  const digits = cand.replace(/^1(\d{10})$/, "$1"); // strip US country code
  return /^\d{10}$/.test(digits) ? digits : "";
}

/**
 * Strip the Google Voice email footer from an inbound SMS body.
 * GV forwards arrive as e.g. "hey mom\n\nTo respond to this text message,
 * reply to this email or visit Google Voice. ... YOUR ACCOUNT
 * <https://voice.google.com> HELP CENTER <...> ..." — everything from the
 * "To respond to this text message" line on is boilerplate, not the message.
 */
export function stripGvFooter(body: string): string {
  const noLead = (body || "").replace(/^\s*<\s*https?:\/\/voice\.google\.com\s*>\s*/i, "");
  const noAccount = noLead.replace(/\s*YOUR ACCOUNT\s*<\s*https?:\/\/voice\.google\.com\s*>[\s\S]*$/i, "");
  return noAccount.replace(/\s*To respond to this text message[\s\S]*$/i, "").trim();
}

/**
 * Drop quoted reply history and signatures from an inbound email body.
 * Handles Gmail ("On ... wrote:") and Outlook ("-----Original Message-----"
 * / From:-Sent:-To:-Subject: blocks) quote headers, ">" quoted lines, and
 * "-- " signature delimiters. Returns the original when nothing new would
 * remain, so a fully-quoted body is never blanked.
 */
export function stripEmailQuotes(body: string): string {
  if (!body) return body;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .+ wrote:$/.test(l)) { end = i; break; } // Gmail quote header
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(l)) { end = i; break; } // Outlook
    if (/^_{10,}$/.test(l) && i > 0) { end = i; break; } // Outlook separator
    if (/^-- ?$/.test(l)) { end = i; break; } // signature delimiter
    if (/^From: \S/.test(l)) { // Outlook header block without the dashes line
      let j = i + 1, headers = 0;
      while (j < lines.length && /^(Sent|To|Cc|Date|Subject): /i.test(lines[j])) { headers++; j++; }
      if (headers >= 2) { end = i; break; }
    }
  }
  const kept0 = lines.slice(0, end).filter((l) => !/^\s*>/.test(l)).join("\n");
  let kept = kept0;
  if (end === lines.length) {
    // Jammed / single-line bodies: the Gmail header sits mid-line, e.g.
    // "...there. ABBYVIP On Tue, Sep 15, 2026 at 9:17 PM Sefu <s@x> wrote: > old".
    // Strict weekday form plus a ">" quote marker right after the header, so a
    // fresh "On Friday, she wrote: ..." sentence is never cut.
    const m = /\bOn (?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), .*? wrote:/.exec(kept);
    if (m && />/.test(kept.slice(m.index + m[0].length, m.index + m[0].length + 80))) {
      kept = kept.slice(0, m.index);
    }
  }
  const out = kept.replace(/\n{3,}/g, "\n\n").trim();
  return out || body;
}

/**
 * If `raw` is a MIME multipart (or carries part headers), extract the first
 * text/plain part and decode its Content-Transfer-Encoding (base64,
 * quoted-printable, 7bit/8bit passthrough). Returns null when no text/plain
 * part is present, so callers can fall back to treating `raw` as plain text.
 */
export function decodeMimeText(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let i = lines.findIndex((l) => /^content-type:\s*text\/plain/i.test(l));
  if (i < 0) return null;
  let encoding = "", charset = "utf-8";
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { i++; break; } // blank line: part headers end, body begins
    const em = l.match(/^content-transfer-encoding:\s*([^\s;]+)/i);
    if (em) encoding = em[1].toLowerCase();
    const cm = l.match(/^content-type:[^;]*;\s*charset="?([^"\s;]+)"?/i);
    if (cm) charset = cm[1].toLowerCase();
    if (/^content-type:/i.test(l)) return null; // ran into the next part: malformed
  }
  const bodyLines: string[] = [];
  for (; i < lines.length; i++) {
    if (/^--/.test(lines[i])) break; // MIME boundary
    bodyLines.push(lines[i]);
  }
  let text = bodyLines.join("\n");
  if (encoding === "base64") {
    try {
      text = Buffer.from(text.replace(/\s+/g, ""), "base64").toString(charset === "utf-8" || charset === "utf8" ? "utf-8" : "latin1");
    } catch { /* keep the raw text */ }
  } else if (encoding === "quoted-printable") {
    // A soft break (= at end of line, incl. the last line before the boundary).
    const noSoft = (text + "\n").replace(/=\r?\n/g, "");
    const bytes: number[] = [];
    noSoft.replace(/=([0-9A-Fa-f]{2})|([\s\S])/g, (_m, hex: string, ch: string) => {
      bytes.push(hex ? parseInt(hex, 16) : ch.charCodeAt(0) & 0xff);
      return "";
    });
    text = Buffer.from(bytes).toString("utf-8");
  }
  return text;
}

/** "New text message from Acela (513) 967-2841" -> "5139672841". */
function subjectPhone(subject: string): string {
  const m = subject.match(/\((\d{3})\)\s*(\d{3})[.-]?(\d{4})/);
  return m ? m[1] + m[2] + m[3] : "";
}

/**
 * Resolve the sender's 10-digit number for a Google Voice message.
 * Primary: the From address (composite own.sender.token or bare-digit formats).
 * Fallback: Google's GV bounce domain in Return-Path (survives From-format
 * changes) with the number taken from the subject line.
 */
export function gvNumberFrom(from: string, subject: string, returnPath: string): string {
  return parseGvNumber(from) || (GV_BOUNCE_RE.test(returnPath) ? subjectPhone(subject) : "");
}

/**
 * Google Voice missed-call notification: sent from voice-noreply@google.com
 * with subject "New missed call from <Name>." and a text body containing
 * "You missed a call from <Name> (<phone>)." Returns the caller name and the
 * normalized 10-digit phone, or null when the mail isn't such a notification.
 */
export function parseMissedCall(from: string, subject: string, body: string): { name: string; digits: string } | null {
  if (!(from || "").toLowerCase().includes("voice-noreply@google.com")) return null;
  if (!/^new missed call from\b/i.test(subject || "")) return null;
  const m = (body || "").match(/you missed a call from\s+(.+?)\s*\(?(\d{3})\)?[.\s-]*(\d{3})[.\s-]*(\d{4})/i);
  if (!m) return null;
  const digits = (m[2] + m[3] + m[4]).replace(/\D/g, "");
  if (digits.length !== 10) return null;
  const name = (m[1] || "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  return { name: name || "Unknown", digits };
}

/** Display name from an envelope addrText: `"Acela (SMS)" <...>` or `Acela (SMS) <...>` or "". */
function displayNameOf(addrText: string): string {
  const t = (addrText || "").trim();
  let m = t.match(/^\s*"([^"]*)"\s*</);
  if (m) return m[1].trim();
  m = t.match(/^\s*([^<]*?)\s*</);
  return m ? m[1].trim() : "";
}

/** Clean a GV sender name: drop the " (SMS)" tag; reject blanks and phone-like strings. */
function cleanGvName(n: string): string {
  const c = (n || "").replace(/\s*\(SMS\)\s*$/i, "").trim();
  if (!c || /^[\d\s()+.-]+$/.test(c)) return "";
  return c;
}

/** "New text message from Acela (513) 967-2841" -> "Acela". */
function subjectGvName(subject: string): string {
  const m = (subject || "").match(/\bfrom\s+(.+?)\s+\(\d{3}\)/i);
  return m ? cleanGvName(m[1]) : "";
}

/** Best sender name for a GV forward: display name first, then the subject line. */
function gvSenderName(from: string, subject: string): string {
  return cleanGvName(displayNameOf(from)) || subjectGvName(subject);
}

/**
 * Scan the last `limit` messages in the sent folder and aggregate the
 * recipients into contacts, most-emailed first. Excludes the user's own
 * addresses and obvious automated senders.
 */
export async function harvestSentContacts(
  cfg0: ImapConfig, limit = 40, selfEmails: string[] = []
): Promise<HarvestedContact[]> {
  const { conn } = await connectAndLogin(cfg0);
  try {
    const sent = await findSentMailbox(conn);
    if (!sent) throw new ImapError(502, "couldn't find a Sent folder in this mailbox");
    const sel = await conn.cmd("h003", `EXAMINE ${qstr(sent)}`);
    const ex = sel.map((l) => l.match(/^\* (\d+) EXISTS/i)).find(Boolean);
    const exists = ex ? Number(ex[1]) : 0;
    if (!exists) return [];
    const start = Math.max(1, exists - Math.min(limit, 200) + 1);
    const lines = await conn.cmd("h004", `FETCH ${start}:${exists} (ENVELOPE)`);
    const self = new Set(selfEmails.map((s) => s.toLowerCase().trim()).filter(Boolean));
    const agg = new Map<string, { name: string; count: number; order: number }>();
    let order = 0;
    const blocks: string[] = [];
    for (const line of lines) {
      if (/^\* \d+ FETCH/i.test(line)) blocks.push(line);
      else if (blocks.length) blocks[blocks.length - 1] += "\r\n" + line;
    }
    // Newest first so the first name we see for an address is the freshest.
    for (const block of blocks.reverse()) {
      const m = block.match(/ENVELOPE\s*/i);
      if (!m) continue;
      let rest = block.slice(m.index! + m[0].length).trim();
      const lm = rest.match(/^\{(\d+)\}\n?/);
      if (lm) rest = rest.slice(lm[0].length);
      const [env] = parseImapValue(rest);
      if (!Array.isArray(env)) continue;
      for (const a of envelopeAddrs(env)) {
        if (self.has(a.email) || SKIP_SENDERS.test(a.email)) continue;
        if (parseGvNumber(a.email)) continue; // phone numbers live in the SMS tab
        const cur = agg.get(a.email);
        if (cur) { cur.count++; }
        else agg.set(a.email, { name: a.name, count: 1, order: order++ });
      }
    }
    return [...agg.entries()]
      .map(([email, v]) => ({ name: v.name || email, email, count: v.count, _o: v.order }))
      .sort((a, b) => b.count - a.count || a._o - b._o)
      .map(({ name, email, count }) => ({ name, email, count }));
  } finally {
    conn.close();
  }
}

// ---------- sent-mail import ----------

export interface SentMailItem {
  uid: string;
  /** Recipient emails from the envelope to/cc lists. */
  to: string[];
  subject: string;
  /** ISO timestamp from INTERNALDATE (falls back to the envelope date). */
  date: string;
  /** Full INTERNALDATE timestamp as ISO UTC ("" when unparseable). */
  dateTime: string;
  messageId: string;
  /** Plain-text snippet, up to 4000 chars. */
  body: string;
}

/**
 * List sent mail newer than `lastUid` (UID watermark), or — on the first run
 * (`lastUid == null`) — everything since `backfillDays` ago. Returns the
 * mailbox that was scanned, the items (newest `max` only, to bound the first
 * backfill), and the highest UID seen so the caller can advance its watermark.
 * Read-only: EXAMINE never sets flags.
 */
export async function fetchSentMail(
  cfg0: ImapConfig,
  lastUid: number | null,
  opts: { backfillDays?: number; max?: number } = {}
): Promise<{ mailbox: string | null; items: SentMailItem[]; maxUid: number | null }> {
  const backfillDays = opts.backfillDays ?? 90;
  const max = Math.min(opts.max ?? 200, 500);
  const { conn } = await connectAndLogin(cfg0);
  try {
    const sent = await findSentMailbox(conn);
    if (!sent) return { mailbox: null, items: [], maxUid: null };
    await conn.cmd("s001", `EXAMINE ${qstr(sent)}`);
    let uids: string[];
    if (lastUid !== null && Number.isFinite(lastUid)) {
      uids = parseSearchUids(await conn.cmd("s002", `UID SEARCH UID ${Math.floor(lastUid) + 1}:*`));
    } else {
      const d = new Date(Date.now() - backfillDays * 86400_000);
      const mon = Object.keys(MONTHS)[d.getMonth()];
      const since = `${String(d.getDate()).padStart(2, "0")}-${mon}-${d.getFullYear()}`;
      uids = parseSearchUids(await conn.cmd("s002", `UID SEARCH SINCE ${since}`));
    }
    if (!uids.length) return { mailbox: sent, items: [], maxUid: lastUid };
    const maxUid = Math.max(...uids.map(Number));
    const picked = uids.slice(-max);
    const envs = await fetchEnvelopes(conn, "s003", picked);
    const bodies = await fetchSnippets(conn, "s004", picked, 4000);
    const items: SentMailItem[] = [];
    for (const uid of picked) {
      const e = envs.get(uid);
      if (!e) continue;
      items.push({
        uid,
        to: e.to,
        subject: e.subject || "(no subject)",
        date: e.dateTime || e.date,
        dateTime: e.dateTime,
        messageId: e.messageId || "",
        body: bodies.get(uid) || "",
      });
    }
    return { mailbox: sent, items, maxUid };
  } finally {
    conn.close();
  }
}

// ---------- inbound attachment extraction ----------

export interface InboundAttachment {
  filename: string;
  mime: string;
  /** Raw file bytes. */
  data: Buffer;
}

/** Don't fetch full bodies over this size (mirrors the 25 MB send limit, with headroom). */
export const INBOUND_FETCH_MAX = 30 * 1024 * 1024;
/** Per-file cap for inbound attachments, matching the outbound limit. */
export const INBOUND_FILE_MAX = 25 * 1024 * 1024;
/** Max attachments kept per inbound message, matching the outbound limit. */
export const INBOUND_FILES_PER_MESSAGE = 10;

function splitHeadBody(raw: string): { head: string; body: string } {
  const m = raw.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { head: raw, body: "" };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Unfold continuation lines; keys lowercased. Repeated headers are joined. */
function headerMap(head: string): Map<string, string> {
  const map = new Map<string, string>();
  let cur = "";
  for (const rawLine of head.split(/\r?\n/)) {
    const line = rawLine;
    if (/^[ \t]/.test(line) && cur) { map.set(cur, map.get(cur)! + " " + line.trim()); continue; }
    const hm = line.match(/^([^:]+):\s*([\s\S]*)$/);
    if (hm) {
      cur = hm[1].toLowerCase();
      map.set(cur, (map.get(cur) ? map.get(cur)! + " " : "") + hm[2].trim());
    }
  }
  return map;
}

/** Parse `;`-separated header params, honoring quoted strings. Keys lowercased. */
function parseParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  const sc = value.indexOf(";");
  if (sc < 0) return params;
  let rest = value.slice(sc + 1);
  for (;;) {
    rest = rest.replace(/^\s*;?\s*/, "");
    if (!rest) break;
    const nm = rest.match(/^([^*=\s;]+(?:\*\d+\*?)?\*?)\s*=\s*/);
    if (!nm) break;
    const name = nm[1].toLowerCase();
    rest = rest.slice(nm[0].length);
    let val: string;
    if (rest[0] === '"') {
      let i = 1, acc = "";
      while (i < rest.length) {
        if (rest[i] === "\\" && i + 1 < rest.length) { acc += rest[i + 1]; i += 2; continue; }
        if (rest[i] === '"') { i++; break; }
        acc += rest[i]; i++;
      }
      val = acc; rest = rest.slice(i);
    } else {
      const vm = rest.match(/^[^;]*/);
      val = (vm ? vm[0] : "").trim(); rest = rest.slice(val.length);
    }
    params.set(name, val);
  }
  return params;
}

function decodeRfc2231(v: string): string {
  const m = v.match(/^([^']*)'[^']*'(.*)$/s);
  const charset = (m && m[1] ? m[1] : "utf-8").toLowerCase();
  const enc = m ? m[2] : v;
  const bytes: number[] = [];
  for (let i = 0; i < enc.length; i++) {
    const c = enc[i];
    if (c === "%" && i + 2 < enc.length && /^[0-9A-Fa-f]{2}$/.test(enc.slice(i + 1, i + 3))) {
      bytes.push(parseInt(enc.slice(i + 1, i + 3), 16)); i += 2;
    } else bytes.push(c.charCodeAt(0) & 0xff);
  }
  try { return new TextDecoder(charset).decode(Buffer.from(bytes)); }
  catch { return Buffer.from(bytes).toString("latin1"); }
}

/** RFC 2231 continuations: filename*0*, filename*1*, ... (or plain numbered). */
function continuationValue(params: Map<string, string>, base: string): string | null {
  const parts: string[] = [];
  for (let i = 0; ; i++) {
    if (params.has(`${base}*${i}*`)) { parts.push(params.get(`${base}*${i}*`)!); continue; }
    if (params.has(`${base}*${i}`)) { parts.push(params.get(`${base}*${i}`)!); continue; }
    break;
  }
  if (!parts.length) return null;
  return decodeRfc2231(parts.join(""));
}

function stripQuotes(v: string): string {
  return v.replace(/^"(.*)"$/s, "$1");
}

/** Best-effort filename from Content-Disposition, falling back to Content-Type name. */
function attachmentFilename(disp: string, ctype: string): string {
  const dp = parseParams(disp || "");
  const cp = parseParams(ctype || "");
  return continuationValue(dp, "filename")
    ?? (dp.has("filename*") ? decodeRfc2231(dp.get("filename*")!) : null)
    ?? (dp.has("filename") ? decodeHeader(stripQuotes(dp.get("filename")!)) : null)
    ?? continuationValue(cp, "name")
    ?? (cp.has("name*") ? decodeRfc2231(cp.get("name*")!) : null)
    ?? (cp.has("name") ? decodeHeader(stripQuotes(cp.get("name")!)) : null)
    ?? "";
}

function decodeQuotedPrintable(s: string): Buffer {
  // A trailing "=" is a soft break whose CRLF was consumed by part splitting
  // (a literal "=" is always =3D-encoded, so this is unambiguous).
  const noSoft = s.replace(/=\r?\n/g, "").replace(/=$/, "");
  const bytes: number[] = [];
  noSoft.replace(/=([0-9A-Fa-f]{2})|([\s\S])/g, (_m, hex: string, ch: string) => {
    bytes.push(hex ? parseInt(hex, 16) : ch.charCodeAt(0) & 0xff);
    return "";
  });
  return Buffer.from(bytes);
}

function decodePartBody(body: string, encoding: string): Buffer {
  const enc = (encoding || "7bit").toLowerCase();
  if (enc === "base64") {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64"); }
    catch { return Buffer.alloc(0); }
  }
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(body, "latin1");
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const delim = "--" + boundary;
  let cur: string[] | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === delim) { if (cur) parts.push(cur.join("\r\n")); cur = []; }
    else if (line === delim + "--") { if (cur) parts.push(cur.join("\r\n")); cur = null; break; }
    else if (cur) cur.push(rawLine);
  }
  return parts;
}

function walkPart(raw: string, out: InboundAttachment[], depth: number): void {
  if (depth > 8) return;
  const { head, body } = splitHeadBody(raw);
  const h = headerMap(head);
  const ctype = h.get("content-type") || "text/plain";
  const mime = ctype.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  if (mime.startsWith("multipart/")) {
    const boundary = parseParams(ctype).get("boundary");
    if (!boundary) return;
    for (const part of splitMultipart(body, stripQuotes(boundary))) walkPart(part, out, depth + 1);
    return;
  }
  const filename = attachmentFilename(h.get("content-disposition") || "", ctype).trim();
  if (!filename) return;
  const data = decodePartBody(body, h.get("content-transfer-encoding") || "");
  if (!data.length) return;
  out.push({ filename: filename.slice(0, 120), mime: mime.slice(0, 120), data });
}

/**
 * Extract file attachments from a raw RFC 5322 message. Only parts carrying
 * a filename are returned (inline body text is never treated as a file).
 * Pure function — unit-testable without a network.
 */
export function parseMailAttachments(raw: string): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  try { walkPart(raw, out, 0); } catch { /* malformed mail: best effort */ }
  return out;
}

/** Pull the literal payload out of a `BODY[] {N}` FETCH response. */
function extractLiteral(lines: string[]): string {
  for (const line of lines) {
    const m = line.match(/FETCH[\s\S]*?\{(\d+)\}\n([\s\S]*)$/i);
    if (m) return m[2].slice(0, Number(m[1]));
  }
  return "";
}

/**
 * Fetch attachments for the given UIDs in `mailbox` (one IMAP connection).
 * Messages over INBOUND_FETCH_MAX are skipped; per message at most
 * INBOUND_FILES_PER_MESSAGE files of at most INBOUND_FILE_MAX bytes are
 * returned. A failure on one message never fails the batch.
 */
export async function fetchMailAttachments(cfg0: ImapConfig, uids: string[], mailbox = "INBOX"): Promise<Map<string, InboundAttachment[]>> {
  const out = new Map<string, InboundAttachment[]>();
  if (!uids.length) return out;
  const conn = await login(cfg0, mailbox);
  try {
    const sizes = new Map<string, number>();
    try {
      for (const line of await conn.cmd("c001", `UID FETCH ${uids.join(",")} (UID RFC822.SIZE)`)) {
        const m = line.match(/UID (\d+)[\s\S]*?RFC822\.SIZE (\d+)/i);
        if (m) sizes.set(m[1], Number(m[2]));
      }
    } catch { /* size gate is advisory */ }
    for (const uid of uids) {
      try {
        const size = sizes.get(uid);
        if (size !== undefined && (size <= 0 || size > INBOUND_FETCH_MAX)) continue;
        const lines = await conn.cmd("c002", `UID FETCH ${uid} (UID BODY.PEEK[])`);
        const raw = extractLiteral(lines);
        if (!raw) continue;
        const atts = parseMailAttachments(raw)
          .filter((a) => a.data.length <= INBOUND_FILE_MAX)
          .slice(0, INBOUND_FILES_PER_MESSAGE);
        if (atts.length) out.set(uid, atts);
      } catch { /* one bad message never kills the batch */ }
    }
  } finally {
    conn.close();
  }
  return out;
}
