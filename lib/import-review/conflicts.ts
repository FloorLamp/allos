// Conflict-aware merge preview (issue #100). The PURE half: given the two full
// activity rows a merge would fold together, find the fields where BOTH rows carry a
// real, DIFFERING value — the cases where "keeper wins" is a guess the user should
// get to make. Everything here is unit-tested (no DB, no network).
//
// Scope. A conflict is only surfaced for NUMERIC MAGNITUDE columns (duration, HR,
// power, …) that differ beyond a small tolerance — the "42 vs 51 min" / "141 vs 149
// bpm" case the issue describes. One-sided fields (only one row has a value) keep
// folding silently, as do the string/opaque columns (notes, components, intensity,
// start/end time) and the workout_type enum, where a "differ beyond a tolerance"
// prompt makes no sense. Zero-as-missing semantics (#93) are reused verbatim from
// detect.ts (hasFoldValue / ZERO_IS_MISSING_FIELDS) — never forked.

import {
  ACTIVITY_FOLD_FIELDS,
  ZERO_IS_MISSING_FIELDS,
  hasFoldValue,
  foldActivityFields,
  type ActivityFoldField,
} from "./detect";

// Two magnitudes are "in conflict" only when they differ by MORE than this fraction
// of the larger one. Matched pairs already sit within the detector's 10% proximity
// window (PROXIMITY_TOLERANCE) on duration/distance, so the same 10% here means: if
// two values are close enough that they could have been the same measurement, don't
// bother the user; only a genuine disagreement (a HIGH-confidence time-overlap pair
// whose durations still diverge, say) raises a toggle.
export const CONFLICT_TOLERANCE = 0.1;

// The numeric magnitude columns a conflict can be surfaced on: the zero-as-missing
// measurement set (#93) plus avg_temp_c (a legitimate 0 reading, but still a
// magnitude). Deliberately EXCLUDES workout_type (an enum, not a magnitude) and the
// string/opaque fold fields.
export const CONFLICT_FIELDS: ReadonlySet<ActivityFoldField> =
  new Set<ActivityFoldField>([...ZERO_IS_MISSING_FIELDS, "avg_temp_c"]);

// Human labels for the conflict fields (pure data; the numeric value is formatted
// with the viewer's units in the UI layer).
export const FOLD_FIELD_LABELS: Partial<Record<ActivityFoldField, string>> = {
  duration_min: "Duration",
  distance_km: "Distance",
  elevation_m: "Elevation",
  avg_hr: "Avg HR",
  max_hr: "Max HR",
  avg_speed_kmh: "Avg speed",
  max_speed_kmh: "Max speed",
  relative_effort: "Relative effort",
  avg_power_w: "Avg power",
  max_power_w: "Max power",
  weighted_avg_power_w: "Weighted avg power",
  avg_cadence: "Avg cadence",
  kilojoules: "Energy",
  avg_temp_c: "Temperature",
};

export function foldFieldLabel(field: ActivityFoldField): string {
  return FOLD_FIELD_LABELS[field] ?? field;
}

// One surfaced conflict: the field plus the numeric value each side carries. Values
// are always the raw canonical numbers (kg/km/etc.) straight off the two rows.
export interface FieldConflict {
  field: ActivityFoldField;
  keepValue: number;
  dropValue: number;
}

// Relative closeness within `tol` (fraction). Two zeros are equal; otherwise the
// absolute difference over the larger magnitude. (Mirrors the private helper in
// detect.ts — kept local so this module stays self-contained.)
function withinTolerance(a: number, b: number, tol: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;
  return Math.abs(a - b) / max <= tol;
}

// The conflicts between a keeper row and the row it would absorb: for each numeric
// conflict field both rows carry a real value for (hasFoldValue — so a 0-filler
// doesn't count), where the two magnitudes differ beyond CONFLICT_TOLERANCE. Order
// follows ACTIVITY_FOLD_FIELDS for stable UI. Pure — the two args are the full rows.
export function detectFieldConflicts(
  keep: Record<string, unknown>,
  drop: Record<string, unknown>
): FieldConflict[] {
  const out: FieldConflict[] = [];
  for (const f of ACTIVITY_FOLD_FIELDS) {
    if (!CONFLICT_FIELDS.has(f)) continue;
    const kv = keep[f];
    const dv = drop[f];
    if (!hasFoldValue(f, kv) || !hasFoldValue(f, dv)) continue;
    if (typeof kv !== "number" || typeof dv !== "number") continue;
    if (!withinTolerance(kv, dv, CONFLICT_TOLERANCE))
      out.push({ field: f, keepValue: kv, dropValue: dv });
  }
  return out;
}

// Narrow an untrusted string to a real fold-field name.
export function isActivityFoldField(name: string): name is ActivityFoldField {
  return (ACTIVITY_FOLD_FIELDS as readonly string[]).includes(name);
}

// Validate an untrusted override list from a client into real, de-duplicated
// fold-field names. Accepts either a JSON-string (the form-encoded shape) or an
// already-parsed array; anything that isn't a known fold-field name is dropped. The
// VALUE is never trusted from the client — only the field NAME survives; the server
// re-reads both rows and takes the discarded row's own value for each named field.
export function parseOverrideFields(raw: unknown): ActivityFoldField[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<ActivityFoldField>();
  for (const x of list)
    if (typeof x === "string" && isActivityFoldField(x)) seen.add(x);
  return [...seen];
}

// Fold as usual (foldActivityFields — keeper wins, discarded fills gaps), then for
// each VALIDATED override field replace the keeper's value with the DISCARDED row's
// own value — but only when the discarded row actually carries a real value there
// (hasFoldValue), so an override can never inject a gap/filler. This is the only
// place a discarded value is chosen over the keeper, and it always comes from the
// re-read `drop` row — never from client input.
export function foldActivityFieldsWithOverrides(
  keep: Record<string, unknown>,
  drop: Record<string, unknown>,
  overrideFields: Iterable<string>
): Record<ActivityFoldField, unknown> {
  const out = foldActivityFields(keep, drop);
  for (const name of overrideFields) {
    if (!isActivityFoldField(name)) continue;
    if (hasFoldValue(name, drop[name])) out[name] = drop[name];
  }
  return out;
}

// Pull just the fold-field values off a full activity row — the compact payload the
// client needs to run detectFieldConflicts (and render the toggles) without shipping
// the whole row. Pure.
export function pickFoldValues(
  row: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ACTIVITY_FOLD_FIELDS) out[f] = row[f] ?? null;
  return out;
}
