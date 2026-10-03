// db.ts — SQLite schema and data-dir bootstrap for Abba.
//
// Abba is a single-user notepad. There is no sign-in: the server binds to
// 127.0.0.1 and access control lives one layer up (Deck's TOTP gate).
// There is no peer-to-peer mesh. Sharing happens through IMAP: a note can
// be emailed to anyone (X-Abba-Share headers), and incoming shared notes
// are picked up from INBOX into the "shared with me" shelf.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let db: Database | null = null;
let dataDir = "";

export function dataDirPath(): string { return dataDir; }

export function initDataDir(dir?: string): Database {
  dataDir = dir || process.env.ABBA_DATA || join(import.meta.dir, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, "abba.db"));
  db.exec("PRAGMA journal_mode=WAL;");
  migrate(db);
  return db;
}

/** Test hook: swap the database handle (mirrors the milton pattern). */
export function __setDbForTests(d: Database): void {
  db = d;
  migrate(db);
}

export function getDb(): Database {
  if (!db) throw new Error("database not initialized");
  return db;
}

function migrate(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'seed',
      read_mins INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_note ON comments(note_id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nudges_seen (
      nudge_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imap_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 993,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'Notes',
      smtp_host TEXT NOT NULL DEFAULT '',
      smtp_port INTEGER NOT NULL DEFAULT 587,
      last_sync_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      last_share_scan_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      shared_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shares_note ON shares(note_id);
    CREATE TABLE IF NOT EXISTS shared_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      abba_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      received_at TEXT NOT NULL
    );
  `);
  migrateSolo(d);
}

/**
 * Solo migration (2026-10-03): collapse the old multi-member / multi-circle /
 * mesh schema into the single-user model. Notes, comments, digests and the
 * IMAP configuration carry over; members, circles, invites, pairings and the
 * mesh leave no trace.
 */
function migrateSolo(d: Database): void {
  const tables = (d.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[]).map((r) => r.name);
  if (!tables.includes("members")) return; // already solo (or fresh)
  const cols = (t: string) => (d.query(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);

  // notes: keep everything, drop member/circle scoping
  d.exec(`
    CREATE TABLE notes_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'seed',
      read_mins INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO notes_new (id, title, body, tags, status, read_mins, created_at, updated_at)
      SELECT id, title, body, tags, status, read_mins, created_at, updated_at FROM notes;
    DROP TABLE notes;
    ALTER TABLE notes_new RENAME TO notes;
    CREATE INDEX idx_notes_updated ON notes(updated_at);
  `);

  // comments: member_id -> author_name
  if (cols("comments").includes("member_id")) {
    d.exec(`
      CREATE TABLE comments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO comments_new (id, note_id, author_name, body, created_at)
        SELECT c.id, c.note_id, COALESCE(m.name, ''), c.body, c.created_at
        FROM comments c LEFT JOIN members m ON m.id = c.member_id;
      DROP TABLE comments;
      ALTER TABLE comments_new RENAME TO comments;
      CREATE INDEX idx_comments_note ON comments(note_id);
    `);
  }

  // events: drop member scoping
  if (cols("events").includes("member_id")) {
    d.exec(`
      CREATE TABLE events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO events_new (id, kind, note_id, meta, created_at)
        SELECT id, kind, note_id, meta, created_at FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX idx_events_created ON events(created_at);
    `);
  }

  // digests: drop circle scoping (keep first payload per week)
  if (cols("digests").includes("circle_id")) {
    d.exec(`
      CREATE TABLE digests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO digests_new (week_key, payload, created_at)
        SELECT week_key, payload, MIN(created_at) FROM digests GROUP BY week_key;
      DROP TABLE digests;
      ALTER TABLE digests_new RENAME TO digests;
    `);
  }

  // nudges_seen: drop member scoping
  if (tables.includes("nudges_seen") && cols("nudges_seen").includes("member_id")) {
    d.exec(`
      CREATE TABLE nudges_seen_new (
        nudge_key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO nudges_seen_new (nudge_key, created_at)
        SELECT nudge_key, MIN(created_at) FROM nudges_seen GROUP BY nudge_key;
      DROP TABLE nudges_seen;
      ALTER TABLE nudges_seen_new RENAME TO nudges_seen;
    `);
  }

  // imap_accounts (per-member) -> imap_account (single row, id = 1)
  if (tables.includes("imap_accounts")) {
    const has = (d.query(`SELECT COUNT(*) AS n FROM imap_account`).get() as any).n;
    if (!has) {
      const row = d.query(`
        SELECT host, port, username, password, folder, last_sync_at, last_error
        FROM imap_accounts ORDER BY member_id LIMIT 1
      `).get() as any;
      if (row) {
        d.query(`INSERT INTO imap_account
          (id, host, port, username, password, folder, smtp_host, smtp_port, last_sync_at, last_error, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, '', 587, ?, ?, ?)`)
          .run(row.host, row.port, row.username, row.password, row.folder, row.last_sync_at, row.last_error, nowIso());
      }
    }
  }

  // drop everything from the circle/mesh era
  for (const t of ["reactions", "circle", "members", "invited_users", "circle_peers", "mesh_seen", "mesh_blocked_nodes", "imap_accounts"]) {
    d.exec(`DROP TABLE IF EXISTS ${t}`);
  }
  d.exec(`DROP INDEX IF EXISTS idx_members_user_id`);
  d.exec(`DROP INDEX IF EXISTS idx_notes_gid`);
  d.exec(`DROP INDEX IF EXISTS idx_comments_rgid`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomToken(prefix = ""): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return prefix + Buffer.from(bytes).toString("base64url");
}

/** Stable id for a shared note (X-Abba-Id). */
export function randomShareId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "sh-" + Buffer.from(bytes).toString("base64url");
}
