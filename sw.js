const CACHE = "pinward-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./src/main.js",
  "./src/game.js",
  "./src/renderer.js",
  "./src/physics.js",
  "./src/entities.js",
  "./src/waves.js",
  "./src/cards.js",
  "./src/audio.js",
  "./src/storage.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("pinward-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  if (
    event.request.method !== "GET" ||
    new URL(event.request.url).origin !== self.location.origin
  )
    return;
  // Fresh online, cached offline; never cache arbitrary external resources.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response.ok &&
          ASSETS.some(
            (path) =>
              new URL(path, self.registration.scope).href === event.request.url,
          )
        ) {
          const copy = response.clone();
          event.waitUntil(
            caches.open(CACHE).then((cache) => cache.put(event.request, copy)),
          );
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then(
            (cached) =>
              cached ||
              (event.request.mode === "navigate"
                ? caches.match("./index.html")
                : Response.error()),
          ),
      ),
  );
});
