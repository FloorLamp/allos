// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// The trends-consistency cluster (#395/#396/#397): every "one question, one
// computation" regression where a Trends/dashboard/household surface re-derived a
// value the canonical query already answers.
//   • #395 — buildMetricSeries (Overview tiles / Compare / digest) charts the
//     one-source-per-day reconciled series, not raw all-source rows.
//   • #396 — the household card takes its current weight from the same primary-
//     source-aware reader the dashboard uses, and its trend arrow compares deduped
//     DAYS, not two devices on one day.
//   • #397 — the Trends zone card's "this week" Zone 2 stat honors week_mode via
//     the shared weekWindow(), matching the weekly recap for the same target.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import {
  upsertBodyMetrics,
  upsertHrMinutes,
} from "@/lib/integrations/normalize";
import { buildMetricSeries } from "@/lib/trends-series";
import {
  getBodyMetricDailySeries,
  getDashboardStats,
  getLatestBodyMetricDated,
  getTrainingZoneData,
  getZone2MinutesInWindow,
} from "@/lib/queries";
import { weightTrend } from "@/lib/household";
import { zone2Adherence } from "@/lib/training-zones";
import { weekWindow } from "@/lib/week-window";
import { shiftDateStr, startOfWeekStr } from "@/lib/date";
import {
  getWeekMode,
  getWeekStart,
  setWeekMode,
  setWeekStart,
  setMetricSourcePriorityEntry,
  setMaxHrOverride,
  setZone2WeeklyTargetMin,
  type WeekStart,
} from "@/lib/settings";

// ---- #395 / #396: weight surfaces read the deduped daily series --------------

describe("#395/#396 — weight surfaces share the one-source-per-day series", () => {
  let profileId: number;
  const DAY1 = "2024-05-01";
  const DAY2 = "2024-05-02"; // two devices report this day

  beforeAll(() => {
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('WeightDedup')").run()
        .lastInsertRowid
    );
    // Manual weigh-ins are the primary source here (issue's failure scenario).
    setMetricSourcePriorityEntry(profileId, "weight", "manual");
    // DAY1: single manual reading.
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, NULL)"
    ).run(profileId, DAY1, 80);
    // DAY2: manual 80 (primary) AND a Health Connect scale reporting 80.6.
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg, source) VALUES (?, ?, ?, NULL)"
    ).run(profileId, DAY2, 80);
    upsertBodyMetrics(
      profileId,
      [{ date: DAY2, weight_kg: 80.6 }],
      "health-connect"
    );
  });

  it("buildMetricSeries weight is the deduped daily series — one point per day, no zig-zag (#395)", () => {
    const [weight] = buildMetricSeries(profileId, 1, {}, false);
    expect(weight.key).toBe("metric:weight");
    // One point per DAY (not one per raw row): the two-device DAY2 collapses to one.
    const dates = weight.points.map((p) => p.date);
    expect(dates).toEqual([DAY1, DAY2]);
    // It equals the reconciled series the Body tab charts (kg == kg display default).
    const daily = getBodyMetricDailySeries(profileId, "weight");
    expect(weight.points).toEqual(
      daily.map((p: { date: string; value: number }) => ({
        date: p.date,
        value: p.value,
      }))
    );
    // The kept DAY2 value is the PRIMARY source's 80, not the scale's 80.6.
    expect(weight.points[weight.points.length - 1].value).toBe(80);
  });

  it("the tile's latest agrees with the dashboard QuickStats current weight (#395)", () => {
    const [weight] = buildMetricSeries(profileId, 1, {}, false);
    const tileLatest = weight.points[weight.points.length - 1].value;
    expect(tileLatest).toBe(getDashboardStats(profileId).latestWeight?.value);
    expect(getDashboardStats(profileId).latestWeight).toEqual(
      getLatestBodyMetricDated(profileId, "weight")
    );
  });

  it("household current weight + trend arrow match the dashboard and compare DAYS not devices (#396)", () => {
    // The page now derives the displayed value from getDashboardStats().latestWeight…
    const displayed = getDashboardStats(profileId).latestWeight;
    expect(displayed).toEqual(getLatestBodyMetricDated(profileId, "weight"));
    expect(displayed?.value).toBe(80);

    // …and the arrow from the two newest days of the deduped series. Both days are
    // 80 (primary), so the arrow is FLAT — not the ordering-dependent 80→80.6 "↑"
    // the old raw two-newest-rows read produced.
    const daily = getBodyMetricDailySeries(profileId, "weight");
    const n = daily.length;
    const trend = weightTrend(daily[n - 1]?.value, daily[n - 2]?.value);
    expect(trend?.dir).toBe("flat");

    // Pin the pre-fix bug: the raw two-newest-rows read WOULD have disagreed —
    // the same-day scale row is a distinct row, so it becomes the "latest".
    const rawTwo = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND weight_kg IS NOT NULL ORDER BY date DESC, id DESC LIMIT 2"
      )
      .all(profileId) as { weight_kg: number }[];
    const rawTrend = weightTrend(rawTwo[0]?.weight_kg, rawTwo[1]?.weight_kg);
    expect(rawTrend?.dir).not.toBe("flat"); // the device offset masquerading as a change
  });
});

