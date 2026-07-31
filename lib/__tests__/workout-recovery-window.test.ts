import { describe, expect, it } from "vitest";
import {
  LARGE_REGION_RECOVERY_DAYS,
  SMALL_REGION_RECOVERY_DAYS,
  recommendNextWorkout,
  recoveryOverrideLine,
  regionRecoveryDays,
  type DatedExercise,
  type NextWorkoutInput,
} from "@/lib/workout-recommendation";
import {
  ALL_FRESH_REST_ID,
  allFreshRestRec,
  canAcknowledgeRest,
  contextNotes,
  recommendCoaching,
  type CoachingInput,
  type RoutineTargetProgress,
  type StrengthRecent,
} from "@/lib/coaching";
import { formatWorkoutReminder } from "@/lib/notifications/workout-format";

// #1673 — the focus ignored training recency across the week boundary. Week starts
// Sunday; push Friday, pull Saturday, rest Sunday. On Monday every region reads 0/N
// because the week just reset, and the old one-day-deep recovery exclusion could only
// see Sunday (a rest day), so the nudge recommended BACK — trained ~36 hours earlier —
// over LEGS, a week stale. These fixtures pin BOTH mechanisms: the rolling per-region
// recovery windows that cross ranking tiers, and least-recently-trained-first ordering
// inside them.

const FRIDAY = "2026-07-24";
const SATURDAY = "2026-07-25";
const MONDAY = "2026-07-27"; // today in every fixture below
const LAST_MONDAY = "2026-07-20"; // legs, a week stale
const PRIOR_MONDAY = "2026-07-13";

function dEx(exercise: string, date: string): DatedExercise {
  return { exercise, date };
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
    lastDate: FRIDAY,
    ...over,
  };
}

// A behind region target with the week's pace attached. `daysLeft` is the on-days
// remaining AFTER today — 5 on a Monday of a Sunday-start week, which is a LOOSE week.
function regionTarget(
  scopeValue: string,
  over: Partial<RoutineTargetProgress> = {},
  daysLeft = 5
): RoutineTargetProgress {
  return {
    target: { scope_kind: "region", scope_value: scopeValue },
    count: 0,
    per_week: 2,
    met: false,
    daysLeftInWindow: daysLeft,
    ...over,
  };
}

// An unscoped "strength 3×/week" target: it names no region, so every region with
// history stays a candidate and the tier ordering — not the scope — decides.
function strengthTarget(daysLeft = 5): RoutineTargetProgress {
  return {
    target: { scope_kind: "type", scope_value: "strength" },
    count: 0,
    per_week: 3,
    met: false,
    daysLeftInWindow: daysLeft,
  };
}

function input(over: Partial<NextWorkoutInput> = {}): NextWorkoutInput {
  return { today: MONDAY, routine: [], strength: [], cardio: [], ...over };
}

describe("per-region recovery windows (#1673 decision 2)", () => {
  it("gives the large groups a longer window than the small ones", () => {
    expect(regionRecoveryDays("Back")).toBe(LARGE_REGION_RECOVERY_DAYS);
    expect(regionRecoveryDays("Legs")).toBe(LARGE_REGION_RECOVERY_DAYS);
    expect(regionRecoveryDays("Chest")).toBe(LARGE_REGION_RECOVERY_DAYS);
    expect(regionRecoveryDays("Arms")).toBe(SMALL_REGION_RECOVERY_DAYS);
    expect(regionRecoveryDays("Shoulders")).toBe(SMALL_REGION_RECOVERY_DAYS);
    expect(regionRecoveryDays("Core")).toBe(SMALL_REGION_RECOVERY_DAYS);
    expect(SMALL_REGION_RECOVERY_DAYS).toBeLessThan(LARGE_REGION_RECOVERY_DAYS);
  });
});

