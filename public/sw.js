/*
 * Allos service worker — deliberately minimal (issue #134, Phase B).
 *
 * Goal: make the installed PWA tolerate a network blip without the browser's
 * blank error page, WITHOUT ever stashing auth-gated PHI in a shared-device
 * cache. So the policy is intentionally conservative:
 *
 *   - Immutable build assets (/_next/static/*) and the static icon are
 *     cache-first — they're content-hashed and carry no personal data.
 *   - Navigations (page loads) are network-only, falling back to a friendly
 *     /offline page ONLY when the network fails. Rendered HTML is never cached,
 *     so nothing personal is persisted.
 *   - Everything else (API calls, /settings, /login, medical file serves,
 *     profile photos, any non-GET) passes straight through to the network and
 *     is never touched. Writes stay online-only; there is no background sync.
 *
 * The cache name is stamped with the app version (passed as ?v=<sha> on the
 * worker's script URL by components/ServiceWorkerRegister.tsx). A deploy changes
 * the sha -> new cache name -> the activate step drops the stale caches.
 */

const SW_PARAMS = new URL(self.location.href).searchParams;
const VERSION = SW_PARAMS.get("v") || "dev";
const CACHE = `allos-shell-${VERSION}`;
const OFFLINE_URL = "/offline";
// Dev-mode disable is driven by an EXPLICIT signal from the registrar (?dev=1),
// NEVER inferred from the version string. A production deploy that ships without
// COMMIT_SHA falls back to version "dev" for cache-naming only — that must not
// disable the offline shell / PWA. components/ServiceWorkerRegister.tsx only
// registers the worker at all in production and never appends ?dev=1, so IS_DEV
// is false in production regardless of the version fallback; the dev-only
// disable is enforced there (it unregisters the worker outside production).
const IS_DEV = SW_PARAMS.get("dev") === "1";

// Small, non-sensitive app shell precached on install so the offline fallback
// (and its icon) are available the moment the network drops.
const PRECACHE = [OFFLINE_URL, "/icon.svg"];

self.addEventListener("install", (event) => {
  if (IS_DEV) {
    event.waitUntil(self.skipWaiting());
    return;
  }

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      // Take over as soon as installed; activate() then claims open clients.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions (busts on deploy).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (k) => k.startsWith("allos-shell-") && (IS_DEV || k !== CACHE)
          )
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// True only for immutable, non-sensitive assets that are safe to cache-first.
function isCacheableAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg")
  );
}

self.addEventListener("fetch", (event) => {
  if (IS_DEV) return;

  const req = event.request;

  // Never intercept writes — all mutations are online-only.
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Leave cross-origin requests to the network untouched.
  if (url.origin !== self.location.origin) return;

  // Page navigations: try the network, fall back to the offline page. The HTML
  // itself is never cached (it may contain PHI and is auth-gated).
  if (req.mode === "navigate") {
    event.respondWith(networkThenOffline(req));
    return;
  }

  // Immutable build assets: serve from cache first for instant, offline-capable
  // loads.
  if (isCacheableAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Everything else (/api/*, /settings*, /login, /medical/*, /profile-photo/*,
  // dynamic data) is left to the network and never cached.
});

// Background Sync for the offline write queue (issue #28) — a PROGRESSIVE
// ENHANCEMENT layered on top of the client's online/on-load flush
// (components/OfflineQueueProvider). The Background Sync API is Chromium/Android-
// only (no Firefox or Safari support as of 2026), so this is bonus reliability: it
// lets the browser replay a pending queue after connectivity returns even if no tab
// is open. The client registers the "allos-offline-replay" tag when it enqueues.
//
// The handler reads the same IndexedDB store the client writes (name/store/version
// mirror lib/offline/queue-db.ts), POSTs the intents to /api/offline-replay (the
// session cookie rides along automatically for a same-origin fetch), deletes the
// settled entries, and pokes any open tab to refresh. The server's replayed_keys
// ledger makes this idempotent even when it races the client's own flush.
const OFFLINE_SYNC_TAG = "allos-offline-replay";
const OFFLINE_DB = "allos-offline";
const OFFLINE_STORE = "intents";
const OFFLINE_DB_VERSION = 1;

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function offlineGetAll(db) {
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(OFFLINE_STORE, "readonly")
      .objectStore(OFFLINE_STORE)
      .getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function offlineDelete(db, keys) {
  return new Promise((resolve, reject) => {
    if (!keys.length) return resolve();
    const t = db.transaction(OFFLINE_STORE, "readwrite");
    const store = t.objectStore(OFFLINE_STORE);
    for (const k of keys) store.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function replayOfflineQueue() {
  const db = await openOfflineDb();
  const intents = await offlineGetAll(db);
  if (!intents.length) {
    db.close();
    return;
  }
  const res = await fetch("/api/offline-replay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intents }),
    credentials: "same-origin",
  });
  // Auth failure (401/403) or any non-OK: keep the queue for the next attempt; a
  // logged-out user is prompted to sign in the next time a tab flushes.
  if (!res.ok) {
    db.close();
    return;
  }
  const data = await res.json().catch(() => ({ results: [] }));
  const settled = (data.results || [])
    .filter(
      (r) =>
        r.status === "done" ||
        r.status === "duplicate" ||
        r.status === "rejected"
    )
    .map((r) => r.key);
  await offlineDelete(db, settled);
  db.close();
  // Nudge any open tab to refresh its badge / view.
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "allos-flush-queue" });
  }
}

self.addEventListener("sync", (event) => {
  if (IS_DEV) return;
  if (event.tag === OFFLINE_SYNC_TAG) {
    event.waitUntil(
      replayOfflineQueue().catch(() => {
        // A rejected replay leaves the queue intact; the browser retries the tag
        // (Background Sync) and the client flush is the safety net.
      })
    );
  }
});

// Web Push (issue #17). The server (lib/notifications/push.ts) sends a tiny JSON
// blob { title, body, url } — deliberately terse and no more revealing than the
// Telegram message, since it lands on the user's own device. We only ever SHOW a
// notification here; nothing is cached and no PHI is persisted.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Allos";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      // The deep link to open on tap (see notificationclick). Defaults to the app
      // root when the payload omits it.
      data: { url: data.url || "/" },
    })
  );
});

// Tapping a push: focus an already-open Allos tab (navigating it to the deep
// link) or open a new one. Same-origin only — url comes from our own payload.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          // Move the focused tab to the deep link when it supports navigation.
          if ("navigate" in client && url) {
            try {
              await client.navigate(url);
            } catch {
              // Cross-document navigation can reject (e.g. different top-level);
              // focusing the existing tab is still the right outcome.
            }
          }
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});

async function networkThenOffline(req) {
  try {
    return await fetch(req);
  } catch {
    const cache = await caches.open(CACHE);
    const offline = await cache.match(OFFLINE_URL);
    return (
      offline ||
      new Response("You are offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  // Only cache successful, complete (non-partial, same-origin) responses.
  if (res.ok && res.status === 200) {
    cache.put(req, res.clone());
  }
  return res;
}
