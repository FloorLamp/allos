import { describe, expect, it } from "vitest";
import {
  recapWindow,
  resolveRecapWindow,
  inWindow,
  weightTrendKg,
  buildWeeklyRecap,
  renderRecapMessage,
  medianWeeklyWorkouts,
  type RecapInput,
} from "@/lib/weekly-recap";
import { recentPRs, type ExerciseSummary } from "@/lib/coaching";

const TODAY = "2026-07-09"; // a Thursday

// A fully-populated baseline input; individual tests override the fields they
// exercise.
function baseInput(over: Partial<RecapInput> = {}): RecapInput {
  return {
    today: TODAY,
    weightUnit: "kg",
    workouts: [],
    prevWorkouts: [],
    volumeKg: 0,
    prevVolumeKg: 0,
    prLabels: [],
    adherence: null,
    weights: [],
    streak: 0,
    strictStreak: 0,
    goalsCompleted: [],
    ...over,
  };
}

describe("recapWindow", () => {
  it("is a trailing seven days ending on today, with a prior seven-day window", () => {
    expect(recapWindow(TODAY)).toEqual({
      start: "2026-07-03",
      end: "2026-07-09",
      prevStart: "2026-06-26",
      prevEnd: "2026-07-02",
    });
  });

  it("windows are contiguous and non-overlapping", () => {
    const w = recapWindow(TODAY);
    // prevEnd is the day immediately before start.
    expect(w.prevEnd < w.start).toBe(true);
    expect(inWindow(w.prevEnd, w.start, w.end)).toBe(false);
    expect(inWindow(w.start, w.start, w.end)).toBe(true);
    expect(inWindow(w.end, w.start, w.end)).toBe(true);
  });
});

// Issue #223: the weekly recap honors the profile's week_mode so its window lines
// up with the routine counters / journal week summary (both derive from
// lib/week-window). resolveRecapWindow is the shared resolver; buildWeeklyRecap's
// {start, end} must follow it. TODAY is a Thursday.
describe("recap honors week_mode (issue #223)", () => {
  const MONDAY = 1;

  it("rolling mode keeps the trailing-seven window (backward compatible)", () => {
    expect(resolveRecapWindow(TODAY, 7, "rolling")).toEqual(recapWindow(TODAY));
    const recap = buildWeeklyRecap(baseInput({ weekMode: "rolling" }));
    expect(recap.start).toBe("2026-07-03");
    expect(recap.end).toBe(TODAY);
  });

  it("calendar mode covers the current week-start day through today", () => {
    // Week starts Monday 2026-07-06; today (Thu 07-09) → partial Mon–Thu window.
    const recap = buildWeeklyRecap(
      baseInput({ weekMode: "calendar", weekStart: MONDAY })
    );
    expect(recap.start).toBe("2026-07-06");
    expect(recap.end).toBe(TODAY);
  });

  it("defaults to the trailing window when no week_mode is supplied", () => {
    const recap = buildWeeklyRecap(baseInput());
    expect(recap.start).toBe("2026-07-03");
    expect(recap.end).toBe(TODAY);
  });
});

describe("weightTrendKg", () => {
  it("returns null for fewer than two readings", () => {
    expect(weightTrendKg([])).toBeNull();
    expect(weightTrendKg([{ date: "2026-07-03", weightKg: 74 }])).toBeNull();
  });

  it("is a robust net change (median endpoints) resistant to one outlier", () => {
    // Steady 74 → 73 descent with a single spurious 99 spike that a raw
    // first/last diff would ignore but a mean would not; median endpoints ignore it.
    const w = [
      { date: "2026-07-03", weightKg: 74 },
      { date: "2026-07-04", weightKg: 73.8 },
      { date: "2026-07-05", weightKg: 99 }, // outlier
      { date: "2026-07-06", weightKg: 73.4 },
      { date: "2026-07-07", weightKg: 73.2 },
      { date: "2026-07-08", weightKg: 73.0 },
    ];
    const trend = weightTrendKg(w)!;
    expect(trend).toBeLessThan(0); // net loss despite the spike
    expect(trend).toBeGreaterThan(-2); // and not wildly distorted
  });
});

