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
import { suggestTitle, exerciseHistoryKey } from "@/lib/lifts";
import { trainingSignalKey } from "@/lib/workout-nudge";

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
        target: { id: 42, scope_kind: "region", scope_value: "Chest" },
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

  it("carries the originating target id so the push shares the Upcoming finding key (#245)", () => {
    // The core forwards the behind target's frequency_targets id, and the SAME
    // trainingSignalKey feeds the Upcoming `training:<id>` finding — so the workout
    // nudge can be silenced by a page dismissal (see workout-nudge.test.ts).
    const nw = recommendNextWorkout(fixture);
    expect(nw.behind.map((t) => t.id)).toEqual([42]);
    expect(trainingSignalKey(nw.behind[0].id!)).toBe("training:42");
  });
});

describe("formatWorkoutReminder — deload softening (#741)", () => {
  const base: WorkoutRecommendation = {
    focus: ["Chest"],
    exercises: ["Barbell Bench Press"],
    behind: [],
    rest: null,
    onTrack: null,
  };

  it("adds a deload note when it's the deload week (nudge still fires)", () => {
    const msg = formatWorkoutReminder({ ...base, deloadWeek: true });
    expect(msg).not.toBeNull();
    expect(msg!.body).toContain("Deload week");
    expect(msg!.body).toContain("Suggested: Barbell Bench Press"); // still suggests
  });

  it("adds no deload note off a deload week (byte-for-byte prior copy)", () => {
    const on = formatWorkoutReminder({ ...base, deloadWeek: true });
    const off = formatWorkoutReminder(base);
    expect(off!.body).not.toContain("Deload week");
    expect(on!.body).not.toBe(off!.body);
  });

  it("notes the deload on a rest-day reframe too", () => {
    const msg = formatWorkoutReminder({
      ...base,
      deloadWeek: true,
      rest: { title: "Rest day", detail: "You trained hard yesterday." },
    });
    expect(msg!.body).toContain("Deload week");
  });
});

describe("formatWorkoutReminder — how-to deep link (#734)", () => {
  const rec: WorkoutRecommendation = {
    focus: ["Chest"],
    exercises: ["Barbell Bench Press", "Incline Bench Press"],
    behind: [],
    rest: null,
    onTrack: null,
  };

  it("adds a deep-link button to the lead exercise's guide when a base is given", () => {
    const msg = formatWorkoutReminder(rec, "https://allos.example.com/");
    expect(msg).not.toBeNull();
    const action = msg!.actions?.[0];
    expect(action).toBeDefined();
    // A URL (deep-link) button — no callback token, so it's never consumed on tap.
    expect(action!.data).toBeUndefined();
    expect(action!.url).toBe(
      "https://allos.example.com/training?tab=analyze&kind=strength&exercise=Barbell%20Bench%20Press"
    );
    // Trailing slash on the base is not doubled.
    expect(action!.url).not.toContain("com//training");
  });

  it("omits the button without a public URL (no base) — the existing arity still works", () => {
    const msg = formatWorkoutReminder(rec);
    expect(msg).not.toBeNull();
    expect(msg!.actions).toBeUndefined();
  });

  it("carries the guide button on a rest-day reframe too", () => {
    const restRec: WorkoutRecommendation = {
      ...rec,
      rest: { title: "Rest day", detail: "You trained hard yesterday." },
    };
    const msg = formatWorkoutReminder(restRec, "https://allos.example.com");
    expect(msg!.actions?.[0]?.url).toContain(
      "exercise=Barbell%20Bench%20Press"
    );
  });

  it("omits the button when there is no lead exercise", () => {
    const focusOnly: WorkoutRecommendation = {
      focus: ["Chest"],
      exercises: [],
      behind: [],
      rest: null,
      onTrack: null,
    };
    const msg = formatWorkoutReminder(focusOnly, "https://allos.example.com");
    expect(msg!.actions).toBeUndefined();
  });
});

describe("recommendNextWorkout — divergent merged-lift spellings (#626/#432)", () => {
  // "Curl", "Barbell Curl", "Dumbbell Curl" all collapse to exerciseHistoryKey
  // "curl" under the #331/#432 variant-collapse convention. The aggregate row from
  // getStrengthByExercise keeps the FIRST-SEEN spelling ("Curl"); the recent dated
  // window's frequency-top spelling is a DIFFERENT one ("Barbell Curl"). A raw ===
  // match between them dropped `primary` to null.
  const recentBarbellCurl: DatedExercise[] = [
    dEx("Barbell Curl", "2026-07-01"),
    dEx("Barbell Curl", "2026-06-24"),
    dEx("Barbell Curl", "2026-06-17"),
  ];
  const aggregateFirstSeen = sRec({ exercise: "Curl", lastDate: "2026-07-01" });

  it("no-routine habit path keeps the strength suggestion when spellings diverge", () => {
    const nw = recommendNextWorkout(
      input({
        routine: [],
        strength: [aggregateFirstSeen],
        datedExercises: recentBarbellCurl,
      })
    );
    // Focus is the Arms habit, the lead is the recent spelling, and — the fix —
    // `primary` resolves to the merged aggregate row by canonical identity instead
    // of falling to null (which would have skipped strength and suggested cardio).
    expect(nw.focus).toContain("Arms");
    expect(nw.exercises[0]).toBe("Barbell Curl");
    expect(nw.items[0].kind).toBe("strength");
    expect(nw.primary?.exercise).toBe("Curl");
    expect(nw.items[0].exercise?.exercise).toBe("Curl");
  });

  it("routine-gap strength path seeds the progression from the merged aggregate", () => {
    const nw = recommendNextWorkout(
      input({
        routine: [tgt({ met: false })],
        strength: [aggregateFirstSeen],
        datedExercises: recentBarbellCurl,
      })
    );
    const strengthItem = nw.items.find((i) => i.kind === "strength");
    expect(strengthItem).toBeDefined();
    // The behind-target strength card carries the real aggregate (its next-set seed)
    // rather than a null generic "train this scope".
    expect(strengthItem!.exercise?.exercise).toBe("Curl");
  });

  it("counts merged spellings as ONE exercise in the ranked list (secondary symptom)", () => {
    const nw = recommendNextWorkout(
      input({
        routine: [],
        strength: [aggregateFirstSeen],
        datedExercises: [
          dEx("Barbell Curl", "2026-07-01"),
          dEx("Barbell Curl", "2026-06-24"),
          dEx("Curl", "2026-06-17"),
        ],
      })
    );
    const curlEntries = nw.exercises.filter(
      (e) => exerciseHistoryKey(e) === "curl"
    );
    expect(curlEntries).toHaveLength(1);
  });
});
