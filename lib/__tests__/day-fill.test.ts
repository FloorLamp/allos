import { describe, it, expect } from "vitest";
import {
  MAX_FILL_DAYS,
  dailyChartDays,
  dayFillWindow,
  daysInclusive,
  fillDailyRows,
  fillDailySeries,
} from "../day-fill";
import {
  applyDayFill,
  applyDayFillRows,
  gapBridgesNulls,
  gapFillValue,
  seriesGapForMetric,
  seriesGapForSeriesKey,
  seriesRenderForSeriesKey,
  MACROS_SERIES_KEY,
  SLEEP_DURATION_SERIES_KEY,
} from "../trend-sparkline";
import { metricSeriesKey } from "../saved-items";

describe("daysInclusive (issue #2258)", () => {
  it("enumerates every calendar day, inclusive of both ends", () => {
    expect(daysInclusive("2026-03-29", "2026-04-02")).toEqual([
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
    ]);
  });
  it("returns the single day when first === last", () => {
    expect(daysInclusive("2026-01-04", "2026-01-04")).toEqual(["2026-01-04"]);
  });
  it("is empty when last precedes first", () => {
    expect(daysInclusive("2026-01-11", "2026-01-04")).toEqual([]);
  });
  it("crosses a leap-day boundary without drifting", () => {
    expect(daysInclusive("2028-02-27", "2028-03-01")).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });
  it("refuses an unparseable date and a span past the cap", () => {
    expect(daysInclusive("not-a-date", "2026-01-04")).toEqual([]);
    expect(daysInclusive("1990-01-01", "2026-01-04").length).toBe(0);
  });
});

describe("dailyChartDays — the trimming rule", () => {
  const window = { from: "2026-06-01", to: "2026-06-10" };

  it("TRIMS leading empty days: the axis starts at the first reading", () => {
    const days = dailyChartDays(["2026-06-04", "2026-06-06"], window);
    expect(days[0]).toBe("2026-06-04");
    expect(days).not.toContain("2026-06-01");
  });

  it("KEEPS trailing days to the window end — the live-outage signal", () => {
    const days = dailyChartDays(["2026-06-04", "2026-06-06"], window);
    expect(days[days.length - 1]).toBe("2026-06-10");
    expect(days).toEqual([
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
    ]);
  });

  it("ends at the last reading when the window has no `to` (all time)", () => {
    const days = dailyChartDays(["2026-06-04", "2026-06-06"], {
      from: null,
      to: null,
    });
    expect(days).toEqual(["2026-06-04", "2026-06-05", "2026-06-06"]);
  });

  it("never drops a reading that sits past the window's end", () => {
    const days = dailyChartDays(["2026-06-04", "2026-06-20"], window);
    expect(days[days.length - 1]).toBe("2026-06-20");
  });

  it("is empty with no data at all — an empty chart, not a month of holes", () => {
    expect(dailyChartDays([], window)).toEqual([]);
  });
});

describe("fillDailySeries — the fill value", () => {
  const window = { from: "2026-06-01", to: "2026-06-06" };
  const points = [
    { date: "2026-06-02", value: 7.5 },
    { date: "2026-06-05", value: 6.25 },
  ];

  it("fills a gap with nulls — a hole the mark can break across", () => {
    expect(fillDailySeries(points, window, "null")).toEqual([
      { date: "2026-06-02", value: 7.5 },
      { date: "2026-06-03", value: null },
      { date: "2026-06-04", value: null },
      { date: "2026-06-05", value: 6.25 },
      { date: "2026-06-06", value: null },
    ]);
  });

  it("fills a gap with a real zero when the missing day IS zero", () => {
    const filled = fillDailySeries(points, window, "zero");
    expect(filled.map((p) => p.value)).toEqual([7.5, 0, 0, 6.25, 0]);
  });

  it("makes a four-day outage four days wide (the whole point)", () => {
    const outage = fillDailySeries(
      [
        { date: "2026-06-01", value: 8 },
        { date: "2026-06-06", value: 8 },
      ],
      { from: "2026-06-01", to: "2026-06-06" },
      "null"
    );
    expect(outage).toHaveLength(6);
    expect(outage.filter((p) => p.value == null)).toHaveLength(4);
  });

  it("returns nothing for an empty series", () => {
    expect(fillDailySeries([], window, "null")).toEqual([]);
  });

  it("degrades to the raw series rather than truncating a monstrous span", () => {
    const wide = [
      { date: "2000-01-01", value: 1 },
      { date: "2026-01-01", value: 2 },
    ];
    expect(fillDailySeries(wide, { from: null, to: null }, "null")).toEqual(
      wide
    );
    expect(MAX_FILL_DAYS).toBeGreaterThan(365);
  });
});

