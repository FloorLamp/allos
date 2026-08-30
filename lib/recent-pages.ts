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
// ── WHAT SURVIVED, AND WHY IT IS NOT DEAD CODE ───────────────────────────────
//
// The allowlist below outlived its first consumer because it answers a different
// question: not "where does this login go most", which is retired, but "what is
// this route CALLED" — the only registry in the app that maps a route to its
// human name. The dashboard reads it for its Show-everything doors and its
// Standing door labels, and `DashboardPlacementCanvas` THROWS on a route it
// cannot name, so this list is load-bearing for a rendered page and not a
// leftover. Deleting it would be a dashboard change wearing a nav change's
// clothes.
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

// Mirrors the nav's top-level destinations (components/Nav.tsx) plus the Medical
// group's leaves. Adding a nav leaf here is optional; omitting one means the
// dashboard has no name for that route, which is a throw and not a silent gap.
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
