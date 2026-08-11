// Semantic href helpers + the app-wide internal-route type alias (issue #285).
//
// Two things live here:
//
// 1. `AppRoute` — the single alias every href-carrying DATA MODEL field is typed
//    with (`href: AppRoute`, not `href: string`). It resolves to Next's generated
//    `Route` type (from `experimental`-graduated `typedRoutes`, enabled in
//    next.config.js), so an invalid internal pathname stored in a model — the
//    #283 dead-link class (`/goals`, `/medical` after a page was consolidated
//    away) — becomes a `tsc` error. External URLs stay a plain `string`; only
//    INTERNAL app routes are `AppRoute`.
//
//    THE ALIAS IS ONLY AS TYPED AS THE GENERATED TYPES ARE PRESENT (#2293).
//    `Route<T>` carries the real route union when `.next/types/routes.d.ts`
//    exists and falls back to `string & {}` when it does not — silently, with
//    every dead literal accepted. `/.next/` and `next-env.d.ts` are both
//    gitignored, so a fresh checkout has neither until something generates them.
//    That is why `npm run typecheck` is `next typegen && tsc --noEmit` rather
//    than bare `tsc`: typegen (~1s) materialises the union so the fast gate has
//    the same teeth `npm run build` has. If a route literal ever stops being
//    checked, look there first — the failure mode is silence, not an error.
//
//    Reversibility (issue #285 note): `typedRoutes` is young. If a Next upgrade
//    breaks it, flip this ONE line to `export type AppRoute = string;` and every
//    field degrades to a plain string without touching each interface.
//
// 2. The rule-carrying href HELPERS. The one-question-one-computation convention
//    applied to links: a helper exists ONLY where the link encodes a RULE that is
//    (or is about to be) duplicated — never a generator that just returns a static
//    literal (a generator returning "/medical" is exactly as dead as the literal).
//    Static/one-off links stay plain literals, now compile-checked and greppable.
//
// Two flavors of helper:
//   - QUERY-RULE helpers (readingDetailHref, timelineDayHref, dataSectionHref):
//     encode a canonical-gating / param-shape rule shared by ≥2 surfaces.
//   - DYNAMIC-ROUTE helpers (importHref, encounterHref, protocolHref,
//     immunizationHref): a dynamic route like `/import/5` is NOT assignable to
//     the field alias `AppRoute` (Next's `Route<string>` only admits static +
//     query/hash routes — dynamic segments need the literal inferred). These
//     helpers validate the pathname against the real route tree via a
//     `Route<`/x/${…}`>` ANNOTATION (a removed `/x/[id]` page fails the build
//     here — that's the point), then widen to `AppRoute` for storage in a field.
//     Inline `<Link href={`/import/${id}`}>` in JSX needs no helper — Next infers
//     and validates those directly.

import type { Route } from "next";
import type { CardioMetric, RangeId } from "./analyze-view";
import { continuousReadingSlug } from "./reading-cadence";
import type { PanelId } from "./biomarker-panels";
import type { GrowthMetric } from "./growth";
import type { IntegrationId } from "./types/integrations";
import type { SupplementKind } from "./types/intake";

export type AppRoute = Route;

// --------------------------------------------------------------------------
// Intake (supplements / medications) surface seam (issue #746)
// --------------------------------------------------------------------------

// The Nutrition umbrella's deep-linkable tabs (#746): Food is the default (no
// query), Supplements is the former /medicine supplement surface folded in as a
// tab. Source of truth for the union — the page parses `?tab=`, so a tab rename
// is one edit and every caller of `nutritionTabHref` is re-checked by the
// compiler (typedRoutes validates the `/nutrition` path but NOT the `?tab=`
// value — this union does, mirroring dataSectionHref).
export const NUTRITION_TABS = ["food", "supplements"] as const;
export type NutritionTab = (typeof NUTRITION_TABS)[number];

export function nutritionTabHref(tab: NutritionTab): AppRoute {
  return tab === "food" ? "/nutrition" : `/nutrition?tab=${tab}`;
}

// The standalone Medications page (#746) — medications left the old combined
// /medicine surface for their own Medical-group page.
export const MEDICATIONS_HREF: AppRoute = "/medications";

