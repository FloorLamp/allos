// DB INTEGRATION TIER — the Trends → Nutrition macros chart, windowed and
// densified end-to-end (issue #2258 §4).
//
// Two defects met on this one chart. It read `getMetricDailyTotals` straight into
// `buildMacroFiberSeries` and handed the result to the stacked bar, so (a) it
// ignored the tab's selected range outright and (b) having no window, it had
// nothing to densify against — four unlogged days between two logged ones plotted
// as two adjacent bars. This exercises the REAL composition the section performs
// (query → merge → filterSeriesByRange → applyDayFillRows) against seeded
// metric_samples, because the bug lived in the composition, not in any one part.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { getMetricDailyTotals } from "@/lib/queries";
import { buildMacroFiberSeries } from "@/lib/nutrition-trends";
import { filterSeriesByRange } from "@/lib/trends";
import { dayFillWindow } from "@/lib/day-fill";
import { applyDayFillRows, MACROS_SERIES_KEY } from "@/lib/trend-sparkline";

let profileId: number;

// Two logged days with a four-day hole between them, plus an older day that sits
// OUTSIDE the selected window (the half of the bug the fill cannot fix).
const OUTSIDE = "2026-04-01";
const FIRST = "2026-05-04";
const LAST = "2026-05-09";
const RANGE = { from: "2026-05-01", to: "2026-05-12" };
const MACRO_KEYS = ["protein", "carbs", "fat", "fiber"] as const;

function sample(metric: string, date: string, value: number) {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    metric,
    date,
    `${date}T08:00:00Z`,
    `${date}T08:30:00Z`,
    value
  );
}

function macroSeries() {
  return filterSeriesByRange(
    buildMacroFiberSeries({
      protein: getMetricDailyTotals(profileId, "protein_g"),
      carbs: getMetricDailyTotals(profileId, "carbs_g"),
      fat: getMetricDailyTotals(profileId, "fat_g"),
      fiber: getMetricDailyTotals(profileId, "fiber_g"),
    }),
    RANGE
  );
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Macro Gap")
      .lastInsertRowid
  );
  for (const date of [OUTSIDE, FIRST, LAST]) {
    sample("protein_g", date, 90);
    sample("carbs_g", date, 200);
    sample("fat_g", date, 60);
    sample("fiber_g", date, 25);
  }
  // A partial day inside the window: only protein logged. This day HAS a row, so
  // its other macros stay the within-row zeros #976 already produced — the fill
  // must not confuse "logged nothing else" with "logged nothing".
  sample("protein_g", "2026-05-06", 40);
});

describe("the macros chart joins the range window (#2258 §4)", () => {
  it("drops days outside the selected range", () => {
    const dates = macroSeries().map((d) => d.date);
    expect(dates).not.toContain(OUTSIDE);
    expect(dates).toEqual([FIRST, "2026-05-06", LAST]);
  });
});

describe("the macros chart densifies to the calendar (#2258)", () => {
  const filled = () =>
    applyDayFillRows(
      macroSeries(),
      { seriesKey: MACROS_SERIES_KEY, ...dayFillWindow(RANGE) },
      [...MACRO_KEYS]
    );

  it("gives every calendar day from the first log to the window's end a slot", () => {
    // 2026-05-04 … 2026-05-12 inclusive: nine days, not the three that carry rows.
    expect(filled().map((d) => d.date)).toEqual([
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-07",
      "2026-05-08",
      "2026-05-09",
      "2026-05-10",
      "2026-05-11",
      "2026-05-12",
    ]);
  });

  it("fills an unlogged day with NULL, never a zero-gram day", () => {
    const gap = filled().find((d) => d.date === "2026-05-05")!;
    for (const key of MACRO_KEYS) expect(gap[key]).toBeNull();
    // The trailing run — the days since the last log — is kept, which is the
    // "you stopped logging three days ago" signal.
    for (const date of ["2026-05-10", "2026-05-11", "2026-05-12"]) {
      const day = filled().find((d) => d.date === date)!;
      expect(day.protein).toBeNull();
    }
  });

  it("leaves a partially-logged day's within-row zeros alone", () => {
    const partial = filled().find((d) => d.date === "2026-05-06")!;
    expect(partial.protein).toBe(40);
    expect(partial.carbs).toBe(0);
    expect(partial.fat).toBe(0);
    expect(partial.fiber).toBe(0);
  });

  it("keeps the logged days' real totals", () => {
    const first = filled().find((d) => d.date === FIRST)!;
    expect(first).toMatchObject({
      protein: 90,
      carbs: 200,
      fat: 60,
      fiber: 25,
    });
  });
});
