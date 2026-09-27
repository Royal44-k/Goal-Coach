const CACHE_NAME = "goal-coach-offline-v1";
const CACHE_PREFIX = "goal-coach-offline-";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.add(OFFLINE_URL)));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(names => Promise.all(
    names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || request.mode !== "navigate" || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).catch(async () => {
    const cached = await (await caches.open(CACHE_NAME)).match(OFFLINE_URL);
    return cached ?? new Response("<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>当前离线</title><p>当前离线，请联网后继续。</p></html>", {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }));
});
