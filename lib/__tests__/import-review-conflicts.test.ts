import { describe, it, expect } from "vitest";
import {
  CONFLICT_TOLERANCE,
  CONFLICT_FIELDS,
  detectClusterFieldConflicts,
  defaultOverrideChoices,
  isActivityFoldField,
  parseOverrideChoices,
  foldActivityFieldsWithOverrides,
  pickFoldValues,
  foldFieldLabel,
  keeperFoldState,
} from "@/lib/import-review/conflicts";

// Conflict-aware merge picker (issue #100, N-way since #1431). The detector
// surfaces ONLY numeric magnitude fields where two or more members carry real
// values that differ beyond a tolerance; everything else folds silently. The
// pairwise merge is the two-member case of the same computation.

// Two-member shorthand for the pairwise semantics (#100).
const pair = (keep: Record<string, unknown>, drop: Record<string, unknown>) =>
  detectClusterFieldConflicts([
    { id: 1, values: keep },
    { id: 2, values: drop },
  ]);

describe("detectClusterFieldConflicts — pairwise semantics (#100)", () => {
  it("flags a numeric field both rows populate that differs beyond tolerance", () => {
    // The issue's flagship case: overlapping-time pair, but durations diverge.
    const conflicts = pair(
      { duration_min: 42, distance_km: 5.0 },
      { duration_min: 51, distance_km: 5.05 }
    );
    expect(conflicts).toEqual([
      {
        field: "duration_min",
        options: [
          { memberId: 1, value: 42 },
          { memberId: 2, value: 51 },
        ],
      },
    ]);
    // distance 5.0 vs 5.05 is within tolerance → not surfaced.
  });

  it("does not flag values within the tolerance", () => {
    // 40 vs 42 = 4.76%, well within the 10% window — a near-identical measurement.
    expect(pair({ duration_min: 40 }, { duration_min: 42 })).toEqual([]);
  });

  it("ignores one-sided fields (only one row has a value)", () => {
    // Neither field is populated on BOTH rows → nothing to choose.
    expect(
      pair(
        { duration_min: 42, distance_km: null },
        { duration_min: null, distance_km: 5 }
      )
    ).toEqual([]);
  });

  it("treats a zero measurement as missing, not a conflicting value (#93)", () => {
    // keep distance 0 is a "sensor didn't record" filler, not a real 0 vs 8.2.
    // distance: one side is filler → one-sided, no conflict. avg_hr equal → none.
    expect(
      pair({ distance_km: 0, avg_hr: 150 }, { distance_km: 8.2, avg_hr: 150 })
    ).toEqual([]);
  });

  it("surfaces several conflicts in stable fold-field order", () => {
    const fields = pair(
      { duration_min: 40, avg_hr: 120, max_hr: 150 },
      { duration_min: 60, avg_hr: 160, max_hr: 151 }
    ).map((c) => c.field);
    // max_hr 150 vs 151 is within tolerance; duration + avg_hr diverge.
    expect(fields).toEqual(["duration_min", "avg_hr"]);
  });

  it("never surfaces the workout_type enum or string fields as conflicts", () => {
    // Enum + opaque/string fields fold silently — "differ beyond a tolerance"
    // is meaningless for them.
    expect(
      pair(
        {
          workout_type: 3,
          notes: "hard",
          intensity: "high",
          start_time: "08:00",
        },
        {
          workout_type: 10,
          notes: "easy",
          intensity: "low",
          start_time: "08:30",
        }
      )
    ).toEqual([]);
  });

  it("surfaces a temperature conflict even though 0°C is a legit reading", () => {
    expect(pair({ avg_temp_c: 2 }, { avg_temp_c: 21 })).toEqual([
      {
        field: "avg_temp_c",
        options: [
          { memberId: 1, value: 2 },
          { memberId: 2, value: 21 },
        ],
      },
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

describe("detectClusterFieldConflicts — N-way (#1431)", () => {
  it("lists EVERY member's value for a conflicting field, in member order", () => {
    const conflicts = detectClusterFieldConflicts([
      { id: 10, values: { distance_km: 5, duration_min: 30 } },
      { id: 20, values: { distance_km: 8, duration_min: 30 } },
      { id: 30, values: { distance_km: 12, duration_min: 31 } },
    ]);
    // Duration 30/30/31 agrees within tolerance; only distance is surfaced —
    // with all three members' values, not just keeper-vs-one.
    expect(conflicts).toEqual([
      {
        field: "distance_km",
        options: [
          { memberId: 10, value: 5 },
          { memberId: 20, value: 8 },
          { memberId: 30, value: 12 },
        ],
      },
    ]);
  });

  it("surfaces a conflict the keeper has no value for (two drops disagree)", () => {
    // The silent-guess problem exists even when the keeper carries no value: the
    // fold would pick a drop by order alone, so the user gets the choice.
    const conflicts = detectClusterFieldConflicts([
      { id: 1, values: { avg_hr: null } },
      { id: 2, values: { avg_hr: 120 } },
      { id: 3, values: { avg_hr: 160 } },
    ]);
    expect(conflicts).toEqual([
      {
        field: "avg_hr",
        options: [
          { memberId: 2, value: 120 },
          { memberId: 3, value: 160 },
        ],
      },
    ]);
  });

  it("does not flag members that all agree within tolerance", () => {
    expect(
      detectClusterFieldConflicts([
        { id: 1, values: { duration_min: 30 } },
        { id: 2, values: { duration_min: 31 } },
        { id: 3, values: { duration_min: 32 } },
      ])
    ).toEqual([]);
  });
});

describe("defaultOverrideChoices (pre-selection)", () => {
  const conflicts = detectClusterFieldConflicts([
    { id: 1, values: { distance_km: 5, avg_hr: null } },
    { id: 2, values: { distance_km: 8, avg_hr: 120 } },
    { id: 3, values: { distance_km: 12, avg_hr: 160 } },
  ]);

  it("pre-selects the keeper's value when the keeper carries one", () => {
    // Keeper 2: it carries both conflicting fields → both pre-select to 2.
    expect(defaultOverrideChoices(conflicts, 2)).toEqual({
      distance_km: 2,
      avg_hr: 2,
    });
  });

  it("falls back to the first option when the keeper has no value", () => {
    // Keeper 1 has no avg_hr → that field pre-selects the first carrying member.
    expect(defaultOverrideChoices(conflicts, 1)).toEqual({
      distance_km: 1,
      avg_hr: 2,
    });
  });

  it("re-orients when the keeper changes", () => {
    // The same conflicts, a different keeper → different pre-selection. This is
    // the "changing the keeper re-orients the preview" rule (#1431).
    expect(defaultOverrideChoices(conflicts, 3)).toEqual({
      distance_km: 3,
      avg_hr: 3,
    });
  });
});

describe("parseOverrideChoices (server-side validation)", () => {
  it("keeps only real fold-field names with positive-integer member ids", () => {
    expect(
      parseOverrideChoices({ duration_min: 7, avg_hr: 9, nonsense: 3 })
    ).toEqual({ duration_min: 7, avg_hr: 9 });
  });

  it("drops identity/provenance names and non-integer ids", () => {
    expect(
      parseOverrideChoices({
        id: 1,
        source: 2,
        title: 3,
        duration_min: "junk",
        distance_km: -4,
        avg_hr: 2.5,
      })
    ).toEqual({});
  });

  it("parses a JSON-string object (the form-encoded shape)", () => {
    expect(parseOverrideChoices('{"distance_km":12,"bogus":1}')).toEqual({
      distance_km: 12,
    });
  });

  it("resolves the legacy pairwise array shape against the single drop id (#100)", () => {
    expect(parseOverrideChoices('["duration_min","bogus"]', 42)).toEqual({
      duration_min: 42,
    });
    // Without a resolvable single drop, the array shape validates to nothing.
    expect(parseOverrideChoices('["duration_min"]')).toEqual({});
  });

  it("returns {} for malformed / missing input", () => {
    expect(parseOverrideChoices(null)).toEqual({});
    expect(parseOverrideChoices("not json")).toEqual({});
    expect(parseOverrideChoices(42)).toEqual({});
  });

  it("isActivityFoldField narrows correctly", () => {
    expect(isActivityFoldField("avg_power_w")).toBe(true);
    expect(isActivityFoldField("profile_id")).toBe(false);
  });
});

describe("foldActivityFieldsWithOverrides", () => {
  const keep = { id: 1, duration_min: 42, distance_km: 5, avg_hr: 150 };
  const dropA = { id: 2, duration_min: 51, distance_km: 4.9, avg_hr: 160 };
  const dropB = { id: 3, duration_min: 60, distance_km: 12, max_hr: 190 };

  it("with no overrides, folds exactly like the keeper-wins base fold", () => {
    const out = foldActivityFieldsWithOverrides(keep, [dropA, dropB]);
    expect(out.duration_min).toBe(42); // keeper wins
    expect(out.avg_hr).toBe(150); // keeper wins
    expect(out.distance_km).toBe(5); // keeper wins
    expect(out.max_hr).toBe(190); // gap-filled from the only carrier
  });

  it("takes the CHOSEN member's value per field, regardless of fold order (#1431)", () => {
    // dropB is LAST in the fold order — its values would never win a fold — yet
    // the choice lands them; the un-chosen fields keep the keeper-wins fold.
    const out = foldActivityFieldsWithOverrides(keep, [dropA, dropB], {
      distance_km: 3,
      avg_hr: 2,
    });
    expect(out.distance_km).toBe(12); // chosen → dropB's value
    expect(out.avg_hr).toBe(160); // chosen → dropA's value
    expect(out.duration_min).toBe(42); // untouched → keeper's value
  });

  it("a choice naming the keeper is the keeper-wins fold (an explicit no-op)", () => {
    const out = foldActivityFieldsWithOverrides(keep, [dropA], {
      duration_min: 1,
    });
    expect(out.duration_min).toBe(42);
  });

  it("ignores a choice naming a member the merge doesn't contain", () => {
    // A forged member id resolves to nothing — the fold default stands.
    const out = foldActivityFieldsWithOverrides(keep, [dropA], {
      duration_min: 999,
    });
    expect(out.duration_min).toBe(42);
  });

  it("ignores a choice for a field the chosen member has no real value for", () => {
    // dropA.max_hr absent → the override can't inject a gap; the fold stands.
    const out = foldActivityFieldsWithOverrides(
      { id: 1, max_hr: 180 },
      [{ id: 2, max_hr: null }],
      { max_hr: 2 }
    );
    expect(out.max_hr).toBe(180);
  });

  it("ignores a choice naming a non-fold field", () => {
    const out = foldActivityFieldsWithOverrides(keep, [dropA], {
      source: 2,
      id: 2,
    } as never);
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

// ── keeperFoldState — the invertible fold (#1884) ─────────────────────────────
// The keeper columns a merge writes, as ONE pure computation used in both
// directions: the fold writes it, and a merge UNDO replays it with the un-folded
// drop removed from the member set. The properties the partial-batch undo relies
// on are that it depends only on the member SET (not on how members got there),
// that an empty set reproduces the pre-fold keeper exactly, and that removing one
// member removes exactly that member's contribution.
describe("keeperFoldState — the invertible fold (#1884)", () => {
  const before = {
    id: 1,
    notes: null,
    avg_hr: null,
    max_hr: null,
    duration_min: 30,
    equipment_id: null,
    edited: 0,
  };
  const a = { id: 2, notes: "from-a" };
  const b = { id: 3, avg_hr: 150 };
  const c = { id: 4, max_hr: 180 };

  it("with no drops reproduces the pre-fold keeper, edit lock included", () => {
    const state = keeperFoldState({ ...before, edited: 1 }, []);
    expect(state.fields.notes).toBeNull();
    expect(state.fields.avg_hr).toBeNull();
    expect(state.fields.duration_min).toBe(30);
    expect(state.equipmentId).toBeNull();
    expect(state.edited).toBe(1); // the keeper's OWN prior lock, not the fold's
  });

  it("edit-locks the keeper while any drop is folded in", () => {
    expect(keeperFoldState(before, [a]).edited).toBe(1);
    expect(keeperFoldState(before, []).edited).toBe(0);
  });

  it("removing one member removes exactly that member's contribution", () => {
    const all = keeperFoldState(before, [a, b, c]).fields;
    expect([all.notes, all.avg_hr, all.max_hr]).toEqual(["from-a", 150, 180]);
    // Un-folding a and c (the partial-undo case) leaves b's contribution alone.
    const onlyB = keeperFoldState(before, [b]).fields;
    expect([onlyB.notes, onlyB.avg_hr, onlyB.max_hr]).toEqual([
      null,
      150,
      null,
    ]);
  });

  it("is independent of the order the members are passed in", () => {
    expect(keeperFoldState(before, [a, b, c])).toEqual(
      keeperFoldState(before, [c, a, b])
    );
  });

  it("hands a shared gap to the next remaining member when the filler leaves", () => {
    // Both drops can fill avg_hr; fold order decides which does. Removing the
    // winner must surface the other's value, not the keeper's gap.
    const b2 = { id: 5, avg_hr: 160 };
    const both = keeperFoldState(before, [b, b2]).fields.avg_hr;
    expect([150, 160]).toContain(both);
    expect(keeperFoldState(before, [b2]).fields.avg_hr).toBe(160);
  });

  it("keeper-wins COALESCEs the equipment link across the remaining members", () => {
    expect(
      keeperFoldState(before, [{ id: 6, equipment_id: 9 }]).equipmentId
    ).toBe(9);
    expect(
      keeperFoldState({ ...before, equipment_id: 4 }, [
        { id: 6, equipment_id: 9 },
      ]).equipmentId
    ).toBe(4);
    expect(keeperFoldState(before, []).equipmentId).toBeNull();
  });

  it("drops an override naming a member that has left, keeps one naming a stayer", () => {
    const overrides = { duration_min: 3 } as const;
    // b (id 3) is still folded in → its chosen value wins over the keeper's own.
    expect(
      keeperFoldState(before, [{ ...b, duration_min: 99 }], overrides).fields
        .duration_min
    ).toBe(99);
    // b has been restored → it is no longer a member, so the choice resolves to
    // nothing and the keeper's own value stands.
    expect(keeperFoldState(before, [a], overrides).fields.duration_min).toBe(
      30
    );
  });
});
