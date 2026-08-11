import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  recapWindow,
  resolveRecapWindow,
  inWindow,
  weightTrendKg,
  buildRecap,
  renderRecapMessage,
  pickRecapNarrative,
  medianWeeklyWorkouts,
  recapLineAnnotation,
  RECAP_COMPARISON_KINDS,
  RECAP_LINE_MODEL,
  lineSpeaksAt,
  trainingMix,
  adherenceShape,
  type RecapInput,
  type RecapLineKey,
} from "@/lib/recap";
import { RECAP_SCALES } from "@/lib/recap-scale";
import { recentPRs, type ExerciseSummary } from "@/lib/coaching";
import { weekWindow } from "@/lib/week-window";
import { shiftDateStr, daysBetweenDateStr } from "@/lib/date";
import type { WeekStart } from "@/lib/settings";
import { plainBody } from "@/lib/notifications/rich-text";

const TODAY = "2026-07-09"; // a Thursday

// A fully-populated baseline input; individual tests override the fields they
// exercise.
function baseInput(over: Partial<RecapInput> = {}): RecapInput {
  return {
    today: TODAY,
    weightUnit: "kg",
    workouts: [],
    prevWorkouts: [],
    prLabels: [],
    adherence: null,
    weights: [],
    goalsCompleted: [],
    ...over,
  };
}

