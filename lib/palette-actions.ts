// Pure registry + matcher for the command palette's create actions (issue #29).
//
// v1 of the palette was navigation-only. These actions let it CREATE: each entry
// either opens the shared activity editor in-place ("Log workout") or navigates
// to a create surface with a query param that auto-focuses its form ("Log
// weight", "Add appointment", …). The registry is pure data + a pure matcher so
// the labels/keywords/targets are unit-testable and stay in one place; the
// palette component maps `icon`/`target` to real behavior.

export type PaletteActionTarget =
  // Open the activity editor overlay via the ActivityEditor context (no nav).
  | { kind: "activity" }
  // Repeat the most recent activity via the ActivityEditor context (issue #337):
  // opens a create form pre-filled from it. Shown only when one exists.
  | { kind: "repeat" }
  // Navigate to a route; the destination form focuses itself from the param
  // baked into `href` (see components/useFocusFormOnParam).
  | { kind: "navigate"; href: string };

export interface PaletteAction {
  id: string;
  label: string;
  // Extra search terms so "gym" finds "Log workout", "lab" finds biomarkers, etc.
  keywords: string[];
  // Icon key resolved to a Tabler icon in CommandPalette.
  icon: "barbell" | "scale" | "heart" | "calendar" | "chart";
  target: PaletteActionTarget;
}

// The query param a create surface reads to know it should open/focus its form.
export const FOCUS_PARAM = "new";

export const PALETTE_ACTIONS: PaletteAction[] = [
  {
    id: "log-workout",
    label: "Log workout",
    keywords: ["activity", "exercise", "training", "gym", "lift", "cardio"],
    icon: "barbell",
    target: { kind: "activity" },
  },
  {
    id: "repeat-last",
    label: "Repeat last activity",
    keywords: ["again", "duplicate", "same", "redo", "log again"],
    icon: "barbell",
    target: { kind: "repeat" },
  },
  {
    id: "log-weight",
    label: "Log weight",
    keywords: ["body", "metric", "bodyweight", "scale", "mass"],
    icon: "scale",
    target: {
      kind: "navigate",
      href: `/trends?tab=body&${FOCUS_PARAM}=weight`,
    },
  },
  {
    id: "log-vitals",
    label: "Log vitals",
    keywords: ["resting", "hr", "heart", "rate", "body fat", "pulse"],
    icon: "heart",
    target: {
      kind: "navigate",
      href: `/trends?tab=body&${FOCUS_PARAM}=vitals`,
    },
  },
  {
    id: "add-appointment",
    label: "Add appointment",
    keywords: ["visit", "doctor", "schedule", "clinic", "booking"],
    icon: "calendar",
    target: { kind: "navigate", href: `/encounters?${FOCUS_PARAM}=1` },
  },
  {
    id: "add-biomarker",
    label: "Add biomarker record",
    keywords: ["lab", "result", "blood", "biomarker", "panel", "test"],
    icon: "chart",
    target: { kind: "navigate", href: `/biomarkers?${FOCUS_PARAM}=1` },
  },
];

// Actions whose label or any keyword contains the (lowercased) query. An empty
// query returns every action (the palette's "quick actions" resting state).
export function matchPaletteActions(query: string): PaletteAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return PALETTE_ACTIONS;
  return PALETTE_ACTIONS.filter(
    (a) =>
      a.label.toLowerCase().includes(q) || a.keywords.some((k) => k.includes(q))
  );
}
