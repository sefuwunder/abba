# PHILOSOPHY.md — S.E.F.U. in Abba

Abba is an exercise in the S.E.F.U. software philosophy:

- **S — Soulfulness (empathy):** software should feel like it was made by someone who cares about the person using it.
- **E — Effectiveness (impact):** every feature must move something that matters; decoration is debt.
- **F — Flow (consistency):** the tool disappears into the rhythm of the work. Same gestures, same places, every day.
- **U — Unity (togetherness):** software should bring the small group closer, not mediate them into strangers.

## How each pillar is embodied

### Soulfulness

- **Paper and ink, not glass and neon.** Warm paper background, serif reading type, muted terracotta. The executive reads ideas the way they'd read a letter.
- **Language is gentle everywhere.** "Share by email" instead of "Publish". "Let it rest" instead of "Archive". "That note isn't here anymore" instead of "404".
- **Nudges, never notifications.** No badges, no counts, no red. A stale sprout gets one quiet card: *"still alive, or time to let it rest?"* — dismissible, never repeated.
- **No surveillance.** No presence, no read receipts, no typing indicators — it's a notepad, not a network.

### Effectiveness

- **Ideas have a lifecycle:** seed → sprout → in motion → decided, plus resting. An executive doesn't need more notes; they need to know what moved.
- **The digest is a decision instrument.** "What moved" and "Still simmering" turn a week of thinking into something you can act on Monday morning.
- **Related ideas** surface connections across your thinking without you having to maintain links.

### Flow

- **Capture in seconds.** One box, always there, drafts auto-save as you type. "Capture it before it evaporates…"
- **Auto-titles.** An untitled thought gets a title from its first heading or sentence — the notepad stays scannable with zero effort.
- **Markdown, zero friction.** A small zero-dependency renderer; a minimal toolbar in the editor; `.md` export so nothing is ever trapped.
- **Consistent weekly rhythm.** The digest composes every Monday from the week's events — the same letter, the same place.

### Unity

- **One person, lightly connected.** Abba is a single-user notepad — no accounts, no passwords, no growth mechanics. There is no sign-in at all: the server only listens on this machine, and Deck's sign-in guards the way in.
- **Share deliberately.** Notes start private; sending one by email is a conscious act. The email *is* the invite — if the other person uses Abba, it lands in their *Shared with me* shelf.
- **The digest is written as "you".** "This week in your notepad" — your own thinking, reflected back to you.

## The invisible agent

Abba is agent-native: `src/mind.ts` is a genuine intelligence layer — it titles, connects, composes, and reminds. The design constraint is absolute:

> **The agent must be invisible at all times.**

Concretely, this means:

1. **No agent surface.** No chat, no "Ask" button, no command palette entry, no settings toggle.
2. **No agent language.** The words AI, smart, assistant, generated, powered — none appear in the UI, the API, or the docs. The digest "arrives every Monday, written from what actually happened."
3. **No agent theater.** No spinners labeled "thinking", no sparkle icons, no "suggestions". Outputs render as plain interface: a title, a "Related" section, a letter, a quiet card.
4. **Deterministic and local.** No network calls, no models, no telemetry. The "intelligence" is hand-tuned heuristics (keyword overlap, event composition, recency rules) — a good chief of staff, silently.
5. **Kind by construction.** The agent may only ever *offer*, never *demand*: nudges are dismissible and never repeated; the digest never shames a quiet week ("Sometimes the best ideas are still forming.").

The test suite enforces a piece of this: a test fails the build if any digest text contains AI fingerprints ("ai-generated", "as an ai", "language model", 🤖, ✨).
