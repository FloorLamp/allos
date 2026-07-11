import { describe, it, expect } from "vitest";
import {
  summarizeTrends,
  robustSeriesSummary,
  type DigestSeries,
} from "../trends-digest";

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

// Build an n-point series from raw values, one day apart, so `days` is n-1.
function valueSeries(
  key: string,
  values: number[],
  extra: Partial<DigestSeries> = {}
): DigestSeries {
  return {
    key,
    label: extra.label ?? key,
    points: values.map((v, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      value: v,
    })),
    ...extra,
  };
}

describe("summarizeTrends — robust endpoints (#37)", () => {
  it("does NOT flag a trend created by a single spiking endpoint", () => {
    // Weight is flat at 80, but the very last reading spikes to 95. The literal
    // first-vs-last delta is +18.75% (old failure mode); the median of the last 3
    // is still 80, so there's no real move and the series is excluded.
    const flatWithSpike = valueSeries("weight", [80, 80, 80, 80, 80, 95], {
      label: "Weight",
    });
    expect(summarizeTrends([flatWithSpike])).toEqual([]);
  });

  it("still flags a genuine sustained move using robust endpoints", () => {
    // A real level shift 80 → 88: robust first (median 80) vs robust last
    // (median 88) = +10%, comfortably over threshold.
    const [item] = summarizeTrends([
      valueSeries("weight", [80, 80, 80, 88, 88, 88], { label: "Weight" }),
    ]);
    expect(item.first).toBe(80);
    expect(item.last).toBe(88);
    expect(item.direction).toBe("up");
    expect(item.pctChange).toBeCloseTo(0.1, 6);
    // `days` still spans the whole window (6 points, one day apart → 5 days).
    expect(item.days).toBe(5);
  });

  it("keeps exact first-vs-last behavior for a 3-point series (k=1)", () => {
    // floor(3/2)=1 → robust endpoints are the raw first/last points, mid ignored.
    const [item] = summarizeTrends([
      valueSeries("weight", [80, 999, 88], { label: "Weight" }),
    ]);
    expect(item.first).toBe(80);
    expect(item.last).toBe(88);
  });
});

describe("summarizeTrends — per-series thresholds (#37)", () => {
  it("uses a per-series minPctChange over the global default", () => {
    // A 3% move: kept because this series sets a 2% bar, despite the 5% default.
    const [item] = summarizeTrends([
      series("weight", 100, 103, { label: "Weight", minPctChange: 0.02 }),
    ]);
    expect(item.key).toBe("weight");
  });

  it("a strict per-series threshold excludes a move the global default would keep", () => {
    // A 10% move that clears the 5% default but not this series' 15% bar.
    expect(
      summarizeTrends([
        series("volume", 100, 110, { label: "Volume", minPctChange: 0.15 }),
      ])
    ).toEqual([]);
  });

  it("per-series threshold overrides the global option too", () => {
    // Global bar 0.20 would drop a 10% move, but the series pins its own 0.05.
    const [item] = summarizeTrends(
      [series("w", 100, 110, { label: "W", minPctChange: 0.05 })],
      { minPctChange: 0.2 }
    );
    expect(item.key).toBe("w");
  });
});

describe("robustSeriesSummary — shared tile/digest core (#398)", () => {
  it("returns null for fewer than two finite points", () => {
    expect(robustSeriesSummary({ points: [] })).toBeNull();
    expect(
      robustSeriesSummary({ points: [{ value: 5 }, { value: null }] })
    ).toBeNull();
  });

  it("uses ROBUST endpoints, not the literal last, so a lone noisy endpoint is not a trend", () => {
    // #398 failure scenario: resting HR with a watch artifact as the last reading.
    const points = [
      { value: 62 },
      { value: 61 },
      { value: 62 },
      { value: 61 },
      { value: 62 },
      { value: 55 },
    ];
    const summary = robustSeriesSummary({ points, minPctChange: 0.05 });
    // Literal first−last would be 55−62 = −7 (an 11% "drop"); robust endpoints
    // (median of first/last 3) barely move, so the tile shows NO arrow…
    expect(summary?.material).toBe(false);
    expect(Math.abs(summary!.absChange)).toBeLessThan(2);
  });

  it("agrees with summarizeTrends: same verdict on the same series", () => {
    // The whole point of #398 — the tile badge and the digest chip share one core.
    const noisy: DigestSeries = {
      key: "metric:resting_hr",
      label: "Resting heart rate",
      minPctChange: 0.05,
      points: [
        { date: "2024-01-01", value: 62 },
        { date: "2024-01-02", value: 61 },
        { date: "2024-01-03", value: 62 },
        { date: "2024-01-04", value: 61 },
        { date: "2024-01-05", value: 62 },
        { date: "2024-01-06", value: 55 },
      ],
    };
    // Digest excludes it (no chip)…
    expect(summarizeTrends([noisy])).toEqual([]);
    // …and the tile core reports the same "not material" verdict.
    expect(robustSeriesSummary(noisy)?.material).toBe(false);

    // A genuine, sustained move: both surfaces agree it IS trending, on the same
    // robust first/last values summarizeTrends reports.
    const real: DigestSeries = {
      key: "metric:resting_hr",
      label: "Resting heart rate",
      minPctChange: 0.05,
      points: [
        { date: "2024-01-01", value: 62 },
        { date: "2024-01-02", value: 61 },
        { date: "2024-01-03", value: 62 },
        { date: "2024-01-04", value: 54 },
        { date: "2024-01-05", value: 55 },
        { date: "2024-01-06", value: 54 },
      ],
    };
    const [item] = summarizeTrends([real]);
    const summary = robustSeriesSummary(real);
    expect(summary?.material).toBe(true);
    expect(item.first).toBe(summary!.first);
    expect(item.last).toBe(summary!.last);
    expect(item.absChange).toBe(summary!.absChange);
  });

  it("honors a reference-range crossing even below the pct bar (parity with the digest)", () => {
    const s: DigestSeries = {
      key: "bio:LDL",
      label: "LDL",
      minPctChange: 0.5, // absurdly high bar so only the range cross can qualify
      range: { low: null, high: 100 },
      points: [
        { date: "2024-01-01", value: 98 },
        { date: "2024-01-11", value: 101 },
      ],
    };
    // Small % move but it crossed into high range: digest keeps it, tile agrees.
    expect(summarizeTrends([s]).length).toBe(1);
    expect(robustSeriesSummary(s)?.material).toBe(true);
  });
});
