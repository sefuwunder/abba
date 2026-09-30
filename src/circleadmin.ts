// circleadmin.ts — circle burning and migration (owner only).
//
// migrate: moves the circle's content (the owner's notes + shared notes of
//          local members) into a fresh, empty circle: new invite code, members
//          start over. Remote (mesh-synced) notes are left to re-sync from
//          their origin peers. Old snapshots are tombstoned so peers converge.
// burn:    destroys the circle on this instance — members, notes, everything.
//          Shared notes are tombstoned first so connected peers drop them;
//          the instance returns to the welcome screen.
import type { Database } from "bun:sqlite";
import type { MeshStore } from "./mesh/store";
import {
  gidFor, remoteMember, publishNote, publishReaction, publishComment, resetMeshNode,
  publishCircleInvite,
} from "./meshbridge";
import { nowIso, randomToken, randomInviteCode, inviteExpiryIso } from "./db";

function tombstone(mesh: MeshStore, db: Database, noteId: number): void {
  const n = db.query("SELECT gid, shared FROM notes WHERE id = ?").get(noteId) as any;
  if (!n || !n.shared) return;
  const gid = n.gid || gidFor(mesh, db, noteId);
  mesh.putKv(`abba:note:${gid}`, JSON.stringify({
    gid, deleted: true, updatedAt: nowIso(), originNode: mesh.identity.id,
  }));
}

function ensureMigratedMember(db: Database, oldId: number, name: string, color: string): any {
  const token = `migrated:${oldId}:${name}`;
  let r = db.query("SELECT * FROM members WHERE token = ?").get(token) as any;
  if (!r) {
    const res = db.query(
      "INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES (?, ?, ?, 'migrated', ?, '')",
    ).run(String(name).slice(0, 40) || "Someone", color || "#A08C5B", token, nowIso());
    r = db.query("SELECT * FROM members WHERE id = ?").get(Number(res.lastInsertRowid));
  }
  return r;
}

