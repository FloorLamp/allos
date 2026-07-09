import { describe, it, expect } from "vitest";
import {
  alignSeries,
  pairedPoints,
  pearson,
  normalizeAligned,
  describeCorrelation,
} from "../trends-compare";

describe("alignSeries", () => {
  it("aligns onto the sorted union of dates with nulls for gaps", () => {
    const a = [
      { date: "2024-01-01", value: 10 },
      { date: "2024-01-03", value: 30 },
    ];
    const b = [
      { date: "2024-01-02", value: 200 },
      { date: "2024-01-03", value: 300 },
    ];
    expect(alignSeries(a, b)).toEqual([
      { date: "2024-01-01", a: 10, b: null },
      { date: "2024-01-02", a: null, b: 200 },
      { date: "2024-01-03", a: 30, b: 300 },
    ]);
  });

  it("collapses duplicate dates (last write wins) and drops non-finite values", () => {
    const a = [
      { date: "2024-01-01", value: 1 },
      { date: "2024-01-01", value: 2 },
      { date: "2024-01-02", value: NaN },
    ];
    expect(alignSeries(a, [])).toEqual([{ date: "2024-01-01", a: 2, b: null }]);
  });

  it("returns [] for two empty series", () => {
    expect(alignSeries([], [])).toEqual([]);
  });
});

describe("pairedPoints", () => {
  it("keeps only rows where both are present", () => {
    const aligned = [
      { date: "d1", a: 1, b: null },
      { date: "d2", a: 2, b: 20 },
      { date: "d3", a: null, b: 30 },
    ];
    expect(pairedPoints(aligned)).toEqual([{ a: 2, b: 20 }]);
  });
});

describe("pearson", () => {
  it("is +1 for a perfectly increasing linear relationship", () => {
    const aligned = alignSeries(
      [
        { date: "d1", value: 1 },
        { date: "d2", value: 2 },
        { date: "d3", value: 3 },
      ],
      [
        { date: "d1", value: 10 },
        { date: "d2", value: 20 },
        { date: "d3", value: 30 },
      ]
    );
    expect(pearson(aligned)).toBeCloseTo(1, 10);
  });

  it("is -1 for a perfectly inverse relationship", () => {
    const aligned = alignSeries(
      [
        { date: "d1", value: 1 },
        { date: "d2", value: 2 },
        { date: "d3", value: 3 },
      ],
      [
        { date: "d1", value: 30 },
        { date: "d2", value: 20 },
        { date: "d3", value: 10 },
      ]
    );
    expect(pearson(aligned)).toBeCloseTo(-1, 10);
  });

  it("is null with fewer than two shared dates", () => {
    const aligned = alignSeries(
      [{ date: "d1", value: 1 }],
      [{ date: "d2", value: 2 }]
    );
    expect(pearson(aligned)).toBeNull();
  });

  it("is null when a series is constant (zero variance)", () => {
    const aligned = alignSeries(
      [
        { date: "d1", value: 5 },
        { date: "d2", value: 5 },
      ],
      [
        { date: "d1", value: 1 },
        { date: "d2", value: 2 },
      ]
    );
    expect(pearson(aligned)).toBeNull();
  });

  it("stays within [-1, 1]", () => {
    const aligned = alignSeries(
      [
        { date: "d1", value: 3 },
        { date: "d2", value: 1 },
        { date: "d3", value: 8 },
        { date: "d4", value: 2 },
      ],
      [
        { date: "d1", value: 7 },
        { date: "d2", value: 2 },
        { date: "d3", value: 9 },
        { date: "d4", value: 4 },
      ]
    );
    const r = pearson(aligned);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThanOrEqual(-1);
    expect(r!).toBeLessThanOrEqual(1);
  });
});

describe("normalizeAligned", () => {
  it("min-max scales each axis to [0,1] independently and preserves nulls", () => {
    const aligned = [
      { date: "d1", a: 10, b: 100 },
      { date: "d2", a: 20, b: null },
      { date: "d3", a: 30, b: 300 },
    ];
    expect(normalizeAligned(aligned)).toEqual([
      { date: "d1", a: 0, b: 0 },
      { date: "d2", a: 0.5, b: null },
      { date: "d3", a: 1, b: 1 },
    ]);
  });

  it("maps a constant axis to 0.5", () => {
    const aligned = [
      { date: "d1", a: 7, b: 1 },
      { date: "d2", a: 7, b: 2 },
    ];
    const out = normalizeAligned(aligned);
    expect(out[0].a).toBe(0.5);
    expect(out[1].a).toBe(0.5);
  });
});

describe("describeCorrelation", () => {
  it("returns null for null r", () => {
    expect(describeCorrelation(null)).toBeNull();
  });

  it("classifies strength and sign by |r| thresholds", () => {
    expect(describeCorrelation(0.9)).toMatchObject({
      strength: "strong",
      sign: "positive",
    });
    expect(describeCorrelation(-0.6)).toMatchObject({
      strength: "moderate",
      sign: "negative",
    });
    expect(describeCorrelation(0.4)).toMatchObject({
      strength: "weak",
      sign: "positive",
    });
    expect(describeCorrelation(0.1)).toMatchObject({
      strength: "none",
      sign: "none",
    });
  });
});
