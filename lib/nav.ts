// Pure nav-model helpers shared by the sidebar's <Nav> (rendered by BOTH the
// desktop sidebar and the mobile drawer via components/SidebarContent.tsx).
// Keeping the active-route / group-expansion logic here — free of React and the
// DOM — lets it be unit-tested directly (the pure suite is DB/JSX-free) while
// the component only wires it to usePathname() and local collapse state.

// True when `href` should be treated as the active route for the current
// `pathname`. The dashboard ("/") matches exactly so it isn't lit up on every
// page; every other entry matches by prefix so nested routes (e.g.
// /biomarkers/123) still highlight their parent nav item. Mirrors the historic
// inline rule so highlighting behavior is unchanged.
export function isRouteActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

// True when any of a group's child hrefs is the active route — used to light up
// the group header and to force the group expanded so the active child is
// always visible.
export function isGroupActive(childHrefs: string[], pathname: string): boolean {
  return childHrefs.some((href) => isRouteActive(href, pathname));
}

import type { NavRelevance, NavRelevanceKey } from "./nav-relevance";

// Whether a nav leaf should be shown, given the viewer's context. This is the
// single visibility predicate shared by the top-level entries and each group's
// children in <Nav>, so the two filters can't drift. Four gates, each a
// cosmetic hide over an authoritative server-side check:
//   - `adminOnly`: hidden for non-admins (the page still calls requireAdmin()).
//   - `requiresMultiProfile`: hidden unless the caller has 2+ ACCESSIBLE profiles
//     (issue #31) — the Household cross-profile overview is meaningless with one
//     profile, so a single-profile login (member or one-profile instance) never
//     sees it while any login granted 2+ profiles does.
//   - age-gate: hidden when the active profile is age-restricted AND the href is
//     in the caller's restricted set (see lib/age-gate.ts / Nav's
//     RESTRICTED_HREFS).
//   - `requiresFoodLogging`: gates the Nutrition entry for an infant profile
//     (< 1 y). Since #746 Nutrition is a Food | Supplements umbrella, and infant
//     supplements are real (vitamin D drops) even though the food-group serving
//     log isn't (issue #591): the entry is shown when the profile is food-logging-
//     eligible OR already tracks any intake item (`hasIntakeItems`). Cosmetic —
//     the Food TAB independently gates on isFoodLoggingRelevant (a direct URL
//     still shows the calm note there), and the Supplements tab is always
//     reachable. Eligible on unknown age (hide only on a positive infant match
//     AND no intake items).
//   - `relevanceKey`: hidden when the server-resolved relevance bitset
//     (lib/nav-relevance.ts, issue #1042) reads false for that key — the
//     data/life-stage gate for the Cycle entry and the data-presence gate for
//     the specialty Medical entries (Vision/Dental). Cosmetic like the rest:
//     the pages never hard-block on a direct URL.
export function isNavLeafVisible(
  leaf: {
    href: string;
    adminOnly?: boolean;
    requiresMultiProfile?: boolean;
    requiresFoodLogging?: boolean;
    relevanceKey?: NavRelevanceKey;
  },
  ctx: {
    isAdmin: boolean;
    restricted: boolean;
    multiProfile: boolean;
    foodLoggingRelevant: boolean;
    hasIntakeItems: boolean;
    relevance: NavRelevance;
    restrictedHrefs: ReadonlySet<string>;
  }
): boolean {
  if (leaf.adminOnly && !ctx.isAdmin) return false;
  if (leaf.requiresMultiProfile && !ctx.multiProfile) return false;
  if (leaf.relevanceKey && !ctx.relevance[leaf.relevanceKey]) return false;
  if (
    leaf.requiresFoodLogging &&
    !ctx.foodLoggingRelevant &&
    !ctx.hasIntakeItems
  )
    return false;
  if (ctx.restricted && ctx.restrictedHrefs.has(leaf.href)) return false;
  return true;
}
