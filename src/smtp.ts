// smtp.ts — minimal zero-dependency SMTP client for Abba's share-by-email.
//
//   - port 465: implicit TLS from the first byte
//   - other ports (587/25): EHLO, STARTTLS via socket.upgradeTLS(), AUTH
// AUTH LOGIN first, then AUTH PLAIN. No OAuth.
// Only used to send share emails through the user's own mail account.
import type { Socket } from "bun";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export class SmtpError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Conn {
  socket: Socket | null;
  buf: string;
  waiters: Array<() => void>;
  write(s: string): void;
  readLine(): Promise<string>;
  cmd(c: string): Promise<string>;
  close(): void;
}

function makeConn(): Conn {
  const c: Conn = {
    socket: null,
    buf: "",
    waiters: [],
    write(s: string) { c.socket!.write(s); },
    close() { try { c.socket?.end(); } catch { /* already closed */ } },
    readLine() {
      return new Promise<string>((resolve) => {
        const pump = (): void => {
          const i = c.buf.indexOf("\r\n");
          if (i >= 0) {
            const line = c.buf.slice(0, i);
            c.buf = c.buf.slice(i + 2);
            resolve(line);
            return;
          }
          c.waiters.push(pump);
        };
        pump();
      });
    },
    async cmd(cmdStr: string) {
      c.write(cmdStr + "\r\n");
      return readReply(c);
    },
  };
  return c;
}

/** Connect with handlers attached up front (Bun requires socket handlers in the options). */
function openSocket(host: string, port: number, tls: boolean, c: Conn): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new SmtpError(504, "SMTP connect timed out")); }
    }, 15000);
    Bun.connect({
      hostname: host,
      port,
      tls,
      socket: {
        open(sock: any) {
          if (!settled) { settled = true; clearTimeout(timer); c.socket = sock; resolve(sock); }
        },
        data(_sock: any, data: Buffer) {
          c.buf += data.toString("utf8");
          const ws = c.waiters.splice(0);
          for (const w of ws) w();
        },
        error(_sock: any, err: Error) {
          if (!settled) { settled = true; clearTimeout(timer); reject(new SmtpError(0, "SMTP connect failed: " + err.message)); }
        },
        close() { /* server hung up; pending reads reject via timeouts */ },
      },
    });
  });
}

/** Read a (possibly multi-line) SMTP reply; throws SmtpError on 4xx/5xx. */
async function readReply(c: Conn): Promise<string> {
  let text = "";
  for (;;) {
    const line = await c.readLine();
    text += line + "\n";
    const m = line.match(/^(\d{3})([ -])/);
    if (!m) throw new SmtpError(502, `bad SMTP reply: ${line.slice(0, 80)}`);
    if (m[2] === " ") {
      const code = Number(m[1]);
      if (code >= 400) throw new SmtpError(code, text.trim().slice(0, 200));
      return text.trim();
    }
  }
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: any;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError(504, `${what} timed out`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Open, greet, and TLS-upgrade as needed. Returns a ready Conn.
 *  `opts.insecure` skips STARTTLS and exists for the local test fake only. */
async function dial(cfg: SmtpConfig, opts: { insecure?: boolean } = {}): Promise<Conn> {
  const implicitTls = cfg.port === 465;
  const c = makeConn();
  const socket = await openSocket(cfg.host, cfg.port, implicitTls, c);
  try {
    await withTimeout(readReply(c), 15000, "SMTP greeting"); // 220 banner
    await withTimeout(c.cmd("EHLO abba"), 15000, "EHLO");
    if (!implicitTls && !opts.insecure) {
      await withTimeout(c.cmd("STARTTLS"), 15000, "STARTTLS");
      await withTimeout(
        (socket as any).upgradeTLS({ servername: cfg.host }),
        15000,
        "TLS upgrade",
      );
      await withTimeout(c.cmd("EHLO abba"), 15000, "EHLO");
    }
    return c;
  } catch (e) {
    c.close();
    throw e;
  }
}

async function login(c: Conn, cfg: SmtpConfig): Promise<void> {
  try {
    await withTimeout(c.cmd("AUTH LOGIN"), 15000, "AUTH LOGIN");
    await withTimeout(c.cmd(b64(cfg.user)), 15000, "SMTP username");
    await withTimeout(c.cmd(b64(cfg.pass)), 15000, "SMTP password");
    return;
  } catch (e) {
    if (e instanceof SmtpError && e.code === 535) throw e; // bad credentials — no fallback helps
    await withTimeout(c.cmd("AUTH PLAIN " + b64(`\0${cfg.user}\0${cfg.pass}`)), 15000, "AUTH PLAIN");
  }
}

/** Send one plain-text email. `headers` adds MIME headers (X-Abba-* etc). */
export async function sendMail(
  cfg: SmtpConfig,
  to: string[],
  subject: string,
  body: string,
  headers: Record<string, string> = {},
  opts: { insecure?: boolean } = {},
): Promise<void> {
  if (!to.length) throw new SmtpError(400, "no recipients");
  const c = await dial(cfg, opts);
  try {
    await login(c, cfg);
    const from = cfg.user.includes("@") ? cfg.user : `${cfg.user}@${cfg.host}`;
    await withTimeout(c.cmd(`MAIL FROM:<${from}>`), 15000, "MAIL FROM");
    for (const rcpt of to) {
      await withTimeout(c.cmd(`RCPT TO:<${rcpt}>`), 15000, "RCPT TO");
    }
    await withTimeout(c.cmd("DATA"), 15000, "DATA");
    const date = new Date().toUTCString();
    const head = [
      `From: ${from}`,
      `To: ${to.join(", ")}`,
      `Subject: ${subject}`,
      `Date: ${date}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@abba>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ``,
    ].join("\r\n");
    // dot-stuffing per RFC 5321 §4.5.2; blank line separates headers from body
    const stuffed = body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    c.write(head + "\r\n" + stuffed + "\r\n.\r\n");
    await withTimeout(readReply(c), 30000, "message body");
    try { await withTimeout(c.cmd("QUIT"), 10000, "QUIT"); } catch { /* bye anyway */ }
  } finally {
    c.close();
  }
}

/** Validate credentials without sending anything. */
export async function testSmtp(cfg: SmtpConfig, opts: { insecure?: boolean } = {}): Promise<void> {
  const c = await dial(cfg, opts);
  try {
    await login(c, cfg);
  } finally {
    try { await withTimeout(c.cmd("QUIT"), 5000, "QUIT"); } catch { /* bye */ }
    c.close();
  }
}
