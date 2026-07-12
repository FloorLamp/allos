// Starter templates for N-of-1 protocols (issue #571). A template is just a set of
// prefill defaults for the add-protocol form (name, notes, outcome metric keys,
// suggested situation + adherence practice) — the user reviews and edits everything
// before saving, so a template never creates a protocol on its own. Pure (const
// data + a lookup), client- and server-safe.
//
// The flagship is SUN EXPOSURE: intervention = daily outdoor daylight minutes (the
// #571 metric, or a manual habit log); outcome = the vitamin-D biomarker family
// through the existing protocol-compare engine — "did my lunch-walk protocol move my
// 25-OH D?". Copy stays observational; sun exposure is dual-edged (vitamin D vs.
// skin-cancer risk), so the notes surface the question, not a prescription.

export interface ProtocolTemplate {
  id: string;
  label: string;
  // A one-line description for the templates strip.
  blurb: string;
  // Prefill defaults for the form.
  name: string;
  notes: string;
  // Outcome metric keys to pre-select (only those the profile actually tracks will
  // render as checkboxes). Biomarker keys use the `biomarker:<canonical>` form.
  outcomeKeys: string[];
  // Suggested situation label + adherence practice (activity type × N/week).
  situation: string;
  practiceType: "strength" | "cardio" | "sport" | "";
  practicePerWeek: number | null;
}

export const SUN_EXPOSURE_TEMPLATE: ProtocolTemplate = {
  id: "sun-exposure",
  label: "Sun exposure",
  blurb:
    "Daily outdoor daylight time vs. your vitamin D — did the lunch-walk habit move your 25-OH D?",
  name: "Daily daylight walk",
  notes:
    "Intervention: outdoor daylight time on most days (e.g. a 20-minute lunch walk). " +
    "Outcome: 25-hydroxy vitamin D. Observational only — sun exposure is dual-edged " +
    "(vitamin D vs. skin-cancer risk); this tracks the relationship, it doesn't " +
    "prescribe UV. Discuss changes with your clinician.",
  outcomeKeys: ["biomarker:Vitamin D, 25-Hydroxy"],
  situation: "Daily daylight",
  practiceType: "cardio",
  practicePerWeek: 5,
};

export const PROTOCOL_TEMPLATES: ProtocolTemplate[] = [SUN_EXPOSURE_TEMPLATE];

// Look up a template by its id, or null.
export function protocolTemplateById(
  id: string | null | undefined
): ProtocolTemplate | null {
  if (!id) return null;
  return PROTOCOL_TEMPLATES.find((t) => t.id === id) ?? null;
}