// The household medicine cabinet — the shared supply pools registry (#1374). ONE
// household-level surface for both kinds (the #746 split is per-ITEM; a shared bottle
// has no kind of its own), so every shared-bottle chip, pooled low-supply finding, and
// pool nudge deep-links here rather than to a kind page.
export const SUPPLIES_HREF: AppRoute = "/supplies";

// The Illness episodes index (#856), which BECAME the cross-profile care-trail surface
// (#1373 Part 2): the view-set banner drives whose data shows, a `?kind=` toggle drives
// what shows. The old /household/history route was REMOVED — this const replaced
// HOUSEHOLD_HISTORY_HREF; the household header, the dashboard illness promotion, and the
// widen-to-household links on Visits all point here now (one edit re-checks every caller).
export const EPISODES_HREF: AppRoute = "/medical/episodes";

// The two-state content toggle on the episodes care trail (#1373): `illness` (default —
// episodes + their nested linked visits + courses) and `illness+visits` (adds the
// unlinked routine visits). Kept in lib/hrefs so the toggle links stay compile-checked.
// The URL param value for the second state is `visits` (NOT `illness+visits`): a literal
// `+` in a query string decodes to a SPACE, so the readable value stays URL-safe.
export function episodesKindHref(kind: "illness" | "illness+visits"): AppRoute {
  return kind === "illness"
    ? "/medical/episodes"
    : "/medical/episodes?kind=visits";
}

// The mental-health instrument surface (#716) — PHQ-9/GAD-7 scores. Lives on the
// Health record's Specialty › Mental health tab (#1079, was the #mental-health
// section since #1042); the old /medical/instruments route 308-redirects here.
export const INSTRUMENTS_HREF: AppRoute = "/records/specialty/mental-health";

// The kind-aware deep link for an intake item / dose (#746): a supplement points
// at the Nutrition → Supplements tab, a medication at the Medications page. The
// ONE place the intake-surface seam is encoded, so every deep-linker (Upcoming,
// Timeline, search, refill/dose Telegram buttons, imports) agrees on where each
// kind lives — a #285 "rule-carrying link" (the rule = kind → surface).
export function intakeHref(kind: SupplementKind): AppRoute {
  return kind === "medication"
    ? MEDICATIONS_HREF
    : nutritionTabHref("supplements");
}

// The cross-item DOSE LEDGER (#2417) — every confirmed dose across items, filterable
// by item, kind and date range. Same kind→surface rule as `intakeHref` one level down:
// the supplements tab's ledger lives under /nutrition, the medications one under
// /medications, and each opens pre-filtered to its own surface's kind (the kind filter
// on the page is what widens it). One helper, so the Trends → Nutrition dose-history
// chart and both intake surfaces name the same destination.
//
// `surface` picks the route; `params` carries the ledger's own filter state — the kind
// filter (`kind=all` widens past the surface's own), the item filter, and the shared
// from/to date window. A single-day window is what the Trends day panel's "what did I
// take that day" means as a table.
export const DOSE_LEDGER_ALL_KINDS = "all";

export function doseLedgerHref(
  surface: SupplementKind,
  params: {
    from?: string;
    to?: string;
    kind?: SupplementKind | typeof DOSE_LEDGER_ALL_KINDS;
    item?: number;
    // The explicit all-time sentinel. Needed for the same reason Trends needs it: an
    // empty query string means this surface's DEFAULT window, so the "All time" pill
    // has to be able to say itself.
    allTime?: boolean;
  } = {}
): AppRoute {
  const sp = new URLSearchParams();
  if (params.allTime) sp.set("range", "all");
  if (params.from) sp.set("from", params.from);
  if (params.to) sp.set("to", params.to);
  if (params.kind) sp.set("kind", params.kind);
  if (params.item) sp.set("item", String(params.item));
  const qs = sp.toString();
  if (surface === "medication") {
    return qs ? `/medications/dose-history?${qs}` : "/medications/dose-history";
  }
  return qs ? `/nutrition/dose-history?${qs}` : "/nutrition/dose-history";
}

// "Add this bottle for another person" (#1705) — the cabinet's second entry point into
// the item forms. Same kind→surface rule as intakeHref, plus the `?supply=` param the
// two surfaces parse to open their add form pre-seeded and pre-linked. One helper so the
// param name lives in exactly one place: the cabinet writes it, both pages read it.
export const SUPPLY_PREFILL_PARAM = "supply";

