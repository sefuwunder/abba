// imapfailure.test.ts — a background IMAP job that dies before it can
// report must still surface its error (the "Sync started…" then silence bug).
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { __resetForTests, noteImapFailure } from "../src/server";

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  __resetForTests(db);
  db.query(`INSERT INTO imap_account
    (id, host, port, username, password, folder, smtp_host, smtp_port, last_sync_at, last_error, last_share_scan_at, updated_at)
    VALUES (1, 'mail.example.com', 993, 'u', 'p', 'Notes', '', 587, '', '', '', ?)`)
    .run(new Date().toISOString());
});

describe("noteImapFailure", () => {
  test("a dead sync records its error where Settings shows it", () => {
    noteImapFailure("sync", new Error("boom"));
    const row = db.query("SELECT last_error FROM imap_account WHERE id = 1").get() as any;
    expect(row.last_error).toBe("boom");
  });
  test("a dead scan records its error too", () => {
    noteImapFailure("scan", "kaput");
    const row = db.query("SELECT last_error FROM imap_account WHERE id = 1").get() as any;
    expect(row.last_error).toBe("kaput");
  });
  test("weird throwables don't break the recorder", () => {
    expect(() => noteImapFailure("sync", null)).not.toThrow();
    expect(() => noteImapFailure("sync", undefined)).not.toThrow();
    const row = db.query("SELECT last_error FROM imap_account WHERE id = 1").get() as any;
    expect(typeof row.last_error).toBe("string");
  });
});
