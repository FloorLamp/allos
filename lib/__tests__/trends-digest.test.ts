import { describe, it, expect } from "vitest";
import { summarizeTrends, type DigestSeries } from "../trends-digest";

// Two points 10 days apart, so `days` is a predictable 10 in the labels.
function series(
  key: string,
  first: number,
  last: number,
  extra: Partial<DigestSeries> = {}
): DigestSeries {
  return {
    key,
    label: extra.label ?? key,
    points: [
      { date: "2024-01-01", value: first },
      { date: "2024-01-11", value: last },
    ],
    ...extra,
  };
}

describe("summarizeTrends — exclusions", () => {
  it("excludes series with fewer than two points", () => {
    const s: DigestSeries = {
      key: "weight",
      label: "Weight",
      points: [{ date: "2024-01-01", value: 80 }],
    };
    expect(summarizeTrends([s])).toEqual([]);
  });

  it("excludes a flat series (no net change)", () => {
    expect(
      summarizeTrends([series("weight", 80, 80, { label: "Weight" })])
    ).toEqual([]);
  });

  it("excludes a sub-threshold move with no range crossing", () => {
    // 2% change, default threshold 5%.
    expect(summarizeTrends([series("weight", 100, 102)])).toEqual([]);
  });

  it("excludes empty input without erroring", () => {
    expect(summarizeTrends([])).toEqual([]);
  });
});

describe("summarizeTrends — direction, magnitude, labels", () => {
  it("labels a downward percentage move", () => {
    const [item] = summarizeTrends([
      series("resting_hr", 64, 60, { label: "Resting HR", unit: " bpm" }),
    ]);
    expect(item.direction).toBe("down");
    expect(item.days).toBe(10);
    // (60-64)/64 = -6.25% → rounds to 6%
    expect(item.text).toBe("Resting HR ↓ 6% over 10d");
  });

  it("labels an upward percentage move", () => {
    const [item] = summarizeTrends([
      series("weight", 80, 88, { label: "Weight" }),
    ]);
    expect(item.direction).toBe("up");
    expect(item.text).toBe("Weight ↑ 10% over 10d");
  });

  it("uses an absolute-change label when the first value is 0", () => {
    const [item] = summarizeTrends([
      series("volume", 0, 1500, { label: "Volume", unit: " kg" }),
    ]);
    expect(item.pctChange).toBeNull();
    expect(item.text).toBe("Volume ↑ 1500 kg over 10d");
  });
});

describe("summarizeTrends — reference-range crossings", () => {
  const range = { low: 0, high: 100 };

  it("flags a move that goes out of range (into high) even when small", () => {
    const [item] = summarizeTrends([
      series("bio:LDL", 99, 101, {
        label: "LDL",
        range: { low: null, high: 100 },
      }),
    ]);
    expect(item.rangeShift).toBe("out-of-range");
    expect(item.lastStatus).toBe("above");
    expect(item.text).toBe("LDL ↑ 2% over 10d — into high range");
  });

  it("flags a move that goes below range", () => {
    const [item] = summarizeTrends([
      series("bio:Iron", 50, -5, { label: "Iron", range }),
    ]);
    expect(item.rangeShift).toBe("out-of-range");
    expect(item.lastStatus).toBe("below");
    expect(item.text).toContain("— into low range");
  });

  it("flags a move back into range", () => {
    const [item] = summarizeTrends([
      series("bio:LDL", 130, 90, { label: "LDL", range }),
    ]);
    expect(item.rangeShift).toBe("into-range");
    expect(item.text).toContain("— back into range");
  });

  it("does not flag a move that stays in range", () => {
    const [item] = summarizeTrends([
      series("bio:LDL", 40, 60, { label: "LDL", range }),
    ]);
    expect(item.rangeShift).toBeNull();
  });

  // A range with a non-zero low so "below" endpoints are expressible.
  const bounded = { low: 40, high: 100 };

  it("flags a full below→above swing as crossing the range (low→high)", () => {
    const [item] = summarizeTrends([
      series("bio:Iron", 30, 120, { label: "Iron", range: bounded }),
    ]);
    expect(item.rangeShift).toBe("through-range");
    expect(item.lastStatus).toBe("above");
    expect(item.text).toContain("— crossed the range low→high");
  });

  it("flags a full above→below swing as crossing the range (high→low)", () => {
    const [item] = summarizeTrends([
      series("bio:Iron", 120, 30, { label: "Iron", range: bounded }),
    ]);
    expect(item.rangeShift).toBe("through-range");
    expect(item.lastStatus).toBe("below");
    expect(item.text).toContain("— crossed the range high→low");
  });

  it("does NOT flag a move that stays out on the same side (both above)", () => {
    const [item] = summarizeTrends([
      series("bio:LDL", 110, 130, { label: "LDL", range: bounded }),
    ]);
    // Both endpoints above range — only magnitude, no range annotation.
    expect(item.rangeShift).toBeNull();
    expect(item.text).toBe("LDL ↑ 18% over 10d");
  });

  it("does NOT flag a move that stays out on the same side (both below)", () => {
    const [item] = summarizeTrends([
      series("bio:Iron", 30, 20, { label: "Iron", range: bounded }),
    ]);
    expect(item.rangeShift).toBeNull();
    expect(item.text).not.toContain("range");
  });

  it("ranks a through-range swing above an into-range move but below out-of-range", () => {
    const items = summarizeTrends([
      series("bio:In", 130, 90, { label: "In", range: bounded }), // into-range (500)
      series("bio:Through", 30, 120, { label: "Through", range: bounded }), // through (750)
      series("bio:Out", 90, 130, { label: "Out", range: bounded }), // out-of-range (1000)
    ]);
    expect(items.map((i) => i.key)).toEqual([
      "bio:Out",
      "bio:Through",
      "bio:In",
    ]);
  });
});

describe("summarizeTrends — ranking and limit", () => {
  it("ranks range crossings above ordinary moves", () => {
    const items = summarizeTrends([
      series("weight", 100, 150, { label: "Weight" }), // +50%, no range
      series("bio:LDL", 99, 101, {
        label: "LDL",
        range: { low: null, high: 100 },
      }), // tiny, but out of range
    ]);
    expect(items[0].key).toBe("bio:LDL");
    expect(items[1].key).toBe("weight");
  });

  it("respects the limit", () => {
    const many = [
      series("a", 100, 200, { label: "A" }),
      series("b", 100, 190, { label: "B" }),
      series("c", 100, 180, { label: "C" }),
    ];
    expect(summarizeTrends(many, { limit: 2 })).toHaveLength(2);
  });

  it("breaks magnitude ties by label", () => {
    const items = summarizeTrends([
      series("z", 100, 150, { label: "Zeta" }),
      series("a", 100, 150, { label: "Alpha" }),
    ]);
    expect(items.map((i) => i.label)).toEqual(["Alpha", "Zeta"]);
  });

  it("honors a custom minPctChange threshold", () => {
    // 3% move: excluded at default 5%, included at 2%.
    expect(summarizeTrends([series("w", 100, 103)])).toEqual([]);
    expect(
      summarizeTrends([series("w", 100, 103)], { minPctChange: 0.02 })
    ).toHaveLength(1);
  });
});