describe("fitness-check recap line (#1307)", () => {
  it("names a completed check with fitness age + prior (was 36)", () => {
    const recap = buildRecap(
      baseInput({ fitnessCheck: { fitnessAge: 34, priorFitnessAge: 36 } })
    );
    const line = recap.lines.find((l) => l.key === "fitness-check");
    expect(line?.value).toBe("fitness age 34, was 36");
  });

  it("drops the 'was' clause when the prior age matches or is absent", () => {
    const same = buildRecap(
      baseInput({ fitnessCheck: { fitnessAge: 34, priorFitnessAge: 34 } })
    );
    expect(same.lines.find((l) => l.key === "fitness-check")?.value).toBe(
      "fitness age 34"
    );
    const noPrior = buildRecap(
      baseInput({ fitnessCheck: { fitnessAge: 34, priorFitnessAge: null } })
    );
    expect(noPrior.lines.find((l) => l.key === "fitness-check")?.value).toBe(
      "fitness age 34"
    );
  });

  it("shows 'battery refreshed' when the check has no fitness age (no VO2)", () => {
    const recap = buildRecap(
      baseInput({ fitnessCheck: { fitnessAge: null, priorFitnessAge: null } })
    );
    expect(recap.lines.find((l) => l.key === "fitness-check")?.value).toBe(
      "battery refreshed"
    );
  });

  it("omits the line when no check completed in the window (null/absent)", () => {
    expect(
      buildRecap(baseInput()).lines.find((l) => l.key === "fitness-check")
    ).toBeUndefined();
    expect(
      buildRecap(baseInput({ fitnessCheck: null })).lines.find(
        (l) => l.key === "fitness-check"
      )
    ).toBeUndefined();
  });
});

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
// up with the routine counters / training log week summary (both derive from
// lib/week-window). resolveRecapWindow is the shared resolver; buildRecap's
// {start, end} must follow it. TODAY is a Thursday.
describe("recap honors week_mode (issue #223)", () => {
  const MONDAY = 1;

  it("rolling mode keeps the trailing-seven window (backward compatible)", () => {
    expect(resolveRecapWindow(TODAY, 7, "rolling")).toEqual(recapWindow(TODAY));
    const recap = buildRecap(baseInput({ weekMode: "rolling" }));
    expect(recap.start).toBe("2026-07-03");
    expect(recap.end).toBe(TODAY);
  });

  it("calendar mode covers the current week-start day through today", () => {
    // Week starts Monday 2026-07-06; today (Thu 07-09) → partial Mon–Thu window.
    const recap = buildRecap(
      baseInput({ weekMode: "calendar", weekStart: MONDAY })
    );
    expect(recap.start).toBe("2026-07-06");
    expect(recap.end).toBe(TODAY);
  });

  it("defaults to the trailing window when no week_mode is supplied", () => {
    const recap = buildRecap(baseInput());
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

  it("buildRecap follows `completed`: the recap's own range names the summarized week", () => {
    // Thursday 2026-07-09, week starts Monday → completed week Mon 06-29 – Sun 07-05.
    const recap = buildRecap(
      baseInput({
        weekMode: "calendar",
        weekStart: MONDAY,
        completed: true,
      })
    );
    expect(recap.start).toBe("2026-06-29");
    expect(recap.end).toBe("2026-07-05");
  });

  it("pickRecapNarrative follows the shifted window — an in-progress narrative is not re-narrated", () => {
    const recap = buildRecap(
      baseInput({
        weekMode: "calendar",
        weekStart: MONDAY,
        completed: true,
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

describe("buildRecap", () => {
  it("summarizes workouts with a type breakdown and prior-week comparison", () => {
    const recap = buildRecap(
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
    expect(line.comparison).toEqual({ kind: "prior", text: "1 last week" });
    expect(recap.headline).toContain("3 workouts");
    expect(recap.isEmpty).toBe(false);
  });

  it("surfaces a sleep-regularity line with the weekend shift (#160)", () => {
    const recap = buildRecap(baseInput({ sri: 82, socialJetlagMin: 78 }));
    const line = recap.lines.find((l) => l.key === "sleepRegularity")!;
    expect(line.value).toBe("SRI 82");
    expect(line.notes).toEqual(["1.3h weekend shift"]);
    // A weekend shift is context, not a comparison — the line compares nothing.
    expect(line.comparison.kind).toBe("none");
  });

  it("uses the shared honest presentation for a negative SRI (#1217)", () => {
    const recap = buildRecap(baseInput({ sri: -30.4 }));
    const line = recap.lines.find((l) => l.key === "sleepRegularity")!;
    expect(line.value).toBe("SRI −30");
  });

  it("omits the sleep-regularity line when SRI is null (#160)", () => {
    const recap = buildRecap(baseInput({ sri: null }));
    expect(
      recap.lines.find((l) => l.key === "sleepRegularity")
    ).toBeUndefined();
  });

  // Issue #837: a sick week reads as a sick week, not a failed one.
  it("names the illness episode with a recovery line when illnessDays > 0", () => {
    const recap = buildRecap(baseInput({ illnessDays: 4 }));
    const line = recap.lines.find((l) => l.key === "recovery")!;
    expect(line.value).toBe("sick 4 days this week");
    // A week with only illness is NOT empty — it has honest context to report.
    expect(recap.isEmpty).toBe(false);
    // ...and the headline names recovery instead of reading as an empty week.
    expect(recap.headline).toBe("recovering — sick 4 days");
  });

  it("adds no recovery line when illnessDays is 0/absent", () => {
    expect(
      buildRecap(baseInput()).lines.some((l) => l.key === "recovery")
    ).toBe(false);
    expect(
      buildRecap(baseInput({ illnessDays: 0 })).lines.some(
        (l) => l.key === "recovery"
      )
    ).toBe(false);
  });

  it("keeps real achievements in the headline, illness only as context line", () => {
    const recap = buildRecap(
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
    const recap = buildRecap(
      baseInput({
        prLabels: ["Bench press", "Squat", "Deadlift", "Overhead press"],
      })
    );
    const line = recap.lines.find((l) => l.key === "prs")!;
    expect(line.value).toBe("4");
    expect(line.notes).toEqual(["Bench press, Squat, Deadlift +1 more"]);
    expect(line.comparison.kind).toBe("none");
    expect(recap.headline).toContain("4 PRs");
  });

  it("computes adherence percentage from taken/due", () => {
    const recap = buildRecap(
      baseInput({ adherence: { taken: 12, skipped: 0, due: 14 } })
    );
    const line = recap.lines.find((l) => l.key === "adherence")!;
    expect(line.value).toBe("86%");
    // A LIST of declared notes since #2391; the grammar punctuates them.
    expect(line.notes).toEqual(["12/14 doses", null]);
    expect(line.comparison.kind).toBe("none");
  });

  it("shows the latest weight and a robust net change with a direction arrow", () => {
    const recap = buildRecap(
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
    expect(line.notes?.[0]).toContain("−"); // net loss over the window
    expect(line.notes?.[0]).toContain("kg");
  });

  it("marks a week with no workouts, adherence, or weight as empty", () => {
    const recap = buildRecap(baseInput());
    expect(recap.isEmpty).toBe(true);
    expect(recap.lines).toEqual([]);
  });

  it("is not empty when only a weigh-in was logged", () => {
    const recap = buildRecap(
      baseInput({ weights: [{ date: "2026-07-08", weightKg: 73 }] })
    );
    expect(recap.isEmpty).toBe(false);
  });
});

describe("renderRecapMessage", () => {
  // recapRangeLabel formats through formatMonthDay, whose year-omission reads the
  // process clock; pin it to the recap year (2026) so the compact "Jul 3 – Jul 9"
  // range is deterministic regardless of when the suite runs (#1218).
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 9));
  });
  afterAll(() => vi.useRealTimers());

  it("returns null for an empty recap (nothing worth interrupting for)", () => {
    const recap = buildRecap(baseInput());
    expect(renderRecapMessage(recap, "Ada")).toBeNull();
  });

  it("renders a titled, profile-named, bulleted message", () => {
    const recap = buildRecap(
      baseInput({
        workouts: [{ date: "2026-07-08", type: "strength" }],
        adherence: { taken: 7, skipped: 0, due: 7 },
      })
    );
    const msg = renderRecapMessage(recap, "Ada")!;
    expect(msg.title).toBe("📊 Weekly recap — Ada");
    expect(plainBody(msg.body)).toContain("Jul 3 – Jul 9");
    expect(plainBody(msg.body)).toContain("• Workouts: 1");
    expect(plainBody(msg.body)).toContain("• Adherence: 100%");
  });

  // #421: a stored recap narrative replaces the bare bullets when present.
  it("uses the stored narrative body when one is supplied", () => {
    const recap = buildRecap(
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
    expect(plainBody(msg.body)).toContain("Jul 3 – Jul 9");
    expect(plainBody(msg.body)).toContain("A strong week");
    // The narrative supersedes the bullet lines.
    expect(plainBody(msg.body)).not.toContain("• Workouts:");
  });

  it("falls back to bullets when the narrative is empty/whitespace", () => {
    const recap = buildRecap(
      baseInput({ workouts: [{ date: "2026-07-08", type: "strength" }] })
    );
    const msg = renderRecapMessage(recap, "Ada", "   ")!;
    expect(plainBody(msg.body)).toContain("• Workouts: 1");
  });

  // THE DOCUMENTED GRAMMAR, exactly (#2391 / #2389 item 2). The recap used to wrap its
  // annotation in parentheses while the digest composed with declared parts, so the two
  // system-initiated messages a profile receives were punctuated by different rules —
  // and only the digest's was nesting-proof. This is the one visible copy change the
  // unification forces, pinned line for line.
  it("no longer nests a label's own parentheses inside another set", () => {
    const recap = buildRecap(
      baseInput({
        workouts: [
          { date: "2026-07-06", type: "strength" },
          { date: "2026-07-08", type: "cardio" },
        ],
        prevWorkouts: [{ date: "2026-06-30", type: "strength" }],
        prLabels: ["Romanian Deadlift (Rep Trap Bar)"],
        adherence: { taken: 12, skipped: 1, due: 14 },
      })
    );
    const lines = plainBody(
      recap.lines.length ? renderRecapMessage(recap, "Ada")!.body : ""
    )
      .split("\n")
      .slice(1);
    // The workouts line still carries ONE parenthetical, inside `value`: a breakdown
    // decomposing the head's own figure. That is #2389 item 1's to re-cut, not an
    // oversight here — what this pins is that the COMPOSITION adds no second set, so a
    // label legitimately containing parens ("Romanian Deadlift (Rep Trap Bar)") cannot
    // nest inside one.
    expect(lines).toEqual([
      "• Workouts: 2 (strength 1, cardio 1) — 1 last week",
      "• PRs: 1 — Romanian Deadlift (Rep Trap Bar)",
      "• Adherence: 92% — 12/13 doses · 1 skipped",
    ]);
    expect(lines.join("\n")).not.toMatch(/\(\(|\)\)/);
  });
});

describe("pickRecapNarrative (#421)", () => {
  const recap = buildRecap(
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
    const recap = buildRecap(baseInput({ zone2Min: 90, zone2Target: 150 }));
    const line = recap.lines.find((l) => l.key === "zone2");
    expect(line).toBeTruthy();
    expect(line!.value).toBe("90 min");
    // Measured against the declared target — never against last week.
    expect(line!.comparison).toEqual({
      kind: "target",
      text: "60% of 150 min target",
    });
  });

  it("declares no comparison when there is no target", () => {
    const recap = buildRecap(baseInput({ zone2Min: 90, zone2Target: 0 }));
    const line = recap.lines.find((l) => l.key === "zone2");
    expect(line!.comparison.kind).toBe("none");
    expect(recapLineAnnotation(line!)).toBeUndefined();
  });

  it("omits the line entirely when there are no Zone 2 minutes", () => {
    const recap = buildRecap(baseInput({ zone2Min: 0, zone2Target: 150 }));
    expect(recap.lines.some((l) => l.key === "zone2")).toBe(false);
    const nullRecap = buildRecap(baseInput({ zone2Min: null }));
    expect(nullRecap.lines.some((l) => l.key === "zone2")).toBe(false);
  });
});

// #1935 — the coverage rule, owner-decided. The recap's advantage over the daily
// digest is showing what you cannot see day to day, so a line has to earn week
// scale. Three did not: volume (a session fact aggregated, whose "-41%" restated
// "fewer sessions" one line under the workout count that already said so),
// estimated calories (a low-confidence derived number compared against another
// estimate), and the streak (app engagement with a cliff, on the same screen as
// the machinery that recommends rest days).
describe("recap coverage rule (#1935)", () => {
  // The fixture that would have produced ALL THREE: a heavy week of lifting with a
  // prior week to compare against and a live streak. It must produce none of them.
  const everything = () =>
    buildRecap(
      baseInput({
        workouts: [
          { date: "2026-07-04", type: "strength" },
          { date: "2026-07-06", type: "strength" },
        ],
        prevWorkouts: [
          { date: "2026-06-30", type: "strength" },
          { date: "2026-07-01", type: "strength" },
          { date: "2026-07-02", type: "strength" },
        ],
      })
    );

  it("builds no volume, calories, or streak line", () => {
    const keys = everything().lines.map((l) => l.key as string);
    expect(keys).not.toContain("volume");
    expect(keys).not.toContain("calories");
    expect(keys).not.toContain("streak");
  });

  it("says none of it in the rendered message either", () => {
    const msg = renderRecapMessage(everything(), "Ada")!;
    expect(plainBody(msg.body)).not.toMatch(/Volume|kcal|streak|active day/i);
    // The line the volume percentage was restating is still there, and is the
    // honest version of the same claim.
    expect(plainBody(msg.body)).toContain("• Workouts: 2 (strength 2)");
    expect(plainBody(msg.body)).toContain("3 last week");
  });

  it("keeps every line that does earn week scale", () => {
    const recap = buildRecap(
      baseInput({
        workouts: [{ date: "2026-07-08", type: "strength" }],
        prLabels: ["Bench press"],
        adherence: { taken: 12, skipped: 1, due: 14 },
        weights: [
          { date: "2026-07-04", weightKg: 74 },
          { date: "2026-07-08", weightKg: 73 },
        ],
        sri: 82,
        zone2Min: 90,
        zone2Target: 150,
        intakeDeltaLine: "Missed: Glycine (2 days)",
      })
    );
    expect(recap.lines.map((l) => l.key as string)).toEqual([
      "workouts",
      "prs",
      "intake-deltas",
      "adherence",
      "weight",
      "zone2",
      "sleepRegularity",
    ]);
  });
});

// #1935 — `delta` had no defined meaning: one slot doing five unrelated jobs
// across eleven lines, plus three silent omissions. The typed comparison makes
// every line declare ONE idiom or declare that it compares nothing, and this pin
// is what forces a NEW line's author to answer the question rather than reaching
// for whichever parenthetical looked closest.
describe("typed comparison slot (#1935)", () => {
  // A fixture that emits every line the recap can build.
  const allLines = () =>
    buildRecap(
      baseInput({
        illnessDays: 2,
        workouts: [{ date: "2026-07-08", type: "strength" }],
        prevWorkouts: [{ date: "2026-07-01", type: "strength" }],
        prLabels: ["Bench press"],
        intakeDeltaLine: "Missed: Glycine (2 days)",
        adherence: { taken: 12, skipped: 1, due: 14 },
        weights: [
          { date: "2026-07-04", weightKg: 74 },
          { date: "2026-07-08", weightKg: 73 },
        ],
        prevWeights: [{ date: "2026-07-01", weightKg: 75 }],
        zone2Min: 90,
        zone2Target: 150,
        sri: 82,
        socialJetlagMin: 78,
        mood: { avgValence: 3.5, daysLogged: 4 },
        goalsCompleted: ["Run a 10k"],
        fitnessCheck: { fitnessAge: 34, priorFitnessAge: 36 },
      })
    );

  it("every emitted line declares the comparison kind the registry assigns it", () => {
    for (const line of allLines().lines) {
      const declared = RECAP_COMPARISON_KINDS[line.key];
      expect(
        declared,
        `${line.key} is missing from the registry`
      ).toBeDefined();
      // A line may fall back to "none" when its idiom's data is absent, but it may
      // never speak a SECOND idiom — that is the drift the untyped slot allowed.
      expect([declared, "none"]).toContain(line.comparison.kind);
    }
  });

  it("the registry covers exactly the key union — a new line cannot omit it", () => {
    // Adding a key to RecapLineKey without a registry entry is a type error at the
    // Record; this pins the other direction (no stale entries) and, with the loop
    // above, closes the loop for every line the builder can emit.
    const keys = Object.keys(RECAP_COMPARISON_KINDS) as RecapLineKey[];
    expect(keys.length).toBe(14);
    for (const k of keys) expect(RECAP_COMPARISON_KINDS[k]).toBeTruthy();
  });

  it("weight carries the week-over-week comparison it was missing", () => {
    const line = allLines().lines.find((l) => l.key === "weight")!;
    expect(line.value).toBe("73 kg");
    expect(line.comparison).toEqual({ kind: "prior", text: "75 kg last week" });
  });

  it("weight compares nothing — rather than something else — with no prior weigh-in", () => {
    const recap = buildRecap(
      baseInput({ weights: [{ date: "2026-07-08", weightKg: 73 }] })
    );
    const line = recap.lines.find((l) => l.key === "weight")!;
    expect(line.comparison.kind).toBe("none");
  });

  it("renders the note before the comparison, one parenthetical", () => {
    const line = allLines().lines.find((l) => l.key === "weight")!;
    expect(recapLineAnnotation(line)).toBe(
      "−1.0 kg this week · 75 kg last week"
    );
  });
});

// #1935 correctness defects.
describe("intake delta line renders once, unprefixed (#1935/#1505)", () => {
  it("is bare — the shared line already carries its own Missed:/Resumed: prefix", () => {
    const recap = buildRecap(
      baseInput({ intakeDeltaLine: "Missed: Glycine (2 days)" })
    );
    const line = recap.lines.find((l) => l.key === "intake-deltas")!;
    expect(line.bare).toBe(true);
    expect(line.value).toBe("Missed: Glycine (2 days)");
    // Not "Changed" — nothing changed; something did not happen.
    expect(line.label).not.toBe("Changed");
  });

  it("the message says Missed: exactly once, under no second label", () => {
    const recap = buildRecap(
      baseInput({
        workouts: [{ date: "2026-07-08", type: "strength" }],
        intakeDeltaLine: "Missed: Glycine (2 days)",
      })
    );
    const msg = renderRecapMessage(recap, "Ada")!;
    expect(plainBody(msg.body)).toContain("• Missed: Glycine (2 days)");
    expect(plainBody(msg.body)).not.toContain("Changed:");
    expect(plainBody(msg.body).match(/Missed:/g)).toHaveLength(1);
  });
});

describe("mood line phrasing (#1935/#992)", () => {
  it("does not call a single check-in an average", () => {
    const recap = buildRecap(
      baseInput({ mood: { avgValence: 2, daysLogged: 1 } })
    );
    const line = recap.lines.find((l) => l.key === "mood")!;
    expect(line.value).toBe("one check-in: 2/5");
    expect(line.value).not.toContain("averaged");
  });

  it("uses the averaging language once there is something to average", () => {
    const recap = buildRecap(
      baseInput({ mood: { avgValence: 3.46, daysLogged: 5 } })
    );
    const line = recap.lines.find((l) => l.key === "mood")!;
    expect(line.value).toBe("averaged 3.5/5 over 5 check-ins");
  });

  it("never compares — a summary, never a score to beat", () => {
    const recap = buildRecap(
      baseInput({ mood: { avgValence: 3.5, daysLogged: 4 } })
    );
    expect(recap.lines.find((l) => l.key === "mood")!.comparison.kind).toBe(
      "none"
    );
  });
});

// ── The per-line scale model (#2178) ────────────────────────────────────────────
//
// The generalization of #1935's owner-decided coverage rule: a line appears at a scale
// only if its fact BECOMES VISIBLE at that scale, and no scale re-totals the smaller
// periods. These are that rule's teeth.
describe("per-line scale model (#2178)", () => {
  it("declares a scale set and a reason for every line key", () => {
    const keys = Object.keys(RECAP_COMPARISON_KINDS) as RecapLineKey[];
    for (const k of keys) {
      const spec = RECAP_LINE_MODEL[k];
      expect(spec, k).toBeDefined();
      expect(spec.scales.length, k).toBeGreaterThan(0);
      // "Nobody looked" and "we decided this, and here is why" must stay
      // distinguishable — the house rule every registry in this repo follows.
      expect(spec.why.trim().length, k).toBeGreaterThan(40);
      for (const s of spec.scales)
        expect(
          RECAP_SCALES.map((e) => e.scale),
          `${k}: ${s}`
        ).toContain(s);
    }
    expect(Object.keys(RECAP_LINE_MODEL).sort()).toEqual([...keys].sort());
  });

  it("gives every scale something to say", () => {
    for (const { scale } of RECAP_SCALES) {
      const speaking = (Object.keys(RECAP_LINE_MODEL) as RecapLineKey[]).filter(
        (k) => lineSpeaksAt(k, scale)
      );
      expect(speaking.length, scale).toBeGreaterThan(2);
    }
  });

  it("NEVER RE-TOTALS: no scale above the week reports a bare event count", () => {
    // The pin, by name. "You did 47 workouts" is four weekly lines summed and handed
    // back with an authority none of them had, which is what the rule forbids. The
    // count lines are declared week-only; the longer scales speak shares, rates and
    // directions instead.
    for (const key of ["workouts", "adherence", "zone2"] as RecapLineKey[])
      expect(RECAP_LINE_MODEL[key].scales, key).toEqual(["week"]);
    const monthOnly = (Object.keys(RECAP_LINE_MODEL) as RecapLineKey[]).filter(
      (k) => !lineSpeaksAt(k, "week")
    );
    expect(monthOnly.sort()).toEqual([
      "adherence-pattern",
      "training-mix",
      "weight-trajectory",
    ]);
  });

  it("emits only the lines a scale declares", () => {
    const rich = {
      workouts: [
        { date: "2026-06-02", type: "strength" as const },
        { date: "2026-06-09", type: "strength" as const },
        { date: "2026-06-16", type: "cardio" as const },
        { date: "2026-06-23", type: "cardio" as const },
      ],
      prevWorkouts: [
        { date: "2026-05-05", type: "strength" as const },
        { date: "2026-05-12", type: "strength" as const },
        { date: "2026-05-19", type: "strength" as const },
        { date: "2026-05-26", type: "cardio" as const },
      ],
      weights: [
        { date: "2026-06-02", weightKg: 80 },
        { date: "2026-06-28", weightKg: 78.2 },
      ],
      prevWeights: [
        { date: "2026-05-02", weightKg: 80.6 },
        { date: "2026-05-28", weightKg: 80 },
      ],
      adherence: { taken: 50, skipped: 0, due: 60 },
      intakeDeltaLine: "Missed: Glycine (2 days)",
      mood: { avgValence: 4, daysLogged: 10 },
      zone2Min: 120,
      zone2Target: 150,
    };
    const week = buildRecap(baseInput({ ...rich, today: "2026-07-09" }));
    const month = buildRecap(
      baseInput({
        ...rich,
        today: "2026-07-09",
        scale: "month",
        completed: true,
        adherenceDays: monthDoseDays(),
      })
    );
    for (const l of week.lines) expect(lineSpeaksAt(l.key, "week")).toBe(true);
    for (const l of month.lines)
      expect(lineSpeaksAt(l.key, "month")).toBe(true);
    expect(week.lines.map((l) => l.key)).toContain("workouts");
    expect(week.lines.map((l) => l.key)).not.toContain("training-mix");
    expect(month.lines.map((l) => l.key)).toContain("training-mix");
    expect(month.lines.map((l) => l.key)).not.toContain("workouts");
    expect(month.lines.map((l) => l.key)).toContain("weight-trajectory");
    expect(month.lines.map((l) => l.key)).toContain("adherence-pattern");
    expect(month.lines.map((l) => l.key)).not.toContain("adherence");
    // The month's own range is the CLOSED calendar month, never a trailing 30 days.
    expect(month.start).toBe("2026-06-01");
    expect(month.end).toBe("2026-06-30");
    // And the headline obeys the same declaration — no smuggled workout total.
    expect(month.headline).not.toMatch(/workouts?/);
    expect(month.headline).toContain("sessions/week");
  });
});

// Every day of June 2026 carrying two intended doses, one of which is missed at
// weekends — a deterministic shape for the pattern line.
function monthDoseDays() {
  const days: { date: string; due: number; taken: number; skipped: number }[] =
    [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    days.push({ date, due: 2, taken: weekend ? 1 : 2, skipped: 0 });
  }
  return days;
}

describe("the month/quarter lines (#2178)", () => {
  it("training mix reports SHARES and a rate, never a session total", () => {
    const mix = trainingMix(
      [
        { date: "2026-06-01", type: "strength" },
        { date: "2026-06-03", type: "strength" },
        { date: "2026-06-05", type: "strength" },
        { date: "2026-06-08", type: "cardio" },
      ],
      28
    );
    expect(mix).toEqual({
      sessions: 4,
      shares: [
        { type: "strength", pct: 75 },
        { type: "cardio", pct: 25 },
      ],
      perWeek: 1,
    });
  });

  it("withholds a share when there are too few sessions to mean anything", () => {
    expect(
      trainingMix(
        [
          { date: "2026-06-01", type: "strength" },
          { date: "2026-06-03", type: "cardio" },
        ],
        30
      )
    ).toBeNull();
  });

  it("withholds a share when nothing carried a bucket (#2272)", () => {
    // An all-unclassified month has no composition, and inventing one would be the
    // exact claim the null type exists to withhold.
    expect(
      trainingMix(
        [
          { date: "2026-06-01", type: null },
          { date: "2026-06-03", type: null },
          { date: "2026-06-05", type: null },
          { date: "2026-06-08", type: null },
        ],
        30
      )
    ).toBeNull();
  });

  it("adherence shape splits weekday from weekend and names the drift", () => {
    const shape = adherenceShape(monthDoseDays())!;
    expect(shape.weekdayPct).toBe(100);
    expect(shape.weekendPct).toBe(50);
    expect(shape.drift).toBe("steady");
  });

  it("adherence shape reports a slipping second half", () => {
    const days = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      due: 2,
      taken: i < 10 ? 2 : 1,
      skipped: 0,
    }));
    expect(adherenceShape(days)!.drift).toBe("slipping");
    expect(
      adherenceShape(days.map((d) => ({ ...d, taken: 2 - d.taken + 1 })))!.drift
    ).toBe("improving");
  });

  it("withholds a shape below the minimum dose count", () => {
    expect(
      adherenceShape([
        { date: "2026-06-01", due: 2, taken: 1, skipped: 0 },
        { date: "2026-06-02", due: 2, taken: 2, skipped: 0 },
      ])
    ).toBeNull();
  });

  it("excludes deliberate skips from the shape's denominator, as week scale does", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`,
      due: 3,
      taken: 2,
      skipped: 1,
    }));
    // 2 taken of 2 intended (3 due − 1 skipped) is 100%, not 67%.
    expect(adherenceShape(days)!.weekdayPct).toBe(100);
  });
});
