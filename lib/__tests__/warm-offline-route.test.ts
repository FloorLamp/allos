// The /offline shell warm-up's parser (owner ruling 2026-08-16, issue #2997).
//
// `public/sw.js` precaches the /offline HTML and the icon and nothing else; build assets
// are cached as a side effect of being fetched. Nothing in the app links to /offline, so
// its route chunk was in the cache only for someone who had already opened /offline
// while online — and without it the precached shell renders and never hydrates. That
// broke this feature's whole justification (someone who set nothing up in advance) and
// the SHIPPED emergency card with it, which reads its copy from the same client page.
//
// The parser is the half that can go wrong invisibly: a warm-up that finds NOTHING fails
// exactly as silently as the defect it fixes, so what it extracts from a real page's
// HTML is pinned here rather than left to the e2e to notice.

import { describe, it, expect } from "vitest";
import {
  MAX_WARMED_ASSETS,
  OFFLINE_ROUTE,
  offlineRouteAssetUrls,
} from "@/lib/offline/warm-offline-route";

// The three shapes a Next App Router document states its assets in: a preload link, a
// script tag, and the flight payload's own escaped references.
const HTML = `<!DOCTYPE html><html><head>
<link rel="preload" href="/_next/static/chunks/abc123.js" as="script"/>
<link rel="stylesheet" href="/_next/static/css/def456.css"/>
</head><body>
<script src="/_next/static/chunks/main-app-789.js" async></script>
<script>self.__next_f.push([1,"3:I[\\"/_next/static/chunks/offline-page-xyz.js\\",[],\\"\\"]"])</script>
<img src="/_next/static/media/logo-000.svg"/>
<a href="/offline">nope</a>
</body></html>`;

describe("offlineRouteAssetUrls (#2997)", () => {
  it("finds the route's code however the document names it", () => {
    expect(offlineRouteAssetUrls(HTML)).toEqual([
      "/_next/static/chunks/abc123.js",
      "/_next/static/css/def456.css",
      "/_next/static/chunks/main-app-789.js",
      "/_next/static/chunks/offline-page-xyz.js",
    ]);
  });

  it("takes only what hydration needs, and only from our own build", () => {
    const urls = offlineRouteAssetUrls(HTML);
    // Media is cacheable too, but a font or a logo is not the difference between a page
    // that works offline and a page that does not.
    expect(urls.some((u) => u.includes("/media/"))).toBe(false);
    // Never a page URL, never an API route — `isCacheableAsset` would refuse them and
    // fetching them would be an uncached round trip for nothing.
    for (const u of urls) expect(u.startsWith("/_next/static/")).toBe(true);
    expect(urls).not.toContain(OFFLINE_ROUTE);
  });

  it("dedupes, because a document names its shared chunks more than once", () => {
    const repeated = `${HTML}<script src="/_next/static/chunks/abc123.js"></script>`;
    expect(offlineRouteAssetUrls(repeated)).toEqual(
      offlineRouteAssetUrls(HTML)
    );
  });

  it("is bounded — a warm-up is background work, never a burst", () => {
    const many = Array.from(
      { length: MAX_WARMED_ASSETS + 25 },
      (_, i) => `<script src="/_next/static/chunks/c${i}.js"></script>`
    ).join("");
    expect(offlineRouteAssetUrls(many)).toHaveLength(MAX_WARMED_ASSETS);
  });

  it("answers empty for HTML that names nothing, rather than guessing", () => {
    // The caller treats empty as "do not latch": a parser that has gone stale gets
    // another chance on the next page load instead of permanently doing nothing.
    expect(offlineRouteAssetUrls("<html><body>hi</body></html>")).toEqual([]);
  });
});
