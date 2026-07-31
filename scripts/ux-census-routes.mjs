// Dynamic-route census registry (#1544).
//
// The `pages` census enumerates app/(app)/**/page.tsx from the filesystem. Until
// #1544 it SKIPPED every `[param]` segment, so the all-pages hierarchy/text/layout
// audit (#1446–#1451) and the #1510 metrics probe that rides it covered exactly
// zero detail pages — the surfaces where density problems concentrate.
//
// This registry gives each dynamic pattern ONE resolvable instance. Two strategies:
//
//   literal — the slug comes from a static enum in lib/, so no DB access is needed.
//             `enumSource` names the enum; lib/__tests__/ux-census-routes.test.ts
//             pins the literal as a live member of it, so a renamed slug fails a
//             cheap unit test instead of silently un-censusing the route.
//
//   follow  — navigate an index route and take the FIRST link matching `match`.
//             Bonus: it also proves the index → detail link works, which nothing
//             else checks. `from` is an ordered candidate list; the first index
//             that yields a link wins, so a moved list (routes churn) degrades to
//             a fallback instead of a blind spot.
//
// Resolution NEVER fails silently: an unregistered pattern, or a `follow` that
// finds no link (a genuinely empty table on the thin/fresh census shapes), logs a
// loud BLIND SPOT line. A blind spot must be visible.
//
// This file is plain .mjs data so both the harness (node) and a pure vitest guard
// can import it.

/**
 * One dynamic route pattern and the single instance the census visits for it.
 *
 * @typedef {object} DynamicRoute
 * @property {string} pattern      the filesystem route, e.g. "/medications/[id]"
 * @property {"literal"|"follow"} strategy
 * @property {string} [instance]   literal: the concrete route to visit
 * @property {string} [enumSource] literal: the lib/ enum the slug belongs to
 * @property {string} [slug]       literal: the param value, pinned by the guard test
 * @property {string[]} [from]     follow: ordered index-route candidates; a
 *                                 candidate may carry a query string when the
 *                                 list lives on a tab of a hub
 * @property {RegExp} [match]      follow: which href on that index is a detail link
 */

/** @type {DynamicRoute[]} */
export const DYNAMIC_ROUTES = [
  {
    // The #1541 surface: the per-metric detail page whose period-stats card
    // collapses at ~1 week of history. Weight is the metric the seed and every
    // real install populate first.
    pattern: "/trends/metric/[kind]",
    strategy: "literal",
    instance: "/trends/metric/weight",
    enumSource: "BODY_METRIC_SLUGS (lib/trends-body-metrics)",
    slug: "weight",
  },
  {
    // Per-vaccine detail. An adult catalog entry renders its schedule, status and
    // override controls with or without a dose record, so it censuses on every
    // data shape including a fresh DB.
    pattern: "/immunizations/[vaccine]",
    strategy: "literal",
    instance: "/immunizations/tdap",
    enumSource: "VACCINE_CATALOG (lib/immunization-catalog)",
    slug: "tdap",
  },
  {
    pattern: "/medications/[id]",
    strategy: "follow",
    from: ["/medications"],
    match: /^\/medications\/\d+$/,
  },
  {
    pattern: "/equipment/[id]",
    strategy: "follow",
    from: ["/equipment"],
    match: /^\/equipment\/\d+$/,
  },
  {
    // The providers registry index lives under Records → Care, not /providers.
    pattern: "/providers/[id]",
    strategy: "follow",
    from: ["/records/care/providers", "/records/care"],
    match: /^\/providers\/\d+$/,
  },
  {
    // Encounters are listed as visits under Records → History.
    pattern: "/encounters/[id]",
    strategy: "follow",
    from: ["/records/history/visits", "/appointments"],
    match: /^\/encounters\/\d+$/,
  },
  {
    pattern: "/protocols/[id]",
    strategy: "follow",
    from: ["/longevity"],
    match: /^\/protocols\/\d+$/,
  },
  {
    // A processed import document. The Data hub's Review tab is the one feed that
    // lists EVERY document (the hub's default Import tab does not, and Results →
    // Reports only links the narrative reports a CCD import produces — empty on
    // the plain seed). An index candidate may carry a query for exactly this
    // reason: a tabbed hub's list lives on a tab.
    pattern: "/import/[id]",
    strategy: "follow",
    from: ["/data?section=review", "/results/reports"],
    match: /^\/import\/\d+$/,
  },
  {
    pattern: "/medical/episodes/[id]",
    strategy: "follow",
    from: ["/medical/episodes"],
    match: /^\/medical\/episodes\/\d+$/,
  },
];

// Stable, filesystem-safe capture/metrics key for a route pattern. Detail-page
// shots and metrics.json rows are keyed by the PATTERN, never the resolved id —
// ids differ run to run, and `--baseline` diffing needs a stable key.
/**
 * @param {string} route
 * @returns {string}
 */
export function routeSlug(route) {
  return route === "/"
    ? "home"
    : route.slice(1).replace(/\//g, "-").replace(/[[\]]/g, "");
}
