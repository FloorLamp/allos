import { describe, it, expect } from "vitest";
import {
  BODY_METRIC_META,
  BODY_METRIC_SLUGS,
  isBodyMetricSlug,
  resolveBodyMetricUnit,
  buildBodyMetricTile,
  orderBodyMetricTiles,
  bodyMetricPeriodStats,
  collapseCoincidentPeriods,
  seriesCoverageNote,
  bodyChartScale,
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

describe("buildBodyMetricTile", () => {
  it("shapes a tile from the selected range, with presence over the full series", () => {
    const full = [
      { date: "2026-01-01", value: 80 },
      { date: "2026-07-10", value: 78 },
      { date: "2026-07-20", value: 77 },
    ];
    const tile = buildBodyMetricTile(BODY_METRIC_META.weight, full, "kg", {
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(tile.slug).toBe("weight");
    expect(tile.href).toBe("/trends/metric/weight");
    expect(tile.unit).toBe(" kg");
    expect(tile.present).toBe(true);
    expect(tile.latestDate).toBe("2026-07-20");
    // Only points inside the selected range make the sparkline.
    expect(tile.points.map((p) => p.value)).toEqual([78, 77]);
  });

  it("keeps a known metric present when the selected range is empty", () => {
    const tile = buildBodyMetricTile(
      BODY_METRIC_META.steps,
      [{ date: "2026-01-01", value: 1000 }],
      "kg",
      { from: "2026-07-01", to: "2026-07-31" }
    );
    expect(tile.present).toBe(true);
    expect(tile.latestDate).toBe("2026-01-01");
    expect(tile.points).toEqual([]);
  });

  it("is absent (present=false) for an empty full series", () => {
    const tile = buildBodyMetricTile(BODY_METRIC_META.steps, [], "kg", {});
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

describe("bodyMetricPeriodStats", () => {
  const today = "2026-07-22";

  // #1541 — the whole point of the collapse: three windows that contain the SAME
  // readings produced three identical cards, which is the common case for any
  // series younger than a week (every new install, every fresh integration).
  it("collapses windows that cover the same readings into one card", () => {
    const stats = bodyMetricPeriodStats(
      [
        { date: "2026-07-20", value: 8200 },
        { date: "2026-07-21", value: 9100 },
        { date: "2026-07-22", value: 7600 },
      ],
      today,
      0
    );
    expect(stats).toHaveLength(1);
    const [only] = stats;
    expect(only.windows).toEqual([7, 30, 90]);
    expect(only.days).toBe(90);
    expect(only.label).toBe("7–90d");
    // The count + the covered span — the passthrough that makes the card explicable.
    expect(only.count).toBe(3);
    expect(only.from).toBe("2026-07-20");
    expect(only.to).toBe("2026-07-22");
  });

  it("collapses only the coincident RUN, keeping a window that really differs", () => {
    // 7d holds one reading; 30d and 90d both hold two → two cards, not three.
    const stats = bodyMetricPeriodStats(
      [
        { date: "2026-07-01", value: 78.4 },
        { date: "2026-07-21", value: 77.9 },
      ],
      today,
      1
    );
    expect(stats.map((s) => s.label)).toEqual(["7d", "30–90d"]);
    expect(stats.map((s) => s.count)).toEqual([1, 2]);
    expect(stats[1].delta).toBeCloseTo(-0.5, 5);
  });

  it("keeps three cards when all three windows genuinely differ", () => {
    const stats = bodyMetricPeriodStats(
      [
        { date: "2026-04-25", value: 100 },
        { date: "2026-07-01", value: 80 },
        { date: "2026-07-20", value: 76 },
      ],
      today,
      1
    );
    expect(stats.map((s) => s.label)).toEqual(["7d", "30d", "90d"]);
    expect(stats.every((s) => s.windows.length === 1)).toBe(true);
  });

  it("collapses three EMPTY windows too — one 'no readings' card, not three", () => {
    const stats = bodyMetricPeriodStats(
      [{ date: "2026-01-01", value: 5 }],
      today
    );
    expect(stats).toHaveLength(1);
    expect(stats[0].count).toBe(0);
    expect(stats[0].label).toBe("7–90d");
  });

  // ── The degenerate inputs (#1545) ──────────────────────────────────────────
  // A windowed statistic's contract is decided at its edges, and those edges are
  // the ORDINARY state of a real install: no readings at all (a metric never
  // recorded), and exactly one (the day after a first weigh-in or a fresh
  // integration). Pinning what the function returns there is what lets a SURFACE
  // spec assert "one card per DISTINCT window" instead of a fixed 7/30/90 trio —
  // the presence-trio that #1541's collapse had to break to be fixable.

  it("returns ONE empty card for a metric with no readings at all", () => {
    const stats = bodyMetricPeriodStats([], today);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      label: "7–90d",
      windows: [7, 30, 90],
      count: 0,
      from: null,
      to: null,
      latest: null,
      avg: null,
      min: null,
      max: null,
      delta: null,
    });
  });

  it("returns ONE card for a single reading, with a zero delta and no spread", () => {
    const stats = bodyMetricPeriodStats(
      [{ date: "2026-07-21", value: 81.25 }],
      today,
      1
    );
    expect(stats).toHaveLength(1);
    const [only] = stats;
    expect(only.label).toBe("7–90d");
    expect(only.count).toBe(1);
    // latest === min === max, and the change is against ITSELF: exactly zero, not
    // null. A single reading is a real (if uninformative) answer, and the card must
    // say so rather than render three copies of it.
    expect(only.latest).toBe(81.3);
    expect(only.min).toBe(81.3);
    expect(only.max).toBe(81.3);
    expect(only.avg).toBe(81.3);
    expect(only.delta).toBe(0);
    expect(only.from).toBe("2026-07-21");
    expect(only.to).toBe("2026-07-21");
  });
});

describe("collapseCoincidentPeriods", () => {
  const stat = (days: number, count: number) => ({
    label: `${days}d`,
    days,
    windows: [days],
    count,
    from: null,
    to: null,
    latest: null,
    avg: null,
    min: null,
    max: null,
    delta: null,
  });

  it("is a no-op when every window differs", () => {
    const out = collapseCoincidentPeriods([
      stat(7, 1),
      stat(30, 2),
      stat(90, 3),
    ]);
    expect(out).toHaveLength(3);
  });

  it("merges an ADJACENT run only — a matching count either side of a gap is not one window", () => {
    // Nested windows can't actually produce this (counts are monotonic), but the
    // merge must stay a run-collapse rather than a group-by-count.
    const out = collapseCoincidentPeriods([
      stat(7, 2),
      stat(30, 3),
      stat(90, 3),
    ]);
    expect(out.map((s) => s.label)).toEqual(["7d", "30–90d"]);
  });
});

describe("seriesCoverageNote (#1541 fix 4)", () => {
  const pts = [{ date: "2026-07-19" }, { date: "2026-07-25" }];

  it("names what is actually drawn when the window is wider than the series", () => {
    expect(
      seriesCoverageNote(pts, { from: "2026-04-27", to: "2026-07-25" })
    ).toBe("All 2 readings, 07-19 → 07-25");
  });

  it("stays silent when the range genuinely bounds the series", () => {
    // The window starts ON the first reading — the pill is already truthful.
    expect(
      seriesCoverageNote(pts, { from: "2026-07-19", to: "2026-07-25" })
    ).toBeNull();
  });

  it("drops the 'All' when the range also clips the recent end", () => {
    expect(seriesCoverageNote(pts, { from: null, to: "2026-07-20" })).toBe(
      "2 readings, 07-19 → 07-25"
    );
  });

  it("has nothing to say about an empty window", () => {
    expect(seriesCoverageNote([], { from: null, to: null })).toBeNull();
  });
});

describe("bodyChartScale (#1541 fix 5)", () => {
  it("floors a COUNT metric at zero and groups its ticks", () => {
    expect(bodyChartScale(BODY_METRIC_META.steps)).toEqual({
      yDomain: [0, "auto"],
      groupYTicks: true,
    });
    expect(bodyChartScale(BODY_METRIC_META.calories).groupYTicks).toBe(true);
    expect(bodyChartScale(BODY_METRIC_META.hydration).groupYTicks).toBe(true);
  });

  it("leaves a ratio/index metric on the auto domain, where zero would flatten it", () => {
    for (const slug of ["weight", "bmi", "resting-hr", "spo2"] as const) {
      expect(bodyChartScale(BODY_METRIC_META[slug]).yDomain).toBeUndefined();
    }
  });
});