describe("buildWeeklyRecap", () => {
  it("summarizes workouts with a type breakdown and prior-week comparison", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        workouts: [
          { date: "2026-07-04", type: "strength" },
          { date: "2026-07-06", type: "strength" },
          { date: "2026-07-08", type: "cardio" },
        ],
        prevWorkouts: [{ date: "2026-06-30", type: "strength" }],
      })
    );
    const line = recap.lines.find((l) => l.key === "workouts")!;
    expect(line.value).toBe("3 (strength 2, cardio 1)");
    expect(line.delta).toBe("1 last week");
    expect(recap.headline).toContain("3 workouts");
    expect(recap.isEmpty).toBe(false);
  });

  it("surfaces a sleep-regularity line with the weekend shift (#160)", () => {
    const recap = buildWeeklyRecap(baseInput({ sri: 82, socialJetlagMin: 78 }));
    const line = recap.lines.find((l) => l.key === "sleepRegularity")!;
    expect(line.value).toBe("82/100");
    expect(line.delta).toBe("1.3h weekend shift");
  });

  it("omits the sleep-regularity line when SRI is null (#160)", () => {
    const recap = buildWeeklyRecap(baseInput({ sri: null }));
    expect(
      recap.lines.find((l) => l.key === "sleepRegularity")
    ).toBeUndefined();
  });

  it("reports a volume delta versus the previous window", () => {
    const recap = buildWeeklyRecap(
      baseInput({ volumeKg: 11000, prevVolumeKg: 10000 })
    );
    const line = recap.lines.find((l) => l.key === "volume")!;
    expect(line.value).toBe("11,000 kg");
    expect(line.delta).toBe("+10%");
  });

  it("omits the volume delta when there was no prior volume", () => {
    const recap = buildWeeklyRecap(baseInput({ volumeKg: 5000 }));
    const line = recap.lines.find((l) => l.key === "volume")!;
    expect(line.delta).toBeUndefined();
  });

  it("lists PRs, truncating past three with a +N more", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        prLabels: ["Bench press", "Squat", "Deadlift", "Overhead press"],
      })
    );
    const line = recap.lines.find((l) => l.key === "prs")!;
    expect(line.value).toBe("4");
    expect(line.delta).toBe("Bench press, Squat, Deadlift +1 more");
    expect(recap.headline).toContain("4 PRs");
  });

  it("computes adherence percentage from taken/due", () => {
    const recap = buildWeeklyRecap(
      baseInput({ adherence: { taken: 12, skipped: 0, due: 14 } })
    );
    const line = recap.lines.find((l) => l.key === "adherence")!;
    expect(line.value).toBe("86%");
    expect(line.delta).toBe("12/14 doses");
  });

  it("shows the latest weight and a robust net change with a direction arrow", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        weights: [
          { date: "2026-07-03", weightKg: 74 },
          { date: "2026-07-06", weightKg: 73.5 },
          { date: "2026-07-08", weightKg: 73 },
        ],
      })
    );
    const line = recap.lines.find((l) => l.key === "weight")!;
    expect(line.value).toBe("73 kg");
    expect(line.delta).toContain("−"); // net loss over the window
    expect(line.delta).toContain("kg");
  });

  it("reports streak status with the strict consecutive count as context", () => {
    const recap = buildWeeklyRecap(baseInput({ streak: 12, strictStreak: 4 }));
    const line = recap.lines.find((l) => l.key === "streak")!;
    expect(line.value).toBe("12 active days");
    expect(line.delta).toBe("4-day consecutive");
  });

  it("marks a week with no workouts, adherence, or weight as empty", () => {
    const recap = buildWeeklyRecap(baseInput());
    expect(recap.isEmpty).toBe(true);
    expect(recap.lines).toEqual([]);
  });

  it("is not empty when only a weigh-in was logged", () => {
    const recap = buildWeeklyRecap(
      baseInput({ weights: [{ date: "2026-07-08", weightKg: 73 }] })
    );
    expect(recap.isEmpty).toBe(false);
  });
});

