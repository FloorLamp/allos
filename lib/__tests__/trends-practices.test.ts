import { describe, expect, it } from "vitest";
import {
  MAX_PRACTICE_TREND_WEEKS,
  PRACTICE_DIGEST_MIN_WEEKS,
  practiceDigestEligible,
  practiceDigestKey,
  practiceTrendWindow,
} from "@/lib/trends-practices";

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
