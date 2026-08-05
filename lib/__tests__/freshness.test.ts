import { describe, it, expect } from "vitest";
import {
  freshnessAgeDays,
  freshnessState,
  hasNoCurrentReading,
  tallyFreshness,
  type FreshnessState,
} from "@/lib/freshness";
import { biomarkerRetestStatus } from "@/lib/reference-range";

// The shared freshness vocabulary (#2023/#2025). One decision, one counting shape; the
// biomarker retest classifier and the fitness-check freshness policy are both adapters
// over it, so these tests pin the boundary the two domains inherit.

describe("freshnessState", () => {
  it("is current up to and including the interval, due strictly after", () => {
    expect(freshnessState(89, 90)).toBe("current");
    expect(freshnessState(90, 90)).toBe("current");
    expect(freshnessState(91, 90)).toBe("due");
  });

  it("a reading measured today is current", () => {
    expect(freshnessState(0, 90)).toBe("current");
  });

  it("has no verdict without an age", () => {
    expect(freshnessState(null, 90)).toBe("not-applicable");
    expect(freshnessState(undefined, 90)).toBe("not-applicable");
  });

  it("has no verdict without a positive interval — no clock, not overdue", () => {
    expect(freshnessState(4000, null)).toBe("not-applicable");
    expect(freshnessState(4000, 0)).toBe("not-applicable");
    expect(freshnessState(4000, -30)).toBe("not-applicable");
  });

  it("an exempt reading is never due, however old", () => {
    expect(freshnessState(9999, 90, { exempt: true })).toBe("not-applicable");
  });
});

describe("freshnessAgeDays", () => {
  it("counts whole days between two ISO dates", () => {
    expect(freshnessAgeDays("2026-01-01", "2026-01-31")).toBe(30);
  });

  it("is null when either side is missing or unparseable", () => {
    expect(freshnessAgeDays(null, "2026-01-31")).toBeNull();
    expect(freshnessAgeDays("2026-01-01", null)).toBeNull();
    expect(freshnessAgeDays("not-a-date", "2026-01-31")).toBeNull();
  });
});

describe("tallyFreshness", () => {
  it("counts each state separately and never folds not-applicable into due", () => {
    const states: FreshnessState[] = [
      "current",
      "current",
      "due",
      "not-applicable",
    ];
    expect(tallyFreshness(states)).toEqual({
      current: 2,
      due: 1,
      notApplicable: 1,
    });
  });

  it("an empty set has nothing current", () => {
    expect(hasNoCurrentReading(tallyFreshness([]))).toBe(true);
  });

  it("hasNoCurrentReading is false as soon as one reading is current", () => {
    expect(hasNoCurrentReading(tallyFreshness(["due", "current"]))).toBe(false);
  });
});

describe("biomarkerRetestStatus is an adapter over the shared decision", () => {
  it("agrees with freshnessState on the age/interval boundary", () => {
    // A lab reading against a 90-day cadence: current at exactly 90 days, due at 91.
    expect(biomarkerRetestStatus("2026-01-01", "lab", "2026-04-01", 90)).toBe(
      freshnessState(90, 90)
    );
    expect(biomarkerRetestStatus("2026-01-01", "lab", "2026-04-02", 90)).toBe(
      freshnessState(91, 90)
    );
  });

  it("keeps its own domain exemptions (genomics carries no clock at all)", () => {
    expect(
      biomarkerRetestStatus("2000-01-01", "genomics", "2026-04-01", 90)
    ).toBe("not-applicable");
  });
});
