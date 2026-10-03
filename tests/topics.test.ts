// topics.test.ts — smart topic folders: max 3, from tags + content mentions.
// Loads public/app.js in a DOM stub (boot() stripped — no network).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function makeEl(): any {
  return {
    innerHTML: "", textContent: "", value: "", dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: {}, disabled: false,
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    append() {}, closest() { return null; }, onclick: null,
  };
}

let topicFolders: any, capTag: any;
// bun shares globalThis across test files: save the originals and restore
// them afterwards so later files keep the real fetch/localStorage.
const ORIGINALS: Record<string, any> = {};
for (const k of ["window", "location", "document", "localStorage", "fetch", "navigator"]) {
  ORIGINALS[k] = (globalThis as any)[k];
}

beforeAll(() => {
  const g: any = globalThis as any;
  g.window = {
    addEventListener() {}, scrollTo() {},
    matchMedia() { return { matches: false }; },
    location: { hash: "" },
  };
  g.location = g.window.location;
  g.document = {
    getElementById: () => makeEl(), querySelector: () => null, querySelectorAll: () => [],
    createElement: () => makeEl(), body: makeEl(), activeElement: { tagName: "BODY" },
  };
  g.localStorage = {
    _m: {}, getItem(k: string) { return this._m[k] || null; },
    setItem(k: string, v: string) { this._m[k] = v; }, removeItem(k: string) { delete this._m[k]; },
  };
  g.fetch = async () => { throw new Error("no network in test"); };
  g.navigator = {};

  let js = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  js = js.replace(/\nroute\(\);?\s*$/, ""); // don't boot; test pure functions
  eval(js + "\n;globalThis.__abbaTopics = { topicFolders, capTag };");
  ({ topicFolders, capTag } = g.__abbaTopics);
  delete g.__abbaTopics;
});

afterAll(() => {
  const g: any = globalThis as any;
  for (const k of Object.keys(ORIGINALS)) g[k] = ORIGINALS[k];
});

const mk = (id: number, title: string, body: string, tags: string[], updatedAt = "2026-10-02T12:00:00.000Z"): any =>
  ({ id, title, body, tags, updatedAt });

describe("topicFolders", () => {
  test("caps at 3 folders, ranked by note count", () => {
    const notes = [
      mk(1, "A", "x", ["t1"]), mk(2, "B", "x", ["t1"]), mk(3, "C", "x", ["t1"]),
      mk(4, "D", "x", ["t2"]), mk(5, "E", "x", ["t2"]),
      mk(6, "F", "x", ["t3"]),
      mk(7, "G", "x", ["t4"]),
    ];
    const f = topicFolders(notes);
    expect(f.length).toBe(3);
    expect(f.map((x: any) => x.tag)).toEqual(["t1", "t2", "t3"]);
  });

  test("notes join by content mention, not just the tag", () => {
    const notes = [
      mk(1, "Marrakech riad", "book the riad", ["travel"]),
      mk(2, "Packing", "marrakech is hot in june", []),
      mk(3, "Unrelated", "nothing here", []),
    ];
    const f = topicFolders(notes);
    expect(f.length).toBe(1);
    expect(f[0].tag).toBe("travel");
    expect(f[0].notes.map((n: any) => n.id).sort()).toEqual([1, 2]);
  });

  test("word boundaries: 'car' does not match 'carpet'", () => {
    const notes = [
      mk(1, "A", "x", ["car"]),
      mk(2, "B", "buy a new carpet", []),
    ];
    const f = topicFolders(notes);
    expect(f[0].notes.map((n: any) => n.id)).toEqual([1]);
  });

  test("tags are case-insensitive and trimmed", () => {
    const notes = [mk(1, "A", "x", ["Travel", " travel "]), mk(2, "B", "x", ["TRAVEL"])];
    const f = topicFolders(notes);
    expect(f.length).toBe(1);
    expect(f[0].tag).toBe("travel");
    expect(f[0].notes.length).toBe(2);
  });

  test("no tags means no folders", () => {
    expect(topicFolders([mk(1, "A", "plain", [])])).toEqual([]);
    expect(topicFolders([])).toEqual([]);
  });

  test("recency breaks ties", () => {
    const notes = [
      mk(1, "A", "x", ["old"], "2026-09-01T12:00:00.000Z"),
      mk(2, "B", "x", ["new"], "2026-10-02T12:00:00.000Z"),
    ];
    const f = topicFolders(notes);
    expect(f[0].tag).toBe("new");
  });
});

describe("capTag", () => {
  test("capitalizes", () => {
    expect(capTag("travel")).toBe("Travel");
  });
});
