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
  gidFor, remoteMember, publishNote, publishReaction, publishComment,
} from "./meshbridge";
import { nowIso, randomInviteCode } from "./db";

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

export function migrateCircle(db: Database, mesh: MeshStore, ownerId: number): { migratedNotes: number; inviteCode: string } {
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
  db.query("UPDATE circle SET invite_code = ? WHERE id = 1").run(inviteCode);

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
  return { migratedNotes: migrated, inviteCode };
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
