import { describe, it, expect } from "vitest";
import {
  blankPart,
  partIntent,
  partTotal,
  groupEditSets,
  setComplete,
  type ActivityEditData,
  type PartEntry,
} from "@/components/activity-form/model";

// A stored set with sensible defaults; override only the fields a case cares
// about. Shape mirrors ActivityEditData["sets"][number].
const storedSet = (
  o: Partial<ActivityEditData["sets"][number]> & { set_number: number }
): ActivityEditData["sets"][number] => ({
  exercise: "Bench Press",
  weight_kg: null,
  reps: null,
  weight_kg_right: null,
  reps_right: null,
  duration_sec: null,
  duration_sec_right: null,
  equipment_id: null,
  target_reps: null,
  to_failure: null,
  ...o,
});

const part = (o: Partial<PartEntry>): PartEntry => ({ ...blankPart(), ...o });

describe("partIntent", () => {
  it("applies to a rep-based bilateral part and reads its target", () => {
    expect(partIntent(part({ name: "Bench Press", targetReps: "5" }))).toEqual({
      applies: true,
      target: 5,
      toFailure: false,
    });
  });

  it("drops the numeric target when the part is to-failure (AMRAP)", () => {
    expect(
      partIntent(
        part({ name: "Bench Press", targetReps: "5", toFailure: true })
      )
    ).toEqual({ applies: true, target: null, toFailure: true });
  });

  it("has no target when none is entered", () => {
    expect(partIntent(part({ name: "Bench Press" })).target).toBeNull();
  });

  it("does not apply to a per-side part (intent is inert and nulled)", () => {
    expect(
      partIntent(part({ name: "Bench Press", perSide: true, targetReps: "5" }))
    ).toEqual({ applies: false, target: null, toFailure: false });
  });

  it("does not apply to a timed hold", () => {
    // Plank is a timed lift; a target rep count is meaningless there.
    expect(partIntent(part({ name: "Plank", targetReps: "5" })).applies).toBe(
      false
    );
  });
});

describe("partTotal", () => {
  it("sums weight × reps across sets", () => {
    const p = part({
      sets: [
        { ...blankPart().sets[0], weight: "100", reps: "5" },
        { ...blankPart().sets[0], weight: "100", reps: "3" },
      ],
    });
    expect(partTotal(p)).toBe(800);
  });

  it("adds the right side only when tracking per-side", () => {
    const sets = [
      {
        ...blankPart().sets[0],
        weight: "20",
        reps: "10",
        weightRight: "25",
        repsRight: "10",
      },
    ];
    expect(partTotal(part({ perSide: false, sets }))).toBe(200);
    expect(partTotal(part({ perSide: true, sets }))).toBe(200 + 250);
  });
});

describe("setComplete", () => {
  it("needs both weight and reps for a normal lift", () => {
    const s = { ...blankPart().sets[0], weight: "100" };
    expect(setComplete("Bench Press", s, false)).toBe(false);
    expect(setComplete("Bench Press", { ...s, reps: "5" }, false)).toBe(true);
  });

  it("counts a completed right side on a per-side part", () => {
    const s = {
      ...blankPart().sets[0],
      weightRight: "20",
      repsRight: "8",
    };
    expect(setComplete("Bench Press", s, false)).toBe(false);
    expect(setComplete("Bench Press", s, true)).toBe(true);
  });
});

describe("groupEditSets", () => {
  it("groups stored sets by exercise, ordered by set_number", () => {
    const grouped = groupEditSets(
      [
        storedSet({
          exercise: "Squat",
          set_number: 2,
          weight_kg: 105,
          reps: 5,
        }),
        storedSet({
          exercise: "Squat",
          set_number: 1,
          weight_kg: 100,
          reps: 5,
        }),
        storedSet({
          exercise: "Bench Press",
          set_number: 3,
          weight_kg: 60,
          reps: 8,
        }),
      ],
      "kg"
    );
    expect(grouped.map((g) => g.name)).toEqual(["Squat", "Bench Press"]);
    expect(grouped[0].sets.map((s) => s.weight)).toEqual(["100", "105"]);
    expect(grouped[0].sets.map((s) => s.reps)).toEqual(["5", "5"]);
  });

  it("marks a part per-side when any set carries right-side data", () => {
    const grouped = groupEditSets(
      [
        storedSet({
          set_number: 1,
          weight_kg: 20,
          reps: 10,
          weight_kg_right: 22,
          reps_right: 10,
        }),
      ],
      "kg"
    );
    expect(grouped[0].perSide).toBe(true);
    expect(grouped[0].sets[0].weightRight).toBe("22");
  });

  it("keeps to-failure only when EVERY set is AMRAP", () => {
    const mixed = groupEditSets(
      [
        storedSet({ set_number: 1, weight_kg: 60, reps: 5, to_failure: 1 }),
        storedSet({ set_number: 2, weight_kg: 60, reps: 5, to_failure: null }),
      ],
      "kg"
    );
    expect(mixed[0].toFailure).toBe(false);

    const allAmrap = groupEditSets(
      [
        storedSet({ set_number: 1, weight_kg: 60, reps: 5, to_failure: 1 }),
        storedSet({ set_number: 2, weight_kg: 60, reps: 3, to_failure: 1 }),
      ],
      "kg"
    );
    expect(allAmrap[0].toFailure).toBe(true);
  });

  it("adopts the first declared target rep count it finds", () => {
    const grouped = groupEditSets(
      [
        storedSet({ set_number: 1, weight_kg: 60, reps: 5, target_reps: null }),
        storedSet({ set_number: 2, weight_kg: 60, reps: 5, target_reps: 8 }),
      ],
      "kg"
    );
    expect(grouped[0].targetReps).toBe("8");
  });
});
