# Abba — a quiet notepad

A single-user markdown notepad for an executive, built on the **S.E.F.U. software philosophy**:

- **Soulfulness** (empathy) — written for humans, not feeds. Warm paper-and-ink design, gentle language.
- **Effectiveness** (impact) — ideas move through a lifecycle (seed → sprout → in motion → decided) instead of accumulating in a drawer.
- **Flow** (consistency) — capture in seconds, drafts auto-save, markdown with zero friction.
- **Unity** (togetherness) — the weekly letter reflects your own thinking back to you.

**Agent-native, agent invisible.** Abba has an intelligence layer (`src/mind.ts`) that auto-titles notes, finds related ideas, composes the weekly digest, and surfaces kind nudges. It never announces itself — no chat widget, no "AI" labels, no sparkle icons. Everything appears as ordinary, calm interface. See `PHILOSOPHY.md`.

Abba handles **no communications** — no email, no IMAP, no SMTP, no sharing, no polling. Nothing leaves this device except through the read-only sync feed below.

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

- **Folders** — a personal greeting, then *Notepad* and *Weekly Letters*, each with a count
- **Notes lists** — title + "date · status — excerpt" rows, per-folder search, floating compose button
- **Note view** — calm reading type, a presence orb floats above the tab bar (tap: zen status icons, edit, export, delete fan out), related notes, margin notes, export. ` ```mermaid ` fenced blocks render as diagrams in Abba's warm theme, light and dark — the library is vendored locally, so it works offline and no CDN is ever contacted
- **Weekly Letters** — every digest edition on a shelf, newest first, each reading like a short editorial letter; plus *Today*, your tasks gathered
- **Smart folders** — up to 3 topic folders derived from your tags and their signature vocabulary
- **Nudges** — small, dismissible, never badges: stale sprouts

## Sync API (read-only, for Switchboard)

Abba exposes exactly one network interface beyond its UI — a read-only feed
Switchboard polls to stay aware of the notepad. No sending, no polling from
Abba's side, no email.

```
GET /api/sync/notes?since=<unix-timestamp>
```

Returns notes changed since the given Unix timestamp (omit `since` for all):

```json
{
  "notes": [
    { "id": 7, "title": "Idea title", "folder": "Notepad",
      "updated_at": "2026-10-05T16:00:48.348Z", "state": "sprout" }
  ]
}
```

- `folder` is always `"Notepad"` (Abba has one shelf).
- `state` is the idea lifecycle: `seed` | `sprout` | `motion` | `decided` | `resting`.
- `updated_at` is ISO 8601; the comparison is `>=`, ordered oldest-first, capped at 500 rows.

## Email-to-note ingest (via Relay)

Abba has no IMAP of its own. Relay owns the Notes IMAP folder sync and
exposes what it finds over HTTP; Abba polls that feed every 5 minutes and
turns new emails into notes. One-way only — nothing is ever written back.

- Source: `GET {RELAY_URL}/api/relay/notes-emails?since=<ms epoch>`
  → `{ emails: [{ id, message_id, subject, body, from, date }] }`
  (`date` is unix seconds; `body` is markdown by the Apple Notes convention.)
- `RELAY_URL` env, default `http://127.0.0.1:3006`. If Relay is unreachable,
  the poll is skipped quietly (logged once, no crash, no aggressive retry).
- First run ingests only the last 7 days — no ancient history.
- Each email becomes a note: title = subject (fallback: first 60 chars of
  body, fallback: "Untitled note"), body as-is, `status: seed`,
  `tags: ["from-email"]`, timestamps from the email's date.
- Dedupe: `ingested_mail (message_id TEXT PRIMARY KEY, note_id, ingested_at)`.
  Key is `message_id`, falling back to `relay:<id>`; emails with neither are
  skipped. Re-delivery never creates duplicates.
- Watermark: ms epoch of the newest ingested email's date, in the `kv` table
  under `notes_mail_watermark`.

## Layout

```
src/server.ts   HTTP API + static serving (127.0.0.1, no auth)
src/db.ts       SQLite schema & bootstrap (+ migrations from earlier eras)
src/mind.ts     the invisible intelligence: auto-title, related, digest, nudges
public/         mobile-first SPA (zero dependencies)
tests/          API end-to-end (real HTTP) + mind unit tests
```

## Tests

```bash
bun test   # notes CRUD, comments, letters, nudges, sync feed, backup, migration-safe schema
```

## History

Abba used to be a multi-member circle app with invite codes and peer-to-peer mesh sync (the `mesh/` era, up to Oct 3 2026), then a single-user notepad that shared through IMAP/SMTP email (up to Oct 5 2026). Both stories got too complicated, so they were cut: `src/db.ts` drops the leftover comms tables on boot, and everything mail-shaped is gone. Simpler is kinder.
