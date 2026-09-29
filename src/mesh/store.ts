// store.ts — MeshStore: peers, content-addressed blobs, signed append-only logs,
// last-writer-wins KV, and invite codes. All replication data is signed; the
// invite code is the trust root (bearer credential, like a circle invite).
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadOrCreateIdentity, signData, verifyData, peerIdFor, type Identity } from "./identity";

export interface PeerRow {
  id: string; url: string; pubkey: string; name: string;
  added_at: number; last_seen: number; last_ok: number; via: string | null;
}
export interface LogEntry { peer: string; seq: number; type: string; body: string; ts: number; sig: string; }
export interface KvRow { k: string; v: string; ts: number; peer: string; sig: string; }

export function logCanonical(e: { peer: string; seq: number; type: string; body: string; ts: number }): string {
  return ["mesh-log", e.peer, String(e.seq), e.type, String(e.ts), e.body].join("\n");
}
export function kvCanonical(k: string, v: string, ts: number, peer: string): string {
  return ["mesh-kv", k, v, String(ts), peer].join("\n");
}
export function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, pubkey TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, last_ok INTEGER NOT NULL DEFAULT 0,
  via TEXT
);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS log_entries (
  peer TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, sig TEXT NOT NULL,
  PRIMARY KEY (peer, seq)
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL, peer TEXT NOT NULL, sig TEXT NOT NULL
);`;

export class MeshStore {
  db: Database;
  identity: Identity;
  dataDir: string;
  publicUrl: string;
  startedAt = Date.now();

  constructor(dataDir: string, publicUrl: string) {
    this.dataDir = dataDir;
    this.publicUrl = publicUrl.replace(/\/+$/, "");
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    this.identity = loadOrCreateIdentity(dataDir);
    this.db = new Database(join(dataDir, "mesh.db"));
    this.db.exec(SCHEMA);
  }

  static open(
    dataDir = process.env.MESH_DATA || "./data",
    publicUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.MESH_PORT || 3014}`,
  ): MeshStore {
    return new MeshStore(dataDir, publicUrl);
  }

  now(): number { return Date.now(); }

  // ---- peers ---------------------------------------------------------------
  addPeer(id: string, url: string, pubkey: string, name = "", via: string | null = null): PeerRow {
    if (id !== peerIdFor(pubkey)) throw new Error("peer id does not match pubkey");
    const now = this.now();
    this.db.query(
      `INSERT INTO peers (id, url, pubkey, name, added_at, via) VALUES (?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET url=excluded.url, pubkey=excluded.pubkey, name=excluded.name`,
    ).run(id, url.replace(/\/+$/, ""), pubkey, name, now, via);
    return this.getPeer(id)!;
  }
  getPeer(id: string): PeerRow | null {
    return (this.db.query("SELECT * FROM peers WHERE id = ?").get(id) as PeerRow) || null;
  }
  listPeers(): PeerRow[] {
    return this.db.query("SELECT * FROM peers ORDER BY added_at ASC").all() as PeerRow[];
  }
  removePeer(id: string): boolean {
    return this.db.query("DELETE FROM peers WHERE id = ?").run(id).changes > 0;
  }
  touchPeer(id: string, ok: boolean): void {
    this.db.query("UPDATE peers SET last_seen = ?, last_ok = ? WHERE id = ?")
      .run(this.now(), ok ? this.now() : 0, id);
  }

  // ---- blobs (content-addressed) -------------------------------------------
  blobPath(hash: string): string {
    return join(this.dataDir, "blobs", hash.slice(0, 2), hash.slice(2));
  }
  hasBlob(hash: string): boolean {
    return (this.db.query("SELECT 1 FROM blobs WHERE hash = ?").get(hash) as any) !== null;
  }
  putBlob(bytes: Uint8Array): { hash: string; size: number } {
    const hash = sha256hex(bytes);
    const p = this.blobPath(hash);
    if (!existsSync(p)) {
      mkdirSync(join(this.dataDir, "blobs", hash.slice(0, 2)), { recursive: true });
      writeFileSync(p, bytes);
    }
    this.db.query(
      "INSERT INTO blobs (hash, size, created_at, pinned) VALUES (?,?,?,0) ON CONFLICT(hash) DO NOTHING",
    ).run(hash, bytes.length, this.now());
    return { hash, size: bytes.length };
  }
  getBlob(hash: string): Uint8Array | null {
    if (!/^[0-9a-f]{64}$/.test(hash) || !this.hasBlob(hash)) return null;
    const p = this.blobPath(hash);
    if (!existsSync(p)) return null;
    return new Uint8Array(readFileSync(p));
  }
  pinBlob(hash: string, pinned: boolean): boolean {
    return this.db.query("UPDATE blobs SET pinned = ? WHERE hash = ?").run(pinned ? 1 : 0, hash).changes > 0;
  }
  listBlobs(): { hash: string; size: number; created_at: number; pinned: boolean }[] {
    return (this.db.query("SELECT hash, size, created_at, pinned FROM blobs ORDER BY created_at DESC").all() as any[])
      .map(r => ({ ...r, pinned: r.pinned === 1 }));
  }
  pinnedHashes(limit = 500): string[] {
    return (this.db.query("SELECT hash FROM blobs WHERE pinned = 1 LIMIT ?").all(limit) as any[]).map(r => r.hash);
  }

  // ---- signed append-only log ----------------------------------------------
  appendLog(type: string, body: string): LogEntry {
    const peer = this.identity.id;
    const row = this.db.query("SELECT COALESCE(MAX(seq),0) AS m FROM log_entries WHERE peer = ?").get(peer) as any;
    const e: LogEntry = { peer, seq: row.m + 1, type: String(type || ""), body: String(body ?? ""), ts: this.now(), sig: "" };
    e.sig = signData(this.identity, logCanonical(e));
    this.db.query("INSERT INTO log_entries (peer, seq, type, body, ts, sig) VALUES (?,?,?,?,?,?)")
      .run(e.peer, e.seq, e.type, e.body, e.ts, e.sig);
    return e;
  }
  /** Insert a remote entry after verifying its signature. Returns true if new. */
  insertLogEntry(e: LogEntry): boolean {
    if (!e || typeof e.seq !== "number" || e.seq < 1 || !e.peer || !e.sig) return false;
    const pubkey = e.peer === this.identity.id ? this.identity.publicKey : this.getPeer(e.peer)?.pubkey;
    if (!pubkey) return false; // only replicate from known peers
    if (!verifyData(pubkey, logCanonical(e), e.sig)) return false;
    const r = this.db.query(
      "INSERT OR IGNORE INTO log_entries (peer, seq, type, body, ts, sig) VALUES (?,?,?,?,?,?)",
    ).run(e.peer, e.seq, String(e.type || ""), String(e.body ?? ""), e.ts, e.sig);
    return r.changes > 0;
  }
  getLog(peer?: string, since = 0, limit = 200): LogEntry[] {
    const lim = Math.min(Math.max(limit, 1), 1000);
    if (peer) {
      return this.db.query("SELECT peer, seq, type, body, ts, sig FROM log_entries WHERE peer = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
        .all(peer, since, lim) as LogEntry[];
    }
    return this.db.query("SELECT peer, seq, type, body, ts, sig FROM log_entries WHERE seq > ? ORDER BY ts ASC, peer ASC, seq ASC LIMIT ?")
      .all(since, lim) as LogEntry[];
  }
  getLogHeads(): Record<string, number> {
    const rows = this.db.query("SELECT peer, MAX(seq) AS s FROM log_entries GROUP BY peer").all() as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.peer] = r.s;
    return out;
  }
  logCount(): number {
    return (this.db.query("SELECT COUNT(*) AS c FROM log_entries").get() as any).c;
  }

  // ---- KV (last-writer-wins, signed) ----------------------------------------
  getKv(k: string): KvRow | null {
    return (this.db.query("SELECT * FROM kv WHERE k = ?").get(k) as KvRow) || null;
  }
  listKv(): KvRow[] {
    return this.db.query("SELECT * FROM kv ORDER BY k ASC").all() as KvRow[];
  }
  mergeKv(k: string, v: string, ts: number, peer: string, sig: string): "applied" | "stale" | "bad-sig" | "unknown-peer" {
    const pubkey = peer === this.identity.id ? this.identity.publicKey : this.getPeer(peer)?.pubkey;
    if (!pubkey) return "unknown-peer";
    if (!verifyData(pubkey, kvCanonical(k, v, ts, peer), sig)) return "bad-sig";
    const cur = this.getKv(k);
    if (cur && (cur.ts > ts || (cur.ts === ts && cur.peer >= peer))) return "stale";
    this.db.query("INSERT OR REPLACE INTO kv (k, v, ts, peer, sig) VALUES (?,?,?,?,?)").run(k, v, ts, peer, sig);
    return "applied";
  }
  putKv(k: string, v: string): KvRow {
    const ts = this.now();
    const sig = signData(this.identity, kvCanonical(k, v, ts, this.identity.id));
    this.mergeKv(k, v, ts, this.identity.id, sig);
    return this.getKv(k)!;
  }

  // ---- invites ---------------------------------------------------------------
  createInvite(): string {
    const ts = this.now();
    const payload = { v: 1, id: this.identity.id, url: this.publicUrl, pubkey: this.identity.publicKey, ts };
    const sig = signData(this.identity, [payload.id, payload.url, payload.pubkey, String(payload.ts)].join("\n"));
    return Buffer.from(JSON.stringify({ ...payload, sig })).toString("base64url");
  }
  static parseInvite(code: string): { id: string; url: string; pubkey: string; ts: number } | null {
    try {
      const p = JSON.parse(Buffer.from(String(code).trim(), "base64url").toString("utf8"));
      if (p.v !== 1 || !p.id || !p.url || !p.pubkey || !p.sig || !p.ts) return null;
      if (!verifyData(p.pubkey, [p.id, p.url, p.pubkey, String(p.ts)].join("\n"), p.sig)) return null;
      if (peerIdFor(p.pubkey) !== p.id) return null;
      if (!/^https?:\/\//.test(p.url)) return null;
      return { id: p.id, url: p.url, pubkey: p.pubkey, ts: p.ts };
    } catch {
      return null;
    }
  }
  joinViaInvite(code: string, name = ""): PeerRow {
    const p = MeshStore.parseInvite(code);
    if (!p) throw new Error("bad invite code");
    if (p.id === this.identity.id) throw new Error("that's your own invite");
    return this.addPeer(p.id, p.url, p.pubkey, name);
  }
}
