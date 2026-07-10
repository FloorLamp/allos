import { describe, expect, it } from "vitest";
import {
  isIsolation,
  repRangeFor,
  weightIncrementKg,
  weightIncrementLb,
  suggestNextSet,
  sessionBestSet,
  nextSetText,
  lastSessionPR,
  recentPRs,
  speedKmh,
  recentCardioPRs,
  recommendCoaching,
  restRecommendation,
  activeDaysInWindow,
  nextRestEpisode,
  restEpisodeDay,
  withRestContinuity,
  DEFAULT_COACHING_THRESHOLDS,
  type ExerciseSummary,
  type CardioSummary,
  type CoachingInput,
  type RestEpisode,
  type Recommendation,
  type RoutineTargetProgress,
  type StrengthRecent,
  type CardioRecent,
} from "@/lib/coaching";
import { currentStreak } from "@/lib/streak";
import { kgTo, toKg } from "@/lib/units";

// ExerciseSummary factory with sensible defaults; override per test.
function ex(over: Partial<ExerciseSummary> = {}): ExerciseSummary {
  return {
    exercise: "Bench Press",
    sessions: 3,
    bodyweight: false,
    e1rmKg: 100,
    bestWeightKg: 90,
    bestReps: 5,
    bestDate: "2026-06-20",
    topWeightKg: 90,
    topWeightDate: "2026-06-20",
    lastDate: "2026-06-20",
    lastSessionBest: { weightKg: 80, reps: 6 },
    ...over,
  };
}

describe("isIsolation", () => {
  it("treats Arms-region and single-joint movements as isolation", () => {
    expect(isIsolation("Dumbbell Curl")).toBe(true);
    expect(isIsolation("Lateral Raise")).toBe(true);
    expect(isIsolation("Leg Extension")).toBe(true);
  });
  it("treats compounds as not isolation", () => {
    expect(isIsolation("Bench Press")).toBe(false);
    expect(isIsolation("Back Squat")).toBe(false);
  });
});

describe("repRangeFor", () => {
  it("uses 5–8 for compounds, 8–12 for isolation", () => {
    expect(repRangeFor("Bench Press")).toEqual({ low: 5, high: 8 });
    expect(repRangeFor("Dumbbell Curl")).toEqual({ low: 8, high: 12 });
  });
});

describe("weightIncrementKg", () => {
  it("is 5 kg for big lower-body compounds", () => {
    expect(weightIncrementKg("Back Squat")).toBe(5);
    expect(weightIncrementKg("Deadlift")).toBe(5);
    expect(weightIncrementKg("Leg Press")).toBe(5);
  });
  it("is 2.5 kg for upper-body and isolation", () => {
    expect(weightIncrementKg("Bench Press")).toBe(2.5);
    expect(weightIncrementKg("Dumbbell Curl")).toBe(2.5);
    expect(weightIncrementKg("Leg Extension")).toBe(2.5); // isolation wins over Legs
  });
  it("is 5 kg for Legs/Glutes-region lifts the name shortcut misses", () => {
    expect(weightIncrementKg("Lunge")).toBe(5); // Legs region
    expect(weightIncrementKg("Glute Bridge")).toBe(5); // Glutes region
  });
});

describe("weightIncrementLb", () => {
  it("mirrors the kg tiers with native 10/5 lb jumps", () => {
    expect(weightIncrementLb("Back Squat")).toBe(10);
    expect(weightIncrementLb("Bench Press")).toBe(5);
    expect(weightIncrementLb("Dumbbell Curl")).toBe(5);
  });
});