describe("the reported week-boundary case (#1673)", () => {
  // Push Friday (Chest), pull Saturday (Back), rest Sunday, legs a week ago.
  const history: DatedExercise[] = [
    dEx("Bench Press", FRIDAY),
    dEx("Barbell Row", SATURDAY),
    dEx("Back Squat", LAST_MONDAY),
  ];
  const routine = [regionTarget("Back"), regionTarget("Legs")];

  const fixture = input({
    routine,
    strength: [
      sRec({ exercise: "Barbell Row", lastDate: SATURDAY }),
      sRec({ exercise: "Back Squat", lastDate: LAST_MONDAY }),
    ],
    datedExercises: history,
  });

  it("recommends legs on Monday, not the back trained Saturday", () => {
    const nw = recommendNextWorkout(fixture);
    expect(nw.focus[0]).toBe("Legs");
    expect(nw.focus).not.toContain("Back");
  });

  it("drives the suggestion from the legs target, not the alphabetically-first back one", () => {
    const nw = recommendNextWorkout(fixture);
    expect(nw.items[0].target?.scopeValue).toBe("Legs");
    expect(nw.recovery.allFresh).toBe(false);
    expect(nw.recovery.override).toBeNull();
  });

  it("holds back inside its 2-day window on Monday", () => {
    // The same Saturday pull session, with back as the ONLY behind target so the window
    // itself is what answers: two days is one banked rest day, short of back's two.
    const nw = recommendNextWorkout({
      ...fixture,
      routine: [regionTarget("Back")],
    });
    expect(nw.recovery.resting).toEqual([
      {
        region: "Back",
        lastDate: SATURDAY,
        daysSince: 2,
        windowDays: LARGE_REGION_RECOVERY_DAYS,
      },
    ]);
    expect(nw.focus).toHaveLength(0);
    expect(nw.recovery.allFresh).toBe(true);
  });

  it("still prefers legs when only the RECENCY ordering can decide", () => {
    // Same week, but back's session was three days ago — outside its window, so the
    // hard exclusion is silent and the ordering alone has to carry the decision.
    const nw = recommendNextWorkout({
      ...fixture,
      datedExercises: [
        dEx("Bench Press", FRIDAY),
        dEx("Barbell Row", "2026-07-24"),
        dEx("Back Squat", LAST_MONDAY),
      ],
    });
    expect(nw.recovery.resting).toHaveLength(0);
    expect(nw.focus[0]).toBe("Legs");
  });
});

describe("habit collision — the window has to cross tiers (#1673)", () => {
  // Back is BOTH behind and the usual Monday region (two prior Mondays), so it sits in
  // the highest ranking tier and wins on ordering alone. Only the hard recovery-window
  // exclusion can demote it.
  const history: DatedExercise[] = [
    dEx("Barbell Row", SATURDAY), // 2 days ago — inside Back's window
    dEx("Barbell Row", LAST_MONDAY),
    dEx("Barbell Row", PRIOR_MONDAY),
    dEx("Back Squat", "2026-07-15"), // legs, 12 days stale
  ];

  it("excludes the fresh weekday habit and leads with the stale region", () => {
    // An unscoped strength target, so nothing narrows the candidates: back reaches the
    // focus ranking in the HIGHEST tier (the weekday habit) and would win on ordering
    // alone. Only the hard window demotes it, and legs takes the slot from the fallback.
    const nw = recommendNextWorkout(
      input({
        routine: [strengthTarget()],
        strength: [
          sRec({ exercise: "Barbell Row", lastDate: SATURDAY }),
          sRec({ exercise: "Back Squat", lastDate: "2026-07-15" }),
        ],
        datedExercises: history,
      })
    );
    expect(nw.focus[0]).toBe("Legs");
    expect(nw.focus).not.toContain("Back");
    expect(nw.recovery.resting.map((r) => r.region)).toEqual(["Back"]);
  });
});

