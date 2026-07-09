import { describe, it, expect } from "vitest";
import {
  median,
  medianAbsoluteDeviation,
  pairwiseSlopesPerDay,
  theilSenSlopePerDay,
  robustEndpoints,
} from "../robust-stats";

describe("median", () => {
  it("returns the middle element for odd lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("averages the two middle elements for even lengths", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 2])).toBe(6);
  });

  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("is unmoved by a single extreme outlier the mean would chase", () => {
    // mean = 208.6, but the median ignores the 1000 spike.
    expect(median([1, 2, 3, 4, 1000])).toBe(3);
  });

  it("returns NaN for an empty list", () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("measures spread and shrugs off a lone outlier", () => {
    // deviations from median 3 are [2,1,0,1,997] → median 1.
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 1000])).toBe(1);
  });

  it("is 0 for a constant list", () => {
    expect(medianAbsoluteDeviation([7, 7, 7])).toBe(0);
  });

  it("returns NaN for an empty list", () => {
    expect(Number.isNaN(medianAbsoluteDeviation([]))).toBe(true);
  });
});

describe("pairwiseSlopesPerDay", () => {
  it("enumerates every distinct-day pair slope", () => {
    const slopes = pairwiseSlopesPerDay([
      { date: "2026-01-01", value: 10 },
      { date: "2026-01-02", value: 12 },
      { date: "2026-01-03", value: 14 },
    ]);
    // (12-10)/1, (14-10)/2, (14-12)/1 → all 2.
    expect(slopes).toEqual([2, 2, 2]);
  });

  it("skips same-day pairs (undefined slope)", () => {
    const slopes = pairwiseSlopesPerDay([
      { date: "2026-01-01", value: 10 },
      { date: "2026-01-01", value: 20 },
      { date: "2026-01-02", value: 12 },
    ]);
    // Only the two cross-day pairs survive: (12-10)/1 and (12-20)/1.
    expect(slopes.sort((a, b) => a - b)).toEqual([-8, 2]);
  });
});

describe("theilSenSlopePerDay", () => {
  it("recovers a clean linear slope", () => {
    const slope = theilSenSlopePerDay([
      { date: "2026-01-01", value: 90 },
      { date: "2026-01-08", value: 89 },
      { date: "2026-01-15", value: 88 },
      { date: "2026-01-22", value: 87 },
    ]);
    expect(slope).toBeCloseTo(-1 / 7, 6);
  });

  it("resists an outlier that would bend OLS", () => {
    // A steady -1/week loss, but the middle reading spikes up 6 kg. Least squares
    // would flatten (even reverse) the slope; Theil–Sen keeps ~-1/7.
    const withOutlier = [
      { date: "2026-01-01", value: 90 },
      { date: "2026-01-08", value: 89 },
      { date: "2026-01-15", value: 95 }, // outlier spike
      { date: "2026-01-22", value: 87 },
      { date: "2026-01-29", value: 86 },
    ];
    const robust = theilSenSlopePerDay(withOutlier)!;
    expect(robust).toBeLessThan(0); // still clearly decreasing
    expect(robust).toBeCloseTo(-1 / 7, 1);
  });

  it("returns null when no pair spans any time (all same day)", () => {
    expect(
      theilSenSlopePerDay([
        { date: "2026-01-01", value: 1 },
        { date: "2026-01-01", value: 2 },
      ])
    ).toBeNull();
  });

  it("returns null for a single point", () => {
    expect(theilSenSlopePerDay([{ date: "2026-01-01", value: 1 }])).toBeNull();
  });
});

describe("robustEndpoints", () => {
  const pts = [
    { value: 100 },
    { value: 102 },
    { value: 101 },
    { value: 90 },
    { value: 92 },
    { value: 91 },
  ];

  it("takes the median of the first k and last k values", () => {
    // first 3 → median(100,102,101)=101; last 3 → median(90,92,91)=91.
    expect(robustEndpoints(pts, 3)).toEqual({ first: 101, last: 91 });
  });

  it("smooths a spiky endpoint that k=1 would trust blindly", () => {
    const spiky = [{ value: 200 }, { value: 100 }, { value: 101 }];
    // k=1 (raw first) would read first=200; the median of the first 2 is 150.
    expect(robustEndpoints(spiky, 1).first).toBe(200);
    expect(robustEndpoints([{ value: 200 }, { value: 100 }], 2).first).toBe(
      150
    );
  });

  it("clamps k to at least 1 and at most n", () => {
    const two = [{ value: 10 }, { value: 20 }];
    expect(robustEndpoints(two, 0)).toEqual({ first: 10, last: 20 });
    expect(robustEndpoints(two, 99)).toEqual({ first: 15, last: 15 });
  });
});
