// Minimal service worker. It exists so the site can be installed as an app
// (and receive shares). It caches nothing: every page comes fresh from the
// server, behind the login.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
