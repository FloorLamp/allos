// Conflict-aware merge preview (issue #100, generalized N-way by #1431). The PURE
// half: given the full activity rows a merge would fold together, find the fields
// where two or more rows carry real, DIFFERING values — the cases where "keeper
// wins" is a guess the user should get to make. Everything here is unit-tested (no
// DB, no network).
//
// Scope. A conflict is only surfaced for NUMERIC MAGNITUDE columns (duration, HR,
// power, …) that differ beyond a small tolerance — the "42 vs 51 min" / "141 vs 149
// bpm" case issue #100 describes. One-sided fields (only one row has a value) keep
// folding silently, as do the string/opaque columns (notes, components, intensity,
// start/end time) and the workout_type enum, where a "differ beyond a tolerance"
// prompt makes no sense. Zero-as-missing semantics (#93) are reused verbatim from
// detect.ts (hasFoldValue / ZERO_IS_MISSING_FIELDS) — never forked.
//
// Since #1431 the detection and the override seam are N-WAY: a conflict lists the
// value EVERY member carries (not just keeper vs one drop), and an override names
// the MEMBER whose value should win a field — so a 3+-row cluster merge can keep,
// say, the Health Connect distance on a Strava keeper. The pairwise merge is the
// two-member case of the same computation.

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

// One merge member's fold-field values, keyed by its row id — the input shape for
// the N-way conflict detector. The keeper is a member like any other.
export interface MemberFoldValues {
  id: number;
  values: Record<string, unknown>;
}

// One surfaced conflict: the field plus the value EVERY member carries for it (a
// member without a real value simply isn't an option — an override can never inject
// a gap). Values are always the raw canonical numbers (kg/km/etc.) straight off the
// rows; options preserve the caller's member order.
export interface ClusterFieldConflict {
  field: ActivityFoldField;
  options: { memberId: number; value: number }[];
}

// Relative closeness within `tol` (fraction). Two zeros are equal; otherwise the
// absolute difference over the larger magnitude. (Mirrors the private helper in
// detect.ts — kept local so this module stays self-contained.)
function withinTolerance(a: number, b: number, tol: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max === 0) return true;
  return Math.abs(a - b) / max <= tol;
}

