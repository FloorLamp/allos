// The Training hub's tab vocabulary (issue #1496) — the lib/trends-tabs.ts shape
// applied to /training so the page can build ONLY the active tab (#105).
//
// The page used to hand every section to `Tabs` as a `content:` prop, which rendered
// (and ran the queries for) all six during the RSC pass on every request — the client
// `keepMounted` flag only gated DOM. Reading `?tab=` here and switching on the result
// makes each visit compute one tab.
//
// The tab NAMES stay the deep-link vocabulary: `/training?tab=log` (the coaching
// engine, the timeline's activity links, every integration page), `?tab=overview`,
// `?tab=analyze` (the plateau finding), `?tab=fitness` (#158's longevity link),
// and `?tab=plan`. RETIRED NAMES KEEP RESOLVING (#2892): `routines` and `goals`
// merged into Plan, and their historic links — timeline goal events, every
// goal-pacing finding, onboarding, and Telegram messages that can never be
// rewritten — map to `plan` here rather than falling to the default, which would
// land a goal link on the wrong surface. An unknown value falls back to the
// default, exactly as `Tabs` did.
//
// PURE + unit-tested: the tab set, the parser and the strip are one decision here
// instead of three inline literals on a Server Component the pure tier can't see.

import type { AppRoute } from "./hrefs";

export const TRAINING_TABS = ["overview", "log", "analyze", "plan"] as const;

export type TrainingTab = (typeof TRAINING_TABS)[number];

// Overview leads (#2893, owner-ruled 2026-08-15): Log-first made sense when the
// Log tab WAS the workout form; with logging owned by the + and (per #2870) the
// activity page, the landing answer is "how am I doing / what should I do" —
// Overview's charter. Anything that wants the log says ?tab=log, as every
// shipped link already does.
export const DEFAULT_TRAINING_TAB: TrainingTab = "overview";

const TAB_LABELS: Record<TrainingTab, string> = {
  log: "Log",
  overview: "Overview",
  analyze: "Analyze",
  plan: "Plan",
};

// Retired tab names → the canonical URL the training page redirects them to.
// ONE mechanism for every retired name (#2892/#2894 review): a redirect
// NORMALIZES the URL, which is what makes the client tab strip highlight the
// right tab (NavTabsStrip resolves ?tab= itself and knows nothing of merges)
// and what restores the section anchor historic hashless links relied on —
// ?tab=goals used to open directly on the goal cards, so it must land on
// plan#goals, not the top of Plan. The MERGED_TABS parser mapping above stays
// as the belt for any caller that parses without redirecting.
const RETIRED_TAB_TARGETS: Record<string, AppRoute> = {
  goals: "/training?tab=plan#goals",
  routines: "/training?tab=plan#routines",
  // The Fitness check left the tab bar for its own route (#2894): the battery
  // is quarterly work, and Overview's strip is its standing surface.
  fitness: "/training/fitness-check",
};

/** The canonical redirect target for a retired ?tab= value, or null for live
 *  names and unknowns. Shares first()'s normalization with parseTrainingTab so
 *  the two can never disagree about what a raw param says. */
export function retiredTrainingTabTarget(
  value: string | string[] | undefined
): AppRoute | null {
  const raw = first(value);
  return (raw && RETIRED_TAB_TARGETS[raw]) || null;
}

// Retired tab names → the tab that absorbed them (#2892). A parser-level mapping,
// not an HTTP redirect: the links keep working with zero navigation cost.
const MERGED_TABS: Record<string, TrainingTab> = {
  routines: "plan",
  goals: "plan",
};

function isTrainingTab(v: string): v is TrainingTab {
  return (TRAINING_TABS as readonly string[]).includes(v);
}

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve a raw `?tab=` value; merged names resolve to their absorbing tab,
 *  anything unknown falls back to the default. */
export function parseTrainingTab(
  value: string | string[] | undefined
): TrainingTab {
  const raw = first(value);
  if (!raw) return DEFAULT_TRAINING_TAB;
  if (isTrainingTab(raw)) return raw;
  return MERGED_TABS[raw] ?? DEFAULT_TRAINING_TAB;
}

export interface TrainingTabEntry {
  id: TrainingTab;
  label: string;
}

/** The tab strip, in display order. */
export function trainingTabStrip(): TrainingTabEntry[] {
  return TRAINING_TABS.map((id) => ({ id, label: TAB_LABELS[id] }));
}