describe("suggestNextSet", () => {
  it("chases one more rep within the range", () => {
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 6 } })
    );
    expect(ns).toMatchObject({ weightKg: 80, reps: 7, bodyweight: false });
  });

  it("adds weight and resets reps at the top of the range", () => {
    // Bench: range 5–8, increment 2.5. 8 reps → +2.5 kg, reset to 5.
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 8 } })
    );
    expect(ns).toMatchObject({ weightKg: 82.5, reps: 5, bodyweight: false });
  });

  it("builds back to the range bottom when below it", () => {
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 3 } })
    );
    expect(ns).toMatchObject({ weightKg: 80, reps: 5, bodyweight: false });
  });

  it("names the weight jump in the user's unit in the rationale", () => {
    // Bench: +2.5 kg jump for kg users, a native +5 lb jump for lb users.
    expect(
      suggestNextSet(ex({ lastSessionBest: { weightKg: 80, reps: 8 } }))!
        .rationale
    ).toContain("add 2.5 kg");
    expect(
      suggestNextSet(ex({ lastSessionBest: { weightKg: 80, reps: 8 } }), "lb")!
        .rationale
    ).toContain("add 5 lb");
  });

  it("targets a multiple of 5 lb when adding weight for an lb user", () => {
    // 175 lb bench × 8 → +5 lb → exactly 180 lb.
    const bench = suggestNextSet(
      ex({ lastSessionBest: { weightKg: toKg(175, "lb"), reps: 8 } }),
      "lb"
    )!;
    expect(kgTo(bench.weightKg, "lb")).toBeCloseTo(180, 6);
    expect(bench.reps).toBe(5);

    // 225 lb squat × 8 → +10 lb → 235 lb.
    const squat = suggestNextSet(
      ex({
        exercise: "Back Squat",
        lastSessionBest: { weightKg: toKg(225, "lb"), reps: 8 },
      }),
      "lb"
    )!;
    expect(kgTo(squat.weightKg, "lb")).toBeCloseTo(235, 6);

    // A kg-entered weight (80 kg ≈ 176.4 lb) still snaps to a multiple of 5:
    // 176.4 + 5 = 181.4 → 180 lb, not 181.9.
    const mixed = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 8 } }),
      "lb"
    )!;
    expect(kgTo(mixed.weightKg, "lb")).toBeCloseTo(180, 6);
  });

  it("progresses bodyweight movements by reps", () => {
    const ns = suggestNextSet(
      ex({
        exercise: "Pull Up",
        bodyweight: true,
        lastSessionBest: { weightKg: 75, reps: 8 },
      })
    );
    expect(ns).toMatchObject({ weightKg: 0, reps: 9, bodyweight: true });
  });

  it("returns null for timed holds and missing history", () => {
    expect(suggestNextSet(ex({ exercise: "Plank" }))).toBeNull();
    expect(suggestNextSet(ex({ lastSessionBest: null }))).toBeNull();
  });

  it("adds weight and keeps the rep target once a declared target is hit", () => {
    // Heavy triple by design: 3 reps is below the heuristic 5–8 range, but the
    // set declared a 3-rep target and hit it → progress, stay at 3.
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 100, reps: 3, targetReps: 3 } })
    )!;
    expect(ns).toMatchObject({ weightKg: 102.5, reps: 3, bodyweight: false });
    expect(ns.rationale).toContain("3-rep target");
  });

  it("holds weight and aims for a declared target that was missed", () => {
    // 3×10 scheme on a compound: 8 reps would trigger the heuristic add-weight
    // branch, but the 10-rep target was missed → hold and build to 10.
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 8, targetReps: 10 } })
    )!;
    expect(ns).toMatchObject({ weightKg: 80, reps: 10, bodyweight: false });
    expect(ns.rationale).toContain("10-rep target");
  });

  it("snaps a target-driven weight jump to a multiple of 5 lb for lb users", () => {
    const ns = suggestNextSet(
      ex({
        lastSessionBest: { weightKg: toKg(175, "lb"), reps: 5, targetReps: 5 },
      }),
      "lb"
    )!;
    expect(kgTo(ns.weightKg, "lb")).toBeCloseTo(180, 6);
    expect(ns.reps).toBe(5);
  });

  it("ignores intent on to-failure sets and falls back to the heuristic", () => {
    // AMRAP that died at 8: its count is an outcome, not a plan, so the
    // heuristic range applies (8 = range top → add weight, reset to 5).
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 8, toFailure: true } })
    )!;
    expect(ns).toMatchObject({ weightKg: 82.5, reps: 5 });
  });

  it("aims a bodyweight movement at a missed rep target", () => {
    const ns = suggestNextSet(
      ex({
        exercise: "Pull Up",
        bodyweight: true,
        lastSessionBest: { weightKg: 75, reps: 6, targetReps: 10 },
      })
    )!;
    expect(ns).toMatchObject({ weightKg: 0, reps: 10, bodyweight: true });
    // Target met → back to beating the achieved count.
    const met = suggestNextSet(
      ex({
        exercise: "Pull Up",
        bodyweight: true,
        lastSessionBest: { weightKg: 75, reps: 10, targetReps: 10 },
      })
    )!;
    expect(met).toMatchObject({ weightKg: 0, reps: 11, bodyweight: true });
  });

  it("carries a declared target on the suggestion, null for heuristics", () => {
    // Target-driven suggestions expose the target so a logger can re-declare
    // it (keeping the scheme going); heuristic ones declare nothing.
    expect(
      suggestNextSet(
        ex({ lastSessionBest: { weightKg: 100, reps: 3, targetReps: 3 } })
      )!.targetReps
    ).toBe(3);
    expect(
      suggestNextSet(
        ex({ lastSessionBest: { weightKg: 80, reps: 8, targetReps: 10 } })
      )!.targetReps
    ).toBe(10);
    expect(
      suggestNextSet(ex({ lastSessionBest: { weightKg: 80, reps: 6 } }))!
        .targetReps
    ).toBeNull();
    expect(
      suggestNextSet(
        ex({ lastSessionBest: { weightKg: 80, reps: 8, toFailure: true } })
      )!.targetReps
    ).toBeNull();
  });
});

