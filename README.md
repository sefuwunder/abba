# Abba — a quiet notepad

A single-user markdown notepad for an executive, built on the **S.E.F.U. software philosophy**:

- **Soulfulness** (empathy) — written for humans, not feeds. Warm paper-and-ink design, gentle language.
- **Effectiveness** (impact) — ideas move through a lifecycle (seed → sprout → in motion → decided) instead of accumulating in a drawer.
- **Flow** (consistency) — capture in seconds, drafts auto-save, markdown with zero friction.
- **Unity** (togetherness) — sharing is email: send a note to anyone, straight from the notepad.

**Agent-native, agent invisible.** Abba has an intelligence layer (`src/mind.ts`) that auto-titles notes, finds related ideas, composes the weekly digest, and surfaces kind nudges. It never announces itself — no chat widget, no "AI" labels, no sparkle icons. Everything appears as ordinary, calm interface. See `PHILOSOPHY.md`.

## Run

Bun + zero dependencies + SQLite. Port 3013. **Binds to 127.0.0.1 only** — there is no sign-in; access control lives one layer up (Deck's TOTP gate).

```bash
bun src/server.ts
# env: ABBA_PORT=3013  ABBA_DATA=./data
```

Open `http://127.0.0.1:3013` — it's your notepad, no account, no setup.

Abba is a PWA: over HTTPS it installs to the home screen / desktop
(manifest + service worker + icons ship with the app). The service worker
caches only the app shell — every `/api/*` request always hits the network.
An "Install Abba on this device" button appears in Settings when the browser offers it.

## What it does

Modeled after Apple Notes — folders, large titles, hairlines, quiet gold:

- **Folders** — a personal greeting, then *Notepad*, *Shared with me*, and *Weekly Letters*, each with a count
- **Notes lists** — title + "date · status — excerpt" rows, per-folder search, floating compose button
- **Note view** — calm reading type, a presence orb floats above the tab bar (tap: zen status icons, share-by-email, edit, export, delete fan out), related notes, margin notes, export. ` ```mermaid ` fenced blocks render as diagrams in Abba's warm theme, light and dark — the library is vendored locally, so it works offline and no CDN is ever contacted
- **Weekly Letters** — every digest edition on a shelf, newest first, each reading like a short editorial letter; plus *Today*, your tasks gathered
- **Shared with me** — notes others emailed you, picked up automatically from your inbox
- **Smart folders** — up to 3 topic folders derived from your tags and their signature vocabulary
- **Nudges** — small, dismissible, never badges: stale sprouts

## Sharing (through IMAP)

There are no accounts, no invite codes, no peer-to-peer sync. Sharing is email:

1. Connect your mail account in **Settings → Mail** (IMAP for sync, SMTP for sending — usually the same account).
2. Tap a note's orb → **Share by email** → enter addresses.
3. They get the note as an email. If they use Abba, it lands in their *Shared with me* shelf — the email *is* the invite.

The same account mirrors your notepad into a `Notes` folder on your mail server (Apple Mail convention): one message per note, two-way sync, last-writer-wins, Abba is the source of truth for deletes. Incoming shares are scanned from your inbox every 10 minutes.

## Layout

```
src/server.ts   HTTP API + static serving (127.0.0.1, no auth)
src/db.ts       SQLite schema & bootstrap (+ one-way migration from the circle era)
src/mind.ts     the invisible intelligence: auto-title, related, digest, nudges
src/imap.ts     zero-dep IMAP client (copied from relay's proven client)
src/imapnotes.ts two-way Notes-folder sync
src/smtp.ts     zero-dep SMTP client (STARTTLS / implicit TLS, AUTH LOGIN/PLAIN)
src/share.ts    share-by-email: compose, send, incoming-share scan
public/         mobile-first SPA (zero dependencies)
tests/          API end-to-end (real HTTP) + IMAP/SMTP fakes + mind unit tests
```

## Tests

```bash
bun test   # 93 tests: notes CRUD, comments, letters, nudges, share compose/send/scan, SMTP + IMAP fakes, migration-safe schema
```

## History

Abba used to be a multi-member circle app with invite codes and peer-to-peer mesh sync (the `mesh/` era, up to Oct 3 2026). That story got too complicated, so it was cut: one more migration (`migrateSolo` in `src/db.ts`) carries notes, comments, digests, and mail settings forward, and everything circle-shaped is gone. Simpler is kinder.
