// DB INTEGRATION TIER — the dashboard vitals card's bounded trend-tail readers
// (#1367). The card only shows the latest BP / resting-HR reading plus a direction
// arrow versus the reading before it, so it must NOT pull a profile's entire history
// just to read the last two points. getLatestBiomarkerTrendPoints /
// getLatestBodyMetricDailyPoints bound the query to the two most recent points, and
// this pins that they return EXACTLY the tail of the full series (same points, same
// order, same daily-rollup + value_num filtering) — a query-bound fix with no display
// change. All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getBiomarkerSeries,
  getLatestBiomarkerTrendPoints,
  getBodyMetricDailySeries,
  getLatestBodyMetricDailyPoints,
  ALL_ROWS,
} from "@/lib/queries";
import { latestTrend } from "@/lib/latest-trend";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

function addBp(canonical: string, date: string, value: number | null) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'vital', ?, ?, 'mmHg', ?, ?)`
  ).run(
    p.profileId,
    date,
    canonical,
    value == null ? null : String(value),
    canonical,
    value
  );
}

function addRestingHr(
  date: string,
  value: number,
  source: string | null = null
) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, ?)`
  ).run(p.profileId, date, value, source);
}

beforeAll(() => {
  p = seedProfile("VITALS-TREND");
  const d = (n: number) => shiftDateStr(p.todayStr, n);

  // Blood pressure: five dated systolic readings + a NEWER null-value_num row (the
  // card filters those out, so the trend tail must skip it too).
  addBp("Blood Pressure Systolic", d(-100), 118);
  addBp("Blood Pressure Systolic", d(-60), 122);
  addBp("Blood Pressure Systolic", d(-30), 120);
  addBp("Blood Pressure Systolic", d(-10), 128);
  addBp("Blood Pressure Systolic", d(-2), 124);
  addBp("Blood Pressure Systolic", d(-1), null); // newest, but non-numeric → dropped

  // Resting HR: several dates, with TWO same-day rows on the most recent date from
  // one source (they must average to one daily point, not read as two trend points).
  addRestingHr(d(-90), 60);
  addRestingHr(d(-40), 58);
  addRestingHr(d(-5), 62);
  addRestingHr(d(-1), 54);
  addRestingHr(d(-1), 56); // same day, same (NULL) source → averages with the 54 → 55
});

describe("vitals trend-tail readers (#1367)", () => {
  it("getLatestBiomarkerTrendPoints returns exactly the filtered full-series tail", () => {
    const full = getBiomarkerSeries(p.profileId, "Blood Pressure Systolic")
      .filter((r) => r.value_num != null)
      .map((r) => ({ date: r.date, value: r.value_num as number }));
    const tail = getLatestBiomarkerTrendPoints(
      p.profileId,
      "Blood Pressure Systolic"
    ).map((r) => ({ date: r.date, value: r.value_num as number }));

    // The card only ever reads the last two of the full series.
    expect(tail).toEqual(full.slice(-2));
    // ...and the null-value_num newest row is NOT one of them.
    expect(tail.map((t) => t.value)).toEqual([128, 124]);
    // latestTrend agrees whether fed the tail or the whole history.
    expect(latestTrend(tail)).toEqual(latestTrend(full));
    expect(latestTrend(tail)?.direction).toBe("down"); // 128 → 124
  });

  it("getLatestBodyMetricDailyPoints returns exactly the full daily-series tail", () => {
    const full = getBodyMetricDailySeries(p.profileId, "resting_hr", ALL_ROWS);
    const tail = getLatestBodyMetricDailyPoints(p.profileId, "resting_hr");

    expect(tail).toEqual(full.slice(-2));
    // The two same-day rows on the newest date average to one point (55), so the
    // tail is [62, 55] — the day is one trend point, not two.
    expect(tail).toEqual([
      { date: shiftDateStr(p.todayStr, -5), value: 62 },
      { date: shiftDateStr(p.todayStr, -1), value: 55 },
    ]);
    expect(latestTrend(tail)).toEqual(latestTrend(full));
    expect(latestTrend(tail)?.direction).toBe("down"); // 62 → 55
  });
});
