// pwa.test.ts — manifest validity + service worker logic (stubbed globals).
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const pub = join(import.meta.dir, "..", "public");

function pngSize(p: string): { w: number; h: number } {
  const b = readFileSync(p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; // IHDR: width@16, height@20
}

describe("web app manifest", () => {
  const m = JSON.parse(readFileSync(join(pub, "manifest.webmanifest"), "utf8"));
  test("has installability fields", () => {
    expect(m.name.length).toBeGreaterThan(0);
    expect(m.short_name.length).toBeGreaterThan(0);
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    const sizes = m.icons.map((i: any) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(m.icons.some((i: any) => i.purpose === "maskable")).toBe(true);
  });
  test("icon files exist at their declared sizes", () => {
    for (const icon of m.icons) {
      const p = join(pub, String(icon.src).replace(/^\//, ""));
      expect(existsSync(p)).toBe(true);
      const [w, h] = String(icon.sizes).split("x").map(Number);
      expect(pngSize(p)).toEqual({ w, h });
    }
  });
  test("apple touch icon exists at 180x180", () => {
    const p = join(pub, "apple-touch-icon.png");
    expect(existsSync(p)).toBe(true);
    expect(pngSize(p)).toEqual({ w: 180, h: 180 });
  });
});

describe("service worker", () => {
  const listeners: Record<string, Function> = {};
  const store = new Map<string, boolean>();
  const waited: Promise<any>[] = [];
  let skipped = false, claimed = false, responded: Promise<any> | null = null;

  const fakeCache = {
    addAll: (urls: string[]) => { urls.forEach((u) => store.set("GET " + u, true)); return Promise.resolve(); },
    put: (req: any) => { store.set(req.method + " " + new URL(req.url).pathname, true); return Promise.resolve(); },
    match: (req: any, opts: any) => {
      const path = new URL(req.url).pathname;
      return Promise.resolve(store.has("GET " + path) ? { ok: true, fromCache: true } : undefined);
    },
  };
  const sandbox: any = {
    console, URL,
    caches: {
      open: () => Promise.resolve(fakeCache),
      match: (req: any, opts: any) => fakeCache.match(req, opts),
      keys: () => Promise.resolve(["abba-shell-00000", "abba-shell-12345"]),
      delete: () => Promise.resolve(true),
    },
    fetch: () => Promise.resolve({ ok: true, clone: () => ({}), fromCache: false }),
    self: {
      addEventListener: (t: string, fn: Function) => { listeners[t] = fn; },
      skipWaiting: () => { skipped = true; },
      clients: { claim: () => { claimed = true; return Promise.resolve(); } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = readFileSync(join(pub, "sw.js"), "utf8").replaceAll("__V__", "12345");
  vm.runInContext(src, sandbox, { filename: "sw.js" });

  const req = (method: string, url: string) => ({ method, url });
  const evt = (request: any) => ({
    request,
    respondWith: (p: Promise<any>) => { responded = p; return p; },
    waitUntil: (p: Promise<any>) => { waited.push(p); return p; },
  });
  async function fire(name: string, request: any) {
    waited.length = 0; responded = null;
    (listeners[name] as Function)(evt(request));
    await Promise.all(waited);
  }

  test("install caches the app shell and skips waiting", async () => {
    await fire("install", req("GET", "https://x/sw.js"));
    for (const u of ["/", "/index.html", "/app.js", "/styles.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"])
      expect(store.has("GET " + u)).toBe(true);
    expect(skipped).toBe(true);
  });

  test("activate drops old caches and claims clients", async () => {
    const deleted: string[] = [];
    sandbox.caches.delete = (k: string) => { deleted.push(k); return Promise.resolve(true); };
    await fire("activate", req("GET", "https://x/"));
    expect(deleted).toContain("abba-shell-00000");
    expect(deleted).not.toContain("abba-shell-12345");
    expect(claimed).toBe(true);
  });

  test("api traffic is never intercepted", async () => {
    await fire("fetch", req("GET", "https://x/api/notes"));
    expect(responded).toBeNull();
    await fire("fetch", req("POST", "https://x/api/notes"));
    expect(responded).toBeNull();
  });

  test("versioned asset urls resolve from cache", async () => {
    await fire("fetch", req("GET", "https://x/styles.css?v=999"));
    const hit: any = await responded!;
    expect(hit && hit.fromCache).toBe(true);
  });
});
