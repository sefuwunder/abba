// Abba smart folders: task parsing, toggling, and checkbox rendering.
// Loads public/app.js in a DOM stub (boot() stripped — no network).
import { describe, test, expect, beforeAll } from "bun:test";
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

let taskStats: any, toggleTask: any, md: any;

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
  js = js.replace(/\nboot\(\);?\s*$/, ""); // don't boot; test pure functions
  eval(js + "\n;globalThis.__abbaTasks = { taskStats, toggleTask, md };");
  ({ taskStats, toggleTask, md } = g.__abbaTasks);
});

describe("taskStats", () => {
  test("counts open/done/total", () => {
    const st = taskStats("- [ ] buy milk\n- [x] call bank\n- plain item\n");
    expect(st.total).toBe(2);
    expect(st.open).toBe(1);
    expect(st.done).toBe(1);
  });
  test("zero when no checklists", () => {
    expect(taskStats("no tasks here").total).toBe(0);
  });
  test("ignores code fences", () => {
    expect(taskStats("```\n- [ ] not a task\n```\n- [ ] real task").total).toBe(1);
  });
  test("handles * bullets, indent, capital X", () => {
    const st = taskStats("* [ ] star bullet\n  - [X] indented caps");
    expect(st.total).toBe(2);
    expect(st.open).toBe(1);
  });
});

describe("toggleTask", () => {
  const body = "- [ ] a\n- [x] b\n- [ ] c";
  test("flips open -> done", () => {
    expect(toggleTask(body, 0).split("\n")[0]).toBe("- [x] a");
  });
  test("flips done -> open", () => {
    expect(toggleTask(body, 1).split("\n")[1]).toBe("- [ ] b");
  });
  test("targets only the nth task", () => {
    const out = toggleTask(body, 2).split("\n");
    expect(out[2]).toBe("- [x] c");
    expect(out[0]).toBe("- [ ] a");
  });
  test("out-of-range index is a no-op", () => {
    expect(toggleTask(body, 9)).toBe(body);
  });
});

describe("md() checkbox rendering", () => {
  test("renders tappable boxes with stable indices", () => {
    const html = md("- [ ] open thing\n- [x] done thing\n- plain\n");
    expect(html).toContain('data-task="0"');
    expect(html).toContain('data-task="1"');
    expect(html).toContain('class="cbox"');
    expect(html).toContain('class="cbox on"');
    expect((html.match(/<li class="task">/g) || []).length).toBe(2);
  });
  test("leaves plain bullets alone and consumes markers", () => {
    const html = md("- [ ] open thing\n- plain\n");
    expect(html).toContain("<li>plain</li>");
    expect(html).not.toContain("[ ]");
  });
});

describe("smart folder filters", () => {
  const notes = [
    { id: 1, body: "- [ ] a" },
    { id: 2, body: "- [x] a\n- [x] b" },
    { id: 3, body: "no tasks" },
  ];
  const classify = (n: any) => {
    const st = taskStats(n.body);
    return st.total > 0 ? (st.open > 0 ? "open" : "done") : "none";
  };
  test("open folder holds notes with unchecked items", () => {
    expect(notes.filter((n) => classify(n) === "open").map((n) => n.id)).toEqual([1]);
  });
  test("done folder holds fully-checked notes", () => {
    expect(notes.filter((n) => classify(n) === "done").map((n) => n.id)).toEqual([2]);
  });
});
