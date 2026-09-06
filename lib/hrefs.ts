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
//   - QUERY-RULE helpers (clinicalResultDetailHref, historyDayHref, dataSectionHref):
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
import type { ExerciseCompareMetric } from "./queries/training/strength";
import { continuousReadingSlug } from "./reading-cadence";
import type { PanelId } from "./biomarker-panels";
import type { GrowthMetric } from "./growth";
import type { IntegrationId } from "./types/integrations";
import type { IntakeItemKind } from "./types/intake";
import type { HistoryFamily, HistoryKind } from "./history-format";

export type AppRoute = Route;

// --------------------------------------------------------------------------
// Intake (supplements / medications) surface seam (issue #746)
// --------------------------------------------------------------------------

// The Nutrition umbrella's deep-linkable tabs (#746). Source of truth for the
// union — the page parses `?tab=`, so every caller of `nutritionTabHref` is
// re-checked by the compiler (typedRoutes validates the `/nutrition` path but NOT
// the `?tab=` value — this union does, mirroring dataSectionHref).
//
// These are URL VALUES, not labels: the tabs read `Day | Manage` (#3987) and the
// words live in components/tab-first-pages.ts. `food` is the Day ledger,
// `supplements` the Manage surface — the spelling every stored notification link,
// finding actionHref and cabinet deep link already carries.
export const NUTRITION_TABS = ["food", "supplements"] as const;
export type NutritionTab = (typeof NUTRITION_TABS)[number];

export function nutritionTabHref(tab: NutritionTab): AppRoute {
  return tab === "food" ? "/nutrition" : `/nutrition?tab=${tab}`;
}

// The standalone Medications page (#746) — medications left the old combined
// intake surface for their own Medical-group page.
export const MEDICATIONS_HREF: AppRoute = "/medications";
export const RECORDS_CONDITIONS_HREF: AppRoute = "/records/problems/conditions";

// The annual retrospective (#2179). A QUERY-RULE helper: the year lives in `?year=`,
// the newest year is the bare path (a link with no year means "the latest one"), and
// three surfaces build the link — the nav row, the page's own year picker, and the
// page's fallback when a hand-edited year does not exist. typedRoutes validates the
// PATH; this function is what keeps the parameter's shape in one place.
export function retrospectiveHref(year?: number): AppRoute {
  return year == null ? "/retrospective" : `/retrospective?year=${year}`;
}

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
export function intakeHref(kind: IntakeItemKind): AppRoute {
  return kind === "medication"
    ? MEDICATIONS_HREF
    : nutritionTabHref("supplements");
}

// THE HISTORY PAGE'S URL GRAMMAR (#3958) — ONE helper, one place the params are
// spelled, a #285 rule-carrying link.
//
// It replaces `doseLedgerHref` / `foodLedgerHref` / `practiceLedgerHref`, which named
// four routes that no longer exist. Their `from`/`to`/`range`/`page` params are NOT
// carried forward and have no successor: the record is navigated, not windowed, so the
// range row and the pager died with the routes (#2657's folds plus `?show` bound the
// read instead). A caller that used to hand this a date window hands it `day` — the
// day view is the honest form of "what did I take that day".
//
// `kind` implies its family, so a kind-scoped link never has to spell both. `class`
// preserves the old two-door dose pre-filter — one route opened on supplements and the
// other on medications — as a param on one page.
//
// `?subject=` IS NOT HERE, DELIBERATELY. The issue's grammar names it and phase 2
// will, but nothing on the page reads it yet — and a helper that WRITES a param no
// reader honours is worse than one that cannot: the URL looks scoped to a member and
// silently is not, and it fails in the reassuring direction (it shows the acting
// profile, so nothing looks wrong). It comes back with its reader.
//
// Param ORDER is fixed by this function, never by the caller's object literal, so the
// same state always produces the same URL — which is what makes a link cacheable and
// "did this href change?" a question a test can ask.
/** Everything `historyHref` spells, as a value a caller can build and pass on. Named so
 *  a server surface can hand a client one its own rules produced — the day view's add
 *  chips do that, adding the chart's window without re-deriving the kind rules (#4950). */
