// Deep-link resolution for the combined "Log measurements" form (issue #1486).
//
// Two param conventions reach this form, and they used to reach three different
// forms on two different tabs:
//   • `focus=` — the care surfaces' convention (the preventive blood-pressure nudge
//     `focus=blood-pressure` (#1083), the sleep prompt `focus=sleep` (#800), the
//     pediatric-height data-quality CTA `focus=height` (#1146));
//   • `new=`   — the FOCUS_PARAM convention (`new=weight` / `new=vitals`, #29).
//     Originally the command palette's; #2184 moved those palette picks onto the
//     in-place quick-entry overlay, but the links stay valid for PWA shortcuts,
//     bookmarks, and anything else that speaks them.
// After the merge both land on ONE form, so the mapping is one pure table here —
// shared by the form (which field to focus) and by the desktop expander / mobile
// overlay (whether to open at all). An unrecognized value focuses nothing, so a
// stale or crafted link never plants a surprise cursor.

export function deepLinkFieldId(
  focus: string | null | undefined,
  created: string | null | undefined
): string | null {
  switch (focus) {
    case "blood-pressure":
      return "m-systolic";
    case "sleep":
      return "m-sleep";
    case "height":
      return "m-height";
    case "weight":
      return "m-weight";
    // #1850: the respiratory surfaces link here to log a blow (the zone card's own
    // "Log a reading" affordance), so peak flow gets a focus target like the rest.
    case "peak-flow":
      return "m-peak-flow";
  }
  switch (created) {
    case "weight":
      return "m-weight";
    case "vitals":
      // The historical "Log vitals" link has always focused the resting-HR
      // field; the merge keeps that target. (The palette pick itself opens the
      // overlay on the vitals GROUP now — #2184 — resolved through the same
      // field→group table below.)
      return "m-resting-hr";
  }
  return null;
}

// ── The form's GROUPS (issue #2014) ─────────────────────────────────────────
//
// The combined form is thirteen fields, and thirteen always-empty boxes to collect
// the one or two readings someone actually took is the thing its own copy argues
// against ("fill in only what you measured"). They are disclosed in three groups,
// exactly one of which is open on mount — chosen by where the person came from.
//
// The field→group lookup lives HERE, beside the deep-link table, deliberately: a
// deep link names a FIELD and the form has to open the group holding it, so a
// second mapping in the component could disagree with this one. One table.
export type MeasurementGroup = "vitals" | "body" | "sleep";

export const MEASUREMENT_GROUPS: readonly MeasurementGroup[] = [
  "vitals",
  "body",
  "sleep",
];

export const MEASUREMENT_GROUP_LABEL: Record<MeasurementGroup, string> = {
  vitals: "Vitals",
  body: "Body",
  sleep: "Sleep & recovery",
};

// No context at all (the quick-log sheet on a profile that has never saved) opens
// Vitals: it holds the reading people take on purpose and then log.
export const DEFAULT_MEASUREMENT_GROUP: MeasurementGroup = "vitals";

// Every grouped field of the form, by its DOM id. `m-date` / `m-time` (the shared
// WhenControl pair) and `m-notes` are deliberately absent: all are permanent,
// rendered outside the groups, and belong to whatever was entered rather than to
// one domain.
const FIELD_GROUP: Record<string, MeasurementGroup> = {
  "m-systolic": "vitals",
  "m-diastolic": "vitals",
  "m-resting-hr": "vitals",
  "m-spo2": "vitals",
  "m-temperature": "vitals",
  "m-temp-time": "vitals",
  "m-glucose": "vitals",
  // Peak expiratory flow (#1850) and the clock time it was blown at. In VITALS
  // because that is what it is — a measured respiratory vital sign, taken on purpose
  // and then logged, which is exactly what the group's own copy describes.
  "m-peak-flow": "vitals",
  "m-peak-flow-time": "vitals",
  "m-weight": "body",
  "m-body-fat": "body",
  "m-height": "body",
  "m-head-circ": "body",
  "m-sleep": "sleep",
  "m-hrv": "sleep",
};

// The ids this table covers — read by the completeness test, which fails if the
// form grows a field with no group (or this table names one the form doesn't have).
export const GROUPED_MEASUREMENT_FIELD_IDS: readonly string[] =
  Object.keys(FIELD_GROUP);

// The permanent fields outside every group, by the literal `id="…"` the form
// source carries. Notes only, since #2235: the date (and the sitting's optional
// time) render through the shared WhenControl, whose `m-date` / `m-time` ids are
// built from its testId inside components/WhenControl.tsx — outside this scan's
// literal-id vocabulary, and outside every group for the same reason `m-date`
// always was (they belong to whatever was entered, not to one domain).
export const UNGROUPED_MEASUREMENT_FIELD_IDS: readonly string[] = ["m-notes"];

export function measurementFieldGroup(
  fieldId: string | null | undefined
): MeasurementGroup | null {
  if (!fieldId) return null;
  return FIELD_GROUP[fieldId] ?? null;
}

// The group a deep link asks for, or null when the URL names no field. Same
// unrecognized-value posture as deepLinkFieldId: a stale or crafted link opens
// nothing special rather than planting a surprise.
export function deepLinkGroup(
  focus: string | null | undefined,
  created: string | null | undefined
): MeasurementGroup | null {
  return measurementFieldGroup(deepLinkFieldId(focus, created));
}

// What a group is holding, for its header when it is collapsed — so a typed value
// is never invisible behind a chevron. Keyed by FORM FIELD NAME (what FormData
// carries), so the caller hands over a plain reader and this stays pure.
export function measurementGroupSummary(
  group: MeasurementGroup,
  value: (name: string) => string | null
): string | null {
  const parts: string[] = [];
  const add = (raw: string | null, format: (v: string) => string): void => {
    const v = (raw ?? "").trim();
    if (v !== "") parts.push(format(v));
  };
  if (group === "vitals") {
    const systolic = (value("systolic") ?? "").trim();
    const diastolic = (value("diastolic") ?? "").trim();
    // A blood pressure is ONE reading typed as two numbers — it summarizes as one.
    if (systolic !== "" || diastolic !== "") {
      parts.push(`${systolic || "—"}/${diastolic || "—"}`);
    }
    add(value("resting_hr"), (v) => `${v} bpm`);
    add(value("spo2"), (v) => `${v}%`);
    add(
      value("temperature"),
      (v) => `${v}°${value("temp_unit") === "C" ? "C" : "F"}`
    );
    add(value("glucose"), (v) => `${v} ${value("glucose_unit") ?? "mg/dL"}`);
    add(value("peak_flow"), (v) => `${v} L/min`);
  } else if (group === "body") {
    add(value("weight"), (v) => `${v} ${value("weight_unit") ?? "kg"}`);
    add(value("body_fat_pct"), (v) => `${v}% fat`);
    add(value("height"), (v) => `${v} ${value("height_unit") ?? "cm"} tall`);
    add(
      value("head_circ"),
      (v) => `${v} ${value("head_circ_unit") ?? "cm"} head`
    );
  } else {
    add(value("sleep_hours"), (v) => `${v} hrs sleep`);
    add(value("hrv"), (v) => `${v} ms HRV`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Whether a URL asks the measurements form to OPEN: the desktop expander starts
// collapsed, and the phone carries no on-page form at all (the quick-entry overlay
// is its logging path), so a deep link has to say "open me" as well as "focus this".
export function measurementsDeepLinked(
  focus: string | null | undefined,
  created: string | null | undefined
): boolean {
  return deepLinkFieldId(focus, created) != null;
}
