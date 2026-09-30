# Abba — a quiet notepad for you and your circle

A markdown notepad for an executive, built on the **S.E.F.U. software philosophy**:

- **Soulfulness** (empathy) — written for humans, not feeds. Warm paper-and-ink design, gentle language, presence without surveillance.
- **Effectiveness** (impact) — ideas move through a lifecycle (seed → sprout → in motion → decided) instead of accumulating in a drawer.
- **Flow** (consistency) — capture in seconds, drafts auto-save, markdown with zero friction.
- **Unity** (togetherness) — one intimate circle (capped at 12), shared ideas, warm reactions, a weekly letter.

**Agent-native, agent invisible.** Abba has an intelligence layer (`src/mind.ts`) that auto-titles notes, finds related ideas, composes the weekly digest, and surfaces kind nudges. It never announces itself — no chat widget, no "AI" labels, no sparkle icons. Everything appears as ordinary, calm interface. See `PHILOSOPHY.md`.

## Run

Bun + zero dependencies + SQLite. Port 3013.

```bash
bun src/server.ts
# env: ABBA_PORT=3013  ABBA_DATA=./data
```

Open `http://localhost:3013` — start a circle (you're the owner), share the invite code, and your circle joins by name. No passwords; the circle is intimate by design.

## What it does

Modeled after Apple Notes — folders, large titles, hairlines, quiet yellow:

- **Folders** — a personal greeting, then *My Notepad*, *The Circle*, and *Weekly Letters*, each with a count
- **Notes lists** — title + "date · status — excerpt" rows, per-folder search, floating compose button (composing inside The Circle shares immediately)
- **Note view** — calm reading type, your presence pill floats above the tab bar (tap: zen status icons, rest/share, and reactions fan out over the interface), related notes, conversation, export. ` ```mermaid ` fenced blocks render as diagrams (flowcharts, sequence diagrams, and more) in Abba's warm theme, light and dark — the library is vendored locally, so it works offline and no CDN is ever contacted
- **Weekly Letters** — every digest edition on a shelf, newest first, each reading like a short editorial letter
- **Circle** — members with quiet presence, invite code card (owner can rotate it)
- **Nudges** — small, dismissible, never badges: stale sprouts, unread ideas

## Layout

```
src/server.ts   HTTP API + static serving
src/db.ts       SQLite schema & bootstrap
src/mind.ts     the invisible intelligence: auto-title, related, digest, nudges
public/         mobile-first SPA (zero dependencies)
tests/          API end-to-end (real HTTP) + mind unit tests
scripts/        screenshot helpers (dev only)
```

## Tests

```bash
bun test   # 77 tests: circle lifecycle + mind unit + two-instance mesh sync (invite + knock)
```

## Mesh sync (peer-to-peer)

Abba embeds a [mesh](https://github.com/sefuwunder/mesh) node (`src/mesh/` —
ed25519 identity, signed KV, gossip). Peer two Abba instances and their shared
circle notes replicate over each instance's Cloudflare tunnel:

- **Circle → Mesh sync** (owner only): create an instance invite on one Abba,
  paste it into the other's Join — or **Peer by URL**: paste the other
  instance's URL (e.g. its Cloudflare tunnel address) and knock; the remote's
  identity is self-verifying (node id = hash of its pubkey), and it adds you
  back automatically. Peering is mutual — both sides sync both ways.
- `./tunnel.sh` runs `cloudflared tunnel --url http://localhost:3013`,
  captures the public URL, and writes it to `.env` as `ABBA_PUBLIC_URL`.
  Run it on each box you want reachable, restart Abba, then peer by URL.
  (Quick-tunnel hostnames change on restart — use a named tunnel for a
  stable address.)
- Only **shared** notes leave the instance; the private notepad never syncs.
  Unshare and delete publish retractions so peers drop the note.
- Notes sync as single-writer snapshots (last-writer-wins); reactions use one
  key per reactor node and comments are immutable payloads, so neither is ever
  lost to a concurrent edit.
- Sync runs every 30s; **Sync now** forces a round. All payloads are
  signature-checked before they touch the database.

Each instance needs its public tunnel address:

```bash
ABBA_PUBLIC_URL=https://abba-you.trycloudflare.com ABBA_PORT=3013 bun src/server.ts
# and in another terminal:
cloudflared tunnel --url http://localhost:3013
```

New env: `ABBA_PUBLIC_URL` (falls back to `PUBLIC_URL`), `ABBA_PORT`, `ABBA_DATA`.
The mesh identity lives at `$ABBA_DATA/identity.json`, sync state in
`$ABBA_DATA/mesh.db`.

## Circle admin (owner only)

**Migrate** moves the circle's content — your notes plus shared notes — into a
fresh, empty circle with a new invite code. Everyone but you starts over;
migrated authors show as "from the old circle". Remote (mesh-synced) notes are
left to re-sync from their origin peers. Peered instances converge on the new
copies via tombstones + fresh snapshots.

**Burn** destroys the circle on this Abba — members, notes, everything — and
returns to the welcome screen. Shared notes are tombstoned first so connected
peers drop them; the tombstones persist in the local mesh KV so even a later
re-peer converges on "deleted" instead of resurrecting notes. Type `BURN` to
confirm. There is no undo.

**Reset** (owner, Danger zone) is the factory reset: it wipes the circle,
notes, members, the mesh blocklist — and mints a brand-new mesh identity with
empty sync state. The instance is indistinguishable from a fresh install.
Unlike burn, no tombstones go out; peered copies simply keep what they already
synced.

**Starting over from the welcome screen:** "Or start a brand new circle"
wipes and restarts in one step. It's owner-only — except when the owner never
set a secret (pre-secrets accounts): then nobody can prove ownership, so the
wipe itself is the recovery path (it locks again as soon as the new owner sets
one).

## Forking as a non-host (migrate to your own circle)

Any member can **Migrate to your own circle** — instead of restructuring in
place (owner behavior), they download a migration bundle: their notes (private
and shared, with reactions and comment threads), frozen links to notes that
were shared with them, and their password-hash credential. Importing the bundle
on a fresh Abba (`POST /api/circle/import`, or the welcome screen's import
card) starts a brand-new circle with them as **host**.

- Linked notes are read-only — visible, removable, but never editable, reactable,
  or commentable. Deleting one removes only the local link.
- Links never update: the origin circle's node is blocklisted
  (`mesh_blocked_nodes`), so no new shared notes flow in from prior circles —
  even if the instances later peer.

## Account secrets (re-open with a password)

Bearer tokens live in the browser — lose the browser data and the account is
locked out. A secret fixes that:

- **Circle → Account → Set secret** stores an argon2id hash on your member row
  (never the secret itself).
- Signed out? The welcome screen's **"Re-open with a secret"** takes your name
  + secret and hands back your token.
- The credential (name, color, **hash**) also syncs through the mesh as
  `abba:member:<node>:<id>`, so the account re-opens on any peered instance —
  even one that never saw you join. The recreated row is always a plain member
  with a fresh token; bearer tokens never cross the wire.

Security notes: the hash is visible to peered instances by design, so make the
secret a real passphrase — anyone holding the hash can brute-force it offline.
The re-open endpoint is rate-limited (10 tries/minute/IP) and answers
ambiguously. Remote (synced) shadow members can never be re-opened.

## Notes

- One circle per Abba instance. Data lives in `./data/abba.db` (gitignored).
- Reduced-motion supported. Muted terracotta palette; nothing shouts.