export interface HistoryHrefParams {
  family?: HistoryFamily;
  kind?: HistoryKind;
  class?: "supplement" | "medication";
  item?: string;
  media?: boolean;
  day?: string;
  everyone?: boolean;
  open?: readonly string[];
  /** The rollup lines opened in Everything (#3958 phase 2), one key per entry. */
  expand?: readonly string[];
  show?: number;
  /**
   * A window selected on the day chart (#4950), as profile-local `HH:MM` clocks on
   * the day in view. `to` is optional: a tap marks a start alone and leaves the
   * length to the form. Written and read through `lib/intraday-window.ts`, which is
   * where the shape is defined and where a pair that is not a window is refused.
   *
   * These ship WITH their reader, per the `?subject=` note above: the day view parses
   * them beside `kind` and hands the window to the add door.
   */
  from?: string;
  to?: string;
}

export function historyHref(params: HistoryHrefParams = {}): AppRoute {
  const sp = new URLSearchParams();
  // A kind implies its family; spelling both would be a URL that can contradict itself.
  if (params.family && !params.kind) sp.set("family", params.family);
  if (params.kind) sp.set("kind", params.kind);
  if (params.class) sp.set("class", params.class);
  if (params.item) sp.set("item", params.item);
  if (params.media) sp.set("media", "1");
  if (params.day) sp.set("day", params.day);
  // The window follows the day it is a window ON, and `to` follows `from`, so a URL
  // reads in the order a person would say it.
  if (params.from) sp.set("from", params.from);
  if (params.from && params.to) sp.set("to", params.to);
  if (params.everyone) sp.set("view", "everyone");
  for (const key of params.open ?? []) sp.append("open", key);
  for (const key of params.expand ?? []) sp.append("expand", key);
  if (params.show != null) sp.set("show", String(params.show));
  const qs = sp.toString();
  // Spelled as literals rather than through a `${base}` variable so Next's typedRoutes
  // can still infer the route from the literal prefix.
  return qs ? `/history?${qs}` : "/history";
}

// "Add this bottle for another person" (#1705) — the cabinet's second entry point into
// the item forms. Same kind→surface rule as intakeHref, plus the `?supply=` param the
// two surfaces parse to open their add form pre-seeded and pre-linked. One helper so the
// param name lives in exactly one place: the cabinet writes it, both pages read it.
export const SUPPLY_PREFILL_PARAM = "supply";

export function addItemFromPoolHref(
  kind: IntakeItemKind,
  supplyId: number
): AppRoute {
  return kind === "medication"
    ? `/medications?${SUPPLY_PREFILL_PARAM}=${supplyId}`
    : `/nutrition?tab=supplements&${SUPPLY_PREFILL_PARAM}=${supplyId}`;
}

// --------------------------------------------------------------------------
// Query-rule helpers
// --------------------------------------------------------------------------

// The Clinical results LIST route: where `clinicalResultDetailHref` falls back when there is
// no canonical name to chart, and (since #1447) where a PARAMLESS
// /results/clinical-results/view redirects — that route can only render a degenerate empty
// page, and this helper already owns "no name ⇒ the list". One constant so the
// link rule and the redirect can never point at different places.
export const CLINICAL_RESULTS_LIST_HREF: AppRoute = "/results/clinical-results";

// PRIVATE destination builder: the EPISODIC result's page (/results/clinical-results/view), or
// the list when there's nothing to chart. The RULE (was duplicated, wrong in one
// place — #283 bug 5): the view page resolves `?name=` as the CANONICAL name, so
// only a canonicalized result has a series to link to. Gate on `canonicalName`;
// when present, encode the CANONICAL name (NOT the raw display name — the bug
// flaggedToAttention shipped); when absent, fall back to the list.
//
// Not exported since #1932: it names ONE of the two detail surfaces, and a call
// site that could pick between them would be free to disagree with the routing
// rule. Everything outside this module asks `clinicalResultDetailHref` for "the detail
// page for this result" and gets whichever surface that result belongs on —
// exactly as `metricDetailHref` stays honest about being only the metric surface.
function episodicClinicalResultHref(
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
    ? `/results/clinical-results/view?name=${encodeURIComponent(name)}`
    : CLINICAL_RESULTS_LIST_HREF;
}

// THE detail page for a clinical result, wherever that result's surface lives
// (issue #1932). One helper for all eleven-plus link sites — the clinical results table,
// Recent labs, Timeline, search, findings, the import "what this wrote" produced-rows
// drilldown, the panel strip on the detail page itself — so none of them can decide
// for itself which renderer a reading deserves.
//
// The rule is CADENCE, and it lives in lib/reading-cadence.ts: a continuous reading
// (SpO2, blood pressure, respiratory rate, body temperature) resolves to its metric
// detail surface, which charts it as the trend it is; every episodic reading resolves
// to the reference-range renderer at /results/clinical-results/view. Named for its SUBJECT rather
// than either destination, because a helper named after one destination invites a
// caller to reason "this one is different, so I should use something else" — the
// drift the centralization exists to prevent.
export function clinicalResultDetailHref(
  canonicalName: string | null | undefined,
  rawName?: string | null
): AppRoute {
  const slug = continuousReadingSlug(canonicalName);
  return slug
    ? metricDetailHref(slug)
    : episodicClinicalResultHref(canonicalName, rawName);
}

