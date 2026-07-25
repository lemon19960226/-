const CACHE_NAME = "retirement-dashboard-v9";
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "ocr-date-fix.js?v=1",
  "app-mixed-launch.js?v=4",
  "manifest.webmanifest",
  "assets/app-icon-180.png",
  "assets/app-icon-192.png",
  "assets/app-icon-512.png",
  "assets/progress-mascot.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("index.html")));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
