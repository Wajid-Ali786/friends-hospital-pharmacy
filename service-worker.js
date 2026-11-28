const CACHE_NAME = "friends-pharmacy-v111";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./vendor/firebase-bundle.js?v=3",
  "./stock.js?v=1",
  "./manifest.webmanifest",
  "./icon.svg",
  "./assets/icons/app-icon.png",
  "./assets/icons/favicon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => Promise.all(APP_SHELL.map(async url => {
      // cache:"reload" skips the browser HTTP cache so a new version never mixes with stale files
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (!response.ok) throw new Error("Could not cache " + url);
      await cache.put(url, response);
    })))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key.startsWith("friends-pharmacy-") && key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached =>
      cached || fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(error => {
        if (request.mode === "navigate") return caches.match("./index.html");
        throw error;
      })
    )
  );
});