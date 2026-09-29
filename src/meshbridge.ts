// meshbridge.ts — Abba <-> mesh bridge. Shared circle notes replicate between
// peered Abba instances over the embedded mesh node (same process, same tunnel).
//
// Sync model — everything lives in the mesh KV, all signed, all verified:
//   abba:note:<originNode>:<localId>   full note snapshot; single-writer (the
//                                     origin instance), last-writer-wins.
//   abba:react:<gid>:<node>:<kind>     one key per reactor node: reactions can
//                                     never clobber each other.
//   abba:comment:<gid>:<cgid>          immutable comment payloads.
// Only shared notes leave the instance. Private notepad notes never sync.
// Unshare / delete publish retractions so remotes drop the note.
import type { Database } from "bun:sqlite";
import { MeshStore } from "./mesh/store";
import { gossipRound } from "./mesh/sync";
import { getDb, dataDirPath, nowIso } from "./db";

export function publicUrl(): string {
  const u = process.env.ABBA_PUBLIC_URL || process.env.PUBLIC_URL ||
    `http://localhost:${process.env.ABBA_PORT || 3013}`;
  return u.replace(/\/+$/, "");
}

let mesh: MeshStore | null = null;
export function getMesh(): MeshStore {
  if (!mesh) mesh = new MeshStore(dataDirPath(), publicUrl());
  return mesh;
}

export function noteGid(m: MeshStore, noteId: number): string {
  return m.identity.id + ":" + noteId;
}

/** Backfill globally-unique ids for notes created before mesh. */
export function ensureNoteGids(db: Database, m: MeshStore): void {
  db.query("UPDATE notes SET gid = ? || ':' || id WHERE gid IS NULL OR gid = ''").run(m.identity.id);
}

/** gid for a note, backfilling the column when this is its first sync. */
export function gidFor(m: MeshStore, db: Database, noteId: number): string {
  const n = db.query("SELECT gid FROM notes WHERE id = ?").get(noteId) as any;
  if (n?.gid) return n.gid;
  const gid = noteGid(m, noteId);
  db.query("UPDATE notes SET gid = ? WHERE id = ?").run(gid, noteId);
  return gid;
}

/** A member row standing in for someone on a peered instance. Never logs in. */
export function remoteMember(db: Database, nodeId: string, name: string, color: string): any {
  const token = `mesh:${nodeId}:${name}`;
  let r = db.query("SELECT * FROM members WHERE token = ?").get(token) as any;
  if (!r) {
    const res = db.query(
      "INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES (?, ?, ?, 'remote', ?, '')",
    ).run(String(name).slice(0, 40) || "Someone", String(color || "#A08C5B"), token, nowIso());
    r = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
  }
  return r;
}

function noteRow(db: Database, noteId: number): any {
  return db.query(`SELECT n.*, m.name AS member_name, m.color AS member_color FROM notes n
    JOIN members m ON m.id = n.member_id WHERE n.id = ?`).get(noteId) as any;
}

/** Publish a note snapshot — only if shared. Unshared/deleted -> retraction. */
export function publishNote(m: MeshStore, db: Database, noteId: number): void {
  const n = noteRow(db, noteId);
  if (!n) return;
  const gid = gidFor(m, db, n.id);
  const key = `abba:note:${gid}`;
  if (!n.shared) {
    m.putKv(key, JSON.stringify({ gid, shared: 0, retracted: true, updatedAt: n.updated_at, originNode: m.identity.id }));
    return;
  }
  m.putKv(key, JSON.stringify({
    gid, title: n.title, body: n.body, tags: JSON.parse(n.tags || "[]"),
    status: n.status, shared: 1, readMins: n.read_mins,
    createdAt: n.created_at, updatedAt: n.updated_at,
    originNode: m.identity.id,
    author: { name: n.member_name, color: n.member_color },
  }));
}

/** Publish a tombstone for a deleted shared note. Call BEFORE the local delete. */
export function publishNoteTombstone(m: MeshStore, db: Database, noteId: number): void {
  const n = noteRow(db, noteId);
  if (!n || !n.shared) return;
  const gid = gidFor(m, db, n.id);
  m.putKv(`abba:note:${gid}`, JSON.stringify({ gid, deleted: true, updatedAt: nowIso(), originNode: m.identity.id }));
}

export function publishReaction(m: MeshStore, db: Database, noteId: number, member: any, kind: string, on: boolean): void {
  const n = db.query("SELECT shared FROM notes WHERE id = ?").get(noteId) as any;
  if (!n || !n.shared) return;
  const gid = gidFor(m, db, noteId);
  m.putKv(`abba:react:${gid}:${m.identity.id}:${kind}`, JSON.stringify({
    on, by: { name: member.name, color: member.color }, ts: Date.now(),
  }));
}

