// db.ts — SQLite schema and data-dir bootstrap for Abba.
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
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
    CREATE TABLE IF NOT EXISTS circle (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL DEFAULT 'The Circle',
      invite_code TEXT NOT NULL,
      invite_expires_at TEXT,
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
      last_seen TEXT NOT NULL DEFAULT '',
      user_id TEXT
    );
    CREATE TABLE IF NOT EXISTS invited_users (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS mesh_seen (
      k TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mesh_blocked_nodes (
      node_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imap_accounts (
      member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 993,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'Notes',
      last_sync_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
  `);
  // mesh columns (added after the fact — idempotent)
  for (const [table, column] of [["notes", "gid"], ["notes", "link_origin"], ["comments", "remote_gid"], ["members", "password_hash"], ["circle", "invite_expires_at"], ["members", "user_id"]]) {
    const cols = d.query(`PRAGMA table_info(${table})`).all() as any[];
    if (!cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id)");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_gid ON notes(gid)");
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_rgid ON comments(remote_gid)");
  migrateMultiCircle(d);
}

/**
 * Multi-circle migration (2026-10-03): one instance can host many circles.
 * - circle: drop CHECK(id = 1), autoincrement ids, add stable mesh_id.
 * - members/notes/events/digests/invited_users: circle_id (existing rows -> 1).
 * - digests: UNIQUE(week_key) -> UNIQUE(week_key, circle_id).
 * - circle_peers: mesh pairing of a local circle to a remote circle.
 */
function migrateMultiCircle(d: Database): void {
  const cols = (t: string) => (d.query(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
  const indexes = (t: string) => (d.query(`PRAGMA index_list(${t})`).all() as any[]).map((i) => i.name);

  if (!cols("circle").includes("mesh_id")) {
    d.exec(`
      CREATE TABLE circle_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT 'The Circle',
        invite_code TEXT NOT NULL,
        invite_expires_at TEXT,
        member_cap INTEGER NOT NULL DEFAULT 12,
        mesh_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      INSERT INTO circle_new (id, name, invite_code, invite_expires_at, member_cap, created_at)
        SELECT id, name, invite_code, invite_expires_at, member_cap, created_at FROM circle;
      DROP TABLE circle;
      ALTER TABLE circle_new RENAME TO circle;
    `);
    for (const r of d.query(`SELECT id FROM circle`).all() as any[]) {
      d.query(`UPDATE circle SET mesh_id = ? WHERE id = ?`).run(randomMeshId(), r.id);
    }
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_circle_mesh_id ON circle(mesh_id)`);
    d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_circle_invite_code ON circle(invite_code)`);
  }

  for (const table of ["members", "notes", "events", "digests", "invited_users"]) {
    if (!cols(table).includes("circle_id")) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN circle_id INTEGER NOT NULL DEFAULT 1`);
    }
  }

  if (!indexes("digests").includes("idx_digests_week_circle")) {
    d.exec(`
      CREATE TABLE digests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circle_id INTEGER NOT NULL DEFAULT 1,
        week_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO digests_new (circle_id, week_key, payload, created_at)
        SELECT 1, week_key, payload, created_at FROM digests;
      DROP TABLE digests;
      ALTER TABLE digests_new RENAME TO digests;
      CREATE UNIQUE INDEX idx_digests_week_circle ON digests(week_key, circle_id);
    `);
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS circle_peers (
      local_circle_id INTEGER NOT NULL REFERENCES circle(id) ON DELETE CASCADE,
      peer_node_id TEXT NOT NULL,
      remote_mesh_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (local_circle_id, peer_node_id)
    );
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_members_circle ON members(circle_id)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_notes_circle ON notes(circle_id)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_events_circle ON events(circle_id)`);
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
  return "abba-" + Buffer.from(bytes).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
}

// Unique, unguessable user IDs (usr-…). Shown in Account; owners can add
// specific users to the circle by ID instead of sharing the invite code.
export function randomUserId(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  return "usr-" + Buffer.from(bytes).toString("base64url");
}
export function isUserId(s: string): boolean {
  return /^usr-[A-Za-z0-9_-]{16,}$/.test(String(s || "").trim());
}

export function randomMeshId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return "cir-" + Buffer.from(bytes).toString("base64url");
}
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export function inviteExpiryIso(): string {
  return new Date(Date.now() + INVITE_TTL_MS).toISOString();
}
