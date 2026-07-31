import { describe, it, expect } from "vitest";
import {
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
