// Pure registry + matcher for the command palette's create actions (issue #29).
//
// v1 of the palette was navigation-only. These actions let it CREATE: each entry
// opens the shared activity editor in-place ("Log workout"), opens a quick-entry
// overlay form in-place ("Log weight", "Add document" — #2184: everything the
// quick-log sheet has a drawer form for), or navigates to a create surface with a
// query param that auto-focuses its form ("Add appointment", … — exactly the
// entries with no drawer form). The registry is pure data + a pure matcher so
// the labels/keywords/targets are unit-testable and stay in one place; the
// palette component maps `icon`/`target` to real behavior.

import type { AppRoute } from "./hrefs";
import type { QuickEntryForm, QuickEntryPrefill } from "./quick-log";

export type PaletteActionTarget =
  // Open the activity editor overlay via the ActivityEditor context (no nav).
  | { kind: "activity" }
  // Open an existing form in the shared quick-entry overlay, in place (#1468) — the
  // SAME `QuickEntryForm` key the quick-log sheet's registry uses, because browse (the
  // sheet) and search (the palette) are two surfaces over one set of forms, not two
  // encodings of "open a create form" (#1506). `prefill` is the context the PICK
  // itself implies (#2014/#2184): "Log weight" opens the measurements form ON the
  // weight group, overriding the form's last-written-group memory (#2068), which
  // stays for context-free opens like the sheet's rows.
  | { kind: "overlay"; form: QuickEntryForm; prefill?: QuickEntryPrefill }
  // Start a LIVE workout (issue #340): opens the create form in the in-gym layout
  // (rest timer + set check-off). Hidden for age-restricted profiles (#489).
  | { kind: "live" }
  // Repeat the most recent activity via the ActivityEditor context (issue #337):
  // opens a create form pre-filled from it. Shown only when one exists.
  | { kind: "repeat" }
  // Navigate to a route; the destination form focuses itself from the param
  // baked into `href` (see components/useFocusFormOnParam).
  | { kind: "navigate"; href: AppRoute };

export interface PaletteAction {
  id: string;
  label: string;
  // Extra search terms so "gym" finds "Log workout", "lab" finds biomarkers, etc.
  keywords: string[];
  // Icon key resolved to a Tabler icon in CommandPalette.
  icon:
    | "barbell"
    | "scale"
    | "heart"
    | "calendar"
    | "chart"
    | "camera"
    | "sparkles"
    | "document";
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
    id: "start-workout",
    // The RESTING label. While a session is live the palette renders the shared
    // start-vs-resume offer instead (#1893, lib/workout-offer) — "resume"/"continue"
    // are keywords here so the action is findable by the verb it will actually perform.
    label: "Start workout",
    keywords: [
      "live",
      "session",
      "rest timer",
      "begin",
      "in session",
      "resume",
      "continue",
    ],
    icon: "barbell",
    target: { kind: "live" },
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
    // TWO palette entries onto the ONE merged measurements form (#1486), where the
    // sheet carries one row: the sheet is a browse surface and one door is enough;
    // the palette is a search surface and "weight" and "vitals" are different
    // intents that should land on different GROUPS of that one form (#2014's
    // context rule). Both used to hard-navigate to the Trends body-section inline
    // forms — a pre-merge journey the sheet had already left behind (#2184).
    label: "Log weight",
    keywords: ["body", "metric", "bodyweight", "scale", "mass"],
    icon: "scale",
    target: {
      kind: "overlay",
      form: "measurements",
      // m-weight's home group; pinned against lib/measurements-deeplink's one
      // field→group table by the registry test.
      prefill: { measurementGroup: "body" },
    },
  },
  {
    id: "log-vitals",
    label: "Log vitals",
    keywords: ["resting", "hr", "heart", "rate", "body fat", "pulse"],
    icon: "heart",
    target: {
      kind: "overlay",
      form: "measurements",
      prefill: { measurementGroup: "vitals" },
    },
  },
  {
    id: "add-appointment",
    label: "Add appointment",
    keywords: ["visit", "doctor", "schedule", "clinic", "booking"],
    icon: "calendar",
    target: {
      kind: "navigate",
      href: `/records/history/visits?${FOCUS_PARAM}=1`,
    },
  },
  {
    id: "add-progress-photo",
    // The always-visible entry to /progress (#1119): the nav leaf is data-gated
    // (hidden until a first photo exists), so this action is the non-stranded
    // creation path for the first capture. The focus param auto-opens the
    // capture flow on arrival (useFocusFormOnParam-style, handled by the page).
    label: "Add progress photo",
    keywords: [
      "photo",
      "physique",
      "body",
      "picture",
      "camera",
      "pose",
      "capture",
      "progress",
    ],
    icon: "camera",
    target: { kind: "navigate", href: `/progress?${FOCUS_PARAM}=1` },
  },
  {
    id: "wellness-practices",
    // Always visible because the matching sidebar leaf is relevance-gated until a
    // first practice target or session exists (#1620). The label is the sheet
    // row's label and the target is the sheet row's target (#2184): the SAME
    // practice overlay, in place. A profile with nothing tracked yet gets the
    // overlay's honest empty state, which points at Wellness — the #1620
    // first-practice path keeps a door (and the /wellness?new=1 deep link
    // itself is untouched).
    label: "Log practice",
    keywords: [
      "wellness",
      "wellness practices",
      "meditation",
      "breathwork",
      "sauna",
      "habit",
      "session",
    ],
    icon: "sparkles",
    target: { kind: "overlay", form: "practice" },
  },
  {
    id: "add-document",
    // The palette is a SEARCH surface, so the one sheet row ("Add document") is reached
    // here by whichever word the user has in mind — upload, scan, lab report, a photo of
    // a result (#1506's browse-vs-search doctrine). Every one of them opens the SAME
    // overlay the sheet opens, mounting the SAME UploadForm the Data page renders:
    // neither surface gets a form of its own.
    label: "Add document",
    keywords: [
      "upload",
      "scan",
      "document",
      "file",
      "lab report",
      "pdf",
      "photo of a result",
      "after-visit summary",
      "health record export",
      "attach",
    ],
    icon: "document",
    target: { kind: "overlay", form: "document" },
  },
  {
    id: "add-biomarker",
    label: "Add biomarker record",
    keywords: ["lab", "result", "blood", "biomarker", "panel", "test"],
    icon: "chart",
    target: {
      kind: "navigate",
      href: `/results/biomarkers?${FOCUS_PARAM}=1`,
    },
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
