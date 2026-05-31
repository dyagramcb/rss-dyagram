const cacheName = "rss-dyagram-pwa-20260531-2";
const shellAssets = [
  "/",
  "/index.html",
  "/styles.css?v=20260510-smaller-top-icons-1",
  "/app.js?v=20260531-culture-capital-1",
  "/estreias.xml",
  "/capital-portuguesa-cultura.xml",
  "/manifest.webmanifest",
  "/icons/rss-dyagram-192.png",
  "/icons/rss-dyagram-512.png",
  "/icons/rss-dyagram.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(cacheName)
      .then((cache) => cache.addAll(shellAssets))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("rss-dyagram-pwa-") && key !== cacheName)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/news") || url.pathname.startsWith("/api/rss") || url.pathname.startsWith("/api/article")) {
    event.respondWith(apiNetworkFirst(request));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(fallbackUrl, response.clone());
    }
    return response;
  } catch {
    return caches.match(fallbackUrl) || caches.match("/index.html");
  }
}

async function apiNetworkFirst(request) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
      return response;
    }

    return await caches.match(request) || response;
  } catch {
    return await caches.match(request) || new Response(JSON.stringify({
      error: "Sem ligação e sem cache guardada para este pedido."
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    });
  }
}
