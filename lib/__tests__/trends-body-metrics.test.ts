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
  it("drops absent tiles and sequences the rest by the tab's ranked card order", () => {
    const tiles: OrderableTile[] = [
      { slug: "bmi", id: "bmi", label: "BMI", present: false },
      { slug: "weight", id: "weight", label: "Weight", present: true },
      { slug: "steps", id: "steps", label: "Steps", present: true },
      { slug: "sleep", id: "sleep", label: "Sleep", present: true },
    ];
    // The order the tab's ranker produced — the tile grid is a formatter over it,
    // never a second sort (#1490 retired the per-surface recency sort).
    const ordered = orderBodyMetricTiles(tiles, [
      "sleep",
      "steps",
      "weight",
      "bmi",
    ]);
    expect(ordered.map((t) => t.slug)).toEqual(["sleep", "steps", "weight"]);
  });

  it("keeps an unranked tile rather than dropping it", () => {
    const ordered = orderBodyMetricTiles(
      [
        { slug: "sun", id: "sun", label: "Sun", present: true },
        { slug: "weight", id: "weight", label: "Weight", present: true },
      ],
      ["weight"]
    );
    expect(ordered.map((t) => t.slug)).toEqual(["weight", "sun"]);
  });
});