export function addItemFromPoolHref(
  kind: SupplementKind,
  supplyId: number
): AppRoute {
  return kind === "medication"
    ? `/medications?${SUPPLY_PREFILL_PARAM}=${supplyId}`
    : `/nutrition?tab=supplements&${SUPPLY_PREFILL_PARAM}=${supplyId}`;
}

// --------------------------------------------------------------------------
// Query-rule helpers
// --------------------------------------------------------------------------

// The clinical-readings LIST route: where `readingDetailHref` falls back when there is
// no canonical name to chart, and (since #1447) where a PARAMLESS
// /results/readings/view redirects — that route can only render a degenerate empty
// page, and this helper already owns "no name ⇒ the list". One constant so the
// link rule and the redirect can never point at different places.
export const READINGS_LIST_HREF: AppRoute = "/results/readings";

// PRIVATE destination builder: the EPISODIC reading's page (/results/readings/view), or
// the list when there's nothing to chart. The RULE (was duplicated, wrong in one
// place — #283 bug 5): the view page resolves `?name=` as the CANONICAL name, so
// only a canonicalized reading has a series to link to. Gate on `canonicalName`;
// when present, encode the CANONICAL name (NOT the raw display name — the bug
// flaggedToAttention shipped); when absent, fall back to the list.
//
// Not exported since #1932: it names ONE of the two detail surfaces, and a call
// site that could pick between them would be free to disagree with the routing
// rule. Everything outside this module asks `readingDetailHref` for "the detail
// page for this reading" and gets whichever surface that reading belongs on —
// exactly as `metricDetailHref` stays honest about being only the metric surface.
function episodicReadingHref(
  canonicalName: string | null | undefined,
  rawName?: string | null
): AppRoute {
  const canonical = canonicalName?.trim();
  // The display token to encode: the canonical name when we have one, else the
  // raw name — but the gate below only reaches the encode branch WITH a canonical
  // (an uncanonicalized reading has no `?name=` the view can resolve), so a
  // present `canonical` always wins.
  const name = canonical || rawName?.trim();
  return canonical && name
    ? `/results/readings/view?name=${encodeURIComponent(name)}`
    : READINGS_LIST_HREF;
}

// THE detail page for a clinical reading, wherever that reading's surface lives
// (issue #1932). One helper for all eleven-plus link sites — the biomarkers table,
// Recent labs, Timeline, search, findings, the import "what this wrote" produced-rows
// drilldown, the panel strip on the detail page itself — so none of them can decide
// for itself which renderer a reading deserves.
//
// The rule is CADENCE, and it lives in lib/reading-cadence.ts: a continuous reading
// (SpO2, blood pressure, respiratory rate, body temperature) resolves to its metric
// detail surface, which charts it as the trend it is; every episodic reading resolves
// to the reference-range renderer at /results/readings/view. Named for its SUBJECT rather
// than either destination, because a helper named after one destination invites a
// caller to reason "this one is different, so I should use something else" — the
// drift the centralization exists to prevent.
export function readingDetailHref(
  canonicalName: string | null | undefined,
  rawName?: string | null
): AppRoute {
  const slug = continuousReadingSlug(canonicalName);
  return slug
    ? metricDetailHref(slug)
    : episodicReadingHref(canonicalName, rawName);
}

// The biomarkers list FILTERED to one normalized panel (#1502). A rule-carrying
// helper because the `?panel=` facet now encodes a controlled SLUG (not the old
// free-text heading) on the post-#1079 list route, and two lanes emit it — the
// Panel cell in ReadingsTable and the "see the whole panel" link on biomarker
// detail. One encoding so they can't drift onto different routes or param shapes.
export function panelFilterHref(panel: PanelId): AppRoute {
  return `/results/readings?panel=${encodeURIComponent(panel)}`;
}

// The reading ADD-FORM deep link: Results › Readings with the add form
// focused (?new=1) and optionally name-prefilled (#662). This is the ONE encoding
// of the lab-record deep-link shape (#1083) shared by the preventive screening
// rows/nudges (lib/preventive-upcoming) and the data-quality PhenoAge gap
// (#1146), so the two lanes can't diverge (#221). The base is the post-#1079
// tabbed route — never `/results#biomarkers`, which only survives via redirect.
export function readingAddHref(name?: string | null): AppRoute {
  const n = name?.trim();
  return n
    ? `/results/readings?new=1&name=${encodeURIComponent(n)}`
    : "/results/readings?new=1";
}

