import { describe, it, expect } from "vitest";
import {
  decodePolyline,
  routeBounds,
  polylineToSvg,
  encodedPolylineToSvg,
} from "../polyline";

describe("decodePolyline", () => {
  it("decodes the canonical Google example vector", () => {
    // From the Google polyline algorithm docs: three points.
    const pts = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it("round-trips a simple synthetic route", () => {
    // A small closed-ish loop (public-park style, no residential anchor).
    const pts = decodePolyline("k{~dHntopN?_ibE_ibE??~hbE~hbE");
    expect(pts.length).toBeGreaterThanOrEqual(2);
  });

  it("returns [] for empty / non-string input", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
  });

  it("stops cleanly on a truncated buffer (no throw)", () => {
    // A single lone continuation byte can't complete a delta — must not throw.
    expect(() => decodePolyline("_")).not.toThrow();
  });
});

describe("routeBounds", () => {
  it("computes the bounding box", () => {
    expect(
      routeBounds([
        [10, 20],
        [12, 18],
        [11, 25],
      ])
    ).toEqual({ minLat: 10, maxLat: 12, minLng: 18, maxLng: 25 });
  });
  it("is null for no points", () => {
    expect(routeBounds([])).toBeNull();
  });
});

describe("polylineToSvg", () => {
  it("projects into the viewBox with padding, north up", () => {
    const svg = polylineToSvg(
      [
        [10, 20],
        [11, 21],
        [10, 22],
      ],
      { width: 100, height: 100, padding: 4 }
    );
    expect(svg).not.toBeNull();
    const s = svg!;
    expect(s.width).toBe(100);
    expect(s.d.startsWith("M")).toBe(true);
    // Every projected point sits inside the padded box.
    for (const p of s.points) {
      expect(p.x).toBeGreaterThanOrEqual(4);
      expect(p.x).toBeLessThanOrEqual(96);
      expect(p.y).toBeGreaterThanOrEqual(4);
      expect(p.y).toBeLessThanOrEqual(96);
    }
    // North is up: the northernmost point (lat 11) has the smallest y.
    const ys = s.points.map((p) => p.y);
    expect(Math.min(...ys)).toBe(s.points[1].y);
  });

  it("returns null for fewer than two points", () => {
    expect(polylineToSvg([[10, 20]])).toBeNull();
    expect(polylineToSvg([])).toBeNull();
  });

  it("does not divide-by-zero on a degenerate (identical-point) route", () => {
    const svg = polylineToSvg([
      [10, 20],
      [10, 20],
    ]);
    // Two identical points: still returns a (tiny) path, no NaN.
    expect(svg).not.toBeNull();
    for (const p of svg!.points) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("encodedPolylineToSvg", () => {
  it("decodes and projects in one call", () => {
    const svg = encodedPolylineToSvg("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(svg).not.toBeNull();
    expect(svg!.points).toHaveLength(3);
  });
  it("is null for an undrawable polyline", () => {
    expect(encodedPolylineToSvg("")).toBeNull();
  });
});
