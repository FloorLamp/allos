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
    enumSource: "TREND_METRIC_SLUGS (lib/trend-metrics)",
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
    // Every session's canonical record. Analyze's sessions table and Log both
    // link it; the seeded shapes carry enough history to resolve one instance.
    pattern: "/training/activity/[id]",
    strategy: "follow",
    from: ["/training?tab=analyze", "/training?tab=log"],
    match: /^\/training\/activity\/\d+$/,
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

// Disclosure-expansion registry (#2616). The census shoots every route in its
// DEFAULT state, and on some surfaces that state is a set of collapsed groups —
// the camera sees a "Vitamins 4" header and nothing inside it, so a whole defect
// class (identity splits, label leaks, duplicate analytes) is structurally
// invisible no matter how many seeds the sweep runs. The #2594 quirky-import
// dial plants exactly such rows, and the first multi-seed sweep proved no
// screenshot could show them.
//
// A registered surface gets a SECOND capture: after the normal shot and metrics
// probe, the journey clicks every still-closed toggle (re-querying until none
// match, so groups revealed by earlier clicks are included), optionally drains
// per-group "load more" buttons, and saves `…-expanded.png` beside the default
// shot. The default shot and its metrics row are untouched — `--baseline`
// diffing compares default states only, so registering a surface here can never
// flag it as a height regression. A registered route with nothing to expand
// logs a BLIND SPOT line, same contract as DYNAMIC_ROUTES resolution: a blind
// spot must be visible, never silent.
//
// lib/__tests__/ux-census-routes.test.ts pins each entry's route to a live
// page.tsx. Selector behavior is exercised by the census itself.
/**
 * @typedef {object} DisclosureExpansion
 * @property {string} route        censused static route whose default state collapses content
 * @property {string} label        human name for log lines
 * @property {string} closedToggle selector matching every still-closed toggle (must not match open ones)
 * @property {string} [loadMore]   selector for "load the rest" buttons revealed by expansion
 */

/** @type {DisclosureExpansion[]} */
export const DISCLOSURE_EXPANSIONS = [
  {
    // #3672: the resting Food tab deliberately shows only the idle fasting door;
    // the companion capture opens it so the start controls and history remain visible
    // to the census while a running fast continues to render unfolded by construction.
    route: "/nutrition",
    label: "Food tab idle fasting controls and history",
    closedToggle: 'details:not([open]) > [data-testid="fasting-fold"]',
  },
  {
    // The Clinical results catalog: every panel group (Vitamins, Lipids, …) collapses by
    // default, hiding the per-analyte rows where identity splits show.
    route: "/results/clinical-results",
    label: "clinical results catalog panel groups",
    closedToggle:
      '[data-testid="clinical-result-panel-toggle"][aria-expanded="false"]',
    loadMore: '[data-testid="clinical-result-panel-load-all"]',
  },
  {
    // THE DASHBOARD'S ONE FOLD, and the census's only picture of the tail (#3366).
    //
    // It began as Standing's quiet tail (#3548) — dormant lines, months-old
    // results, quiet pillars, out-ranked connect-a-source CTAs. #4480 merged that
    // fold into Show everything, so one <details> now hides both it and the
    // exhaustive remainder, and the resting dashboard shot photographs neither.
    //
    // WHAT IS BEHIND IT CHANGED TWICE UNDER THIS ENTRY:
    //   * #4083 retired the four always-available write cards — weight, vitals,
    //     well-day and cycle — to the quick-log sheet.
    //   * #4396 removed the Elsewhere door rows #4083 had drawn for the declared
    //     nav duplicate. Completeness is proven at the placement-manifest tier.
    //
    // The existing `dashboard-all` marker names the <details>; selecting its
    // direct <summary> avoids adding a second runtime marker only for this tool.
    // `:not([open])` is load-bearing: the expansion loop must stop after one click.
    route: "/",
    label: "the dashboard's Show everything fold",
    closedToggle: 'details[data-testid="dashboard-all"]:not([open]) > summary',
  },
];

