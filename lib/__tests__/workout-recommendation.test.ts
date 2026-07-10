import { describe, expect, it } from "vitest";
import {
  recommendNextWorkout,
  pickOldestCardio,
  VARIETY_LOOKBACK_DAYS,
  WORKOUT_LOOKBACK_DAYS,
  type NextWorkoutInput,
  type DatedExercise,
} from "@/lib/workout-recommendation";
import {
  recommendCoaching,
  type CoachingInput,
  type StrengthRecent,
  type CardioRecent,
  type RoutineTargetProgress,
} from "@/lib/coaching";
import {
  formatWorkoutReminder,
  type WorkoutRecommendation,
} from "@/lib/notifications/workout-format";
import { suggestTitle } from "@/lib/lifts";

// A Wednesday, so the weekday-habit dates below (all Wednesdays) line up.
const TODAY = "2026-07-08";

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return {
    today: TODAY,
    routine: [],
    strength: [],
    cardio: [],
    ...over,
  };
}

function tgt(over: Partial<RoutineTargetProgress> = {}): RoutineTargetProgress {
  return {
    target: { scope_kind: "type", scope_value: "strength" },
    count: 0,
    per_week: 3,
    met: false,
    ...over,
  };
}

function sRec(over: Partial<StrengthRecent> = {}): StrengthRecent {
  return {
    exercise: "Bench Press",
    bodyweight: false,
    lastSessionBest: {
      weightKg: 60,
      reps: 5,
      targetReps: null,
      toFailure: false,
    },
    lastDate: "2026-07-01",
    ...over,
  };
}

function cRec(over: Partial<CardioRecent> = {}): CardioRecent {
  return { activity: "Running", lastDate: "2026-07-01", ...over };
}

// A dated exercise row; defaults to a recent Wednesday within the window.
function dEx(exercise: string, date: string): DatedExercise {
  return { exercise, date };
}

describe("pickOldestCardio (#185 practiced-activity picker)", () => {
  it("excludes an ancient one-off and keeps the recent activity", () => {
    const pick = pickOldestCardio(
      [
        cRec({ activity: "Running", lastDate: "2026-07-07" }),
        cRec({ activity: "Kayaking", lastDate: "2015-06-01" }),
      ],
      TODAY
    );
    expect(pick?.activity).toBe("Running");
  });

  it("returns null when every activity is beyond the variety window", () => {
    expect(
      pickOldestCardio(
        [cRec({ activity: "Kayaking", lastDate: "2015-06-01" })],
        TODAY
      )
    ).toBeNull();
  });

  it("picks the least-recently-done, stable by name on a tie", () => {
    const pick = pickOldestCardio(
      [
        cRec({ activity: "Rowing", lastDate: "2026-07-01" }),
        cRec({ activity: "Cycling", lastDate: "2026-07-01" }),
      ],
      TODAY
    );
    expect(pick?.activity).toBe("Cycling");
  });
});

describe("recommendNextWorkout — aggregate fallback (no dated history)", () => {
  it("picks the least-recent qualifying lift for a behind strength target", () => {
    const nw = recommendNextWorkout(
      input({
        routine: [tgt()],
        strength: [
          sRec({ exercise: "Back Squat", lastDate: "2026-07-05" }),
          sRec({ exercise: "Overhead Press", lastDate: "2015-06-01" }), // ancient
        ],
      })
    );
    expect(nw.items[0].kind).toBe("strength");
    expect(nw.primary?.exercise).toBe("Back Squat");
    expect(nw.exercises[0]).toBe("Back Squat");
  });

  it("emits a setup item with no usable history", () => {
    const nw = recommendNextWorkout(input({ routine: [] }));
    expect(nw.items).toHaveLength(1);
    expect(nw.items[0].kind).toBe("setup");
  });
});

