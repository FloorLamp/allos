import { describe, it, expect } from "vitest";
import { summarizeStepsToday, STEPS_TRAILING_DAYS } from "@/lib/steps-today";

// Pure-tier: the Steps-today dashboard aggregation (#1221). No DB/clock — the gather
// hands the deduped one-source-per-day series here.

const TODAY = "2026-07-23";

describe("summarizeStepsToday", () => {
  it("returns null for an empty series (the data-aware empty state)", () => {
    expect(summarizeStepsToday([], TODAY)).toBeNull();
  });

  it("reports today's steps and the trailing 7-day average with an up arrow", () => {
    const points = [
      { date: "2026-07-16", value: 6000 },
      { date: "2026-07-17", value: 7000 },
      { date: "2026-07-18", value: 8000 },
      { date: "2026-07-22", value: 5000 },
      { date: TODAY, value: 10000 },
    ];
    const s = summarizeStepsToday(points, TODAY)!;
    expect(s.today).toBe(10000);
    // Average over the 4 prior data days: (6000+7000+8000+5000)/4 = 6500.
    expect(s.average7).toBe(6500);
    expect(s.direction).toBe("up");
    expect(s.deltaPct).toBe(Math.round(((10000 - 6500) / 6500) * 100));
  });

  it("caps the trailing average to the most recent N data days before today", () => {
    // 9 prior days all before today; only the newest STEPS_TRAILING_DAYS count.
    const prior = Array.from({ length: 9 }, (_, i) => ({
      date: `2026-07-${String(10 + i).padStart(2, "0")}`,
      value: (i + 1) * 1000, // 1000..9000, oldest→newest
    }));
    const s = summarizeStepsToday(
      [...prior, { date: TODAY, value: 500 }],
      TODAY
    )!;
    // The 7 most-recent prior days are 3000..9000 → mean 6000.
    const expected = Math.round(
      prior.slice(-STEPS_TRAILING_DAYS).reduce((a, p) => a + p.value, 0) /
        STEPS_TRAILING_DAYS
    );
    expect(s.average7).toBe(expected);
    expect(s.direction).toBe("down"); // 500 < 6000
  });

  it("handles history with no reading today (today null, average present)", () => {
    const s = summarizeStepsToday(
      [
        { date: "2026-07-21", value: 8000 },
        { date: "2026-07-22", value: 9000 },
      ],
      TODAY
    )!;
    expect(s.today).toBeNull();
    expect(s.average7).toBe(8500);
    expect(s.direction).toBeNull();
    expect(s.deltaPct).toBeNull();
  });

  it("marks a flat day when today equals the trailing average", () => {
    const s = summarizeStepsToday(
      [
        { date: "2026-07-22", value: 7000 },
        { date: TODAY, value: 7000 },
      ],
      TODAY
    )!;
    expect(s.direction).toBe("flat");
    expect(s.deltaPct).toBe(0);
  });
});
