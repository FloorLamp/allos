// Semantic href helpers + the app-wide internal-route type alias (issue #285).
//
// Two things live here:
//
// 1. `AppRoute` — the single alias every href-carrying DATA MODEL field is typed
//    with (`href: AppRoute`, not `href: string`). It resolves to Next's generated
//    `Route` type (from `experimental`-graduated `typedRoutes`, enabled in
//    next.config.js), so an invalid internal pathname stored in a model — the
//    #283 dead-link class (`/goals`, `/medical` after a page was consolidated
//    away) — becomes a `tsc` (⇒ `npm run build`) error. External URLs stay a
//    plain `string`; only INTERNAL app routes are `AppRoute`.
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
//   - QUERY-RULE helpers (biomarkerViewHref, timelineDayHref, dataSectionHref):
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

// The merged cross-profile household visit + illness history (#1009). A static
// route shared across ≥4 surfaces (the Household header, the dashboard illness
// promotion, and the widen-to-household links on Visits + Illness episodes), so it's
// a named const — one edit re-checks every caller — rather than a re-typed literal.
export const HOUSEHOLD_HISTORY_HREF: AppRoute = "/household/history";

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

// --------------------------------------------------------------------------
// Query-rule helpers
// --------------------------------------------------------------------------

// Deep-link to a biomarker's chart on /biomarkers/view, or the list when there's
// nothing to chart. The RULE (was duplicated, wrong in one place — #283 bug 5):
// the view page resolves `?name=` as the CANONICAL name, so only a canonicalized
// reading has a series to link to. Gate on `canonicalName`; when present, encode
// the CANONICAL name (NOT the raw display name — the bug flaggedToAttention
// shipped); when absent, fall back to the list. `biomarkerItems` (correct) and
// `buildFlaggedItem` (the buggy one) both converge here.
export function biomarkerViewHref(
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
    ? `/biomarkers/view?name=${encodeURIComponent(name)}`
    : "/results/biomarkers";
}

// The Timeline "jump to this day" link: filter the feed to a single day AND
// scroll to that day's anchor. One place for the `/timeline?from=X&to=X#…`
// pattern the sidebar calendar and the workout heatmap (#186) both build.
export function timelineDayHref(date: string): AppRoute {
  return `/timeline?from=${date}&to=${date}#timeline-day-${date}`;
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
  "calendar-feed": "/integrations/calendar-feed",
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

// A protocol (training/care protocol) detail page.
export function protocolHref(id: number): AppRoute {
  const href: Route<`/protocols/${number}`> = `/protocols/${id}`;
  return href as AppRoute;
}

// The per-vaccine immunization history page (slug is the vaccine code/name).
export function immunizationHref(vaccine: string): AppRoute {
  const href: Route<`/immunizations/${string}`> = `/immunizations/${vaccine}`;
  return href as AppRoute;
}

// The illness-episode detail page (issue #856). The slug is the STABLE episode row id
// — it survives boundary edits (unlike the old date slug), so a bookmark/link never
// dangles when the start date is corrected. A dynamic route needs the widening cast.
export function episodeHref(id: number): AppRoute {
  const href: Route<`/medical/episodes/${string}`> = `/medical/episodes/${id}`;
  return href as AppRoute;
}
