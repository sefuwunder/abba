// share.test.ts — sharing by email: compose, validation, SMTP send against
// a fake server, and incoming-share scan against a fake IMAP server.
// No real network.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { __setDbForTests, getDb, nowIso } from "../src/db";
import { composeShare, validEmail, smtpHostFor, shareNote, scanSharedInbox } from "../src/share";
import { sendMail } from "../src/smtp";

// ---------- unit: compose & validation ----------

describe("composeShare", () => {
  test("builds a share email with Abba headers", () => {
    const d = composeShare({ id: 1, title: "Sourdough", body: "feed daily" }, "me@example.com");
    expect(d.subject).toBe("[Abba] Sourdough");
    expect(d.body).toContain("feed daily");
    expect(d.headers["X-Abba-Share"]).toBe("1");
    expect(d.headers["X-Abba-Id"]).toMatch(/^sh-/);
    expect(d.headers["X-Abba-From"]).toBe("me@example.com");
  });
  test("untitled note gets a fallback subject", () => {
    const d = composeShare({ id: 2, title: "", body: "x" }, "me@example.com");
    expect(d.subject).toBe("[Abba] Untitled note");
  });
});

describe("validEmail", () => {
  test("accepts normal addresses, rejects junk", () => {
    expect(validEmail("ari@example.com")).toBe(true);
    expect(validEmail("a.b+tag@sub.example.co")).toBe(true);
    expect(validEmail("not-an-email")).toBe(false);
    expect(validEmail("a@b")).toBe(false);
    expect(validEmail("")).toBe(false);
  });
});

describe("smtpHostFor", () => {
  test("explicit setting wins, else imap. -> smtp.", () => {
    expect(smtpHostFor({ host: "imap.gmail.com", port: 993, username: "u", password: "p", folder: "Notes", smtp_host: "", smtp_port: 587 }))
      .toBe("smtp.gmail.com");
    expect(smtpHostFor({ host: "mail.example.com", port: 993, username: "u", password: "p", folder: "Notes", smtp_host: "smtp.example.com", smtp_port: 587 }))
      .toBe("smtp.example.com");
  });
});

// ---------- fake SMTP server ----------

interface SmtpCapture { mailFrom: string; rcpts: string[]; headers: string; body: string; }

function startFakeSmtp() {
  let capture: SmtpCapture | null = null;
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock: any) {
        sock.write("220 fake smtp ready\r\n");
        sock.st = { buf: "", auth: 0, data: false, lines: [] as string[] };
      },
      data(sock: any, data: Buffer) {
        const st = sock.st;
        st.buf += data.toString("utf8");
        for (;;) {
          if (st.data) {
            const end = st.buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            const raw = st.buf.slice(0, end);
            st.buf = st.buf.slice(end + 5);
            st.data = false;
            const idx = raw.indexOf("\r\n\r\n");
            const headers = idx >= 0 ? raw.slice(0, idx) : raw;
            const body = idx >= 0 ? raw.slice(idx + 4) : "";
            capture = { mailFrom: st.mailFrom, rcpts: st.rcpts, headers, body };
            sock.write("250 OK queued\r\n");
            continue;
          }
          const i = st.buf.indexOf("\r\n");
          if (i < 0) return;
          const line = st.buf.slice(0, i);
          st.buf = st.buf.slice(i + 2);
          const [verb, ...rest] = line.split(" ");
          const arg = rest.join(" ");
          const V = verb.toUpperCase();
          if (V === "EHLO" || V === "HELO") sock.write("250-fake\r\n250 OK\r\n");
          else if (V === "AUTH" && arg.toUpperCase() === "LOGIN") { st.auth = 1; sock.write("334 VXNlcm5hbWU6\r\n"); }
          else if (st.auth === 1) { st.user = arg; st.auth = 2; sock.write("334 UGFzc3dvcmQ6\r\n"); }
          else if (st.auth === 2) { st.auth = 3; sock.write("235 OK\r\n"); }
          else if (V === "MAIL") { st.mailFrom = arg; st.rcpts = []; sock.write("250 OK\r\n"); }
          else if (V === "RCPT") { st.rcpts.push(arg); sock.write("250 OK\r\n"); }
          else if (V === "DATA") { st.data = true; sock.write("354 go ahead\r\n"); }
          else if (V === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
          else if (V === "RSET") sock.write("250 OK\r\n");
          else sock.write("502 no\r\n");
        }
      },
    },
  });
  return { port: (server as any).port, get: () => capture, stop: () => server.stop() };
}

