// The Trends hub's SECTION vocabulary (issue #1644) — successor to the retired
// `lib/trends-tabs.ts`.
//
// #1644 merged the tab strip (Overview | Body | Fitness | Nutrition | Insights)
// into ONE scrollable page: the trending digest and the cross-domain starred grid
// head it, and each domain census follows as a titled SECTION. What used to be a
// tab is now an `#anchor`, and what used to be the tab strip is the page's
// jump-chip row.
//
// The `?tab=` param died WITH the strip, with NO compatibility shim (#1635 policy):
// there is nothing left for it to select, and a mapping table that resolves a tab
// name to "the whole page" is a vocabulary pretending to be a choice. Every
// internal deep link moved to a section anchor in the same change.
//
// GATE SHAPE (carried over from #1489). Fitness is wholly age-gated content, so a
// training-restricted profile gets neither the chip nor the section. Insights is
// MIXED — the AI half is age-gated but its compare half is age-neutral — so its
// gate stays DOWN in the section, which hides only the gated half. Hence
// RESTRICTED_TRENDS_SECTIONS lists fitness alone.
//
// WHY INSIGHTS IS A SECTION AND NOT ITS OWN SURFACE (#1644, decided here rather
// than by default): its content is derived views over the SAME window the rest of
// the page reads — the digest ranks the movers, the censuses draw them, Insights
// narrates them and overlays two of them against each other. Splitting it back out
// would re-mint the navigation weight this issue removed, and its compare section
// is the one surface that must sit next to the census it compares. It closes the
// page instead.

import type { AppRoute } from "./hrefs";

// Every section of the merged page, in render (and chip) order. The ids double as
// the in-page `#anchor` — the same id → anchor convention the Fitness sections
// (#1492) and the Body chart stack (#1067) already use one level down.
export const TRENDS_SECTIONS = [
  "starred",
  "body",
  "fitness",
  "nutrition",
  "insights",
] as const;

export type TrendsSection = (typeof TRENDS_SECTIONS)[number];

// The sections an age-restricted profile never sees (see the header).
export const RESTRICTED_TRENDS_SECTIONS: readonly TrendsSection[] = ["fitness"];

const SECTION_LABELS: Record<TrendsSection, string> = {
  starred: "Starred",
  body: "Body",
  fitness: "Fitness",
  nutrition: "Nutrition",
  insights: "Insights",
};

export interface TrendsSectionEntry {
  id: TrendsSection;
  label: string;
}

// The page's jump-chip strip, in reading order. A training-restricted profile
// loses only the wholly age-gated Fitness section.
export function trendsSectionStrip(restricted: boolean): TrendsSectionEntry[] {
  return TRENDS_SECTIONS.filter(
    (id) => !restricted || !RESTRICTED_TRENDS_SECTIONS.includes(id)
  ).map((id) => ({ id, label: SECTION_LABELS[id] }));
}

// Whether a section is unavailable to this profile, so the page can skip both the
// chip and the render (the section's own content gate is still authoritative).
export function isSectionRestricted(
  id: TrendsSection,
  restricted: boolean
): boolean {
  return restricted && RESTRICTED_TRENDS_SECTIONS.includes(id);
}

// A deep link INTO a section of the hub — the successor to every `/trends?tab=…`
// literal (#1644). A rule-carrying helper in the #285 sense: the anchor id is the
// section id, and one edit here re-points every dashboard tile, finding CTA,
// palette action, and integration link at once.
export function trendsSectionHref(id: TrendsSection): AppRoute {
  return `/trends#${id}` as AppRoute;
}
