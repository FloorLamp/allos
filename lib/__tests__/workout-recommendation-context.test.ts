import { describe, expect, it } from "vitest";
import {
  recommendNextWorkout,
  type NextWorkoutInput,
} from "@/lib/workout-recommendation";
import {
  recommendCoaching,
  type CoachingInput,
  type StrengthRecent,
  type RoutineTargetProgress,
} from "@/lib/coaching";
import type { InjuryConstraint } from "@/lib/injury-model";
import type { ConditionConsideration } from "@/lib/condition-training-considerations";

const TODAY = "2026-07-08";

function sRec(over: Partial<StrengthRecent> = {}): StrengthRecent {
  return {
    exercise: "Bench Press",
    bodyweight: false,
    lastSessionBest: {
      weightKg: 100,
      reps: 5,
      targetReps: 5,
      toFailure: false,
    },
    lastDate: "2026-07-01",
    ...over,
  };
}

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return {
    today: TODAY,
    routine: [],
    strength: [sRec({ exercise: "Bench Press" }), sRec({ exercise: "Squat" })],
    cardio: [],
    ...over,
  };
}

const shoulderInjury: InjuryConstraint = {
  id: 1,
  label: "right shoulder",
  status: "active",
  regions: ["Chest", "Shoulders"],
};

describe("recommendNextWorkout — active-injury exclusion (#838)", () => {
  it("excludes an active injury's region from focus/exercises and NAMES why", () => {
    const nw = recommendNextWorkout(input({ injuries: [shoulderInjury] }));
    // Chest (Bench Press) is off the table; Legs (Squat) survives.
    expect(nw.focus).not.toContain("Chest");
    expect(nw.exercises).not.toContain("Bench Press");
    expect(nw.exercises).toContain("Squat");
    expect(nw.primary?.exercise).toBe("Squat");
    // Disclosure present — never silent.
    expect(nw.excludedRegions.map((d) => d.region)).toEqual([
      "Chest",
      "Shoulders",
    ]);
    expect(nw.excludedRegions[0].injuryLabels).toEqual(["right shoulder"]);
  });

  it("leaves an unaffected region's recommendation unchanged", () => {
    const base = recommendNextWorkout(input());
    const withInjury = recommendNextWorkout(
      input({ injuries: [{ ...shoulderInjury, regions: ["Chest"] }] })
    );
    // A leg fixture is untouched by a chest injury.
    expect(withInjury.exercises).toContain("Squat");
    expect(base.exercises).toContain("Squat");
  });

  it("drops a fully-excluded region behind-target from the nag set", () => {
    const chestTarget: RoutineTargetProgress = {
      target: { id: 7, scope_kind: "region", scope_value: "Chest" },
      count: 0,
      per_week: 2,
      met: false,
    };
    const legTarget: RoutineTargetProgress = {
      target: { id: 8, scope_kind: "region", scope_value: "Legs" },
      count: 0,
      per_week: 2,
      met: false,
    };
    const nw = recommendNextWorkout(
      input({
        routine: [chestTarget, legTarget],
        injuries: [{ ...shoulderInjury, regions: ["Chest"] }],
      })
    );
    // "Behind on chest" is silenced while the region is out; "behind on legs" stays.
    expect(nw.behind.map((b) => b.scopeValue)).toEqual(["Legs"]);
  });

  it("has empty context fields with no injuries/conditions (byte-for-byte prior shape)", () => {
    const nw = recommendNextWorkout(input());
    expect(nw.excludedRegions).toEqual([]);
    expect(nw.temperedRegions).toEqual([]);
    expect(nw.considerations).toEqual([]);
    expect(nw.substitutionSuggested).toBe(false);
  });
});

describe("recommendNextWorkout — recovering tempering markers (#838)", () => {
  it("marks the recovering region as tempered (not excluded)", () => {
    const nw = recommendNextWorkout(
      input({
        injuries: [
          { ...shoulderInjury, status: "recovering", regions: ["Chest"] },
        ],
      })
    );
    expect(nw.temperedRegions).toContain("Chest");
    expect(nw.excludedRegions).toEqual([]);
    // The region still returns — Bench Press is a candidate again.
    expect(nw.exercises).toContain("Bench Press");
  });
});

describe("recommendNextWorkout — condition considerations ride alongside (#666)", () => {
  const osteoNote: ConditionConsideration = {
    key: "osteoporosis",
    conditionLabel: "Osteoporosis",
    note: "You have osteoporosis on file — favor controlled progressive loading.",
    source: "NIH NIAMS",
  };

  it("passes the note through UNCHANGED without gating or re-ranking", () => {
    const base = recommendNextWorkout(input());
    const withNote = recommendNextWorkout(
      input({ considerations: [osteoNote] })
    );
    // The recommendation itself is identical — the note rides alongside.
    expect(withNote.exercises).toEqual(base.exercises);
    expect(withNote.primary?.exercise).toBe(base.primary?.exercise);
    expect(withNote.considerations).toEqual([osteoNote]);
    // No region is excluded by a condition.
    expect(withNote.excludedRegions).toEqual([]);
  });
});

describe("recommendCoaching — context notes on the card (#666/#838, one computation)", () => {
  function ci(over: Partial<CoachingInput> = {}): CoachingInput {
    return {
      today: TODAY,
      routine: [],
      strength: [
        sRec({ exercise: "Bench Press" }),
        sRec({ exercise: "Squat" }),
      ],
      cardio: [],
      trainingDates: ["2026-07-01"],
      sleep: null,
      restingHr: null,
      ...over,
    };
  }

  it("attaches the exclusion disclosure + condition note to the lead rec", () => {
    const [top] = recommendCoaching(
      ci({
        injuries: [{ ...shoulderInjury, regions: ["Chest"] }],
        considerations: [
          {
            key: "osteoporosis",
            conditionLabel: "Osteoporosis",
            note: "Favor controlled progressive loading.",
            source: "NIH NIAMS",
          },
        ],
      })
    );
    expect(top.notes ?? []).toContain("Avoiding Chest (right shoulder injury)");
    expect(top.notes ?? []).toContain("Favor controlled progressive loading.");
  });

  it("tempers the recovering region's suggested set below the plain target", () => {
    const plain = recommendCoaching(ci())[0];
    const tempered = recommendCoaching(
      ci({
        injuries: [
          {
            id: 1,
            label: "chest strain",
            status: "recovering",
            regions: ["Chest"],
          },
        ],
      })
    )[0];
    // Both recommend Bench Press (the lead); the tempered target is lighter.
    expect(plain.target).toBeTruthy();
    expect(tempered.target).toBeTruthy();
    const num = (s: string | undefined) =>
      Number((s ?? "").match(/[\d.]+/)?.[0] ?? "0");
    expect(num(tempered.target)).toBeLessThan(num(plain.target));
  });
});
