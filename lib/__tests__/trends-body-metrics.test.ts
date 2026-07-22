import { describe, it, expect } from "vitest";
import {
  BODY_METRIC_META,
  BODY_METRIC_SLUGS,
  isBodyMetricSlug,
  resolveBodyMetricUnit,
  last30DaySlice,
  buildBodyMetricTile,
  orderBodyMetricTiles,
  bodyMetricPeriodStats,
  type OrderableTile,
} from "@/lib/trends-body-metrics";

// #1067 Phase 2 — the pure body-metric registry + tile/stat math backing the Trends
// → Body sparkline grid and its per-metric detail pages.

describe("BODY_METRIC_META registry", () => {
  it("has an entry per slug, keyed by its own slug, with a matching detail href", () => {
    for (const slug of BODY_METRIC_SLUGS) {
      const meta = BODY_METRIC_META[slug];
      expect(meta).toBeTruthy();
      expect(meta.slug).toBe(slug);
    }
    // Every registry key is a declared slug (no orphans).
    for (const key of Object.keys(BODY_METRIC_META)) {
      expect(isBodyMetricSlug(key)).toBe(true);
    }
  });

  it("gives every metric a distinct base order", () => {
    const orders = BODY_METRIC_SLUGS.map((s) => BODY_METRIC_META[s].order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("only weight carries the login weight-unit suffix; others are static", () => {
    expect(resolveBodyMetricUnit(BODY_METRIC_META.weight, "lb")).toBe(" lb");
    expect(resolveBodyMetricUnit(BODY_METRIC_META.weight, "kg")).toBe(" kg");
    // resting-hr's suffix ignores the weight unit.
    expect(resolveBodyMetricUnit(BODY_METRIC_META["resting-hr"], "lb")).toBe(
      " bpm"
    );
    expect(resolveBodyMetricUnit(BODY_METRIC_META.bmi, "lb")).toBe("");
  });

  it("marks body composition + growth as windowed, synced daily metrics as not", () => {
    expect(BODY_METRIC_META.weight.windowed).toBe(true);
    expect(BODY_METRIC_META.height.windowed).toBe(true);
    expect(BODY_METRIC_META.steps.windowed).toBe(false);
    expect(BODY_METRIC_META.hr.windowed).toBe(false);
  });
});

describe("last30DaySlice", () => {
  const today = "2026-07-22";
  it("keeps only the trailing 30 days (today − 29 … today, inclusive)", () => {
    const points = [
      { date: "2026-05-01", value: 1 }, // > 30d ago → dropped
      { date: "2026-06-23", value: 2 }, // exactly 29 days before today → kept
      { date: "2026-06-22", value: 9 }, // 30 days before → dropped
      { date: "2026-07-22", value: 3 }, // today → kept
    ];
    const sliced = last30DaySlice(points, today);
    expect(sliced.map((p) => p.value)).toEqual([2, 3]);
  });
});

describe("buildBodyMetricTile", () => {
  const today = "2026-07-22";
  it("shapes a tile from the full series' 30-day tail, presence over the full series", () => {
    const full = [
      { date: "2026-01-01", value: 80 }, // old — outside the 30d tail
      { date: "2026-07-10", value: 78 },
      { date: "2026-07-20", value: 77 },
    ];
    const tile = buildBodyMetricTile(
      BODY_METRIC_META.weight,
      full,
      "kg",
      today
    );
    expect(tile.slug).toBe("weight");
    expect(tile.href).toBe("/trends/metric/weight");
    expect(tile.unit).toBe(" kg");
    expect(tile.present).toBe(true);
    expect(tile.latestDate).toBe("2026-07-20");
    // Only the trailing-30d points make the sparkline.
    expect(tile.points.map((p) => p.value)).toEqual([78, 77]);
  });

  it("is absent (present=false) for an empty series", () => {
    const tile = buildBodyMetricTile(BODY_METRIC_META.steps, [], "kg", today);
    expect(tile.present).toBe(false);
    expect(tile.latestDate).toBeNull();
    expect(tile.points).toEqual([]);
  });
});

describe("orderBodyMetricTiles", () => {
  it("drops absent tiles and sorts present ones most-recent-first, ties by order", () => {
    const tiles: OrderableTile[] = [
      { slug: "bmi", id: "bmi", label: "BMI", present: false, latestDate: null, order: 7 },
      { slug: "weight", id: "weight", label: "Weight", present: true, latestDate: "2026-07-01", order: 0 },
      { slug: "steps", id: "steps", label: "Steps", present: true, latestDate: "2026-07-20", order: 5 },
      { slug: "sleep", id: "sleep", label: "Sleep", present: true, latestDate: "2026-07-20", order: 1 },
    ];
    const ordered = orderBodyMetricTiles(tiles);
    // Absent BMI dropped; the two 2026-07-20 entries tie and break by base order
    // (sleep 1 before steps 5); weight (older) last.
    expect(ordered.map((t) => t.slug)).toEqual(["sleep", "steps", "weight"]);
  });
});

describe("bodyMetricPeriodStats", () => {
  const today = "2026-07-22";
  it("computes latest/avg/min/max/delta over 7/30/90-day trailing windows", () => {
    const points = [
      { date: "2026-04-25", value: 100 }, // ~88d ago → only in the 90d window
      { date: "2026-07-01", value: 80 }, // ~21d ago → in 30d + 90d
      { date: "2026-07-20", value: 76 }, // 2d ago → all windows
      { date: "2026-07-22", value: 78 }, // today → all windows
    ];
    const [w7, w30, w90] = bodyMetricPeriodStats(points, today, 1);

    expect(w7.count).toBe(2);
    expect(w7.latest).toBe(78);
    expect(w7.min).toBe(76);
    expect(w7.max).toBe(78);
    expect(w7.delta).toBe(2); // 78 − 76

    expect(w30.count).toBe(3);
    expect(w30.min).toBe(76);
    expect(w30.max).toBe(80);
    expect(w30.delta).toBe(-2); // 78 − 80

    expect(w90.count).toBe(4);
    expect(w90.max).toBe(100);
    expect(w90.avg).toBe(83.5); // (100+80+76+78)/4
  });

  it("reports nulls for a window with no readings", () => {
    const [w7] = bodyMetricPeriodStats(
      [{ date: "2026-01-01", value: 5 }],
      today
    );
    expect(w7.count).toBe(0);
    expect(w7.latest).toBeNull();
    expect(w7.delta).toBeNull();
  });
});
