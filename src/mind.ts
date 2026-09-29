// mind.ts — Abba's quiet intelligence.
//
// This module is the "agent" in "agent-native", and it is deliberately
// invisible: it never announces itself, never shows a spinner with a label,
// never uses words like AI/smart/assistant. It just keeps the notepad tidy,
// connected, and warm — the way a good chief of staff would, silently.
//
// Everything here is deterministic and local: no network, no model, no
// telemetry. The UI renders its outputs as ordinary interface, never as
// "suggestions from an agent".
import { getDb, nowIso } from "./db";

export const STOP = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,us,do,does,did,will,would,can,could,should,have,has,had,not,no,yes,so,such,than,too,very,just,about,into,over,after,before,up,down,out,off,again,once,here,there,when,where,why,how,what,which,who,whom,all,any,both,each,few,more,most,other,some,only,own,same".split(",")
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Quiet auto-title: first heading, else first sentence, else a calm fallback. */
export function autoTitle(body: string): string {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const h = l.match(/^#{1,3}\s+(.+)/);
    if (h) return h[1].slice(0, 80);
  }
  const first = lines[0] || "";
  const sentence = first.split(/(?<=[.!?])\s/)[0] || first;
  const clean = sentence.replace(/^[-*>\d.\s]+/, "").trim();
  if (!clean) return "Untitled thought";
  return clean.length > 64 ? clean.slice(0, 61).trimEnd() + "…" : clean;
}