// The Clinical results list FILTERED to one normalized panel (#1502). A rule-carrying
// helper because the `?panel=` facet now encodes a controlled SLUG (not the old
// free-text heading) on the post-#1079 list route, and two lanes emit it — the
// Panel cell in ClinicalResultsTable and the "see the whole panel" link on biomarker
// detail. One encoding so they can't drift onto different routes or param shapes.
export function clinicalResultPanelHref(panel: PanelId): AppRoute {
  return `/results/clinical-results?panel=${encodeURIComponent(panel)}`;
}

// The result ADD-FORM deep link: Results › Clinical results with the add form
// focused (?new=1) and optionally name-prefilled (#662). This is the ONE encoding
// of the lab-record deep-link shape (#1083) shared by the preventive screening
// rows/nudges (lib/preventive-upcoming) and the data-quality PhenoAge gap
// (#1146), so the two lanes can't diverge (#221). The base is the post-#1079
// tabbed route — never the retired `/results#biomarkers` bookmark.
export function clinicalResultAddHref(name?: string | null): AppRoute {
  const n = name?.trim();
  return n
    ? `/results/clinical-results?new=1&name=${encodeURIComponent(n)}`
    : "/results/clinical-results?new=1";
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

// One event's page (#3285 item 2): the plan, its day and its linked result.
export function trainingEventPageHref(planId: number): AppRoute {
  const href: Route<`/training/event/${number}`> = `/training/event/${planId}`;
  return href as AppRoute;
}

// One activity's canonical page (#2870): every activity type uses this route;
// callers preserve optional browsing context with typed query helpers below.
export function trainingActivityPageHref(
  activityId: number,
  subjectProfileId?: number
): AppRoute {
  const href: Route<`/training/activity/${number}`> = `/training/activity/${activityId}`;
  return (
    subjectProfileId == null ? href : `${href}?subject=${subjectProfileId}`
  ) as AppRoute;
}

// THE RECORD'S "JUMP TO THIS DAY" LINK (#3958 phase 2). One place the day-view
// param is spelled for the ~10 surfaces that deep-link a day — the sidebar calendar,
// the three sleep surfaces, Trends → Body, encounter detail, DayHistory, the
// integration import digests and the intake-safety finding.
//
// It replaces `timelineDayHref`, which named a route that no longer exists. Two
// things went with that route and neither has a successor, both by owner ruling:
//
//   • THE `#timeline-day-<date>` FRAGMENT. It existed because `/timeline?from=X&to=X`
//     still rendered a scrolling feed that had to be scrolled to the day. `?day=` IS
//     the day, so there is nothing to scroll to.
//   • THE `subject` PARAM (#1329). The 2026-08-29 ruling took `?subject=` out of the
//     grammar entirely — "never implemented, never will be" — because a subject param
//     is a second profile-selection vocabulary beside the sidebar switcher. A day link
//     built inside `?view=everyone` lands on the acting profile's day context, and
//     reading a member's day means switching to them.
export function historyDayHref(date: string): AppRoute {
  return historyHref({ day: date });
}

// THE DAY VIEW'S INTRADAY PANEL, AS A DESTINATION (#4767 item 1). The panel is the
// app's one intraday surface, and until now nothing could land on it: it carried
// testids and no id, so a receipt or a dashboard chart could only drop you at the
// top of the day and leave the scroll to you.
//
// This is NOT the `#timeline-day-<date>` fragment the note above retired. That one
// named a POSITION IN A FEED, which `?day=` made meaningless; this names a PANEL on
// the page the day param already selects — the same thing `/data#integrations` is.
export const INTRADAY_PANEL_ANCHOR = "day-at-a-glance";

export function historyDayIntradayHref(date: string): AppRoute {
  return `${historyDayHref(date)}#${INTRADAY_PANEL_ANCHOR}` as AppRoute;
}

// ONE WORKOUT DAY, IN THE LOG. Workout-day surfaces land in the domain ledger
// rather than routing through Timeline; the log owns activity review and editing,
// while Timeline remains the cross-domain destination.
//
// THE DAY IS IN THE QUERY, NOT IN A FRAGMENT (#4079). This used to be
// `/training?tab=log#day-<date>`, which asked the BROWSER to find the day among
// whatever the Log had drawn — so it resolved only while the day happened to fall
// inside the default window, and stopped resolving the moment that window moved.
// The Log is a place with a URL now, and the substrate it renders through already
// takes a day as a read bound (`HistoryGatherOptions.day`, the same `?day=` the
// record's day view is spelled with). Naming the day there is what makes the link
// land: the page gathers that day, so there is nothing left to scroll to. It is the
// ruling `#timeline-day-<date>` was retired under, and the one `bucketFeedHref`
// already applies a month at a time.
export function trainingLogDayHref(date: string): AppRoute {
  return trainingLogHref({ day: date });
}

// THE LOG TAB'S OWN URL (#4079). The tab renders through the shared history
// substrate, so its state is the substrate's — the bound, the open folds, the
// household mode — plus the training-only refinements layered on the mount. One
// builder, so every control writes the same grammar and a filter change can never
// drop the bound the reader had widened.
export function trainingLogHref(
  params: {
    q?: string | null;
    type?: string | null;
    source?: string | null;
    fault?: boolean;
    tag?: { kind: "muscle" | "region"; value: string } | null;
    /** One profile-local day, the substrate's own read bound. */
    day?: string | null;
    everyone?: boolean;
    show?: number;
    open?: readonly string[];
  } = {}
): AppRoute {
  const sp = new URLSearchParams({ tab: "log" });
  if (params.day) sp.set("day", params.day);
  if (params.q) sp.set("q", params.q);
  if (params.type) sp.set("type", params.type);
  if (params.source) sp.set("src", params.source);
  if (params.fault) sp.set("fault", "1");
  if (params.tag) sp.set("tag", `${params.tag.kind}:${params.tag.value}`);
  if (params.everyone) sp.set("view", "everyone");
  if (params.show != null) sp.set("show", String(params.show));
  for (const key of params.open ?? []) sp.append("open", key);
  return `/training?${sp.toString()}` as AppRoute;
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

/**
 * The bulk-correction panel with one field pre-selected (#1603). The `fix=` key
 * is a `CorrectionFieldId`; the review page validates it and falls back to no
 * pre-selection, so a key the panel does not know lands on an ordinary Review.
 */
export function bulkCorrectionHref(field: string): AppRoute {
  return `/data?section=review&fix=${field}#bulk-correction`;
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

export interface CyclingLens {
  metric: CardioMetric;
  range: RangeId;
  activity?: string;
}

// A ride reached from Cycling carries the aggregate lens that selected it. The
// same query survives adjacent/comparison navigation and reconstructs the
// overview link, so opening a Power · 6m ride never silently returns to
// Distance · All.
export function cyclingRideHref(
  id: number,
  lens: CyclingLens,
  subjectProfileId?: number
): AppRoute {
  const path = trainingActivityPageHref(id);
  const params = new URLSearchParams({
    metric: lens.metric,
    range: lens.range,
  });
  if (lens.activity && lens.activity.trim().toLowerCase() !== "cycling") {
    params.set("item", lens.activity);
  }
  if (subjectProfileId != null) {
    params.set("subject", String(subjectProfileId));
  }
  return `${path}?${params.toString()}` as AppRoute;
}

// The strength progression view for one movement. A PR link supplies the exact
// metric, all-time range, and load context that explain the record; ordinary
// exercise links can omit those refinements and let Analyze use its defaults.
export function strengthAnalyzeHref(
  exercise: string,
  options: {
    metric?: ExerciseCompareMetric;
    range?: RangeId;
    lane?: string;
  } = {}
): AppRoute {
  const params = new URLSearchParams({
    tab: "analyze",
    kind: "strength",
    item: exercise,
  });
  if (options.metric) params.set("metric", options.metric);
  if (options.range) params.set("range", options.range);
  if (options.lane) params.set("lane", options.lane);
  return `/training?${params.toString()}` as AppRoute;
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
// this canonical state instead of sending the reader back to a single Training Log
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
// registered kind points at. The slug is a stable TrendMetricSlug (see
// lib/trend-metrics); a dynamic route needs the widening cast. Typed `string`
// (not the slug union) to avoid a hrefs ↔ trend-metrics import cycle — the
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