// Hover-capture registry (#3489 deliverable 4). The census photographs the
// RESTING state, so anything that exists only while a pointer is over an element
// is invisible to it by construction. #3459 item 2 is the named miss — the
// Standing door labels were shipped, re-ruled and fixed without the census ever
// producing one picture of them — and #3375 is a whole issue about information
// that exists only on hover, on surfaces the census has photographed many times.
//
// A registered entry gets a SECOND capture, `…-hover.png`, beside the default
// shot: the same contract as DISCLOSURE_EXPANSIONS above, with `page.hover()` in
// place of the click loop. Three rules the pass enforces, each for a reason:
//
//   DESKTOP ONLY. The census runs every route at 1280×900 and again at 390×844.
//   A phone has no hover, so a `…-hover.png` from the mobile pass is a picture of
//   a state no phone user can reach — and it would sit in the contact sheet
//   looking exactly like evidence. That is worse than no capture.
//
//   THE ROUTE'S OWN VISIT ONLY (`landedOn === wanted`). An alias landing here
//   would produce a second hover shot filed under a route the reader was not
//   looking at — the same guard, for the same reason, as the expansion pass.
//
//   A NO-OP IS REPORTED, NOT PHOTOGRAPHED. If the rendered difference is empty —
//   no pixels changed in the region, nothing revealed, hidden or moved — the shot
//   is SKIPPED and a BLIND SPOT line names the entry. A byte-identical twin of the
//   default shot is noise a reader cannot tell from the default without opening
//   both; the fact that a ruled hover affordance stopped doing anything is a real
//   finding and is kept.
//
// What NOT to register: a bare `title=` tooltip. It is native browser chrome,
// drawn outside the page, and never appears in a screenshot —
// scripts/ux-hover-census.mjs says so at length. #3375 owns that class.
//
// lib/__tests__/ux-census-routes.test.ts pins each entry's route to a live
// page.tsx; e2e/ux-hover-capture.spec.ts proves the probe can see a reveal and
// stays quiet on a hover that changes nothing.
/**
 * @typedef {object} HoverCapture
 * @property {string} route      censused static route carrying the hover affordance
 * @property {string} label      human name for log lines and the audit table
 * @property {string} target     selector for the element to hover (first match wins)
 * @property {string} [reveals]  selector for the ruled payload, resolved INSIDE the
 *                               target first and document-wide only as a fallback
 * @property {string} [openFirst] selector clicked before hovering, when the
 *                               affordance lives behind a closed disclosure
 * @property {string} ruling     which decision put a fact on hover, for the reader
 */

/** @type {HoverCapture[]} */
export const HOVER_CAPTURES = [
  {
    // #3459 item 2 / #3253 decision 2: the door label slides in at the right edge
    // of the facts cell, so the static census needs one hovered capture.
    route: "/",
    label: "Standing family door labels",
    target: "a.standing-row",
    reveals: '[data-testid="standing-door"]',
    ruling: "#3253 decision 2, re-ruled by #3459 item 2",
  },
  {
    // #3375's load-bearing case: the CDC schedule grid's per-vaccine and per-dose
    // content uses the same panel for mouse hover and pinned tap/keyboard access.
    // The grid itself sits behind a closed <details>, which is what `openFirst` is
    // for.
    route: "/records/history/immunizations",
    label: "CDC schedule grid vaccine details",
    // The vaccine NAME cell specifically. `tbody td` also matches the grid's
    // group-label rows, which carry no handler: registered that way the entry
    // reported an honest no-op and the surface stopped being captured (measured
    // on this pass's first run).
    target: '[data-testid="schedule-grid-vaccine-cell"]',
    reveals: '[data-testid="schedule-grid-tip"]',
    openFirst: '[data-testid="immunization-schedule-disclosure"]',
    ruling: "#3375 — mouse hover preserved; tap/keyboard pin the same content",
  },
];

// Query-driven hub panels are not separate page.tsx files, so the filesystem
// census otherwise sees only their default state. Keep each non-default state
// explicit: these visits get their own desktop/mobile screenshot and metrics row.
/**
 * @typedef {object} HubVariant
 * @property {string} route static hub route
 * @property {string} target canonical query-driven panel URL
 * @property {string} slug filesystem-safe capture key
 */

/** @type {HubVariant[]} */
export const HUB_VARIANTS = [
  { route: "/training", target: "/training?tab=log", slug: "training-tab-log" },
  {
    // #3512: the default Analyze variant is now All training (workout history +
    // data-gated zones). Per-entity views remain reachable through its picker.
    route: "/training",
    target: "/training?tab=analyze",
    slug: "training-tab-analyze",
  },
  {
    route: "/training",
    target: "/training?tab=plan",
    slug: "training-tab-plan",
  },
  {
    route: "/trends",
    target: "/trends?tab=nutrition",
    slug: "trends-tab-nutrition",
  },
  {
    route: "/trends",
    target: "/trends?tab=insights",
    slug: "trends-tab-insights",
  },
  {
    route: "/nutrition",
    target: "/nutrition?tab=supplements",
    slug: "nutrition-tab-supplements",
  },
  {
    route: "/data",
    target: "/data?section=review",
    slug: "data-section-review",
  },
  {
    route: "/data",
    target: "/data?section=coverage",
    slug: "data-section-coverage",
  },
  {
    route: "/data",
    target: "/data?section=manage",
    slug: "data-section-manage",
  },
  { route: "/data", target: "/data?section=trash", slug: "data-section-trash" },
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
