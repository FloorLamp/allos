// DB INTEGRATION TIER — the dashboard vitals card's bounded trend-tail readers
// (#1367). The card only shows the latest BP / resting-HR reading plus a direction
// arrow versus the reading before it, so it must NOT pull a profile's entire history
// just to read the last two points. getLatestBiomarkerTrendPoints /
// getLatestBodyMetricDailyPoints bound the query to the two most recent points, and
// this pins that they return EXACTLY the tail of the full series (same points, same
// order, same daily-rollup + value_num filtering) — a query-bound fix with no display
// change.
//
// Since #2303 it also pins the CARD'S WHOLE MODEL (getVitalsLatestModel) over the
// reported shape: one visit's three same-day cuff readings, years old, beside a resting
// HR from yesterday. All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getBiomarkerSeries,
  getLatestBiomarkerTrendPoints,
  getBodyMetricDailySeries,
  getLatestBodyMetricDailyPoints,
  getVitalsLatestModel,
} from "@/lib/queries";
import { ALL_ROWS } from "@/lib/trends";
import { latestTrend } from "@/lib/latest-trend";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
// A second profile carrying the #2303 shape: one clinic visit's three sequential cuff
// readings, years old, beside a resting HR from yesterday.
let stale: SeededProfile;

function addBpFor(
  profileId: number,
  canonical: string,
  date: string,
  value: number | null
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'vitals', ?, ?, 'mmHg', ?, ?)`
  ).run(
    profileId,
    date,
    canonical,
    value == null ? null : String(value),
    canonical,
    value
  );
}

function addBp(canonical: string, date: string, value: number | null) {
  addBpFor(p.profileId, canonical, date, value);
}

function addRestingHrFor(
  profileId: number,
  date: string,
  value: number,
  source: string | null = null
) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, date, value, source);
}

function addRestingHr(
  date: string,
  value: number,
  source: string | null = null
) {
  addRestingHrFor(p.profileId, date, value, source);
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
  // The diastolic half, on the same two newest dates — the card needs both to render a
  // BP row at all.
  addBp("Blood Pressure Diastolic", d(-10), 82);
  addBp("Blood Pressure Diastolic", d(-2), 78);

  // Resting HR: several dates, with TWO same-day rows on the most recent date from
  // one source (they must average to one daily point, not read as two trend points).
  addRestingHr(d(-90), 60);
  addRestingHr(d(-40), 58);
  addRestingHr(d(-5), 62);
  addRestingHr(d(-1), 54);
  addRestingHr(d(-1), 56); // same day, same (NULL) source → averages with the 54 → 55

  // ── The #2303 regression profile ────────────────────────────────────────────────
  // One clinic visit, THREE sequential cuff readings on the same day (ordinary
  // practice), 1600 days back — plus a resting HR from yesterday, so the two rows age
  // independently. All values SYNTHETIC.
  stale = seedProfile("VITALS-STALE");
  const sd = (n: number) => shiftDateStr(stale.todayStr, n);
  for (const [sys, dia] of [
    [126, 82],
    [124, 80],
    [128, 84],
  ] as const) {
    addBpFor(stale.profileId, "Blood Pressure Systolic", sd(-1600), sys);
    addBpFor(stale.profileId, "Blood Pressure Diastolic", sd(-1600), dia);
  }
  addRestingHrFor(stale.profileId, sd(-4), 59);
  addRestingHrFor(stale.profileId, sd(-1), 61);
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

// The whole-card regression for #2303: a years-old blood pressure was rendering as a
// headline number with a trend arrow between two readings from a single visit, beside a
// resting HR from yesterday, in identical typography.
describe("getVitalsLatestModel — the card's presentation floor (#2303)", () => {
  it("keeps the stale BP value but withdraws both currency claims", () => {
    const model = getVitalsLatestModel(stale.profileId, stale.todayStr)!;
    expect(model.bp).not.toBeNull();
    // The VALUE survives at full prominence — the newest same-day reading.
    expect(model.bp).toMatchObject({
      systolic: 128,
      diastolic: 84,
      date: shiftDateStr(stale.todayStr, -1600),
    });
    // ...but the card no longer presents it as current, and the arrow that compared
    // cuff reading #3 to cuff reading #2 of one measurement is gone.
    expect(model.bp?.freshness).toBe("due");
    expect(model.bp?.direction).toBeNull();
  });

  it("leaves the fresh resting-HR row alone — the rows age independently", () => {
    const model = getVitalsLatestModel(stale.profileId, stale.todayStr)!;
    expect(model.restingHr).toMatchObject({
      value: 61,
      date: shiftDateStr(stale.todayStr, -1),
      freshness: "current",
      direction: "up", // 59 → 61, two different days
    });
  });

  it("presents a recent BP normally", () => {
    // The other profile's readings are days old and on distinct dates: value, arrow,
    // and a `current` verdict, exactly as before.
    const model = getVitalsLatestModel(p.profileId, p.todayStr)!;
    expect(model.bp?.freshness).toBe("current");
    expect(model.bp?.direction).toBe("down"); // 128 → 124
    expect(model.restingHr?.freshness).toBe("current");
  });
});