describe("renderRecapMessage", () => {
  it("returns null for an empty recap (nothing worth interrupting for)", () => {
    const recap = buildWeeklyRecap(baseInput());
    expect(renderRecapMessage(recap, "Ada")).toBeNull();
  });

  it("renders a titled, profile-named, bulleted message", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        workouts: [{ date: "2026-07-08", type: "strength" }],
        adherence: { taken: 7, skipped: 0, due: 7 },
      })
    );
    const msg = renderRecapMessage(recap, "Ada")!;
    expect(msg.title).toBe("📊 Weekly recap — Ada");
    expect(msg.body).toContain("2026-07-03 – 2026-07-09");
    expect(msg.body).toContain("• Workouts: 1");
    expect(msg.body).toContain("• Adherence: 100%");
  });
});

// Issue #190: gatherRecapInput passes `days - 1` into recentPRs/recentCardioPRs
// because those helpers' `within` is INCLUSIVE at both ends. For a 7-day weekly
// recap the PR window must be the same [today-6, today] the workout window uses —
// a PR dated exactly today-7 belongs to the PREVIOUS week (its workout lands in
// prevWorkouts), so it must NOT surface in this week's PR labels. Otherwise the
// recap can read "0 workouts this week, 1 PR". Mirrors the gather-layer boundary.
describe("recap PR window off-by-one (issue #190)", () => {
  // TODAY is 2026-07-09; exactly seven calendar days earlier is 2026-07-02, the
  // last day of the *previous* recap window (recapWindow(TODAY).prevEnd).
  const TODAY_MINUS_7 = "2026-07-02";

  function summary(bestDate: string): ExerciseSummary {
    return {
      exercise: "Bench press",
      sessions: 2, // >1 so it isn't a first-ever log
      bodyweight: false,
      e1rmKg: 100,
      bestWeightKg: 90,
      bestReps: 5,
      bestDate,
      topWeightKg: 90,
      topWeightDate: bestDate,
      lastDate: bestDate,
      lastSessionBest: { weightKg: 90, reps: 5 },
    };
  }

  it("excludes a PR dated exactly today-7 from a 7-day recap (days-1 window)", () => {
    expect(recapWindow(TODAY).prevEnd).toBe(TODAY_MINUS_7);
    // Gather layer calls recentPRs with days - 1 = 6 for the weekly recap.
    const prs = recentPRs([summary(TODAY_MINUS_7)], TODAY, 7 - 1);
    expect(prs).toEqual([]);
  });

  it("still surfaces a PR inside the corrected window", () => {
    const prs = recentPRs([summary("2026-07-05")], TODAY, 7 - 1);
    expect(prs.map((p) => p.exercise)).toContain("Bench press");
  });

  it("would have leaked the today-7 PR under the pre-fix inclusive `days` window", () => {
    const leaked = recentPRs([summary(TODAY_MINUS_7)], TODAY, 7);
    expect(leaked.map((p) => p.exercise)).toContain("Bench press");
  });
});

describe("medianWeeklyWorkouts", () => {
  it("returns null for an empty list and the median otherwise", () => {
    expect(medianWeeklyWorkouts([])).toBeNull();
    expect(medianWeeklyWorkouts([2, 4, 3])).toBe(3);
  });
});

describe("Zone 2 recap line (issue #159)", () => {
  it("adds a Zone 2 line with % of target when minutes are present", () => {
    const recap = buildWeeklyRecap(
      baseInput({ zone2Min: 90, zone2Target: 150 })
    );
    const line = recap.lines.find((l) => l.key === "zone2");
    expect(line).toBeTruthy();
    expect(line!.value).toBe("90 min");
    expect(line!.delta).toBe("60% of 150 min target");
  });

  it("omits the target delta when there is no target", () => {
    const recap = buildWeeklyRecap(baseInput({ zone2Min: 90, zone2Target: 0 }));
    const line = recap.lines.find((l) => l.key === "zone2");
    expect(line!.delta).toBeUndefined();
  });

  it("omits the line entirely when there are no Zone 2 minutes", () => {
    const recap = buildWeeklyRecap(
      baseInput({ zone2Min: 0, zone2Target: 150 })
    );
    expect(recap.lines.some((l) => l.key === "zone2")).toBe(false);
    const nullRecap = buildWeeklyRecap(baseInput({ zone2Min: null }));
    expect(nullRecap.lines.some((l) => l.key === "zone2")).toBe(false);
  });
});
