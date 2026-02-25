 

// Bump this when changing caching behavior to ensure old caches are dropped.
const CACHE_NAME = "caliche-cards-v3";

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/icon",
  "/apple-icon",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(PRECACHE_URLS);
      } catch {
        // If precache fails (redirects, transient network), still install.
      }
      await self.skipWaiting();
    })()
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
  // Never cache API responses.
  if (url.pathname.startsWith("/api/")) return;

  // Don't cache icons; browsers (Safari especially) can get stuck on old ones.
  if (
    url.pathname === "/favicon.ico" ||
    url.pathname === "/favicon-16x16.png" ||
    url.pathname === "/favicon-32x32.png" ||
    url.pathname === "/apple-touch-icon.png" ||
    url.pathname === "/apple-touch-icon-precomposed.png" ||
    url.pathname === "/logo.ico" ||
    url.pathname === "/logo.png" ||
    url.pathname === "/logo-180.png" ||
    url.pathname === "/logo-192.png" ||
    url.pathname === "/logo-512.png"
  ) {
    event.respondWith(fetch(request));
    return;
  }

  // For navigations, prefer network to avoid serving stale HTML across deploys.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match("/")) || Response.error();
        }
      })()
    );
    return;
  }
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