describe("all-fresh corner → rest reframe (#1673 decision 3)", () => {
  // Upper-only targets, push Friday + pull Saturday, evaluated the SUNDAY in between —
  // every candidate region is inside its window, so there is nothing to suggest.
  const sunday = "2026-07-26";
  const upperOnly: CoachingInput = {
    today: sunday,
    routine: [regionTarget("Chest", {}, 6), regionTarget("Back", {}, 6)],
    strength: [
      sRec({ exercise: "Bench Press", lastDate: FRIDAY }),
      sRec({ exercise: "Barbell Row", lastDate: SATURDAY }),
    ],
    cardio: [],
    trainingDates: [FRIDAY, SATURDAY],
    sleep: null,
    restingHr: null,
    weightUnit: "kg",
    datedExercises: [dEx("Bench Press", FRIDAY), dEx("Barbell Row", SATURDAY)],
  };

  it("reports all-fresh instead of forcing a pick", () => {
    const nw = recommendNextWorkout(upperOnly);
    expect(nw.focus).toHaveLength(0);
    expect(nw.recovery.allFresh).toBe(true);
    // Neither upper target has a trainable region, so the scope settles on the staler
    // one and its resting region is what the reframe discloses.
    expect(nw.recovery.resting.map((r) => r.region)).toEqual(["Chest"]);
  });

  it("routes through the rest framing on every surface", () => {
    const recs = recommendCoaching(upperOnly);
    expect(recs[0].kind).toBe("rest");
    expect(recs[0].id).toBe(ALL_FRESH_REST_ID);
    expect(recs[0].detail).toContain("still fresh");
    // A scheduling reframe, not an under-recovery signal: nothing to acknowledge.
    expect(canAcknowledgeRest(recs[0])).toBe(false);

    // The Telegram nudge reframes off the same rest slot.
    const msg = formatWorkoutReminder({
      focus: [],
      exercises: [],
      behind: [],
      rest: { title: recs[0].title, detail: recs[0].detail },
      onTrack: null,
    });
    expect(msg!.title).toContain(recs[0].title);
  });

  it("resumes the normal recommendation the day a window opens", () => {
    // Monday: back has banked its rest days, chest longer still — the slot is no longer
    // a rest reframe and the staler chest leads.
    const monday = { ...upperOnly, today: MONDAY };
    const nw = recommendNextWorkout(monday);
    expect(nw.recovery.allFresh).toBe(false);
    expect(nw.focus[0]).toBe("Chest");
    expect(allFreshRestRec(nw)).toBeNull();
    expect(recommendCoaching(monday)[0].kind).toBe("strength");
  });
});

describe("tight week overrides the window, with acknowledgment (#1673 decision 4)", () => {
  // Back 1/2 with NO on-days left after today: the target cannot be met without this
  // session, so pace wins over back's still-open recovery window.
  const history = [dEx("Barbell Row", SATURDAY)];
  const strength = [sRec({ exercise: "Barbell Row", lastDate: SATURDAY })];

  function week(daysLeft: number): CoachingInput {
    return {
      today: MONDAY,
      routine: [regionTarget("Back", { count: 1 }, daysLeft)],
      strength,
      cardio: [],
      trainingDates: [SATURDAY],
      sleep: null,
      restingHr: null,
      weightUnit: "kg",
      datedExercises: history,
    };
  }

  it("fires for back anyway and names both facts", () => {
    const nw = recommendNextWorkout(week(0));
    expect(nw.focus).toEqual(["Back"]);
    expect(nw.recovery.allFresh).toBe(false);
    expect(nw.recovery.override).toMatchObject({
      region: "Back",
      lastDate: SATURDAY,
      daysSince: 2,
      daysLeftInWindow: 0,
    });
    const line = recoveryOverrideLine(nw.recovery.override!);
    expect(line).toContain("Saturday");
    expect(line).toContain("1/2");
    expect(line).toContain("today left");
    // The same line reaches the dashboard/overview cards as a context note.
    expect(contextNotes(nw)).toContain(line);
  });

  it("the SAME fixture on a loose week yields the rest note instead", () => {
    const nw = recommendNextWorkout(week(4));
    expect(nw.focus).toHaveLength(0);
    expect(nw.recovery.override).toBeNull();
    expect(nw.recovery.allFresh).toBe(true);
    expect(recommendCoaching(week(4))[0].id).toBe(ALL_FRESH_REST_ID);
  });

  it("the Telegram nudge carries the acknowledgment line", () => {
    const nw = recommendNextWorkout(week(0));
    const msg = formatWorkoutReminder({
      focus: nw.focus,
      exercises: nw.exercises,
      behind: [],
      rest: null,
      onTrack: null,
      recoveryOverride: recoveryOverrideLine(nw.recovery.override!),
    });
    expect(msg!.body).toContain("Back was Saturday");
  });
});

