import { describe, expect, it } from "vitest";
import {
  recapWindow,
  resolveRecapWindow,
  inWindow,
  weightTrendKg,
  buildWeeklyRecap,
  renderRecapMessage,
  pickRecapNarrative,
  medianWeeklyWorkouts,
  type RecapInput,
} from "@/lib/weekly-recap";
import { recentPRs, type ExerciseSummary } from "@/lib/coaching";
import { weekWindow } from "@/lib/week-window";
import { shiftDateStr, daysBetweenDateStr } from "@/lib/date";
import type { WeekStart } from "@/lib/settings";

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

// Issue #1021: the NOTIFICATION's calendar-mode window is the last COMPLETED week
// (completed = true), so "week starts Monday, recap Monday 9am" summarizes the
// full week that just ended — never a 9-hour "week" compared against 7 full days.
// The dashboard (completed omitted/false) keeps the in-progress window (#223), and
// rolling mode is byte-for-byte untouched on both surfaces.
describe("completed-week window selection (issue #1021)", () => {
  const MONDAY = 1;

  it("headline case — recap day = week start: subject is the last FULL week, not a 1-day window", () => {
    // 2026-07-06 is a Monday; week starts Monday, recap sent Monday morning.
    const win = resolveRecapWindow("2026-07-06", 7, "calendar", MONDAY, true);
    expect(win).toEqual({
      start: "2026-06-29",
      end: "2026-07-05",
      prevStart: "2026-06-22",
      prevEnd: "2026-06-28",
    });
  });

  it("every (weekStart, sendDay) pair yields a full 7-day subject — the last completed week — with a full 7-day comparison", () => {
    for (let weekStart = 0; weekStart <= 6; weekStart++) {
      for (let sendOffset = 0; sendOffset <= 6; sendOffset++) {
        // Walk a full week of send days from an anchor date.
        const today = shiftDateStr("2026-07-06", sendOffset);
        const win = resolveRecapWindow(
          today,
          7,
          "calendar",
          weekStart as WeekStart,
          true
        );
        const inProgress = weekWindow(
          today,
          "calendar",
          weekStart as WeekStart
        );
        // Subject = the in-progress week's comparison slot (the last full week).
        expect(win.start).toBe(inProgress.prevStart);
        expect(win.end).toBe(inProgress.prevEnd);
        // Always exactly 7 days, ending the day before the current week starts.
        expect(daysBetweenDateStr(win.start, win.end)).toBe(6);
        expect(win.end).toBe(shiftDateStr(inProgress.start, -1));
        // Comparison = the full week immediately before, contiguous.
        expect(daysBetweenDateStr(win.prevStart, win.prevEnd)).toBe(6);
        expect(win.prevEnd).toBe(shiftDateStr(win.start, -1));
      }
    }
  });

  it("rolling mode is untouched by completed (always a full trailing week already)", () => {
    expect(resolveRecapWindow(TODAY, 7, "rolling", 0, true)).toEqual(
      resolveRecapWindow(TODAY, 7, "rolling", 0, false)
    );
    expect(resolveRecapWindow(TODAY, 7, "rolling", 0, true)).toEqual(
      recapWindow(TODAY)
    );
  });

  it("the dashboard (non-completed) calendar path is unchanged", () => {
    expect(resolveRecapWindow(TODAY, 7, "calendar", MONDAY, false)).toEqual(
      resolveRecapWindow(TODAY, 7, "calendar", MONDAY)
    );
    expect(resolveRecapWindow(TODAY, 7, "calendar", MONDAY)).toEqual(
      weekWindow(TODAY, "calendar", MONDAY)
    );
  });

  it("non-weekly periods ignore completed (week_mode only defines a week)", () => {
    expect(resolveRecapWindow(TODAY, 30, "calendar", MONDAY, true)).toEqual(
      recapWindow(TODAY, 30)
    );
  });

  it("buildWeeklyRecap follows completedWeek: the recap's own range names the summarized week", () => {
    // Thursday 2026-07-09, week starts Monday → completed week Mon 06-29 – Sun 07-05.
    const recap = buildWeeklyRecap(
      baseInput({
        weekMode: "calendar",
        weekStart: MONDAY,
        completedWeek: true,
      })
    );
    expect(recap.start).toBe("2026-06-29");
    expect(recap.end).toBe("2026-07-05");
  });

  it("pickRecapNarrative follows the shifted window — an in-progress narrative is not re-narrated", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        weekMode: "calendar",
        weekStart: MONDAY,
        completedWeek: true,
        workouts: [{ date: "2026-07-01", type: "strength" }],
      })
    );
    // A narrative generated for the in-progress week (period_end = today) must
    // NOT be picked for the completed-week recap…
    expect(
      pickRecapNarrative(
        [{ period_start: "2026-07-06", period_end: TODAY, summary: "current" }],
        recap
      )
    ).toBeNull();
    // …while one anchored inside the completed week is.
    expect(
      pickRecapNarrative(
        [
          { period_start: "2026-07-06", period_end: TODAY, summary: "current" },
          {
            period_start: "2026-06-29",
            period_end: "2026-07-05",
            summary: "completed",
          },
        ],
        recap
      )
    ).toBe("completed");
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
    expect(line.value).toBe("SRI 82");
    expect(line.delta).toBe("1.3h weekend shift");
  });

  it("uses the shared honest presentation for a negative SRI (#1217)", () => {
    const recap = buildWeeklyRecap(baseInput({ sri: -30.4 }));
    const line = recap.lines.find((l) => l.key === "sleepRegularity")!;
    expect(line.value).toBe("SRI −30");
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

  // Issue #837: a sick week reads as a sick week, not a failed one.
  it("names the illness episode with a recovery line when illnessDays > 0", () => {
    const recap = buildWeeklyRecap(baseInput({ illnessDays: 4 }));
    const line = recap.lines.find((l) => l.key === "recovery")!;
    expect(line.value).toBe("sick 4 days this week");
    // A week with only illness is NOT empty — it has honest context to report.
    expect(recap.isEmpty).toBe(false);
    // ...and the headline names recovery instead of reading as an empty week.
    expect(recap.headline).toBe("recovering — sick 4 days");
  });

  it("adds no recovery line when illnessDays is 0/absent", () => {
    expect(
      buildWeeklyRecap(baseInput()).lines.some((l) => l.key === "recovery")
    ).toBe(false);
    expect(
      buildWeeklyRecap(baseInput({ illnessDays: 0 })).lines.some(
        (l) => l.key === "recovery"
      )
    ).toBe(false);
  });

  it("keeps real achievements in the headline, illness only as context line", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        illnessDays: 2,
        workouts: [{ date: TODAY, type: "strength" }],
      })
    );
    // A logged workout still leads the headline; recovery is the context line.
    expect(recap.headline).toBe("1 workout");
    expect(recap.lines.some((l) => l.key === "recovery")).toBe(true);
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

  // #421: a stored recap narrative replaces the bare bullets when present.
  it("uses the stored narrative body when one is supplied", () => {
    const recap = buildWeeklyRecap(
      baseInput({
        workouts: [{ date: "2026-07-08", type: "strength" }],
        adherence: { taken: 7, skipped: 0, due: 7 },
      })
    );
    const msg = renderRecapMessage(
      recap,
      "Ada",
      "A strong week — one lift and perfect adherence."
    )!;
    expect(msg.body).toContain("2026-07-03 – 2026-07-09");
    expect(msg.body).toContain("A strong week");
    // The narrative supersedes the bullet lines.
    expect(msg.body).not.toContain("• Workouts:");
  });

  it("falls back to bullets when the narrative is empty/whitespace", () => {
    const recap = buildWeeklyRecap(
      baseInput({ workouts: [{ date: "2026-07-08", type: "strength" }] })
    );
    const msg = renderRecapMessage(recap, "Ada", "   ")!;
    expect(msg.body).toContain("• Workouts: 1");
  });
});

describe("pickRecapNarrative (#421)", () => {
  const recap = buildWeeklyRecap(
    baseInput({ workouts: [{ date: "2026-07-08", type: "strength" }] })
  );
  // recap window is 2026-07-03 – 2026-07-09.
  it("prefers an exact period_end match", () => {
    const got = pickRecapNarrative(
      [
        {
          period_start: "2026-07-03",
          period_end: "2026-07-09",
          summary: "exact",
        },
        {
          period_start: "2026-06-26",
          period_end: "2026-07-02",
          summary: "old",
        },
      ],
      recap
    );
    expect(got).toBe("exact");
  });

  it("falls back to the newest narrative overlapping the window", () => {
    const got = pickRecapNarrative(
      [
        { period_start: null, period_end: "2026-07-05", summary: "overlap-a" },
        { period_start: null, period_end: "2026-07-07", summary: "overlap-b" },
      ],
      recap
    );
    expect(got).toBe("overlap-b");
  });

  it("returns null when nothing overlaps the window", () => {
    expect(
      pickRecapNarrative(
        [{ period_start: null, period_end: "2026-06-20", summary: "stale" }],
        recap
      )
    ).toBeNull();
    expect(pickRecapNarrative([], recap)).toBeNull();
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
