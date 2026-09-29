// db.ts — SQLite schema and data-dir bootstrap for Sefu.
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let db: Database | null = null;
let dataDir = "";

export function dataDirPath(): string { return dataDir; }

export function initDataDir(dir?: string): Database {
  dataDir = dir || process.env.SEFU_DATA || join(import.meta.dir, "..", "data");
  mkdirSync(dataDir, { recursive: true });
  db = new Database(join(dataDir, "sefu.db"));
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
    CREATE TABLE IF NOT EXISTS circle (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'The Circle',
      invite_code TEXT NOT NULL,
      member_cap INTEGER NOT NULL DEFAULT 12,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#C0765A',
      token TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'seed',
      shared INTEGER NOT NULL DEFAULT 0,
      read_mins INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_member ON notes(member_id);
    CREATE INDEX IF NOT EXISTS idx_notes_shared ON notes(shared);
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_note ON comments(note_id);
    CREATE TABLE IF NOT EXISTS reactions (
      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (note_id, member_id, kind)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
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
      member_id INTEGER NOT NULL,
      nudge_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (member_id, nudge_key)
    );
  `);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomToken(prefix = ""): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return prefix + Buffer.from(bytes).toString("base64url");
}

export function randomInviteCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "sefu-" + Buffer.from(bytes).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
}
