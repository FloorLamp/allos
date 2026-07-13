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

// Whether a nav leaf should be shown, given the viewer's context. This is the
// single visibility predicate shared by the top-level entries and each group's
// children in <Nav>, so the two filters can't drift. Three gates, each a
// cosmetic hide over an authoritative server-side check:
//   - `adminOnly`: hidden for non-admins (the page still calls requireAdmin()).
//   - `requiresMultiProfile`: hidden unless the caller has 2+ ACCESSIBLE profiles
//     (issue #31) — the Household cross-profile overview is meaningless with one
//     profile, so a single-profile login (member or one-profile instance) never
//     sees it while any login granted 2+ profiles does.
//   - age-gate: hidden when the active profile is age-restricted AND the href is
//     in the caller's restricted set (see lib/age-gate.ts / Nav's
//     RESTRICTED_HREFS).
//   - `requiresFoodLogging`: hidden when the active profile is an infant (< 1 y),
//     for whom food-group serving logging is meaningless (issue #591). Cosmetic —
//     the /nutrition page independently gates on the same predicate
//     (isFoodLoggingRelevant), so a direct URL still shows the calm note. Eligible
//     on unknown age (hide only on a positive infant match).
export function isNavLeafVisible(
  leaf: {
    href: string;
    adminOnly?: boolean;
    requiresMultiProfile?: boolean;
    requiresFoodLogging?: boolean;
  },
  ctx: {
    isAdmin: boolean;
    restricted: boolean;
    multiProfile: boolean;
    foodLoggingRelevant: boolean;
    restrictedHrefs: ReadonlySet<string>;
  }
): boolean {
  if (leaf.adminOnly && !ctx.isAdmin) return false;
  if (leaf.requiresMultiProfile && !ctx.multiProfile) return false;
  if (leaf.requiresFoodLogging && !ctx.foodLoggingRelevant) return false;
  if (ctx.restricted && ctx.restrictedHrefs.has(leaf.href)) return false;
  return true;
}
