// dailyletter.test.ts — the daily task letter: parsing + composition.
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { __setDbForTests, nowIso } from "../src/db";
import { parseTasks, composeDailyLetter } from "../src/mind";

let db: Database;
let memberId: number;

function freshDb() {
  db = new Database(":memory:");
  __setDbForTests(db);
  const m = db.query("INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES ('Sam', '#fff', ?, 'owner', ?, '')")
    .run("tok-" + Math.random(), nowIso());
  memberId = Number(m.lastInsertRowid);
}

function addNote(title: string, body: string, updatedAt: string): number {
  const r = db.query(`INSERT INTO notes (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
    VALUES (?, ?, ?, '[]', 'seed', 0, 1, ?, ?)`)
    .run(memberId, title, body, updatedAt, updatedAt);
  return Number(r.lastInsertRowid);
}

describe("parseTasks", () => {
  test("extracts items with done state", () => {
    const t = parseTasks("- [ ] oat milk\n- [x] eggs\n- plain");
    expect(t).toEqual([
      { text: "oat milk", done: false },
      { text: "eggs", done: true },
    ]);
  });
  test("skips fenced code blocks", () => {
    expect(parseTasks("```\n- [ ] not a task\n```\n- [ ] real").length).toBe(1);
  });
  test("empty body has no tasks", () => {
    expect(parseTasks("just prose")).toEqual([]);
  });
});

describe("composeDailyLetter", () => {
  beforeEach(freshDb);

  test("empty when the member has no tasks", () => {
    addNote("Prose", "no checklists here", new Date().toISOString());
    const d = composeDailyLetter(memberId);
    expect(d.empty).toBe(true);
    expect(d.title).toBe("Today");
    expect(d.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("open tasks group by note with progress", () => {
    addNote("Shopping", "- [ ] oat milk\n- [x] eggs\n- [ ] bread", new Date().toISOString());
    const d = composeDailyLetter(memberId);
    expect(d.empty).toBe(false);
    const open = d.sections.find((s) => s.heading === "Still open")!;
    expect(open).toBeDefined();
    expect(open.lines.length).toBe(1);
    expect(open.lines[0]).toContain("Shopping");
    expect(open.lines[0]).toContain("1 of 3 done");
    expect(open.lines[0]).toContain("oat milk");
    expect(open.lines[0]).toContain("bread");
    expect(open.lines[0]).not.toContain("eggs");
  });

  test("fully-done notes land in Wrapped up", () => {
    addNote("Done thing", "- [x] a\n- [x] b", new Date().toISOString());
    const d = composeDailyLetter(memberId);
    const done = d.sections.find((s) => s.heading === "Wrapped up")!;
    expect(done.lines[0]).toContain("Done thing");
    expect(done.lines[0]).toContain("all 2 done");
    expect(d.sections.find((s) => s.heading === "Still open")).toBeUndefined();
  });

  test("stale done notes stay out of the letter", () => {
    const old = new Date(Date.now() - 30 * 864e5).toISOString();
    addNote("Ancient", "- [x] a", old);
    const d = composeDailyLetter(memberId);
    expect(d.sections.find((s) => s.heading === "Wrapped up")).toBeUndefined();
  });

  test("other members' notes are excluded", () => {
    const m2 = db.query("INSERT INTO members (name, color, token, role, created_at, last_seen) VALUES ('Jo', '#000', ?, 'member', ?, '')")
      .run("tok2-" + Math.random(), nowIso());
    db.query(`INSERT INTO notes (member_id, title, body, tags, status, shared, read_mins, created_at, updated_at)
      VALUES (?, 'Theirs', '- [ ] secret task', '[]', 'seed', 0, 1, ?, ?)`)
      .run(Number(m2.lastInsertRowid), new Date().toISOString(), new Date().toISOString());
    const d = composeDailyLetter(memberId);
    expect(d.empty).toBe(true);
  });
});