// A RecentSession-shaped set with everything null unless overridden.
function set(
  over: Partial<Parameters<typeof sessionBestSet>[0][number]> = {}
): Parameters<typeof sessionBestSet>[0][number] {
  return {
    weight_kg: null,
    reps: null,
    weight_kg_right: null,
    reps_right: null,
    ...over,
  };
}

describe("sessionBestSet", () => {
  it("picks the set with the highest estimated 1RM", () => {
    const best = sessionBestSet([
      set({ weight_kg: 100, reps: 5 }), // e1RM ≈ 116.7
      set({ weight_kg: 110, reps: 3 }), // e1RM = 121 ← best
      set({ weight_kg: 60, reps: 12 }),
    ]);
    expect(best).toMatchObject({ weightKg: 110, reps: 3 });
  });

  it("breaks ties by reps (bodyweight sets all estimate to the base)", () => {
    const best = sessionBestSet([
      set({ reps: 8 }),
      set({ reps: 11 }),
      set({ reps: 9 }),
    ]);
    expect(best).toMatchObject({ weightKg: 0, reps: 11 });
  });

  it("treats each side of a per-side set as its own candidate", () => {
    const best = sessionBestSet([
      set({ weight_kg: 20, reps: 8, weight_kg_right: 25, reps_right: 8 }),
    ]);
    expect(best).toMatchObject({ weightKg: 25, reps: 8 });
    // A right side with reps but no logged weight is still a (base-load) candidate.
    expect(sessionBestSet([set({ reps_right: 10 })])).toMatchObject({
      weightKg: 0,
      reps: 10,
    });
  });

  it("carries the chosen set's declared intent", () => {
    const best = sessionBestSet([
      set({ weight_kg: 100, reps: 5, target_reps: 5 }),
      set({ weight_kg: 80, reps: 10, to_failure: 1 }),
    ]);
    expect(best).toMatchObject({ weightKg: 100, reps: 5, targetReps: 5 });
    expect(best!.toFailure).toBe(false);
  });

  it("folds a bodyweight base into the load and ignores rep-less sets", () => {
    // Weighted pull-ups: with an 80 kg base, +20×5 (e1RM 116.7) beats +10×8
    // (e1RM 114) — the unweighted ranking would flip that.
    const best = sessionBestSet(
      [set({ weight_kg: 10, reps: 8 }), set({ weight_kg: 20, reps: 5 })],
      80
    );
    expect(best).toMatchObject({ weightKg: 100, reps: 5 });
    // No usable (rep-bearing) sets → no seed.
    expect(sessionBestSet([set({ weight_kg: 50 })])).toBeNull();
  });
});

describe("nextSetText", () => {
  it("formats weighted suggestions in the user's unit and bodyweight as BW", () => {
    const ns = suggestNextSet(
      ex({ lastSessionBest: { weightKg: 80, reps: 6 } })
    )!;
    expect(nextSetText(ns, "kg")).toBe("80 kg × 7");
    const bw = suggestNextSet(
      ex({
        exercise: "Pull Up",
        bodyweight: true,
        lastSessionBest: { weightKg: 75, reps: 12 },
      })
    )!;
    expect(nextSetText(bw, "kg")).toBe("BW × 13");
  });
});

describe("lastSessionPR", () => {
  it("flags a fresh 1RM when the best is on the most recent date", () => {
    expect(
      lastSessionPR(ex({ bestDate: "2026-06-20", lastDate: "2026-06-20" }))
    ).toEqual({
      e1rm: true,
      weight: true,
    });
  });

  it("never flags a single-session exercise", () => {
    expect(lastSessionPR(ex({ sessions: 1 }))).toEqual({
      e1rm: false,
      weight: false,
    });
  });

  it("suppresses the weight PR for bodyweight lifts", () => {
    const pr = lastSessionPR(
      ex({ bodyweight: true, bestDate: "2026-06-20", lastDate: "2026-06-20" })
    );
    expect(pr).toEqual({ e1rm: true, weight: false });
  });
});

