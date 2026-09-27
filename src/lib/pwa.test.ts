import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import manifest from "@/app/manifest";

type Event = { request: Request; respondWith: ReturnType<typeof vi.fn> };

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const entries = new Map<string, Response>();
  const deleted: string[] = [];
  const names = ["goal-coach-offline-v0", "other-app-cache"];
  const cache = {
    add: vi.fn(async (url: string) => { entries.set(url, new Response("offline page")); }),
    match: vi.fn(async (url: string) => entries.get(url)),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => names),
    delete: vi.fn(async (name: string) => { deleted.push(name); return true; }),
  };
  const fetch = vi.fn(async () => new Response("private navigation"));
  const self = { location: { origin: "https://goal.example" }, clients: { claim: vi.fn(async () => undefined) }, addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), skipWaiting: vi.fn() };
  runInNewContext(readFileSync("public/sw.js", "utf8"), { self, caches, fetch, URL, Response });
  const dispatch = (request: Request) => {
    const event: Event = { request, respondWith: vi.fn() };
    listeners.get("fetch")!(event);
    return event;
  };
  return { listeners, entries, deleted, cache, caches, fetch, self, dispatch };
}

describe("install manifest", () => {
  it("starts the standalone app at its scoped root with usable icons", () => {
    expect(manifest()).toMatchObject({ name: "Goal Coach", short_name: "Goal Coach", start_url: "/", scope: "/", id: "/", display: "standalone", lang: "zh-CN" });
    expect(manifest().icons?.map(icon => icon.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const size of [192, 512]) {
      const data = readFileSync(`public/icons/icon-${size}.png`);
      expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(data.readUInt32BE(16)).toBe(size);
      expect(data.readUInt32BE(20)).toBe(size);
    }
  });

  it("ships a real 180px Apple touch icon", () => {
    const apple = readFileSync("public/icons/apple-touch-icon-180.png");
    expect([...apple.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(apple.readUInt32BE(16)).toBe(180);
    expect(apple.readUInt32BE(20)).toBe(180);
  });
});

describe("offline worker", () => {
  it("never intercepts writes, API, or cross-origin traffic", () => {
    const sw = worker();
    for (const request of [
      new Request("https://goal.example/api/agent", { method: "POST" }),
      new Request("https://goal.example/api/settings"),
      { url: "https://goal.example/api", method: "GET", mode: "navigate" } as Request,
      { url: "https://another.example/", method: "GET", mode: "navigate" } as Request,
    ]) expect(sw.dispatch(request).respondWith).not.toHaveBeenCalled();
    expect(sw.caches.open).not.toHaveBeenCalled();
  });

  it("passes navigation through without caching and shows only a static offline fallback on failure", async () => {
    const sw = worker();
    let installed: Promise<unknown> = Promise.resolve();
    sw.listeners.get("install")!({ waitUntil: (promise: Promise<unknown>) => { installed = promise; } });
    await installed;
    sw.cache.add.mockClear();
    const request = { url: "https://goal.example/goals/private", method: "GET", mode: "navigate" } as Request;
    const online = sw.dispatch(request);
    const response = await online.respondWith.mock.calls[0][0];
    expect(await response.text()).toBe("private navigation");
    expect(sw.cache.add).not.toHaveBeenCalled();
    sw.fetch.mockRejectedValueOnce(new Error("network down"));
    const offline = sw.dispatch(request);
    expect(await (await offline.respondWith.mock.calls[0][0]).text()).toContain("offline page");
    expect(sw.cache.add).not.toHaveBeenCalled();
    sw.entries.clear();
    sw.fetch.mockRejectedValueOnce(new Error("network down"));
    const missing = sw.dispatch(request);
    expect(await (await missing.respondWith.mock.calls[0][0]).text()).toContain("当前离线");
  });

  it("pre-caches only the public offline page and removes only old own caches", async () => {
    const sw = worker();
    let pending: Promise<unknown> = Promise.resolve();
    sw.listeners.get("install")!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(sw.cache.add).toHaveBeenCalledWith("/offline.html");
    sw.listeners.get("activate")!({ waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
    await pending;
    expect(sw.deleted).toEqual(["goal-coach-offline-v0"]);
    expect(sw.self.clients.claim).toHaveBeenCalledOnce();
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
    sw.listeners.get("message")!({ data: { type: "SKIP_WAITING" } });
    expect(sw.self.skipWaiting).toHaveBeenCalledOnce();
  });
});
