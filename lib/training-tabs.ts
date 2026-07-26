// The Training hub's tab vocabulary (issue #1496) — the lib/trends-tabs.ts shape
// applied to /training so the page can build ONLY the active tab (#105).
//
// The page used to hand every section to `Tabs` as a `content:` prop, which rendered
// (and ran the queries for) all six during the RSC pass on every request — the client
// `keepMounted` flag only gated DOM. Reading `?tab=` here and switching on the result
// makes each visit compute one tab.
//
// The tab NAMES are unchanged and stay the deep-link vocabulary: `/training?tab=log`
// (the coaching engine, the timeline's activity links, every integration page),
// `?tab=overview`, `?tab=analyze` (the plateau finding), `?tab=fitness` (#158's
// longevity link), `?tab=routines` (onboarding), `?tab=goals` (the dashboard widget).
// An unknown value falls back to the default, exactly as `Tabs` did.
//
// PURE + unit-tested: the tab set, the parser and the strip are one decision here
// instead of three inline literals on a Server Component the pure tier can't see.

export const TRAINING_TABS = [
  "log",
  "overview",
  "analyze",
  "fitness",
  "routines",
  "goals",
] as const;

export type TrainingTab = (typeof TRAINING_TABS)[number];

// Log leads: it IS the Journal (JOURNAL_ROUTE = "/training"), the surface a training
// visit usually wants, and it was the first tab (hence the default) before #1496.
export const DEFAULT_TRAINING_TAB: TrainingTab = "log";

const TAB_LABELS: Record<TrainingTab, string> = {
  log: "Log",
  overview: "Overview",
  analyze: "Analyze",
  fitness: "Fitness check",
  routines: "Routines",
  goals: "Goals",
};

function isTrainingTab(v: string): v is TrainingTab {
  return (TRAINING_TABS as readonly string[]).includes(v);
}

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve a raw `?tab=` value; anything unknown falls back to the default. */
export function parseTrainingTab(
  value: string | string[] | undefined
): TrainingTab {
  const raw = first(value);
  return raw && isTrainingTab(raw) ? raw : DEFAULT_TRAINING_TAB;
}

export interface TrainingTabEntry {
  id: TrainingTab;
  label: string;
}

/** The tab strip, in display order. */
export function trainingTabStrip(): TrainingTabEntry[] {
  return TRAINING_TABS.map((id) => ({ id, label: TAB_LABELS[id] }));
}
