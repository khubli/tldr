// Registers the service worker so Android Chrome offers "Install app",
// which puts tl;dr in the phone's share sheet.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
