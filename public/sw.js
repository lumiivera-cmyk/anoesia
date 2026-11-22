/*
 * Anoesia's service worker. It exists so Android Chrome installs Anoesia as
 * a real full-screen app (a WebAPK) rather than a shortcut with Chrome's
 * title bar. It caches nothing and works offline no better than before:
 * page loads go straight to the network, and everything else (the API,
 * streamed replies, photos) never passes through it at all.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") event.respondWith(fetch(event.request));
});
