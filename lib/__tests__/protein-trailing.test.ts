import { describe, expect, it } from "vitest";
import {
  proteinDailyGrams,
  proteinTrailingAverage,
  proteinTrailingWindowStart,
  PROTEIN_TRAILING_DAYS,
  type ProteinDayParts,
} from "@/lib/protein";
import { trailingAverage } from "@/lib/trailing-average";

// Pure tier: the trailing 7-day protein average (#1917) — the number the dashboard's
// "7-day average" label has always claimed, and did not show. Three groups:
//   1. the label's promise — seven CALENDAR days, today excluded;
//   2. the #221 pin — this figure IS trailingAverage's output, not a fourth mean;
//   3. the declared basis — what `calendar` buys over `data-bearing` for food logs.

const TODAY = "2026-07-23";

// A day carrying only manually-logged grams (the simplest signal; the composition of
// tracked/estimated/logged is proteinIntake's own tested job).
function logged(date: string, grams: number): ProteinDayParts {
  return { date, dailyTracked: null, dailyLogged: grams, dailyEstimated: 0 };
}

// Seven complete days at a steady 100 g, then a today that is deliberately far off.
const WEEK: ProteinDayParts[] = [
  logged("2026-07-16", 100),
  logged("2026-07-17", 100),
  logged("2026-07-18", 100),
  logged("2026-07-19", 100),
  logged("2026-07-20", 100),
  logged("2026-07-21", 100),
  logged("2026-07-22", 100),
  logged(TODAY, 20),
];

describe("the trailing protein average keeps its label's promise (#1917)", () => {
  it("covers seven days, not the week so far", () => {
    const w = proteinTrailingAverage(WEEK, TODAY);
    expect(w.grams).toBe(100);
    expect(w.dayOne).toBe(false);
    // The window is seven days wide regardless of where the week boundary falls —
    // the defect was a figure that covered two days on a Tuesday and reset on
    // Monday morning.
    expect(PROTEIN_TRAILING_DAYS).toBe(7);
    expect(proteinTrailingWindowStart(TODAY)).toBe("2026-07-16");
  });

  it("excludes a partial today — the afternoon understatement", () => {
    // Half a day's protein logged by 2pm used to drag the mean down and correct
    // itself at midnight. The complete-day window cannot move for today at all.
    const withoutToday = WEEK.filter((d) => d.date !== TODAY);
    expect(proteinTrailingAverage(WEEK, TODAY).grams).toBe(
      proteinTrailingAverage(withoutToday, TODAY).grams
    );
  });

  it("averages the days that carry a log — an unlogged day is unknown, not zero", () => {
    // Four logged days of the seven. Dividing by 7 would report ~57 g and read as
    // a shortfall invented by silence; the honest figure is the average logged day.
    const gappy = [
      logged("2026-07-18", 120),
      logged("2026-07-20", 80),
      logged("2026-07-21", 100),
      logged("2026-07-22", 100),
    ];
    expect(proteinTrailingAverage(gappy, TODAY).grams).toBe(100);
  });

  it("reports nothing rather than zero when the window holds no logged day", () => {
    expect(proteinTrailingAverage([], TODAY)).toEqual({
      grams: null,
      dayOne: false,
    });
  });

  it("skips a day with no protein signal at all", () => {
    const days: ProteinDayParts[] = [
      {
        date: "2026-07-21",
        dailyTracked: null,
        dailyLogged: null,
        dailyEstimated: 0,
      },
      logged("2026-07-22", 90),
    ];
    expect(proteinDailyGrams(days)).toEqual([
      { date: "2026-07-22", value: 90 },
    ]);
    expect(proteinTrailingAverage(days, TODAY).grams).toBe(90);
  });

  it("composes each day through the SAME intake engine (tracked overrides)", () => {
    // A measured full-day total wins over the estimated + logged floor, exactly as
    // it does for today's own figure — one composition, four surfaces.
    const days: ProteinDayParts[] = [
      {
        date: "2026-07-22",
        dailyTracked: 150,
        dailyLogged: 30,
        dailyEstimated: 40,
      },
    ];
    expect(proteinTrailingAverage(days, TODAY).grams).toBe(150);
  });
});

describe("protein is a trailingAverage CONSUMER, not a fourth mean (#221/#1909)", () => {
  it("the figure IS the shared helper's calendar window, today excluded", () => {
    const helper = trailingAverage(proteinDailyGrams(WEEK), TODAY, {
      days: PROTEIN_TRAILING_DAYS,
      basis: "calendar",
    });
    expect(proteinTrailingAverage(WEEK, TODAY).grams).toBe(helper.average);
  });

  it("inherits the day-one fallback rather than re-deriving one", () => {
    // A first-ever food log, today: no complete-day history at all, so the helper
    // offers today's intake and marks it. The dashboard card DECLINES it (today's
    // intake is already that card's headline) — but the decision is the helper's,
    // made once, not this module's.
    const w = proteinTrailingAverage([logged(TODAY, 84)], TODAY);
    expect(w).toEqual({ grams: 84, dayOne: true });
  });

  it("a gather that reads only the window declares it, and day one stays off", () => {
    // The real gather's SQL stops at the window start, so a profile that logged a
    // month ago and again today arrives here looking exactly like a first-ever log.
    // The truncation is declared rather than guessed at, and the shared rule holds.
    expect(
      proteinTrailingAverage([logged(TODAY, 84)], TODAY, {
        hasEarlierHistory: true,
      })
    ).toEqual({ grams: null, dayOne: false });
  });

  it("a gap is not day one — a stale log stays out of the window", () => {
    // Logged a fortnight ago and again today. There IS complete-day history, so the
    // 7-day window is honestly empty; showing today's 84 g under a "7-day average"
    // label is the exact defect #1909 removed.
    const w = proteinTrailingAverage(
      [logged("2026-07-08", 130), logged(TODAY, 84)],
      TODAY
    );
    expect(w).toEqual({ grams: null, dayOne: false });
  });
});

describe("the declared basis is CALENDAR, and it matters for food logs (#1917)", () => {
  // Food logging is gappy, which argues AGAINST the data-bearing basis here rather
  // than for it: "the last 7 days that carry a log" would reach back a month for
  // someone who logged a week and stopped, then print that month-old number under a
  // label naming the last week. The steps card can afford data-bearing because a
  // watch feeds it daily and its question is "my usual day".
  const ABANDONED = [
    logged("2026-06-20", 150),
    logged("2026-06-21", 150),
    logged("2026-06-22", 150),
    logged(TODAY, 40),
  ];

  it("a month-old run does NOT become this week's average", () => {
    expect(proteinTrailingAverage(ABANDONED, TODAY).grams).toBeNull();
  });

  it("…which is exactly what the data-bearing basis would have done", () => {
    // Stated as a contrast so the choice is visible rather than implied: the same
    // series on the other basis reports 150 g/day, a month out of date, under a
    // label that says seven days.
    const dataBearing = trailingAverage(proteinDailyGrams(ABANDONED), TODAY, {
      days: PROTEIN_TRAILING_DAYS,
      basis: "data-bearing",
    });
    expect(dataBearing.average).toBe(150);
  });
});
