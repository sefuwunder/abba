// share.ts — sharing notes through IMAP.
//
// Abba has no accounts, no invite codes, no peer-to-peer mesh. Sharing is
// email: a note is sent as a message with X-Abba-Share headers through the
// user's own mail account (SMTP). "Inviting" someone is just sharing a note
// with them — the email is the invite.
//
// Incoming: scan INBOX for X-Abba-Share messages and import them into the
// "shared with me" shelf (shared_notes). Seen messages are tracked by
// Message-ID so re-scans are idempotent.
import { getDb, nowIso, randomShareId } from "./db.ts";
import { connectAndLogin, qstr, decodeHeader, decodeMimeText, extractEmail, type Conn } from "./imap.ts";
import { sendMail, SmtpError } from "./smtp.ts";

export interface ImapAccountRow {
  host: string; port: number; username: string; password: string; folder: string;
  smtp_host: string; smtp_port: number;
  last_sync_at?: string; last_error?: string; last_share_scan_at?: string;
}

export function getImapAccount(): ImapAccountRow | null {
  return getDb().query(`SELECT host, port, username, password, folder, smtp_host, smtp_port,
    last_sync_at, last_error, last_share_scan_at
    FROM imap_account WHERE id = 1`).get() as any || null;
}

/** Guess the SMTP host from the IMAP host (imap.x -> smtp.x); explicit setting wins. */
export function smtpHostFor(a: ImapAccountRow): string {
  if (a.smtp_host.trim()) return a.smtp_host.trim();
  return a.host.replace(/^imap\./i, "smtp.");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validEmail(s: string): boolean {
  return EMAIL_RE.test(String(s || "").trim());
}

export interface ShareDraft {
  subject: string;
  body: string;
  headers: Record<string, string>;
}

/** Compose the share email for a note. */
export function composeShare(note: { id: number; title: string; body: string }, fromEmail: string): ShareDraft {
  const shareId = randomShareId();
  const title = note.title || "Untitled note";
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  return {
    subject: `[Abba] ${title}`,
    body:
      `${title}\n${date}\n\n` +
      `${note.body.trim()}\n\n` +
      `---\nShared from Abba, a quiet notepad.`,
    headers: {
      "X-Abba-Share": "1",
      "X-Abba-Id": shareId,
      "X-Abba-From": fromEmail,
    },
  };
}

/**
 * Share a note with email recipients. Sends via SMTP using the IMAP
 * account's credentials and records the share. Throws on validation or
 * SMTP errors (nothing is recorded unless the send succeeds).
 */
export async function shareNote(noteId: number, recipients: string[], opts: { insecure?: boolean } = {}): Promise<{ sent: number }> {
  const db = getDb();
  const note = db.query(`SELECT id, title, body FROM notes WHERE id = ?`).get(noteId) as any;
  if (!note) throw new SmtpError(400, "note not found");
  const emails = [...new Set(recipients.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new SmtpError(400, "no recipients");
  const bad = emails.filter((e) => !validEmail(e));
  if (bad.length) throw new SmtpError(400, `not an email address: ${bad[0]}`);
  const acct = getImapAccount();
  if (!acct) throw new SmtpError(400, "connect your mail account first (Settings → Mail)");
  const draft = composeShare(note, acct.username);
  await sendMail(
    { host: smtpHostFor(acct), port: acct.smtp_port, user: acct.username, pass: acct.password },
    emails, draft.subject, draft.body, draft.headers, opts,
  );
  const now = nowIso();
  for (const r of emails) {
    db.query(`INSERT INTO shares (note_id, recipient, message_id, shared_at) VALUES (?, ?, ?, ?)`)
      .run(noteId, r, draft.headers["X-Abba-Id"], now);
  }
  db.query(`UPDATE notes SET updated_at = ? WHERE id = ?`).run(now, noteId);
  return { sent: emails.length };
}

// ---------- incoming shares ----------

interface IncomingShare {
  abbaId: string;
  messageId: string;
  title: string;
  body: string;
  fromName: string;
  fromEmail: string;
}

function parseSearchUids(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\* SEARCH (.*)$/i);
    if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) out.push(n);
  }
  return out;
}