// ---------- fake IMAP server (INBOX share scan) ----------

function startFakeImap(shareRaw: string) {
  const server = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(sock: any) { sock.write("* OK fake imap ready\r\n"); sock.st = { buf: "" }; },
      data(sock: any, data: Buffer) {
        const st = sock.st;
        st.buf += data.toString("utf8");
        for (;;) {
          const i = st.buf.indexOf("\r\n");
          if (i < 0) return;
          const line = st.buf.slice(0, i);
          st.buf = st.buf.slice(i + 2);
          const sp = line.indexOf(" ");
          const tag = line.slice(0, sp);
          const rest = line.slice(sp + 1);
          const verb = rest.split(" ")[0].toUpperCase();
          if (verb === "LOGIN") { sock.write(`${tag} OK logged in\r\n`); continue; }
          if (verb === "EXAMINE" || verb === "SELECT") { sock.write(`* 1 EXISTS\r\n${tag} OK examined\r\n`); continue; }
          if (verb === "UID") {
            const sub = rest.split(" ")[1].toUpperCase();
            if (sub === "SEARCH") { sock.write(`* SEARCH 7\r\n${tag} OK searched\r\n`); continue; }
            if (sub === "FETCH") {
              const what = rest.slice(rest.indexOf("("));
              let payload: string, label: string;
              if (what.includes("HEADER.FIELDS")) {
                const head = shareRaw.split("\r\n\r\n")[0];
                payload = head; label = `BODY[HEADER.FIELDS (X-ABBA-ID X-ABBA-FROM SUBJECT DATE MESSAGE-ID FROM)]`;
              } else {
                payload = shareRaw.split("\r\n\r\n").slice(1).join("\r\n\r\n");
                label = "BODY[TEXT]";
              }
              const n = Buffer.byteLength(payload, "utf8");
              sock.write(`* 1 FETCH (UID 7 ${label} {${n}}\r\n${payload}\r\n)\r\n${tag} OK fetched\r\n`);
              continue;
            }
          }
          if (verb === "LOGOUT") { sock.write(`* BYE bye\r\n${tag} OK logged out\r\n`); sock.end(); continue; }
          sock.write(`${tag} BAD unknown\r\n`);
        }
      },
    },
  });
  return { port: (server as any).port, stop: () => server.stop() };
}

function freshDb() {
  const db = new Database(":memory:");
  __setDbForTests(db);
  return db;
}

function addMailAccount(db: Database, smtpPort: number, imapPort = 0) {
  db.query(`INSERT INTO imap_account (id, host, port, username, password, folder, smtp_host, smtp_port, updated_at)
    VALUES (1, '127.0.0.1', ?, 'me@example.com', 'secret', 'Notes', '127.0.0.1', ?, ?)`)
    .run(imapPort || 993, smtpPort, nowIso());
}

// ---------- sendMail ----------

describe("sendMail", () => {
  let fake: ReturnType<typeof startFakeSmtp>;
  beforeAll(() => { fake = startFakeSmtp(); });
  afterAll(() => fake.stop());

  test("AUTH LOGIN + DATA round-trip, headers intact", async () => {
    await sendMail(
      { host: "127.0.0.1", port: fake.port, user: "me@example.com", pass: "secret" },
      ["ari@example.com"], "Hello", "body here",
      { "X-Abba-Share": "1", "X-Abba-Id": "sh-abc" },
      { insecure: true },
    );
    const c = fake.get()!;
    expect(c.rcpts.join(" ")).toContain("ari@example.com");
    expect(c.headers).toContain("X-Abba-Share: 1");
    expect(c.headers).toContain("X-Abba-Id: sh-abc");
    expect(c.body).toBe("body here");
  });

  test("no recipients is refused before connecting", async () => {
    await expect(sendMail(
      { host: "127.0.0.1", port: fake.port, user: "u", pass: "p" }, [], "s", "b", {}, { insecure: true },
    )).rejects.toThrow(/no recipients/);
  });
});

