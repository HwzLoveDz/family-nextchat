// Deliberately independent of the legacy stores: importing them hydrates old data.
const LEGACY_KEYS = [
  "chat-next-web-store",
  "chat-next-web-plugin",
  "access-control",
  "app-config",
  "mask-store",
  "prompt-store",
  "chat-update",
  "sync",
  "sd-list",
  "mcp-store",
  "last-input",
];
const LEGACY_CACHES = ["chatgpt-next-web-cache", "chatgpt-next-web-file"];
export const FAMILY_SESSION_CHANNEL = "family-session-change";
export const FAMILY_SESSION_EVENT = "family-session-event";

async function retireLegacyWorker(registration: ServiceWorkerRegistration) {
  let timeout: number | undefined;
  try {
    // Give the tombstone worker a chance to refresh other open legacy tabs.
    await Promise.race([
      registration.update(),
      new Promise<void>((resolve) => {
        timeout = window.setTimeout(resolve, 2000);
      }),
    ]);
    if (timeout !== undefined) window.clearTimeout(timeout);
    const worker = registration.installing ?? registration.waiting;
    if (
      worker &&
      worker.state !== "activated" &&
      worker.state !== "redundant"
    ) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          if (timeout !== undefined) window.clearTimeout(timeout);
          worker.removeEventListener("statechange", changed);
          resolve();
        };
        const changed = () => {
          if (worker.state === "activated" || worker.state === "redundant")
            finish();
        };
        timeout = window.setTimeout(finish, 2000);
        worker.addEventListener("statechange", changed);
        changed();
      });
    }
  } catch {
    // Offline / CSP failure still retires the old registration.
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    await registration.unregister();
  }
}

function clearLegacyIndexedDB(): Promise<void> {
  if (!("indexedDB" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    let database: IDBDatabase | undefined;
    const timeout = window.setTimeout(() => {
      database?.close();
      resolve();
    }, 2500);
    const finish = () => {
      window.clearTimeout(timeout);
      database?.close();
      resolve();
    };
    try {
      const request = indexedDB.open("keyval-store");
      // Do not create a legacy database on a clean browser.
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = finish;
      request.onblocked = finish;
      request.onsuccess = () => {
        database = request.result;
        if (!database.objectStoreNames.contains("keyval")) return finish();
        const transaction = database.transaction("keyval", "readwrite");
        const store = transaction.objectStore("keyval");
        LEGACY_KEYS.forEach((key) => store.delete(key));
        const cursor = store.openKeyCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          if (
            typeof entry.key === "string" &&
            entry.key.startsWith("unfinished-input-")
          ) {
            store.delete(entry.key);
          }
          entry.continue();
        };
        transaction.oncomplete = finish;
        transaction.onerror = finish;
        transaction.onabort = finish;
      };
    } catch {
      finish();
    }
  });
}

/** Remove only this app's known legacy data, never unrelated origin storage. */
export async function clearLegacyFamilyData(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    LEGACY_KEYS.forEach((key) => window.localStorage.removeItem(key));
    for (let index = window.localStorage.length - 1; index >= 0; index--) {
      const key = window.localStorage.key(index);
      if (key?.startsWith("unfinished-input-")) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Storage can be unavailable in private browsing. No private store is loaded.
  }
  await Promise.allSettled([
    clearLegacyIndexedDB(),
    "caches" in window
      ? Promise.all(LEGACY_CACHES.map((name) => caches.delete(name)))
      : Promise.resolve(),
    "serviceWorker" in navigator
      ? navigator.serviceWorker.getRegistrations().then((registrations) =>
          Promise.all(
            registrations
              .filter((registration) =>
                [
                  registration.active,
                  registration.waiting,
                  registration.installing,
                ]
                  .filter(Boolean)
                  .some((worker) => {
                    const url = new URL(worker!.scriptURL);
                    return (
                      url.origin === location.origin &&
                      url.pathname === "/serviceWorker.js"
                    );
                  }),
              )
              .map(retireLegacyWorker),
          ),
        )
      : Promise.resolve(),
  ]);
}
