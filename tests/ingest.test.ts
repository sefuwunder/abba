// ingest.test.ts — email-to-note ingestion from Relay's Notes-folder feed.
// Abba does NO IMAP itself; it polls Relay's HTTP API. Tests:
//  1. Pure mapping: Relay email → Abba note fields (subject/body/date fallbacks).
//  2. Dedupe key: message_id preferred, relay id fallback, empty when unidentifiable.
//  3. End-to-end against a stubbed Relay: ingest creates notes, re-ingest adds
//     nothing, watermark advances, Relay failure is quiet.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

process.env.RELAY_URL = "http://127.0.0.1:31931"; // stub below; set before import
const { __resetForTests, notesEmailToNote, notesEmailDedupeKey, ingestNotesEmails } =
  await import("../src/server.ts");
const { getDb, kvGet } = await import("../src/db.ts");

describe("notesEmailToNote mapping", () => {
  test("subject becomes title, body as-is, seed status, from-email tag", () => {
    const n = notesEmailToNote({ subject: "  Grocery list  ", body: "# milk\n# eggs", date: 1728000000 });
    expect(n.title).toBe("Grocery list");
    expect(n.body).toBe("# milk\n# eggs");
    expect(JSON.parse(n.tags)).toEqual(["from-email"]);
    expect(n.created_at).toBe("2024-10-04T00:00:00.000Z");
    expect(n.updated_at).toBe(n.created_at);
  });
  test("blank subject falls back to first 60 chars of body", () => {
    const body = "a".repeat(100);
    const n = notesEmailToNote({ subject: "", body, date: 1728000000 });
    expect(n.title).toBe("a".repeat(60));
  });
  test("blank subject and body falls back to Untitled note", () => {
    const n = notesEmailToNote({ subject: " ", body: "  ", date: 1728000000 });
    expect(n.title).toBe("Untitled note");
  });
  test("date accepts ms epoch and ISO strings", () => {
    expect(notesEmailToNote({ date: 1728000000000 }).created_at).toBe("2024-10-04T00:00:00.000Z");
    expect(notesEmailToNote({ date: "2024-10-04T00:00:00.000Z" }).created_at).toBe("2024-10-04T00:00:00.000Z");
  });
  test("title capped at 200 chars", () => {
    const n = notesEmailToNote({ subject: "x".repeat(300), date: 1728000000 });
    expect(n.title.length).toBe(200);
  });
});

describe("notesEmailDedupeKey", () => {
  test("prefers message_id", () => {
    expect(notesEmailDedupeKey({ message_id: "<a@x>", id: 7 })).toBe("<a@x>");
  });
  test("falls back to relay id", () => {
    expect(notesEmailDedupeKey({ id: 42 })).toBe("relay:42");
  });
  test("empty when unidentifiable", () => {
    expect(notesEmailDedupeKey({})).toBe("");
    expect(notesEmailDedupeKey({ message_id: " ", id: "" })).toBe("");
  });
});

describe("ingestNotesEmails against stubbed Relay", () => {
  const t0 = Math.floor(Date.now() / 1000) - 3600; // 1h ago, unix seconds
  const emails = [
    { id: 1, message_id: "<one@x>", subject: "First", body: "hello", from: "me@x", date: t0 },
    { id: 2, message_id: "<two@x>", subject: "", body: "no subject here", from: "me@x", date: t0 + 60 },
    { subject: "unidentifiable", body: "no ids at all", date: t0 + 120 }, // no id, no message_id → skipped
  ];
  let stub: any;
  let sinceSeen: string[] = [];

  beforeAll(() => {
    __resetForTests(new Database(":memory:"));
    stub = Bun.serve({
      port: 31931,
      fetch: (req) => {
        const u = new URL(req.url);
        sinceSeen.push(u.searchParams.get("since") || "");
        if (u.pathname === "/api/relay/notes-emails")
          return Response.json({ emails });
        return new Response("nf", { status: 404 });
      },
    });
  });
  afterAll(() => { stub.stop(); });

  test("ingests identifiable emails as seed notes tagged from-email", async () => {
    const r = await ingestNotesEmails();
    expect(r.fetched).toBe(3);
    expect(r.ingested).toBe(2); // the id-less email is skipped
    const rows = getDb().query(`SELECT title, status, tags FROM notes ORDER BY id`).all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ title: "First", status: "seed" });
    expect(JSON.parse(rows[0].tags)).toEqual(["from-email"]);
    expect(rows[1].title).toBe("no subject here");
    const mail = getDb().query(`SELECT message_id, note_id FROM ingested_mail ORDER BY message_id`).all();
    expect(mail.length).toBe(2);
  });

  test("re-ingest creates no duplicates and watermark advances", async () => {
    const wmBefore = Number(kvGet("notes_mail_watermark"));
    expect(wmBefore).toBe((t0 + 60) * 1000);
    const r = await ingestNotesEmails();
    expect(r.ingested).toBe(0);
    const count = (getDb().query(`SELECT COUNT(*) AS c FROM notes`).get() as any).c;
    expect(count).toBe(2);
    // first call sent a 7-day-ago watermark (ms); second call sent the stored one
    expect(Number(sinceSeen[0])).toBeLessThan(wmBefore);
    expect(Number(sinceSeen[1])).toBe(wmBefore);
  });

  test("Relay failure is quiet, not a crash", async () => {
    stub.stop();
    const r = await ingestNotesEmails();
    expect(r).toEqual({ fetched: 0, ingested: 0 });
  });
});