// The Medications list filtered to a maintenance slice (#1146). Source of truth
// for the union — the page parses `?filter=`, so a rename is one edit and every
// caller is re-checked by the compiler (typedRoutes validates the /medications
// path but NOT the `?filter=` value — this union does, mirroring dataSectionHref).
// `needs-rxcui`: only ACTIVE medications with no confirmed RxNorm code (the #851
// confirm backlog the data-quality med-rxcui gap points at when several need it).
export const MEDICATION_FILTERS = ["needs-rxcui"] as const;
export type MedicationFilter = (typeof MEDICATION_FILTERS)[number];

export function medicationsFilterHref(filter: MedicationFilter): AppRoute {
  return `/medications?filter=${filter}`;
}

// The Timeline "jump to this day" link: filter the feed to a single day AND
// scroll to that day's anchor. One place for the `/timeline?from=X&to=X#…`
// pattern the sidebar calendar and the workout heatmap (#186) both build.
//
// `subjectProfileId` (issue #1329) rides only on links built INSIDE the multi-view
// timeline feed, where an event belongs to a specific in-view member and the day it
// deep-links to is THAT member's local day. The single-day timeline view stays
// single-SUBJECT (never a mixed-subject edit surface), so the param carries whose day
// it is; omitted (the default, and every single-view caller) it renders byte-identical.
export function timelineDayHref(
  date: string,
  subjectProfileId?: number
): AppRoute {
  // Inline the full `/timeline?…` literals (not a `${base}` variable) so Next's
  // typedRoutes can still infer the route from the literal prefix at build time.
  return subjectProfileId != null
    ? `/timeline?from=${date}&to=${date}&subject=${subjectProfileId}#timeline-day-${date}`
    : `/timeline?from=${date}&to=${date}#timeline-day-${date}`;
}

// The Training Log's date anchor. Workout-day surfaces land in the domain
// ledger rather than routing through Timeline; the log owns activity review
// and editing, while Timeline remains the cross-domain destination.
export function trainingLogDayHref(date: string): AppRoute {
  return `/training?tab=log#day-${date}`;
}

// Turn a day-history panel's domain landing page into its dated CREATE entry
// point (#2420). The base route remains AppRoute-checked at the server call site;
// this helper owns the four parameter names so a chart cannot send a date to a
// destination that does not read it.
export type DayHistoryAddKind = "food" | "dose" | "practice" | "workout";

export function dayHistoryAddHref(
  base: AppRoute,
  kind: DayHistoryAddKind,
  date: string
): AppRoute {
  const param =
    kind === "dose" ? "backfill" : kind === "practice" ? "log" : "date";
  const separator = String(base).includes("?") ? "&" : "?";
  return `${base}${separator}${param}=${encodeURIComponent(date)}` as AppRoute;
}

// The Data hub's deep-linkable sections. Source of truth for the union — the page
// (`app/(app)/data/page.tsx`) imports it, so a section rename is one edit and
// every caller of `dataSectionHref` is re-checked by the compiler (typedRoutes
// validates the `/data` path but NOT the `?section=` value — this union does).
export const DATA_SECTIONS = ["import", "review", "manage"] as const;
export type DataSection = (typeof DATA_SECTIONS)[number];

// Link to a section of the Data hub, with an optional in-page hash
// (e.g. "paste-import"). `section` is union-typed so a typo can't strand a caller.
export function dataSectionHref(section: DataSection, hash?: string): AppRoute {
  return hash ? `/data?section=${section}#${hash}` : `/data?section=${section}`;
}

// A provider's setup / detail page. Each CONNECTABLE provider has its OWN static
// page (`/integrations/<id>`); a still-"planned" provider (Garmin) has none, so
// this returns null for it — which makes a dead `/integrations/garmin` link
// impossible by construction (the whole point of #285). This mapping is the
// source of truth for "which providers have a page"; callers already gate on
// connectability and render a non-link card when it's null.
const INTEGRATION_DETAIL_ROUTES: Partial<Record<IntegrationId, AppRoute>> = {
  "health-connect": "/integrations/health-connect",
  strava: "/integrations/strava",
  oura: "/integrations/oura",
  withings: "/integrations/withings",
  weather: "/integrations/weather",
  "calendar-feed": "/integrations/calendar-feed",
  "fitbit-takeout": "/integrations/fitbit-takeout",
  "patient-portals": "/integrations/patient-portals",
};

