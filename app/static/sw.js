const CACHE_NAME = "local-bridge-v2";
const ACCOUNT = "/account";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(ACCOUNT))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate" && new URL(e.request.url).pathname === ACCOUNT) {
    e.respondWith(fetch(e.request).catch(() => caches.match(ACCOUNT)));
    return;
  }
  if (e.request.url.includes("execute-api") || e.request.url.includes("/api/")) {
    return; // Don't cache API calls
  }
});
