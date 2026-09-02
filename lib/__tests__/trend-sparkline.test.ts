import { describe, it, expect } from "vitest";
import {
  loneReading,
  sourceSpreadCaption,
  sourceSpreadCompanions,
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
  // draws — so no `result:` key is ever bar-shaped, whatever it is called.
  it("never bars a biomarker, including one named like a metric", () => {
    expect(sparklineShapeForSeriesKey("result:LDL Cholesterol")).toBe("line");
    expect(sparklineShapeForSeriesKey("result:volume")).toBe("line");
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

describe("two sources, one day — the companion decision (#2653 state 6)", () => {
  const spread = (others: { source: string; value: number }[]) => ({
    trusted: "Withings",
    others,
  });

  it("draws a companion only where the other source prints a different number", () => {
    const print = (v: number) => v.toFixed(1);
    const out = sourceSpreadCompanions(
      [
        // Agrees to the printed digit: no fact to add, no mark.
        {
          date: "2026-07-20",
          value: 80.04,
          sources: spread([{ source: "Oura", value: 80.01 }]),
        },
        // Disagrees at the chart's precision: a companion.
        {
          date: "2026-07-21",
          value: 80.0,
          sources: spread([{ source: "Oura", value: 80.6 }]),
        },
        // One of two others agrees; only the disagreeing one survives.
        {
          date: "2026-07-22",
          value: 80.0,
          sources: spread([
            { source: "Manual", value: 80.02 },
            { source: "Oura", value: 81.0 },
          ]),
        },
        // A gap day and an uncontested day carry nothing.
        {
          date: "2026-07-23",
          value: null,
          sources: spread([{ source: "Oura", value: 1 }]),
        },
        { date: "2026-07-24", value: 79 },
      ],
      print
    );
    expect([...out.keys()]).toEqual(["2026-07-21", "2026-07-22"]);
    expect(out.get("2026-07-22")?.others).toEqual([
      { source: "Oura", value: 81.0 },
    ]);
  });

  it.each([
    [
      [["2026-07-21", ["Oura"]]],
      "Showing Withings · 1 day also reported by Oura",
    ],
    [
      [
        ["2026-07-21", ["Oura"]],
        ["2026-07-22", ["Oura", "Manual"]],
      ],
      "Showing Withings · 2 days also reported by Oura and Manual",
    ],
  ] as const)("captions the facts and takes no side: %j", (days, text) => {
    const spreads = new Map(
      days.map(([date, names]) => [
        date,
        spread(names.map((source) => ({ source, value: 1 }))),
      ])
    );
    expect(sourceSpreadCaption(spreads)).toBe(text);
  });
});
