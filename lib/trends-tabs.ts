// The Trends hub's tab vocabulary (issue #1486, extended by #1489 and #1492).
//
// Extracted out of app/(app)/trends/page.tsx so the tab set, the ?tab= parser and
// the tab strip are a PURE, unit-tested decision instead of three inline literals
// on a Server Component (which the pure tier structurally can't see).
//
// #1486 retired the **Vitals** tab: the physiologic vitals are the first section of
// the merged **Body** tab. #1489 retires **Compare** the same way — it is now a
// SECTION of Insights (the hub's "derived views over your data" tab: AI insights,
// situation analytics, compare) — leaving FIVE tabs in frequency order:
// Overview | Body | Fitness | Nutrition | Insights (five chips fit a 390px phone
// unclipped).
//
// Both retirements are VOCABULARY MAPPINGS — one alias entry here, resolved by
// `parseTab`, deliberately NOT a redirect layer: every old deep link (`?tab=vitals`
// from the preventive blood-pressure nudge, `?tab=compare&cmpA=…&cmpB=…` from a
// bookmark or a stored saved view) simply names the tab by its former name and
// lands on the tab that absorbed it. The compare params ride along untouched — the
// page reads cmpA/cmpB/cmpn off the URL independently of the tab name, so nothing
// has to re-encode them.
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
  "body",
  "fitness",
  "nutrition",
  "insights",
] as const;

export type TrendsTab = (typeof TRENDS_TABS)[number];

// The tabs an age-restricted profile never sees. Fitness alone since #1489 —
// Insights survives the gate carrying only its compare section (see the header).
export const RESTRICTED_TRENDS_TABS: readonly TrendsTab[] = ["fitness"];

// Retired tab names that still resolve. ONE map, so "the Vitals/Compare tabs are
// gone but their links are not" is a single fact rather than a redirect scattered
// across surfaces.
const TAB_ALIASES: Record<string, TrendsTab> = {
  // #1486: Vitals merged into Body (vitals section first).
  vitals: "body",
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

const TAB_LABELS: Record<TrendsTab, string> = {
  overview: "Overview",
  body: "Body",
  fitness: "Fitness",
  nutrition: "Nutrition",
  insights: "Insights",
};

// The tab strip, in display order. A training-restricted profile loses only the
// wholly age-gated Fitness surface; Insights stays (its gated half is hidden by
// the section, not the strip — #1489).
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