describe("recommendNextWorkout — dated history (bounded window, recovery, habit)", () => {
  // Three recent Wednesdays of Chest work (Bench Press) — a clear weekday habit.
  const chestHabit: DatedExercise[] = [
    dEx("Bench Press", "2026-07-01"),
    dEx("Bench Press", "2026-06-24"),
    dEx("Bench Press", "2026-06-17"),
  ];

  it("uses the weekday habit to choose the focus region", () => {
    const nw = recommendNextWorkout(
      input({ strength: [sRec()], datedExercises: chestHabit })
    );
    expect(nw.focus).toContain("Chest");
    expect(nw.exercises[0]).toBe("Bench Press");
  });

  it("excludes a region trained yesterday (recovery)", () => {
    // Add a Chest session yesterday → Chest is on recovery, so it drops out of
    // the focus even though it's the weekday habit; the fallback finds nothing
    // else, so there's no strength region to emphasize.
    const nw = recommendNextWorkout(
      input({
        strength: [sRec()],
        datedExercises: [...chestHabit, dEx("Bench Press", "2026-07-07")],
      })
    );
    expect(nw.focus).not.toContain("Chest");
  });

  it("ignores dated rows beyond the bounded window", () => {
    // A single ancient Chest row (well past WORKOUT_LOOKBACK_DAYS) is not a habit.
    const ancient = "2020-01-01";
    const nw = recommendNextWorkout(
      input({
        strength: [sRec({ lastDate: ancient })],
        datedExercises: [dEx("Bench Press", ancient)],
      })
    );
    // Nothing within the window → no dated focus; falls back to the aggregate
    // path, which also drops the ancient lift (beyond the variety window).
    expect(nw.focus).toHaveLength(0);
    expect(nw.exercises).toHaveLength(0);
  });

  it("keeps the window constants ordered (variety ⊇ workout)", () => {
    expect(WORKOUT_LOOKBACK_DAYS).toBeLessThanOrEqual(VARIETY_LOOKBACK_DAYS);
  });
});

describe("recommendCoaching gains recovery exclusion + weekday habit (#221)", () => {
  const chestHabit: DatedExercise[] = [
    dEx("Bench Press", "2026-07-01"),
    dEx("Bench Press", "2026-06-24"),
    dEx("Bench Press", "2026-06-17"),
  ];

  function ci(over: Partial<CoachingInput> = {}): CoachingInput {
    return {
      today: TODAY,
      routine: [],
      strength: [sRec()],
      cardio: [],
      trainingDates: [],
      sleep: null,
      restingHr: null,
      weightUnit: "kg",
      ...over,
    };
  }

  it("carries the shared focus/exercises onto the dashboard strength card", () => {
    const recs = recommendCoaching(ci({ datedExercises: chestHabit }));
    const strengthRec = recs.find((r) => r.kind === "strength");
    expect(strengthRec?.focus).toContain("Chest");
    expect(strengthRec?.exercises?.[0]).toBe("Bench Press");
    expect(strengthRec?.title).toBe("Train Bench Press");
  });
});

// The heart of #221: one fixture, three surfaces, one recommendation.
describe("cross-surface consistency (#221)", () => {
  // Behind a Chest strength target, with a Chest weekday habit — every surface
  // should agree on the focus region and the lead exercise.
  const fixture: CoachingInput = {
    today: TODAY,
    routine: [
      {
        target: { scope_kind: "region", scope_value: "Chest" },
        count: 0,
        per_week: 2,
        met: false,
      },
    ],
    strength: [sRec({ exercise: "Bench Press", lastDate: "2026-07-01" })],
    cardio: [],
    trainingDates: ["2026-07-01"],
    sleep: null,
    restingHr: null,
    weightUnit: "kg",
    datedExercises: [
      dEx("Bench Press", "2026-07-01"),
      dEx("Bench Press", "2026-06-24"),
      dEx("Bench Press", "2026-06-17"),
    ],
  };

  it("agrees on focus + lead exercise across the core, dashboard, and Telegram", () => {
    // 1) The unified core — the single source of truth.
    const nw = recommendNextWorkout(fixture);
    expect(nw.focus).toEqual(["Chest"]);
    expect(nw.exercises[0]).toBe("Bench Press");
    expect(nw.primary?.exercise).toBe("Bench Press");

    // 2) Dashboard + Training overview: recommendCoaching formats the same core.
    const recs = recommendCoaching(fixture);
    const strengthRec = recs.find((r) => r.kind === "strength");
    expect(strengthRec).toBeDefined();
    expect(strengthRec!.focus).toEqual(nw.focus);
    expect(strengthRec!.exercises).toEqual(nw.exercises);
    expect(strengthRec!.title).toBe(`Train ${nw.exercises[0]}`);

    // 3) Telegram: recommendWorkout maps the same core result verbatim
    // ({ focus: nw.focus, exercises: nw.exercises }); drive the pure formatter
    // with exactly that shape.
    const wr: WorkoutRecommendation = {
      focus: nw.focus,
      exercises: nw.exercises,
      behind: [],
      rest: null,
      onTrack: null,
    };
    const msg = formatWorkoutReminder(wr);
    expect(msg).not.toBeNull();
    expect(msg!.title).toContain(suggestTitle(nw.exercises));
    expect(msg!.body).toContain(nw.exercises[0]);

    // All three surfaces resolved to the identical focus + lead exercise.
    expect(strengthRec!.exercises![0]).toBe(nw.exercises[0]);
    expect(wr.exercises[0]).toBe(nw.exercises[0]);
  });
});