// ---- #397: zone card "this week" honors week_mode ----------------------------

describe("#397 — Trends zone card 'this week' Zone 2 honors week_mode", () => {
  let profileId: number;

  beforeAll(() => {
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ZoneWeek')").run()
        .lastInsertRowid
    );
    // A resolvable zone model without needing an age: max HR 200 → Zone 2 is
    // [120,140) bpm on the percent-max model.
    setMaxHrOverride(profileId, 200);
    setZone2WeeklyTargetMin(profileId, 60);

    const td = today(profileId);
    const yesterday = shiftDateStr(td, -1);
    // Force the CALENDAR week to start today, so yesterday sits in the PREVIOUS
    // calendar week but still inside the trailing-7 rolling window.
    let ws: WeekStart = 0;
    for (let w = 0 as WeekStart; w <= 6; w = (w + 1) as WeekStart) {
      if (startOfWeekStr(td, w) === td) {
        ws = w;
        break;
      }
    }
    setWeekStart(profileId, ws);

    // A 30-minute Zone 2 session YESTERDAY, with per-minute HR to match.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min, start_time, end_time)
       VALUES (?, ?, 'cardio', 'Easy run', 30, '08:00', '08:30')`
    ).run(profileId, yesterday);
    const minutes = Array.from({ length: 30 }, (_, i) => {
      const m = String(i).padStart(2, "0");
      return {
        ts: `${yesterday}T08:${m}`,
        bpm: 130,
        bpm_min: 128,
        bpm_max: 132,
        n: 1,
      };
    });
    upsertHrMinutes(profileId, minutes, "health-connect");
  });

  it("rolling mode counts yesterday's session; the old calendar-bucket read would show 0", () => {
    setWeekMode(profileId, "rolling");
    const data = getTrainingZoneData(profileId);
    // Rolling window [today-6, today] includes yesterday's 30 Zone 2 minutes.
    expect(data.currentWeekZone2?.minutes).toBe(30);

    // It equals the SAME computation the weekly recap uses (parity, #223/#397).
    const win = weekWindow(
      today(profileId),
      getWeekMode(profileId),
      getWeekStart(profileId)
    );
    const recapMin =
      getZone2MinutesInWindow(profileId, win.start, win.end) ?? 0;
    expect(data.currentWeekZone2).toEqual(zone2Adherence(recapMin, 60));

    // The pre-fix calendar bucket (current calendar week starts TODAY) excludes
    // yesterday → 0, contradicting the recap. Pin that the headline is NOT that.
    expect(data.currentWeekZone2?.minutes).not.toBe(0);
  });

  it("calendar mode excludes yesterday (current calendar week starts today)", () => {
    setWeekMode(profileId, "calendar");
    const data = getTrainingZoneData(profileId);
    expect(data.currentWeekZone2?.minutes).toBe(0);

    // Still parity with the recap path for the SAME mode.
    const win = weekWindow(
      today(profileId),
      getWeekMode(profileId),
      getWeekStart(profileId)
    );
    const recapMin =
      getZone2MinutesInWindow(profileId, win.start, win.end) ?? 0;
    expect(data.currentWeekZone2).toEqual(zone2Adherence(recapMin, 60));
  });
});