describe("recentPRs", () => {
  const today = "2026-06-29";
  const stats: ExerciseSummary[] = [
    ex({
      exercise: "Bench Press",
      sessions: 3,
      bestDate: "2026-06-20",
      topWeightKg: 100,
      topWeightDate: "2026-06-25",
    }),
    ex({ exercise: "Row", sessions: 1, bestDate: "2026-06-28" }), // first-ever — excluded
    ex({
      exercise: "Old Lift",
      sessions: 2,
      bestDate: "2026-01-01",
      topWeightDate: "2026-01-01",
    }), // stale
    ex({
      exercise: "Pull Up",
      sessions: 2,
      bodyweight: true,
      bestDate: "2026-06-28",
      topWeightKg: 0,
    }),
  ];

  it("includes both 1RM and top-weight PRs, newest first, with exclusions", () => {
    const prs = recentPRs(stats, today, 30);
    expect(prs.map((p) => `${p.exercise}:${p.kind}:${p.date}`)).toEqual([
      "Pull Up:1rm:2026-06-28",
      "Bench Press:weight:2026-06-25",
      "Bench Press:1rm:2026-06-20",
    ]);
  });

  it("flags the bodyweight PR so it renders as BW, not an absolute weight", () => {
    const prs = recentPRs(stats, today, 30);
    expect(prs.find((p) => p.exercise === "Pull Up")?.bodyweight).toBe(true);
    expect(
      prs.find((p) => p.exercise === "Bench Press" && p.kind === "1rm")
        ?.bodyweight
    ).toBe(false);
  });

  it("respects the window", () => {
    // 3-day window: only Pull Up's 1RM (06-28) qualifies; Bench's 06-25/06-20 fall outside.
    expect(recentPRs(stats, today, 3)).toEqual([
      expect.objectContaining({ exercise: "Pull Up", kind: "1rm" }),
    ]);
  });

  it("excludes records with unparseable dates instead of throwing", () => {
    expect(
      recentPRs(
        [ex({ sessions: 3, bestDate: "garbage", topWeightDate: "garbage" })],
        today,
        30
      )
    ).toEqual([]);
  });

  it("keeps same-day records adjacent (sort tie)", () => {
    const prs = recentPRs(
      [
        ex({
          exercise: "Bench Press",
          bestDate: "2026-06-28",
          topWeightDate: "2026-06-28",
        }),
        ex({
          exercise: "Row",
          bestDate: "2026-06-28",
          topWeightDate: "2026-06-28",
        }),
      ],
      today,
      30
    );
    expect(prs.map((p) => p.exercise)).toEqual(["Bench Press", "Row"]);
  });
});

describe("speedKmh", () => {
  it("computes km/h", () => {
    expect(speedKmh(10, 30)).toBe(20); // 10 km in 30 min
  });
  it("returns null without a usable distance and duration", () => {
    expect(speedKmh(0, 30)).toBeNull();
    expect(speedKmh(10, 0)).toBeNull();
    expect(speedKmh(null, 30)).toBeNull();
    expect(speedKmh(10, -5)).toBeNull();
  });
});

describe("recentCardioPRs", () => {
  const today = "2026-06-29";
  function cardio(over: Partial<CardioSummary> = {}): CardioSummary {
    return {
      activity: "Running",
      sessions: 3,
      hasDistance: true,
      longestDistanceKm: 10,
      longestDistanceDate: "2026-06-27",
      fastestKmh: 12,
      fastestKmhDate: "2026-06-26",
      longestDurationMin: 60,
      longestDurationDate: "2026-06-20",
      ...over,
    };
  }

  it("emits distance, speed, and duration PRs for a distance activity", () => {
    const prs = recentCardioPRs([cardio()], today, 30);
    expect(prs.map((p) => `${p.kind}:${p.date}`)).toEqual([
      "distance:2026-06-27",
      "speed:2026-06-26",
      "duration:2026-06-20",
    ]);
  });

  it("emits only a duration PR when there's no distance", () => {
    const prs = recentCardioPRs(
      [
        cardio({
          activity: "HIIT",
          hasDistance: false,
          longestDurationDate: "2026-06-28",
        }),
      ],
      today,
      30
    );
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ activity: "HIIT", kind: "duration" });
  });

  it("excludes first-ever sessions and out-of-window records", () => {
    expect(recentCardioPRs([cardio({ sessions: 1 })], today, 30)).toEqual([]);
    expect(recentCardioPRs([cardio()], today, 1)).toEqual([]); // nearest record is 2 days ago
  });
});

// ---- Rule-based coaching engine ----

const TODAY = "2026-07-08";