export function migrateCircle(db: Database, mesh: MeshStore, ownerId: number): { migratedNotes: number; inviteCode: string; inviteExpiresAt: string } {
  // 1. collect migratable notes: the owner's everything + local members' shared notes.
  //    Remote (mesh) notes are skipped — they re-sync from their origin peers.
  const notes = db.query(`SELECT n.*, m.name AS author_name, m.color AS author_color, m.role AS author_role
    FROM notes n JOIN members m ON m.id = n.member_id
    WHERE (n.member_id = ? OR n.shared = 1) AND m.role != 'remote'`).all(ownerId) as any[];
  const bundle = notes.map((n) => ({
    note: n,
    reactions: db.query(`SELECT r.*, m.name AS by_name, m.color AS by_color FROM reactions r
      JOIN members m ON m.id = r.member_id WHERE r.note_id = ?`).all(n.id) as any[],
    comments: db.query(`SELECT c.*, m.name AS by_name, m.color AS by_color FROM comments c
      JOIN members m ON m.id = c.member_id WHERE c.note_id = ? ORDER BY c.id ASC`).all(n.id) as any[],
  }));

  // 2. tombstone old shared snapshots so peers drop them
  for (const { note } of bundle) tombstone(mesh, db, note.id);

  // 3. wipe — keep the owner and remote shadows; fresh invite code
  db.query("DELETE FROM reactions").run();
  db.query("DELETE FROM comments").run();
  db.query("DELETE FROM notes").run();
  db.query("DELETE FROM events").run();
  db.query("DELETE FROM digests").run();
  db.query("DELETE FROM nudges_seen").run();
  db.query("DELETE FROM mesh_seen").run();
  db.query("DELETE FROM members WHERE id != ? AND role != 'remote'").run(ownerId);
  const inviteCode = randomInviteCode();
  const inviteExpiresAt = inviteExpiryIso();
  db.query("UPDATE circle SET invite_code = ?, invite_expires_at = ? WHERE id = 1").run(inviteCode, inviteExpiresAt);
  try { publishCircleInvite(mesh, db); } catch { /* ignore */ }

  // 4. re-insert with attribution preserved
  const migratedAs = new Map<number, number>(); // old member id -> migrated shadow id
  const asMember = (oldId: number, name: string, color: string): number => {
    if (oldId === ownerId) return ownerId;
    const stillThere = db.query("SELECT id FROM members WHERE id = ?").get(oldId) as any;
    if (stillThere) return oldId; // remote shadow survived the wipe
    if (!migratedAs.has(oldId)) {
      migratedAs.set(oldId, ensureMigratedMember(db, oldId, name, color).id);
    }
    return migratedAs.get(oldId)!;
  };
  const insertNote = db.query(`INSERT INTO notes
    (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let migrated = 0;
  for (const { note, reactions, comments } of bundle) {
    const memberId = asMember(note.member_id, note.author_name, note.author_color);
    const r = insertNote.run(memberId, note.title, note.body, note.tags, note.status,
      note.shared, note.read_mins, note.created_at, note.updated_at);
    const newId = Number(r.lastInsertRowid);
    for (const rc of reactions) {
      const byId = asMember(rc.member_id, rc.by_name, rc.by_color);
      db.query("INSERT OR IGNORE INTO reactions (note_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)")
        .run(newId, byId, rc.kind, rc.created_at);
    }
    const insertComment = db.query("INSERT INTO comments (note_id, member_id, body, created_at) VALUES (?, ?, ?, ?)");
    for (const c of comments) {
      const byId = asMember(c.member_id, c.by_name, c.by_color);
      insertComment.run(newId, byId, c.body, c.created_at);
    }
    // 5. re-publish shared notes so the mesh converges on the new copies
    if (note.shared) {
      publishNote(mesh, db, newId);
      for (const rc of db.query("SELECT member_id, kind FROM reactions WHERE note_id = ?").all(newId) as any[]) {
        const mem = db.query("SELECT name, color FROM members WHERE id = ?").get(rc.member_id) as any;
        publishReaction(mesh, db, newId, mem, rc.kind, true);
      }
      for (const c of db.query("SELECT id FROM comments WHERE note_id = ?").all(newId) as any[]) {
        publishComment(mesh, db, c.id);
      }
    }
    migrated++;
  }
  return { migratedNotes: migrated, inviteCode, inviteExpiresAt };
}

export function burnCircle(db: Database, mesh: MeshStore): void {
  // 1. tombstone every shared note so connected peers drop them on next pull.
  //    The tombstones stay in the local mesh KV (nothing deletes them), so even
  //    a later re-peer converges on "deleted" instead of resurrecting notes.
  const shared = db.query("SELECT id, gid FROM notes WHERE shared = 1").all() as any[];
  for (const n of shared) {
    const gid = n.gid || (mesh.identity.id + ":" + n.id);
    mesh.putKv(`abba:note:${gid}`, JSON.stringify({
      gid, deleted: true, updatedAt: nowIso(), originNode: mesh.identity.id,
    }));
  }
  // 2. unpeer — a burned circle syncs with no one
  for (const p of mesh.listPeers()) mesh.removePeer(p.id);
  // 3. wipe everything; the instance returns to the welcome screen
  for (const t of ["reactions", "comments", "notes", "events", "digests", "nudges_seen", "mesh_seen", "members"]) {
    db.query(`DELETE FROM ${t}`).run();
  }
  db.query("DELETE FROM circle").run();
}

/** Factory reset: burn the circle AND the mesh node itself — new identity,
    empty KV/peers, cleared blocklist. The instance is indistinguishable from
    a fresh install. Unlike burn, no tombstones go out: there is no identity
    left to speak for the old circle. */
export function resetAbba(db: Database, _mesh: MeshStore): void {
  for (const t of ["reactions", "comments", "notes", "events", "digests", "nudges_seen", "mesh_seen", "mesh_blocked_nodes", "members"]) {
    db.query(`DELETE FROM ${t}`).run();
  }
  db.query("DELETE FROM circle").run();
  resetMeshNode();
}

// ---- member migration: fork to your own circle --------------------------------
// A non-host keeps their data, becomes host of a fresh circle, and carries
// frozen links to notes that were shared with them (plus their comments).
// The origin circle's node is blocklisted, so no new shared notes flow in
// afterwards — even if the instances later peer.

export function exportMemberBundle(db: Database, mesh: MeshStore, memberId: number): any {
  const me = db.query("SELECT * FROM members WHERE id = ?").get(memberId) as any;
  if (!me) throw new Error("No such member.");
  const notes = db.query("SELECT * FROM notes WHERE member_id = ? AND link_origin IS NULL ORDER BY id ASC").all(memberId) as any[];
  const bundleNotes = notes.map((n) => ({
    title: n.title, body: n.body, tags: JSON.parse(n.tags || "[]"), status: n.status,
    shared: n.shared === 1, readMins: n.read_mins, createdAt: n.created_at, updatedAt: n.updated_at,
    reactions: db.query(`SELECT r.kind, r.created_at, m.name AS by_name, m.color AS by_color FROM reactions r
      JOIN members m ON m.id = r.member_id WHERE r.note_id = ?`).all(n.id),
    comments: db.query(`SELECT c.body, c.created_at, m.name AS by_name, m.color AS by_color FROM comments c
      JOIN members m ON m.id = c.member_id WHERE c.note_id = ? ORDER BY c.id ASC`).all(n.id),
  }));
  // frozen links: shared notes by others that were visible to me
  const shared = db.query(`SELECT n.*, m.name AS author_name, m.color AS author_color FROM notes n
    JOIN members m ON m.id = n.member_id
    WHERE n.shared = 1 AND n.member_id != ? AND n.link_origin IS NULL`).all(memberId) as any[];
  const links = shared.map((n) => ({
    gid: n.gid || null,
    title: n.title, body: n.body, tags: JSON.parse(n.tags || "[]"), status: n.status,
    readMins: n.read_mins, createdAt: n.created_at, updatedAt: n.updated_at,
    author: { name: n.author_name, color: n.author_color },
    originNode: n.gid ? String(n.gid).split(":")[0] : mesh.identity.id,
    reactions: db.query(`SELECT r.kind, r.created_at, m.name AS by_name, m.color AS by_color FROM reactions r
      JOIN members m ON m.id = r.member_id WHERE r.note_id = ?`).all(n.id),
    comments: db.query(`SELECT c.body, c.created_at, m.name AS by_name, m.color AS by_color FROM comments c
      JOIN members m ON m.id = c.member_id WHERE c.note_id = ? ORDER BY c.id ASC`).all(n.id),
  }));
  const circle = db.query("SELECT name FROM circle WHERE id = 1").get() as any;
  return {
    version: 1, exportedAt: nowIso(),
    origin: { nodeId: mesh.identity.id, circleName: circle?.name || "a circle" },
    profile: { name: me.name, color: me.color, passwordHash: me.password_hash || null },
    notes: bundleNotes, links,
  };
}

export function importBundle(db: Database, mesh: MeshStore, bundle: any, circleName?: string): {
  token: string; memberId: number; circle: { name: string; inviteCode: string };
} {
  if (!bundle || bundle.version !== 1 || !bundle.profile || !String(bundle.profile.name || "").trim()) {
    throw new Error("Bad migration bundle.");
  }
  const name = String(bundle.profile.name).slice(0, 40);
  const color = String(bundle.profile.color || "#C0765A");
  const cname = String(circleName || `${name}'s Circle`).slice(0, 60);
  const code = randomInviteCode();
  db.query("INSERT INTO circle (id, name, invite_code, invite_expires_at, created_at) VALUES (1, ?, ?, ?, ?)")
    .run(cname, code, inviteExpiryIso(), nowIso());
  const token = randomToken("abba_");
  const res = db.query(
    "INSERT INTO members (name, color, token, role, created_at, last_seen, password_hash) VALUES (?, ?, ?, 'owner', ?, ?, ?)",
  ).run(name, color, token, nowIso(), nowIso(), bundle.profile.passwordHash || null);
  const ownerId = Number(res.lastInsertRowid);

  // cut the old circle's share stream: its future notes stay out, links stay frozen
  const originNode = bundle.origin?.nodeId;
  if (originNode && originNode !== mesh.identity.id) {
    db.query("INSERT OR IGNORE INTO mesh_blocked_nodes (node_id, reason, created_at) VALUES (?, ?, ?)")
      .run(originNode, "migrated from " + (bundle.origin.circleName || "a circle"), nowIso());
  }

  const shadowFor = (bname: string, bcolor: string): number => {
    const t = db.query("SELECT id FROM members WHERE token = ?").get(`migrated:import:${bname}`) as any;
    if (t) return t.id;
    const r = db.query(
      "INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES (?, ?, ?, 'migrated', ?, '')",
    ).run(String(bname).slice(0, 40) || "Someone", bcolor || "#A08C5B", `migrated:import:${bname}`, nowIso());
    return Number(r.lastInsertRowid);
  };
  const insertNote = db.query(`INSERT INTO notes
    (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at, gid, link_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertReaction = db.query("INSERT OR IGNORE INTO reactions (note_id, member_id, kind, created_at) VALUES (?, ?, ?, ?)");
  const insertComment = db.query("INSERT INTO comments (note_id, member_id, body, created_at) VALUES (?, ?, ?, ?)");

  // my notes — I own them here now
  for (const n of bundle.notes || []) {
    const r = insertNote.run(ownerId, n.title || "", n.body || "", JSON.stringify(n.tags || []),
      n.status || "seed", n.shared ? 1 : 0, n.readMins || 1,
      n.createdAt || nowIso(), n.updatedAt || nowIso(), null, null);
    const nid = Number(r.lastInsertRowid);
    for (const rc of n.reactions || []) {
      const byId = rc.by_name === name ? ownerId : shadowFor(rc.by_name, rc.by_color);
      insertReaction.run(nid, byId, rc.kind, rc.createdAt || nowIso());
    }
    for (const c of n.comments || []) {
      const byId = c.by_name === name ? ownerId : shadowFor(c.by_name, c.by_color);
      insertComment.run(nid, byId, c.body || "", c.createdAt || nowIso());
    }
    if (n.shared) publishNote(mesh, db, nid);
  }
  // frozen links to notes that were shared with me
  for (const l of bundle.links || []) {
    const author = remoteMember(db, l.originNode || "import", l.author?.name || "Someone", l.author?.color);
    const r = insertNote.run(author.id, l.title || "", l.body || "", JSON.stringify(l.tags || []),
      l.status || "seed", 1, l.readMins || 1, l.createdAt || nowIso(), l.updatedAt || nowIso(),
      l.gid || null,
      JSON.stringify({ name: l.author?.name || "Someone", circle: bundle.origin?.circleName || "a circle", gid: l.gid || null }));
    const nid = Number(r.lastInsertRowid);
    for (const rc of l.reactions || []) {
      const byId = rc.by_name === name ? ownerId : shadowFor(rc.by_name, rc.by_color);
      insertReaction.run(nid, byId, rc.kind, rc.createdAt || nowIso());
    }
    for (const c of l.comments || []) {
      const byId = c.by_name === name ? ownerId : shadowFor(c.by_name, c.by_color);
      insertComment.run(nid, byId, c.body || "", c.createdAt || nowIso());
    }
  }
  try { publishCircleInvite(mesh, db); } catch { /* ignore */ }
  return { token, memberId: ownerId, circle: { name: cname, inviteCode: code } };
}
