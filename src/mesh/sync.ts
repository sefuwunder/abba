// sync.ts — pull gossip. Every entry that crosses the wire is signature-checked
// against the known peer's pubkey before it touches the database. Works over
// plain HTTPS, which is exactly what a Cloudflare tunnel gives each node.
import type { MeshStore, PeerRow, LogEntry } from "./store";

async function getJson(url: string, timeoutMs = 9000): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} <- ${url}`);
  return r.json();
}

export interface SyncReport {
  peer: string; ok: boolean; error?: string;
  logEntries: number; kvApplied: number; blobsFetched: number; peersLearned: number;
}

export async function syncWithPeer(store: MeshStore, peer: PeerRow): Promise<SyncReport> {
  const rep: SyncReport = { peer: peer.id, ok: false, logEntries: 0, kvApplied: 0, blobsFetched: 0, peersLearned: 0 };
  try {
    const base = peer.url.replace(/\/+$/, "");
    const state = await getJson(base + "/api/sync/state");
    if (state.id !== peer.id || state.pubkey !== peer.pubkey) throw new Error("identity mismatch at " + base);

    // 1. signed log entries we're missing (only from peers we know)
    const heads = store.getLogHeads();
    for (const [pid, rseq] of Object.entries<number>(state.logHeads || {})) {
      const lseq = heads[pid] || 0;
      if (typeof rseq === "number" && rseq > lseq) {
        const entries = await getJson(`${base}/api/sync/log/${encodeURIComponent(pid)}?since=${lseq}&limit=500`) as LogEntry[];
        for (const e of entries || []) if (store.insertLogEntry(e)) rep.logEntries++;
      }
    }

    // 2. KV rows (last-writer-wins, signature-checked in mergeKv)
    const kv = await getJson(base + "/api/sync/kv");
    for (const row of kv || []) {
      if (store.mergeKv(row.k, row.v, row.ts, row.peer, row.sig) === "applied") rep.kvApplied++;
    }

    // 3. pinned blobs we don't have yet (content-addressed: hash IS the check)
    for (const h of (state.pinned || []).slice(0, 200)) {
      if (typeof h === "string" && !store.hasBlob(h)) {
        const r = await fetch(`${base}/api/blobs/${h}`, { signal: AbortSignal.timeout(30000) });
        if (r.ok) {
          store.putBlob(new Uint8Array(await r.arrayBuffer()));
          rep.blobsFetched++;
        }
      }
    }

    // 4. transitive peer discovery (friends of friends)
    const others = await getJson(base + "/api/sync/peers");
    for (const p of (others || []).slice(0, 100)) {
      if (p && p.id && p.id !== store.identity.id && !store.getPeer(p.id) && p.url && p.pubkey) {
        try { store.addPeer(p.id, p.url, p.pubkey, p.name || "", peer.id); rep.peersLearned++; }
        catch { /* id/pubkey mismatch — skip */ }
      }
    }

    store.touchPeer(peer.id, true);
    rep.ok = true;
  } catch (e: any) {
    rep.error = String(e?.message || e);
    store.touchPeer(peer.id, false);
  }
  return rep;
}

export async function gossipRound(store: MeshStore): Promise<SyncReport[]> {
  const out: SyncReport[] = [];
  for (const p of store.listPeers()) out.push(await syncWithPeer(store, p));
  return out;
}
