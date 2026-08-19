

const CACHE_NAME = "nullvault-v2";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./settings.json",
  "./app-list.json",
  "./icons/icon-72.png",
  "./icons/icon-96.png",
  "./icons/icon-128.png",
  "./icons/icon-144.png",
  "./icons/icon-152.png",
  "./icons/icon-192.png",
  "./icons/icon-384.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => {
        // Don't let one missing precache asset block install entirely —
        // log it and continue; the fetch handler will still cache
        // successful responses opportunistically at runtime.
        console.warn("[SW] Precache warning:", err);
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Don't try to cache cross-origin requests (Firebase, CDN fonts, CDN
  // Firebase SDK, external screenshot images, etc.) — let those go
  // straight to network so auth/Firestore always behave normally.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline fallback to whatever's cached

      // Cache-first for instant loads, but still refresh cache in the
      // background (stale-while-revalidate) so config/catalog edits
      // are picked up on next reload without needing a hard refresh.
      return cached || networkFetch;
    })
  );
});
