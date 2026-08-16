// WARMING THE OFFLINE SHELL'S OWN CODE (owner ruling, 2026-08-16, issue #2997).
//
// THE DEFECT. `public/sw.js` precaches exactly two things: the `/offline` HTML and the
// icon. Build assets are `cacheFirst`, which caches them as a SIDE EFFECT of being
// fetched — so `/offline`'s route chunk is in the cache only if `/offline` has already
// been loaded in this browser. Nothing in the app links to `/offline`, prefetches it, or
// visits it. So for a first-time offline user the precached HTML is served, renders, and
// then NEVER HYDRATES: no snapshot list, no emergency-card button, no "Try again" — a
// page that looks like it loaded and does nothing.
//
// That is not only this feature's problem. `app/offline/page.tsx` is a client component
// and the SHIPPED Emergency Card (#42) reads its localStorage copy from it, so the card
// has the same dependency today: it is readable in a dead zone only for someone who
// happened to open `/offline` while online first. Both e2e specs warm it by hand, which
// is what surfaced the gap.
//
// THE RULING, and its shape. The invariant is amended NARROWLY: the shell + icon rule
// still governs what is PRECACHED, and a warm-up fetch may populate the route chunk
// through the `cacheFirst` path that already exists. Rendered HTML is still never
// cached, and PHI is still never cached — both unchanged, and nothing here touches
// either. A content-hashed static chunk is already declared non-personal by
// `isCacheableAsset` and already lands in that cache lazily; this moves only WHEN it
// arrives, never WHETHER.
//
// WHY THE HTML IS READ RATHER THAN THE CHUNK NAMED. Precaching the chunk directly was
// considered and rejected: the filename is content-hashed by the build, so naming it in
// `sw.js` would couple the worker to the build output and rot silently on the first
// rename. The page's own HTML is the build's authoritative statement of which assets it
// needs, so we ask it. The HTML fetch itself is a plain GET, not a navigation — the
// worker passes it straight through and caches nothing, which is exactly the behaviour
// the invariant requires of rendered HTML.

// The public offline fallback, mirroring `OFFLINE_URL` in public/sw.js.
export const OFFLINE_ROUTE = "/offline";

// A bound on the work, so a build that one day emits a hundred chunks for this route
// cannot turn a background warm-up into a burst. `/offline` is one small client page;
// this is generous headroom, not a target.
export const MAX_WARMED_ASSETS = 60;

// The immutable build assets a page's HTML declares — `<script src>`, `<link href>`, and
// the flight payload's own module references alike, since all three are the same URL
// shape and all three go through `isCacheableAsset`. Pure and unit-tested: the parsing
// is the part that can be wrong without anyone noticing, because a warm-up that finds
// NOTHING fails exactly as silently as the defect it fixes.
//
// Only `.js` and `.css` — those are what hydration needs. Fonts and images under
// /_next/static/media are cacheable too, but they are not the difference between a page
// that works offline and a page that does not, and warming them would cost bytes for
// appearance.
export function offlineRouteAssetUrls(html: string): string[] {
  const found = html.match(/\/_next\/static\/[A-Za-z0-9._~\-/]+/g) ?? [];
  const wanted = found.filter((u) => u.endsWith(".js") || u.endsWith(".css"));
  return [...new Set(wanted)].slice(0, MAX_WARMED_ASSETS);
}

// Once per page load. A second warm-up would re-fetch the HTML to learn the same answer,
// and every asset it names is a cache hit by then. Module state, so a reload — including
// the one a service-worker update triggers, which is when a NEW cache generation needs
// warming — starts over.
let warmed = false;

/**
 * Populate the `/offline` route's chunks into the service worker's asset cache, so the
 * precached shell can actually hydrate the first time it is served.
 *
 * Best-effort and silent by construction: every failure path (no worker, no network, a
 * 404, a changed HTML shape) leaves the app exactly as it is today. It is called from
 * the authenticated refresher because that is the one online, authenticated,
 * once-per-visit actor that already exists — but it is SHELL-level work, deliberately
 * not gated on the offline-snapshots toggle: the emergency card depends on it too, and
 * it is a separate feature with a separate opt-in.
 */
export async function warmOfflineRoute(): Promise<void> {
  if (warmed) return;
  if (typeof navigator === "undefined") return;
  if (navigator.onLine === false) return;
  // No controlling worker means no cache to warm — and on a first visit it means the
  // worker has not claimed this page yet, which the next navigation's run will catch.
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    return;
  }
  warmed = true;
  try {
    const res = await fetch(OFFLINE_ROUTE, {
      headers: { Accept: "text/html" },
    });
    if (!res.ok) {
      warmed = false;
      return;
    }
    const urls = offlineRouteAssetUrls(await res.text());
    if (urls.length === 0) {
      // The HTML said nothing we recognise. Do not latch: a later run may do better,
      // and latching would make a parser that has gone stale permanent.
      warmed = false;
      return;
    }
    // Each of these is a cacheable asset, so the worker's `cacheFirst` stores it on the
    // way past. Most are already cached (the current page loaded them), and a cache hit
    // costs no network at all — the route-specific chunks are the real work.
    await Promise.all(urls.map((u) => fetch(u).catch(() => undefined)));
  } catch {
    /* offline, a blip, a worker mid-update — the next page load tries again */
    warmed = false;
  }
}

/** Test seam: the latch is module state. */
export function resetOfflineRouteWarming(): void {
  warmed = false;
}