export function readMins(body: string): number {
  const words = body.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export interface NoteRow {
  id: number; member_id: number; title: string; body: string;
  tags: string; status: string; shared: number; read_mins: number;
  created_at: string; updated_at: string;
  member_name?: string; member_color?: string;
}

function keywordSet(n: NoteRow): Set<string> {
  return new Set(tokens(n.title + " " + n.body + " " + JSON.parse(n.tags || "[]").join(" ")));
}

/**
 * Related ideas, found by shared language — shown in the UI under a plain
 * "Related" heading. Deterministic; ties break by recency then id.
 */
export function relatedIdeas(note: NoteRow, pool: NoteRow[], limit = 3): NoteRow[] {
  const mine = keywordSet(note);
  if (!mine.size) return [];
  const scored: { n: NoteRow; s: number }[] = [];
  for (const other of pool) {
    if (other.id === note.id) continue;
    const theirs = keywordSet(other);
    let overlap = 0;
    for (const w of mine) if (theirs.has(w)) overlap++;
    if (overlap >= 2) scored.push({ n: other, s: overlap });
  }
  scored.sort((a, b) => b.s - a.s || b.n.updated_at.localeCompare(a.n.updated_at) || a.n.id - b.n.id);
  return scored.slice(0, limit).map((x) => x.n);
}

// ---- digest ------------------------------------------------------------------
// The weekly digest reads like a short editorial letter from someone who was
// paying attention. It is composed from the week's events with fixed,
// hand-tuned phrasing — never "AI-generated".

export interface DigestSection { heading: string; lines: string[]; }
export interface Digest { weekKey: string; title: string; intro: string; sections: DigestSection[]; empty: boolean; }

function weekKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  // ISO week
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t.getTime() - first.getTime()) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${p(week)}`;
}

export function currentWeekKey(): string { return weekKey(); }

/** Read a digest edition: cached if it exists, composed fresh for the current week, null otherwise. */
export function getDigest(wk?: string): Digest | null {
  const db = getDb();
  const key = wk || weekKey();
  const cached = db.query("SELECT payload FROM digests WHERE week_key = ?").get(key) as any;
  if (cached) {
    const p = JSON.parse(cached.payload);
    return { weekKey: key, ...p };
  }
  if (!wk || wk === weekKey()) return composeDigest();
  return null;
}

/** Every cached edition, newest first — the Weekly Letters shelf. */
export function listDigests(): { weekKey: string; createdAt: string; title: string }[] {
  const db = getDb();
  const rows = db.query("SELECT week_key, payload, created_at FROM digests ORDER BY week_key DESC").all() as any[];
  return rows.map((r) => ({ weekKey: r.week_key, createdAt: r.created_at, title: JSON.parse(r.payload).title || "Weekly letter" }));
}

const INTROS = [
  "A quiet look back at what the circle was thinking about this week.",
  "What moved, what landed, and what's still simmering — this week in the circle.",
  "The week in ideas, gathered in one place.",
];
const OUTROS = [
  "Nothing here needs a reply. But if something tugs at you, you know where it lives.",
  "Carry one of these into next week — that's plenty.",
];

export function composeDigest(): Digest {
  const db = getDb();
  const wk = weekKey();
  const cached = db.query("SELECT payload FROM digests WHERE week_key = ?").get(wk) as any;
  if (cached) {
    const p = JSON.parse(cached.payload);
    return { weekKey: wk, ...p };
  }
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceIso = since.toISOString();

  const notes = db.query(`
    SELECT n.*, m.name AS member_name FROM notes n
    JOIN members m ON m.id = n.member_id
    WHERE n.shared = 1 AND n.created_at >= ? ORDER BY n.created_at DESC
  `).all(sinceIso) as NoteRow[];

  const statusMoves = db.query(`
    SELECT e.*, n.title, m.name AS member_name FROM events e
    JOIN notes n ON n.id = e.note_id JOIN members m ON m.id = e.member_id
    WHERE e.kind = 'status' AND e.created_at >= ? ORDER BY e.created_at DESC
  `).all(sinceIso) as any[];

  const commented = db.query(`
    SELECT DISTINCT n.id, n.title FROM comments c
    JOIN notes n ON n.id = c.note_id
    WHERE c.created_at >= ? AND n.shared = 1 ORDER BY c.created_at DESC LIMIT 8
  `).all(sinceIso) as any[];

  const sections: DigestSection[] = [];
  const fresh = notes.filter((n) => n.status === "seed" || n.status === "sprout");
  if (fresh.length) {
    sections.push({
      heading: "New seeds",
      lines: fresh.slice(0, 6).map((n) => `**${n.title}** — ${n.member_name || ""}`),
    });
  }
  const moving = statusMoves.filter((e) => ["motion", "decided"].includes(JSON.parse(e.meta || "{}").to));
  if (moving.length) {
    const seen = new Set<number>(); const lines: string[] = [];
    for (const e of moving) {
      if (seen.has(e.note_id)) continue; seen.add(e.note_id);
      const to = JSON.parse(e.meta || "{}").to;
      lines.push(`**${e.title}** ${to === "decided" ? "landed — a decision was made" : "is in motion"} (${e.member_name})`);
      if (lines.length >= 6) break;
    }
    sections.push({ heading: "What moved", lines });
  }
  if (commented.length) {
    sections.push({
      heading: "Worth a re-read",
      lines: commented.map((c) => `**${c.title}** — the conversation kept going`),
    });
  }
  // Quiet ones: shared ideas untouched for 14+ days (gentle, never shaming)
  const quiet = db.query(`
    SELECT n.*, m.name AS member_name FROM notes n JOIN members m ON m.id = n.member_id
    WHERE n.shared = 1 AND n.status IN ('seed','sprout') AND n.updated_at < ?
    ORDER BY n.updated_at ASC LIMIT 4
  `).all(new Date(Date.now() - 14 * 864e5).toISOString()) as NoteRow[];
  if (quiet.length) {
    sections.push({
      heading: "Still simmering",
      lines: quiet.map((n) => `**${n.title}** — ${n.member_name || ""} planted this a while back`),
    });
  }

  const digest: Digest = {
    weekKey: wk,
    title: "This week in the circle",
    intro: INTROS[wk.charCodeAt(wk.length - 1) % INTROS.length],
    sections,
    empty: sections.length === 0,
  };
  // Cache for the week; a "refresh" is just a re-read once new events land —
  // the digest is recomposed when the week turns over.
  db.query("INSERT INTO digests (week_key, payload, created_at) VALUES (?, ?, ?)").run(
    wk, JSON.stringify({ title: digest.title, intro: digest.intro, sections: digest.sections, empty: digest.empty }), nowIso());
  return digest;
}


// ---- nudges --------------------------------------------------------------------
// Small, kind, dismissible. Never badges, never counts, never red.

export interface Nudge { key: string; text: string; noteId?: number; action?: string }

export function nudgesFor(memberId: number): Nudge[] {
  const db = getDb();
  const out: Nudge[] = [];
  const seen = new Set(
    (db.query("SELECT nudge_key FROM nudges_seen WHERE member_id = ?").all(memberId) as any[]).map((r) => r.nudge_key)
  );
  // Stale sprouts: shared ideas sitting 9+ days without movement (own ideas only — never nag about others')
  const stale = db.query(`
    SELECT id, title FROM notes
    WHERE member_id = ? AND shared = 1 AND status = 'sprout'
      AND updated_at < ? ORDER BY updated_at ASC LIMIT 2
  `).all(memberId, new Date(Date.now() - 9 * 864e5).toISOString()) as any[];
  for (const s of stale) {
    const key = `stale-${s.id}`;
    if (!seen.has(key)) out.push({ key, text: `“${s.title}” has been sprouting for a while — still alive, or time to let it rest?`, noteId: s.id, action: "rest" });
  }
  // Unread circle ideas (shared by others, never opened — tracked via events is overkill; use created recency)
  const unread = db.query(`
    SELECT id, title FROM notes
    WHERE shared = 1 AND member_id != ? AND created_at > ?
    ORDER BY created_at DESC LIMIT 3
  `).all(memberId, new Date(Date.now() - 3 * 864e5).toISOString()) as any[];
  if (unread.length >= 3 && !seen.has("unread-3")) {
    out.push({ key: "unread-3", text: `${unread.length} new ideas landed in the circle this week — worth a slow read.` });
  }
  return out.slice(0, 3);
}

export function dismissNudge(memberId: number, key: string): void {
  getDb().query("INSERT OR IGNORE INTO nudges_seen (member_id, nudge_key, created_at) VALUES (?, ?, ?)")
    .run(memberId, key, nowIso());
}
