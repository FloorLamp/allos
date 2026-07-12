import { describe, it, expect } from "vitest";
import { normalizeWorkoutExtraction } from "@/lib/workout-extract";

// Pure coercion of the model's raw save_workouts output (#420). The extractor now
// carries intensity/start_time/end_time/duration_min + per-set target_reps/to_failure
// and a structural cardio-skipped count; these guards enforce the shapes in code so a
// stray model value can't reach the DB.

describe("normalizeWorkoutExtraction (#420)", () => {
  it("coerces the new session + set fields", () => {
    const { workouts } = normalizeWorkoutExtraction({
      workouts: [
        {
          date: "2026-01-05",
          title: "Push",
          notes: null,
          intensity: "Hard",
          start_time: "18:30",
          end_time: "19:20",
          duration_min: 50,
          sets: [
            {
              exercise: "Bench Press",
              weight: 80,
              weight_unit: "kg",
              reps: 5,
              target_reps: 8,
              to_failure: 1,
            },
          ],
        },
      ],
    });
    expect(workouts).toHaveLength(1);
    const w = workouts[0];
    expect(w.intensity).toBe("hard"); // enum, lower-cased
    expect(w.start_time).toBe("18:30");
    expect(w.end_time).toBe("19:20");
    expect(w.duration_min).toBe(50);
    expect(w.sets[0].target_reps).toBe(8);
    expect(w.sets[0].to_failure).toBe(1);
  });

  it("drops an out-of-enum intensity and non-positive numeric fields", () => {
    const { workouts } = normalizeWorkoutExtraction({
      workouts: [
        {
          intensity: "brutal", // not in the enum
          duration_min: 0, // non-positive → null
          sets: [
            {
              exercise: "Squat",
              reps: 5,
              target_reps: -3, // invalid → null
              to_failure: "no", // → 0
            },
          ],
        },
      ],
    });
    const w = workouts[0];
    expect(w.intensity).toBeNull();
    expect(w.duration_min).toBeNull();
    expect(w.sets[0].target_reps).toBeNull();
    expect(w.sets[0].to_failure).toBe(0);
  });

  it("reports the structural cardio-skipped count, defaulting to 0", () => {
    expect(
      normalizeWorkoutExtraction({ workouts: [], cardio_rows_skipped: 4 })
        .cardioSkipped
    ).toBe(4);
    expect(normalizeWorkoutExtraction({ workouts: [] }).cardioSkipped).toBe(0);
    // A junk / negative count degrades to 0.
    expect(
      normalizeWorkoutExtraction({ workouts: [], cardio_rows_skipped: -2 })
        .cardioSkipped
    ).toBe(0);
  });

  it("maps common to_failure annotations to 1", () => {
    const { workouts } = normalizeWorkoutExtraction({
      workouts: [
        {
          sets: [
            { exercise: "A", reps: 8, to_failure: "AMRAP" },
            { exercise: "B", reps: 8, to_failure: true },
            { exercise: "C", reps: 8, to_failure: "F" },
          ],
        },
      ],
    });
    expect(workouts[0].sets.map((s) => s.to_failure)).toEqual([1, 1, 1]);
  });
});
