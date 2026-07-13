import { describe, it, expect } from "vitest";
import { visitTenseForDate, initialVisitTense } from "@/lib/visit-entry";

const TODAY = "2026-07-13";

describe("visitTenseForDate", () => {
  it("routes a future date to the appointment (upcoming) branch", () => {
    expect(visitTenseForDate("2026-08-01", TODAY)).toBe("upcoming");
  });

  it("routes a strictly past date to the encounter (past) branch", () => {
    expect(visitTenseForDate("2026-06-30", TODAY)).toBe("past");
  });

  it("treats today as upcoming (a fresh entry defaults to scheduling)", () => {
    expect(visitTenseForDate(TODAY, TODAY)).toBe("upcoming");
  });
});

describe("initialVisitTense", () => {
  it("forces upcoming when a Book-CTA prefill is present, even for a past date", () => {
    expect(
      initialVisitTense({
        hasPrefill: true,
        focusNew: false,
        date: "2020-01-01",
        today: TODAY,
      })
    ).toBe("upcoming");
  });

  it("forces upcoming for a bare ?new=1 command-palette deep link", () => {
    expect(
      initialVisitTense({
        hasPrefill: false,
        focusNew: true,
        date: "2020-01-01",
        today: TODAY,
      })
    ).toBe("upcoming");
  });

  it("otherwise lets the seeded date decide the branch", () => {
    expect(
      initialVisitTense({
        hasPrefill: false,
        focusNew: false,
        date: "2026-06-01",
        today: TODAY,
      })
    ).toBe("past");
    expect(
      initialVisitTense({
        hasPrefill: false,
        focusNew: false,
        date: TODAY,
        today: TODAY,
      })
    ).toBe("upcoming");
  });
});