describe("boundary cases (#1673)", () => {
  it("a region trained window-many rest days ago is eligible again", () => {
    // Back trained three days ago has banked two full rest days — ON the boundary, so a
    // rotation that revisits a region every third day never trips the window.
    const nw = recommendNextWorkout(
      input({
        routine: [regionTarget("Back")],
        strength: [sRec({ exercise: "Barbell Row", lastDate: FRIDAY })],
        datedExercises: [dEx("Barbell Row", FRIDAY)],
      })
    );
    expect(nw.recovery.resting).toHaveLength(0);
    expect(nw.focus).toEqual(["Back"]);
  });

  it("keeps the small-group window one day deep", () => {
    // Arms trained two days ago is eligible (a large group would not be); trained
    // yesterday it is not — the original one-day rule, unchanged.
    const eligible = recommendNextWorkout(
      input({
        routine: [regionTarget("Arms")],
        strength: [sRec({ exercise: "Barbell Curl", lastDate: SATURDAY })],
        datedExercises: [dEx("Barbell Curl", SATURDAY)],
      })
    );
    expect(eligible.focus).toEqual(["Arms"]);

    const resting = recommendNextWorkout(
      input({
        routine: [regionTarget("Arms")],
        strength: [sRec({ exercise: "Barbell Curl", lastDate: "2026-07-26" })],
        datedExercises: [dEx("Barbell Curl", "2026-07-26")],
      })
    );
    expect(resting.focus).toHaveLength(0);
    expect(resting.recovery.resting.map((r) => r.region)).toEqual(["Arms"]);
  });

  it("orders by the weekday habit WITHIN the eligible candidates", () => {
    // An unscoped strength target, so both regions are candidates. Chest and Legs are
    // both out of their windows and Chest is the usual Monday region, so the habit tier
    // still decides between them.
    const nw = recommendNextWorkout(
      input({
        routine: [strengthTarget()],
        strength: [
          sRec({ exercise: "Bench Press", lastDate: LAST_MONDAY }),
          sRec({ exercise: "Back Squat", lastDate: LAST_MONDAY }),
        ],
        datedExercises: [
          dEx("Bench Press", LAST_MONDAY),
          dEx("Bench Press", PRIOR_MONDAY),
          dEx("Back Squat", LAST_MONDAY),
        ],
      })
    );
    expect(nw.focus[0]).toBe("Chest");
  });

  it("orders least-recently-trained first inside one behind tier", () => {
    // One unscoped strength target, three regions with history and no weekday habit:
    // the tier is ranked purely by recency, staler first, and the region inside its
    // window drops out entirely.
    const nw = recommendNextWorkout(
      input({
        routine: [strengthTarget()],
        strength: [
          sRec({ exercise: "Barbell Row", lastDate: SATURDAY }),
          sRec({ exercise: "Overhead Press", lastDate: "2026-07-22" }),
          sRec({ exercise: "Back Squat", lastDate: "2026-07-15" }),
        ],
        datedExercises: [
          dEx("Barbell Row", SATURDAY), // Back — inside its 2-day window
          dEx("Overhead Press", "2026-07-22"), // Shoulders — 5 days
          dEx("Back Squat", "2026-07-15"), // Legs — 12 days
        ],
      })
    );
    expect(nw.focus).toEqual(["Legs", "Shoulders"]);
  });
});