function input(over: Partial<CoachingInput> = {}): CoachingInput {
  return {
    today: TODAY,
    routine: [],
    strength: [],
    cardio: [],
    trainingDates: [],
    sleep: null,
    restingHr: null,
    weightUnit: "kg",
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

// N consecutive dates ending at (and including) `end`, newest first.
function consecutiveDates(end: string, n: number): string[] {
  const out: string[] = [];
  const [y, m, d] = end.split("-").map(Number);
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

describe("activeDaysInWindow", () => {
  it("counts distinct days inside the trailing window (inclusive of today)", () => {
    const dates = ["2026-07-08", "2026-07-06", "2026-07-02", "2026-07-01"];
    expect(activeDaysInWindow(dates, TODAY, 7)).toBe(3); // 07-01 is 7 days ago → excluded
  });
});

describe("restRecommendation", () => {
  const th = DEFAULT_COACHING_THRESHOLDS;

  it("fires on sleep below the baseline deficit and names the reason", () => {
    // baseline 10h, deficit 90m → threshold 510m; 510 fires (<=), well above floor.
    const rest = restRecommendation(
      input({ sleep: { lastNightMin: 510, baselineMin: 600 } }),
      th
    );
    expect(rest?.kind).toBe("rest");
    expect(rest?.id).toBe("rest-sleep");
    expect(rest?.tone).toBe("caution");
    expect(rest?.detail).toContain("8.5h");
    expect(rest?.detail).toContain("10.0h");
    expect(rest?.target).toBeUndefined();
    expect(rest?.actionHref).toBeUndefined();
  });

  it("does not fire one minute above the sleep deficit threshold", () => {
    expect(
      restRecommendation(
        input({ sleep: { lastNightMin: 511, baselineMin: 600 } }),
        th
      )
    ).toBeNull();
  });

  it("fires on sleep below the absolute floor even with a modest baseline", () => {
    const rest = restRecommendation(
      input({ sleep: { lastNightMin: 359, baselineMin: 400 } }),
      th
    );
    expect(rest?.id).toBe("rest-sleep");
    expect(rest?.detail).toContain("6.0h");
  });

  it("never fires on sleep when there is no sleep data", () => {
    expect(restRecommendation(input({ sleep: null }), th)).toBeNull();
  });

  it("fires on elevated resting HR at/above the jump, not below", () => {
    expect(
      restRecommendation(input({ restingHr: { recent: 62, baseline: 55 } }), th)
        ?.id
    ).toBe("rest-rhr");
    expect(
      restRecommendation(input({ restingHr: { recent: 61, baseline: 55 } }), th)
    ).toBeNull();
  });

  it("widens the sleep deficit for a variable sleeper (variance-aware)", () => {
    // Fixed deficit 90m fires at <=510m. With a personal spread of 60m the
    // effective deficit becomes 2×60=120m (>90), so the same 510m night — a
    // normal off-night for a noisy sleeper — no longer trips a rest nudge.
    expect(
      restRecommendation(
        input({
          sleep: { lastNightMin: 510, baselineMin: 600, baselineSpreadMin: 60 },
        }),
        th
      )
    ).toBeNull();
    // A genuinely short night (below baseline − 2×spread = 480m) still fires.
    expect(
      restRecommendation(
        input({
          sleep: { lastNightMin: 480, baselineMin: 600, baselineSpreadMin: 60 },
        }),
        th
      )?.id
    ).toBe("rest-sleep");
  });

  it("keeps the fixed sleep deficit when the spread is small (backward compatible)", () => {
    // 2×30=60 < the fixed 90m floor, so the threshold stays at 90m and the 510m
    // night fires exactly as it does with no spread supplied.
    expect(
      restRecommendation(
        input({
          sleep: { lastNightMin: 510, baselineMin: 600, baselineSpreadMin: 30 },
        }),
        th
      )?.id
    ).toBe("rest-sleep");
  });

  it("widens the resting-HR jump for a variable baseline (variance-aware)", () => {
    // Fixed jump 7 fires at >=62. Spread 5 → effective jump max(7, 2×5)=10, so a
    // +7 bump (recent 62) no longer fires but a +10 bump (recent 65) does.
    expect(
      restRecommendation(
        input({
          restingHr: { recent: 62, baseline: 55, baselineSpreadBpm: 5 },
        }),
        th
      )
    ).toBeNull();
    expect(
      restRecommendation(
        input({
          restingHr: { recent: 65, baseline: 55, baselineSpreadBpm: 5 },
        }),
        th
      )?.id
    ).toBe("rest-rhr");
  });

  it("fires on a consecutive-day streak at the threshold", () => {
    const rest = restRecommendation(
      input({ trainingDates: consecutiveDates(TODAY, 4) }),
      th
    );
    expect(rest?.id).toBe("rest-overtraining");
    expect(rest?.detail).toContain("4 days in a row");
  });

  // Anti-drift pin (#222): the overtraining nudge and the dashboard StreakWidget
  // must read the SAME consecutive-day count. Coaching now calls currentStreak
  // (the widget's source) directly, so prove they agree on the same fixture — if
  // one ever forks, the number in the nudge copy stops matching currentStreak.
  it("counts the streak the same way the dashboard widget does (currentStreak)", () => {
    const dates = consecutiveDates(TODAY, 5);
    const widgetStreak = currentStreak(TODAY, dates); // StreakWidget's source
    const rest = restRecommendation(input({ trainingDates: dates }), th);
    expect(rest?.id).toBe("rest-overtraining");
    expect(rest?.detail).toContain(`${widgetStreak} days in a row`);
    expect(widgetStreak).toBe(5);
  });

  it("fires on a heavy trailing window without a long streak", () => {
    // 6 of the last 7 days, but no 4-in-a-row (today then gaps).
    const dates = [
      "2026-07-08",
      "2026-07-06",
      "2026-07-05",
      "2026-07-04",
      "2026-07-03",
      "2026-07-02",
    ];
    const rest = restRecommendation(input({ trainingDates: dates }), th);
    expect(rest?.id).toBe("rest-load");
    expect(rest?.detail).toContain("6 of the last 7");
  });

  it("stays quiet with light training and no recovery data", () => {
    expect(
      restRecommendation(input({ trainingDates: ["2026-07-08"] }), th)
    ).toBeNull();
  });
});

describe("recommendCoaching", () => {
  it("returns a friendly empty state when there is no data at all", () => {
    const [top, ...rest] = recommendCoaching(input());
    expect(rest).toHaveLength(0);
    expect(top.kind).toBe("setup");
    expect(top.actionHref).toBe("/training");
  });

  it("adds a cardio session when behind a cardio target", () => {
    const [top] = recommendCoaching(
      input({
        routine: [
          tgt({
            target: { scope_kind: "type", scope_value: "cardio" },
            count: 0,
            per_week: 2,
          }),
        ],
      })
    );
    expect(top.kind).toBe("cardio");
    expect(top.title).toBe("Add a cardio session");
    expect(top.detail).toContain("0 of 2");
  });

  it("suggests a strength lift with a next-set target when behind", () => {
    const [top] = recommendCoaching(
      input({
        routine: [tgt()], // type=strength, 0 of 3
        strength: [sRec()],
      })
    );
    expect(top.kind).toBe("strength");
    expect(top.title).toBe("Train Bench Press");
    expect(top.target).toMatch(/×/);
    expect(top.actionHref).toContain("kind=strength");
  });

  it("falls back to a generic strength nudge when no exercise matches", () => {
    const [top] = recommendCoaching(input({ routine: [tgt()], strength: [] }));
    expect(top.kind).toBe("strength");
    expect(top.title).toBe("Train Strength");
    expect(top.target).toBeUndefined();
  });

  it("ranks the cardio gap ahead of the strength gap", () => {
    const recs = recommendCoaching(
      input({
        routine: [
          tgt({
            target: { scope_kind: "type", scope_value: "cardio" },
            count: 0,
            per_week: 2,
          }),
          tgt(), // strength, 0 of 3
        ],
        strength: [sRec()],
      })
    );
    expect(recs.map((r) => r.kind)).toEqual(["cardio", "strength"]);
  });

  it("celebrates being on track when every target is met", () => {
    const [top, ...rest] = recommendCoaching(
      input({ routine: [tgt({ count: 3, met: true })] })
    );
    expect(top.kind).toBe("ontrack");
    expect(rest).toHaveLength(0);
  });

  it("lets a recovery signal override and demote the training nudge", () => {
    const recs = recommendCoaching(
      input({
        routine: [
          tgt({
            target: { scope_kind: "type", scope_value: "cardio" },
            count: 0,
            per_week: 2,
          }),
        ],
        sleep: { lastNightMin: 300, baselineMin: 445 },
      })
    );
    expect(recs[0].kind).toBe("rest");
    expect(recs[1].kind).toBe("cardio"); // kept as secondary
  });

  it("drops the redundant on-track note when a rest signal fires", () => {
    const recs = recommendCoaching(
      input({
        routine: [tgt({ count: 3, met: true })],
        restingHr: { recent: 70, baseline: 55 },
      })
    );
    expect(recs).toHaveLength(1);
    expect(recs[0].kind).toBe("rest");
  });

  it("uses habit history when there is no routine set", () => {
    const [top] = recommendCoaching(
      input({ strength: [sRec({ lastDate: "2026-06-01" })] })
    );
    expect(top.kind).toBe("strength");
    expect(top.detail).toContain("Last trained");
  });

  it("recognizes training already logged today (no routine)", () => {
    const [top] = recommendCoaching(
      input({
        strength: [sRec({ lastDate: TODAY })],
        trainingDates: [TODAY],
      })
    );
    expect(top.kind).toBe("ontrack");
    expect(top.title).toBe("Nice work today");
  });

  it("suggests a cardio activity when only cardio history exists (no routine)", () => {
    const [top] = recommendCoaching(
      input({ cardio: [cRec({ activity: "Cycling", lastDate: "2026-06-20" })] })
    );
    expect(top.kind).toBe("cardio");
    expect(top.title).toBe("Add a Cycling session");
  });

  it("works without any recovery data — routine rules still fire", () => {
    const [top] = recommendCoaching(
      input({
        routine: [tgt()],
        strength: [sRec()],
        sleep: null,
        restingHr: null,
      })
    );
    expect(top.kind).toBe("strength");
  });

  it("does not fire rest when recovery signals are within normal range", () => {
    const recs = recommendCoaching(
      input({
        routine: [tgt()],
        strength: [sRec()],
        sleep: { lastNightMin: 450, baselineMin: 460 },
        restingHr: { recent: 55, baseline: 54 },
        trainingDates: ["2026-07-08"],
      })
    );
    expect(recs[0].kind).toBe("strength");
  });

  it("honors overridden thresholds", () => {
    // Tighten the RHR jump so a small elevation now triggers rest.
    const recs = recommendCoaching(
      input({
        strength: [sRec()],
        restingHr: { recent: 57, baseline: 55 },
        thresholds: { restingHrJumpBpm: 2 },
      })
    );
    expect(recs[0].kind).toBe("rest");
  });
});

describe("recommendCoaching variety lookback (#185)", () => {
  // Regression: a single ancient one-off type (an imported 2015 kayak) used to
  // permanently win the "least-recently-done" slot, so a routine cardio nudge
  // read "Last done 11 years ago" even after cardio yesterday. The variety pick
  // is now bounded to a recent window and the copy names the activity.
  const ancient = { lastDate: "2015-06-01" };

  it("names the recent cardio type, not an ancient one-off, when behind a cardio target", () => {
    const [top] = recommendCoaching(
      input({
        routine: [
          tgt({
            target: { scope_kind: "type", scope_value: "cardio" },
            count: 1,
            per_week: 3,
          }),
        ],
        cardio: [
          cRec({ activity: "Running", lastDate: "2026-07-07" }), // yesterday
          cRec({ activity: "Kayaking", ...ancient }), // ancient one-off
        ],
      })
    );
    expect(top.kind).toBe("cardio");
    expect(top.detail).toContain("Running — last done");
    expect(top.detail).not.toContain("Kayaking");
    expect(top.detail).not.toContain("years ago");
    expect(top.actionHref).toContain("Running");
  });

  it("drops the stale suggestion entirely when every cardio type is ancient", () => {
    const [top] = recommendCoaching(
      input({
        routine: [
          tgt({
            target: { scope_kind: "type", scope_value: "cardio" },
            count: 0,
            per_week: 2,
          }),
        ],
        cardio: [cRec({ activity: "Kayaking", ...ancient })],
      })
    );
    expect(top.kind).toBe("cardio");
    expect(top.title).toBe("Add a cardio session");
    expect(top.detail).not.toContain("Kayaking");
    expect(top.detail).not.toContain("years ago");
    expect(top.actionLabel).toBe("Log activity");
  });

  it("does not pick an ancient lift for a behind strength target", () => {
    const [top] = recommendCoaching(
      input({
        routine: [tgt()], // type=strength, 0 of 3
        strength: [
          sRec({ exercise: "Back Squat", lastDate: "2026-07-05" }),
          sRec({ exercise: "Overhead Press", ...ancient }),
        ],
      })
    );
    expect(top.kind).toBe("strength");
    expect(top.title).toBe("Train Back Squat");
  });

  it("suggests the recent habit, not an ancient one-off cardio (no routine)", () => {
    const [top] = recommendCoaching(
      input({
        cardio: [
          cRec({ activity: "Cycling", lastDate: "2026-06-20" }), // ~3 weeks ago
          cRec({ activity: "Kayaking", ...ancient }),
        ],
      })
    );
    expect(top.kind).toBe("cardio");
    expect(top.title).toBe("Add a Cycling session");
  });

  it("suggests the recent habit, not an ancient one-off lift (no routine)", () => {
    const [top] = recommendCoaching(
      input({
        strength: [
          sRec({ exercise: "Bench Press", lastDate: "2026-06-25" }),
          sRec({ exercise: "Overhead Press", ...ancient }),
        ],
      })
    );
    expect(top.kind).toBe("strength");
    expect(top.title).toBe("Train Bench Press");
  });
});

// ---- Rest-episode continuity (#44 item 3b) ----

const YESTERDAY = "2026-07-07";

// A rest recommendation stand-in for the pure episode helpers.
function restRec(id = "rest-sleep"): Recommendation {
  return {
    id,
    kind: "rest",
    title: "Rest or take it easy today",
    detail: "You slept 5.0h last night — consider a rest or light day.",
    tone: "caution",
  };
}

function episode(over: Partial<RestEpisode> = {}): RestEpisode {
  return {
    startDate: YESTERDAY,
    lastDate: YESTERDAY,
    reasonId: "rest-sleep",
    ...over,
  };
}

describe("nextRestEpisode", () => {
  it("opens a fresh episode when a rest rec fires with no prior marker", () => {
    expect(nextRestEpisode(null, restRec(), TODAY)).toEqual({
      startDate: TODAY,
      lastDate: TODAY,
      reasonId: "rest-sleep",
    });
  });

  it("continues an episode last seen yesterday (consecutive day)", () => {
    const next = nextRestEpisode(episode(), restRec(), TODAY);
    expect(next).toEqual({
      startDate: YESTERDAY, // start carried forward
      lastDate: TODAY, // advanced to today
      reasonId: "rest-sleep",
    });
  });

  it("is idempotent when already reconciled today", () => {
    const already = episode({ startDate: YESTERDAY, lastDate: TODAY });
    expect(nextRestEpisode(already, restRec(), TODAY)).toEqual(already);
  });

  it("carries the start across a shifted reason (still one condition)", () => {
    const next = nextRestEpisode(episode(), restRec("rest-rhr"), TODAY);
    expect(next).toEqual({
      startDate: YESTERDAY,
      lastDate: TODAY,
      reasonId: "rest-rhr", // latest reason recorded
    });
  });

  it("opens a fresh episode after a gap (prior run not seen yesterday)", () => {
    const stale = episode({ startDate: "2026-07-01", lastDate: "2026-07-05" });
    expect(nextRestEpisode(stale, restRec(), TODAY)).toEqual({
      startDate: TODAY,
      lastDate: TODAY,
      reasonId: "rest-sleep",
    });
  });

  it("clears the episode when no rest rec fires", () => {
    expect(nextRestEpisode(episode(), null, TODAY)).toBeNull();
    const strength: Recommendation = {
      id: "strength-x",
      kind: "strength",
      title: "Train X",
      detail: "",
      tone: "action",
    };
    expect(nextRestEpisode(episode(), strength, TODAY)).toBeNull();
  });
});

describe("restEpisodeDay", () => {
  it("is day 1 on the start date", () => {
    expect(restEpisodeDay(episode({ startDate: TODAY }), TODAY)).toBe(1);
  });
  it("counts consecutive days from the start (1-based)", () => {
    expect(restEpisodeDay(episode({ startDate: YESTERDAY }), TODAY)).toBe(2);
    expect(restEpisodeDay(episode({ startDate: "2026-07-05" }), TODAY)).toBe(4);
  });
  it("clamps a future/garbled start to at least day 1", () => {
    expect(restEpisodeDay(episode({ startDate: "2026-07-20" }), TODAY)).toBe(1);
  });
});

describe("withRestContinuity", () => {
  it("re-titles as the ordinal easy day and keeps id/kind/tone", () => {
    const cont = withRestContinuity(restRec(), 2);
    expect(cont.title).toBe("Second easy day");
    expect(cont.id).toBe("rest-sleep"); // snooze dedup unchanged
    expect(cont.kind).toBe("rest");
    expect(cont.tone).toBe("caution");
    expect(cont.detail).toContain("second easy day in a row");
    // The underlying reason is preserved, not discarded.
    expect(cont.detail).toContain("slept 5.0h");
  });
  it("phrases day 3+ with the matching ordinal", () => {
    expect(withRestContinuity(restRec(), 3).title).toBe("Third easy day");
    expect(withRestContinuity(restRec(), 4).title).toBe("Fourth easy day");
  });
  it("falls back to Nth past the word table", () => {
    expect(withRestContinuity(restRec(), 12).title).toBe("12th easy day");
  });
});

describe("recommendCoaching rest continuity", () => {
  // A short night that clears the absolute floor → a fresh rest-sleep nudge.
  const poorSleep = { lastNightMin: 300, baselineMin: 300 };
  // A minimal training context so the engine evaluates recovery (rest is only
  // considered once there's any activity/routine to coach against).
  const ctx = { strength: [sRec()] };

  it("phrases a fresh rest nudge normally without an episode", () => {
    const [top] = recommendCoaching(input({ ...ctx, sleep: poorSleep }));
    expect(top.kind).toBe("rest");
    expect(top.title).toBe("Rest or take it easy today");
  });

  it("phrases a rest nudge as a continuing day when the episode continues", () => {
    const [top] = recommendCoaching(
      input({
        ...ctx,
        sleep: poorSleep,
        restEpisode: episode({ startDate: YESTERDAY, lastDate: YESTERDAY }),
      })
    );
    expect(top.kind).toBe("rest");
    expect(top.title).toBe("Second easy day");
    expect(top.detail).toContain("second easy day in a row");
  });

  it("does not apply continuity to a stale (gapped) episode", () => {
    const [top] = recommendCoaching(
      input({
        ...ctx,
        sleep: poorSleep,
        restEpisode: episode({
          startDate: "2026-07-01",
          lastDate: "2026-07-04",
        }),
      })
    );
    expect(top.title).toBe("Rest or take it easy today");
  });
});
