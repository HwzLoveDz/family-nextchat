// Safety upgrade for browsers still controlled by an older NextChat worker.
// This version never intercepts requests or stores private conversations/files.
const LEGACY_CACHES = ["chatgpt-next-web-cache", "chatgpt-next-web-file"];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(LEGACY_CACHES.map((name) => caches.delete(name)));
      await self.clients.claim();
      // Existing legacy tabs keep their in-memory store until navigation.
      // Refresh only pages on this origin into the isolated family UI.
      const pages = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      await Promise.all(
        pages.map(async (page) => {
          const url = new URL(page.url);
          if (url.origin === self.location.origin) {
            await page.navigate(page.url).catch(() => undefined);
          }
        }),
      );
      await self.registration.unregister();
    })(),
  );
});
