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