// The conflicts across N merge members (#1431): for each numeric conflict field,
// the members carrying a real value (hasFoldValue — a 0-filler doesn't count); the
// field is surfaced when at least two of those values differ beyond
// CONFLICT_TOLERANCE (the min/max spread — the same "would an unattended fold
// silently drop real data" question autoMergeCluster's material-conflict gate
// asks). Order follows ACTIVITY_FOLD_FIELDS for stable UI. Pure. The two-member
// call is exactly the pairwise #100 semantics: both rows carry a value and the two
// differ beyond tolerance.
export function detectClusterFieldConflicts(
  members: MemberFoldValues[]
): ClusterFieldConflict[] {
  const out: ClusterFieldConflict[] = [];
  for (const f of ACTIVITY_FOLD_FIELDS) {
    if (!CONFLICT_FIELDS.has(f)) continue;
    const options: { memberId: number; value: number }[] = [];
    for (const m of members) {
      const v = m.values[f];
      if (typeof v === "number" && hasFoldValue(f, v))
        options.push({ memberId: m.id, value: v });
    }
    if (options.length < 2) continue;
    const values = options.map((o) => o.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    if (!withinTolerance(lo, hi, CONFLICT_TOLERANCE))
      out.push({ field: f, options });
  }
  return out;
}

// The pre-selected member per conflicting field: the KEEPER's value when the keeper
// carries one, else the first listed option. The picker submits an explicit choice
// for every surfaced field, so what renders selected is exactly what the merge
// writes — the default is never left to fold-order luck. ONE computation (the
// dialog derives its initial state from this, and re-derives it when the keeper
// changes, so a keeper switch re-orients the preview).
export function defaultOverrideChoices(
  conflicts: ClusterFieldConflict[],
  keeperId: number
): OverrideChoices {
  const out: OverrideChoices = {};
  for (const c of conflicts)
    out[c.field] = c.options.some((o) => o.memberId === keeperId)
      ? keeperId
      : c.options[0].memberId;
  return out;
}

// Narrow an untrusted string to a real fold-field name.
export function isActivityFoldField(name: string): name is ActivityFoldField {
  return (ACTIVITY_FOLD_FIELDS as readonly string[]).includes(name);
}

// Per-field source-member choice (#1431): for each named fold field, the row id of
// the merge member whose value should win. The VALUE never crosses the client
// boundary — only the field name and member id do; the server re-reads the rows and
// takes the chosen member's own stored value.
export type OverrideChoices = Partial<Record<ActivityFoldField, number>>;

// Validate an untrusted override payload from a client into real, per-field member
// choices. Accepts a JSON-string (the form-encoded shape) or an already-parsed
// value, in either of two shapes:
//   - an OBJECT of fold-field name → member row id (the #1431 picker);
//   - the LEGACY pairwise ARRAY of fold-field names (#100 — "take the discarded
//     row's value"), resolved against `legacyDropId` when the caller can name the
//     single discarded row; without one the array shape validates to no overrides.
// Anything that isn't a known fold-field name with a positive-integer id is
// dropped. Only NAMES and IDS survive — the id is later resolved against the
// re-read, profile-verified merge rows, so a foreign id can never take effect.
export function parseOverrideChoices(
  raw: unknown,
  legacyDropId?: number
): OverrideChoices {
  let val: unknown = raw;
  if (typeof raw === "string") {
    try {
      val = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const out: OverrideChoices = {};
  if (Array.isArray(val)) {
    if (typeof legacyDropId !== "number" || !Number.isInteger(legacyDropId))
      return {};
    for (const x of val)
      if (typeof x === "string" && isActivityFoldField(x))
        out[x] = legacyDropId;
    return out;
  }
  if (val == null || typeof val !== "object") return {};
  for (const [k, v] of Object.entries(val)) {
    const n = Number(v);
    if (isActivityFoldField(k) && Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}

// Fold as usual across the keeper and the ordered drops (foldActivityFields —
// keeper wins, each drop only fills gaps, in the caller's deterministic order),
// then apply the per-field member choices: each named field takes the CHOSEN
// member's own value — regardless of where that member sits in the fold order —
// but only when that member is actually one of the merge rows and carries a real
// value there (hasFoldValue), so an override can never inject a gap/filler or
// reach outside the merge. This is the only place a non-fold-default value is
// chosen, and it always comes from a re-read row — never from client input.
export function foldActivityFieldsWithOverrides(
  keep: Record<string, unknown>,
  drops: Record<string, unknown>[],
  choices: OverrideChoices = {}
): Record<ActivityFoldField, unknown> {
  let acc: Record<string, unknown> = keep;
  for (const drop of drops) acc = { ...acc, ...foldActivityFields(acc, drop) };
  const out = {} as Record<ActivityFoldField, unknown>;
  for (const f of ACTIVITY_FOLD_FIELDS) out[f] = acc[f] ?? null;

  const byId = new Map<number, Record<string, unknown>>();
  for (const m of [keep, ...drops])
    if (typeof m.id === "number") byId.set(m.id, m);
  for (const [name, memberId] of Object.entries(choices)) {
    if (!isActivityFoldField(name) || typeof memberId !== "number") continue;
    const member = byId.get(memberId);
    if (member && hasFoldValue(name, member[name])) out[name] = member[name];
  }
  return out;
}

// Pull just the fold-field values off a full activity row — the compact payload the
// client needs to run detectClusterFieldConflicts (and render the picker) without
// shipping the whole row. Pure.
export function pickFoldValues(
  row: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ACTIVITY_FOLD_FIELDS) out[f] = row[f] ?? null;
  return out;
}