// ---------- shareNote ----------

describe("shareNote", () => {
  let fake: ReturnType<typeof startFakeSmtp>;
  let db: Database;
  beforeAll(() => { fake = startFakeSmtp(); });
  afterAll(() => fake.stop());

  test("sends, records, and dedupes recipients", async () => {
    db = freshDb();
    addMailAccount(db, fake.port);
    const r = db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
      VALUES ('Sourdough', 'feed daily', '[]', 'seed', 1, ?, ?)`)
      .run(nowIso(), nowIso());
    const id = Number(r.lastInsertRowid);
    const res = await shareNote(id, ["ari@example.com", "ARI@example.com", " sam@example.com "], { insecure: true });
    expect(res.sent).toBe(2);
    const rows = db.query(`SELECT recipient FROM shares WHERE note_id = ? ORDER BY recipient`).all(id) as any[];
    expect(rows.map((x) => x.recipient)).toEqual(["ari@example.com", "sam@example.com"]);
    const c = fake.get()!;
    expect(c.headers).toContain("X-Abba-Share: 1");
    expect(c.headers).toContain("Subject: [Abba] Sourdough");
  });

  test("bad email rejected, nothing sent or recorded", async () => {
    db = freshDb();
    addMailAccount(db, fake.port);
    const r = db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
      VALUES ('T', 'b', '[]', 'seed', 1, ?, ?)`).run(nowIso(), nowIso());
    await expect(shareNote(Number(r.lastInsertRowid), ["nope"], { insecure: true })).rejects.toThrow(/email/);
    expect((db.query(`SELECT COUNT(*) AS n FROM shares`).get() as any).n).toBe(0);
  });

  test("missing note and missing mail account fail cleanly", async () => {
    db = freshDb();
    addMailAccount(db, fake.port);
    await expect(shareNote(999, ["a@example.com"], { insecure: true })).rejects.toThrow(/not found/);
    db.query(`DELETE FROM imap_account`).run();
    const r = db.query(`INSERT INTO notes (title, body, tags, status, read_mins, created_at, updated_at)
      VALUES ('T', 'b', '[]', 'seed', 1, ?, ?)`).run(nowIso(), nowIso());
    await expect(shareNote(Number(r.lastInsertRowid), ["a@example.com"], { insecure: true })).rejects.toThrow(/mail account/);
  });
});

// ---------- scanSharedInbox ----------

describe("scanSharedInbox", () => {
  test("imports a share email once", async () => {
    const db = freshDb();
    const raw = [
      "From: Ari <ari@example.com>",
      "To: me@example.com",
      "Subject: [Abba] Sourdough secrets",
      "Date: Sat, 03 Oct 2026 12:00:00 +0000",
      "Message-ID: <share-1@test>",
      "X-Abba-Share: 1",
      "X-Abba-Id: sh-test-1",
      "X-Abba-From: ari@example.com",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Sourdough secrets",
      "October 3, 2026",
      "",
      "feed it rye, not wheat.",
      "",
      "---",
      "Shared from Abba, a quiet notepad.",
      "",
    ].join("\r\n");
    const fake = startFakeImap(raw);
    try {
      db.query(`INSERT INTO imap_account (id, host, port, username, password, folder, updated_at)
        VALUES (1, '127.0.0.1', ?, 'me@example.com', 'secret', 'Notes', ?)`)
        .run(fake.port, nowIso());
      const r1 = await scanSharedInbox({ insecure: true });
      expect(r1.imported).toBe(1);
      const rows = db.query(`SELECT * FROM shared_notes`).all() as any[];
      expect(rows.length).toBe(1);
      expect(rows[0].title).toBe("Sourdough secrets");
      expect(rows[0].body).toContain("feed it rye");
      expect(rows[0].body).not.toContain("Shared from Abba");
      expect(rows[0].from_email).toBe("ari@example.com");
      // idempotent: second scan imports nothing
      const r2 = await scanSharedInbox({ insecure: true });
      expect(r2.imported).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("no account -> no-op", async () => {
    freshDb();
    expect((await scanSharedInbox({ insecure: true })).imported).toBe(0);
  });
});
