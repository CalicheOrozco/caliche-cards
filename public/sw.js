// Bump this when changing caching behavior to ensure old caches are dropped.
const CACHE_NAME = "caliche-cards-v4";

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/sql-wasm.wasm",
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

  // Icons: try cache first, then network. Never block the app going offline
  // just because a favicon can't be fetched.
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
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        } catch {
          return Response.error();
        }
      })()
    );
    return;
  }

  // For navigations: try network with a SHORT timeout, then fall back to
  // the cached shell. Without the timeout, Safari hangs for 30-60 s on iOS
  // before surfacing its own "no connection" page — the SW fallback never runs.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);
          let response;
          try {
            response = await fetch(request, { signal: controller.signal });
          } finally {
            clearTimeout(timeoutId);
          }
          // Keep the cached shell up-to-date while online.
          if (response && response.status === 200) {
            cache.put(new Request("/"), response.clone());
          }
          return response;
        } catch {
          // Network failed or timed out — serve the cached shell.
          const cached = await cache.match("/");
          if (cached) return cached;
          return Response.error();
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
