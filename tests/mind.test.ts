// mind.test.ts — the invisible agent's pure functions.
import { describe, test, expect } from "bun:test";
import { autoTitle, readMins, tokens, relatedIdeas } from "../src/mind";

describe("autoTitle", () => {
  test("prefers the first heading", () => {
    expect(autoTitle("## Launch plan\nSome body text here")).toBe("Launch plan");
  });
  test("falls back to the first sentence", () => {
    expect(autoTitle("We should buy the building. It is cheap.")).toBe("We should buy the building.");
  });
  test("truncates long openers", () => {
    const t = autoTitle("This is a very long opening line that keeps going and going and going past sixty four characters easily");
    expect(t.length).toBeLessThanOrEqual(65);
    expect(t.endsWith("…")).toBe(true);
  });
  test("empty body gets a calm fallback", () => {
    expect(autoTitle("   \n  ")).toBe("Untitled thought");
  });
});

describe("readMins", () => {
  test("short note is 1 min", () => { expect(readMins("hello world")).toBe(1); });
  test("400 words is 2 min", () => { expect(readMins(Array(400).fill("word").join(" "))).toBe(2); });
});

describe("relatedIdeas", () => {
  const mk = (id: number, title: string, body: string, shared = 1): any =>
    ({ id, title, body, tags: "[]", status: "seed", shared, updated_at: "2026-09-29T10:00:00.000Z" });
  test("finds notes sharing language", () => {
    const a = mk(1, "Launch plan", "We launch the marketplace in October with a big marketing push");
    const b = mk(2, "Marketing push", "The marketing push for the October marketplace launch needs budget");
    const c = mk(3, "Lunch menu", "Sandwiches and soup for the team lunch on Friday");
    const rel = relatedIdeas(a, [a, b, c]);
    expect(rel.map((n) => n.id)).toEqual([2]);
  });
  test("needs at least two shared words", () => {
    const a = mk(1, "Apples", "I like apples very much indeed");
    const b = mk(2, "Oranges", "I like oranges very much indeed"); // shares: like, much, indeed -> 3
    const c = mk(3, "Cars", "I drive cars daily now"); // shares: only "i"? filtered. -> 0
    expect(relatedIdeas(a, [a, b, c]).map((n) => n.id)).toEqual([2]);
  });
  test("empty note relates to nothing", () => {
    expect(relatedIdeas(mk(1, "", ""), [mk(2, "Something", "with words here")])).toEqual([]);
  });
  test("deterministic ordering", () => {
    const a = mk(1, "Base", "alpha beta gamma delta");
    const pool = [a, mk(3, "C", "alpha beta zeta", 1), mk(2, "B", "alpha beta zeta", 1)];
    const r1 = relatedIdeas(a, pool).map((n) => n.id);
    const r2 = relatedIdeas(a, pool).map((n) => n.id);
    expect(r1).toEqual(r2);
  });
});