export function integrationDetailHref(id: IntegrationId): AppRoute | null {
  return INTEGRATION_DETAIL_ROUTES[id] ?? null;
}

// Escape hatch for "current page + modified query" links built from the LIVE
// router pathname (`usePathname()`), which is a real route at runtime but only a
// `string` to the compiler — typedRoutes can't see a runtime value. Use this
// ONLY in the generic filter / tab / sort / pager components that round-trip the
// current URL's query string; NEVER to launder a KNOWN static literal (keep
// those AppRoute-checked so a dead one still fails the build). Named + greppable
// so every legitimate cast is auditable in one place.
export function currentPathHref(href: string): AppRoute {
  return href as AppRoute;
}

// --------------------------------------------------------------------------
// Dynamic-route widening helpers (validate the pathname, widen to AppRoute)
// --------------------------------------------------------------------------

// A processed-import document detail page.
export function importHref(id: number): AppRoute {
  const href: Route<`/import/${number}`> = `/import/${id}`;
  return href as AppRoute;
}

// One tab of an import document's records browser, optionally FOCUSED on a row
// label (#2339). The param shape is a rule, not a literal: `?focus=` carries the
// LABEL — never a row id, which would be stale the moment the row is edited or the
// document reprocessed — and the destination re-resolves it against the rows that
// exist then. Shared by the "Check these first" links, the focus notice's "Show
// all rows" escape, and their tests, so one edit moves all three.
export function importTabHref(
  id: number,
  tabKey: string,
  focusLabel?: string
): AppRoute {
  const params = new URLSearchParams({ tab: tabKey });
  if (focusLabel) params.set("focus", focusLabel);
  return `${importHref(id)}?${params.toString()}` as AppRoute;
}

// An encounter (visit/appointment) detail page.
export function encounterHref(id: number): AppRoute {
  const href: Route<`/encounters/${number}`> = `/encounters/${id}`;
  return href as AppRoute;
}

// A provider's registry detail page (#275). Used by the import-detail Providers
// listing (#1182) to deep-link each referenced provider from its produced-rows
// panel; a dynamic route needs the widening cast.
export function providerHref(id: number): AppRoute {
  const href: Route<`/providers/${number}`> = `/providers/${id}`;
  return href as AppRoute;
}

// A medication's clinical-record detail page (issue #817). The list page
// (MEDICATIONS_HREF) stays the kind-level target for every deep-linker via
// intakeHref — Upcoming/Timeline/dose reminders point at the daily list where the
// Today panel lives; this per-med detail is linked only from a list row.
export function medicationHref(id: number): AppRoute {
  const href: Route<`/medications/${number}`> = `/medications/${id}`;
  return href as AppRoute;
}

// A medication's EDIT form: the detail page opened with its edit workflow
// (`?action=edit`) — the form that carries the #851 RxNorm confirm affordance.
// The ONE encoding of that action-shape, shared by the list row's Edit item
// (MedicationRow) and the data-quality med-rxcui gap CTA when exactly one
// medication needs its code confirmed (#1146).
export function medicationEditHref(id: number): AppRoute {
  return `${medicationHref(id)}?action=edit` as AppRoute;
}

// An equipment registry detail page (#343) — the gear's usage history. Used as DATA
// (a search hit's typed destination, #1595), where a bare literal cannot carry the
// dynamic-route widening cast a `<Link href>` gets for free.
export function equipmentHref(id: number): AppRoute {
  const href: Route<`/equipment/${number}`> = `/equipment/${id}`;
  return href as AppRoute;
}

// Where wellness PRACTICES live — the same address the Upcoming `practice:<id>` item
// and the search hit already point at. The ONE encoding of that seam (#285's
// rule-carrying link), so the practice nudge's deep link (#1718) can't drift from the
// item it is the push twin of.
export const PRACTICES_HREF: AppRoute = "/wellness";

