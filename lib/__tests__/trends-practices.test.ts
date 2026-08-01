import { describe, expect, it } from "vitest";
import {
  MAX_PRACTICE_TREND_WEEKS,
  MIN_PRACTICE_TREND_WEEKS,
  PRACTICE_DIGEST_MIN_WEEKS,
  PRACTICE_VERDICT_LABEL,
  practiceConsistencyText,
  practiceDigestEligible,
  practiceDigestKey,
  practiceTrendWeeks,
  practiceTrendWindow,
  practiceWeekMet,
  practiceWeekVerdict,
  summarizePracticeWeeks,
  type PracticeWeekVerdict,
} from "@/lib/trends-practices";
import { frequencyRangeState } from "@/lib/practice";

// The Trends wellness lens's pure decisions (#1632). The load-bearing property is
// that the lens FORMATS the practice domain's existing verdicts rather than
// inventing its own, so the first block asserts agreement with
// frequencyRangeState itself instead of restating its rules.

describe("practiceWeekVerdict", () => {
  it("is frequencyRangeState with the week fully elapsed", () => {
    for (const floor of [1, 3, 5]) {
      for (const ceiling of [null, floor + 2]) {
        for (let count = 0; count <= 8; count++) {
          const state = frequencyRangeState(count, floor, ceiling, 7);
          const verdict = practiceWeekVerdict(count, floor, ceiling);
          expect(verdict === "at-ceiling").toBe(state.atCeiling);
          expect(practiceWeekMet(verdict)).toBe(state.met);
        }
      }
    }
  });

  it("names the three states a completed week can have", () => {
    expect(practiceWeekVerdict(1, 3, 5)).toBe("under");
    expect(practiceWeekVerdict(3, 3, 5)).toBe("met");
    expect(practiceWeekVerdict(5, 3, 5)).toBe("at-ceiling");
    // Above the ceiling stays the calm at-ceiling state, never an over-the-top
    // fourth state (#1259: past the cap is never a red flag).
    expect(practiceWeekVerdict(9, 3, 5)).toBe("at-ceiling");
  });

  it("has no at-ceiling state without a declared ceiling", () => {
    expect(practiceWeekVerdict(99, 3, null)).toBe("met");
  });

  it("labels every verdict", () => {
    const verdicts: PracticeWeekVerdict[] = ["at-ceiling", "met", "under"];
    for (const verdict of verdicts) {
      expect(PRACTICE_VERDICT_LABEL[verdict].length).toBeGreaterThan(0);
    }
  });
});

describe("summarizePracticeWeeks", () => {
  const weeks = (verdicts: PracticeWeekVerdict[]) =>
    verdicts.map((verdict) => ({ verdict }));

  it("counts an at-ceiling week as met", () => {
    const c = summarizePracticeWeeks(
      weeks(["met", "at-ceiling", "under", "at-ceiling"])
    );
    expect(c.met).toBe(3);
    expect(c.weeks).toBe(4);
    expect(c.rate).toBeCloseTo(0.75);
  });

  it("reads the current streak from the NEWEST end", () => {
    // Oldest first: the run that matters is the one that reaches the last cell.
    const c = summarizePracticeWeeks(
      weeks(["met", "met", "met", "under", "met", "met"])
    );
    expect(c.currentStreak).toBe(2);
    expect(c.bestStreak).toBe(3);
  });

  it("reports no streak when the most recent week fell under", () => {
    const c = summarizePracticeWeeks(weeks(["met", "met", "under"]));
    expect(c.currentStreak).toBe(0);
    expect(c.bestStreak).toBe(2);
  });

  it("has no rate without completed weeks", () => {
    expect(summarizePracticeWeeks([])).toEqual({
      weeks: 0,
      met: 0,
      rate: null,
      currentStreak: 0,
      bestStreak: 0,
    });
  });
});

describe("practiceConsistencyText", () => {
  it("states weeks met, and the streak only once there is one", () => {
    const text = practiceConsistencyText(
      summarizePracticeWeeks([
        { verdict: "met" },
        { verdict: "under" },
        { verdict: "met" },
        { verdict: "met" },
      ])
    );
    expect(text).toBe("Floor met in 3 of 4 completed weeks · 2-week streak");
  });

  it("omits a one-week streak", () => {
    expect(
      practiceConsistencyText(
        summarizePracticeWeeks([{ verdict: "under" }, { verdict: "met" }])
      )
    ).toBe("Floor met in 1 of 2 completed weeks");
  });

  it("says so plainly when there is no history", () => {
    expect(practiceConsistencyText(summarizePracticeWeeks([]))).toBe(
      "No completed weeks yet"
    );
  });
});

describe("practiceTrendWeeks", () => {
  it("turns the hub's 90-day default into a quarter of columns", () => {
    expect(practiceTrendWeeks(90)).toBe(13);
  });

  it("clamps a very short window up and an all-time window down", () => {
    expect(practiceTrendWeeks(3)).toBe(MIN_PRACTICE_TREND_WEEKS);
    expect(practiceTrendWeeks(null)).toBe(MAX_PRACTICE_TREND_WEEKS);
    expect(practiceTrendWeeks(3650)).toBe(MAX_PRACTICE_TREND_WEEKS);
  });
});

describe("practiceTrendWindow", () => {
  const TODAY = "2026-03-15";

  it("anchors on today for an open-ended window", () => {
    expect(practiceTrendWindow({}, TODAY)).toEqual({
      asOf: TODAY,
      weeks: MAX_PRACTICE_TREND_WEEKS,
    });
  });

  it("anchors on a range that ENDS in the past", () => {
    // The honest ledger for "January" is the weeks that ended in January.
    expect(
      practiceTrendWindow({ from: "2026-01-01", to: "2026-01-31" }, TODAY)
    ).toEqual({ asOf: "2026-01-31", weeks: 5 });
  });

  it("never anchors in the future", () => {
    expect(
      practiceTrendWindow({ from: "2026-01-01", to: "2026-12-31" }, TODAY)
    ).toMatchObject({ asOf: TODAY });
  });
});

describe("the digest candidate rule", () => {
  const someWeeks = (n: number, count = 2) =>
    Array.from({ length: n }, () => ({ count }));

  it("keys a practice by its identity, in its own namespace", () => {
    expect(practiceDigestKey("sauna")).toBe("wellness:sauna");
  });

  it("takes only tracked practices with enough completed history", () => {
    expect(
      practiceDigestEligible({
        perWeek: 3,
        weeks: someWeeks(PRACTICE_DIGEST_MIN_WEEKS),
      })
    ).toBe(true);
    // Untracked: a session count moving is not a commitment moving.
    expect(
      practiceDigestEligible({
        perWeek: null,
        weeks: someWeeks(PRACTICE_DIGEST_MIN_WEEKS),
      })
    ).toBe(false);
    expect(
      practiceDigestEligible({
        perWeek: 3,
        weeks: someWeeks(PRACTICE_DIGEST_MIN_WEEKS - 1),
      })
    ).toBe(false);
    // Never logged at all is not a trend, it is an empty habit.
    expect(
      practiceDigestEligible({
        perWeek: 3,
        weeks: someWeeks(PRACTICE_DIGEST_MIN_WEEKS, 0),
      })
    ).toBe(false);
  });
});
