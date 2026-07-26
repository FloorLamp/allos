// The Trends hub's tab vocabulary (issue #1486).
//
// Extracted out of app/(app)/trends/page.tsx so the tab set, the ?tab= parser and
// the tab strip are a PURE, unit-tested decision instead of three inline literals
// on a Server Component (which the pure tier structurally can't see).
//
// #1486 retires the **Vitals** tab: the physiologic vitals are the first section of
// the merged **Body** tab, so the strip drops to six entries. `?tab=vitals` keeps
// working as a VOCABULARY MAPPING — one alias entry here, resolved by `parseTab`,
// deliberately NOT a redirect layer: every old deep link (the preventive
// blood-pressure nudge, the Withings/dashboard CTAs, a bookmark, a Telegram
// message) simply names the tab by its former name and lands on Body.
//
// Fitness + Insights are age-gated surfaces, omitted for a training-restricted
// profile — the strip never offers them and the page falls back to the default when
// one is requested via ?tab= (the caller applies that; see the page).

export const TRENDS_TABS = [
  "overview",
  "compare",
  "body",
  "nutrition",
  "fitness",
  "insights",
] as const;

export type TrendsTab = (typeof TRENDS_TABS)[number];

// The tabs an age-restricted profile never sees (matching the Journal/Training/
// Insights nav gate).
export const RESTRICTED_TRENDS_TABS: readonly TrendsTab[] = [
  "fitness",
  "insights",
];

// Retired tab names that still resolve. ONE map, so "the Vitals tab is gone but its
// links are not" is a single fact rather than a redirect scattered across surfaces.
const TAB_ALIASES: Record<string, TrendsTab> = {
  // #1486: Vitals merged into Body (vitals section first).
  vitals: "body",
};

export const DEFAULT_TRENDS_TAB: TrendsTab = "overview";

function isTrendsTab(v: string): v is TrendsTab {
  return (TRENDS_TABS as readonly string[]).includes(v);
}

// Resolve a raw `?tab=` value: a live tab name wins, a retired one maps through the
// alias table, anything else falls back to the default.
export function parseTab(value: string | string[] | undefined): TrendsTab {
  const first = Array.isArray(value) ? value[0] : value;
  const raw = first?.trim();
  if (!raw) return DEFAULT_TRENDS_TAB;
  if (isTrendsTab(raw)) return raw;
  return TAB_ALIASES[raw] ?? DEFAULT_TRENDS_TAB;
}

export interface TrendsTabEntry {
  id: TrendsTab;
  label: string;
}

const TAB_LABELS: Record<TrendsTab, string> = {
  overview: "Overview",
  compare: "Compare",
  body: "Body",
  nutrition: "Nutrition",
  fitness: "Fitness",
  insights: "Insights",
};

// The tab strip, in display order. A training-restricted profile loses the two
// age-gated surfaces entirely (never in the strip, never reachable via ?tab=).
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