// A protocol (training/care protocol) detail page.
export function protocolHref(id: number): AppRoute {
  const href: Route<`/protocols/${number}`> = `/protocols/${id}`;
  return href as AppRoute;
}

// A read-first cycling activity detail page. The dynamic route remains scoped by
// the active profile at its query boundary; this helper only owns its URL shape.
export function rideHref(id: number): AppRoute {
  const href: Route<`/training/rides/${number}`> = `/training/rides/${id}`;
  return href as AppRoute;
}

export interface CyclingLens {
  metric: CardioMetric;
  range: RangeId;
  activity?: string;
}

// A ride reached from Cycling carries the aggregate lens that selected it. The
// same query survives adjacent/comparison navigation and reconstructs the
// overview link, so opening a Power · 6m ride never silently returns to
// Distance · All.
export function cyclingRideHref(id: number, lens: CyclingLens): AppRoute {
  const path: Route<`/training/rides/${number}`> = `/training/rides/${id}`;
  const params = new URLSearchParams({
    metric: lens.metric,
    range: lens.range,
  });
  if (lens.activity && lens.activity.trim().toLowerCase() !== "cycling") {
    params.set("item", lens.activity);
  }
  return `${path}?${params.toString()}` as AppRoute;
}

export function cyclingOverviewHref(lens: CyclingLens): AppRoute {
  const params = new URLSearchParams({
    tab: "analyze",
    kind: "cardio",
    item: lens.activity?.trim() || "Cycling",
    metric: lens.metric,
    range: lens.range,
  });
  return `/training?${params.toString()}` as AppRoute;
}

// The all-ride Cycling home within Training → Analyze. Ride detail pages use
// this canonical state instead of sending the reader back to a single Journal
// row; `range=all` makes the first landing an actual overall history.
export const CYCLING_OVERVIEW_HREF: AppRoute =
  "/training?tab=analyze&kind=cardio&item=Cycling&range=all";

// The per-vaccine immunization history page (slug is the vaccine code/name).
export function immunizationHref(vaccine: string): AppRoute {
  const href: Route<`/immunizations/${string}`> = `/immunizations/${vaccine}`;
  return href as AppRoute;
}

// A metric DETAIL page (#1067 Phase 2, generalized by #1488) — the per-metric
// full-depth surface (`/trends/metric/weight`, `/trends/metric/steps`,
// `/trends/metric/mood`, …): the biomarker-view pattern applied to body metrics,
// and since #1488 the tap-through destination EVERY full-size Trends chart of a
// registered kind points at. The slug is a stable BodyMetricSlug (see
// lib/trends-body-metrics); a dynamic route needs the widening cast. Typed `string`
// (not the slug union) to avoid a hrefs ↔ trends-body-metrics import cycle — the
// page validates the slug against the registry, and `chart-detail-href.test.ts`
// pins that every kind the registry declares resolves there.
export function metricDetailHref(kind: string): AppRoute {
  const href: Route<`/trends/metric/${string}`> = `/trends/metric/${kind}`;
  return href as AppRoute;
}

// The composite WHO/CDC growth-percentile detail surface. It is deliberately not
// a metric slug: one view switches among height, weight, BMI, and head circumference.
export const GROWTH_TRENDS_HREF = "/trends/growth" as AppRoute;

// Each growth measure is a separate chart while sharing one pediatric detail page.
// The hash lands a tile/full-chart header on that measure instead of dropping the
// reader at the top of a four-chart page.
export function growthTrendsHref(
  metric: GrowthMetric,
  range?: { from?: string; to?: string }
): AppRoute {
  const params = new URLSearchParams();
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);
  // An explicitly supplied empty range means All time; no range argument means
  // the destination's normal default.
  if (range && !range.from && !range.to) params.set("range", "all");
  const query = params.toString();
  return `/trends/growth${query ? `?${query}` : ""}#growth-${metric}` as AppRoute;
}

// The illness-episode detail page (issue #856). The slug is the STABLE episode row id
// — it survives boundary edits (unlike the old date slug), so a bookmark/link never
// dangles when the start date is corrected. A dynamic route needs the widening cast.
export function episodeHref(id: number): AppRoute {
  const href: Route<`/medical/episodes/${string}`> = `/medical/episodes/${id}`;
  return href as AppRoute;
}