export function publishComment(m: MeshStore, db: Database, commentId: number): void {
  const c = db.query(`SELECT c.*, n.shared AS note_shared FROM comments c
    JOIN notes n ON n.id = c.note_id WHERE c.id = ?`).get(commentId) as any;
  if (!c || !c.note_shared) return;
  const noteGid = gidFor(m, db, c.note_id);
  const cgid = m.identity.id + ":" + c.id;
  db.query("UPDATE comments SET remote_gid = ? WHERE id = ?").run(cgid, c.id);
  const mem = db.query("SELECT name, color FROM members WHERE id = ?").get(c.member_id) as any;
  m.putKv(`abba:comment:${noteGid}:${cgid}`, JSON.stringify({
    body: c.body, by: { name: mem.name, color: mem.color }, createdAt: c.created_at,
  }));
}

// ---- apply -----------------------------------------------------------------

function applyNoteSnapshot(db: Database, m: MeshStore, row: any): boolean {
  const snap = JSON.parse(row.v);
  if (snap.originNode === m.identity.id) return true; // own — already local
  const gid = String(snap.gid || "");
  if (!gid) return false;
  const existing = db.query("SELECT * FROM notes WHERE gid = ?").get(gid) as any;
  if (existing && existing.link_origin) return true; // frozen migration link — never updated
  if (snap.deleted || snap.retracted || !snap.shared) {
    if (existing) db.query("DELETE FROM notes WHERE id = ?").run(existing.id);
    return true;
  }
  if (existing && existing.updated_at >= String(snap.updatedAt || "")) return true; // stale
  const author = remoteMember(db, snap.originNode, snap.author?.name || "Someone", snap.author?.color);
  if (existing) {
    db.query(`UPDATE notes SET member_id = ?, title = ?, body = ?, tags = ?, status = ?,
      shared = 1, read_mins = ?, updated_at = ? WHERE id = ?`)
      .run(author.id, snap.title, snap.body, JSON.stringify(snap.tags || []),
        snap.status, snap.readMins || 1, snap.updatedAt, existing.id);
  } else {
    db.query(`INSERT INTO notes (member_id, title, body, tags, status, shared, read_mins,
      created_at, updated_at, gid) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(author.id, snap.title, snap.body, JSON.stringify(snap.tags || []),
        snap.status, snap.readMins || 1, snap.createdAt, snap.updatedAt, gid);
  }
  return true;
}

function applyReaction(db: Database, m: MeshStore, row: any): boolean {
  const parts = String(row.k).slice("abba:react:".length).split(":");
  if (parts.length !== 4) return false;
  const [originNode, localId, node, kind] = parts;
  if (node === m.identity.id) return true;
  const val = JSON.parse(row.v);
  const note = db.query("SELECT id FROM notes WHERE gid = ?").get(originNode + ":" + localId) as any;
  if (!note) return false; // snapshot hasn't arrived yet — retry next round
  const by = remoteMember(db, node, val.by?.name || "Someone", val.by?.color);
  if (val.on) {
    db.query("INSERT OR IGNORE INTO reactions (note_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)")
      .run(note.id, by.id, kind, new Date(val.ts || Date.now()).toISOString());
  } else {
    db.query("DELETE FROM reactions WHERE note_id = ? AND member_id = ? AND kind = ?")
      .run(note.id, by.id, kind);
  }
  return true;
}

function applyComment(db: Database, m: MeshStore, row: any): boolean {
  const parts = String(row.k).slice("abba:comment:".length).split(":");
  if (parts.length !== 4) return false;
  const [originNode, localId, cnode, clocal] = parts;
  if (cnode === m.identity.id) return true;
  const cgid = cnode + ":" + clocal;
  const val = JSON.parse(row.v);
  const note = db.query("SELECT id FROM notes WHERE gid = ?").get(originNode + ":" + localId) as any;
  if (!note) return false;
  const dup = db.query("SELECT 1 FROM comments WHERE remote_gid = ?").get(cgid);
  if (dup) return true;
  const by = remoteMember(db, cnode, val.by?.name || "Someone", val.by?.color);
  db.query("INSERT INTO comments (note_id, member_id, body, created_at, remote_gid) VALUES (?, ?, ?, ?, ?)")
    .run(note.id, by.id, String(val.body || ""), val.createdAt || nowIso(), cgid);
  return true;
}

/** Pull one gossip round, then fold new mesh state into Abba. Idempotent. */
export function applyMeshUpdates(m: MeshStore, db: Database): number {
  const seen = new Map<string, number>(
    (db.query("SELECT k, ts FROM mesh_seen").all() as any[]).map(r => [r.k, r.ts]),
  );
  const blocked = new Set(
    (db.query("SELECT node_id FROM mesh_blocked_nodes").all() as any[]).map(r => r.node_id),
  );
  // which node a key belongs to (abba:member: credentials are never blocked)
  const nodeFor = (k: string): string | null => {
    const p = k.split(":");
    if (k.startsWith("abba:note:")) return p[2] || null;
    if (k.startsWith("abba:react:") || k.startsWith("abba:comment:")) return p[4] || null;
    return null;
  };
  let changed = 0;
  for (const row of m.listKv()) {
    if (!row.k.startsWith("abba:")) continue;
    if ((seen.get(row.k) || 0) >= row.ts) continue;
    const bn = nodeFor(row.k);
    if (bn && blocked.has(bn)) {
      // migrated away from this circle: its share stream stays out
      db.query("INSERT OR REPLACE INTO mesh_seen (k, ts) VALUES (?, ?)").run(row.k, row.ts);
      continue;
    }
    let applied = false;
    try {
      if (row.k.startsWith("abba:note:")) applied = applyNoteSnapshot(db, m, row);
      else if (row.k.startsWith("abba:react:")) applied = applyReaction(db, m, row);
      else if (row.k.startsWith("abba:comment:")) applied = applyComment(db, m, row);
      else applied = true; // unknown abba: key — ignore
    } catch { applied = false; }
    if (applied) {
      db.query("INSERT OR REPLACE INTO mesh_seen (k, ts) VALUES (?, ?)").run(row.k, row.ts);
      changed++;
    }
  }
  return changed;
}

export async function meshTick(): Promise<void> {
  const m = getMesh();
  const db = getDb();
  try { await gossipRound(m); } catch (e) { console.error("[mesh] gossip:", (e as any)?.message); }
  // a burned (or not-yet-created) circle serves sync but applies nothing
  const circle = db.query("SELECT id FROM circle WHERE id = 1").get();
  if (!circle) return;
  try {
    const n = applyMeshUpdates(m, db);
    if (n) console.log(`[mesh] applied ${n} update(s)`);
  } catch (e) { console.error("[mesh] apply:", (e as any)?.message); }
}

/** Publish a member's credential snapshot so the account can be re-opened
    from the mesh with the secret. Call after a password is set. */
export function publishMemberCredential(m: MeshStore, db: Database, memberId: number): void {
  const mem = db.query("SELECT * FROM members WHERE id = ?").get(memberId) as any;
  if (!mem || !mem.password_hash || mem.role === "remote") return;
  m.putKv(`abba:member:${m.identity.id}:${mem.id}`, JSON.stringify({
    name: mem.name, color: mem.color, role: mem.role,
    passwordHash: mem.password_hash, updatedAt: Date.now(), originNode: m.identity.id,
  }));
}

/** Find the newest mesh credential for a name (any origin but our own). */
export function findMeshCredential(m: MeshStore, name: string): any | null {
  const lower = String(name).toLowerCase();
  let best: any = null;
  for (const row of m.listKv()) {
    if (!row.k.startsWith("abba:member:")) continue;
    try {
      const c = JSON.parse(row.v);
      if (c.originNode === m.identity.id) continue;
      if (String(c.name || "").toLowerCase() !== lower || !c.passwordHash) continue;
      if (!best || row.ts > best.ts) best = { ...c, ts: row.ts };
    } catch { /* skip malformed */ }
  }
  return best;
}

/** The peer-facing sync protocol (no auth — payloads are signed). */
export function meshProtocol(m: MeshStore, req: Request, url: URL): Response | null {
  const path = url.pathname;
  const q = url.searchParams;
  const json = (d: unknown, s = 200) =>
    new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (path === "/api/sync/state" && req.method === "GET") {
    return json({
      id: m.identity.id, pubkey: m.identity.publicKey,
      logHeads: m.getLogHeads(), pinned: m.pinnedHashes(),
      peerCount: m.listPeers().length,
    });
  }
  const sl = path.match(/^\/api\/sync\/log\/([0-9a-f]{32})$/);
  if (sl && req.method === "GET") {
    return json(m.getLog(sl[1], Number(q.get("since") || 0), Number(q.get("limit") || 200)));
  }
  if (path === "/api/sync/kv" && req.method === "GET") return json(m.listKv());
  if (path === "/api/sync/peers" && req.method === "GET") {
    return json(m.listPeers().slice(0, 100).map(p => ({ id: p.id, url: p.url, pubkey: p.pubkey, name: p.name })));
  }
  return null;
}