describe("fillDailyRows — any dated row shape", () => {
  it("builds the caller's blank row for a missing day", () => {
    const rows = [
      { date: "2026-06-01", protein: 100, carbs: 200 },
      { date: "2026-06-03", protein: 90, carbs: 150 },
    ];
    const filled = fillDailyRows(rows, { from: null, to: null }, (date) => ({
      date,
      protein: 0,
      carbs: 0,
    }));
    expect(filled).toHaveLength(3);
    expect(filled[1]).toEqual({ date: "2026-06-02", protein: 0, carbs: 0 });
  });
});

describe("dayFillWindow", () => {
  it("reads an absent bound as the data's own edge", () => {
    expect(dayFillWindow({})).toEqual({ from: null, to: null });
    expect(dayFillWindow({ from: "2026-01-01", to: "2026-02-01" })).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });
});

describe("the per-series gap declaration (issue #2258 §2)", () => {
  it("levels bridge: null fill, stroke crosses the hole", () => {
    for (const id of ["weight", "bodyfat", "bmi", "resting_hr", "hrv", "hr"]) {
      expect(seriesGapForMetric(id), id).toBe("bridge");
    }
    expect(gapFillValue("bridge")).toBe("null");
    expect(gapBridgesNulls("bridge")).toBe(true);
  });

  it("per-night readings break: null fill, stroke does NOT cross", () => {
    expect(seriesGapForSeriesKey(SLEEP_DURATION_SERIES_KEY)).toBe("break");
    expect(gapFillValue("break")).toBe("null");
    expect(gapBridgesNulls("break")).toBe(false);
  });

  it("training volume's rest day is a REAL zero; a sensor outage is not", () => {
    expect(seriesGapForMetric("volume")).toBe("slot-zero");
    expect(gapFillValue("slot-zero")).toBe("zero");
    for (const id of ["steps", "active-calories", "sun", "calories"]) {
      expect(seriesGapForMetric(id), id).toBe("slot-null");
    }
    expect(gapFillValue("slot-null")).toBe("null");
    expect(gapBridgesNulls("slot-null")).toBe(false);
  });

  it("manually-logged nutrition totals fill NULL, never zero", () => {
    expect(gapFillValue(seriesGapForSeriesKey(MACROS_SERIES_KEY))).toBe("null");
  });

  it("the MARK and the GAP travel together on one key", () => {
    expect(seriesRenderForSeriesKey(metricSeriesKey("volume"))).toEqual({
      shape: "bar",
      gap: "slot-zero",
    });
    expect(seriesRenderForSeriesKey(metricSeriesKey("weight"))).toEqual({
      shape: "line",
      gap: "bridge",
    });
  });
});

describe("applyDayFill — what a chart card resolves", () => {
  const points = [
    { date: "2026-06-01", value: 8000 },
    { date: "2026-06-05", value: 9000 },
  ];
  const spec = {
    seriesKey: metricSeriesKey("steps"),
    from: "2026-06-01",
    to: "2026-06-06",
  };

  it("counts REAL readings, not calendar days, for the dot threshold", () => {
    const out = applyDayFill(points, spec);
    expect(out.data).toHaveLength(6);
    expect(out.realCount).toBe(2);
  });

  it("reports the declared bridge policy, overriding the caller's default", () => {
    expect(applyDayFill(points, spec).bridges).toBe(false);
    expect(
      applyDayFill(points, { ...spec, seriesKey: metricSeriesKey("weight") })
        .bridges
    ).toBe(true);
  });

  it("leaves an exempt (bio:) series and a spec-less call untouched", () => {
    const bio = applyDayFill(points, { ...spec, seriesKey: "bio:ApoB" });
    expect(bio.data).toEqual(points);
    expect(bio.bridges).toBeNull();
    expect(applyDayFill(points, undefined).data).toEqual(points);
  });

  it("counts real readings even with no spec (a series that already has holes)", () => {
    expect(
      applyDayFill(
        [
          { date: "2026-06-01", value: 1 },
          { date: "2026-06-02", value: null },
        ],
        undefined
      ).realCount
    ).toBe(1);
  });
});

describe("applyDayFillRows — a stacked day", () => {
  it("blanks every stacked key on a missing day", () => {
    const rows = [
      { date: "2026-06-01", protein: 100, carbs: 200, fat: 50, fiber: 20 },
      { date: "2026-06-03", protein: 90, carbs: 150, fat: 40, fiber: 15 },
    ];
    const filled = applyDayFillRows(
      rows,
      { seriesKey: MACROS_SERIES_KEY, from: null, to: null },
      ["protein", "carbs", "fat", "fiber"]
    );
    expect(filled).toHaveLength(3);
    expect(filled[1]).toEqual({
      date: "2026-06-02",
      protein: null,
      carbs: null,
      fat: null,
      fiber: null,
    });
  });
});
