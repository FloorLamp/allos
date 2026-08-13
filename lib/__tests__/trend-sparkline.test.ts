import { describe, it, expect } from "vitest";
import {
  loneReading,
  sparklineShapeForMetric,
  sparklineShapeForSeriesKey,
} from "../trend-sparkline";

// Which MARK a trend tile draws (#1485 D). The rule is a claim about the DATA, not
// a style preference: a line asserts the quantity existed between two readings and
// moved smoothly between them. True of a level (weight, an analyte); false of a
// per-day total whose missing days are real zeros (training volume), where the line
// draws a slope across a rest day that had no training in it.
describe("sparklineShapeForMetric", () => {
  it("draws a per-day quantity as bars", () => {
    expect(sparklineShapeForMetric("volume")).toBe("bar");
  });

  it("draws every level as a line", () => {
    expect(sparklineShapeForMetric("weight")).toBe("line");
    expect(sparklineShapeForMetric("bodyfat")).toBe("line");
    expect(sparklineShapeForMetric("resting_hr")).toBe("line");
  });

  // The safe default matters in the asymmetric direction: a level drawn as bars
  // merely looks odd, while a quantity drawn as a line asserts something false.
  it("falls back to the line for an unknown metric", () => {
    expect(sparklineShapeForMetric("steps")).toBe("line");
    expect(sparklineShapeForMetric("")).toBe("line");
  });
});

describe("sparklineShapeForSeriesKey", () => {
  it("keys on the shared series vocabulary", () => {
    expect(sparklineShapeForSeriesKey("metric:volume")).toBe("bar");
    expect(sparklineShapeForSeriesKey("metric:weight")).toBe("line");
  });

  // A biomarker is always a level — an analyte has a value on the days between
  // draws — so no `bio:` key is ever bar-shaped, whatever it is called.
  it("never bars a biomarker, including one named like a metric", () => {
    expect(sparklineShapeForSeriesKey("bio:LDL Cholesterol")).toBe("line");
    expect(sparklineShapeForSeriesKey("bio:volume")).toBe("line");
  });

  it("falls back to the line for an unprefixed or empty key", () => {
    expect(sparklineShapeForSeriesKey("volume")).toBe("line");
    expect(sparklineShapeForSeriesKey("")).toBe("line");
  });
});

describe("loneReading (#2615 item 3)", () => {
  it("returns the one point a series has", () => {
    expect(
      loneReading([
        { date: "2026-07-13", value: null },
        { date: "2026-07-14", value: 118 },
        { date: "2026-07-15", value: null },
      ])
    ).toEqual({ date: "2026-07-14", value: 118 });
  });

  it("counts non-null points, so a densified window is still one reading", () => {
    // #2258 fills a day-grain series to the calendar, so the array length is the window
    // and says nothing about how many readings are in it. A predicate keyed on length
    // would draw a 30-point plot for one reading, which is the defect.
    const filled = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, "0")}`,
      value: i === 12 ? 118 : null,
    }));
    expect(loneReading(filled)?.date).toBe("2026-07-13");
  });

  it("answers null for an empty series and for two or more readings", () => {
    expect(loneReading([])).toBeNull();
    expect(loneReading([{ date: "2026-07-13", value: null }])).toBeNull();
    expect(
      loneReading([
        { date: "2026-07-13", value: 118 },
        { date: "2026-07-14", value: 121 },
      ])
    ).toBeNull();
  });
});
