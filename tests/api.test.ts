// api.test.ts — end-to-end over real HTTP against a spawned server
// with a fresh data dir. Covers the single-user notepad API: notes CRUD,
// comments, letters, nudges, mail config, and backup. No auth anywhere.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 31313;
const BASE = `http://localhost:${PORT}`;
let proc: any;
let noteId = 0;

async function api(path: string, opts: any = {}): Promise<{ status: number; data: any }> {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const post = (p: string, body: any) => api(p, { method: "POST", body: JSON.stringify(body) });
const patch = (p: string, body: any) => api(p, { method: "PATCH", body: JSON.stringify(body) });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "abba-test-"));
  proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, ABBA_DATA: dir, ABBA_PORT: String(PORT) },
    stdout: "ignore", stderr: "ignore",
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      const r = await fetch(BASE + "/api/status");
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterAll(() => { try { proc.kill(); } catch { /* already down */ } });

describe("status", () => {
  test("no auth required, fresh notepad", async () => {
    const { status, data } = await api("/api/status");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.notes).toBe(0);
  });
});

describe("notes", () => {
  test("empty body is refused", async () => {
    const { status } = await post("/api/notes", { body: "   " });
    expect(status).toBe(400);
  });
  test("create auto-titles", async () => {
    const { status, data } = await post("/api/notes", { body: "The quick brown fox jumps over the lazy dog" });
    expect(status).toBe(201);
    expect(data.note.title.length).toBeGreaterThan(0);
    expect(data.note.status).toBe("seed");
    noteId = data.note.id;
  });
  test("list returns the note", async () => {
    const { data } = await api("/api/notes");
    expect(data.notes.length).toBe(1);
    expect(data.notes[0].id).toBe(noteId);
  });
  test("get one", async () => {
    const { data } = await api(`/api/notes/${noteId}`);
    expect(data.note.id).toBe(noteId);
  });
  test("get missing -> 404", async () => {
    const { status } = await api("/api/notes/99999");
    expect(status).toBe(404);
  });
  test("patch status logs an event", async () => {
    const { data } = await patch(`/api/notes/${noteId}`, { status: "sprout" });
    expect(data.note.status).toBe("sprout");
  });
  test("patch body + tags", async () => {
    const { data } = await patch(`/api/notes/${noteId}`, { body: "updated body", tags: ["test", "demo"] });
    expect(data.note.body).toBe("updated body");
    expect(data.note.tags).toEqual(["test", "demo"]);
  });
  test("patch with nothing -> 400", async () => {
    const { status } = await patch(`/api/notes/${noteId}`, {});
    expect(status).toBe(400);
  });
  test("export downloads markdown", async () => {
    const res = await fetch(`${BASE}/api/notes/${noteId}/export`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("updated body");
  });
});

describe("comments", () => {
  test("add and remove a margin note", async () => {
    const { status, data } = await post(`/api/notes/${noteId}/comments`, { body: "a margin thought" });
    expect(status).toBe(201);
    expect(data.note.comments.length).toBe(1);
    expect(data.note.comments[0].body).toBe("a margin thought");
    const cid = data.commentId;
    const del = await api(`/api/notes/${noteId}/comments/${cid}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.data.note.comments.length).toBe(0);
  });
  test("empty comment refused", async () => {
    const { status } = await post(`/api/notes/${noteId}/comments`, { body: "  " });
    expect(status).toBe(400);
  });
});

describe("related", () => {
  test("finds notes with shared language", async () => {
    const a = await post("/api/notes", { body: "sourdough starter feeding schedule" });
    await post("/api/notes", { body: "my sourdough starter smells funky" });
    await post("/api/notes", { body: "completely unrelated quantum knitting" });
    const { data } = await api(`/api/notes/${a.data.note.id}/related`);
    expect(data.related.length).toBeGreaterThan(0);
  });
});

describe("letters and nudges", () => {
  test("today letter composes", async () => {
    const { data } = await api("/api/digest/today");
    expect(data.digest.title).toBe("Today");
  });
  test("digests list", async () => {
    const { data } = await api("/api/digests");
    expect(Array.isArray(data.digests)).toBe(true);
  });
  test("nudges list and dismiss", async () => {
    const { data } = await api("/api/nudges");
    expect(Array.isArray(data.nudges)).toBe(true);
    const d = await post("/api/nudges/dismiss", { key: "nope-never" });
    expect(d.status).toBe(200);
  });
});

describe("share without mail", () => {
  test("share requires a connected mail account", async () => {
    const { status, data } = await post(`/api/notes/${noteId}/share`, { emails: ["a@example.com"] });
    expect(status).toBe(400);
    expect(data.error).toMatch(/mail/i);
  });
  test("bad emails rejected", async () => {
    const { status } = await post(`/api/notes/${noteId}/share`, { emails: ["not-an-email"] });
    expect(status).toBe(400);
  });
  test("share history starts empty", async () => {
    const { data } = await api("/api/shares");
    expect(data.shares).toEqual([]);
  });
  test("shared inbox starts empty", async () => {
    const { data } = await api("/api/shared");
    expect(data.shared).toEqual([]);
  });
});

describe("imap config", () => {
  test("unconfigured at first", async () => {
    const { data } = await api("/api/imap");
    expect(data.configured).toBe(false);
  });
  test("missing fields refused", async () => {
    const { status } = await post("/api/imap", { host: "x" });
    expect(status).toBe(400);
  });
  test("unreachable host -> 502, nothing saved", async () => {
    const { status } = await post("/api/imap", {
      host: "127.0.0.1", port: 1, username: "u", password: "p", folder: "Notes",
    });
    expect(status).toBe(502);
    const { data } = await api("/api/imap");
    expect(data.configured).toBe(false);
  });
  test("delete when unconfigured is fine", async () => {
    const { status } = await api("/api/imap", { method: "DELETE" });
    expect(status).toBe(200);
  });
  test("sync kick returns instantly with a backward-compatible shape", async () => {
    const t0 = Date.now();
    const { status, data } = await post("/api/imap/sync", {});
    expect(status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(data.ok).toBe(true);
    // stale cached clients do r.errors.length — this must never throw
    expect(Array.isArray(data.errors)).toBe(true);
    expect(typeof data.pushed).toBe("number");
  });
  test("scan kick returns instantly with a backward-compatible shape", async () => {
    const { status, data } = await post("/api/imap/scan", {});
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(typeof data.imported).toBe("number");
  });
  test("service worker cache name is version-stamped", async () => {
    const res = await fetch(BASE + "/sw.js");
    const text = await res.text();
    expect(text.includes("__V__")).toBe(false);
    expect(/abba-shell-\d+/.test(text)).toBe(true);
  });
});

describe("backup", () => {
  test("export is well-formed", async () => {
    const res = await fetch(`${BASE}/api/backup`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.app).toBe("abba");
    expect(data.notes.length).toBeGreaterThan(0);
  });
  test("import adds notes", async () => {
    const before = (await api("/api/notes")).data.notes.length;
    const { data } = await post("/api/backup", {
      app: "abba", version: 1, notes: [{ title: "Restored", body: "from backup", tags: ["x"], status: "seed" }],
    });
    expect(data.imported).toBe(1);
    expect((await api("/api/notes")).data.notes.length).toBe(before + 1);
  });
  test("non-backup rejected", async () => {
    const { status } = await post("/api/backup", { app: "nope" });
    expect(status).toBe(400);
  });
});

describe("delete note", () => {
  test("note is gone afterwards", async () => {
    const { status } = await api(`/api/notes/${noteId}`, { method: "DELETE" });
    expect(status).toBe(200);
    expect((await api(`/api/notes/${noteId}`)).status).toBe(404);
  });
});
