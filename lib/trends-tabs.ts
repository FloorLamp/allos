// The Trends hub's tab vocabulary (issue #1486, extended by #1489, #1492, #1644).
//
// Extracted out of app/(app)/trends/page.tsx so the tab set, the ?tab= parser and
// the tab strip are a PURE, unit-tested decision instead of three inline literals
// on a Server Component (which the pure tier structurally can't see).
//
// #1486 retired the **Vitals** tab into Body. #1489 retired **Compare** into
// Insights. #1644 retires **Body** itself: its census moved onto the Overview
// LANDING SURFACE (digest → starred grid → body census), leaving FOUR tabs in
// frequency order: Overview | Fitness | Nutrition | Insights.
//
// THE FOUR ARE PERMANENT (owner ruling, #1644). The merge stops here: the landing
// surface answers "how am I doing", and Fitness / Nutrition / Insights answer "how
// is my training / nutrition / analysis specifically". There is no all-tabs
// endpoint and no phase 2 — the earlier symmetry argument for folding the rest in
// was rejected as aesthetic, so reviving it needs a new owner decision rather than
// this file quietly growing sections again.
//
// #1489's Compare retirement stays a VOCABULARY MAPPING — one alias entry here,
// resolved by `parseTab`, deliberately NOT a redirect layer: an old
// `?tab=compare&cmpA=…&cmpB=…` link simply names the tab by its former name and
// lands on the tab that absorbed it. The compare params ride along untouched — the
// page reads cmpA/cmpB/cmpn off the URL independently of the tab name, so nothing
// has to re-encode them.
//
// **`?tab=body` and `?tab=vitals` get NO entry** (#1635/#1644): the surface they
// named is the DEFAULT view now, so they need no mapping to reach it — an unknown
// value already falls through to the default. Adding an alias would be a shim for
// a link that already lands correctly, which is exactly what #1635 forbids.
//
// GATE SHAPE (#1489). Fitness is wholly age-gated content, so it keeps its
// TAB-level gate: a training-restricted profile never sees the chip and a
// `?tab=fitness` falls back to the default. Insights is now MIXED — the AI insight
// content is age-gated but compare is age-neutral (restricted profiles have always
// had it) — so its gate moved DOWN to the sections: the tab is offered to everyone
// and InsightsSection hides the gated half. Hence RESTRICTED_TRENDS_TABS lists
// fitness alone.

export const TRENDS_TABS = [
  "overview",
  "fitness",
  "nutrition",
  "insights",
] as const;

export type TrendsTab = (typeof TRENDS_TABS)[number];

// The tabs an age-restricted profile never sees. Fitness alone since #1489 —
// Insights survives the gate carrying only its compare section (see the header).
export const RESTRICTED_TRENDS_TABS: readonly TrendsTab[] = ["fitness"];

// Retired tab names that still resolve to a DIFFERENT tab. ONE map, so "the
// Compare tab is gone but its links are not" is a single fact rather than a
// redirect scattered across surfaces. Body and Vitals are deliberately absent —
// see the header: they resolve to the default view through the ordinary
// unknown-value fallback, which is not a shim.
const TAB_ALIASES: Record<string, TrendsTab> = {
  // #1489: Compare folded into Insights as a section. cmpA/cmpB/cmpn are read
  // straight off the URL by the hub, so an old link's comparison renders as-is.
  compare: "insights",
};

// The RETIRED nested Fitness strip (#1492). Fitness used to carry a second
// navigation level — `?ftab=strength|cardio|sport` — that re-mounted the /training
// page's sections verbatim. It's gone: Fitness is now four windowed SECTIONS, so
// there is no nested tab to select and no nested param to honor.
//
// Same vocabulary-mapping shape as TAB_ALIASES above, one level down: an old link
// simply NAMES the Fitness tab by its nested value, and the value itself is then
// IGNORED (there is nothing left for "cardio" to select — the Zones & cardio
// section renders on the tab unconditionally). A `?tab=fitness&ftab=cardio` link
// already carries its tab and needs nothing; the case this table exists for is a
// link that lost (or never had) the outer `?tab=` — it still lands on Fitness
// rather than silently on Overview.
const RETIRED_FTABS: readonly string[] = ["strength", "cardio", "sport"];

export const DEFAULT_TRENDS_TAB: TrendsTab = "overview";

function isTrendsTab(v: string): v is TrendsTab {
  return (TRENDS_TABS as readonly string[]).includes(v);
}

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

// Resolve a raw `?tab=` value: a live tab name wins, a retired one maps through the
// alias table, anything else falls back to the default. `nested` is the legacy
// `?ftab=` value (#1492) — consulted ONLY when `?tab=` names nothing live, so a
// pre-#1492 deep link into a nested Fitness view still lands on Fitness.
export function parseTab(
  value: string | string[] | undefined,
  nested?: string | string[] | undefined
): TrendsTab {
  const raw = first(value);
  if (raw) {
    if (isTrendsTab(raw)) return raw;
    const alias = TAB_ALIASES[raw];
    if (alias) return alias;
  }
  const ftab = first(nested);
  if (ftab && RETIRED_FTABS.includes(ftab)) return "fitness";
  return DEFAULT_TRENDS_TAB;
}

export interface TrendsTabEntry {
  id: TrendsTab;
  label: string;
}

// Overview keeps its label through the merge (#1644): the landing surface still
// answers "what changed and what did I star" — it simply carries the body census
// underneath now.
const TAB_LABELS: Record<TrendsTab, string> = {
  overview: "Overview",
  fitness: "Fitness",
  nutrition: "Nutrition",
  insights: "Insights",
};

// The tab strip, in display order — FOUR entries since #1644. A training-restricted
// profile loses only the wholly age-gated Fitness surface; Insights stays (its
// gated half is hidden by the section, not the strip — #1489).
export function trendsTabStrip(restricted: boolean): TrendsTabEntry[] {
  return TRENDS_TABS.filter(
    (id) => !restricted || !RESTRICTED_TRENDS_TABS.includes(id)
  ).map((id) => ({ id, label: TAB_LABELS[id] }));
}

// Whether a requested tab is unavailable to this profile (so the caller can fall
// back rather than advertise a tab that isn't in the strip).
export function isTabRestricted(tab: TrendsTab, restricted: boolean): boolean {
  return restricted && RESTRICTED_TRENDS_TABS.includes(tab);
}
