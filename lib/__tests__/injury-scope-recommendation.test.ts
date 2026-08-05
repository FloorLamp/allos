import { describe, expect, it } from "vitest";
import {
  recommendNextWorkout,
  type NextWorkoutInput,
} from "@/lib/workout-recommendation";
import { contextNotes, type StrengthRecent } from "@/lib/coaching";
import {
  regionInjuryConstraint,
  RECOVERING_LOAD_FACTOR,
  type InjuryConstraint,
} from "@/lib/injury-model";
import { exerciseHistoryKey } from "@/lib/lifts";

// #2024 — the recommendation engine consumes ONE resolved constraint model, so a precise
// constraint changes exactly the intended output and every affected surface renders the
// same disclosure. These pin the behavior the issue names: a single sore movement must not
// cost the user every recommendation in its coarse region.

const TODAY = "2026-07-08";

function sRec(over: Partial<StrengthRecent> = {}): StrengthRecent {
  return {
    exercise: "Bench Press",
    bodyweight: false,
    lastSessionBest: { weightKg: 100, reps: 5, targetReps: 5, toFailure: false },
    lastDate: "2026-07-01",
    ...over,
  };
}

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return {
    today: TODAY,
    routine: [],
    strength: [
      sRec({ exercise: "Bench Press" }),
      sRec({ exercise: "Cable Fly" }),
      sRec({ exercise: "Squat" }),
    ],
    cardio: [],
    ...over,
  };
}

function exerciseScoped(
  over: Partial<InjuryConstraint> & { exercises: string[] }
): InjuryConstraint {
  return {
    ...regionInjuryConstraint({
      id: 1,
      label: "right shoulder",
      status: "active",
      regions: ["Chest"],
    }),
    scope: "exercise",
    ...over,
  };
}

describe("a precise constraint removes the named lift, not the region", () => {
  const benchOnly = exerciseScoped({
    exercises: [exerciseHistoryKey("Bench Press")],
  });

  it("the named lift is gone and its region-mates stay", () => {
    const nw = recommendNextWorkout(input({ injuries: [benchOnly] }));
    expect(nw.exercises).not.toContain("Bench Press");
    expect(nw.exercises).toContain("Cable Fly");
    expect(nw.exercises).toContain("Squat");
  });

  it("the coarse region is NOT excluded, so nothing else in it disappears", () => {
    const nw = recommendNextWorkout(input({ injuries: [benchOnly] }));
    expect(nw.excludedRegions).toEqual([]);
    expect(nw.focus).toContain("Chest");
  });

  it("the removal is disclosed at the level it was declared", () => {
    const nw = recommendNextWorkout(input({ injuries: [benchOnly] }));
    expect(nw.excludedExercises.map((d) => d.exercise)).toEqual(["Bench Press"]);
    expect(nw.excludedExercises[0].injuryLabels).toEqual(["right shoulder"]);
    expect(contextNotes(nw).join(" ")).toContain("Bench Press");
  });

  it("a whole-region constraint still takes the region — the fallback is intact", () => {
    const whole = regionInjuryConstraint({
      id: 2,
      label: "shoulder",
      status: "active",
      regions: ["Chest"],
    });
    const nw = recommendNextWorkout(input({ injuries: [whole] }));
    expect(nw.exercises).not.toContain("Bench Press");
    expect(nw.exercises).not.toContain("Cable Fly");
    expect(nw.excludedRegions.map((d) => d.region)).toEqual(["Chest"]);
    // …and it does NOT produce a duplicate per-exercise line for the same fact.
    expect(nw.excludedExercises).toEqual([]);
  });
});

describe("a movement-scoped constraint acts on its pattern", () => {
  const pressing: InjuryConstraint = {
    ...regionInjuryConstraint({
      id: 3,
      label: "pressing pain",
      status: "active",
      regions: ["Chest", "Shoulders"],
    }),
    scope: "movement",
    movements: ["push"],
  };

  it("push lifts go, the rest of the recommendation survives", () => {
    const nw = recommendNextWorkout(input({ injuries: [pressing] }));
    expect(nw.exercises).not.toContain("Bench Press");
    expect(nw.exercises).toContain("Squat");
    expect(nw.excludedRegions).toEqual([]);
    expect(nw.excludedExercises.map((d) => d.exercise)).toContain("Bench Press");
  });
});

describe("tempering carries the user's declared factor", () => {
  const easing = (loadFactor: number | null): InjuryConstraint => ({
    ...regionInjuryConstraint({
      id: 4,
      label: "pec strain",
      status: "recovering",
      regions: ["Chest"],
    }),
    scope: "exercise",
    exercises: [exerciseHistoryKey("Bench Press")],
    loadFactor,
  });

  it("with no preference the disclosed fallback fraction applies", () => {
    const nw = recommendNextWorkout(input({ injuries: [easing(null)] }));
    expect(nw.temperedExercises[0]).toMatchObject({
      exercise: "Bench Press",
      factor: RECOVERING_LOAD_FACTOR,
      fallback: true,
    });
    expect(contextNotes(nw).join(" ")).toContain("default");
  });

  it("a declared preference wins and is disclosed as the user's", () => {
    const nw = recommendNextWorkout(input({ injuries: [easing(0.85)] }));
    expect(nw.temperedExercises[0]).toMatchObject({
      factor: 0.85,
      fallback: false,
    });
    expect(contextNotes(nw).join(" ")).toContain("85%");
    expect(contextNotes(nw).join(" ")).toContain("your setting");
  });

  it("a tempered lift is still recommended — tempering is not exclusion", () => {
    const nw = recommendNextWorkout(input({ injuries: [easing(0.85)] }));
    expect(nw.exercises).toContain("Bench Press");
    expect(nw.excludedExercises).toEqual([]);
  });
});

describe("laterality limitations reach the surfaces", () => {
  it("a one-sided constraint on a bilateral lift says the side could not be honored", () => {
    const leftKnee: InjuryConstraint = {
      ...regionInjuryConstraint({
        id: 5,
        label: "left knee",
        status: "recovering",
        regions: ["Legs"],
      }),
      scope: "exercise",
      exercises: [exerciseHistoryKey("Squat")],
      laterality: "left",
    };
    const nw = recommendNextWorkout(input({ injuries: [leftKnee] }));
    expect(nw.temperedExercises[0].limitations.length).toBe(1);
    expect(contextNotes(nw).join(" ")).toContain("both sides");
  });
});

describe("no constraints leaves the model byte-for-byte its prior shape", () => {
  it("every injury field is empty", () => {
    const nw = recommendNextWorkout(input());
    expect(nw.excludedRegions).toEqual([]);
    expect(nw.temperedRegions).toEqual([]);
    expect(nw.excludedExercises).toEqual([]);
    expect(nw.temperedExercises).toEqual([]);
    expect(nw.injuryConstraints).toEqual([]);
    expect(contextNotes(nw)).toEqual([]);
  });
});