/** Fetch one header block for a UID. */
async function fetchHeaders(conn: Conn, tag: string, uid: string): Promise<string> {
  const lines = await conn.cmd(tag,
    `UID FETCH ${uid} (UID BODY.PEEK[HEADER.FIELDS (X-ABBA-ID X-ABBA-FROM SUBJECT DATE MESSAGE-ID FROM)])`);
  const joined = lines.join("\r\n");
  const lm = joined.match(/\{(\d+)\}\r?\n([\s\S]*)$/);
  return lm ? lm[2].slice(0, Number(lm[1])) : joined;
}

/** Fetch up to maxChars of decoded plain text for one UID. */
async function fetchText(conn: Conn, tag: string, uid: string, maxChars: number): Promise<string> {
  try {
    const lines = await conn.cmd(tag, `UID FETCH ${uid} (UID BODY.PEEK[TEXT]<0.${maxChars}>)`);
    const joined = lines.join("\r\n");
    const lm = joined.match(/\{(\d+)\}\r?\n([\s\S]*)$/);
    let text = lm ? lm[2].slice(0, Number(lm[1])) : "";
    const mime = decodeMimeText(text);
    if (mime !== null) text = mime;
    else {
      const hm = text.match(/\r?\n\r?\n/);
      if (hm) text = text.slice(hm.index! + hm[0].length);
    }
    // strip our own share footer (wire is CRLF)
    text = text.replace(/\r\n/g, "\n");
    text = text.replace(/\n---\nShared from Abba, a quiet notepad\.\s*$/, "");
    return text.replace(/\s+$/g, "").slice(0, maxChars);
  } catch {
    return "";
  }
}

function headerVal(headers: string, name: string): string {
  const m = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return m ? decodeHeader(m[1].trim()) : "";
}

/**
 * Scan INBOX for X-Abba-Share messages and import new ones into the
 * "shared with me" shelf. Idempotent by Message-ID / X-Abba-Id.
 * Returns the number of newly imported notes.
 */
export async function scanSharedInbox(opts: { insecure?: boolean } = {}): Promise<{ imported: number }> {
  const acct = getImapAccount();
  if (!acct) return { imported: 0 };
  const { conn } = await connectAndLogin({ host: acct.host, port: acct.port, user: acct.username, pass: acct.password, secure: !opts.insecure });
  const db = getDb();
  try {
    await conn.cmd("s001", "EXAMINE INBOX"); // read-only: never touches flags
    const uids = parseSearchUids(await conn.cmd("s002", `UID SEARCH HEADER ${qstr("X-Abba-Share")} ${qstr("1")}`));
    if (!uids.length) return { imported: 0 };
    const known = new Set(
      (db.query(`SELECT abba_id FROM shared_notes`).all() as any[]).map((r) => r.abba_id),
    );
    const knownMid = new Set(
      (db.query(`SELECT message_id FROM shares WHERE message_id != ''`).all() as any[]).map((r) => r.message_id),
    );
    let imported = 0;
    for (const uid of uids.slice(0, 50)) {
      const headers = await fetchHeaders(conn, `s1${uid}`, uid);
      const abbaId = headerVal(headers, "X-Abba-Id");
      const messageId = headerVal(headers, "Message-ID");
      if ((abbaId && known.has(abbaId)) || (messageId && knownMid.has(messageId))) continue;
      const fromRaw = headerVal(headers, "From");
      const fromEmail = extractEmail(fromRaw) || headerVal(headers, "X-Abba-From");
      const fromName = fromRaw.replace(/<[^>]*>/, "").trim().replace(/^"|"$/g, "");
      const subject = headerVal(headers, "Subject").replace(/^\[Abba\]\s*/i, "") || "Shared note";
      const body = await fetchText(conn, `s2${uid}`, uid, 20000);
      if (!body.trim()) continue;
      db.query(`INSERT OR IGNORE INTO shared_notes
        (abba_id, title, body, from_name, from_email, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(abbaId || `mid:${messageId || uid}`, subject.slice(0, 200), body, fromName.slice(0, 80), fromEmail.slice(0, 120), nowIso());
      imported++;
    }
    db.query(`UPDATE imap_account SET last_share_scan_at = ? WHERE id = 1`).run(nowIso());
    return { imported };
  } finally {
    conn.close();
  }
}

export { SmtpError };
