 

const CACHE_NAME = "caliche-cards-v1";

const PRECACHE_URLS = ["/", "/manifest.webmanifest", "/icon", "/apple-icon"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Avoid caching Next.js RSC/data requests too aggressively.
  const url = new URL(request.url);
  if (url.pathname.startsWith("/_next/image")) return;

  if (url.pathname.startsWith("/_next/static")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Cache basic successful same-origin responses
        if (response && response.status === 200 && url.origin === self.location.origin) {
          cache.put(request, response.clone());
        }
        return response;
      } catch (err) {
        // Offline fallback: cached root if available
        const fallback = await cache.match("/");
        if (fallback) return fallback;
        throw err;
      }
    })()
  );
});
