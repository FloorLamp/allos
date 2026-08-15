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

export const TRAINING_TABS = [
  "log",
  "overview",
  "analyze",
  "fitness",
  "plan",
] as const;

export type TrainingTab = (typeof TRAINING_TABS)[number];

// Log leads: it IS the Training Log (TRAINING_LOG_ROUTE = "/training"), the surface a training
// visit usually wants, and it was the first tab (hence the default) before #1496.
export const DEFAULT_TRAINING_TAB: TrainingTab = "log";

const TAB_LABELS: Record<TrainingTab, string> = {
  log: "Log",
  overview: "Overview",
  analyze: "Analyze",
  fitness: "Fitness check",
  plan: "Plan",
};

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
