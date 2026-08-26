// The Training hub's tab vocabulary (issue #1496). Parsing here lets the page
// build only the active tab (#105), while retired names keep historic deep links
// resolving to the section that absorbed them (#2892).

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
// The redirect normalizes both the selected tab and the historic section anchor;
// the parser mapping below covers callers that parse without redirecting.
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
