// The route → page-name registry (issue #1416, section E3).
//
// ── WHAT THIS FILE USED TO BE, AND WHY THE REST OF IT IS GONE ────────────────
//
// It was the pure half of "Frequent": a per-device tally of page visits in
// `localStorage` under `allos:page-visits:v1`, ranked into a four-shortcut row at
// the top of the drawer. #4102 retired that outright. With the dock covering the
// daily set and Search covering lookups the row duplicated both, and it was the
// nav's only NON-DETERMINISTIC element — chrome that quietly reordered itself
// under a user who had no way to ask why. #1042's "no pinned/frecent nav
// machinery" now holds without exception, and the tally, the ranking, the storage
// key and the component that read them are all deleted rather than left dormant.
//
// ── WHAT SURVIVED, AND WHAT NO LONGER READS IT ───────────────────────────────
//
// The allowlist below outlived its first consumer because it answers a different
// question: not "where does this login go most", which is retired, but "what is
// this route CALLED" — the only registry in the app that maps a route to its
// human name. Its second consumer is now gone too, and saying so plainly is the
// point of this paragraph: the reason recorded here was that the dashboard read
// it for its Show-everything doors and its Standing door labels and that
// `DashboardPlacementCanvas` THREW on a route it could not name, which made the
// list load-bearing for a rendered page. #5435 §4 retires all three, and the
// canvas, the cluster and that throw are deleted with them.
//
// SO NOTHING IN PRODUCTION READS `TRACKED_PAGES` OR `trackedPageFor` TODAY. The
// only half of this file with a live caller is the tombstone below
// (`clearRetiredPageVisits`, from components/SidebarContent.tsx), and the reader
// who arrives here looking for the load-bearing claim should find this sentence
// instead of hunting a consumer that no longer exists. What is NOT claimed here
// is a replacement reason: the list is kept because it is the app's only
// route-to-name registry and the next surface that needs one should find it
// whole rather than half-deleted, not because something is rendering from it.
// Retiring it outright is a decision about that registry, with its own PR.
//
// The set is an ALLOWLIST of top-level destinations rather than "any pathname".
// A detail route (`/medical/episodes/17`, `/import/5`) has no name to give, and
// hrefs are typed `AppRoute`, so a page removed in a future consolidation fails
// the build here (the #285 dead-link class) instead of naming something gone.

import type { AppRoute } from "./hrefs";

export interface TrackedPage {
  href: AppRoute;
  label: string;
}

// The visit tally is retired, but an upgraded browser can still carry the old
// value. Keep only this tombstone until every active device has loaded the new
// shell: it can DELETE the retired state and can never read or write it.
export const RETIRED_PAGE_VISITS_KEY = "allos:page-visits:v1";

export function clearRetiredPageVisits(storage: {
  removeItem(key: string): void;
}): void {
  storage.removeItem(RETIRED_PAGE_VISITS_KEY);
}

// Mirrors the nav's top-level destinations (components/Nav.tsx) plus the Medical
// group's leaves. Adding a nav leaf here is optional; omitting one used to mean a
// throw from the dashboard's door labels, and since #5435 §4 deleted that reader
// it means only that `trackedPageFor` answers null for the route.
export const TRACKED_PAGES: TrackedPage[] = [
  { href: "/", label: "Dashboard" },
  { href: "/training", label: "Training" },
  { href: "/nutrition", label: "Nutrition" },
  { href: "/history", label: "History" },
  { href: "/trends", label: "Trends" },
  { href: "/retrospective", label: "Year in review" },
  { href: "/sleep", label: "Sleep" },
  { href: "/progress", label: "Progress photos" },
  { href: "/upcoming", label: "Upcoming" },
  { href: "/household", label: "Household" },
  { href: "/wellness", label: "Wellness" },
  { href: "/longevity", label: "Longevity" },
  { href: "/records", label: "Health record" },
  { href: "/results", label: "Results" },
  { href: "/medications", label: "Medications" },
  { href: "/supplies", label: "Medicine cabinet" },
  { href: "/medical/episodes", label: "Illness episodes" },
  { href: "/medical/cycles", label: "Cycle" },
  { href: "/profile", label: "Passport" },
  { href: "/equipment", label: "Equipment" },
  { href: "/data", label: "Data" },
  // Not a nav leaf: `/integrations` itself redirects to Data → Import, but every
  // per-source setup page is a child of it, so a caller asking what one of those
  // pages is CALLED gets an answer. The rows that used to need it — the
  // dashboard's source asks in Ahead — went with #5435 §4.
  { href: "/integrations", label: "Integrations" },
  { href: "/settings", label: "Settings" },
];

// The tracked page a pathname belongs to, or null. Exact match wins over a
// prefix so `/medical/episodes` beats nothing and `/records/care/providers`
// resolves to `/records`. "/" only ever matches exactly (every path starts with
// it).
//
// The query AND the hash are cut before matching: since #1644 a section deep link
// carries its anchor (`/trends#body`), and a fragment is a position on a page,
// never a different page. The two defects this fixed both belonged to the retired
// tally, so the reason is restated for the reader it has now: a caller asking
// "what is `/trends#body` called" must get "Trends", not null.
export function trackedPageFor(pathname: string): TrackedPage | null {
  const path = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const exact = TRACKED_PAGES.find((p) => p.href === path);
  if (exact) return exact;
  const prefixed = TRACKED_PAGES.filter(
    (p) => p.href !== "/" && path.startsWith(`${p.href}/`)
  );
  // Longest href wins: /medical/episodes/17 belongs to Illness episodes, not to
  // any shorter /medical* entry that might be added later.
  return prefixed.sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}
