// The Trends hub's tab vocabulary (issue #1486, extended by #1489, #1492, #1644).
//
// Extracted out of app/(app)/trends/page.tsx so the tab set, the ?tab= parser and
// the tab strip are a PURE, unit-tested decision instead of three inline literals
// on a Server Component (which the pure tier structurally can't see).
//
// #1486 retired the **Vitals** tab into Body. #1489 retired **Compare** into
// Insights. #1644 retired **Body** itself into Overview. #3512 deliberately
// reverses #1492 and retires **Fitness** into Training → Analyze, leaving three
// tabs in frequency order: Overview | Nutrition | Insights.
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
import type { AppRoute } from "./hrefs";

export const TRENDS_TABS = ["overview", "nutrition", "insights"] as const;

export type TrendsTab = (typeof TRENDS_TABS)[number];

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

// The retired nested Fitness strip (#1492) still names the retired Fitness
// surface when no live/aliased outer tab wins. The page uses this to redirect old
// bookmarks and notification links to Training → Analyze (#3512).
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
// alias table, anything else falls back to the default. Fitness is handled by the
// explicit redirect decision below so it cannot silently fall onto Overview.
export function parseTab(value: string | string[] | undefined): TrendsTab {
  const raw = first(value);
  if (raw) {
    if (isTrendsTab(raw)) return raw;
    const alias = TAB_ALIASES[raw];
    if (alias) return alias;
  }
  return DEFAULT_TRENDS_TAB;
}

/** Return the canonical destination for the retired Fitness surface. A live or
 * aliased outer tab still wins over a stale nested `ftab`, matching the old
 * parser's precedence. */
export function retiredFitnessTabTarget(
  value: string | string[] | undefined,
  nested?: string | string[] | undefined
): AppRoute | null {
  const raw = first(value);
  if (raw) {
    if (raw === "fitness") return "/training?tab=analyze";
    if (isTrendsTab(raw) || TAB_ALIASES[raw]) return null;
  }
  const ftab = first(nested);
  return ftab && RETIRED_FTABS.includes(ftab) ? "/training?tab=analyze" : null;
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
  nutrition: "Nutrition",
  insights: "Insights",
};

// The tab strip, in display order — THREE entries since Fitness retired into
// Training → Analyze (#3512).
export function trendsTabStrip(): TrendsTabEntry[] {
  return TRENDS_TABS.map((id) => ({ id, label: TAB_LABELS[id] }));
}
