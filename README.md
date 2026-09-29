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
- **Note view** — calm reading type, the single response-menu bubble (status + reactions), related notes, conversation, export
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
bun test   # 36 tests: full circle lifecycle over real HTTP
```

## Notes

- One circle per Abba instance. Data lives in `./data/abba.db` (gitignored).
- Reduced-motion supported. Muted terracotta palette; nothing shouts.
