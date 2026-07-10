import { describe, it, expect } from "vitest";
import {
  CONFLICT_TOLERANCE,
  CONFLICT_FIELDS,
  detectFieldConflicts,
  isActivityFoldField,
  parseOverrideFields,
  foldActivityFieldsWithOverrides,
  pickFoldValues,
  foldFieldLabel,
} from "@/lib/import-review/conflicts";

// Conflict-aware merge preview (issue #100). The detector surfaces ONLY numeric
// magnitude fields where both rows carry a real, differing value beyond a tolerance;
// everything else folds silently.

describe("detectFieldConflicts", () => {
  it("flags a numeric field both rows populate that differs beyond tolerance", () => {
    // The issue's flagship case: overlapping-time pair, but durations diverge.
    const keep = { duration_min: 42, distance_km: 5.0 };
    const drop = { duration_min: 51, distance_km: 5.05 };
    const conflicts = detectFieldConflicts(keep, drop);
    expect(conflicts).toEqual([
      { field: "duration_min", keepValue: 42, dropValue: 51 },
    ]);
    // distance 5.0 vs 5.05 is within tolerance → not surfaced.
  });

  it("does not flag values within the tolerance", () => {
    // 40 vs 42 = 4.76%, well within the 10% window — a near-identical measurement.
    expect(
      detectFieldConflicts({ duration_min: 40 }, { duration_min: 42 })
    ).toEqual([]);
  });

  it("ignores one-sided fields (only one row has a value)", () => {
    const keep = { duration_min: 42, distance_km: null };
    const drop = { duration_min: null, distance_km: 5 };
    // Neither field is populated on BOTH rows → nothing to choose.
    expect(detectFieldConflicts(keep, drop)).toEqual([]);
  });

  it("treats a zero measurement as missing, not a conflicting value (#93)", () => {
    // keep distance 0 is a "sensor didn't record" filler, not a real 0 vs 8.2.
    const keep = { distance_km: 0, avg_hr: 150 };
    const drop = { distance_km: 8.2, avg_hr: 150 };
    // distance: one side is filler → one-sided, no conflict. avg_hr equal → none.
    expect(detectFieldConflicts(keep, drop)).toEqual([]);
  });

  it("surfaces several conflicts in stable fold-field order", () => {
    const keep = { duration_min: 40, avg_hr: 120, max_hr: 150 };
    const drop = { duration_min: 60, avg_hr: 160, max_hr: 151 };
    const fields = detectFieldConflicts(keep, drop).map((c) => c.field);
    // max_hr 150 vs 151 is within tolerance; duration + avg_hr diverge.
    expect(fields).toEqual(["duration_min", "avg_hr"]);
  });

  it("never surfaces the workout_type enum or string fields as conflicts", () => {
    const keep = {
      workout_type: 3,
      notes: "hard",
      intensity: "high",
      start_time: "08:00",
    };
    const drop = {
      workout_type: 10,
      notes: "easy",
      intensity: "low",
      start_time: "08:30",
    };
    // Enum + opaque/string fields fold silently — "differ beyond a tolerance"
    // is meaningless for them.
    expect(detectFieldConflicts(keep, drop)).toEqual([]);
  });

  it("surfaces a temperature conflict even though 0°C is a legit reading", () => {
    const conflicts = detectFieldConflicts(
      { avg_temp_c: 2 },
      { avg_temp_c: 21 }
    );
    expect(conflicts).toEqual([
      { field: "avg_temp_c", keepValue: 2, dropValue: 21 },
    ]);
  });

  it("CONFLICT_FIELDS excludes workout_type and the string fold fields", () => {
    expect(CONFLICT_FIELDS.has("avg_hr")).toBe(true);
    expect(CONFLICT_FIELDS.has("avg_temp_c")).toBe(true);
    expect(CONFLICT_FIELDS.has("workout_type" as never)).toBe(false);
    expect(CONFLICT_FIELDS.has("notes" as never)).toBe(false);
    expect(CONFLICT_TOLERANCE).toBeGreaterThan(0);
  });
});

describe("parseOverrideFields (server-side validation)", () => {
  it("keeps only real fold-field names, de-duplicated", () => {
    expect(
      parseOverrideFields(["duration_min", "avg_hr", "duration_min"])
    ).toEqual(["duration_min", "avg_hr"]);
  });

  it("drops non-fold-field and identity/provenance names", () => {
    // id/date/source/title are NOT fold fields; 'nonsense' is junk.
    expect(
      parseOverrideFields(["id", "date", "source", "title", "nonsense"])
    ).toEqual([]);
  });

  it("parses a JSON-string list (the form-encoded shape)", () => {
    expect(parseOverrideFields('["distance_km","bogus"]')).toEqual([
      "distance_km",
    ]);
  });

  it("returns [] for malformed / missing input", () => {
    expect(parseOverrideFields(null)).toEqual([]);
    expect(parseOverrideFields("not json")).toEqual([]);
    expect(parseOverrideFields(42)).toEqual([]);
    expect(parseOverrideFields({ duration_min: true })).toEqual([]);
  });

  it("isActivityFoldField narrows correctly", () => {
    expect(isActivityFoldField("avg_power_w")).toBe(true);
    expect(isActivityFoldField("profile_id")).toBe(false);
  });
});

describe("foldActivityFieldsWithOverrides", () => {
  const keep = { duration_min: 42, distance_km: 5, avg_hr: 150 };
  const drop = { duration_min: 51, distance_km: 4.9, avg_hr: 160 };

  it("with no overrides, folds exactly like the keeper-wins base fold", () => {
    const out = foldActivityFieldsWithOverrides(keep, drop, []);
    expect(out.duration_min).toBe(42); // keeper wins
    expect(out.avg_hr).toBe(150); // keeper wins
    expect(out.distance_km).toBe(5); // keeper wins
  });

  it("takes the DISCARDED row's value for each overridden field only", () => {
    const out = foldActivityFieldsWithOverrides(keep, drop, [
      "duration_min",
      "avg_hr",
    ]);
    expect(out.duration_min).toBe(51); // overridden → drop's value
    expect(out.avg_hr).toBe(160); // overridden → drop's value
    expect(out.distance_km).toBe(5); // untouched → keeper's value
  });

  it("ignores an override naming a field the discarded row has no real value for", () => {
    // drop.max_hr absent → the override can't inject a gap; keeper's fold stands.
    const out = foldActivityFieldsWithOverrides(
      { max_hr: 180 },
      { max_hr: null },
      ["max_hr"]
    );
    expect(out.max_hr).toBe(180);
  });

  it("ignores an override naming a non-fold field", () => {
    const out = foldActivityFieldsWithOverrides(keep, drop, ["source", "id"]);
    expect(out.duration_min).toBe(42); // unchanged keeper-wins fold
  });
});

describe("pickFoldValues + foldFieldLabel", () => {
  it("extracts the fold columns (nulling absent ones) and nothing else", () => {
    const row = { id: 7, profile_id: 1, duration_min: 30, avg_hr: 140 };
    const picked = pickFoldValues(row);
    expect(picked.duration_min).toBe(30);
    expect(picked.avg_hr).toBe(140);
    expect(picked.max_hr).toBeNull();
    expect("id" in picked).toBe(false);
    expect("profile_id" in picked).toBe(false);
  });

  it("labels conflict fields for the UI", () => {
    expect(foldFieldLabel("duration_min")).toBe("Duration");
    expect(foldFieldLabel("avg_hr")).toBe("Avg HR");
  });
});
