// Most-visited page shortcuts (issue #1416, section E3) — the PURE half.
//
// The drawer is a full navigation tree; on a phone that means scrolling past a
// dozen entries to reach the two or three surfaces this login actually lives in.
// The fix is a small "Frequent" row at the top of the shared sidebar content,
// ordered by how often the login has visited each page.
//
// Deliberately CLIENT-SIDE and schema-free: visit counts are a per-device
// display preference, not health data. They live in `localStorage` under one key
// (components/FrequentPages.tsx owns that I/O); everything that DECIDES anything
// — what counts as a visit, how a path maps to a page, which pages win — is here
// and unit-tested.
//
// The tracked set is an ALLOWLIST of top-level destinations rather than "any
// pathname visited". Two reasons: a detail route (`/medical/episodes/17`,
// `/import/5`) is a poor shortcut and its label would have to be invented, and
// an allowlist keeps stored keys bounded and non-identifying. Hrefs are typed
// `AppRoute`, so a page removed in a future consolidation fails the build here
// (the #285 dead-link class) instead of shipping a dead shortcut.

import type { AppRoute } from "./hrefs";

export interface TrackedPage {
  href: AppRoute;
  label: string;
}

// Mirrors the nav's top-level destinations (components/Nav.tsx) plus the Medical
// group's leaves — the pages a shortcut is worth spending a row on. Adding a
// nav leaf here is optional; omitting one just means it never appears as a
// shortcut.
export const TRACKED_PAGES: TrackedPage[] = [
  { href: "/", label: "Dashboard" },
  { href: "/training", label: "Training" },
  { href: "/nutrition", label: "Nutrition" },
  { href: "/timeline", label: "Timeline" },
  { href: "/trends", label: "Trends" },
  { href: "/sleep", label: "Sleep" },
  { href: "/progress", label: "Progress photos" },
  { href: "/upcoming", label: "Upcoming" },
  { href: "/household", label: "Household" },
  { href: "/longevity", label: "Longevity" },
  { href: "/records", label: "Health record" },
  { href: "/results", label: "Results" },
  { href: "/medications", label: "Medications" },
  { href: "/medical/episodes", label: "Illness episodes" },
  { href: "/medical/cycles", label: "Cycle" },
  { href: "/profile", label: "Passport" },
  { href: "/equipment", label: "Equipment" },
  { href: "/data", label: "Data" },
  { href: "/settings", label: "Settings" },
];

// The localStorage key. Versioned so a future shape change can be ignored rather
// than migrated (a dropped visit history costs nothing).
export const PAGE_VISITS_KEY = "allos:page-visits:v1";

// Per-page tally: `n` visits, `t` = the epoch ms of the most recent one (the
// tie-break, and what pruning drops first).
export interface PageVisit {
  n: number;
  t: number;
}
export type PageVisits = Record<string, PageVisit>;

// How many pages we keep tallies for. Well above the tracked-page count, so this
// is purely a defence against a corrupted/hand-edited store.
export const MAX_TRACKED = 50;

// How many shortcuts the drawer shows, and the floor a page must clear to earn a
// row — one accidental visit is not a habit.
export const FREQUENT_LIMIT = 4;
export const FREQUENT_MIN_VISITS = 3;

// The tracked page a pathname belongs to, or null. Exact match wins over a
// prefix so `/medical/episodes` beats nothing and `/records/care/providers`
// resolves to `/records`. "/" only ever matches exactly (every path starts with
// it).
export function trackedPageFor(pathname: string): TrackedPage | null {
  const path = pathname.split("?")[0].replace(/\/+$/, "") || "/";
  const exact = TRACKED_PAGES.find((p) => p.href === path);
  if (exact) return exact;
  const prefixed = TRACKED_PAGES.filter(
    (p) => p.href !== "/" && path.startsWith(`${p.href}/`)
  );
  // Longest href wins: /medical/episodes/17 belongs to Illness episodes, not to
  // any shorter /medical* entry that might be added later.
  return prefixed.sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}

// Fold a visit into the tally. Returns a NEW object (never mutates), ignores an
// untracked path, and prunes the least-recently-visited entries past MAX_TRACKED.
export function recordPageVisit(
  visits: PageVisits,
  pathname: string,
  now: number
): PageVisits {
  const page = trackedPageFor(pathname);
  if (!page) return visits;
  const prev = visits[page.href];
  const next: PageVisits = {
    ...visits,
    [page.href]: { n: (prev?.n ?? 0) + 1, t: now },
  };
  const keys = Object.keys(next);
  if (keys.length <= MAX_TRACKED) return next;
  const keep = keys.sort((a, b) => next[b].t - next[a].t).slice(0, MAX_TRACKED);
  return Object.fromEntries(keep.map((k) => [k, next[k]]));
}

// The shortcuts to render: most-visited first, ties broken by recency, capped at
// `limit`, and never including the page you are already on (a shortcut to here
// is a wasted row). Returns [] until at least one page clears the floor, so a
// fresh login sees no empty section.
export function frequentPages(
  visits: PageVisits,
  options: {
    currentPath?: string;
    limit?: number;
    minVisits?: number;
  } = {}
): TrackedPage[] {
  const limit = options.limit ?? FREQUENT_LIMIT;
  const minVisits = options.minVisits ?? FREQUENT_MIN_VISITS;
  const current = options.currentPath
    ? trackedPageFor(options.currentPath)
    : null;
  return TRACKED_PAGES.filter((p) => {
    const v = visits[p.href];
    return v != null && v.n >= minVisits && p.href !== current?.href;
  })
    .sort((a, b) => {
      const av = visits[a.href];
      const bv = visits[b.href];
      return bv.n - av.n || bv.t - av.t;
    })
    .slice(0, limit);
}

// Parse the stored JSON defensively — a hand-edited or half-written value must
// degrade to "no history", never throw inside a render.
export function parsePageVisits(raw: string | null): PageVisits {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: PageVisits = {};
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    if (value == null || typeof value !== "object") continue;
    const { n, t } = value as { n?: unknown; t?: unknown };
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    const at = typeof t === "number" && Number.isFinite(t) ? t : 0;
    out[key] = { n: Math.floor(n), t: at };
  }
  return out;
}
